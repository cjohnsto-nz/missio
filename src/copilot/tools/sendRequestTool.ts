import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { EnvironmentService } from '../../services/environmentService';
import { HttpClient } from '../../services/httpClient';
import { readFolderFile } from '../../services/yamlParser';
import { detectUnresolvedVars } from '../../services/unresolvedVars';
import { varPatternGlobal } from '../../models/varPattern';
import * as path from 'path';
import * as fs from 'fs';
import type { Auth } from '../../models/types';

export interface SendRequestParams {
  requestFilePath: string;
  collectionId?: string;
  environment?: string;
  variables?: Record<string, unknown>;
  dryRun?: boolean;
  responseOutputPath?: string;
  extract?: Record<string, string>;
}

export class SendRequestTool extends ToolBase<SendRequestParams> {
  public readonly toolName = 'missio_send_request';

  constructor(
    private _collectionService: CollectionService,
    private _environmentService: EnvironmentService,
    private _httpClient: HttpClient,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<SendRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { collectionId, environment, variables, dryRun, responseOutputPath, extract } = options.input;
    let { requestFilePath } = options.input;

    // Resolve relative paths against collection roots (or specific collectionId)
    if (!path.isAbsolute(requestFilePath)) {
      const resolved = this._resolveRelativePath(requestFilePath, collectionId);
      if (!resolved) {
        return JSON.stringify({ success: false, message: `Cannot resolve relative path "${requestFilePath}" against any collection root.` });
      }
      requestFilePath = resolved;
    }

    const request = await this._collectionService.loadRequestFile(requestFilePath);
    if (!request) {
      return JSON.stringify({ success: false, message: `Failed to load request: ${requestFilePath}` });
    }

    // Find collection: prefer explicit collectionId, fall back to path-based
    const collection = collectionId
      ? this._collectionService.getCollection(collectionId)
      : this._findCollection(requestFilePath);
    if (!collection) {
      return JSON.stringify({ success: false, message: `No parent collection found for: ${requestFilePath}` });
    }

    // Read folder defaults if a folder.yml exists alongside the request
    const folderDefaults = await this._readFolderDefaults(requestFilePath, collection.rootDir);

    // Convert typed variable values to strings for the resolution map.
    // interpolateJson handles smart coercion: "{{var}}" with a value like "0" or "true"
    // will produce unquoted JSON literals in JSON bodies.
    const extraVariables = variables
      ? new Map<string, string>(Object.entries(variables).map(([k, v]) => [k, String(v)]))
      : undefined;

    const warnings: string[] = [];
    if (extraVariables && extraVariables.size > 0) {
      const referenced = this._collectReferencedVarNames(request, collection, folderDefaults);
      const unused = [...extraVariables.keys()].filter(k => !referenced.has(k));
      if (unused.length > 0) {
        warnings.push(
          `Unused variables provided (no matching {{placeholder}} found in the request template): ${unused.map(n => `{{${n}}}`).join(', ')}`,
        );
      }
    }

    // Detect unresolved placeholders before sending
    const unresolvedNames = await detectUnresolvedVars(
      request,
      collection,
      this._environmentService,
      folderDefaults,
      environment,
    );
    // Remove any that are covered by user-provided variable overrides
    const stillUnresolved = extraVariables
      ? unresolvedNames.filter(n => !extraVariables.has(n))
      : unresolvedNames;

    // Dry-run: resolve and preview without sending
    if (dryRun) {
      return this._dryRun(request, collection, folderDefaults, extraVariables, environment, stillUnresolved, warnings);
    }

    // Warn on unresolved placeholders
    if (stillUnresolved.length > 0) {
      return JSON.stringify({
        success: false,
        message: `Unresolved placeholders: ${stillUnresolved.map(n => `{{${n}}}`).join(', ')}. Provide them via the "variables" parameter or set the correct environment.`,
        unresolvedVariables: stillUnresolved,
      });
    }

    const response = await this._httpClient.send(request, collection, folderDefaults, undefined, extraVariables, environment);

    // Write response body to file if requested
    let savedTo: string | undefined;
    if (responseOutputPath) {
      try {
        const dir = path.dirname(responseOutputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(responseOutputPath, response.body, 'utf-8');
        savedTo = responseOutputPath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to write responseOutputPath "${responseOutputPath}": ${message}`);
      }
    }

    // Build result
    const result: Record<string, unknown> = {
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body.length > 10_000
        ? response.body.substring(0, 10_000) + '\n... (truncated)'
        : response.body,
      duration: response.duration,
      size: response.size,
    };

    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    if (savedTo) result.savedTo = savedTo;

    // Extract values from JSON response body
    if (extract && response.body) {
      try {
        const json = JSON.parse(response.body);
        const extracted: Record<string, unknown> = {};
        for (const [key, jsonPath] of Object.entries(extract)) {
          extracted[key] = this._extractByPath(json, jsonPath);
        }
        result.extracted = extracted;
      } catch {
        result.extractError = 'Response body is not valid JSON; extraction skipped.';
      }
    }

    return JSON.stringify(result);
  }

  private _collectReferencedVarNames(
    request: import('../../models/types').HttpRequest,
    collection: import('../../models/types').MissioCollection,
    folderDefaults: import('../../models/types').RequestDefaults | undefined,
  ): Set<string> {
    const referenced = new Set<string>();
    const extract = (s: string | undefined) => {
      if (!s) return;
      const re = varPatternGlobal();
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) referenced.add(m[1].trim());
    };

    const details = request.http;
    if (!details) return referenced;

    extract(details.url);
    for (const h of details.headers ?? []) { if (!h.disabled) { extract(h.name); extract(h.value); } }
    for (const p of details.params ?? []) { if (!p.disabled) { extract(p.name); extract(p.value); } }

    const body = details.body;
    const scanBody = (b: any) => {
      if (!b) return;
      switch (b.type) {
        case 'json':
        case 'text':
        case 'xml':
        case 'sparql':
          extract(b.data);
          break;
        case 'form-urlencoded':
        case 'multipart-form':
          for (const entry of b.data ?? []) {
            if (!entry.disabled) {
              extract(entry.name);
              if (typeof entry.value === 'string') extract(entry.value);
              else if (Array.isArray(entry.value)) entry.value.forEach((v: string) => extract(v));
            }
          }
          break;
      }
    };
    if (body) {
      if (Array.isArray(body)) {
        const selected = (body as any[]).find((v: any) => v.selected) ?? body[0];
        scanBody(selected?.body);
      } else {
        scanBody(body as any);
      }
    }

    // Auth strings may include variables (e.g. bearer token = "{{token}}")
    // Use the same inheritance chain selection as httpClient / unresolvedVars.
    const auth = this._selectEffectiveAuth(request, collection, folderDefaults);
    if (auth && auth !== 'inherit' && typeof auth === 'object') {
      const scanAllStrings = (obj: unknown) => {
        if (typeof obj === 'string') { extract(obj); return; }
        if (Array.isArray(obj)) { for (const item of obj) scanAllStrings(item); return; }
        if (obj && typeof obj === 'object') {
          for (const val of Object.values(obj as Record<string, unknown>)) scanAllStrings(val);
        }
      };
      scanAllStrings(auth);
    }

    return referenced;
  }

  private _selectEffectiveAuth(
    request: import('../../models/types').HttpRequest,
    collection: import('../../models/types').MissioCollection,
    folderDefaults: import('../../models/types').RequestDefaults | undefined,
  ): import('../../models/types').Auth | undefined {
    const collectionAuth = collection.data.request?.auth;
    if (collection.data.config?.forceAuthInherit) {
      if (collectionAuth && collectionAuth !== 'inherit' && this._isAuthComplete(collectionAuth)) {
        return collectionAuth;
      }
    }
    let auth = request.runtime?.auth;
    if (!auth || auth === 'inherit') auth = folderDefaults?.auth;
    if (!auth || auth === 'inherit') auth = collectionAuth;
    return auth;
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
        return true;
      default:
        return true;
    }
  }

  private _applyDryRunAuth(
    request: import('../../models/types').HttpRequest,
    collection: import('../../models/types').MissioCollection,
    folderDefaults: import('../../models/types').RequestDefaults | undefined,
    headers: Record<string, string>,
    variables: Map<string, string>,
  ): void {
    const auth = this._selectEffectiveAuth(request, collection, folderDefaults);
    if (!auth || auth === 'inherit' || typeof auth !== 'object') return;

    switch ((auth as any).type) {
      case 'apikey': {
        const keyRaw = (auth as any).key;
        const placement = (auth as any).placement;
        if (!keyRaw || placement === 'query') return;
        const key = this._environmentService.interpolate(String(keyRaw), variables);
        headers[key] = '[redacted]';
        break;
      }
      case 'bearer': {
        headers['Authorization'] = 'Bearer [redacted]';
        break;
      }
      case 'basic': {
        headers['Authorization'] = 'Basic [redacted]';
        break;
      }
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SendRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const { requestFilePath, dryRun } = options.input;
    if (dryRun) {
      return { invocationMessage: `Previewing request: ${path.basename(requestFilePath)}` };
    }
    return {
      invocationMessage: `Sending HTTP request: ${path.basename(requestFilePath)}`,
      confirmationMessages: {
        title: 'Missio: Send Request',
        message: new vscode.MarkdownString(`Execute the HTTP request at \`${requestFilePath}\`?`),
      },
    };
  }

  // ── Dry-run: resolve and preview without sending ──

  private async _dryRun(
    request: import('../../models/types').HttpRequest,
    collection: import('../../models/types').MissioCollection,
    folderDefaults: import('../../models/types').RequestDefaults | undefined,
    extraVariables: Map<string, string> | undefined,
    environmentName: string | undefined,
    unresolvedNames: string[],
    warnings: string[],
  ): Promise<string> {
    const varsWithSource = await this._environmentService.resolveVariablesWithSource(collection, folderDefaults, environmentName);
    const variables = new Map<string, string>();
    const secretValues = new Set<string>();
    for (const [k, v] of varsWithSource) {
      variables.set(k, v.value);
      if (v.source === 'secret' && v.value) {
        secretValues.add(v.value);
      }
    }
    if (extraVariables) {
      for (const [k, v] of extraVariables) variables.set(k, v);
    }
    const details = request.http;
    const url = details?.url ? this._environmentService.interpolate(details.url, variables) : '';
    const method = details?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const h of details?.headers ?? []) {
      if (!h.disabled) {
        headers[this._environmentService.interpolate(h.name, variables)] =
          this._environmentService.interpolate(h.value, variables);
      }
    }

    // Auth — apply effective auth chain (request → folder → collection), mirroring httpClient selection.
    // We only apply simple auth types here (apikey/basic/bearer). OAuth2 token acquisition is not performed in dryRun.
    this._applyDryRunAuth(request, collection, folderDefaults, headers, variables);
    // Resolve body using the same logic as httpClient._buildBody
    let body: string | undefined;
    const rawBody = details?.body;
    if (rawBody) {
      const resolvedBody = Array.isArray(rawBody)
        ? (rawBody.find((v: any) => v.selected) ?? rawBody[0])?.body
        : rawBody;
      if (resolvedBody) {
        switch (resolvedBody.type) {
          case 'json':
            body = this._environmentService.interpolateJson(resolvedBody.data, variables);
            break;
          case 'text':
          case 'xml':
          case 'sparql':
            body = this._environmentService.interpolate(resolvedBody.data, variables);
            break;
          case 'form-urlencoded': {
            const params = new URLSearchParams();
            for (const entry of resolvedBody.data ?? []) {
              if (!entry.disabled) {
                params.set(
                  this._environmentService.interpolate(entry.name, variables),
                  this._environmentService.interpolate(entry.value, variables),
                );
              }
            }
            body = params.toString();
            break;
          }
        }
      }
    }

    const result: Record<string, unknown> = {
      success: true,
      dryRun: true,
      method,
      url: this._redactSensitiveUrl(url, secretValues),
      headers: this._redactSensitiveHeaders(headers, secretValues),
    };
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    if (body !== undefined) {
      body = this._redactSecretValues(body, secretValues);
      result.body = body.length > 10_000
        ? body.substring(0, 10_000) + '\n... (truncated)'
        : body;
    }
    if (unresolvedNames.length > 0) {
      result.unresolvedVariables = unresolvedNames;
    }
    return JSON.stringify(result);
  }

  private _redactSensitiveHeaders(
    headers: Record<string, string>,
    secretValues: Set<string>,
  ): Record<string, string> {
    const redacted: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.trim().toLowerCase();
      if (lower === 'authorization' || lower === 'proxy-authorization') {
        const scheme = value.match(/^([A-Za-z]+)\s+/)?.[1];
        redacted[name] = scheme ? `${scheme} [redacted]` : '[redacted]';
        continue;
      }
      if (this._isSensitiveHeaderName(lower)) {
        redacted[name] = '[redacted]';
        continue;
      }
      redacted[name] = this._redactSecretValues(value, secretValues);
    }
    return redacted;
  }

  private _redactSensitiveUrl(url: string, secretValues: Set<string>): string {
    let masked = this._redactSecretValues(url, secretValues);
    try {
      const parsed = new URL(masked);
      for (const [name, value] of parsed.searchParams.entries()) {
        if (this._isSensitiveQueryName(name.toLowerCase())) {
          parsed.searchParams.set(name, '[redacted]');
        } else {
          const maybeRedacted = this._redactSecretValues(value, secretValues);
          if (maybeRedacted !== value) {
            parsed.searchParams.set(name, maybeRedacted);
          }
        }
      }
      masked = parsed.toString();
    } catch {
      // leave as-is when URL parsing fails
    }
    return masked;
  }

  private _isSensitiveHeaderName(lowerHeaderName: string): boolean {
    return lowerHeaderName === 'cookie'
      || lowerHeaderName === 'set-cookie'
      || lowerHeaderName.includes('api-key')
      || lowerHeaderName.includes('apikey')
      || lowerHeaderName.includes('token')
      || lowerHeaderName.includes('secret')
      || lowerHeaderName.includes('auth');
  }

  private _isSensitiveQueryName(lowerQueryName: string): boolean {
    return lowerQueryName.includes('token')
      || lowerQueryName.includes('apikey')
      || lowerQueryName.includes('api_key')
      || lowerQueryName.includes('secret')
      || lowerQueryName.includes('password')
      || lowerQueryName.includes('auth')
      || lowerQueryName.includes('key');
  }

  private _redactSecretValues(value: string, secretValues: Set<string>): string {
    let masked = value;
    for (const secret of secretValues) {
      if (!secret) continue;
      masked = masked.split(secret).join('[secret]');
    }
    return masked;
  }

  // ── Helpers ──

  private _resolveRelativePath(relativePath: string, collectionId?: string): string | undefined {
    const normalized = relativePath.replace(/\//g, path.sep);
    // If collectionId is specified, resolve against that collection only
    if (collectionId) {
      const c = this._collectionService.getCollection(collectionId);
      return c ? path.join(c.rootDir, normalized) : undefined;
    }
    const collections = this._collectionService.getCollections();
    if (collections.length === 1) {
      return path.join(collections[0].rootDir, normalized);
    }
    for (const c of collections) {
      const candidate = path.join(c.rootDir, normalized);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* skip */ }
    }
    return collections.length > 0
      ? path.join(collections[0].rootDir, normalized)
      : undefined;
  }

  private _findCollection(filePath: string) {
    const collections = this._collectionService.getCollections();
    const normalizedFilePath = this._normalizePathForCompare(filePath);
    return collections.find(c => {
      const normalizedRoot = this._normalizePathForCompare(c.rootDir);
      return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(normalizedRoot + '/');
    });
  }

  private _normalizePathForCompare(filePath: string): string {
    const normalized = path.normalize(filePath).replace(/[\\/]+/g, '/').replace(/\/+$/g, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private async _readFolderDefaults(requestFilePath: string, collectionRoot: string) {
    let dir = path.dirname(requestFilePath);
    while (dir !== collectionRoot && dir.startsWith(collectionRoot)) {
      for (const name of ['folder.yml', 'folder.yaml']) {
        try {
          const data = await readFolderFile(path.join(dir, name));
          if (data?.request) return data.request;
        } catch { /* no folder file */ }
      }
      dir = path.dirname(dir);
    }
    return undefined;
  }

  /** Simple dot-path/bracket-index extractor (e.g. "data[0].id", "items.name") */
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
