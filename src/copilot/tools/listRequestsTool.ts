import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import type { Item, Folder, HttpRequest } from '../../models/types';
import { varPatternGlobal } from '../../models/varPattern';

export interface ListRequestsParams {
  collectionId?: string;
  folder?: string;
}

interface RequestEntry {
  name: string;
  method: string;
  url: string;
  filePath: string | undefined;
  folder: string;
  templateVariables?: Record<string, string[]>;
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
    const collection = this._collectionService.resolveCollection(collectionId);
    if (!collection) {
      const hint = collectionId
        ? `Collection not found: ${collectionId}`
        : 'Multiple collections loaded — specify collectionId (use missio_list_collections to find it).';
      return JSON.stringify({ success: false, message: hint });
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
        const url = req.http?.url ?? '';
        const templateVariables = this._extractTemplateVariables(req);
        const entry: RequestEntry = {
          name: req.info?.name ?? 'Unnamed',
          method: req.http?.method ?? 'GET',
          url,
          filePath: (req as any)._filePath,
          folder,
        };
        if (Object.keys(templateVariables).length > 0) entry.templateVariables = templateVariables;
        out.push(entry);
      }
    }
  }

  private _extractTemplateVariables(req: HttpRequest): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    const add = (name: string, placement: string) => {
      if (!name) return;
      if (!result[name]) result[name] = [];
      if (!result[name].includes(placement)) result[name].push(placement);
    };
    const extractFromString = (s: string | undefined, placement: string) => {
      if (!s) return;
      const re = varPatternGlobal();
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        add(m[1].trim(), placement);
      }
    };
    const scanAllStrings = (obj: unknown, placement: string) => {
      if (typeof obj === 'string') {
        extractFromString(obj, placement);
        return;
      }
      if (Array.isArray(obj)) {
        for (const item of obj) scanAllStrings(item, placement);
        return;
      }
      if (obj && typeof obj === 'object') {
        for (const val of Object.values(obj as Record<string, unknown>)) scanAllStrings(val, placement);
      }
    };

    const details = req.http;
    if (details) {
      extractFromString(details.url, 'url');

      for (const h of details.headers ?? []) {
        if (!h.disabled) {
          extractFromString(h.name, 'headers');
          extractFromString(h.value, 'headers');
        }
      }

      for (const p of details.params ?? []) {
        if (!p.disabled) {
          extractFromString(p.name, 'params');
          extractFromString(p.value, 'params');
        }
      }

      const body = details.body as any;
      const scanBody = (b: any) => {
        if (!b) return;
        switch (b.type) {
          case 'json':
          case 'text':
          case 'xml':
          case 'sparql':
            extractFromString(b.data, 'body');
            break;
          case 'form-urlencoded':
          case 'multipart-form':
            for (const entry of b.data ?? []) {
              if (!entry.disabled) {
                extractFromString(entry.name, 'body');
                if (typeof entry.value === 'string') extractFromString(entry.value, 'body');
                else if (Array.isArray(entry.value)) entry.value.forEach((v: string) => extractFromString(v, 'body'));
              }
            }
            break;
        }
      };
      if (body) {
        if (Array.isArray(body)) {
          const selected = body.find((v: any) => v.selected) ?? body[0];
          scanBody(selected?.body);
        } else {
          scanBody(body);
        }
      }
    }

    // Auth template variables (request-level only; no environment resolution)
    const auth = req.runtime?.auth;
    if (auth && auth !== 'inherit') {
      scanAllStrings(auth, 'auth');
    }

    return result;
  }
}
