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
  GrpcMessageVariant,
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

interface ActiveGrpcCall {
  call?: grpc.ClientUnaryCall;
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

    const methodType = details.methodType ?? 'unary';
    if (methodType !== 'unary') {
      throw new GrpcStreamingUnsupportedError(methodType);
    }

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
    const methodKey = this._resolveUnaryMethodKey(serviceConstructor, method);
    mark('Load proto', phaseStart);

    const metadata = await this._buildMetadata(request, collection, folderDefaults, variables, cliApprovalPrompt);
    const message = this._buildMessage(details.message, variables);

    onProgress?.(`Calling ${details.method}...`);
    phaseStart = Date.now();
    return this._executeUnary({
      serviceConstructor,
      methodKey,
      target,
      message,
      metadata,
      displayMethod: `${method.servicePath}/${method.rpcName}`,
      timing,
      t0,
      phaseStart,
    });
  }

  cancelAll(): void {
    for (const activeCall of this._activeCalls.values()) {
      activeCall.cancelled = true;
      activeCall.call?.cancel();
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
    timing: { label: string; start: number; end: number }[];
    t0: number;
    phaseStart: number;
  }): Promise<HttpResponse> {
    const credentials = args.target.secure
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    const client = new args.serviceConstructor(args.target.target, credentials);
    const config = vscode.workspace.getConfiguration('missio');
    const timeout = config.get<number>('timeout', 30000);
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
          headers['x-missio-grpc-status-text'] = grpc.status[grpcCode] ?? 'OK';
          headers['x-missio-grpc-method'] = args.displayMethod;
          headers['content-type'] = 'application/json';
          finish();
          resolve({
            status: grpcCode === grpc.status.OK ? 200 : 0,
            statusText: finalStatus?.details || (grpc.status[grpcCode] ?? 'OK'),
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

  private _normalizeGrpcError(err: grpc.ServiceError, method: string): Error {
    const statusName = typeof err.code === 'number' ? grpc.status[err.code] : undefined;
    const message = `gRPC ${method} failed${statusName ? ` with ${statusName}` : ''}: ${err.details || err.message}`;
    const normalized = new Error(message);
    (normalized as any).code = typeof err.code === 'number' ? `GRPC_${statusName ?? err.code}` : err.code;
    (normalized as any).grpcStatus = err.code;
    (normalized as any).grpcDetails = err.details;
    return normalized;
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

  private _resolveUnaryMethodKey(serviceConstructor: any, method: ParsedGrpcMethod): string {
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
    if (definition?.requestStream || definition?.responseStream) {
      throw new GrpcStreamingUnsupportedError(
        definition.requestStream && definition.responseStream
          ? 'bidi-streaming'
          : definition.requestStream
            ? 'client-streaming'
            : 'server-streaming',
      );
    }
    return methodKey;
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

  private _buildMessage(
    message: string | GrpcMessageVariant[] | undefined,
    variables: Map<string, string>,
  ): Record<string, unknown> {
    const selectedMessage = Array.isArray(message)
      ? (message.find(variant => variant.selected) ?? message[0])?.message
      : message;
    const rawMessage = selectedMessage?.trim() || '{}';
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

  private _metadataToRecord(metadata: grpc.Metadata): Record<string, string> {
    const output: Record<string, string> = {};
    const map = metadata.getMap();
    for (const [key, value] of Object.entries(map)) {
      output[key] = Buffer.isBuffer(value) ? value.toString('base64') : String(value);
    }
    return output;
  }
}
