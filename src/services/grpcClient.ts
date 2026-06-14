import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as vscode from 'vscode';
import type {
  Auth,
  AuthApiKey,
  AuthBasic,
  AuthBearer,
  AuthCli,
  GrpcMetadata,
  GrpcMethodType,
  GrpcRequest,
  HttpResponse,
  MissioCollection,
  RequestDefaults,
} from '../models/types';
import type { EnvironmentService } from './environmentService';
import type { CliApprovalPrompt } from './httpClient';

const execAsync = promisify(exec);

interface CancellableGrpcCall {
  cancel?: () => void;
  destroy?: (error?: Error) => void;
  removeAllListeners?: () => void;
}

interface ActiveGrpcCall {
  call?: CancellableGrpcCall;
  cancelled: boolean;
}

interface ParsedGrpcMethod {
  servicePath: string;
  rpcName: string;
}

interface ResolvedGrpcTarget {
  target: string;
  secure: boolean;
}

interface ResolvedGrpcMethod {
  methodKey: string;
  methodType: GrpcMethodType;
  displayMethod: string;
}

interface BuiltGrpcMessage {
  index: number;
  description?: string;
  message: Record<string, unknown>;
}

interface GrpcStreamEvent {
  type: 'sent' | 'received' | 'metadata' | 'status' | 'error' | 'end';
  direction?: 'sent' | 'received';
  index?: number;
  description?: string;
  message?: unknown;
  metadata?: Record<string, string>;
  status?: GrpcStatusSummary;
  error?: GrpcErrorSummary;
  elapsedMs: number;
}

interface GrpcStatusSummary {
  code: number;
  name: string;
  details: string;
}

interface GrpcErrorSummary extends GrpcStatusSummary {
  message: string;
}

export class GrpcStreamingUnsupportedError extends Error {
  public readonly code = 'MISSIO_GRPC_STREAMING_UNSUPPORTED';

  constructor(public readonly methodType: Exclude<GrpcMethodType, 'unary'>) {
    super(`gRPC ${methodType} requests are not supported yet. Missio currently supports unary gRPC requests for OC-030; streaming modes are explicit follow-up work.`);
    this.name = 'GrpcStreamingUnsupportedError';
  }
}

export class GrpcClient implements vscode.Disposable {
  private readonly _activeCalls = new Map<string, ActiveGrpcCall>();

  constructor(private readonly _environmentService: EnvironmentService) {}

  async send(
    request: GrpcRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    onProgress?: (message: string) => void,
    extraVariables?: Map<string, string>,
    environmentName?: string,
    cliApprovalPrompt?: CliApprovalPrompt,
  ): Promise<HttpResponse> {
    const t0 = Date.now();
    const timing: { label: string; start: number; end: number }[] = [];
    const mark = (label: string, start: number) => timing.push({ label, start: start - t0, end: Date.now() - t0 });
    let phaseStart = Date.now();

    const variables = await this._environmentService.resolveVariables(collection, folderDefaults, environmentName);
    if (extraVariables) {
      for (const [key, value] of extraVariables) variables.set(key, value);
    }

    const details = request.grpc;
    if (!details) throw new Error('gRPC request must include a grpc object.');
    if (!details.url) throw new Error('gRPC request must include grpc.url.');
    if (!details.method) throw new Error('gRPC request must include grpc.method as "package.Service/Method".');

    const target = this._normalizeTarget(this._environmentService.interpolate(details.url, variables));
    const method = this._parseMethod(this._environmentService.interpolate(details.method, variables));
    const protoFilePath = this._resolveProtoFilePath(request, collection, variables);
    const includeDirs = this._resolveImportPaths(protoFilePath, collection, variables);
    mark('Resolve', phaseStart);

    onProgress?.('Loading protobuf definition...');
    phaseStart = Date.now();
    const packageDefinition = protoLoader.loadSync(protoFilePath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs,
    });
    const loadedPackage = grpc.loadPackageDefinition(packageDefinition) as Record<string, unknown>;
    const serviceConstructor = this._resolveService(loadedPackage, method.servicePath);
    const resolvedMethod = this._resolveMethod(serviceConstructor, method);
    const methodType = details.methodType ?? resolvedMethod.methodType;
    this._assertMethodType(details.methodType, resolvedMethod);
    mark('Load proto', phaseStart);

    const metadata = await this._buildMetadata(request, collection, folderDefaults, variables, cliApprovalPrompt);
    const displayMethod = resolvedMethod.displayMethod;

    onProgress?.(`Calling ${details.method}...`);
    phaseStart = Date.now();

    if (methodType === 'unary') {
      const message = this._buildUnaryMessage(details.message, variables, methodType);
      return this._executeUnary({
        serviceConstructor,
        methodKey: resolvedMethod.methodKey,
        target,
        message,
        metadata,
        displayMethod,
        methodType,
        timing,
        t0,
        phaseStart,
      });
    }

    if (methodType === 'server-streaming') {
      const message = this._buildUnaryMessage(details.message, variables, methodType);
      return this._executeServerStreaming({
        serviceConstructor,
        methodKey: resolvedMethod.methodKey,
        target,
        message,
        metadata,
        displayMethod,
        methodType,
        timing,
        t0,
        phaseStart,
        onProgress,
      });
    }

    const messages = this._buildStreamingMessages(details.message, variables, methodType);
    if (methodType === 'client-streaming') {
      return this._executeClientStreaming({
        serviceConstructor,
        methodKey: resolvedMethod.methodKey,
        target,
        messages,
        metadata,
        displayMethod,
        methodType,
        timing,
        t0,
        phaseStart,
        onProgress,
      });
    }

    return this._executeBidiStreaming({
      serviceConstructor,
      methodKey: resolvedMethod.methodKey,
      target,
      messages,
      metadata,
      displayMethod,
      methodType,
      timing,
      t0,
      phaseStart,
      onProgress,
    });
  }

  cancelAll(): void {
    for (const activeCall of this._activeCalls.values()) {
      activeCall.cancelled = true;
      try {
        activeCall.call?.cancel?.();
      } catch {
        activeCall.call?.destroy?.(new Error('Request cancelled'));
      }
    }
    this._activeCalls.clear();
  }

  dispose(): void {
    this.cancelAll();
  }

  private _executeUnary(args: {
    serviceConstructor: any;
    methodKey: string;
    target: ResolvedGrpcTarget;
    message: Record<string, unknown>;
    metadata: grpc.Metadata;
    displayMethod: string;
    methodType: GrpcMethodType;
    timing: { label: string; start: number; end: number }[];
    t0: number;
    phaseStart: number;
  }): Promise<HttpResponse> {
    const client = this._createClient(args.serviceConstructor, args.target);
    const timeout = this._requestTimeout();
    const requestId = `${Date.now()}-${Math.random()}`;
    const activeCall: ActiveGrpcCall = { cancelled: false };
    this._activeCalls.set(requestId, activeCall);

    return new Promise<HttpResponse>((resolve, reject) => {
      let responseMetadata = new grpc.Metadata();
      let finalStatus: grpc.StatusObject | undefined;
      const startTime = Date.now();

      const finish = () => {
        this._activeCalls.delete(requestId);
        client.close();
      };

      const call = client[args.methodKey](
        args.message,
        args.metadata,
        { deadline: new Date(Date.now() + timeout) },
        (err: grpc.ServiceError | null, response: unknown) => {
          if (activeCall.cancelled || err?.code === grpc.status.CANCELLED) {
            finish();
            reject(new Error('Request cancelled'));
            return;
          }
          if (err) {
            finish();
            reject(this._normalizeGrpcError(err, args.displayMethod));
            return;
          }

          const duration = Date.now() - startTime;
          args.timing.push({ label: 'gRPC', start: args.phaseStart - args.t0, end: Date.now() - args.t0 });
          const body = JSON.stringify(response ?? {}, null, 2);
          const headers = this._metadataToRecord(responseMetadata);
          const grpcCode = finalStatus?.code ?? grpc.status.OK;
          headers['x-missio-grpc-status'] = String(grpcCode);
          headers['x-missio-grpc-status-text'] = this._statusName(grpcCode);
          headers['x-missio-grpc-method'] = args.displayMethod;
          headers['x-missio-grpc-method-type'] = args.methodType;
          headers['content-type'] = 'application/json';
          finish();
          resolve({
            status: grpcCode === grpc.status.OK ? 200 : 0,
            statusText: finalStatus?.details || this._statusName(grpcCode),
            headers,
            body,
            duration,
            size: Buffer.byteLength(body, 'utf-8'),
            timing: args.timing,
          } as any);
        },
      ) as grpc.ClientUnaryCall;

      activeCall.call = call;
      call.on('metadata', metadata => { responseMetadata = metadata; });
      call.on('status', status => { finalStatus = status; });
    });
  }

  private _executeServerStreaming(args: {
    serviceConstructor: any;
    methodKey: string;
    target: ResolvedGrpcTarget;
    message: Record<string, unknown>;
    metadata: grpc.Metadata;
    displayMethod: string;
    methodType: GrpcMethodType;
    timing: { label: string; start: number; end: number }[];
    t0: number;
    phaseStart: number;
    onProgress?: (message: string) => void;
  }): Promise<HttpResponse> {
    const client = this._createClient(args.serviceConstructor, args.target);
    const timeout = this._requestTimeout();
    const requestId = `${Date.now()}-${Math.random()}`;
    const activeCall: ActiveGrpcCall = { cancelled: false };
    this._activeCalls.set(requestId, activeCall);
    const startTime = Date.now();
    const sentMessages: BuiltGrpcMessage[] = [{ index: 0, message: args.message }];
    const receivedMessages: unknown[] = [];
    const events: GrpcStreamEvent[] = [];
    let responseMetadata = new grpc.Metadata();
    let finalStatus: grpc.StatusObject | undefined;

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        this._activeCalls.delete(requestId);
        activeCall.call?.removeAllListeners?.();
        client.close();
      };
      const settle = (error?: grpc.ServiceError | Error) => {
        if (settled) return;
        settled = true;
        if (activeCall.cancelled || (error as grpc.ServiceError | undefined)?.code === grpc.status.CANCELLED) {
          finish();
          reject(new Error('Request cancelled'));
          return;
        }
        args.timing.push({ label: 'gRPC Stream', start: args.phaseStart - args.t0, end: Date.now() - args.t0 });
        const response = this._buildStreamResponse({
          method: args.displayMethod,
          methodType: args.methodType,
          sentMessages,
          receivedMessages,
          events,
          responseMetadata,
          finalStatus,
          error,
          duration: Date.now() - startTime,
          timing: args.timing,
        });
        finish();
        resolve(response);
      };

      events.push({ type: 'sent', direction: 'sent', index: 0, message: args.message, elapsedMs: 0 });
      const call = client[args.methodKey](
        args.message,
        args.metadata,
        { deadline: new Date(Date.now() + timeout) },
      ) as grpc.ClientReadableStream<unknown>;
      activeCall.call = call as unknown as CancellableGrpcCall;
      call.on('metadata', metadata => {
        responseMetadata = metadata;
        events.push({ type: 'metadata', metadata: this._metadataToRecord(metadata), elapsedMs: Date.now() - startTime });
      });
      call.on('data', response => {
        receivedMessages.push(response);
        const index = receivedMessages.length - 1;
        events.push({ type: 'received', direction: 'received', index, message: response, elapsedMs: Date.now() - startTime });
        args.onProgress?.(`Received gRPC stream message ${receivedMessages.length}...`);
      });
      call.on('status', status => {
        finalStatus = status;
        events.push({ type: 'status', status: this._statusSummary(status), elapsedMs: Date.now() - startTime });
      });
      call.on('error', err => {
        events.push({ type: 'error', error: this._errorSummary(err), elapsedMs: Date.now() - startTime });
        settle(err);
      });
      call.on('end', () => {
        events.push({ type: 'end', elapsedMs: Date.now() - startTime });
        settle();
      });
    });
  }

  private _executeClientStreaming(args: {
    serviceConstructor: any;
    methodKey: string;
    target: ResolvedGrpcTarget;
    messages: BuiltGrpcMessage[];
    metadata: grpc.Metadata;
    displayMethod: string;
    methodType: GrpcMethodType;
    timing: { label: string; start: number; end: number }[];
    t0: number;
    phaseStart: number;
    onProgress?: (message: string) => void;
  }): Promise<HttpResponse> {
    const client = this._createClient(args.serviceConstructor, args.target);
    const timeout = this._requestTimeout();
    const requestId = `${Date.now()}-${Math.random()}`;
    const activeCall: ActiveGrpcCall = { cancelled: false };
    this._activeCalls.set(requestId, activeCall);
    const startTime = Date.now();
    const receivedMessages: unknown[] = [];
    const events: GrpcStreamEvent[] = [];
    let responseMetadata = new grpc.Metadata();
    let finalStatus: grpc.StatusObject | undefined;

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        this._activeCalls.delete(requestId);
        activeCall.call?.removeAllListeners?.();
        client.close();
      };
      const settle = (error?: grpc.ServiceError | Error) => {
        if (settled) return;
        settled = true;
        if (activeCall.cancelled || (error as grpc.ServiceError | undefined)?.code === grpc.status.CANCELLED) {
          finish();
          reject(new Error('Request cancelled'));
          return;
        }
        args.timing.push({ label: 'gRPC Stream', start: args.phaseStart - args.t0, end: Date.now() - args.t0 });
        const response = this._buildStreamResponse({
          method: args.displayMethod,
          methodType: args.methodType,
          sentMessages: args.messages,
          receivedMessages,
          events,
          responseMetadata,
          finalStatus,
          error,
          duration: Date.now() - startTime,
          timing: args.timing,
        });
        finish();
        resolve(response);
      };

      const call = client[args.methodKey](
        args.metadata,
        { deadline: new Date(Date.now() + timeout) },
        (err: grpc.ServiceError | null, response: unknown) => {
          if (err) {
            events.push({ type: 'error', error: this._errorSummary(err), elapsedMs: Date.now() - startTime });
            settle(err);
            return;
          }
          receivedMessages.push(response ?? {});
          events.push({ type: 'received', direction: 'received', index: 0, message: response ?? {}, elapsedMs: Date.now() - startTime });
          settle();
        },
      ) as grpc.ClientWritableStream<unknown>;
      activeCall.call = call as unknown as CancellableGrpcCall;
      call.on('metadata', metadata => {
        responseMetadata = metadata;
        events.push({ type: 'metadata', metadata: this._metadataToRecord(metadata), elapsedMs: Date.now() - startTime });
      });
      call.on('status', status => {
        finalStatus = status;
        events.push({ type: 'status', status: this._statusSummary(status), elapsedMs: Date.now() - startTime });
      });
      call.on('error', err => {
        events.push({ type: 'error', error: this._errorSummary(err), elapsedMs: Date.now() - startTime });
        settle(err);
      });

      for (const item of args.messages) {
        if (activeCall.cancelled) break;
        events.push({
          type: 'sent',
          direction: 'sent',
          index: item.index,
          description: item.description,
          message: item.message,
          elapsedMs: Date.now() - startTime,
        });
        args.onProgress?.(`Sending gRPC stream message ${item.index + 1}/${args.messages.length}...`);
        call.write(item.message);
      }
      call.end();
    });
  }

  private _executeBidiStreaming(args: {
    serviceConstructor: any;
    methodKey: string;
    target: ResolvedGrpcTarget;
    messages: BuiltGrpcMessage[];
    metadata: grpc.Metadata;
    displayMethod: string;
    methodType: GrpcMethodType;
    timing: { label: string; start: number; end: number }[];
    t0: number;
    phaseStart: number;
    onProgress?: (message: string) => void;
  }): Promise<HttpResponse> {
    const client = this._createClient(args.serviceConstructor, args.target);
    const timeout = this._requestTimeout();
    const requestId = `${Date.now()}-${Math.random()}`;
    const activeCall: ActiveGrpcCall = { cancelled: false };
    this._activeCalls.set(requestId, activeCall);
    const startTime = Date.now();
    const receivedMessages: unknown[] = [];
    const events: GrpcStreamEvent[] = [];
    let responseMetadata = new grpc.Metadata();
    let finalStatus: grpc.StatusObject | undefined;

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        this._activeCalls.delete(requestId);
        activeCall.call?.removeAllListeners?.();
        client.close();
      };
      const settle = (error?: grpc.ServiceError | Error) => {
        if (settled) return;
        settled = true;
        if (activeCall.cancelled || (error as grpc.ServiceError | undefined)?.code === grpc.status.CANCELLED) {
          finish();
          reject(new Error('Request cancelled'));
          return;
        }
        args.timing.push({ label: 'gRPC Stream', start: args.phaseStart - args.t0, end: Date.now() - args.t0 });
        const response = this._buildStreamResponse({
          method: args.displayMethod,
          methodType: args.methodType,
          sentMessages: args.messages,
          receivedMessages,
          events,
          responseMetadata,
          finalStatus,
          error,
          duration: Date.now() - startTime,
          timing: args.timing,
        });
        finish();
        resolve(response);
      };

      const call = client[args.methodKey](
        args.metadata,
        { deadline: new Date(Date.now() + timeout) },
      ) as grpc.ClientDuplexStream<unknown, unknown>;
      activeCall.call = call as unknown as CancellableGrpcCall;
      call.on('metadata', metadata => {
        responseMetadata = metadata;
        events.push({ type: 'metadata', metadata: this._metadataToRecord(metadata), elapsedMs: Date.now() - startTime });
      });
      call.on('data', response => {
        receivedMessages.push(response);
        const index = receivedMessages.length - 1;
        events.push({ type: 'received', direction: 'received', index, message: response, elapsedMs: Date.now() - startTime });
        args.onProgress?.(`Received gRPC stream message ${receivedMessages.length}...`);
      });
      call.on('status', status => {
        finalStatus = status;
        events.push({ type: 'status', status: this._statusSummary(status), elapsedMs: Date.now() - startTime });
      });
      call.on('error', err => {
        events.push({ type: 'error', error: this._errorSummary(err), elapsedMs: Date.now() - startTime });
        settle(err);
      });
      call.on('end', () => {
        events.push({ type: 'end', elapsedMs: Date.now() - startTime });
        settle();
      });

      for (const item of args.messages) {
        if (activeCall.cancelled) break;
        events.push({
          type: 'sent',
          direction: 'sent',
          index: item.index,
          description: item.description,
          message: item.message,
          elapsedMs: Date.now() - startTime,
        });
        args.onProgress?.(`Sending gRPC stream message ${item.index + 1}/${args.messages.length}...`);
        call.write(item.message);
      }
      call.end();
    });
  }

  private _buildStreamResponse(args: {
    method: string;
    methodType: GrpcMethodType;
    sentMessages: BuiltGrpcMessage[];
    receivedMessages: unknown[];
    events: GrpcStreamEvent[];
    responseMetadata: grpc.Metadata;
    finalStatus?: grpc.StatusObject;
    error?: grpc.ServiceError | Error;
    duration: number;
    timing: { label: string; start: number; end: number }[];
  }): HttpResponse {
    const error = args.error ? this._errorSummary(args.error) : undefined;
    const status = args.finalStatus
      ? this._statusSummary(args.finalStatus)
      : error
        ? { code: error.code, name: error.name, details: error.details }
        : { code: grpc.status.OK, name: this._statusName(grpc.status.OK), details: 'OK' };
    const headers = this._metadataToRecord(args.responseMetadata);
    headers['x-missio-grpc-status'] = String(status.code);
    headers['x-missio-grpc-status-text'] = status.name;
    headers['x-missio-grpc-method'] = args.method;
    headers['x-missio-grpc-method-type'] = args.methodType;
    headers['x-missio-grpc-streaming'] = 'true';
    headers['x-missio-grpc-sent-message-count'] = String(args.sentMessages.length);
    headers['x-missio-grpc-received-message-count'] = String(args.receivedMessages.length);
    headers['content-type'] = 'application/json';

    const stream = {
      protocol: 'grpc',
      method: args.method,
      methodType: args.methodType,
      sentMessageCount: args.sentMessages.length,
      receivedMessageCount: args.receivedMessages.length,
      status,
      metadata: headers,
      sentMessages: args.sentMessages.map(item => ({
        index: item.index,
        description: item.description,
        message: item.message,
      })),
      receivedMessages: args.receivedMessages.map((message, index) => ({ index, message })),
      events: args.events,
      error,
    };
    const body = JSON.stringify(stream, null, 2);

    return {
      status: status.code === grpc.status.OK ? 200 : 0,
      statusText: status.details || status.name,
      headers,
      body,
      duration: args.duration,
      size: Buffer.byteLength(body, 'utf-8'),
      timing: args.timing,
      stream,
    } as any;
  }

  private _createClient(serviceConstructor: any, target: ResolvedGrpcTarget): any {
    const credentials = target.secure
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    return new serviceConstructor(target.target, credentials);
  }

  private _requestTimeout(): number {
    return vscode.workspace.getConfiguration('missio').get<number>('timeout', 30000);
  }

  private _normalizeGrpcError(err: grpc.ServiceError, method: string): Error {
    const summary = this._errorSummary(err);
    const message = `gRPC ${method} failed with ${summary.name}: ${summary.details || summary.message}`;
    const normalized = new Error(message);
    (normalized as any).code = `GRPC_${summary.name}`;
    (normalized as any).grpcStatus = summary.code;
    (normalized as any).grpcDetails = summary.details;
    return normalized;
  }

  private _errorSummary(err: grpc.ServiceError | Error): GrpcErrorSummary {
    const grpcCode = typeof (err as grpc.ServiceError).code === 'number'
      ? (err as grpc.ServiceError).code
      : grpc.status.UNKNOWN;
    const details = typeof (err as grpc.ServiceError).details === 'string' && (err as grpc.ServiceError).details
      ? (err as grpc.ServiceError).details
      : err.message;
    return {
      code: grpcCode,
      name: this._statusName(grpcCode),
      details,
      message: err.message,
    };
  }

  private _statusSummary(status: grpc.StatusObject): GrpcStatusSummary {
    return {
      code: status.code,
      name: this._statusName(status.code),
      details: status.details,
    };
  }

  private _statusName(code: number): string {
    return (grpc.status as any)[code] ?? String(code);
  }

  private _normalizeTarget(url: string): ResolvedGrpcTarget {
    const trimmed = url.trim();
    if (!trimmed) throw new Error('gRPC request URL resolved to an empty value.');

    if (/^grpcs:\/\//i.test(trimmed) || /^https:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed.replace(/^grpcs:\/\//i, 'https://'));
      return { target: parsed.host, secure: true };
    }
    if (/^grpc:\/\//i.test(trimmed) || /^http:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed.replace(/^grpc:\/\//i, 'http://'));
      return { target: parsed.host, secure: false };
    }
    return { target: trimmed, secure: false };
  }

  private _parseMethod(method: string): ParsedGrpcMethod {
    const [servicePath, rpcName, ...rest] = method.split('/');
    if (!servicePath || !rpcName || rest.length > 0) {
      throw new Error(`Invalid gRPC method "${method}". Expected "package.Service/Method".`);
    }
    return { servicePath, rpcName };
  }

  private _resolveProtoFilePath(
    request: GrpcRequest,
    collection: MissioCollection,
    variables: Map<string, string>,
  ): string {
    const configuredPath = request.grpc?.protoFilePath
      ?? this._singleConfiguredProtoFile(collection);
    if (!configuredPath) {
      throw new Error('gRPC request must include grpc.protoFilePath, or the collection must configure exactly one config.protobuf.protoFiles entry.');
    }

    const interpolatedPath = this._environmentService.interpolate(configuredPath, variables);
    const resolvedPath = path.isAbsolute(interpolatedPath)
      ? interpolatedPath
      : path.resolve(collection.rootDir, interpolatedPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`gRPC proto file not found: ${resolvedPath}`);
    }
    return resolvedPath;
  }

  private _singleConfiguredProtoFile(collection: MissioCollection): string | undefined {
    const protoFiles = collection.data.config?.protobuf?.protoFiles ?? [];
    return protoFiles.length === 1 ? protoFiles[0].path : undefined;
  }

  private _resolveImportPaths(
    protoFilePath: string,
    collection: MissioCollection,
    variables: Map<string, string>,
  ): string[] {
    const includeDirs = [
      path.dirname(protoFilePath),
      collection.rootDir,
      ...((collection.data.config?.protobuf?.importPaths ?? [])
        .filter(importPath => !importPath.disabled)
        .map(importPath => this._environmentService.interpolate(importPath.path, variables))
        .map(importPath => path.isAbsolute(importPath) ? importPath : path.resolve(collection.rootDir, importPath))),
    ];
    return [...new Set(includeDirs)];
  }

  private _resolveService(loadedPackage: Record<string, unknown>, servicePath: string): any {
    const service = servicePath.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[part];
    }, loadedPackage);
    if (typeof service !== 'function' || !(service as any).service) {
      throw new Error(`gRPC service "${servicePath}" was not found in the loaded proto package.`);
    }
    return service;
  }

  private _resolveMethod(serviceConstructor: any, method: ParsedGrpcMethod): ResolvedGrpcMethod {
    const serviceDefinition = serviceConstructor.service ?? {};
    const match = Object.entries<any>(serviceDefinition).find(([key, definition]) => {
      return definition?.path === `/${method.servicePath}/${method.rpcName}`
        || definition?.originalName === method.rpcName
        || key === method.rpcName
        || key.toLowerCase() === this._lowerFirst(method.rpcName).toLowerCase();
    });
    if (!match) {
      throw new Error(`gRPC method "${method.servicePath}/${method.rpcName}" was not found in the loaded proto service.`);
    }
    const [methodKey, definition] = match;
    const methodType: GrpcMethodType = definition?.requestStream && definition?.responseStream
      ? 'bidi-streaming'
      : definition?.requestStream
        ? 'client-streaming'
        : definition?.responseStream
          ? 'server-streaming'
          : 'unary';
    return {
      methodKey,
      methodType,
      displayMethod: `${method.servicePath}/${method.rpcName}`,
    };
  }

  private _assertMethodType(requested: GrpcMethodType | undefined, resolved: ResolvedGrpcMethod): void {
    if (!requested || requested === resolved.methodType) return;
    throw new Error(`gRPC method type mismatch for ${resolved.displayMethod}: request declares "${requested}" but the proto defines "${resolved.methodType}".`);
  }

  private _lowerFirst(value: string): string {
    return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
  }

  private async _buildMetadata(
    request: GrpcRequest,
    collection: MissioCollection,
    folderDefaults: RequestDefaults | undefined,
    variables: Map<string, string>,
    cliApprovalPrompt?: CliApprovalPrompt,
  ): Promise<grpc.Metadata> {
    const metadata = new grpc.Metadata();
    this._applyMetadataEntries(metadata, collection.data.request?.metadata, variables);
    this._applyMetadataEntries(metadata, folderDefaults?.metadata, variables);
    this._applyMetadataEntries(metadata, request.grpc?.metadata, variables);
    await this._applyAuthMetadata(metadata, request, collection, folderDefaults, variables, cliApprovalPrompt);
    return metadata;
  }

  private _applyMetadataEntries(
    metadata: grpc.Metadata,
    entries: GrpcMetadata[] | undefined,
    variables: Map<string, string>,
  ): void {
    for (const entry of entries ?? []) {
      if (entry.disabled) continue;
      const name = this._environmentService.interpolate(entry.name, variables).trim();
      if (!name) continue;
      metadata.set(name, this._environmentService.interpolate(entry.value, variables));
    }
  }

  private async _applyAuthMetadata(
    metadata: grpc.Metadata,
    request: GrpcRequest,
    collection: MissioCollection,
    folderDefaults: RequestDefaults | undefined,
    variables: Map<string, string>,
    cliApprovalPrompt?: CliApprovalPrompt,
  ): Promise<void> {
    const auth = this._selectEffectiveAuth(request, collection, folderDefaults);
    if (!auth || auth === 'inherit') return;

    switch (auth.type) {
      case 'basic': {
        const basic = auth as AuthBasic;
        const username = this._environmentService.interpolate(basic.username ?? '', variables);
        const password = this._environmentService.interpolate(basic.password ?? '', variables);
        metadata.set('authorization', 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'));
        break;
      }
      case 'bearer': {
        const bearer = auth as AuthBearer;
        metadata.set('authorization', `Bearer ${this._environmentService.interpolate(bearer.token ?? '', variables)}`);
        break;
      }
      case 'apikey': {
        const apiKey = auth as AuthApiKey;
        if (apiKey.placement === 'query') return;
        const key = this._environmentService.interpolate(apiKey.key ?? '', variables);
        if (key) metadata.set(key, this._environmentService.interpolate(apiKey.value ?? '', variables));
        break;
      }
      case 'cli': {
        const cli = auth as AuthCli;
        const token = await this._runCliAuth(cli, variables, cliApprovalPrompt);
        const headerName = cli.tokenHeader || 'authorization';
        const prefix = cli.tokenPrefix !== undefined ? cli.tokenPrefix : 'Bearer';
        metadata.set(headerName, prefix ? `${prefix} ${token}` : token);
        break;
      }
    }
  }

  private _selectEffectiveAuth(
    request: GrpcRequest,
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
      case 'cli':
        return !!auth.command;
      case 'oauth2':
        return true;
      default:
        return true;
    }
  }

  private async _runCliAuth(
    auth: AuthCli,
    variables: Map<string, string>,
    approvalPrompt?: CliApprovalPrompt,
  ): Promise<string> {
    const commandTemplate = auth.command;
    const command = this._environmentService.interpolate(commandTemplate, variables);
    if (approvalPrompt) {
      const approved = await approvalPrompt(commandTemplate, command);
      if (!approved) throw new Error('CLI auth command was not approved by user');
    }
    const { stdout } = await execAsync(command, {
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true,
    });
    const token = stdout.trim();
    if (!token || /[\r\n\0]/.test(token) || (token.startsWith('{') && token.endsWith('}')) || (token.startsWith('[') && token.endsWith(']'))) {
      throw new Error('CLI auth command must print a single header-safe token value.');
    }
    return token;
  }

  private _buildUnaryMessage(
    message: unknown,
    variables: Map<string, string>,
    methodType: GrpcMethodType,
  ): Record<string, unknown> {
    if (this._isMessageSequence(message)) {
      if (message.length !== 1) {
        throw new Error(`gRPC ${methodType} requests accept one request message, but grpc.message contains ${message.length} messages. Use client-streaming or bidi-streaming for ordered message sequences.`);
      }
      return this._parseMessageJson(message[0].message, variables);
    }

    const selectedMessage = Array.isArray(message)
      ? this._selectedVariantMessage(message)
      : message;
    return this._parseMessageJson(typeof selectedMessage === 'string' ? selectedMessage : undefined, variables);
  }

  private _buildStreamingMessages(
    message: unknown,
    variables: Map<string, string>,
    methodType: GrpcMethodType,
  ): BuiltGrpcMessage[] {
    if (!this._isMessageSequence(message)) {
      throw new Error(`gRPC ${methodType} requests require grpc.message to be an ordered array of request message objects, for example [{ message: "{...}" }].`);
    }
    if (message.length === 0) {
      throw new Error(`gRPC ${methodType} requests require at least one request message.`);
    }
    return message.map((entry, index) => ({
      index,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      message: this._parseMessageJson(entry.message, variables),
    }));
  }

  private _selectedVariantMessage(message: unknown[]): string | undefined {
    const selected = message.find(variant => this._isRecord(variant) && variant.selected === true) ?? message[0];
    if (this._isRecord(selected) && typeof selected.message === 'string') return selected.message;
    return undefined;
  }

  private _isMessageSequence(value: unknown): value is Array<{ description?: unknown; message: string }> {
    return Array.isArray(value)
      && value.every(entry => this._isRecord(entry) && !Object.prototype.hasOwnProperty.call(entry, 'title') && typeof entry.message === 'string');
  }

  private _parseMessageJson(
    message: string | undefined,
    variables: Map<string, string>,
  ): Record<string, unknown> {
    const rawMessage = message?.trim() || '{}';
    const interpolated = this._environmentService.interpolateJson(rawMessage, variables);
    try {
      const parsed = JSON.parse(interpolated);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('message must be a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (err: any) {
      throw new Error(`Invalid gRPC message JSON: ${err.message}`);
    }
  }

  private _isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private _metadataToRecord(metadata: grpc.Metadata): Record<string, string> {
    const output: Record<string, string> = {};
    const map = metadata.getMap();
    for (const [key, value] of Object.entries(map)) {
      output[key] = Buffer.isBuffer(value) ? value.toString('base64') : String(value);
    }
    return output;
  }
}
