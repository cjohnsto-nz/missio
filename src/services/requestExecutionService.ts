import type {
  GraphQLRequest,
  GrpcRequest,
  HttpRequest,
  HttpResponse,
  MissioCollection,
  OpenCollectionRequest,
  RequestDefaults,
  RequestProtocol,
  WebSocketMessage,
  WebSocketRequest,
} from '../models/types';
import {
  isGraphQLRequest,
  isGrpcRequest,
  isHttpRequest,
  isWebSocketRequest,
} from '../models/types';
import type { CliApprovalPrompt, HttpClient, ResolvedRequest } from './httpClient';
import { buildGraphQLHttpRequest } from './graphqlSupport';
import { RuntimeExecutionService, type RuntimePreparedRequest } from './runtimeExecutionService';
import type { WebSocketSessionSnapshot } from './webSocketClient';

export interface UnsupportedProtocolDiagnostic {
  code: 'MISSIO_UNSUPPORTED_PROTOCOL';
  protocol: Exclude<RequestProtocol, 'http'> | 'unknown';
  protocolName: string;
  taskId?: 'OC-010' | 'OC-020' | 'OC-030';
  message: string;
}

export class UnsupportedProtocolError extends Error {
  public readonly code = 'MISSIO_UNSUPPORTED_PROTOCOL';
  public readonly diagnostic: UnsupportedProtocolDiagnostic;

  constructor(diagnostic: UnsupportedProtocolDiagnostic) {
    super(diagnostic.message);
    this.name = 'UnsupportedProtocolError';
    this.diagnostic = diagnostic;
  }
}

export interface RequestExecutor<TRequest extends OpenCollectionRequest> {
  readonly protocol: RequestProtocol;
  send(
    request: TRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
    options?: { requestId?: string },
  ): Promise<HttpResponse>;
}

interface WebSocketRequestClient {
  readonly onDidChangeSession?: (listener: (snapshot: WebSocketSessionSnapshot) => unknown) => { dispose(): void };
  send(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    options?: { requestId?: string },
  ): Promise<HttpResponse>;
  cancelAll(): void;
  disconnect(requestId: string): boolean;
  connect(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    options?: { requestId?: string; requestFilePath?: string; requestName?: string },
  ): Promise<WebSocketSessionSnapshot>;
  sendMessage(
    requestId: string,
    message?: WebSocketMessage,
    onProgress?: (message: string) => void,
  ): Promise<WebSocketSessionSnapshot>;
  disconnectSession(requestId: string, reason?: string): Promise<HttpResponse | undefined>;
  disconnectAllSessions(): void;
  clearSessionEvents(requestId: string): WebSocketSessionSnapshot | undefined;
  listSessions(options?: { includeClosed?: boolean }): WebSocketSessionSnapshot[];
  getSession(requestId: string): WebSocketSessionSnapshot | undefined;
}

interface GrpcRequestClient {
  send(
    request: GrpcRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
  ): Promise<HttpResponse>;
  cancelAll(): void;
}

export class RequestExecutionService {
  private readonly _webSocketRuntimeSessions = new Map<string, RuntimePreparedRequest<WebSocketRequest>>();

  constructor(
    private readonly _httpClient: HttpClient,
    private readonly _webSocketClient?: WebSocketRequestClient,
    private readonly _grpcClient?: GrpcRequestClient,
    private readonly _runtimeExecutionService = new RuntimeExecutionService(),
  ) {
    this._webSocketClient?.onDidChangeSession?.(session => {
      if (session.state === 'closed' || session.state === 'error') {
        this._webSocketRuntimeSessions.delete(session.requestId);
      }
    });
  }

  async buildResolvedRequest(
    request: OpenCollectionRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
    options?: { includeAuth?: boolean; includeBody?: boolean },
  ): Promise<ResolvedRequest> {
    if (isHttpRequest(request)) {
      const runtimeVariables = await this._runtimeExecutionService.buildRequestVariableOverrides(
        request,
        collection,
        folderDefaults,
        extraVariables,
        environmentName,
      );
      return this._httpClient.buildResolvedRequest(
        request,
        collection,
        folderDefaults,
        runtimeVariables,
        environmentName,
        cliApprovalPrompt,
        options,
      );
    }
    if (isGraphQLRequest(request)) {
      const httpRequest = buildGraphQLHttpRequest(request);
      const runtimeVariables = await this._runtimeExecutionService.buildRequestVariableOverrides(
        httpRequest,
        collection,
        folderDefaults,
        extraVariables,
        environmentName,
      );
      return this._httpClient.buildResolvedRequest(
        httpRequest,
        collection,
        folderDefaults,
        runtimeVariables,
        environmentName,
        cliApprovalPrompt,
        options,
      );
    }
    throw new UnsupportedProtocolError(getUnsupportedProtocolDiagnostic(request));
  }

  get onDidChangeWebSocketSession() {
    return this._webSocketClient?.onDidChangeSession;
  }

  listWebSocketSessions(options: { includeClosed?: boolean } = {}): WebSocketSessionSnapshot[] {
    return this._webSocketClient?.listSessions(options) ?? [];
  }

  getWebSocketSession(requestId: string): WebSocketSessionSnapshot | undefined {
    return this._webSocketClient?.getSession(requestId);
  }

  clearWebSocketSessionHistory(requestId: string): WebSocketSessionSnapshot | undefined {
    return this._webSocketClient?.clearSessionEvents(requestId);
  }

  async connectWebSocket(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    options?: { requestId?: string; requestFilePath?: string; requestName?: string },
  ): Promise<WebSocketSessionSnapshot> {
    if (!this._webSocketClient) {
      throw new UnsupportedProtocolError(getUnsupportedProtocolDiagnostic(request));
    }

    const requestId = options?.requestId ?? options?.requestFilePath ?? request.info?.name ?? `${Date.now()}-${Math.random()}`;
    if (this._runtimeExecutionService.hasRuntimeWork(request, collection, folderDefaults)) {
      const prepared = await this._runtimeExecutionService.prepareWebSocketRequest(
        request,
        collection,
        folderDefaults,
        extraVariables,
        environmentName,
      );
      this._webSocketRuntimeSessions.set(requestId, prepared);
      return this._webSocketClient.connect(
        prepared.request,
        collection,
        folderDefaults,
        onProgress,
        prepared.extraVariables,
        environmentName,
        { ...options, requestId },
      );
    }

    this._webSocketRuntimeSessions.delete(requestId);
    return this._webSocketClient.connect(
      request,
      collection,
      folderDefaults,
      onProgress,
      extraVariables,
      environmentName,
      { ...options, requestId },
    );
  }

  async sendWebSocketMessage(
    requestId: string,
    message?: WebSocketMessage,
    onProgress?: (message: string) => void,
  ): Promise<WebSocketSessionSnapshot> {
    if (!this._webSocketClient) {
      throw new UnsupportedProtocolError(getUnsupportedProtocolDiagnostic({
        info: { name: 'WebSocket', type: 'websocket' },
        websocket: {},
      } as WebSocketRequest));
    }
    return this._webSocketClient.sendMessage(requestId, message, onProgress);
  }

  async disconnectWebSocketSession(requestId: string, reason?: string): Promise<HttpResponse | undefined> {
    const response = await this._webSocketClient?.disconnectSession(requestId, reason);
    const prepared = this._webSocketRuntimeSessions.get(requestId);
    if (!response || !prepared) return response;
    this._webSocketRuntimeSessions.delete(requestId);
    return this._runtimeExecutionService.completeWebSocketRequest(prepared, response);
  }

  disconnectAllWebSocketSessions(): void {
    this._webSocketClient?.disconnectAllSessions();
    this._webSocketRuntimeSessions.clear();
  }

  async send(
    request: OpenCollectionRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
    options?: { requestId?: string },
  ): Promise<HttpResponse> {
    if (isHttpRequest(request)) {
      if (!this._runtimeExecutionService.hasRuntimeWork(request, collection, folderDefaults)) {
        return this._httpClient.send(
          request,
          collection,
          folderDefaults,
          onProgress,
          extraVariables,
          environmentName,
          cliApprovalPrompt,
        );
      }
      const prepared = await this._runtimeExecutionService.prepareHttpRequest(
        request,
        collection,
        folderDefaults,
        extraVariables,
        environmentName,
      );
      const response = await this._httpClient.send(
        prepared.request,
        collection,
        folderDefaults,
        onProgress,
        prepared.extraVariables,
        environmentName,
        cliApprovalPrompt,
      );
      return this._runtimeExecutionService.completeHttpRequest(prepared, response);
    }
    if (isGraphQLRequest(request)) {
      const prepared = await this._runtimeExecutionService.prepareHttpRequest(
        buildGraphQLHttpRequest(request),
        collection,
        folderDefaults,
        extraVariables,
        environmentName,
      );
      const response = await this._httpClient.send(
        prepared.request,
        collection,
        folderDefaults,
        onProgress,
        prepared.extraVariables,
        environmentName,
        cliApprovalPrompt,
      );
      return this._runtimeExecutionService.completeHttpRequest(prepared, response);
    }

    if (isWebSocketRequest(request) && this._webSocketClient) {
      if (this._runtimeExecutionService.hasRuntimeWork(request, collection, folderDefaults)) {
        const prepared = await this._runtimeExecutionService.prepareWebSocketRequest(
          request,
          collection,
          folderDefaults,
          extraVariables,
          environmentName,
        );
        const startedAt = Date.now();
        let response: HttpResponse;
        try {
          response = await this._webSocketClient.send(
            prepared.request,
            collection,
            folderDefaults,
            onProgress,
            prepared.extraVariables,
            environmentName,
            options,
          );
        } catch (error) {
          if (isCancellationError(error)) throw error;
          response = buildProtocolErrorResponse('websocket', error, Date.now() - startedAt);
        }
        return this._runtimeExecutionService.completeWebSocketRequest(prepared, response);
      }
      return this._webSocketClient.send(
        request,
        collection,
        folderDefaults,
        onProgress,
        extraVariables,
        environmentName,
        options,
      );
    }

    if (isGrpcRequest(request) && this._grpcClient) {
      const grpcMethodType = request.grpc?.methodType ?? 'unary';
      if (grpcMethodType === 'unary' && this._runtimeExecutionService.hasRuntimeWork(request, collection, folderDefaults)) {
        const prepared = await this._runtimeExecutionService.prepareGrpcRequest(
          request,
          collection,
          folderDefaults,
          extraVariables,
          environmentName,
        );
        const startedAt = Date.now();
        let response: HttpResponse;
        try {
          response = await this._grpcClient.send(
            prepared.request,
            collection,
            folderDefaults,
            onProgress,
            prepared.extraVariables,
            environmentName,
            cliApprovalPrompt,
          );
        } catch (error) {
          if (isCancellationError(error)) throw error;
          response = buildProtocolErrorResponse('grpc', error, Date.now() - startedAt);
        }
        return this._runtimeExecutionService.completeGrpcRequest(prepared, response);
      }
      return this._grpcClient.send(
        request,
        collection,
        folderDefaults,
        onProgress,
        extraVariables,
        environmentName,
        cliApprovalPrompt,
      );
    }

    throw new UnsupportedProtocolError(getUnsupportedProtocolDiagnostic(request));
  }

  cancelAll(): void {
    this._httpClient.cancelAll();
    this._webSocketClient?.cancelAll();
    this._grpcClient?.cancelAll();
  }

  disconnectWebSocket(requestId: string): boolean {
    return this._webSocketClient?.disconnect(requestId) ?? false;
  }
}

export function getUnsupportedProtocolDiagnostic(request: OpenCollectionRequest): UnsupportedProtocolDiagnostic {
  if (isGraphQLRequest(request)) {
    return {
      code: 'MISSIO_UNSUPPORTED_PROTOCOL',
      protocol: 'graphql',
      protocolName: 'GraphQL',
      taskId: 'OC-010',
      message: 'GraphQL request execution is not supported yet. Missio can load OpenCollection GraphQL request files, but execution will land with OC-010 GraphQL support.',
    };
  }

  if (isWebSocketRequest(request)) {
    return {
      code: 'MISSIO_UNSUPPORTED_PROTOCOL',
      protocol: 'websocket',
      protocolName: 'WebSocket',
      taskId: 'OC-020',
      message: 'WebSocket request execution is not supported yet. Missio can load OpenCollection WebSocket request files, but connection execution will land with OC-020 WebSocket support.',
    };
  }

  if (isGrpcRequest(request)) {
    return {
      code: 'MISSIO_UNSUPPORTED_PROTOCOL',
      protocol: 'grpc',
      protocolName: 'gRPC',
      taskId: 'OC-030',
      message: 'gRPC request execution is not available in this Missio runtime. Unary gRPC support requires the OC-030 gRPC executor to be registered.',
    };
  }

  return {
    code: 'MISSIO_UNSUPPORTED_PROTOCOL',
    protocol: 'unknown',
    protocolName: 'Unknown',
    message: 'This OpenCollection request protocol is not supported for execution yet.',
  };
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && /request cancelled/i.test(error.message);
}

function buildProtocolErrorResponse(protocol: 'websocket' | 'grpc', error: unknown, duration: number): HttpResponse {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = typeof (err as any).code === 'string' ? (err as any).code : undefined;
  const grpcStatus = typeof (err as any).grpcStatus === 'number' ? (err as any).grpcStatus : undefined;
  const details = {
    message: err.message,
    name: err.name,
    code,
    grpcStatus,
    grpcDetails: typeof (err as any).grpcDetails === 'string' ? (err as any).grpcDetails : undefined,
    stack: typeof err.stack === 'string' ? err.stack : undefined,
  };
  const body = JSON.stringify({ protocol, error: details }, null, 2);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-missio-protocol': protocol,
    'x-missio-error': 'true',
    'x-missio-error-message': err.message,
  };
  if (code) headers['x-missio-error-code'] = code;
  if (grpcStatus !== undefined) {
    headers['x-missio-grpc-status'] = String(grpcStatus);
  }

  return {
    status: 0,
    statusText: code ?? err.name ?? 'Error',
    headers,
    body,
    duration,
    size: Buffer.byteLength(body, 'utf-8'),
  };
}

export type HttpRequestExecutor = RequestExecutor<HttpRequest>;
export type GraphQLRequestExecutor = RequestExecutor<GraphQLRequest>;
export type GrpcRequestExecutor = RequestExecutor<GrpcRequest>;
export type WebSocketRequestExecutor = RequestExecutor<WebSocketRequest>;
