import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';

export class ListCollectionsTool extends ToolBase<undefined> {
  public readonly toolName = 'missio_list_collections';

  constructor(private _collectionService: CollectionService) {
    super();
  }

  async call(
    _options: vscode.LanguageModelToolInvocationOptions<undefined>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const collections = this._collectionService.getCollections();
    const result = collections.map(c => ({
      collectionId: c.id,
      name: c.data.info?.name ?? 'Unnamed',
      rootDir: c.rootDir,
      environmentCount: c.data.config?.environments?.length ?? 0,
    }));
    return JSON.stringify({ collections: result });
  }
}
