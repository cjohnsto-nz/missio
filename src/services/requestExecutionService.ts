import type {
  HttpResponse,
  MissioCollection,
  OpenCollectionRequest,
  RequestDefaults,
  RequestProtocol,
} from '../models/types';
import {
  isGraphQLRequest,
  isGrpcRequest,
  isHttpRequest,
  isWebSocketRequest,
} from '../models/types';
import type { CliApprovalPrompt, HttpClient, ResolvedRequest } from './httpClient';

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

export class RequestExecutionService {
  constructor(private readonly _httpClient: HttpClient) {}

  buildResolvedRequest(
    request: OpenCollectionRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
    options?: { includeAuth?: boolean; includeBody?: boolean },
  ): Promise<ResolvedRequest> {
    if (isHttpRequest(request)) {
      return this._httpClient.buildResolvedRequest(
        request,
        collection,
        folderDefaults,
        extraVariables,
        environmentName,
        cliApprovalPrompt,
        options,
      );
    }
    throw new UnsupportedProtocolError(getUnsupportedProtocolDiagnostic(request));
  }

  async send(
    request: OpenCollectionRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
  ): Promise<HttpResponse> {
    if (isHttpRequest(request)) {
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

    throw new UnsupportedProtocolError(getUnsupportedProtocolDiagnostic(request));
  }

  cancelAll(): void {
    this._httpClient.cancelAll();
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
      message: 'gRPC request execution is not supported yet. Missio can load OpenCollection gRPC request files, but RPC execution will land with OC-030 gRPC support.',
    };
  }

  return {
    code: 'MISSIO_UNSUPPORTED_PROTOCOL',
    protocol: 'unknown',
    protocolName: 'Unknown',
    message: 'This OpenCollection request protocol is not supported for execution yet.',
  };
}
