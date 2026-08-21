import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import type { RequestExecutionService } from '../../services/requestExecutionService';
import type { Auth, HttpRequest, HttpRequestBody, MissioCollection } from '../../models/types';

export interface SendRawRequestParams {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  auth?: Auth;
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
    private _requestExecutionService: RequestExecutionService,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<SendRawRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { method, headers: rawHeaders, body: rawBody, auth, collectionId, environment, variables, responseOutputPath, extract } = options.input;

    let collection: MissioCollection | undefined;
    try {
      collection = this._resolveCollection(collectionId);
    } catch (error) {
      return JSON.stringify({ success: false, message: error instanceof Error ? error.message : String(error) });
    }

    const executionCollection = collection ?? this._createRawCollection();
    let body: HttpRequestBody | undefined;
    try {
      body = rawBody === undefined || rawBody === null
        ? undefined
        : typeof rawBody === 'string'
          ? { type: 'text', data: rawBody }
          : { type: 'json', data: JSON.stringify(rawBody) };
    } catch (error) {
      return JSON.stringify({ success: false, message: `Unable to serialize request body: ${error instanceof Error ? error.message : String(error)}` });
    }

    const request: HttpRequest = {
      http: {
        method,
        url: options.input.url,
        headers: Object.entries(rawHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
        body,
      },
      runtime: { auth: auth ?? 'inherit' },
    };
    const extraVariables = variables
      ? new Map<string, string>(Object.entries(variables).map(([key, value]) => [key, String(value)]))
      : undefined;

    let response;
    try {
      response = await this._requestExecutionService.send(
        request,
        executionCollection,
        undefined,
        undefined,
        extraVariables,
        environment,
      );
    } catch (error) {
      return JSON.stringify({ success: false, message: error instanceof Error ? error.message : String(error) });
    }

    const responseBody = response.body;
    const warnings: string[] = [];
    let savedTo: string | undefined;
    if (responseOutputPath) {
      try {
        const dir = path.dirname(responseOutputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(responseOutputPath, responseBody, 'utf-8');
        savedTo = responseOutputPath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to write responseOutputPath "${responseOutputPath}": ${message}`);
      }
    }

    const result: Record<string, unknown> = {
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: responseBody.length > 10_000
        ? responseBody.substring(0, 10_000) + '\n... (truncated)'
        : responseBody,
      duration: response.duration,
      size: response.size,
    };

    if (warnings.length > 0) result.warnings = warnings;
    if (savedTo) result.savedTo = savedTo;

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

    return JSON.stringify(result);
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

  private _resolveCollection(collectionId?: string): MissioCollection | undefined {
    if (collectionId) {
      const collection = this._collectionService.resolveCollection(collectionId);
      if (!collection) throw new Error(`Collection not found: ${collectionId}`);
      return collection;
    }

    const collections = typeof (this._collectionService as any).getCollections === 'function'
      ? (this._collectionService as any).getCollections() as MissioCollection[]
      : [];
    if (collections.length > 1) {
      throw new Error('Multiple collections are loaded; provide collectionId to select one.');
    }
    return this._collectionService.resolveCollection() ?? collections[0];
  }

  private _createRawCollection(): MissioCollection {
    return {
      id: '__raw_request__',
      filePath: '',
      rootDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      data: { config: {}, request: {} } as any,
    };
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
