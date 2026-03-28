import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  HttpRequest, HttpRequestDetails, HttpRequestBody,
  Auth, AuthOAuth2, AuthCli, HttpResponse, HttpRequestSettings, HttpRequestBodyVariant,
  MissioCollection,
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
        urlObj.searchParams.set(
          this._environmentService.interpolate(p.name, variables),
          resolvedValue,
        );
      }
      url = urlObj.toString();
    }

    // Apply path params
    const pathParams = (details.params ?? []).filter(p => p.type === 'path' && !p.disabled);
    for (const p of pathParams) {
      const name = this._environmentService.interpolate(p.name, variables);
      const value = this._environmentService.interpolate(p.value, variables);
      url = url.replace(`:${name}`, encodeURIComponent(value));
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
          await this._applyOAuth2(auth as AuthOAuth2, headers, variables, collection, environmentName);
        } else if (auth.type === 'cli') {
          await this._applyCliAuth(auth as AuthCli, headers, variables, collection, cliApprovalPrompt);
        } else {
          this._applyAuth(auth, headers, variables);
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
    // Execute
    const { method, url, headers, body } = resolved;
    _log(`  executing: ${method} ${url}`);
    tPhase = Date.now();
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    const requestId = `${Date.now()}-${Math.random()}`;

    return new Promise<HttpResponse>((resolve, reject) => {
      const startTime = Date.now();

      const options: http.RequestOptions = {
        method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers,
        timeout: settings.timeout,
      };

      if (isHttps) {
        (options as https.RequestOptions).rejectUnauthorized =
          vscode.workspace.getConfiguration('missio').get<boolean>('rejectUnauthorized', true);
      }

      const req = requestModule.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          this._activeRequests.delete(requestId);
          const buffer = Buffer.concat(chunks);
          const duration = Date.now() - startTime;
          const responseHeaders: Record<string, string> = {};
          for (const [key, val] of Object.entries(res.headers)) {
            if (val) {
              responseHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
            }
          }

          _mark('HTTP', tPhase);

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
            timing: _timing,
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

      if (body) {
        const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
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

  private _resolveSettings(
    settings: HttpRequestSettings | undefined,
    config: vscode.WorkspaceConfiguration,
  ) {
    return {
      timeout: (settings?.timeout !== 'inherit' && settings?.timeout) || config.get<number>('timeout', 30000),
      followRedirects: (settings?.followRedirects !== 'inherit' && settings?.followRedirects) ?? config.get<boolean>('followRedirects', true),
      maxRedirects: (settings?.maxRedirects !== 'inherit' && settings?.maxRedirects) || config.get<number>('maxRedirects', 5),
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
  ): Promise<void> {
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
      clientSecret: await resolve(creds.clientSecret),
      placement: creds.placement,
    } : undefined;

    const base: any = {
      type: 'oauth2',
      flow: auth.flow,
      accessTokenUrl: await resolve(auth.accessTokenUrl),
      refreshTokenUrl: await resolve(auth.refreshTokenUrl),
      scope: await resolve(auth.scope),
      credentials: interpolatedCreds,
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
      base.pkce = ac.pkce;
    }

    const interpolated: AuthOAuth2 = base;

    const envName = environmentName ?? this._environmentService.getActiveEnvironmentName(collection.id);
    const token = await this._oauth2Service.getToken(interpolated, collection.id, envName);

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
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
      token = stdout.trim();
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
  ): void {
    switch (auth.type) {
      case 'basic':
        headers['Authorization'] = 'Basic ' + Buffer.from(
          `${this._environmentService.interpolate(auth.username || '', variables)}:${this._environmentService.interpolate(auth.password || '', variables)}`
        ).toString('base64');
        break;
      case 'bearer': {
        const token = this._environmentService.interpolate(auth.token ?? '', variables);
        headers['Authorization'] = `Bearer ${token}`;
        break;
      }
      case 'apikey': {
        const key = this._environmentService.interpolate(auth.key ?? '', variables);
        const value = this._environmentService.interpolate(auth.value ?? '', variables);
        if (auth.placement === 'query') {
          // Handled elsewhere — would need URL mutation
        } else {
          headers[key] = value;
        }
        break;
      }
      // digest, ntlm, wsse, awsv4 — complex auth flows, stub for now
      default:
        break;
    }
  }

  dispose(): void {
    this.cancelAll();
  }
}
