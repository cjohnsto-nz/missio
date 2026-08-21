import * as vscode from 'vscode';
import * as path from 'path';
import { ToolBase } from './toolBase';
import type { CollectionService } from '../../services/collectionService';
import type { EnvironmentService } from '../../services/environmentService';
import type { RequestExecutionService } from '../../services/requestExecutionService';
import type { WebSocketExchangeEvent, WebSocketSessionSnapshot } from '../../services/webSocketClient';
import { readFolderFile } from '../../services/yamlParser';
import { detectUnresolvedVars } from '../../services/unresolvedVars';
import type { MissioCollection, RequestDefaults, WebSocketMessage, WebSocketRequest } from '../../models/types';
import { isWebSocketRequest } from '../../models/types';

export interface WebSocketSessionParams {
  operation: 'connect' | 'send-message' | 'disconnect' | 'status' | 'list-messages' | 'disconnect-all';
  requestFilePath?: string;
  collectionId?: string;
  environment?: string;
  variables?: Record<string, unknown>;
  message?: WebSocketMessage;
}

export class WebSocketSessionTool extends ToolBase<WebSocketSessionParams> {
  public readonly toolName = 'missio_websocket_session';

  constructor(
    private readonly _collectionService: CollectionService,
    private readonly _environmentService: EnvironmentService,
    private readonly _requestExecutionService: RequestExecutionService,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<WebSocketSessionParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const input = options.input;

    if (input.operation === 'disconnect-all') {
      this._requestExecutionService.disconnectAllWebSocketSessions();
      return JSON.stringify({ success: true, operation: input.operation });
    }

    const requestFilePath = this._resolveRequestPath(input.requestFilePath, input.collectionId);
    if (!requestFilePath) {
      return JSON.stringify({ success: false, operation: input.operation, message: 'requestFilePath is required for this WebSocket operation.' });
    }

    if (input.operation === 'status' || input.operation === 'list-messages') {
      const session = this._requestExecutionService.getWebSocketSession(requestFilePath);
      const redactedSession = session ? redactSession(session) : undefined;
      return JSON.stringify({
        success: !!session,
        operation: input.operation,
        session: redactedSession,
        messages: input.operation === 'list-messages' ? redactedSession?.events ?? [] : undefined,
        message: session ? undefined : 'No WebSocket session exists for this request.',
      });
    }

    if (input.operation === 'disconnect') {
      try {
        const response = await this._requestExecutionService.disconnectWebSocketSession(requestFilePath);
        const session = this._requestExecutionService.getWebSocketSession(requestFilePath);
        return JSON.stringify({
          success: true,
          operation: input.operation,
          session: session ? redactSession(session) : undefined,
          response: response ? summarizeResponse(response) : undefined,
        });
      } catch (error: any) {
        return JSON.stringify({ success: false, operation: input.operation, message: redactDiagnostic(error?.message ?? String(error)), code: error?.code });
      }
    }

    if (input.operation === 'send-message') {
      try {
        const session = await this._requestExecutionService.sendWebSocketMessage(requestFilePath, input.message);
        return JSON.stringify({ success: true, operation: input.operation, session: redactSession(session) });
      } catch (error: any) {
        return JSON.stringify({ success: false, operation: input.operation, message: redactDiagnostic(error?.message ?? String(error)), code: error?.code });
      }
    }

    const context = await this._loadContext(requestFilePath, input.collectionId);
    if (!context) {
      return JSON.stringify({ success: false, operation: input.operation, message: `Failed to load WebSocket request: ${requestFilePath}` });
    }
    const { request, collection, folderDefaults } = context;
    const extraVariables = input.variables
      ? new Map<string, string>(Object.entries(input.variables).map(([key, value]) => [key, String(value)]))
      : new Map<string, string>();
    const unresolved = await detectUnresolvedVars(request, collection, this._environmentService, folderDefaults, input.environment);
    const stillUnresolved = unresolved.filter(name => !extraVariables.has(name));
    if (stillUnresolved.length > 0) {
      return JSON.stringify({
        success: false,
        operation: input.operation,
        message: `Unresolved placeholders: ${stillUnresolved.map(name => `{{${name}}}`).join(', ')}.`,
        unresolvedVariables: stillUnresolved,
      });
    }

    try {
      const session = await this._requestExecutionService.connectWebSocket(
        request,
        collection,
        folderDefaults,
        undefined,
        extraVariables.size > 0 ? extraVariables : undefined,
        input.environment,
        { requestId: requestFilePath, requestFilePath, requestName: request.info?.name },
      );
      return JSON.stringify({ success: true, operation: input.operation, session: redactSession(session) });
    } catch (error: any) {
      return JSON.stringify({ success: false, operation: input.operation, message: redactDiagnostic(error?.message ?? String(error)), code: error?.code });
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<WebSocketSessionParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `WebSocket ${options.input.operation}`,
    };
  }

  private _resolveRequestPath(requestFilePath: string | undefined, collectionId?: string): string | undefined {
    if (!requestFilePath) return undefined;
    if (path.isAbsolute(requestFilePath)) return requestFilePath;
    const collection = collectionId
      ? this._collectionService.getCollection(collectionId)
      : this._collectionService.getCollections()[0];
    return collection ? path.join(collection.rootDir, requestFilePath.replace(/\//g, path.sep)) : undefined;
  }

  private async _loadContext(requestFilePath: string, collectionId?: string): Promise<{
    request: WebSocketRequest;
    collection: MissioCollection;
    folderDefaults: RequestDefaults | undefined;
  } | undefined> {
    const request = await this._collectionService.loadRequestFile(requestFilePath);
    if (!isWebSocketRequest(request)) return undefined;
    const collection = collectionId
      ? this._collectionService.getCollection(collectionId)
      : this._findCollection(requestFilePath);
    if (!collection) return undefined;
    return {
      request,
      collection,
      folderDefaults: await this._readFolderDefaults(requestFilePath, collection.rootDir),
    };
  }

  private _findCollection(filePath: string): MissioCollection | undefined {
    const normalized = path.normalize(filePath).replace(/[\\/]+/g, '/').replace(/\/+$/g, '');
    return this._collectionService.getCollections().find(collection => {
      const root = path.normalize(collection.rootDir).replace(/[\\/]+/g, '/').replace(/\/+$/g, '');
      return normalized === root || normalized.startsWith(root + '/');
    });
  }

  private async _readFolderDefaults(requestFilePath: string, collectionRoot: string): Promise<RequestDefaults | undefined> {
    let dir = path.dirname(requestFilePath);
    const normalizedRoot = path.normalize(collectionRoot).replace(/[\\/]+/g, '/').toLowerCase();
    while (path.normalize(dir).replace(/[\\/]+/g, '/').toLowerCase().startsWith(normalizedRoot)) {
      for (const name of ['folder.yml', 'folder.yaml']) {
        try {
          const folder = await readFolderFile(path.join(dir, name));
          if (folder?.request) return folder.request;
        } catch {
          // Continue walking upward.
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  }
}

function redactSession(session: WebSocketSessionSnapshot): WebSocketSessionSnapshot {
  const cloned = JSON.parse(JSON.stringify(session)) as WebSocketSessionSnapshot;
  if (cloned.url) cloned.url = redactUrl(cloned.url);
  cloned.events = cloned.events.map(redactEvent);
  if (cloned.lastError) cloned.lastError = redactDiagnostic(cloned.lastError);
  return cloned;
}

function redactEvent(event: WebSocketExchangeEvent): WebSocketExchangeEvent {
  const redacted = { ...event };
  if (redacted.data !== undefined) {
    redacted.data = redacted.direction === 'inbound' || redacted.direction === 'outbound'
      ? '[redacted]'
      : redactDiagnostic(redacted.data);
  }
  if (redacted.reason !== undefined) redacted.reason = '[redacted]';
  return redacted;
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '[redacted]';
    if (parsed.password) parsed.password = '[redacted]';
    for (const [name] of parsed.searchParams.entries()) {
      parsed.searchParams.set(name, '[redacted]');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function redactDiagnostic(value: string): string {
  return value.replace(/wss?:\/\/[^\s"']+/gi, match => redactUrl(match));
}

function summarizeResponse(response: import('../../models/types').HttpResponse): Record<string, unknown> {
  return {
    status: response.status,
    statusText: response.statusText,
    duration: response.duration,
    size: response.size,
  };
}
