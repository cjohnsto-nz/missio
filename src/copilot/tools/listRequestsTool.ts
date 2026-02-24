import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import type { Item, Folder, HttpRequest } from '../../models/types';

export interface ListRequestsParams {
  collectionId: string;
  folder?: string;
}

interface RequestEntry {
  name: string;
  method: string;
  url: string;
  filePath: string | undefined;
  folder: string;
}

export class ListRequestsTool extends ToolBase<ListRequestsParams> {
  public readonly toolName = 'missio_list_requests';

  constructor(private _collectionService: CollectionService) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<ListRequestsParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { collectionId, folder: folderFilter } = options.input;
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) {
      return JSON.stringify({ success: false, message: `Collection not found: ${collectionId}` });
    }

    const items = await this._collectionService.resolveItems(collection);
    const requests: RequestEntry[] = [];
    this._extract(items, '', requests);

    // Apply folder filter if provided (prefix match, case-insensitive)
    const filtered = folderFilter
      ? requests.filter(r => r.folder.toLowerCase().startsWith(folderFilter.toLowerCase()))
      : requests;

    return JSON.stringify({ success: true, requests: filtered });
  }

  private _extract(items: Item[], folder: string, out: RequestEntry[]): void {
    for (const item of items) {
      if (item.info?.type === 'folder') {
        const f = item as Folder;
        const name = f.info?.name ?? 'folder';
        const subPath = folder ? `${folder}/${name}` : name;
        if (f.items) this._extract(f.items, subPath, out);
      } else {
        const req = item as HttpRequest;
        out.push({
          name: req.info?.name ?? 'Unnamed',
          method: req.http?.method ?? 'GET',
          url: req.http?.url ?? '',
          filePath: (req as any)._filePath,
          folder,
        });
      }
    }
  }
}
