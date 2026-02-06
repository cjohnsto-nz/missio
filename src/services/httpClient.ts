import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type {
  HttpRequest, HttpRequestDetails, HttpRequestBody,
  HttpRequestHeader, HttpRequestParam,
  Auth, HttpResponse, HttpRequestSettings, HttpRequestBodyVariant,
} from '../models/types';
import type { EnvironmentService } from './environmentService';
import type { MissioCollection } from '../models/types';

export class HttpClient implements vscode.Disposable {
  private _activeRequests: Map<string, http.ClientRequest> = new Map();

  constructor(private readonly _environmentService: EnvironmentService) {}

  async send(
    request: HttpRequest,
    collection: MissioCollection,
  ): Promise<HttpResponse> {
    const variables = await this._environmentService.resolveVariables(collection);
    const details = request.http;
    if (!details?.url || !details?.method) {
      throw new Error('Request must have a URL and method');
    }

    const config = vscode.workspace.getConfiguration('missio');
    const settings = this._resolveSettings(request.settings, config);

    // Interpolate URL
    let url = this._environmentService.interpolate(details.url, variables);

    // Apply query params
    const queryParams = (details.params ?? []).filter(p => p.type === 'query' && !p.disabled);
    if (queryParams.length > 0) {
      const urlObj = new URL(url);
      for (const p of queryParams) {
        urlObj.searchParams.set(
          this._environmentService.interpolate(p.name, variables),
          this._environmentService.interpolate(p.value, variables),
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

    // Build headers
    const headers: Record<string, string> = {};

    // Collection default headers
    const defaultHeaders = collection.data.request?.headers ?? [];
    for (const h of defaultHeaders) {
      if (!h.disabled) {
        headers[this._environmentService.interpolate(h.name, variables)] =
          this._environmentService.interpolate(h.value, variables);
      }
    }

    // Request headers (override defaults)
    for (const h of (details.headers ?? [])) {
      if (!h.disabled) {
        headers[this._environmentService.interpolate(h.name, variables)] =
          this._environmentService.interpolate(h.value, variables);
      }
    }

    // Auth
    const auth = details.auth ?? collection.data.request?.auth;
    if (auth && auth !== 'inherit') {
      this._applyAuth(auth, headers, variables);
    }

    // Body
    let body: string | Buffer | undefined;
    const resolvedBody = this._resolveBody(details.body);
    if (resolvedBody) {
      const result = this._buildBody(resolvedBody, headers, variables);
      body = result;
    }

    // Execute
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

          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
            body: buffer.toString('utf-8'),
            duration,
            size: buffer.length,
          });
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

      // Handle redirects manually if needed
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  cancelAll(): void {
    for (const [id, req] of this._activeRequests) {
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
