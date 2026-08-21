import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { getItemKind, isWebSocketRequest } from '../../models/types';
import type { WebSocketSessionSnapshot } from '../../services/webSocketClient';

export interface GetRequestParams {
  requestFilePath: string;
}

export class GetRequestTool extends ToolBase<GetRequestParams> {
  public readonly toolName = 'missio_get_request';

  constructor(
    private _collectionService: CollectionService,
    private _webSocketSessions?: { getWebSocketSession(requestId: string): WebSocketSessionSnapshot | undefined },
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<GetRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { requestFilePath } = options.input;
    const request = await this._collectionService.loadRequestFile(requestFilePath);
    if (!request) {
      return JSON.stringify({ success: false, message: `Failed to load request: ${requestFilePath}` });
    }
    const protocol = getItemKind(request);
    const session = isWebSocketRequest(request)
      ? this._webSocketSessions?.getWebSocketSession(requestFilePath)
      : undefined;
    return JSON.stringify({
      success: true,
      protocol,
      requestFilePath,
      request: redactRequestForTool(request),
      lifecycle: isWebSocketRequest(request)
        ? {
            canConnect: !session || session.state === 'closed' || session.state === 'error' || session.state === 'disconnected',
            canSendMessage: session?.state === 'connected',
            canDisconnect: session?.state === 'connected' || session?.state === 'connecting' || session?.state === 'disconnecting',
            state: session?.state ?? 'disconnected',
            inboundCount: session?.inboundCount,
            outboundCount: session?.outboundCount,
          }
        : undefined,
    });
  }
}

function redactRequestForTool<T>(request: T): T {
  const cloned = request === undefined ? request : JSON.parse(JSON.stringify(request));
  redactAuth((cloned as any)?.runtime?.auth);
  return cloned;
}

function redactAuth(auth: any): void {
  if (!auth || auth === 'inherit' || typeof auth !== 'object') return;

  for (const key of ['password', 'token', 'value', 'clientSecret', 'accessToken', 'refreshToken', 'secretAccessKey', 'sessionToken']) {
    if (typeof auth[key] === 'string' && auth[key] !== '') {
      auth[key] = '[redacted]';
    }
  }

  if (auth.credentials && typeof auth.credentials === 'object') {
    for (const key of ['clientSecret']) {
      if (typeof auth.credentials[key] === 'string' && auth.credentials[key] !== '') {
        auth.credentials[key] = '[redacted]';
      }
    }
  }

  if (auth.resourceOwner && typeof auth.resourceOwner === 'object' && typeof auth.resourceOwner.password === 'string' && auth.resourceOwner.password !== '') {
    auth.resourceOwner.password = '[redacted]';
  }
}
