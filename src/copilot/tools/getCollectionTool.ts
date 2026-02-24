import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';

export interface GetCollectionParams {
  collectionId: string;
}

export class GetCollectionTool extends ToolBase<GetCollectionParams> {
  public readonly toolName = 'missio_get_collection';

  constructor(private _collectionService: CollectionService) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<GetCollectionParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { collectionId } = options.input;
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) {
      return JSON.stringify({ success: false, message: `Collection not found: ${collectionId}` });
    }
    return JSON.stringify({ success: true, collection: collection.data });
  }
}
