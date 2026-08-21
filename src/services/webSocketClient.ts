import * as vscode from 'vscode';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type {
  Auth,
  HttpRequestHeader,
  HttpResponse,
  MissioCollection,
  RequestDefaults,
  SecretProvider,
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
  variables: Map<string, string>;
  secretProviders: SecretProvider[];
}

export const MAX_WEBSOCKET_SESSION_EVENTS = 500;
const MAX_RETAINED_CLOSED_SESSIONS = 20;
const CLOSED_SESSION_RETENTION_MS = 5 * 60 * 1000;

export interface WebSocketExchangeEvent {
  timestamp: string;
  direction: 'event' | 'outbound' | 'inbound' | 'error';
  type: WebSocketMessageType | 'open' | 'close' | 'error';
  data?: string;
  closeCode?: number;
  reason?: string;
}

export type WebSocketSessionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'closed'
  | 'error';

export interface WebSocketSessionSnapshot {
  requestId: string;
  requestFilePath?: string;
  requestName?: string;
  state: WebSocketSessionState;
  url?: string;
  events: WebSocketExchangeEvent[];
  inboundCount: number;
  outboundCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  lastError?: string;
}

interface ActiveWebSocketSession {
  requestId: string;
  requestFilePath?: string;
  requestName?: string;
  state: WebSocketSessionState;
  socket?: WebSocket;
  resolved?: ResolvedWebSocketRequest;
  events: WebSocketExchangeEvent[];
  inboundCount: number;
  outboundCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  lastError?: string;
  closeWaiters: Array<(response: HttpResponse) => void>;
  evictionTimer?: NodeJS.Timeout;
}

interface OneShotWebSocket {
  socket: WebSocket;
  cancel: () => void;
}

export class WebSocketClient implements vscode.Disposable {
  private _secretService: SecretService | undefined;
  private readonly _sessions = new Map<string, ActiveWebSocketSession>();
  private readonly _oneShotSockets = new Map<string, OneShotWebSocket>();
  private readonly _onDidChangeSession = new vscode.EventEmitter<WebSocketSessionSnapshot>();
  readonly onDidChangeSession = this._onDidChangeSession.event;

  constructor(private readonly _environmentService: EnvironmentService) {}

  setSecretService(secretService: SecretService): void {
    this._secretService = secretService;
  }

  get activeConnectionCount(): number {
    let count = this._oneShotSockets.size;
    for (const session of this._sessions.values()) {
      if (session.state === 'connecting' || session.state === 'connected' || session.state === 'disconnecting') {
        count++;
      }
    }
    return count;
  }

  listSessions(options: { includeClosed?: boolean } = {}): WebSocketSessionSnapshot[] {
    return [...this._sessions.values()]
      .filter(session => options.includeClosed || session.state === 'connecting' || session.state === 'connected' || session.state === 'disconnecting')
      .map(session => this._snapshot(session))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getSession(requestId: string): WebSocketSessionSnapshot | undefined {
    const session = this._sessions.get(requestId);
    return session ? this._snapshot(session) : undefined;
  }

  clearSessionEvents(requestId: string): WebSocketSessionSnapshot | undefined {
    const session = this._sessions.get(requestId);
    if (!session) return undefined;
    session.events = [];
    this._touch(session);
    this._emit(session);
    return this._snapshot(session);
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

    return { url, headers, message, variables, secretProviders: providers };
  }

  async connect(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    options?: { requestId?: string; requestFilePath?: string; requestName?: string },
  ): Promise<WebSocketSessionSnapshot> {
    const requestId = options?.requestId ?? options?.requestFilePath ?? `${Date.now()}-${Math.random()}`;
    const existing = this._sessions.get(requestId);
    if (existing && (existing.state === 'connecting' || existing.state === 'connected' || existing.state === 'disconnecting')) {
      throw Object.assign(
        new Error(`WebSocket session is already ${existing.state}. Disconnect before connecting again.`),
        { code: 'MISSIO_WEBSOCKET_ALREADY_CONNECTED' },
      );
    }
    if (existing?.evictionTimer) clearTimeout(existing.evictionTimer);

    const now = new Date().toISOString();
    const session: ActiveWebSocketSession = {
      requestId,
      requestFilePath: options?.requestFilePath,
      requestName: options?.requestName ?? request.info?.name,
      state: 'connecting',
      events: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
      closeWaiters: [],
    };
    this._sessions.set(requestId, session);
    this._emit(session);

    let resolved: ResolvedWebSocketRequest;
    try {
      onProgress?.('Resolving WebSocket request...');
      resolved = await this.buildResolvedRequest(request, collection, folderDefaults, extraVariables, environmentName);
      session.resolved = resolved;
      this._touch(session);
      this._emit(session);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      session.state = 'error';
      session.lastError = err.message;
      session.closedAt = new Date().toISOString();
      this._recordEvent(session, { direction: 'error', type: 'error', data: err.message });
      throw error;
    }

    const timeoutMs = vscode.workspace.getConfiguration('missio').get<number>('timeout', 30000);
    const wsOptions: ClientOptions = {
      headers: resolved.headers,
      rejectUnauthorized: vscode.workspace.getConfiguration('missio').get<boolean>('rejectUnauthorized', true),
    };

    onProgress?.('Connecting WebSocket...');
    return new Promise<WebSocketSessionSnapshot>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        fn();
      };

      const socket = new WebSocket(resolved.url, wsOptions);
      session.socket = socket;
      this._touch(session);
      this._emit(session);

      timeout = setTimeout(() => {
        const error = Object.assign(new Error('WebSocket connection timed out'), { code: 'MISSIO_WEBSOCKET_TIMEOUT' });
        session.state = 'error';
        session.lastError = error.message;
        session.closedAt = new Date().toISOString();
        this._recordEvent(session, { direction: 'error', type: 'error', data: error.message });
        socket.terminate();
        settle(() => reject(error));
      }, timeoutMs);

      socket.on('open', () => {
        session.state = 'connected';
        this._recordEvent(session, { direction: 'event', type: 'open' });
        onProgress?.('WebSocket connected.');
        settle(() => resolve(this._snapshot(session)));
      });

      socket.on('message', (data, isBinary) => {
        this._recordEvent(session, {
          direction: 'inbound',
          type: isBinary ? 'binary' : 'text',
          data: isBinary ? rawDataToBuffer(data).toString('base64') : rawDataToBuffer(data).toString('utf-8'),
        });
      });

      socket.on('close', (code, reasonBuffer) => {
        session.socket = undefined;
        session.state = session.state === 'error' ? 'error' : 'closed';
        session.closedAt = new Date().toISOString();
        this._recordEvent(session, {
          direction: 'event',
          type: 'close',
          closeCode: code,
          reason: reasonBuffer.toString('utf-8'),
        });
        const response = this._buildResponse(session, Date.now() - Date.parse(session.createdAt));
        const waiters = session.closeWaiters.splice(0);
        waiters.forEach(waiter => waiter(response));
        if (!settled) {
          settle(() => resolve(this._snapshot(session)));
        }
      });

      socket.on('error', (error) => {
        session.lastError = error.message;
        session.state = 'error';
        session.closedAt = new Date().toISOString();
        this._recordEvent(session, { direction: 'error', type: 'error', data: error.message });
        if (!settled) {
          settle(() => reject(error));
        }
      });
    });
  }

  async sendMessage(
    requestId: string,
    message?: WebSocketMessage,
    onProgress?: (message: string) => void,
  ): Promise<WebSocketSessionSnapshot> {
    const session = this._sessions.get(requestId);
    if (!session || session.state !== 'connected' || !session.socket || session.socket.readyState !== WebSocket.OPEN) {
      throw Object.assign(
        new Error('WebSocket session is not connected. Connect before sending a message.'),
        { code: 'MISSIO_WEBSOCKET_NOT_CONNECTED' },
      );
    }

    const selectedMessage = message
      ? {
          type: message.type,
          data: this._resolveMessageData(message, session.resolved?.variables ?? new Map()),
        }
      : session.resolved?.message;
    if (!selectedMessage) {
      throw Object.assign(
        new Error('WebSocket request does not define a message to send.'),
        { code: 'MISSIO_WEBSOCKET_MESSAGE_REQUIRED' },
      );
    }
    if (message && this._secretService && session.resolved?.secretProviders.length) {
      selectedMessage.data = await this._secretService.resolveSecretReferences(
        selectedMessage.data,
        session.resolved.secretProviders,
        session.resolved.variables,
      );
    }

    onProgress?.('Sending WebSocket message...');
    const payload = this._messagePayload(selectedMessage);
    await new Promise<void>((resolve, reject) => {
      session.socket!.send(payload, error => error ? reject(error) : resolve());
    });
    this._recordEvent(session, {
      direction: 'outbound',
      type: selectedMessage.type,
      data: selectedMessage.type === 'binary' && Buffer.isBuffer(payload)
        ? payload.toString('base64')
        : String(selectedMessage.data),
    });
    return this._snapshot(session);
  }

  disconnectSession(requestId: string, reason = 'Missio disconnect'): Promise<HttpResponse | undefined> {
    const session = this._sessions.get(requestId);
    if (!session) return Promise.resolve(undefined);

    if (!session.socket || session.state === 'closed' || session.state === 'error') {
      return Promise.resolve(this._buildResponse(session, Date.now() - Date.parse(session.createdAt)));
    }

    session.state = 'disconnecting';
    this._touch(session);
    this._emit(session);

    return new Promise<HttpResponse>(resolve => {
      session.closeWaiters.push(resolve);
      session.socket?.close(1000, reason);
    });
  }

  disconnectAllSessions(): void {
    for (const session of this._sessions.values()) {
      if (session.socket && (session.state === 'connecting' || session.state === 'connected')) {
        session.state = 'disconnecting';
        this._touch(session);
        this._emit(session);
        session.socket.close(1000, 'Missio disconnect all');
      }
    }
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
    const payload = resolved.message ? this._messagePayload(resolved.message) : undefined;
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
        this._oneShotSockets.delete(requestId);
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
      this._oneShotSockets.set(requestId, {
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
        if (!resolved.message || payload === undefined) {
          onProgress?.('Disconnecting WebSocket...');
          socket.close(1000, 'Missio disconnect');
          return;
        }

        onProgress?.('Sending WebSocket message...');
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
    const active = this._oneShotSockets.get(requestId);
    if (!active) {
      const session = this._sessions.get(requestId);
      if (!session?.socket) return false;
      session.state = 'disconnecting';
      this._touch(session);
      this._emit(session);
      session.socket.close(1000, 'Missio disconnect');
      return true;
    }
    active.cancel();
    return true;
  }

  cancelAll(): void {
    for (const [requestId, active] of this._oneShotSockets) {
      this._oneShotSockets.delete(requestId);
      active.cancel();
    }
    this.disconnectAllSessions();
  }

  dispose(): void {
    this.cancelAll();
    for (const session of this._sessions.values()) {
      if (session.evictionTimer) clearTimeout(session.evictionTimer);
    }
    this._sessions.clear();
    this._onDidChangeSession.dispose();
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
    const normalized = message.data.replace(/\s/g, '');
    const isBase64 = normalized.length > 0
      && normalized.length % 4 === 0
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized);
    if (!isBase64) {
      throw Object.assign(
        new Error('Binary WebSocket message data must be valid base64.'),
        { code: 'MISSIO_INVALID_WEBSOCKET_BINARY_DATA' },
      );
    }
    return Buffer.from(normalized, 'base64');
  }

  private _buildResponse(
    source: ResolvedWebSocketRequest | ActiveWebSocketSession,
    eventsOrDuration: WebSocketExchangeEvent[] | number,
    durationValue?: number,
  ): HttpResponse {
    const isSession = Object.prototype.hasOwnProperty.call(source, 'state');
    const resolved: ResolvedWebSocketRequest | undefined = isSession
      ? (source as ActiveWebSocketSession).resolved
      : (source as ResolvedWebSocketRequest);
    const responseEvents = Array.isArray(eventsOrDuration)
      ? eventsOrDuration
      : isSession
        ? (source as ActiveWebSocketSession).events
        : [];
    const duration = typeof eventsOrDuration === 'number' ? eventsOrDuration : durationValue ?? 0;
    const body = JSON.stringify({
      protocol: 'websocket',
      url: resolved?.url ?? '',
      state: isSession ? (source as ActiveWebSocketSession).state : 'closed',
      messageCount: responseEvents.filter(event => event.direction === 'inbound').length,
      events: responseEvents,
    }, null, 2);

    return {
      status: 101,
      statusText: 'WebSocket Session',
      headers: {
        'content-type': 'application/json',
        'x-missio-protocol': 'websocket',
        'x-missio-websocket-url': resolved?.url ?? '',
      },
      body,
      duration,
      size: Buffer.byteLength(body, 'utf-8'),
    };
  }

  private _snapshot(session: ActiveWebSocketSession): WebSocketSessionSnapshot {
    return {
      requestId: session.requestId,
      requestFilePath: session.requestFilePath,
      requestName: session.requestName,
      state: session.state,
      url: session.resolved?.url,
      events: session.events.map(event => ({ ...event })),
      inboundCount: session.inboundCount,
      outboundCount: session.outboundCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      closedAt: session.closedAt,
      lastError: session.lastError,
    };
  }

  private _recordEvent(session: ActiveWebSocketSession, entry: Omit<WebSocketExchangeEvent, 'timestamp'>): void {
    session.events.push({ timestamp: new Date().toISOString(), ...entry });
    if (entry.direction === 'inbound') session.inboundCount++;
    if (entry.direction === 'outbound') session.outboundCount++;
    if (session.events.length > MAX_WEBSOCKET_SESSION_EVENTS) {
      session.events.splice(0, session.events.length - MAX_WEBSOCKET_SESSION_EVENTS);
    }
    this._touch(session);
    this._emit(session);
    if (session.state === 'closed' || session.state === 'error') {
      this._scheduleSessionEviction(session);
    }
  }

  private _scheduleSessionEviction(session: ActiveWebSocketSession): void {
    if (session.evictionTimer) clearTimeout(session.evictionTimer);
    session.evictionTimer = setTimeout(() => {
      const current = this._sessions.get(session.requestId);
      if (current === session && (current.state === 'closed' || current.state === 'error')) {
        this._evictSession(current);
      }
    }, CLOSED_SESSION_RETENTION_MS);
    session.evictionTimer.unref?.();

    const closedSessions = [...this._sessions.values()]
      .filter(candidate => candidate.state === 'closed' || candidate.state === 'error')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    while (closedSessions.length > MAX_RETAINED_CLOSED_SESSIONS) {
      const oldest = closedSessions.shift();
      if (!oldest) break;
      this._evictSession(oldest);
    }
  }

  private _evictSession(session: ActiveWebSocketSession): void {
    if (session.evictionTimer) clearTimeout(session.evictionTimer);
    if (session.socket) {
      session.socket.terminate();
      session.socket = undefined;
    }
    this._sessions.delete(session.requestId);
  }

  private _touch(session: ActiveWebSocketSession): void {
    session.updatedAt = new Date().toISOString();
  }

  private _emit(session: ActiveWebSocketSession): void {
    this._onDidChangeSession.fire(this._snapshot(session));
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}
