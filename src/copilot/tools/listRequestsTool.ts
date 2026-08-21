import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import type { Item, Folder, OpenCollectionRequest } from '../../models/types';
import { isFolder, isGraphQLRequest, isGrpcRequest, isHttpRequest, isWebSocketRequest } from '../../models/types';
import { varPatternGlobal } from '../../models/varPattern';
import { describeGraphQLOperation } from '../../services/graphqlSupport';
import type { WebSocketSessionSnapshot } from '../../services/webSocketClient';

export interface ListRequestsParams {
  collectionId?: string;
  folder?: string;
}

interface RequestEntry {
  name: string;
  protocol: string;
  method: string;
  url: string;
  filePath: string | undefined;
  folder: string;
  templateVariables?: Record<string, string[]>;
  lifecycle?: {
    canConnect: boolean;
    canSendMessage: boolean;
    canDisconnect: boolean;
    state: string;
    inboundCount?: number;
    outboundCount?: number;
  };
}

export class ListRequestsTool extends ToolBase<ListRequestsParams> {
  public readonly toolName = 'missio_list_requests';

  constructor(
    private _collectionService: CollectionService,
    private _webSocketSessions?: { getWebSocketSession(requestId: string): WebSocketSessionSnapshot | undefined },
  ) {
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
      if (isFolder(item)) {
        const f = item as Folder;
        const name = f.info?.name ?? 'folder';
        const subPath = folder ? `${folder}/${name}` : name;
        if (f.items) this._extract(f.items, subPath, out);
      } else if (isHttpRequest(item) || isGraphQLRequest(item) || isGrpcRequest(item) || isWebSocketRequest(item)) {
        const req = item;
        const protocol = isWebSocketRequest(req) ? 'websocket' : isGrpcRequest(req) ? 'grpc' : isGraphQLRequest(req) ? 'graphql' : 'http';
        const url = isWebSocketRequest(req)
          ? (req.websocket?.url ?? '')
          : isGrpcRequest(req)
          ? (req.grpc?.url ?? '')
          : isGraphQLRequest(req)
          ? (req.graphql?.url ?? '')
          : (req.http?.url ?? '');
        const method = isWebSocketRequest(req)
          ? 'WS'
          : isGrpcRequest(req)
          ? (req.grpc?.method ?? 'gRPC')
          : isGraphQLRequest(req)
          ? describeGraphQLOperation(req)
          : (req.http?.method ?? 'GET');
        const templateVariables = this._extractTemplateVariables(req);
        const entry: RequestEntry = {
          name: req.info?.name ?? 'Unnamed',
          protocol,
          method,
          url,
          filePath: (req as any)._filePath,
          folder,
        };
        if (isWebSocketRequest(req)) {
          const session = entry.filePath ? this._webSocketSessions?.getWebSocketSession(entry.filePath) : undefined;
          entry.lifecycle = {
            canConnect: !session || session.state === 'closed' || session.state === 'error' || session.state === 'disconnected',
            canSendMessage: session?.state === 'connected',
            canDisconnect: session?.state === 'connected' || session?.state === 'connecting' || session?.state === 'disconnecting',
            state: session?.state ?? 'disconnected',
            inboundCount: session?.inboundCount,
            outboundCount: session?.outboundCount,
          };
        }
        if (Object.keys(templateVariables).length > 0) entry.templateVariables = templateVariables;
        out.push(entry);
      }
    }
  }

  private _extractTemplateVariables(req: OpenCollectionRequest): Record<string, string[]> {
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

    const details = isGraphQLRequest(req) ? req.graphql : isHttpRequest(req) ? req.http : undefined;
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
        if (isGraphQLRequest(req)) {
          extractFromString(b.query, 'body');
          extractFromString(b.variables, 'body');
          return;
        }
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
          case 'file':
            // filePath entries may contain variable references
            for (const variant of b.data ?? []) {
              if (variant.filePath) extractFromString(variant.filePath, 'body');
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

    if (isWebSocketRequest(req)) {
      const details = req.websocket;
      extractFromString(details?.url, 'url');
      for (const h of details?.headers ?? []) {
        if (!h.disabled) {
          extractFromString(h.name, 'headers');
          extractFromString(h.value, 'headers');
        }
      }
      const message = Array.isArray(details?.message)
        ? (details?.message.find((variant: any) => variant.selected) ?? details?.message[0])?.message
        : details?.message;
      extractFromString(message?.data, 'message');
    }

    if (isGrpcRequest(req)) {
      const details = req.grpc;
      extractFromString(details?.url, 'url');
      extractFromString(details?.method, 'method');
      extractFromString(details?.protoFilePath, 'proto');
      for (const h of details?.metadata ?? []) {
        if (!h.disabled) {
          extractFromString(h.name, 'metadata');
          extractFromString(h.value, 'metadata');
        }
      }
      scanGrpcMessages(details?.message as unknown, 'message');
    }

    function scanGrpcMessages(message: unknown, placement: string): void {
      if (!Array.isArray(message)) {
        extractFromString(typeof message === 'string' ? message : undefined, placement);
        return;
      }

      const isSequence = message.every(entry => isRecord(entry) && !Object.prototype.hasOwnProperty.call(entry, 'title'));
      if (isSequence) {
        for (const entry of message) {
          extractFromString(typeof entry.message === 'string' ? entry.message : undefined, placement);
        }
        return;
      }

      const selected = message.find(entry => isRecord(entry) && entry.selected === true) ?? message[0];
      extractFromString(isRecord(selected) && typeof selected.message === 'string' ? selected.message : undefined, placement);
    }

    function isRecord(value: unknown): value is Record<string, any> {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    // Auth template variables (request-level only; no environment resolution)
    const auth = req.runtime?.auth;
    if (auth && auth !== 'inherit') {
      scanAllStrings(auth, 'auth');
    }

    return result;
  }
}
