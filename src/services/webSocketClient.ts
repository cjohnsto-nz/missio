import * as vscode from 'vscode';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type {
  Auth,
  HttpRequestHeader,
  HttpResponse,
  MissioCollection,
  RequestDefaults,
  Variable,
  VariableTypedValue,
  VariableValueVariant,
  WebSocketMessage,
  WebSocketMessageType,
  WebSocketRequest,
} from '../models/types';
import type { EnvironmentService } from './environmentService';
import type { SecretService } from './secretService';

export interface ResolvedWebSocketRequest {
  url: string;
  headers: Record<string, string>;
  message?: WebSocketMessage;
}

export interface WebSocketExchangeEvent {
  timestamp: string;
  direction: 'event' | 'outbound' | 'inbound' | 'error';
  type: WebSocketMessageType | 'open' | 'close' | 'error';
  data?: string;
  closeCode?: number;
  reason?: string;
}

interface ActiveWebSocket {
  socket: WebSocket;
  cancel: () => void;
}

export class WebSocketClient implements vscode.Disposable {
  private _secretService: SecretService | undefined;
  private readonly _activeSockets = new Map<string, ActiveWebSocket>();

  constructor(private readonly _environmentService: EnvironmentService) {}

  setSecretService(secretService: SecretService): void {
    this._secretService = secretService;
  }

  get activeConnectionCount(): number {
    return this._activeSockets.size;
  }

  async buildResolvedRequest(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
  ): Promise<ResolvedWebSocketRequest> {
    const variables = await this._environmentService.resolveVariables(collection, folderDefaults, environmentName);
    this._applyRuntimeVariables(request.runtime?.variables, variables);
    if (extraVariables) {
      for (const [key, value] of extraVariables) variables.set(key, value);
    }

    const details = request.websocket;
    if (!details?.url) {
      throw new Error('WebSocket request must have a URL');
    }

    let url = this._environmentService.interpolate(details.url, variables);
    if (!/^wss?:\/\//i.test(url)) {
      throw Object.assign(
        new Error('WebSocket URL must start with ws:// or wss://'),
        { code: 'MISSIO_INVALID_WEBSOCKET_URL' },
      );
    }

    const headers = this._buildHeaders(collection, folderDefaults, details.headers, variables);
    url = this._applyAuth(request, collection, folderDefaults, headers, url, variables);

    const selectedMessage = this._resolveMessage(details.message);
    const message = selectedMessage
      ? {
          type: selectedMessage.type,
          data: this._resolveMessageData(selectedMessage, variables),
        }
      : undefined;

    const providers = collection.data.config?.secretProviders ?? [];
    if (providers.length > 0 && this._secretService) {
      url = await this._secretService.resolveSecretReferences(url, providers, variables);
      for (const [name, value] of Object.entries(headers)) {
        headers[name] = await this._secretService.resolveSecretReferences(value, providers, variables);
      }
      if (message) {
        message.data = await this._secretService.resolveSecretReferences(message.data, providers, variables);
      }
    }

    return { url, headers, message };
  }

  async send(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    options?: { requestId?: string },
  ): Promise<HttpResponse> {
    const requestId = options?.requestId ?? `${Date.now()}-${Math.random()}`;
    this.disconnect(requestId);

    const startedAt = Date.now();
    const events: WebSocketExchangeEvent[] = [];
    const event = (entry: Omit<WebSocketExchangeEvent, 'timestamp'>) => {
      events.push({ timestamp: new Date().toISOString(), ...entry });
    };

    onProgress?.('Resolving WebSocket request...');
    const resolved = await this.buildResolvedRequest(request, collection, folderDefaults, extraVariables, environmentName);
    const timeoutMs = vscode.workspace.getConfiguration('missio').get<number>('timeout', 30000);

    onProgress?.('Connecting WebSocket...');
    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      let sawMessage = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this._activeSockets.delete(requestId);
        fn();
      };

      const fail = (error: Error) => {
        finish(() => reject(error));
      };

      const wsOptions: ClientOptions = {
        headers: resolved.headers,
        rejectUnauthorized: vscode.workspace.getConfiguration('missio').get<boolean>('rejectUnauthorized', true),
      };

      const socket = new WebSocket(resolved.url, wsOptions);
      this._activeSockets.set(requestId, {
        socket,
        cancel: () => {
          fail(new Error('Request cancelled'));
          socket.terminate();
        },
      });

      timeout = setTimeout(() => {
        fail(new Error('WebSocket request timed out'));
        socket.terminate();
      }, timeoutMs);

      socket.on('open', () => {
        event({ direction: 'event', type: 'open' });
        if (!resolved.message) {
          onProgress?.('Disconnecting WebSocket...');
          socket.close(1000, 'Missio disconnect');
          return;
        }

        onProgress?.('Sending WebSocket message...');
        const payload = this._messagePayload(resolved.message);
        socket.send(payload);
        event({
          direction: 'outbound',
          type: resolved.message.type,
          data: resolved.message.type === 'binary' && Buffer.isBuffer(payload)
            ? payload.toString('base64')
            : String(resolved.message.data),
        });
      });

      socket.on('message', (data, isBinary) => {
        sawMessage = true;
        onProgress?.('Received WebSocket message...');
        event({
          direction: 'inbound',
          type: isBinary ? 'binary' : 'text',
          data: isBinary ? rawDataToBuffer(data).toString('base64') : rawDataToBuffer(data).toString('utf-8'),
        });
        socket.close(1000, 'Missio message received');
      });

      socket.on('close', (code, reasonBuffer) => {
        event({
          direction: 'event',
          type: 'close',
          closeCode: code,
          reason: reasonBuffer.toString('utf-8'),
        });
        finish(() => resolve(this._buildResponse(resolved, events, Date.now() - startedAt)));
      });

      socket.on('error', (error) => {
        event({ direction: 'error', type: 'error', data: error.message });
        if (!sawMessage) {
          fail(error);
        }
      });
    });
  }

  disconnect(requestId: string): boolean {
    const active = this._activeSockets.get(requestId);
    if (!active) return false;
    active.cancel();
    return true;
  }

  cancelAll(): void {
    for (const [requestId, active] of this._activeSockets) {
      this._activeSockets.delete(requestId);
      active.cancel();
    }
  }

  dispose(): void {
    this.cancelAll();
  }

  private _buildHeaders(
    collection: MissioCollection,
    folderDefaults: RequestDefaults | undefined,
    requestHeaders: HttpRequestHeader[] | undefined,
    variables: Map<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    const add = (source: HttpRequestHeader[] | undefined) => {
      for (const header of source ?? []) {
        if (header.disabled) continue;
        headers[this._environmentService.interpolate(header.name, variables)] =
          this._environmentService.interpolate(header.value, variables);
      }
    };
    add(collection.data.request?.headers);
    add(folderDefaults?.headers);
    add(requestHeaders);
    return headers;
  }

  private _applyRuntimeVariables(runtimeVariables: Variable[] | undefined, variables: Map<string, string>): void {
    for (const variable of runtimeVariables ?? []) {
      if (variable.disabled) continue;
      const value = this._resolveVariableValue(variable.value);
      if (value !== undefined) {
        variables.set(variable.name, this._environmentService.interpolate(value, variables));
      }
    }
  }

  private _resolveVariableValue(value: Variable['value']): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const variants = value as VariableValueVariant[];
      const selected = variants.find(variant => variant.selected) ?? variants[0];
      return selected ? this._resolveVariableValue(selected.value) : undefined;
    }
    if (typeof value === 'object' && 'data' in value && 'type' in value) {
      return (value as VariableTypedValue).data;
    }
    return undefined;
  }

  private _applyAuth(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults: RequestDefaults | undefined,
    headers: Record<string, string>,
    url: string,
    variables: Map<string, string>,
  ): string {
    const auth = this._selectEffectiveAuth(request, collection, folderDefaults);
    if (!auth || auth === 'inherit') return url;

    switch (auth.type) {
      case 'basic':
        headers.Authorization = 'Basic ' + Buffer.from(
          `${this._environmentService.interpolate(auth.username || '', variables)}:${this._environmentService.interpolate(auth.password || '', variables)}`,
        ).toString('base64');
        return url;
      case 'bearer':
        headers.Authorization = `Bearer ${this._environmentService.interpolate(auth.token ?? '', variables)}`;
        return url;
      case 'apikey': {
        const key = this._environmentService.interpolate(auth.key ?? '', variables);
        const value = this._environmentService.interpolate(auth.value ?? '', variables);
        if (!key) return url;
        if (auth.placement === 'query') {
          const parsed = new URL(url);
          parsed.searchParams.set(key, value);
          return parsed.toString();
        }
        headers[key] = value;
        return url;
      }
      default:
        throw new Error(`Authentication type "${(auth as any).type ?? 'unknown'}" is not supported for WebSocket requests by the Missio runtime yet.`);
    }
  }

  private _selectEffectiveAuth(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults: RequestDefaults | undefined,
  ): Auth | undefined {
    const collectionAuth = collection.data.request?.auth;
    if (collection.data.config?.forceAuthInherit) {
      if (collectionAuth && collectionAuth !== 'inherit' && this._isAuthComplete(collectionAuth)) {
        return collectionAuth;
      }
    }
    let auth = request.runtime?.auth;
    if (auth === 'inherit') auth = folderDefaults?.auth ?? 'inherit';
    if (auth === 'inherit') auth = collectionAuth;
    return auth;
  }

  private _isAuthComplete(auth: Exclude<Auth, 'inherit'>): boolean {
    switch (auth.type) {
      case 'basic':
        return !!(auth.username || auth.password);
      case 'bearer':
        return !!auth.token;
      case 'apikey':
        return !!auth.key;
      default:
        return true;
    }
  }

  private _resolveMessage(message: NonNullable<WebSocketRequest['websocket']>['message']): WebSocketMessage | undefined {
    if (!message) return undefined;
    if (!Array.isArray(message)) return message;
    const selected = message.find(variant => variant.selected) ?? message[0];
    return selected?.message;
  }

  private _resolveMessageData(message: WebSocketMessage, variables: Map<string, string>): string {
    if (message.type === 'json') {
      return this._environmentService.interpolateJson(message.data, variables);
    }
    return this._environmentService.interpolate(message.data, variables);
  }

  private _messagePayload(message: WebSocketMessage): string | Buffer {
    if (message.type !== 'binary') return message.data;
    const normalized = message.data.trim();
    return /^[A-Za-z0-9+/=\r\n]+$/.test(normalized)
      ? Buffer.from(normalized, 'base64')
      : Buffer.from(message.data, 'utf-8');
  }

  private _buildResponse(
    resolved: ResolvedWebSocketRequest,
    events: WebSocketExchangeEvent[],
    duration: number,
  ): HttpResponse {
    const body = JSON.stringify({
      protocol: 'websocket',
      url: resolved.url,
      messageCount: events.filter(event => event.direction === 'inbound').length,
      events,
    }, null, 2);

    return {
      status: 101,
      statusText: 'WebSocket Exchange',
      headers: {
        'content-type': 'application/json',
        'x-missio-protocol': 'websocket',
        'x-missio-websocket-url': resolved.url,
      },
      body,
      duration,
      size: Buffer.byteLength(body, 'utf-8'),
    };
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}
