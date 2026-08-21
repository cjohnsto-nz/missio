import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { WebSocketServer } from 'ws';
import { workspace, WorkspaceEdit } from 'vscode';
import type { MissioCollection, RequestDefaults, WebSocketRequest } from '../src/models/types';
import { MissioCodeLensProvider } from '../src/providers/codeLensProvider';
import { ListRequestsTool } from '../src/copilot/tools/listRequestsTool';
import { SendRequestTool } from '../src/copilot/tools/sendRequestTool';
import { RequestEditorProvider } from '../src/panels/requestPanel';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import { WebSocketClient } from '../src/services/webSocketClient';
import { detectUnresolvedVars } from '../src/services/unresolvedVars';
import { validateCollection } from '../src/services/validationService';
import {
  applyRequestEditorModel,
  createRequestEditorModelFromRequest,
} from '../src/models/schemaRoundTrip';

const demoRoot = path.resolve(__dirname, '..', 'examples', 'demo-api');
const schemaPath = path.resolve(__dirname, '..', 'schema', 'opencollectionschema.json');
const originalApplyEdit = workspace.applyEdit;

interface Fixture {
  server: http.Server;
  wss: WebSocketServer;
  baseUrl: string;
}

const fixtures: Fixture[] = [];

function interpolate(template: string, vars: Map<string, string>): string {
  return template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, name) => vars.get(name) ?? match);
}

function isJsonLiteral(value: string): boolean {
  try {
    JSON.parse(value);
    return /^(?:-?\d|true$|false$|null$|\[|\{)/.test(value.trim());
  } catch {
    return false;
  }
}

function interpolateJson(template: string, vars: Map<string, string>): string {
  const phase1 = template.replace(/"(\{\{\s*[\w.$-]+\s*\}\})"/g, (match, placeholder) => {
    const nameMatch = placeholder.match(/\{\{\s*([\w.$-]+)\s*\}\}/);
    if (!nameMatch) return match;
    const value = vars.get(nameMatch[1]);
    if (value === undefined) return match;
    return isJsonLiteral(value) ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return interpolate(phase1, vars);
}

function makeEnvService(vars: Record<string, string> = {}) {
  const map = new Map(Object.entries(vars));
  return {
    resolveVariables: vi.fn().mockResolvedValue(new Map(map)),
    resolveVariablesWithSource: vi.fn().mockResolvedValue(
      new Map([...map].map(([key, value]) => [key, { value, source: 'environment' }])),
    ),
    interpolate,
    interpolateJson,
    getActiveEnvironmentName: () => undefined,
  } as any;
}

function makeCollection(rootDir = process.cwd()): MissioCollection {
  return {
    id: path.join(rootDir, 'opencollection.yml'),
    filePath: path.join(rootDir, 'opencollection.yml'),
    rootDir,
    data: {
      opencollection: '1.0.0',
      info: { name: 'WebSocket Test' },
      config: { environments: [] },
      request: {
        headers: [{ name: 'X-Collection', value: 'collection-{{tenant}}' }],
      },
    },
  } as MissioCollection;
}

function socketPath(requestUrl: string | undefined): string {
  try {
    return new URL(requestUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return requestUrl ?? '/';
  }
}

function rejectUpgrade(socket: import('net').Socket, status: number): void {
  socket.write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function dataBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

async function startFixture(): Promise<Fixture> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const route = socketPath(req.url);
    if (route === '/ws/reject') {
      rejectUpgrade(socket, 401);
      return;
    }
    if (route === '/ws/auth' && (req.headers.authorization !== 'Bearer token-abc' || req.headers['x-demo-client'] !== 'missio-demo')) {
      rejectUpgrade(socket, 401);
      return;
    }
    if (!['/ws/echo', '/ws/auth', '/ws/close', '/ws/hold'].includes(route)) {
      rejectUpgrade(socket, 404);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).route = route;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const route = (ws as any).route as string;
    if (route === '/ws/close') {
      ws.close(4000, 'fixture close');
      return;
    }

    ws.on('message', (data, isBinary) => {
      if (route === '/ws/hold') return;
      const buffer = dataBuffer(data);
      if (route === '/ws/auth') {
        const text = buffer.toString('utf8');
        ws.send(JSON.stringify({
          ok: true,
          headers: {
            authorization: req.headers.authorization,
            'x-demo-client': req.headers['x-demo-client'],
            'x-collection': req.headers['x-collection'],
            'x-folder': req.headers['x-folder'],
          },
          message: JSON.parse(text),
        }));
        return;
      }
      ws.send(buffer, { binary: isBinary });
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind to a port');
  const fixture = { server, wss, baseUrl: `ws://127.0.0.1:${address.port}` };
  fixtures.push(fixture);
  return fixture;
}

async function closeFixtures(): Promise<void> {
  await Promise.all(fixtures.splice(0).map(fixture => new Promise<void>(resolve => {
    for (const client of fixture.wss.clients) client.terminate();
    fixture.wss.close(() => {
      fixture.server.close(() => resolve());
    });
  })));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  workspace.applyEdit = originalApplyEdit;
  vi.restoreAllMocks();
  await closeFixtures();
});

describe('WebSocket execution lifecycle', () => {
  it('connects, sends a text message, receives an echo, and clears active sockets', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({ wsBaseUrl: fixture.baseUrl, name: 'Ada', tenant: 'nz' });
    const client = new WebSocketClient(envService);
    const response = await client.send({
      info: { name: 'Echo', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/echo',
        message: { type: 'text', data: 'hello {{name}}' },
      },
    }, makeCollection());
    const body = JSON.parse(response.body);

    expect(response.status).toBe(101);
    expect(body.messageCount).toBe(1);
    expect(body.events.map((event: any) => event.direction)).toContain('outbound');
    expect(body.events.find((event: any) => event.direction === 'inbound')).toMatchObject({
      type: 'text',
      data: 'hello Ada',
    });
    expect(client.activeConnectionCount).toBe(0);
  });

  it('resolves selected JSON variants, inherited headers, and bearer auth during the handshake', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({
      wsBaseUrl: fixture.baseUrl,
      name: 'Grace',
      count: '2',
      tenant: 'nz',
      token: 'token-abc',
    });
    const client = new WebSocketClient(envService);
    const folderDefaults: RequestDefaults = {
      headers: [
        { name: 'X-Demo-Client', value: 'missio-demo' },
        { name: 'X-Folder', value: 'folder-{{tenant}}' },
      ],
    };
    const request: WebSocketRequest = {
      info: { name: 'Auth JSON', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/auth',
        message: [
          { title: 'Text', message: { type: 'text', data: 'not selected' } },
          {
            title: 'JSON',
            selected: true,
            message: { type: 'json', data: '{"user":"{{name}}","count":"{{count}}"}' },
          },
        ],
      },
      runtime: { auth: { type: 'bearer', token: '{{token}}' } },
    };

    const response = await client.send(request, makeCollection(), folderDefaults);
    const inbound = JSON.parse(response.body).events.find((event: any) => event.direction === 'inbound');
    const payload = JSON.parse(inbound.data);

    expect(payload).toMatchObject({
      ok: true,
      headers: {
        authorization: 'Bearer token-abc',
        'x-demo-client': 'missio-demo',
        'x-collection': 'collection-nz',
        'x-folder': 'folder-nz',
      },
      message: { user: 'Grace', count: 2 },
    });
    expect(client.activeConnectionCount).toBe(0);
  });

  it('sends binary frames and records base64 inbound payloads', async () => {
    const fixture = await startFixture();
    const client = new WebSocketClient(makeEnvService({ wsBaseUrl: fixture.baseUrl, tenant: 'nz' }));

    const response = await client.send({
      info: { name: 'Binary echo', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/echo',
        message: { type: 'binary', data: Buffer.from('hello').toString('base64') },
      },
    }, makeCollection());
    const inbound = JSON.parse(response.body).events.find((event: any) => event.direction === 'inbound');

    expect(inbound).toMatchObject({
      type: 'binary',
      data: Buffer.from('hello').toString('base64'),
    });
  });

  it('handles server close and explicit cancellation without leaking active sockets', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({ wsBaseUrl: fixture.baseUrl, tenant: 'nz' });
    const client = new WebSocketClient(envService);

    const closeResponse = await client.send({
      info: { name: 'Server close', type: 'websocket' },
      websocket: { url: '{{wsBaseUrl}}/ws/close' },
    }, makeCollection());
    expect(JSON.parse(closeResponse.body).events.some((event: any) => event.type === 'close')).toBe(true);
    expect(client.activeConnectionCount).toBe(0);

    const pending = client.send({
      info: { name: 'Hold', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/hold',
        message: { type: 'text', data: 'wait' },
      },
    }, makeCollection(), undefined, undefined, undefined, undefined, { requestId: 'hold-request' });

    await waitFor(() => client.activeConnectionCount === 1);
    expect(client.disconnect('hold-request')).toBe(true);
    await expect(pending).rejects.toThrow('Request cancelled');
    expect(client.activeConnectionCount).toBe(0);
  });

  it('rejects invalid WebSocket URLs before connecting', async () => {
    const client = new WebSocketClient(makeEnvService({ tenant: 'nz' }));

    await expect(client.send({
      info: { name: 'Invalid', type: 'websocket' },
      websocket: { url: 'https://example.com/socket' },
    }, makeCollection())).rejects.toMatchObject({
      code: 'MISSIO_INVALID_WEBSOCKET_URL',
    });
    expect(client.activeConnectionCount).toBe(0);
  });
});

describe('WebSocket editor, variables, and tools', () => {
  it('edits WebSocket requests schema-natively while preserving message variants', () => {
    const request = {
      info: { name: 'Socket variants', type: 'websocket' },
      websocket: {
        url: 'wss://api.example.com/socket',
        headers: [{ name: 'X-Client', value: 'missio', description: 'keep' }],
        message: [
          { title: 'Text', message: { type: 'text', data: 'ping' } },
          { title: 'JSON', selected: true, message: { type: 'json', data: '{"name":"Ada"}' } },
        ],
      },
      runtime: { auth: { type: 'apikey', key: 'x-api-key', value: '{{token}}' } },
      docs: 'Keep docs',
    };

    const model = createRequestEditorModelFromRequest(request);
    model.url = 'wss://api.example.com/socket/v2';
    model.body = {
      kind: 'raw',
      rawType: 'json',
      data: '{"name":"Grace"}',
      bodyVariantIndex: 1,
    };
    const updated = applyRequestEditorModel(request, model) as any;

    expect(updated.http).toBeUndefined();
    expect(updated.graphql).toBeUndefined();
    expect(updated.websocket.url).toBe('wss://api.example.com/socket/v2');
    expect(updated.websocket.message[0]).toEqual(request.websocket.message[0]);
    expect(updated.websocket.message[1].message).toEqual({ type: 'json', data: '{"name":"Grace"}' });
    expect(updated.runtime).toEqual(request.runtime);
  });

  it('allows the request editor to save WebSocket document edits', async () => {
    const applyEdit = vi.fn().mockResolvedValue(true);
    workspace.applyEdit = applyEdit;
    const replaceSpy = vi.spyOn(WorkspaceEdit.prototype, 'replace');
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      { disconnectWebSocket: vi.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await (provider as any)._applyDocumentEdit(
      {
        uri: { fsPath: path.join(process.cwd(), 'socket.yml') },
        lineCount: 5,
        getText: () => `
info: { name: Socket, type: websocket }
websocket:
  url: "wss://api.example.com/socket"
`,
      },
      {
        request: {
          info: { name: 'Socket', type: 'websocket' },
          websocket: {
            url: 'wss://api.example.com/socket/v2',
            message: { type: 'text', data: 'ping' },
          },
        },
      },
    );

    expect(applyEdit).toHaveBeenCalled();
    const yaml = replaceSpy.mock.calls[0][2] as string;
    expect(parseYaml(yaml)).toMatchObject({
      websocket: {
        url: 'wss://api.example.com/socket/v2',
        message: { type: 'text', data: 'ping' },
      },
    });
  });

  it('detects unresolved variables across WebSocket URL, inherited headers, message, and auth', async () => {
    const collection = makeCollection();
    collection.data.request!.headers = [{ name: 'X-Collection', value: '{{collectionHeader}}' }];
    const request: WebSocketRequest = {
      info: { name: 'Needs vars', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/{{route}}',
        headers: [{ name: 'X-Request', value: '{{requestHeader}}' }],
        message: [
          { title: 'Selected', selected: true, message: { type: 'text', data: '{{payload}}' } },
          { title: 'Ignored', message: { type: 'text', data: '{{ignored}}' } },
        ],
      },
      runtime: {
        auth: { type: 'bearer', token: '{{token}}' },
        variables: [{ name: 'route', value: 'echo' }],
      },
    };

    const unresolved = await detectUnresolvedVars(
      request,
      collection,
      makeEnvService({ wsBaseUrl: 'ws://127.0.0.1:1', payload: 'hello' }),
      { headers: [{ name: 'X-Folder', value: '{{folderHeader}}' }] },
    );

    expect(unresolved.sort()).toEqual(['collectionHeader', 'folderHeader', 'requestHeader', 'token']);
  });

  it('provides WebSocket CodeLens labels and Copilot list entries', async () => {
    const provider = new MissioCodeLensProvider();
    const lenses = provider.provideCodeLenses({
      uri: { fsPath: 'socket.yml' },
      getText: () => `
info: { name: Socket, type: websocket }
websocket:
  url: "{{wsBaseUrl}}/ws/echo"
`,
    } as any);
    expect(lenses.map(lens => lens.command?.title)).toEqual([
      'Connect WebSocket',
      'WS {{wsBaseUrl}}/ws/echo',
    ]);
    provider.dispose();

    const tool = new ListRequestsTool({
      resolveCollection: () => makeCollection(),
      resolveItems: async () => [{
        info: { name: 'Socket', type: 'websocket' },
        websocket: {
          url: '{{wsBaseUrl}}/ws/{{route}}',
          headers: [{ name: 'X-Trace', value: '{{traceId}}' }],
          message: { type: 'text', data: '{{payload}}' },
        },
      }],
    } as any);

    const parsed = JSON.parse(await tool.call({ input: {} } as any, {} as any));
    expect(parsed.requests[0]).toMatchObject({
      name: 'Socket',
      protocol: 'websocket',
      method: 'WS',
      url: '{{wsBaseUrl}}/ws/{{route}}',
      templateVariables: {
        wsBaseUrl: ['url'],
        route: ['url'],
        traceId: ['headers'],
        payload: ['message'],
      },
    });
  });

  it('dry-runs and sends WebSocket requests from the Copilot send tool', async () => {
    const fixture = await startFixture();
    const collection = makeCollection();
    const envService = makeEnvService({
      wsBaseUrl: fixture.baseUrl,
      tenant: 'nz',
      name: 'Ada',
    });
    const request: WebSocketRequest = {
      info: { name: 'Tool socket', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/echo',
        message: { type: 'text', data: 'hello {{name}}' },
      },
    };
    const tool = new SendRequestTool(
      {
        loadRequestFile: async () => request,
        getCollection: () => collection,
        getCollections: () => [collection],
      } as any,
      envService,
      new RequestExecutionService(
        { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
        new WebSocketClient(envService),
      ),
    );

    const requestFilePath = path.join(collection.rootDir, 'socket.yml');
    const dryRun = JSON.parse(await tool.call(
      { input: { requestFilePath, collectionId: collection.id, dryRun: true } } as any,
      {} as any,
    ));
    expect(dryRun).toMatchObject({
      success: true,
      dryRun: true,
      protocol: 'websocket',
      url: `${fixture.baseUrl}/ws/echo`,
      message: { type: 'text', data: 'hello Ada' },
    });

    const live = JSON.parse(await tool.call(
      { input: { requestFilePath, collectionId: collection.id } } as any,
      {} as any,
    ));
    expect(live).toMatchObject({
      success: true,
      status: 101,
      headers: { 'x-missio-protocol': 'websocket' },
    });
    expect(JSON.parse(live.body).events.find((event: any) => event.direction === 'inbound')).toMatchObject({
      data: 'hello Ada',
    });
  });

  it('dispatches WebSocket requests and cancellation through RequestExecutionService', async () => {
    const response = { status: 101, statusText: 'WebSocket Exchange', headers: {}, body: '{}', duration: 1, size: 2 };
    const webSocketClient = {
      send: vi.fn().mockResolvedValue(response),
      cancelAll: vi.fn(),
      disconnect: vi.fn().mockReturnValue(true),
    };
    const httpClient = { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() };
    const service = new RequestExecutionService(httpClient as any, webSocketClient as any);
    const request: WebSocketRequest = {
      info: { name: 'Socket', type: 'websocket' },
      websocket: { url: 'ws://127.0.0.1/socket' },
    };
    const collection = makeCollection();

    await expect(service.send(request, collection, undefined, undefined, undefined, undefined, undefined, { requestId: 'socket.yml' })).resolves.toBe(response);
    expect(webSocketClient.send).toHaveBeenCalledWith(request, collection, undefined, undefined, undefined, undefined, { requestId: 'socket.yml' });

    service.cancelAll();
    expect(httpClient.cancelAll).toHaveBeenCalled();
    expect(webSocketClient.cancelAll).toHaveBeenCalled();
    expect(service.disconnectWebSocket('socket.yml')).toBe(true);
    expect(webSocketClient.disconnect).toHaveBeenCalledWith('socket.yml');
  });
});

describe('WebSocket demo fixtures', () => {
  it('keeps the demo API collection schema-valid with WebSocket requests', async () => {
    const report = await validateCollection(demoRoot, schemaPath);
    const webSocketIssues = report.issues.filter(issue => issue.file.includes('WebSocket'));

    expect(webSocketIssues).toEqual([]);
    expect(report.failCount).toBe(0);
  });

  it('smoke tests a committed demo WebSocket request against a local fixture server', async () => {
    const fixture = await startFixture();
    const request = parseYaml(fs.readFileSync(path.join(demoRoot, 'WebSocket', 'text-echo.yml'), 'utf-8')) as WebSocketRequest;
    const response = await new WebSocketClient(makeEnvService({
      wsBaseUrl: fixture.baseUrl,
      socketUser: 'Ada',
      socketMessageId: 'ws-demo-001',
      tenant: 'nz',
    })).send(request, makeCollection(demoRoot), {
      headers: [{ name: 'X-Demo-Client', value: 'missio-demo' }],
    });

    const inbound = JSON.parse(response.body).events.find((event: any) => event.direction === 'inbound');
    expect(inbound.data).toBe('Hello Ada from ws-demo-001');
  });
});
