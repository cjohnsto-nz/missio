import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import Ajv from 'ajv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { MissioCollection, RequestDefaults } from '../src/models/types';
import { EnvironmentService } from '../src/services/environmentService';
import { GrpcClient } from '../src/services/grpcClient';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import { RuntimeExecutionError, RuntimeExecutionService } from '../src/services/runtimeExecutionService';
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

interface DemoGrpcServerProcess {
  child: ChildProcessWithoutNullStreams;
  target: string;
  output: () => string;
}

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

function makeDemoCollection(): MissioCollection {
  const filePath = path.join(demoRoot, 'opencollection.yml');
  return {
    id: filePath,
    filePath,
    rootDir: demoRoot,
    data: parseYaml(fs.readFileSync(filePath, 'utf-8')) as any,
  };
}

function readDemoGrpcRequest(fileName: string) {
  return parseYaml(fs.readFileSync(path.join(demoRoot, 'gRPC', fileName), 'utf-8'));
}

function readDemoGrpcFolderDefaults(): RequestDefaults | undefined {
  return parseYaml(fs.readFileSync(path.join(demoRoot, 'gRPC', 'folder.yml'), 'utf-8')).request;
}

function setDemoGrpcBaseUrl(collection: MissioCollection, value: string): void {
  const environments = collection.data.config?.environments ?? [];
  const local = environments.find(env => env.name === 'LOCAL');
  if (!local) throw new Error('Demo collection is missing LOCAL environment.');
  local.variables ??= [];
  const variable = local.variables.find(item => item.name === 'grpcBaseUrl');
  if (variable) variable.value = value;
  else local.variables.push({ name: 'grpcBaseUrl', value });
}

async function withUnavailableLocalGrpcTarget<T>(run: (target: string) => Promise<T>): Promise<T> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') {
    throw new Error('Unable to create an unavailable local gRPC target.');
  }

  try {
    return await run(`127.0.0.1:${bound.port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

function makeDemoGrpcExecution(environmentService: EnvironmentService): RequestExecutionService {
  return new RequestExecutionService(
    { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
    undefined,
    new GrpcClient(environmentService),
    new RuntimeExecutionService((runtimeCollection, folderDefaults, environmentName) =>
      environmentService.resolveVariables(runtimeCollection, folderDefaults, environmentName),
    ),
  );
}

function startDemoGrpcServerProcess(): Promise<DemoGrpcServerProcess> {
  const child = spawn(process.execPath, [path.join(demoRoot, 'grpc-server.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MISSIO_GRPC_PORT: '0' },
    stdio: 'pipe',
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const finish = (error?: Error, port?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ child, target: `127.0.0.1:${port}`, output: () => output });
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf-8');
      const match = output.match(/Listening on 127\.0\.0\.1:(\d+)/i);
      if (match) {
        finish(undefined, match[1]);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`gRPC demo server exited before readiness (code=${code}, signal=${signal}). Output:\n${output}`));
    };
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for gRPC demo server readiness. Output:\n${output}`));
    }, 10_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopDemoGrpcServerProcess(serverProcess: DemoGrpcServerProcess): Promise<void> {
  if (serverProcess.child.exitCode !== null) return;
  serverProcess.child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      serverProcess.child.kill('SIGKILL');
      reject(new Error(`Timed out stopping the gRPC demo server. Output:\n${serverProcess.output()}`));
    }, 2_000);
    serverProcess.child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (process.platform !== 'win32' && !serverProcess.output().includes('Missio gRPC Demo Server stopped.')) {
    throw new Error(`gRPC demo server did not report graceful shutdown. Output:\n${serverProcess.output()}`);
  }
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
      const reply = () => {
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
      };
      if (call.request.userId === 999) {
        const timer = setTimeout(reply, 250);
        call.on('cancelled', () => clearTimeout(timer));
        return;
      }
      reply();
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
      call.on('end', () => callback(null, {
        count: requests.length,
        names: requests.map(request => request.name).join(','),
        requestIds: requests.map(request => request.trace?.requestId ?? '').join(','),
        authorization: String(call.metadata.get('authorization')[0] ?? ''),
        defaultMetadata: String(call.metadata.get('x-demo-default')[0] ?? ''),
      }));
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

  it('fails unsupported schema auth loudly', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    const client = new GrpcClient(environmentService);

    await expect(client.send({
      ...makeUnaryRequest(address),
      runtime: { auth: { type: 'digest', username: 'u', password: 'p' } as any },
    }, collection)).rejects.toThrow(/digest.*not supported for gRPC/);

    await expect(client.send({
      ...makeUnaryRequest(address),
      runtime: { auth: { type: 'apikey', key: 'api_key', value: 'secret', placement: 'query' } },
    }, collection)).rejects.toThrow(/API key query auth is not supported for gRPC/);
  });

  it('runs runtime lifecycle around unary gRPC metadata and message construction', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    const localEnv = collection.data.config?.environments?.find(env => env.name === 'LOCAL');
    localEnv?.variables?.push({ name: 'grpcBaseUrl', value: address });
    localEnv?.variables?.push({ name: 'grpcRuntimeNameSeed', value: 'Runtime Ada' });
    localEnv?.variables?.push({ name: 'grpcRuntimeUserIdSeed', value: '77' });
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const grpcClient = new GrpcClient(environmentService);
    const runtime = new RuntimeExecutionService((runtimeCollection, folderDefaults, environmentName) =>
      environmentService.resolveVariables(runtimeCollection, folderDefaults, environmentName),
    );
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      undefined,
      grpcClient,
      runtime,
    );
    const request = {
      ...makeUnaryRequest(address),
      grpc: {
        ...makeUnaryRequest(address).grpc,
        message: '{"name":"before","userId":0,"trace":{"requestId":"before"}}',
      },
      runtime: {
        auth: { type: 'bearer' as const, token: '{{grpcToken}}' },
        variables: [
          { name: 'grpcRuntimeUserId', value: '{{grpcRuntimeUserIdSeed}}' },
          { name: 'grpcRuntimeNameSeeded', value: '{{grpcRuntimeNameSeed}}' },
        ],
        scripts: [
          {
            type: 'before-request' as const,
            code: 'missio.variables.set("grpcRuntimeName", "{{grpcRuntimeNameSeeded}}");',
          },
          {
            type: 'before-request' as const,
            code: [
              'missio.variables.set("grpcRuntimeTrace", "runtime-{{grpcRequestId}}");',
              'missio.request.metadata.set("x-demo-request", "script-{{grpcRequestId}}");',
              'missio.request.body = { name: "{{grpcRuntimeName}}", userId: Number("{{grpcRuntimeUserId}}"), trace: { requestId: "{{grpcRuntimeTrace}}" } };',
            ].join('\n'),
          },
          {
            type: 'after-response' as const,
            code: 'console.info("grpc after", response.json().requestId);',
          },
          {
            type: 'tests' as const,
            code: 'test("grpc runtime response", () => assert(response.json().name === "Runtime Ada"));',
          },
        ],
        assertions: [
          { expression: 'res.body.requestId', operator: 'equals', value: 'runtime-trace-123' },
          { expression: 'res.body.userId', operator: 'equals', value: '77' },
        ],
        actions: [
          {
            type: 'set-variable' as const,
            selector: { method: 'jsonq' as const, expression: '$.requestId' },
            variable: { scope: 'runtime' as const, name: 'grpcRuntimeRequestId' },
          },
        ],
      },
    };

    const response = await execution.send(request as any, collection, {
      metadata: [{ name: 'x-demo-folder', value: 'folder-{{grpcRequestId}}' }],
    });
    const body = JSON.parse(response.body);

    expect(body).toMatchObject({
      message: 'Hello Runtime Ada',
      name: 'Runtime Ada',
      userId: 77,
      requestId: 'runtime-trace-123',
      authorization: 'Bearer token-abc',
      requestMetadata: 'script-trace-123',
      folderMetadata: 'folder-trace-123',
    });
    expect(response.runtime?.success).toBe(true);
    expect(response.runtime?.summary).toEqual({ passed: 4, failed: 0, skipped: 0 });
    expect(response.runtime?.variableMutations.map(mutation => mutation.name)).toEqual([
      'grpcRuntimeName',
      'grpcRuntimeTrace',
      'grpcRuntimeRequestId',
    ]);
    expect(response.runtime?.logs[0].message).toBe('grpc after runtime-trace-123');
  });

  it('runs after-response runtime for unary gRPC failures without hiding diagnostics', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      undefined,
      new GrpcClient(environmentService),
      new RuntimeExecutionService((runtimeCollection, folderDefaults, environmentName) =>
        environmentService.resolveVariables(runtimeCollection, folderDefaults, environmentName),
      ),
    );
    const request = {
      ...makeUnaryRequest(address),
      grpc: {
        ...makeUnaryRequest(address).grpc,
        method: 'missio.demo.DemoService/MissingMethod',
      },
      runtime: {
        scripts: [{
          type: 'tests' as const,
          code: 'test("grpc error is visible", () => assert(response.json().error.message.includes("was not found")));',
        }],
        assertions: [
          { expression: 'res.status', operator: 'equals', value: '200' },
        ],
      },
    };

    const response = await execution.send(request as any, collection);

    expect(response.status).toBe(0);
    expect(JSON.parse(response.body).error.message).toMatch(/MissingMethod.*was not found/);
    expect(response.runtime?.success).toBe(false);
    expect(response.runtime?.tests[0]).toMatchObject({ name: 'grpc error is visible', passed: true });
    expect(response.runtime?.assertions[0].passed).toBe(false);
  });

  it('denies unsafe unary gRPC runtime scripts before opening a call', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const grpcClient = new GrpcClient(environmentService);
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      undefined,
      grpcClient,
      new RuntimeExecutionService((runtimeCollection, folderDefaults, environmentName) =>
        environmentService.resolveVariables(runtimeCollection, folderDefaults, environmentName),
      ),
    );
    const request = {
      ...makeUnaryRequest(address),
      runtime: {
        scripts: [{ type: 'before-request' as const, code: 'require("fs").readFileSync("package.json", "utf8");' }],
      },
    };

    await expect(execution.send(request as any, collection)).rejects.toBeInstanceOf(RuntimeExecutionError);
    expect((grpcClient as any)._activeCalls.size).toBe(0);
  });

  it('cancels runtime-prepared unary gRPC calls and cleans up active state', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const grpcClient = new GrpcClient(environmentService);
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      undefined,
      grpcClient,
      new RuntimeExecutionService((runtimeCollection, folderDefaults, environmentName) =>
        environmentService.resolveVariables(runtimeCollection, folderDefaults, environmentName),
      ),
    );
    const request = {
      ...makeUnaryRequest(address),
      grpc: {
        ...makeUnaryRequest(address).grpc,
        message: '{"name":"Slow Ada","userId":999,"trace":{"requestId":"cancel-runtime"}}',
      },
      runtime: {
        scripts: [{ type: 'before-request' as const, code: 'missio.variables.set("prepared", "yes");' }],
      },
    };

    const pending = execution.send(request as any, collection);
    setTimeout(() => execution.cancelAll(), 10);

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect((grpcClient as any)._activeCalls.size).toBe(0);
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

    const response = await client.send(makeClientStreamingRequest(address) as any, collection);
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

    const response = await client.send(makeBidiStreamingRequest(address) as any, collection);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(response.headers['x-missio-grpc-method-type']).toBe('bidi-streaming');
    expect(body.sentMessages.map((entry: any) => entry.description)).toEqual(['first chat', 'second chat']);
    expect(body.receivedMessages.map((entry: any) => entry.message.name)).toEqual(['ack:Ada', 'ack:Grace']);
    expect(body.events.filter((event: any) => event.type === 'sent')).toHaveLength(2);
    expect(body.events.filter((event: any) => event.type === 'received')).toHaveLength(2);
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
    } as any, collection)).rejects.toThrow(/ordered array of request message objects/);

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

    const pending = client.send(makeServerStreamingRequest(address, 999) as any, collection);
    setTimeout(() => client.cancelAll(), 10);

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect((client as any)._activeCalls.size).toBe(0);
  });
});

describe('gRPC schema and tooling surfaces', () => {
  it('validates and round-trips streaming message sequences through schema-safe editors', () => {
    const request = makeClientStreamingRequest('localhost:50051') as any;
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

  it('smoke tests the committed demo unary gRPC runtime lifecycle request', async () => {
    const environmentService = makeEnvironmentService();
    const collection = makeCollection();
    const localEnv = collection.data.config?.environments?.find(env => env.name === 'LOCAL');
    localEnv?.variables?.push({ name: 'grpcBaseUrl', value: address });
    await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
    const request = parseYaml(fs.readFileSync(path.join(demoRoot, 'gRPC', 'runtime-unary-lifecycle.yml'), 'utf-8'));
    const grpcClient = new GrpcClient(environmentService);
    const response = await new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      undefined,
      grpcClient,
      new RuntimeExecutionService((runtimeCollection, folderDefaults, environmentName) =>
        environmentService.resolveVariables(runtimeCollection, folderDefaults, environmentName),
      ),
    ).send(request as any, collection, {
      metadata: [{ name: 'x-demo-folder', value: 'folder-{{grpcRequestId}}' }],
    });
    const body = JSON.parse(response.body);

    expect(body).toMatchObject({
      name: 'Ada Runtime',
      userId: 77,
      requestMetadata: 'script-trace-123',
    });
    expect(response.runtime?.success).toBe(true);
    expect(response.runtime?.actions[0]).toMatchObject({ target: 'runtime.grpcRuntimeRequestId' });
  });
});

describe('gRPC demo server reliability', () => {
  it('keeps unavailable local gRPC target diagnostics generic and unbranded', async () => {
    await withUnavailableLocalGrpcTarget(async unavailableTarget => {
      const environmentService = makeEnvironmentService();
      const collection = makeDemoCollection();
      const request = readDemoGrpcRequest('echo-unary.yml') as any;
      request.grpc.url = unavailableTarget;
      const execution = makeDemoGrpcExecution(environmentService);

      let error: unknown;
      try {
        await execution.send(
          request,
          collection,
          readDemoGrpcFolderDefaults(),
          undefined,
          undefined,
          'LOCAL',
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as any).code).toBe('GRPC_UNAVAILABLE');
      expect((error as any).grpcStatus).toBe(grpc.status.UNAVAILABLE);
      expect((error as any).grpcDetails).toEqual(expect.any(String));
      expect((error as Error).message).toMatch(/UNAVAILABLE/i);
      expect((error as Error).message).not.toMatch(/Missio gRPC demo fixture|node examples\/demo-api\/grpc-server\.js/i);
      expect((error as any).hint).toBeUndefined();
    });
  });

  it('keeps runtime-wrapped gRPC transport errors generic without hint headers', async () => {
    await withUnavailableLocalGrpcTarget(async unavailableTarget => {
      const environmentService = makeEnvironmentService();
      const collection = makeDemoCollection();
      setDemoGrpcBaseUrl(collection, unavailableTarget);
      const request = readDemoGrpcRequest('runtime-unary-lifecycle.yml');
      const execution = makeDemoGrpcExecution(environmentService);

      const response = await execution.send(
        request as any,
        collection,
        readDemoGrpcFolderDefaults(),
        undefined,
        undefined,
        'LOCAL',
      );
      const body = JSON.parse(response.body);

      expect(response.status).toBe(0);
      expect(response.headers['x-missio-grpc-status']).toBe(String(grpc.status.UNAVAILABLE));
      expect(response.headers['x-missio-error-hint']).toBeUndefined();
      expect(body.error.hint).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/Missio gRPC demo fixture|node examples\/demo-api\/grpc-server\.js/i);
    });
  });

  it('starts the documented fixture and smokes every packaged gRPC demo request through Missio execution', async () => {
    const demoServer = await startDemoGrpcServerProcess();
    try {
      const environmentService = makeEnvironmentService();
      const collection = makeDemoCollection();
      setDemoGrpcBaseUrl(collection, demoServer.target);
      await environmentService.setActiveEnvironment(collection.id, 'LOCAL');
      const execution = makeDemoGrpcExecution(environmentService);
      const folderDefaults = readDemoGrpcFolderDefaults();
      const send = (fileName: string) => execution.send(
        readDemoGrpcRequest(fileName) as any,
        collection,
        folderDefaults,
        undefined,
        undefined,
        'LOCAL',
        undefined,
        { requestId: path.join(demoRoot, 'gRPC', fileName) },
      );

      const unary = JSON.parse((await send('echo-unary.yml')).body);
      expect(unary).toMatchObject({
        message: 'Hello Ada',
        name: 'Ada',
        userId: 42,
        requestId: 'demo-trace-001',
        authorization: 'Bearer demo-token',
        defaultMetadata: 'request-override-demo-trace-001',
        folderMetadata: 'folder-demo-trace-001',
        requestMetadata: 'request-demo-trace-001',
      });

      const metadata = JSON.parse((await send('echo-metadata-defaults.yml')).body);
      expect(metadata).toMatchObject({
        message: 'Hello Metadata Ada',
        defaultMetadata: 'collection-demo-trace-001',
        folderMetadata: 'folder-demo-trace-001',
        requestMetadata: 'metadata-defaults-demo-trace-001',
      });

      const serverStream = JSON.parse((await send('stream-users.yml')).body);
      expect(serverStream).toMatchObject({
        methodType: 'server-streaming',
        sentMessageCount: 1,
        receivedMessageCount: 2,
      });
      expect(serverStream.receivedMessages.map((entry: any) => entry.message.name)).toEqual(['Ada', 'Grace']);

      const clientStream = JSON.parse((await send('upload-users-client-streaming.yml')).body);
      expect(clientStream).toMatchObject({
        methodType: 'client-streaming',
        sentMessageCount: 2,
        receivedMessageCount: 1,
      });
      expect(clientStream.receivedMessages[0].message).toMatchObject({
        count: 2,
        names: 'Ada,Grace',
        requestIds: 'demo-trace-001-1,demo-trace-001-2',
        authorization: 'Bearer demo-token',
        defaultMetadata: 'collection-demo-trace-001',
      });

      const bidiStream = JSON.parse((await send('chat-users-bidi-streaming.yml')).body);
      expect(bidiStream).toMatchObject({
        methodType: 'bidi-streaming',
        sentMessageCount: 2,
        receivedMessageCount: 2,
      });
      expect(bidiStream.receivedMessages.map((entry: any) => entry.message.name)).toEqual(['ack:Ada', 'ack:Grace']);

      const errorResponse = await send('stream-users-error.yml');
      const errorStream = JSON.parse(errorResponse.body);
      expect(errorResponse.status).toBe(0);
      expect(errorStream.receivedMessages[0].message).toMatchObject({
        id: 42,
        name: 'Ada',
        requestId: 'demo-trace-001-error',
      });
      expect(errorStream.error).toMatchObject({
        name: 'INTERNAL',
        details: 'Demo stream failure after partial data',
      });

      const runtimeResponse = await send('runtime-unary-lifecycle.yml');
      const runtimeBody = JSON.parse(runtimeResponse.body);
      expect(runtimeBody).toMatchObject({
        name: 'Ada Runtime',
        userId: 77,
        requestMetadata: 'script-demo-trace-001',
        requestId: 'runtime-demo-trace-001',
      });
      expect(runtimeResponse.runtime?.success).toBe(true);
      expect(runtimeResponse.runtime?.summary).toEqual({ passed: 4, failed: 0, skipped: 0 });
      expect(runtimeResponse.runtime?.actions[0]).toMatchObject({ target: 'runtime.grpcRuntimeRequestId' });
    } finally {
      await stopDemoGrpcServerProcess(demoServer);
    }
  }, 20_000);
});
