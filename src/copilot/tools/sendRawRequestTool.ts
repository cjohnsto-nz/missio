import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { EnvironmentService } from '../../services/environmentService';

export interface SendRawRequestParams {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  collectionId?: string;
  environment?: string;
  variables?: Record<string, unknown>;
  responseOutputPath?: string;
  extract?: Record<string, string>;
}

export class SendRawRequestTool extends ToolBase<SendRawRequestParams> {
  public readonly toolName = 'missio_send_raw_request';

  constructor(
    private _collectionService: CollectionService,
    private _environmentService: EnvironmentService,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<SendRawRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { method, headers: rawHeaders, body: rawBody, collectionId, environment, variables, responseOutputPath, extract } = options.input;
    let { url } = options.input;

    // Build variable map from collection if available
    const collection = this._collectionService.resolveCollection(collectionId);
    const varMap = new Map<string, string>();
    if (collection) {
      const resolved = await this._environmentService.resolveVariables(collection, undefined, environment);
      for (const [k, v] of resolved) varMap.set(k, v);
    }
    // Merge user-provided variable overrides (highest priority)
    if (variables) {
      for (const [k, v] of Object.entries(variables)) varMap.set(k, String(v));
    }

    // Interpolate URL
    url = this._environmentService.interpolate(url, varMap);
    if (!/^https?:\/\//i.test(url)) {
      url = 'http://' + url;
    }

    // Build headers — interpolate values
    const headers: Record<string, string> = {};
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[this._environmentService.interpolate(k, varMap)] =
          this._environmentService.interpolate(v, varMap);
      }
    }

    // Apply collection-level auth if available and no Authorization header provided
    if (collection && !headers['Authorization'] && !headers['authorization']) {
      const auth = collection.data.request?.auth;
      if (auth && auth !== 'inherit') {
        this._applyBasicAuth(auth, headers, varMap);
      }
    }

    // Build body
    let bodyStr: string | undefined;
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody === 'string') {
        // String body: interpolate variables
        bodyStr = this._environmentService.interpolate(rawBody, varMap);
      } else {
        // Object/array/number/boolean: serialize as JSON (no interpolation — already constructed)
        bodyStr = JSON.stringify(rawBody);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    // Execute HTTP request
    const startTime = Date.now();
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    return new Promise<string>((resolve) => {
      const reqOptions: http.RequestOptions = {
        method: method.toUpperCase(),
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers,
        timeout: 30_000,
      };

      if (isHttps) {
        (reqOptions as https.RequestOptions).rejectUnauthorized =
          vscode.workspace.getConfiguration('missio').get<boolean>('rejectUnauthorized', true);
      }

      const req = requestModule.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const duration = Date.now() - startTime;
          const responseHeaders: Record<string, string> = {};
          for (const [key, val] of Object.entries(res.headers)) {
            if (val) responseHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
          }

          const responseBody = buffer.toString('utf-8');

          // Write response body to file if requested
          if (responseOutputPath) {
            try {
              const dir = path.dirname(responseOutputPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(responseOutputPath, responseBody, 'utf-8');
            } catch { /* non-fatal */ }
          }

          const result: Record<string, unknown> = {
            success: true,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: responseHeaders,
            body: responseBody.length > 10_000
              ? responseBody.substring(0, 10_000) + '\n... (truncated)'
              : responseBody,
            duration,
            size: buffer.length,
          };

          if (responseOutputPath) result.savedTo = responseOutputPath;

          // Extract values from JSON response body
          if (extract && responseBody) {
            try {
              const json = JSON.parse(responseBody);
              const extracted: Record<string, unknown> = {};
              for (const [key, jsonPath] of Object.entries(extract)) {
                extracted[key] = this._extractByPath(json, jsonPath);
              }
              result.extracted = extracted;
            } catch {
              result.extractError = 'Response body is not valid JSON; extraction skipped.';
            }
          }

          resolve(JSON.stringify(result));
        });
      });

      req.on('error', (err) => {
        resolve(JSON.stringify({ success: false, message: `Request failed: ${err.message}` }));
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(JSON.stringify({ success: false, message: 'Request timed out' }));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SendRawRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const { method, url } = options.input;
    return {
      invocationMessage: `Sending ${method.toUpperCase()} ${url}`,
      confirmationMessages: {
        title: 'Missio: Send Raw Request',
        message: new vscode.MarkdownString(`Execute **${method.toUpperCase()}** \`${url}\`?`),
      },
    };
  }

  // ── Helpers ──

  private _applyBasicAuth(
    auth: Exclude<import('../../models/types').Auth, 'inherit'>,
    headers: Record<string, string>,
    variables: Map<string, string>,
  ): void {
    switch (auth.type) {
      case 'bearer':
        if (auth.token) {
          headers['Authorization'] = `Bearer ${this._environmentService.interpolate(auth.token, variables)}`;
        }
        break;
      case 'basic':
        if (auth.username) {
          const user = this._environmentService.interpolate(auth.username, variables);
          const pass = this._environmentService.interpolate(auth.password ?? '', variables);
          headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        }
        break;
      case 'apikey':
        if (auth.key && auth.value) {
          const key = this._environmentService.interpolate(auth.key, variables);
          const val = this._environmentService.interpolate(auth.value, variables);
          if (auth.placement === 'query') {
            // Can't easily modify URL at this point, add as header instead
            headers[key] = val;
          } else {
            headers[key] = val;
          }
        }
        break;
    }
  }

  /** Simple dot-path/bracket-index extractor */
  private _extractByPath(obj: unknown, jsonPath: string): unknown {
    const segments = jsonPath.replace(/\[(\d+)\]/g, '.$1').split('.');
    let current: unknown = obj;
    for (const seg of segments) {
      if (current === undefined || current === null) return undefined;
      current = (current as Record<string, unknown>)[seg];
    }
    return current;
  }
}
