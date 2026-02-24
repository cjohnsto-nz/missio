import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';

export interface GetCollectionParams {
  collectionId?: string;
  summary?: boolean;
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
    const { collectionId, summary } = options.input;
    const collection = this._collectionService.resolveCollection(collectionId);
    if (!collection) {
      const hint = collectionId
        ? `Collection not found: ${collectionId}`
        : 'Multiple collections loaded — specify collectionId (use missio_list_collections to find it).';
      return JSON.stringify({ success: false, message: hint });
    }

    if (summary) {
      const items = await this._collectionService.resolveItems(collection);
      const requestCount = this._countRequests(items);
      const environments = (collection.data.config?.environments ?? []).map(e => e.name);
      return JSON.stringify({
        success: true,
        name: collection.data.info?.name ?? collectionId,
        rootDir: collection.rootDir,
        environments,
        requestCount,
        hasAuth: !!collection.data.request?.auth && collection.data.request.auth !== 'inherit',
        variableCount: (collection.data.request?.variables ?? []).length,
      });
    }

    return JSON.stringify({ success: true, collection: collection.data });
  }

  private _countRequests(items: import('../../models/types').Item[]): number {
    let count = 0;
    for (const item of items) {
      if (item.info?.type === 'folder') {
        const f = item as import('../../models/types').Folder;
        if (f.items) count += this._countRequests(f.items);
      } else {
        count++;
      }
    }
    return count;
  }
}
