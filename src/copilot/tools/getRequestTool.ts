import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';

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
    return JSON.stringify({ success: true, request });
  }
}
