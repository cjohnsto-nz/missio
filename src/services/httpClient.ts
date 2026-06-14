import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as tls from 'tls';
import { URL } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  HttpRequest, HttpRequestDetails, HttpRequestBody,
  Auth, AuthOAuth2, AuthCli, HttpResponse, HttpRequestSettings, HttpRequestBodyVariant,
  MissioCollection, ClientCertificate, OAuth2AdditionalParameters, OAuth2AdditionalParameter,
} from '../models/types';
import type { EnvironmentService } from './environmentService';
import type { OAuth2Service } from './oauth2Service';
import type { SecretService } from './secretService';
import type { CliAuthApprovalService } from './cliAuthApproval';
import { resolveFileVariantToBuffer } from './fileBodyHelper';

const execAsync = promisify(exec);

const _logChannel = vscode.window.createOutputChannel('Missio Requests');
function _log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  _logChannel.appendLine(`[${ts}] ${msg}`);
}
export { _logChannel as requestLog };

/** Fully resolved request ready for execution or export. */
export interface ResolvedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** String for text bodies; Buffer for binary file bodies. */
  body?: string | Buffer;
}

interface CliTokenCacheEntry {
  token: string;
  expiresAt: number; // epoch ms
}

interface ResolvedHttpRequestSettings {
  timeout: number;
  followRedirects: boolean;
  maxRedirects: number;
  encodeUrl: boolean;
}

interface ResolvedProxyConfig {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  authHeader?: string;
}

/** Callback to prompt user for CLI command approval. Returns true if approved. */
export type CliApprovalPrompt = (commandTemplate: string, interpolatedCommand: string) => Promise<boolean>;

export class HttpClient implements vscode.Disposable {
  private _activeRequests: Map<string, http.ClientRequest> = new Map();
  private _oauth2Service: OAuth2Service | undefined;
  private _secretService: SecretService | undefined;
  private _cliAuthApprovalService: CliAuthApprovalService | undefined;
  private _cliTokenCache: Map<string, CliTokenCacheEntry> = new Map();

  constructor(private readonly _environmentService: EnvironmentService) {}

  clearCliTokenCache(): void {
    this._cliTokenCache.clear();
  }

  setCliAuthApprovalService(service: CliAuthApprovalService): void {
    this._cliAuthApprovalService = service;
  }

  setOAuth2Service(oauth2Service: OAuth2Service): void {
    this._oauth2Service = oauth2Service;
  }

  setSecretService(secretService: SecretService): void {
    this._secretService = secretService;
  }

  /**
   * Resolve all variables, interpolate URL/headers/body/auth, and return the
   * fully-resolved request without executing it. Useful for export (cURL, etc.).
   */
  async buildResolvedRequest(
    request: HttpRequest,
    collection: MissioCollection,
    folderDefaults?: import('../models/types').RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
    options?: { includeAuth?: boolean; includeBody?: boolean },
  ): Promise<ResolvedRequest> {
    const variables = await this._environmentService.resolveVariables(collection, folderDefaults, environmentName);
    if (extraVariables) {
      for (const [k, v] of extraVariables) variables.set(k, v);
    }
    const details = request.http;
    if (!details?.url || !details?.method) {
      throw new Error('Request must have a URL and method');
    }
    const settings = this._resolveSettings(request.settings, vscode.workspace.getConfiguration('missio'));

    // Interpolate URL
    let url = this._environmentService.interpolate(details.url, variables);
    if (url && !/^https?:\/\//i.test(url)) {
      url = 'http://' + url;
    }

    // Apply query params
    const allQueryParams = (details.params ?? []).filter(p => p.type === 'query');
    if (allQueryParams.length > 0) {
      const urlObj = new URL(url);
      urlObj.search = '';
      for (const p of allQueryParams) {
        if (p.disabled) continue;
        const resolvedValue = this._environmentService.interpolate(p.value, variables);
        if (resolvedValue === '') continue;
        this._setQueryParam(urlObj, this._environmentService.interpolate(p.name, variables), resolvedValue, settings.encodeUrl);
      }
      url = urlObj.toString();
    }

    // Apply path params
    const pathParams = (details.params ?? []).filter(p => p.type === 'path' && !p.disabled);
    for (const p of pathParams) {
      const name = this._environmentService.interpolate(p.name, variables);
      const value = this._environmentService.interpolate(p.value, variables);
      url = url.replace(`:${name}`, settings.encodeUrl ? encodeURIComponent(value) : value);
    }

    // Build headers: collection -> folder -> request (each layer overrides)
    const headers: Record<string, string> = {};
    for (const h of (collection.data.request?.headers ?? [])) {
      if (!h.disabled) {
        headers[this._environmentService.interpolate(h.name, variables)] =
          this._environmentService.interpolate(h.value, variables);
      }
    }
    if (folderDefaults?.headers) {
      for (const h of folderDefaults.headers) {
        if (!h.disabled) {
          headers[this._environmentService.interpolate(h.name, variables)] =
            this._environmentService.interpolate(h.value, variables);
        }
      }
    }
    for (const h of (details.headers ?? [])) {
      if (!h.disabled) {
        headers[this._environmentService.interpolate(h.name, variables)] =
          this._environmentService.interpolate(h.value, variables);
      }
    }

    // Auth (skip when exporting without auth)
    if (options?.includeAuth !== false) {
      let auth: Auth | undefined;
      if (collection.data.config?.forceAuthInherit) {
        const collectionAuth = collection.data.request?.auth;
        if (collectionAuth && collectionAuth !== 'inherit' && this._isAuthComplete(collectionAuth)) {
          auth = collectionAuth;
        } else {
          auth = request.runtime?.auth;
          if (auth === 'inherit') auth = folderDefaults?.auth ?? 'inherit';
          if (auth === 'inherit') auth = collectionAuth;
        }
      } else {
        auth = request.runtime?.auth;
        if (auth === 'inherit') auth = folderDefaults?.auth ?? 'inherit';
        if (auth === 'inherit') auth = collection.data.request?.auth;
      }
      if (auth && auth !== 'inherit') {
        if (auth.type === 'oauth2') {
          url = await this._applyOAuth2(auth as AuthOAuth2, headers, variables, collection, environmentName, url, settings.encodeUrl);
        } else if (auth.type === 'cli') {
          await this._applyCliAuth(auth as AuthCli, headers, variables, collection, cliApprovalPrompt);
        } else {
          url = this._applyAuth(auth, headers, variables, url, settings.encodeUrl);
        }
      }
    }

    // Body
    let body: string | Buffer | undefined;
    const resolvedBody = this._resolveBody(details.body);
    if (resolvedBody) {
      if (resolvedBody.type === 'file') {
        const variant = options?.includeBody !== false
          ? (resolvedBody.data.find(v => v.selected) ?? resolvedBody.data[0])
          : undefined;
        if (variant?.filePath) {
          body = await resolveFileVariantToBuffer(collection.rootDir, variant.filePath);
          const ct = variant.contentType || 'application/octet-stream';
          const hasContentType = Object.keys(headers).some(h => h.toLowerCase() === 'content-type');
          if (!hasContentType) {
            headers['Content-Type'] = ct;
          }
        }
      } else {
        body = this._buildBody(resolvedBody, headers, variables);
      }
    }

    // Resolve $secret references
    const providers = collection.data.config?.secretProviders ?? [];
    if (providers.length > 0 && this._secretService) {
      url = await this._secretService.resolveSecretReferences(url, providers, variables);
      for (const [k, v] of Object.entries(headers)) {
        const resolved = await this._secretService.resolveSecretReferences(v, providers, variables);
        if (resolved !== v) headers[k] = resolved;
      }
      if (body && typeof body === 'string') {
        body = await this._secretService.resolveSecretReferences(body, providers, variables);
      }
    }

    url = this._normalizeUrl(url, settings.encodeUrl);

    return { method: details.method.toUpperCase(), url, headers, body };
  }

  async send(
    request: HttpRequest,
    collection: MissioCollection,
    folderDefaults?: import('../models/types').RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
  ): Promise<HttpResponse> {
    const t0 = Date.now();
    const _timing: { label: string; start: number; end: number }[] = [];
    const _mark = (label: string, start: number) => { _timing.push({ label, start: start - t0, end: Date.now() - t0 }); };
    _log(`── Send ${request.http?.method ?? '?'} ${request.http?.url ?? '?'} ──`);
    let tPhase = Date.now();

    const resolved = await this.buildResolvedRequest(
      request, collection, folderDefaults, extraVariables, environmentName, cliApprovalPrompt,
    );

    _mark('Resolve', tPhase);
    _log(`  resolve: ${Date.now() - t0}ms`);

    const config = vscode.workspace.getConfiguration('missio');
    const settings = this._resolveSettings(request.settings, config);

    onProgress?.('Sending request…');
    const variables = await this._environmentService.resolveVariables(collection, folderDefaults, environmentName);
    if (extraVariables) {
      for (const [k, v] of extraVariables) variables.set(k, v);
    }

    tPhase = Date.now();
    const requestId = `${Date.now()}-${Math.random()}`;
    const response = await this._sendWithRedirects(
      resolved,
      settings,
      collection,
      variables,
      environmentName,
      requestId,
    );
    _mark('HTTP', tPhase);
    return { ...response, timing: _timing };
  }

  private async _sendWithRedirects(
    resolved: ResolvedRequest,
    settings: ResolvedHttpRequestSettings,
    collection: MissioCollection,
    variables: Map<string, string>,
    environmentName: string | undefined,
    requestId: string,
  ): Promise<HttpResponse> {
    let current: ResolvedRequest = {
      ...resolved,
      headers: { ...resolved.headers },
    };
    const startedAt = Date.now();
    let redirects = 0;

    while (true) {
      _log(`  executing: ${current.method} ${current.url}`);
      const response = await this._sendOnce(current, settings, collection, variables, environmentName, requestId, startedAt);
      const location = this._getRedirectLocation(response);
      if (!location || !settings.followRedirects) {
        return response;
      }
      if (redirects >= settings.maxRedirects) {
        throw new Error(`Too many redirects: exceeded maxRedirects (${settings.maxRedirects})`);
      }
      redirects += 1;
      current = this._buildRedirectRequest(current, response.status, location, settings.encodeUrl);
    }
  }

  private async _sendOnce(
    resolved: ResolvedRequest,
    settings: ResolvedHttpRequestSettings,
    collection: MissioCollection,
    variables: Map<string, string>,
    environmentName: string | undefined,
    requestId: string,
    startedAt: number,
  ): Promise<HttpResponse> {
    const transport = await this._buildRequestOptions(resolved, settings, collection, variables, environmentName);
    const requestModule = transport.module;

    return new Promise<HttpResponse>((resolve, reject) => {
      const req = requestModule.request(transport.options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          this._activeRequests.delete(requestId);
          const buffer = Buffer.concat(chunks);
          const duration = Date.now() - startedAt;
          const responseHeaders: Record<string, string> = {};
          for (const [key, val] of Object.entries(res.headers)) {
            if (val) {
              responseHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
            }
          }

          // Detect binary content types for preview support
          const ct = (responseHeaders['content-type'] ?? '').toLowerCase();
          const isBinary = /^(image\/|application\/pdf|application\/octet-stream)/.test(ct);

          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
            body: buffer.toString('utf-8'),
            bodyBase64: isBinary ? buffer.toString('base64') : undefined,
            duration,
            size: buffer.length,
          } as any);
        });
      });

      req.on('error', (err) => {
        this._activeRequests.delete(requestId);
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy(new Error('Request timed out'));
      });

      this._activeRequests.set(requestId, req);

      if (resolved.body !== undefined) {
        const bodyBuffer = Buffer.isBuffer(resolved.body) ? resolved.body : Buffer.from(resolved.body, 'utf-8');
        req.setHeader('Content-Length', bodyBuffer.length);
        _log(`  body: ${bodyBuffer.length} bytes`);
        req.write(bodyBuffer);
      }
      req.end();
    });
  }

  cancelAll(): void {
    for (const [, req] of this._activeRequests) {
      req.destroy(new Error('Request cancelled'));
    }
    this._activeRequests.clear();
  }

  // ── Private ──────────────────────────────────────────────────────

  private async _buildRequestOptions(
    resolved: ResolvedRequest,
    settings: ResolvedHttpRequestSettings,
    collection: MissioCollection,
    variables: Map<string, string>,
    environmentName: string | undefined,
  ): Promise<{ module: typeof http | typeof https; options: http.RequestOptions | https.RequestOptions }> {
    const parsedUrl = new URL(resolved.url);
    const isHttps = parsedUrl.protocol === 'https:';
    const headers = { ...resolved.headers };
    const tlsOptions = isHttps
      ? await this._resolveTlsOptions(collection, variables, environmentName, parsedUrl.hostname)
      : undefined;
    const proxy = this._resolveProxy(collection, variables, parsedUrl);

    if (proxy && isHttps) {
      const socket = await this._createProxyTunnel(parsedUrl, proxy, settings, tlsOptions);
      return {
        module: https,
        options: {
          method: resolved.method,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: parsedUrl.pathname + parsedUrl.search,
          headers,
          timeout: settings.timeout,
          agent: false,
          createConnection: () => socket,
          ...tlsOptions,
        } as https.RequestOptions,
      };
    }

    if (proxy) {
      if (!this._hasHeader(headers, 'host')) {
        headers.Host = parsedUrl.host;
      }
      if (proxy.authHeader) {
        headers['Proxy-Authorization'] = proxy.authHeader;
      }
      return {
        module: proxy.protocol === 'https:' ? https : http,
        options: {
          method: resolved.method,
          hostname: proxy.hostname,
          port: proxy.port,
          path: parsedUrl.toString(),
          headers,
          timeout: settings.timeout,
          ...(proxy.protocol === 'https:'
            ? { rejectUnauthorized: vscode.workspace.getConfiguration('missio').get<boolean>('rejectUnauthorized', true) }
            : {}),
        },
      };
    }

    return {
      module: isHttps ? https : http,
      options: {
        method: resolved.method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers,
        timeout: settings.timeout,
        ...(tlsOptions ?? {}),
      },
    };
  }

  private _resolveProxy(
    collection: MissioCollection,
    variables: Map<string, string>,
    targetUrl: URL,
  ): ResolvedProxyConfig | undefined {
    const proxy = collection.data.config?.proxy;
    if (!proxy || proxy.disabled || proxy.enabled === false) return undefined;
    const config = proxy.config;
    if (!config || !config.hostname || !config.port) return undefined;
    if (this._isProxyBypassed(config.bypassProxy, targetUrl.hostname, variables)) return undefined;

    const rawProtocol = this._environmentService.interpolate(config.protocol || 'http', variables).toLowerCase();
    const protocol = rawProtocol.endsWith(':') ? rawProtocol : `${rawProtocol}:`;
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`Proxy protocol "${rawProtocol}" is not supported. Use http or https.`);
    }

    let authHeader: string | undefined;
    const auth = config.auth;
    if (auth && typeof auth === 'object' && !auth.disabled) {
      const username = this._environmentService.interpolate(auth.username ?? '', variables);
      const password = this._environmentService.interpolate(auth.password ?? '', variables);
      authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    return {
      protocol,
      hostname: this._environmentService.interpolate(config.hostname, variables),
      port: config.port,
      authHeader,
    };
  }

  private _isProxyBypassed(bypassProxy: string | undefined, hostname: string, variables: Map<string, string>): boolean {
    if (!bypassProxy) return false;
    const host = hostname.toLowerCase();
    const entries = this._environmentService.interpolate(bypassProxy, variables)
      .split(/[,\s]+/)
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean);
    return entries.some(entry => {
      if (entry === '*') return true;
      if (entry === '<local>') return !host.includes('.');
      if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
      return host === entry;
    });
  }

  private async _createProxyTunnel(
    targetUrl: URL,
    proxy: ResolvedProxyConfig,
    settings: ResolvedHttpRequestSettings,
    tlsOptions: tls.ConnectionOptions | undefined,
  ): Promise<tls.TLSSocket> {
    const proxyModule = proxy.protocol === 'https:' ? https : http;
    const targetPort = targetUrl.port || '443';
    const tunnelHeaders: Record<string, string> = {
      Host: `${targetUrl.hostname}:${targetPort}`,
    };
    if (proxy.authHeader) {
      tunnelHeaders['Proxy-Authorization'] = proxy.authHeader;
    }

    return new Promise<tls.TLSSocket>((resolve, reject) => {
      const req = proxyModule.request({
        method: 'CONNECT',
        hostname: proxy.hostname,
        port: proxy.port,
        path: `${targetUrl.hostname}:${targetPort}`,
        headers: tunnelHeaders,
        timeout: settings.timeout,
      });

      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`Proxy CONNECT failed with status ${res.statusCode ?? 0}`));
          return;
        }

        const tlsSocket = tls.connect({
          socket,
          servername: targetUrl.hostname,
          ...(tlsOptions ?? {}),
        }, () => resolve(tlsSocket));
        tlsSocket.once('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Proxy CONNECT timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  private async _resolveTlsOptions(
    collection: MissioCollection,
    variables: Map<string, string>,
    environmentName: string | undefined,
    hostname: string,
  ): Promise<tls.ConnectionOptions> {
    const options: tls.ConnectionOptions = {
      rejectUnauthorized: vscode.workspace.getConfiguration('missio').get<boolean>('rejectUnauthorized', true),
    };
    const certificate = this._selectClientCertificate(collection, variables, environmentName, hostname);
    if (!certificate) return options;

    if (certificate.type === 'pem') {
      options.cert = await fs.promises.readFile(this._resolveCollectionPath(collection.rootDir, this._environmentService.interpolate(certificate.certificateFilePath, variables)));
      options.key = await fs.promises.readFile(this._resolveCollectionPath(collection.rootDir, this._environmentService.interpolate(certificate.privateKeyFilePath, variables)));
    } else {
      options.pfx = await fs.promises.readFile(this._resolveCollectionPath(collection.rootDir, this._environmentService.interpolate(certificate.pkcs12FilePath, variables)));
    }
    if (certificate.passphrase) {
      options.passphrase = this._environmentService.interpolate(certificate.passphrase, variables);
    }
    return options;
  }

  private _selectClientCertificate(
    collection: MissioCollection,
    variables: Map<string, string>,
    environmentName: string | undefined,
    hostname: string,
  ): ClientCertificate | undefined {
    const envName = environmentName ?? this._environmentService.getActiveEnvironmentName(collection.id);
    const env = envName
      ? collection.data.config?.environments?.find(candidate => candidate.name === envName)
      : undefined;
    const candidates = [
      ...(env?.clientCertificates ?? []),
      ...(collection.data.config?.clientCertificates ?? []),
    ];
    return candidates.find(certificate => this._certificateMatches(certificate, hostname, variables));
  }

  private _certificateMatches(certificate: ClientCertificate, hostname: string, variables: Map<string, string>): boolean {
    const domain = this._environmentService.interpolate(certificate.domain, variables).toLowerCase();
    const host = hostname.toLowerCase();
    if (domain === '*') return true;
    if (domain.startsWith('*.')) return host.endsWith(domain.slice(1));
    return domain === host;
  }

  private _resolveCollectionPath(rootDir: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
  }

  private _getRedirectLocation(response: HttpResponse): string | undefined {
    if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
    return response.headers.location || response.headers.Location;
  }

  private _buildRedirectRequest(current: ResolvedRequest, status: number, location: string, encodeUrl: boolean): ResolvedRequest {
    const url = this._normalizeUrl(new URL(location, current.url).toString(), encodeUrl);
    const headers = { ...current.headers };
    let method = current.method;
    let body = current.body;

    if ([301, 302, 303].includes(status) && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
      this._deleteHeader(headers, 'content-length');
    }

    return { method, url, headers, body };
  }

  private _setQueryParam(url: URL, name: string, value: string, _encodeUrl = true): void {
    if (name) {
      url.searchParams.set(name, value);
    }
  }

  private _normalizeUrl(url: string, encodeUrl: boolean): string {
    if (!encodeUrl) return url;
    try {
      return new URL(url).toString();
    } catch {
      return url;
    }
  }

  private _hasHeader(headers: Record<string, string>, name: string): boolean {
    const lower = name.toLowerCase();
    return Object.keys(headers).some(header => header.toLowerCase() === lower);
  }

  private _deleteHeader(headers: Record<string, string>, name: string): void {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) delete headers[key];
    }
  }

  private _resolveSettings(
    settings: HttpRequestSettings | undefined,
    config: vscode.WorkspaceConfiguration,
  ): ResolvedHttpRequestSettings {
    return {
      timeout: (settings?.timeout !== 'inherit' ? settings?.timeout : undefined) ?? config.get<number>('timeout', 30000),
      followRedirects: (settings?.followRedirects !== 'inherit' && settings?.followRedirects) ?? config.get<boolean>('followRedirects', true),
      maxRedirects: (settings?.maxRedirects !== 'inherit' ? settings?.maxRedirects : undefined) ?? config.get<number>('maxRedirects', 5),
      encodeUrl: (settings?.encodeUrl !== 'inherit' && settings?.encodeUrl) ?? true,
    };
  }

  private _resolveBody(body: HttpRequestDetails['body']): HttpRequestBody | undefined {
    if (!body) { return undefined; }
    if (Array.isArray(body)) {
      // HttpRequestBodyVariant[] — pick selected
      const variants = body as HttpRequestBodyVariant[];
      const selected = variants.find(v => v.selected) ?? variants[0];
      return selected?.body;
    }
    return body as HttpRequestBody;
  }

  private _buildBody(
    body: HttpRequestBody,
    headers: Record<string, string>,
    variables: Map<string, string>,
  ): string | undefined {
    switch (body.type) {
      case 'json':
      case 'text':
      case 'xml':
      case 'sparql': {
        if (!headers['Content-Type'] && !headers['content-type']) {
          const contentTypes: Record<string, string> = {
            json: 'application/json',
            text: 'text/plain',
            xml: 'application/xml',
            sparql: 'application/sparql-query',
          };
          headers['Content-Type'] = contentTypes[body.type] ?? 'text/plain';
        }
        // Use JSON-aware interpolation for JSON bodies so "{{var}}" with numeric/boolean/null
        // values produces typed JSON (e.g. 42 instead of "42")
        return body.type === 'json'
          ? this._environmentService.interpolateJson(body.data, variables)
          : this._environmentService.interpolate(body.data, variables);
      }
      case 'form-urlencoded': {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        const params = new URLSearchParams();
        for (const entry of body.data) {
          if (!entry.disabled) {
            params.set(
              this._environmentService.interpolate(entry.name, variables),
              this._environmentService.interpolate(entry.value, variables),
            );
          }
        }
        return params.toString();
      }
      case 'multipart-form': {
        // For simplicity, use a boundary-based approach
        const boundary = `----MissioBoundary${Date.now()}`;
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        const parts: string[] = [];
        for (const entry of body.data) {
          if (entry.disabled) { continue; }
          const name = this._environmentService.interpolate(entry.name, variables);
          if (entry.type === 'text') {
            const value = this._environmentService.interpolate(
              typeof entry.value === 'string' ? entry.value : entry.value[0],
              variables,
            );
            parts.push(
              `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`,
            );
          }
          // File type would need fs access — omitted for lightweight impl
        }
        parts.push(`--${boundary}--\r\n`);
        return parts.join('\r\n');
      }
      default:
        return undefined;
    }
  }

  private async _applyOAuth2(
    auth: AuthOAuth2,
    headers: Record<string, string>,
    variables: Map<string, string>,
    collection: MissioCollection,
    environmentName?: string,
    url = '',
    encodeUrl = true,
  ): Promise<string> {
    if (!this._oauth2Service) {
      throw new Error('OAuth2 service not available');
    }

    // Interpolate + resolve $secret references in all OAuth2 config fields
    const providers = collection.data.config?.secretProviders ?? [];
    const resolve = async (val: string | undefined): Promise<string | undefined> => {
      if (!val) return undefined;
      let result = this._environmentService.interpolate(val, variables);
      if (providers.length > 0 && this._secretService) {
        result = await this._secretService.resolveSecretReferences(result, providers, variables);
      }
      return result;
    };

    const creds = auth.credentials;
    const interpolatedCreds = creds ? {
      clientId: await resolve(creds.clientId),
      clientSecret: 'clientSecret' in creds ? await resolve(creds.clientSecret) : undefined,
      placement: 'placement' in creds ? creds.placement : undefined,
    } : undefined;

    const base: any = {
      type: 'oauth2',
      flow: auth.flow,
      accessTokenUrl: await resolve(auth.accessTokenUrl),
      refreshTokenUrl: await resolve(auth.refreshTokenUrl),
      scope: await resolve(auth.scope),
      credentials: interpolatedCreds,
      tokenConfig: await this._resolveOAuth2TokenConfig(auth.tokenConfig, resolve),
      additionalParameters: await this._resolveOAuth2AdditionalParameters(auth.additionalParameters, resolve),
      settings: auth.settings,
      credentialsId: auth.credentialsId,
    };

    // Flow-specific fields
    if (auth.flow === 'resource_owner_password_credentials') {
      const owner = (auth as import('../models/types').AuthOAuth2ResourceOwnerPassword).resourceOwner;
      if (owner) {
        base.resourceOwner = {
          username: await resolve(owner.username),
          password: await resolve(owner.password),
        };
      }
    } else if (auth.flow === 'authorization_code') {
      const ac = auth as import('../models/types').AuthOAuth2AuthorizationCode;
      base.authorizationUrl = await resolve(ac.authorizationUrl);
      base.callbackUrl = ac.callbackUrl;
      base.state = await resolve(ac.state);
      base.pkce = ac.pkce;
    } else if (auth.flow === 'implicit') {
      const implicit = auth as import('../models/types').AuthOAuth2Implicit;
      base.authorizationUrl = await resolve(implicit.authorizationUrl);
      base.callbackUrl = implicit.callbackUrl;
      base.state = await resolve(implicit.state);
    }

    const interpolated: AuthOAuth2 = base;

    const envName = environmentName ?? this._environmentService.getActiveEnvironmentName(collection.id);
    const token = await this._oauth2Service.getToken(interpolated, collection.id, envName);

    if (token) {
      return this._applyOAuth2Token(interpolated, headers, token, url, encodeUrl);
    }
    return url;
  }

  private _applyOAuth2Token(
    auth: AuthOAuth2,
    headers: Record<string, string>,
    token: string,
    url: string,
    encodeUrl: boolean,
  ): string {
    const placement = auth.tokenConfig?.placement;
    if (placement && 'query' in placement) {
      const parsed = new URL(url);
      this._setQueryParam(parsed, placement.query || 'access_token', token, encodeUrl);
      return parsed.toString();
    }

    const headerName = placement && 'header' in placement ? placement.header : 'Authorization';
    headers[headerName || 'Authorization'] = (headerName || 'Authorization').toLowerCase() === 'authorization'
      ? `Bearer ${token}`
      : token;
    return url;
  }

  private async _resolveOAuth2TokenConfig(
    tokenConfig: AuthOAuth2['tokenConfig'],
    resolve: (value: string | undefined) => Promise<string | undefined>,
  ): Promise<AuthOAuth2['tokenConfig']> {
    if (!tokenConfig) return undefined;
    const placement = tokenConfig.placement;
    let resolvedPlacement = placement;
    if (placement && 'header' in placement) {
      resolvedPlacement = { header: await resolve(placement.header) ?? placement.header };
    } else if (placement && 'query' in placement) {
      resolvedPlacement = { query: await resolve(placement.query) ?? placement.query };
    }
    return {
      id: await resolve(tokenConfig.id),
      placement: resolvedPlacement,
    };
  }

  private async _resolveOAuth2AdditionalParameters(
    params: OAuth2AdditionalParameters | undefined,
    resolve: (value: string | undefined) => Promise<string | undefined>,
  ): Promise<OAuth2AdditionalParameters | undefined> {
    if (!params) return undefined;
    const resolveEntries = async (entries: OAuth2AdditionalParameter[] | undefined): Promise<OAuth2AdditionalParameter[] | undefined> => {
      if (!entries) return undefined;
      return Promise.all(entries.map(async entry => ({
        ...entry,
        name: await resolve(entry.name),
        value: await resolve(entry.value),
      })));
    };
    return {
      authorizationRequest: await resolveEntries(params.authorizationRequest),
      accessTokenRequest: await resolveEntries(params.accessTokenRequest),
      refreshTokenRequest: await resolveEntries(params.refreshTokenRequest),
    };
  }

  private _isAuthComplete(auth: Exclude<Auth, 'inherit'>): boolean {
    switch (auth.type) {
      case 'basic':
        return !!(auth.username || auth.password);
      case 'bearer':
        return !!auth.token;
      case 'apikey':
        return !!auth.key;
      case 'cli':
        return !!auth.command;
      case 'oauth2':
        return true; // OAuth2 has its own validation path
      default:
        return true;
    }
  }

  /**
   * Apply CLI auth. Returns the time spent waiting for user approval (0 if no approval needed).
   */
  private async _applyCliAuth(
    auth: AuthCli,
    headers: Record<string, string>,
    variables: Map<string, string>,
    collection: MissioCollection,
    approvalPrompt?: CliApprovalPrompt,
  ): Promise<number> {
    const commandTemplate = auth.command;
    let approvalWaitMs = 0;

    // Interpolate command with variables
    let command = this._environmentService.interpolate(commandTemplate, variables);

    // Resolve $secret references in command
    const providers = collection.data.config?.secretProviders ?? [];
    if (providers.length > 0 && this._secretService) {
      command = await this._secretService.resolveSecretReferences(command, providers, variables);
    }

    const cacheEnabled = auth.cache?.enabled !== false;
    // Key on the fully resolved command so env-specific variables and secrets
    // produce distinct cache entries.
    const cacheKey = `${collection.id}:${command}`;

    // Check cache
    if (cacheEnabled) {
      const cached = this._cliTokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        _log(`  CLI auth: using cached token (expires in ${Math.round((cached.expiresAt - Date.now()) / 1000)}s)`);
        this._setCliTokenHeader(headers, auth, cached.token);
        return 0;
      }
    }

    // Check if the fully interpolated command is approved
    if (this._cliAuthApprovalService && !this._cliAuthApprovalService.isApproved(command)) {
      _log(`  CLI auth: command not approved, prompting user`);
      if (!approvalPrompt) {
        throw new Error(
          `CLI auth command requires user approval before execution. ` +
          `The user must first run this request interactively in the Missio request panel to approve the command. ` +
          `Command: ${command}`
        );
      }
      const approvalStart = Date.now();
      const approved = await approvalPrompt(commandTemplate, command);
      approvalWaitMs = Date.now() - approvalStart;
      if (!approved) {
        throw new Error('CLI auth command was not approved by user');
      }
      // Store approval for the interpolated command
      await this._cliAuthApprovalService.approve(command);
      _log(`  CLI auth: command approved and stored`);
    }

    // Execute command
    _log(`  CLI auth: executing command`);
    let token: string;
    try {
      const { stdout, stderr } = await execAsync(command, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      });
      if (stderr) _log(`  CLI auth: stderr: ${stderr.trim()}`);
      token = this._normalizeCliToken(stdout, auth);
    } catch (err: any) {
      const msg = err.stderr?.toString() || err.message || 'Unknown error';
      throw new Error(`CLI auth command failed: ${msg}`);
    }

    if (!token) {
      throw new Error('CLI auth command returned empty token');
    }

    // Determine TTL
    let ttlMs: number;
    if (auth.cache?.ttlSeconds !== undefined) {
      ttlMs = auth.cache.ttlSeconds * 1000;
    } else {
      // Try to parse JWT expiry
      ttlMs = this._parseJwtTtl(token) ?? 3600 * 1000; // default 1 hour
    }

    // Cache token
    if (cacheEnabled) {
      this._cliTokenCache.set(cacheKey, {
        token,
        expiresAt: this._computeCliCacheExpiry(ttlMs),
      });
      _log(`  CLI auth: cached token for ${Math.round(ttlMs / 1000)}s`);
    }

    this._setCliTokenHeader(headers, auth, token);
    return approvalWaitMs;
  }

  private _setCliTokenHeader(headers: Record<string, string>, auth: AuthCli, token: string): void {
    const headerName = auth.tokenHeader || 'Authorization';
    const prefix = auth.tokenPrefix !== undefined ? auth.tokenPrefix : 'Bearer';
    headers[headerName] = prefix ? `${prefix} ${token}` : token;
  }

  private _normalizeCliToken(stdout: string, auth: AuthCli): string {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return '';
    }

    if (this._looksLikeStructuredCliOutput(trimmed)) {
      throw new Error(this._buildCliTokenOutputError(auth, 'returned structured JSON output'));
    }
    const token = trimmed;

    if (/[\r\n\0]/.test(token)) {
      throw new Error(this._buildCliTokenOutputError(auth, 'returned line breaks or null bytes'));
    }

    return token;
  }

  private _looksLikeStructuredCliOutput(output: string): boolean {
    return (output.startsWith('{') && output.endsWith('}')) || (output.startsWith('[') && output.endsWith(']'));
  }

  private _buildCliTokenOutputError(auth: AuthCli, reason: string): string {
    const headerName = auth.tokenHeader || 'Authorization';
    return (
      `CLI auth command ${reason}. ` +
      `It must print a single header-safe token value for ${headerName}. ` +
      `If your CLI returns JSON, add a query/format step such as --query <path> -o tsv.`
    );
  }

  private _computeCliCacheExpiry(ttlMs: number): number {
    const safetyMarginMs = Math.min(60000, Math.floor(ttlMs * 0.1));
    return Date.now() + Math.max(ttlMs - safetyMarginMs, 0);
  }

  private _parseJwtTtl(token: string): number | undefined {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return undefined;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      if (typeof payload.exp === 'number') {
        const expiresAt = payload.exp * 1000;
        const ttl = expiresAt - Date.now();
        return ttl > 0 ? ttl : undefined;
      }
    } catch {
      // Not a JWT or invalid format
    }
    return undefined;
  }

  private _applyAuth(
    auth: Exclude<Auth, 'inherit'>,
    headers: Record<string, string>,
    variables: Map<string, string>,
    url: string,
    encodeUrl = true,
  ): string {
    switch (auth.type) {
      case 'basic':
        headers['Authorization'] = 'Basic ' + Buffer.from(
          `${this._environmentService.interpolate(auth.username || '', variables)}:${this._environmentService.interpolate(auth.password || '', variables)}`
        ).toString('base64');
        return url;
      case 'bearer': {
        const token = this._environmentService.interpolate(auth.token ?? '', variables);
        headers['Authorization'] = `Bearer ${token}`;
        return url;
      }
      case 'apikey': {
        const key = this._environmentService.interpolate(auth.key ?? '', variables);
        const value = this._environmentService.interpolate(auth.value ?? '', variables);
        if (!key) return url;
        if (auth.placement === 'query') {
          const parsed = new URL(url);
          this._setQueryParam(parsed, key, value, encodeUrl);
          return parsed.toString();
          // Handled elsewhere — would need URL mutation
        } else {
          headers[key] = value;
        }
        return url;
      }
      // digest, ntlm, wsse, awsv4 — complex auth flows, stub for now
      default:
        throw new Error(`Authentication type "${(auth as any).type ?? 'unknown'}" is not supported by the Missio runtime yet.`);
    }
  }

  dispose(): void {
    this.cancelAll();
  }
}
