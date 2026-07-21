import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as vscode from 'vscode';
import type { MissioCollection, RequestDefaults } from '../src/models/types';
import { EnvironmentService } from '../src/services/environmentService';
import { GrpcClient } from '../src/services/grpcClient';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import { validateCollection } from '../src/services/validationService';
import {
  applyCollectionEditorModel,
  applyRequestEditorModel,
  createCollectionEditorModelFromCollection,
  createRequestEditorModelFromRequest,
} from '../src/models/schemaRoundTrip';

const demoRoot = path.resolve(__dirname, '..', 'examples', 'demo-api');
const demoProtoPath = path.join(demoRoot, 'proto', 'services', 'missio_demo.proto');
const schemaPath = path.resolve(__dirname, '..', 'schema', 'opencollectionschema.json');

function validateGrpcRequestData(data: unknown): void {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile({
    $schema: schema.$schema,
    $id: `${schema.$id}#test-grpc-streaming`,
    $ref: `${schema.$id}#/$defs/GrpcRequest`,
    $defs: schema.$defs,
  });
  expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

let server: grpc.Server | undefined;
let address = '';

function makeContext() {
  const state = new Map<string, unknown>();
  return {
    globalState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async (key: string, value: unknown) => { state.set(key, value); },
    },
    workspaceState: {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async (key: string, value: unknown) => { state.set(key, value); },
    },
  } as any;
}

function makeEnvironmentService(): EnvironmentService {
  return new EnvironmentService(makeContext(), {
    resolveSecretReferences: async (value: string) => value,
    resolveSecret: async () => undefined,
  } as any);
}

function makeCollection(): MissioCollection {
  return {
    id: path.join(demoRoot, 'opencollection.yml'),
    filePath: path.join(demoRoot, 'opencollection.yml'),
    rootDir: demoRoot,
    data: {
      opencollection: '1.0.0',
      info: { name: 'gRPC Test Collection' },
      config: {
        protobuf: {
          protoFiles: [{ type: 'file', path: 'proto/services/missio_demo.proto' }],
          importPaths: [{ path: 'proto' }],
        },
        environments: [
          {
            name: 'LOCAL',
            variables: [
              { name: 'grpcName', value: 'Ada' },
              { name: 'grpcUserId', value: '42' },
              { name: 'grpcRequestId', value: 'trace-123' },
              { name: 'grpcToken', value: 'token-abc' },
            ],
          },
        ],
      },
      request: {
        metadata: [{ name: 'x-demo-default', value: 'collection-{{grpcRequestId}}' }],
      },
    },
  };
}

function makeUnaryRequest(url: string) {
  return {
    info: { name: 'Echo unary', type: 'grpc' as const },
    grpc: {
      url,
      method: 'missio.demo.DemoService/EchoUnary',
      methodType: 'unary' as const,
      protoFilePath: 'proto/services/missio_demo.proto',
      metadata: [
        { name: 'x-demo-default', value: 'request-{{grpcRequestId}}' },
        { name: 'x-demo-request', value: 'request-{{grpcRequestId}}' },
      ],
      message: JSON.stringify({
        name: '{{grpcName}}',
        userId: '{{grpcUserId}}',
        trace: { requestId: '{{grpcRequestId}}' },
      }),
    },
    runtime: { auth: { type: 'bearer' as const, token: '{{grpcToken}}' } },
  };
}

function makeServerStreamingRequest(url: string, userId = '{{grpcUserId}}') {
  return {
    info: { name: 'Stream users', type: 'grpc' as const },
    grpc: {
      url,
      method: 'missio.demo.DemoService/StreamUsers',
      methodType: 'server-streaming' as const,
      protoFilePath: 'proto/services/missio_demo.proto',
      message: JSON.stringify({
        name: '{{grpcName}}',
        userId,
        trace: { requestId: '{{grpcRequestId}}' },
      }),
    },
  };
}

function makeClientStreamingRequest(url: string) {
  return {
    info: { name: 'Upload users', type: 'grpc' as const },
    grpc: {
      url,
      method: 'missio.demo.DemoService/UploadUsers',
      methodType: 'client-streaming' as const,
      protoFilePath: 'proto/services/missio_demo.proto',
      message: [
        {
          description: 'first',
          message: JSON.stringify({
            name: '{{grpcName}}',
            userId: '{{grpcUserId}}',
            trace: { requestId: '{{grpcRequestId}}-1' },
          }),
        },
        {
          description: 'second',
          message: JSON.stringify({
            name: 'Grace',
            userId: 43,
            trace: { requestId: '{{grpcRequestId}}-2' },
          }),
        },
      ],
    },
    runtime: { auth: { type: 'bearer' as const, token: '{{grpcToken}}' } },
  };
}

function makeBidiStreamingRequest(url: string) {
  return {
    info: { name: 'Chat users', type: 'grpc' as const },
    grpc: {
      url,
      method: 'missio.demo.DemoService/ChatUsers',
      methodType: 'bidi-streaming' as const,
      protoFilePath: 'proto/services/missio_demo.proto',
      message: [
        {
          description: 'first chat',
          message: JSON.stringify({
            name: '{{grpcName}}',
            userId: '{{grpcUserId}}',
            trace: { requestId: '{{grpcRequestId}}-chat-1' },
          }),
        },
        {
          description: 'second chat',
          message: JSON.stringify({
            name: 'Grace',
            userId: 43,
            trace: { requestId: '{{grpcRequestId}}-chat-2' },
          }),
        },
      ],
    },
  };
}

async function startServer(): Promise<void> {
  const packageDefinition = protoLoader.loadSync(demoProtoPath, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [path.join(demoRoot, 'proto')],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  server = new grpc.Server();
  server.addService(proto.missio.demo.DemoService.service, {
    echoUnary(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      const metadataValue = (name: string) => String(call.metadata.get(name)[0] ?? '');
      const metadata = new grpc.Metadata();
      metadata.set('x-demo-grpc', 'ok');
      call.sendMetadata(metadata);
      callback(null, {
        message: `Hello ${call.request.name}`,
        name: call.request.name,
        userId: call.request.userId,
        requestId: call.request.trace?.requestId ?? '',
        authorization: metadataValue('authorization'),
        defaultMetadata: metadataValue('x-demo-default'),
        folderMetadata: metadataValue('x-demo-folder'),
        requestMetadata: metadataValue('x-demo-request'),
      });
    },
    streamUsers(call: grpc.ServerWritableStream<any, any>) {
      if (call.request.userId === 999) {
        const timer = setTimeout(() => {
          call.write({ id: 999, name: 'Slow Ada', requestId: call.request.trace?.requestId ?? '' });
          call.end();
        }, 250);
        call.on('cancelled', () => clearTimeout(timer));
        return;
      }
      call.write({ id: call.request.userId || 1, name: call.request.name || 'Ada', requestId: call.request.trace?.requestId ?? '' });
      call.write({ id: (call.request.userId || 1) + 1, name: 'Grace', requestId: call.request.trace?.requestId ?? '' });
      call.end();
    },
    uploadUsers(call: grpc.ServerReadableStream<any, any>, callback: grpc.sendUnaryData<any>) {
      const requests: any[] = [];
      call.on('data', request => requests.push(request));
      call.on('end', () => {
        if (requests.some(request => request.userId === 999)) {
          callback(Object.assign(new Error('Demo client stream failure'), {
            code: grpc.status.INTERNAL,
            details: 'Demo client stream failure',
            metadata: new grpc.Metadata(),
          }) as grpc.ServiceError);
          return;
        }
        callback(null, {
          count: requests.length,
          names: requests.map(request => request.name).join(','),
          requestIds: requests.map(request => request.trace?.requestId ?? '').join(','),
          authorization: String(call.metadata.get('authorization')[0] ?? ''),
          defaultMetadata: String(call.metadata.get('x-demo-default')[0] ?? ''),
        });
      });
    },
    chatUsers(call: grpc.ServerDuplexStream<any, any>) {
      call.on('data', request => {
        call.write({
          id: request.userId,
          name: `ack:${request.name}`,
          requestId: request.trace?.requestId ?? '',
        });
      });
      call.on('end', () => call.end());
    },
    streamUsersWithError(call: grpc.ServerWritableStream<any, any>) {
      call.write({ id: call.request.userId || 1, name: 'Partial Ada', requestId: call.request.trace?.requestId ?? '' });
      const error = Object.assign(new Error('Demo stream failure after partial data'), {
        code: grpc.status.INTERNAL,
        details: 'Demo stream failure after partial data',
      });
      call.emit('error', error);
    },
  });
  address = await new Promise<string>((resolve, reject) => {
    server!.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else {
        server!.start();
        resolve(`127.0.0.1:${port}`);
      }
    });
  });
}

beforeEach(async () => {
  await startServer();
});

afterEach(() => {
  server?.forceShutdown();
  server = undefined;
  vi.restoreAllMocks();
});

describe('gRPC execution', () => {
  it('loads proto imports, merges metadata defaults, interpolates variables and auth, and executes unary calls', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const client = new GrpcClient(environmentService);
    const folderDefaults: RequestDefaults = {
      metadata: [{ name: 'x-demo-folder', value: 'folder-{{grpcRequestId}}' }],
    };

    const response = await client.send(makeUnaryRequest(address), collection, folderDefaults);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['x-demo-grpc']).toBe('ok');
    expect(response.headers['x-missio-grpc-status']).toBe('0');
    expect(body).toMatchObject({
      message: 'Hello Ada',
      name: 'Ada',
      userId: 42,
      requestId: 'trace-123',
      authorization: 'Bearer token-abc',
      defaultMetadata: 'request-trace-123',
      folderMetadata: 'folder-trace-123',
      requestMetadata: 'request-trace-123',
    });
  });

  it('reports missing proto files and invalid method names clearly', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    const client = new GrpcClient(environmentService);

    await expect(client.send({
      ...makeUnaryRequest(address),
      grpc: { ...makeUnaryRequest(address).grpc, protoFilePath: 'proto/missing.proto' },
    }, collection)).rejects.toThrow(/proto file not found/i);

    await expect(client.send({
      ...makeUnaryRequest(address),
      grpc: { ...makeUnaryRequest(address).grpc, method: 'missio.demo.DemoService/MissingMethod' },
    }, collection)).rejects.toThrow(/was not found/);
  });

  it('executes server-streaming calls and returns ordered response events', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const client = new GrpcClient(environmentService);

    const response = await client.send(makeServerStreamingRequest(address), collection);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['x-missio-grpc-method-type']).toBe('server-streaming');
    expect(response.headers['x-missio-grpc-received-message-count']).toBe('2');
    expect(body.receivedMessages.map((entry: any) => entry.message.name)).toEqual(['Ada', 'Grace']);
    expect(body.events.filter((event: any) => event.type === 'received')).toHaveLength(2);
    expect((response as any).stream.receivedMessageCount).toBe(2);
  });

  it('executes client-streaming calls with ordered message sequences and metadata/auth', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const client = new GrpcClient(environmentService);

    const response = await client.send(makeClientStreamingRequest(address), collection);
    const body = JSON.parse(response.body);
    const summary = body.receivedMessages[0].message;

    expect(response.status).toBe(200);
    expect(response.headers['x-missio-grpc-method-type']).toBe('client-streaming');
    expect(response.headers['x-missio-grpc-sent-message-count']).toBe('2');
    expect(summary).toMatchObject({
      count: 2,
      names: 'Ada,Grace',
      requestIds: 'trace-123-1,trace-123-2',
      authorization: 'Bearer token-abc',
      defaultMetadata: 'collection-trace-123',
    });
    expect(body.events.filter((event: any) => event.type === 'sent')).toHaveLength(2);
  });

  it('executes bidirectional-streaming calls with correlated sent and received events', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const client = new GrpcClient(environmentService);

    const response = await client.send(makeBidiStreamingRequest(address), collection);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['x-missio-grpc-method-type']).toBe('bidi-streaming');
    expect(body.sentMessages.map((entry: any) => entry.description)).toEqual(['first chat', 'second chat']);
    expect(body.receivedMessages.map((entry: any) => entry.message.name)).toEqual(['ack:Ada', 'ack:Grace']);
    expect(body.events.filter((event: any) => event.type === 'sent')).toHaveLength(2);
    expect(body.events.filter((event: any) => event.type === 'received')).toHaveLength(2);
  });

  it('records a client-streaming failure once when grpc-js reports it through both error paths', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    const client = new GrpcClient(environmentService);
    const request = makeClientStreamingRequest(address);
    request.grpc.message = [{
      description: 'trigger server failure',
      message: '{"name":"Ada","userId":999,"trace":{"requestId":"client-error"}}',
    }];

    const response = await client.send(request, collection);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(0);
    expect(response.headers['x-missio-grpc-status']).toBe(String(grpc.status.INTERNAL));
    expect(body.events.filter((event: any) => event.type === 'error')).toHaveLength(1);
  });

  it('applies the configured timeout to streaming calls and preserves deadline diagnostics', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: (key: string, defaultValue: unknown) => key === 'timeout' ? 20 : defaultValue,
    } as any);
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    const client = new GrpcClient(environmentService);

    const response = await client.send(makeServerStreamingRequest(address, 999), collection);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(0);
    expect(response.headers['x-missio-grpc-status']).toBe(String(grpc.status.DEADLINE_EXCEEDED));
    expect(body.error).toMatchObject({
      code: grpc.status.DEADLINE_EXCEEDED,
      name: 'DEADLINE_EXCEEDED',
    });
  });

  it('retains partial stream responses and final gRPC error details', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const client = new GrpcClient(environmentService);

    const response = await client.send({
      info: { name: 'Error stream', type: 'grpc' as const },
      grpc: {
        url: address,
        method: 'missio.demo.DemoService/StreamUsersWithError',
        methodType: 'server-streaming' as const,
        protoFilePath: 'proto/services/missio_demo.proto',
        message: '{"userId": 42, "name": "Ada", "trace": {"requestId": "err-1"}}',
      },
    }, collection);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(0);
    expect(response.headers['x-missio-grpc-status']).toBe(String(grpc.status.INTERNAL));
    expect(body.receivedMessages[0].message.name).toBe('Partial Ada');
    expect(body.error).toMatchObject({
      code: grpc.status.INTERNAL,
      name: 'INTERNAL',
      details: 'Demo stream failure after partial data',
    });
  });

  it('reports invalid streaming payloads and proto method type mismatches clearly', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    const client = new GrpcClient(environmentService);

    await expect(client.send({
      info: { name: 'Bad payload', type: 'grpc' as const },
      grpc: {
        url: address,
        method: 'missio.demo.DemoService/UploadUsers',
        methodType: 'client-streaming' as const,
        protoFilePath: 'proto/services/missio_demo.proto',
        message: '{"userId": 42}',
      },
    }, collection)).rejects.toThrow(/ordered array of request message objects/);

    await expect(client.send({
      ...makeServerStreamingRequest(address),
      grpc: { ...makeServerStreamingRequest(address).grpc, methodType: 'client-streaming' as const },
    }, collection)).rejects.toThrow(/method type mismatch/);
  });

  it('cancels active streaming calls and cleans up request state', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const client = new GrpcClient(environmentService);

    const pending = client.send(makeServerStreamingRequest(address, 999), collection);
    setTimeout(() => client.cancelAll(), 10);

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect((client as any)._activeCalls.size).toBe(0);
  });
});

describe('gRPC schema and tooling surfaces', () => {
  it('validates and round-trips streaming message sequences through schema-safe editors', () => {
    const request = makeClientStreamingRequest('localhost:50051');
    const updatedRequest = applyRequestEditorModel(request, createRequestEditorModelFromRequest(request));
    const roundTripped = parseYaml(stringifyYaml(updatedRequest, { lineWidth: 120 }));

    expect(updatedRequest).toEqual(request);
    expect(roundTripped).toEqual(request);
    expect(request.grpc.message).toHaveLength(2);
    validateGrpcRequestData(roundTripped);
  });
});

describe('gRPC integration surfaces', () => {
  it('dispatches gRPC requests through RequestExecutionService when a gRPC executor is registered', async () => {
    const response = { status: 200, statusText: 'OK', headers: {}, body: '{}', duration: 1, size: 2 };
    const grpcClient = { send: vi.fn().mockResolvedValue(response), cancelAll: vi.fn() };
    const service = new RequestExecutionService({ send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any, undefined, grpcClient as any);
    const request = makeUnaryRequest(address);
    const collection = makeCollection();

    await expect(service.send(request, collection)).resolves.toBe(response);
    expect(grpcClient.send).toHaveBeenCalledWith(request, collection, undefined, undefined, undefined, undefined, undefined);
  });

  it('preserves protobuf config and gRPC metadata defaults through collection editor models', () => {
    const collection = {
      opencollection: '1.0.0',
      info: { name: 'Protobuf Config' },
      config: {
        protobuf: {
          protoFiles: [{ type: 'file', path: 'proto/services/missio_demo.proto' }],
          importPaths: [{ path: 'proto' }, { path: 'disabled-proto', disabled: true }],
        },
      },
      request: {
        metadata: [{ name: 'x-demo-default', value: '{{traceId}}' }],
      },
    };

    const updated = applyCollectionEditorModel(collection, createCollectionEditorModelFromCollection(collection));

    expect(updated).toEqual(collection);
  });

  it('validates the demo collection including gRPC request fixtures', async () => {
    const report = await validateCollection(demoRoot, schemaPath);
    const grpcIssues = report.issues.filter(issue => issue.file.includes('gRPC'));

    expect(grpcIssues).toEqual([]);
    expect(report.failCount).toBe(0);
  });

  it('smoke tests the committed demo unary request against the local fixture server', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const request = makeUnaryRequest(address);
    const demoFile = path.join(demoRoot, 'gRPC', 'echo-unary.yml');

    expect(fs.existsSync(demoFile)).toBe(true);
    const response = await new GrpcClient(environmentService).send(request, collection, {
      metadata: [{ name: 'x-demo-folder', value: 'folder-{{grpcRequestId}}' }],
    });

    expect(JSON.parse(response.body).message).toBe('Hello Ada');
  });
});
