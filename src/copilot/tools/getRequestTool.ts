import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { getItemKind } from '../../models/types';

export interface GetRequestParams {
  requestFilePath: string;
}

export class GetRequestTool extends ToolBase<GetRequestParams> {
  public readonly toolName = 'missio_get_request';

  constructor(private _collectionService: CollectionService) {
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
    return JSON.stringify({
      success: true,
      protocol,
      requestFilePath,
      request: redactRequestForTool(request),
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
