import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { HttpClient } from '../../services/httpClient';
import { readFolderFile } from '../../services/yamlParser';
import * as path from 'path';

export interface SendRequestParams {
  requestFilePath: string;
}

export class SendRequestTool extends ToolBase<SendRequestParams> {
  public readonly toolName = 'missio_send_request';

  constructor(
    private _collectionService: CollectionService,
    private _httpClient: HttpClient,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<SendRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { requestFilePath } = options.input;

    const request = await this._collectionService.loadRequestFile(requestFilePath);
    if (!request) {
      return JSON.stringify({ success: false, message: `Failed to load request: ${requestFilePath}` });
    }

    const collection = this._findCollection(requestFilePath);
    if (!collection) {
      return JSON.stringify({ success: false, message: `No parent collection found for: ${requestFilePath}` });
    }

    // Read folder defaults if a folder.yml exists alongside the request
    const folderDefaults = await this._readFolderDefaults(requestFilePath, collection.rootDir);

    const response = await this._httpClient.send(request, collection, folderDefaults);
    return JSON.stringify({
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body.length > 10_000
        ? response.body.substring(0, 10_000) + '\n... (truncated)'
        : response.body,
      duration: response.duration,
      size: response.size,
    });
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SendRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const { requestFilePath } = options.input;
    return {
      invocationMessage: `Sending HTTP request: ${path.basename(requestFilePath)}`,
      confirmationMessages: {
        title: 'Missio: Send Request',
        message: new vscode.MarkdownString(`Execute the HTTP request at \`${requestFilePath}\`?`),
      },
    };
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
}
