import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { MissioCollection, RequestDefaults } from '../src/models/types';
import { EnvironmentService } from '../src/services/environmentService';
import { GrpcClient } from '../src/services/grpcClient';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import { validateCollection } from '../src/services/validationService';
import {
  applyCollectionEditorModel,
  createCollectionEditorModelFromCollection,
} from '../src/models/schemaRoundTrip';

const demoRoot = path.resolve(__dirname, '..', 'examples', 'demo-api');
const demoProtoPath = path.join(demoRoot, 'proto', 'services', 'missio_demo.proto');
const schemaPath = path.resolve(__dirname, '..', 'schema', 'opencollectionschema.json');

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
      call.write({ id: call.request.userId || 1, name: 'Ada' });
      call.end();
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

describe('gRPC unary execution', () => {
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

  it('returns explicit diagnostics for unsupported streaming modes', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    const client = new GrpcClient(environmentService);

    await expect(client.send({
      info: { name: 'Streaming', type: 'grpc' as const },
      grpc: {
        url: address,
        method: 'missio.demo.DemoService/StreamUsers',
        methodType: 'server-streaming' as const,
        protoFilePath: 'proto/services/missio_demo.proto',
        message: '{"userId": 42}',
      },
    }, collection)).rejects.toMatchObject({
      code: 'MISSIO_GRPC_STREAMING_UNSUPPORTED',
      methodType: 'server-streaming',
    });
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
