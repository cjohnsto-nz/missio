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

export interface SendRequestParams {
  requestFilePath: string;
  collectionId?: string;
  environment?: string;
  variables?: Record<string, string>;
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

    const extraVariables = variables
      ? new Map<string, string>(Object.entries(variables))
      : undefined;

    // Detect unresolved placeholders before sending
    const unresolvedNames = await detectUnresolvedVars(request, collection, this._environmentService, folderDefaults);
    // Remove any that are covered by user-provided variable overrides
    const stillUnresolved = extraVariables
      ? unresolvedNames.filter(n => !extraVariables.has(n))
      : unresolvedNames;

    // Dry-run: resolve and preview without sending
    if (dryRun) {
      return this._dryRun(request, collection, folderDefaults, extraVariables, environment, stillUnresolved);
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
    if (responseOutputPath) {
      try {
        const dir = path.dirname(responseOutputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(responseOutputPath, response.body, 'utf-8');
      } catch (err) {
        // Non-fatal: include warning but still return the response
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

    if (responseOutputPath) {
      result.savedTo = responseOutputPath;
    }

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
  ): Promise<string> {
    const variables = await this._environmentService.resolveVariables(collection, folderDefaults, environmentName);
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
    const result: Record<string, unknown> = {
      success: true,
      dryRun: true,
      method,
      url,
      headers,
    };
    if (unresolvedNames.length > 0) {
      result.unresolvedVariables = unresolvedNames;
    }
    return JSON.stringify(result);
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
    return collections.find(c => filePath.startsWith(c.rootDir + path.sep));
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
