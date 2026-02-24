import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type {
  HttpRequest, HttpRequestDetails, HttpRequestBody,
  Auth, AuthOAuth2, HttpResponse, HttpRequestSettings, HttpRequestBodyVariant,
  MissioCollection,
} from '../models/types';
import type { EnvironmentService } from './environmentService';
import type { OAuth2Service } from './oauth2Service';
import type { SecretService } from './secretService';

const _logChannel = vscode.window.createOutputChannel('Missio Requests');
function _log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  _logChannel.appendLine(`[${ts}] ${msg}`);
}
export { _logChannel as requestLog };

export class HttpClient implements vscode.Disposable {
  private _activeRequests: Map<string, http.ClientRequest> = new Map();
  private _oauth2Service: OAuth2Service | undefined;
  private _secretService: SecretService | undefined;

  constructor(private readonly _environmentService: EnvironmentService) {}

  setOAuth2Service(oauth2Service: OAuth2Service): void {
    this._oauth2Service = oauth2Service;
  }

  setSecretService(secretService: SecretService): void {
    this._secretService = secretService;
  }

  async send(
    request: HttpRequest,
    collection: MissioCollection,
    folderDefaults?: import('../models/types').RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
  ): Promise<HttpResponse> {
    const t0 = Date.now();
    const _timing: { label: string; start: number; end: number }[] = [];
    const _mark = (label: string, start: number) => { _timing.push({ label, start: start - t0, end: Date.now() - t0 }); };
    _log(`── Send ${request.http?.method ?? '?'} ${request.http?.url ?? '?'} ──`);
    let tPhase = Date.now();
    const variables = await this._environmentService.resolveVariables(collection, folderDefaults);
    // Merge ephemeral extra variables (e.g. user-prompted values for unresolved vars)
    if (extraVariables) {
      for (const [k, v] of extraVariables) variables.set(k, v);
    }
    _mark('Resolve Variables', tPhase);
    _log(`  resolveVariables: ${Date.now() - t0}ms`);
    const details = request.http;
    if (!details?.url || !details?.method) {
      throw new Error('Request must have a URL and method');
    }

    const config = vscode.workspace.getConfiguration('missio');
    const settings = this._resolveSettings(request.settings, config);

    // Interpolate URL
    let url = this._environmentService.interpolate(details.url, variables);

    // Auto-prepend http:// if no scheme provided (matches Postman behaviour)
    if (url && !/^https?:\/\//i.test(url)) {
      url = 'http://' + url;
    }

    // Apply query params — params array is the source of truth, so strip any
    // query string baked into the URL (common Postman import artifact)
    const allQueryParams = (details.params ?? []).filter(p => p.type === 'query');
    if (allQueryParams.length > 0) {
      const urlObj = new URL(url);
      urlObj.search = '';
      for (const p of allQueryParams) {
        if (p.disabled) continue;
        const resolvedValue = this._environmentService.interpolate(p.value, variables);
        if (resolvedValue === '') continue; // Skip empty-value params
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

    // Collection default headers
    const defaultHeaders = collection.data.request?.headers ?? [];
    for (const h of defaultHeaders) {
      if (!h.disabled) {
        headers[this._environmentService.interpolate(h.name, variables)] =
          this._environmentService.interpolate(h.value, variables);
      }
    }

    // Folder default headers (override collection)
    if (folderDefaults?.headers) {
      for (const h of folderDefaults.headers) {
        if (!h.disabled) {
          headers[this._environmentService.interpolate(h.name, variables)] =
            this._environmentService.interpolate(h.value, variables);
        }
      }
    }

    // Request headers (override folder and collection)
    for (const h of (details.headers ?? [])) {
      if (!h.disabled) {
        headers[this._environmentService.interpolate(h.name, variables)] =
          this._environmentService.interpolate(h.value, variables);
      }
    }

    _mark('Interpolate + Params', tPhase);
    _log(`  interpolate+params: ${Date.now() - t0}ms`);
    tPhase = Date.now();
    // Auth: request -> folder -> collection (first non-inherit wins)
    // forceAuthInherit: skip request/folder auth, go straight to collection
    // If the inherited auth is incomplete, fall back to the normal chain
    let auth: Auth | undefined;
    if (collection.data.config?.forceAuthInherit) {
      const collectionAuth = collection.data.request?.auth;
      if (collectionAuth && collectionAuth !== 'inherit' && this._isAuthComplete(collectionAuth)) {
        auth = collectionAuth;
      } else {
        // Fall back to normal chain when collection auth is incomplete
        auth = request.runtime?.auth;
        if (!auth || auth === 'inherit') auth = folderDefaults?.auth;
        if (!auth || auth === 'inherit') auth = collectionAuth;
      }
    } else {
      auth = request.runtime?.auth;
      if (!auth || auth === 'inherit') {
        auth = folderDefaults?.auth;
      }
      if (!auth || auth === 'inherit') {
        auth = collection.data.request?.auth;
      }
    }
    if (auth && auth !== 'inherit') {
      if (auth.type === 'oauth2') {
        await this._applyOAuth2(auth as AuthOAuth2, headers, variables, collection);
      } else {
        this._applyAuth(auth, headers, variables);
      }
    }

    _mark('Auth', tPhase);
    _log(`  auth: ${Date.now() - t0}ms`);
    onProgress?.('Sending request…');
    tPhase = Date.now();
    // Body
    let body: string | Buffer | undefined;
    const resolvedBody = this._resolveBody(details.body);
    if (resolvedBody) {
      const result = this._buildBody(resolvedBody, headers, variables);
      body = result;
    }

    _mark('Body', tPhase);
    _log(`  body: ${Date.now() - t0}ms`);
    tPhase = Date.now();
    // Resolve $secret references in URL, headers, and body
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

    _mark('Secrets', tPhase);
    _log(`  secrets: ${Date.now() - t0}ms`);
    // Execute
    _log(`  executing: ${details.method} ${url}`);
    tPhase = Date.now();
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    const requestId = `${Date.now()}-${Math.random()}`;

    return new Promise<HttpResponse>((resolve, reject) => {
      const startTime = Date.now();

      const options: http.RequestOptions = {
        method: details.method!.toUpperCase(),
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
        const bodyBuffer = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
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
        return this._environmentService.interpolate(body.data, variables);
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

    const envName = this._environmentService.getActiveEnvironmentName(collection.id);
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
      case 'oauth2':
        return true; // OAuth2 has its own validation path
      default:
        return true;
    }
  }

  private _applyAuth(
    auth: Exclude<Auth, 'inherit'>,
    headers: Record<string, string>,
    variables: Map<string, string>,
  ): void {
    switch (auth.type) {
      case 'basic': {
        const user = this._environmentService.interpolate(auth.username ?? '', variables);
        const pass = this._environmentService.interpolate(auth.password ?? '', variables);
        headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        break;
      }
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
