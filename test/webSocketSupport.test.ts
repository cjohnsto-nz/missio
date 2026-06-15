import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { WebSocketServer } from 'ws';
import { commands, window, workspace, WorkspaceEdit } from 'vscode';
import type { MissioCollection, RequestDefaults, WebSocketRequest } from '../src/models/types';
import { MissioCodeLensProvider } from '../src/providers/codeLensProvider';
import { ListRequestsTool } from '../src/copilot/tools/listRequestsTool';
import { SendRequestTool } from '../src/copilot/tools/sendRequestTool';
import { WebSocketSessionTool } from '../src/copilot/tools/webSocketSessionTool';
import { RequestEditorProvider } from '../src/panels/requestPanel';
import { registerRequestCommands } from '../src/commands/requestCommands';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import { RuntimeExecutionError, RuntimeExecutionService } from '../src/services/runtimeExecutionService';
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
    if (!['/ws/echo', '/ws/auth', '/ws/close', '/ws/hold', '/ws/session', '/ws/push'].includes(route)) {
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
    if (route === '/ws/push') {
      ws.send(JSON.stringify({ route, event: 'connected' }));
      setTimeout(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ route, event: 'server-push' }));
      }, 25);
    }
    let messageCount = 0;

    ws.on('message', (data, isBinary) => {
      messageCount += 1;
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
            'x-runtime-header': req.headers['x-runtime-header'],
          },
          message: JSON.parse(text),
        }));
        return;
      }
      if (route === '/ws/session' || route === '/ws/push') {
        ws.send(JSON.stringify({
          ok: true,
          route,
          messageCount,
          message: isBinary ? buffer.toString('base64') : buffer.toString('utf8'),
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
  it('connects without sending, sends repeated messages, records server push, and disconnects with history', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({ wsBaseUrl: fixture.baseUrl, name: 'Ada', tenant: 'nz' });
    const client = new WebSocketClient(envService);
    const request: WebSocketRequest = {
      info: { name: 'Persistent session', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/push',
        message: { type: 'text', data: 'hello {{name}}' },
      },
    };

    const connected = await client.connect(request, makeCollection(), undefined, undefined, undefined, undefined, {
      requestId: 'persistent.yml',
      requestFilePath: 'persistent.yml',
    });
    expect(connected).toMatchObject({
      state: 'connected',
      outboundCount: 0,
    });

    await waitFor(() => (client.getSession('persistent.yml')?.inboundCount ?? 0) >= 2);
    await client.sendMessage('persistent.yml');
    await client.sendMessage('persistent.yml', { type: 'text', data: 'second {{name}}' });
    await waitFor(() => (client.getSession('persistent.yml')?.events.filter(event => event.direction === 'outbound').length ?? 0) === 2);
    await waitFor(() => (client.getSession('persistent.yml')?.inboundCount ?? 0) >= 4);

    const response = await client.disconnectSession('persistent.yml');
    const body = JSON.parse(response!.body);

    expect(client.activeConnectionCount).toBe(0);
    expect(client.getSession('persistent.yml')).toMatchObject({ state: 'closed', outboundCount: 2 });
    expect(body.events.map((event: any) => event.direction)).toEqual(expect.arrayContaining(['outbound', 'inbound', 'event']));
    expect(body.events.filter((event: any) => event.direction === 'outbound').map((event: any) => event.data)).toEqual([
      'hello Ada',
      'second Ada',
    ]);
  });

  it('diagnoses duplicate connect and send while disconnected', async () => {
    const fixture = await startFixture();
    const client = new WebSocketClient(makeEnvService({ wsBaseUrl: fixture.baseUrl, tenant: 'nz' }));
    const request: WebSocketRequest = {
      info: { name: 'Duplicate', type: 'websocket' },
      websocket: { url: '{{wsBaseUrl}}/ws/session', message: { type: 'text', data: 'ping' } },
    };

    await expect(client.sendMessage('missing.yml')).rejects.toMatchObject({ code: 'MISSIO_WEBSOCKET_NOT_CONNECTED' });
    await client.connect(request, makeCollection(), undefined, undefined, undefined, undefined, { requestId: 'duplicate.yml' });
    await expect(client.connect(request, makeCollection(), undefined, undefined, undefined, undefined, { requestId: 'duplicate.yml' }))
      .rejects.toMatchObject({ code: 'MISSIO_WEBSOCKET_ALREADY_CONNECTED' });
    await client.disconnectSession('duplicate.yml');
  });

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

  it('runs runtime lifecycle around WebSocket request mutation and exchange summaries', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({
      wsBaseUrl: fixture.baseUrl,
      tenant: 'nz',
      token: 'token-abc',
    });
    const client = new WebSocketClient(envService);
    const runtime = new RuntimeExecutionService((collection, folderDefaults, environmentName) =>
      envService.resolveVariables(collection, folderDefaults, environmentName),
    );
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      client,
      undefined,
      runtime,
    );
    const request: WebSocketRequest = {
      info: { name: 'Runtime socket', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/auth',
        message: { type: 'json', data: '{"user":"before","count":0}' },
      },
      runtime: {
        auth: { type: 'bearer', token: '{{token}}' },
        variables: [{ name: 'runtimeCount', value: '7' }],
        scripts: [
          {
            type: 'before-request',
            code: [
              'missio.variables.set("runtimeUser", "Ada Runtime");',
              'missio.request.headers.set("X-Demo-Client", "missio-demo");',
              'missio.request.headers.set("X-Runtime-Header", "scripted");',
              'missio.request.body = { user: missio.variables.get("runtimeUser"), count: Number(missio.variables.get("runtimeCount")) };',
            ].join('\n'),
          },
          {
            type: 'after-response',
            code: [
              'const inbound = response.json().events.find(event => event.direction === "inbound");',
              'const payload = JSON.parse(inbound.data);',
              'console.log("websocket after", payload.message.user);',
              'missio.variables.set("afterUser", payload.message.user);',
            ].join('\n'),
          },
          {
            type: 'tests',
            code: [
              'const inbound = response.json().events.find(event => event.direction === "inbound");',
              'const payload = JSON.parse(inbound.data);',
              'test("websocket runtime payload echoed", () => assert(payload.message.count === 7));',
            ].join('\n'),
          },
        ],
        assertions: [
          { expression: 'res.body.messageCount', operator: 'equals', value: '1' },
        ],
        actions: [
          {
            type: 'set-variable',
            selector: { method: 'jsonq', expression: '$.messageCount' },
            variable: { scope: 'runtime', name: 'wsMessageCount' },
          },
        ],
      } as any,
    };

    const response = await execution.send(request, makeCollection(), undefined, undefined, undefined, undefined, undefined, { requestId: 'runtime-ws' });
    const body = JSON.parse(response.body);
    const inbound = body.events.find((event: any) => event.direction === 'inbound');
    const payload = JSON.parse(inbound.data);

    expect(payload).toMatchObject({
      ok: true,
      headers: {
        authorization: 'Bearer token-abc',
        'x-demo-client': 'missio-demo',
        'x-runtime-header': 'scripted',
      },
      message: { user: 'Ada Runtime', count: 7 },
    });
    expect(response.runtime?.success).toBe(true);
    expect(response.runtime?.summary).toEqual({ passed: 3, failed: 0, skipped: 0 });
    expect(response.runtime?.actions[0]).toMatchObject({ passed: true, target: 'runtime.wsMessageCount', value: 1 });
    expect(response.runtime?.variableMutations.map(mutation => mutation.name)).toEqual(['runtimeUser', 'wsMessageCount', 'afterUser']);
    expect(response.runtime?.logs[0].message).toBe('websocket after Ada Runtime');
    expect(client.activeConnectionCount).toBe(0);
  });

  it('runs after-response runtime on WebSocket terminal errors and preserves cleanup', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({ wsBaseUrl: fixture.baseUrl, tenant: 'nz' });
    const client = new WebSocketClient(envService);
    const runtime = new RuntimeExecutionService((collection, folderDefaults, environmentName) =>
      envService.resolveVariables(collection, folderDefaults, environmentName),
    );
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      client,
      undefined,
      runtime,
    );
    const request: WebSocketRequest = {
      info: { name: 'Runtime reject', type: 'websocket' },
      websocket: { url: '{{wsBaseUrl}}/ws/reject' },
      runtime: {
        scripts: [{
          type: 'tests',
          code: 'test("websocket error is visible", () => assert(response.json().error.message.includes("401")));',
        }],
        assertions: [
          { expression: 'res.status', operator: 'equals', value: '101' },
        ],
      } as any,
    };

    const response = await execution.send(request, makeCollection());

    expect(response.status).toBe(0);
    expect(JSON.parse(response.body).error.message).toContain('401');
    expect(response.runtime?.success).toBe(false);
    expect(response.runtime?.tests[0]).toMatchObject({ name: 'websocket error is visible', passed: true });
    expect(response.runtime?.assertions[0].passed).toBe(false);
    expect(client.activeConnectionCount).toBe(0);
  });

  it('denies unsafe WebSocket runtime scripts before opening a socket', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({ wsBaseUrl: fixture.baseUrl, tenant: 'nz' });
    const client = new WebSocketClient(envService);
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      client,
      undefined,
      new RuntimeExecutionService((collection, folderDefaults, environmentName) =>
        envService.resolveVariables(collection, folderDefaults, environmentName),
      ),
    );

    await expect(execution.send({
      info: { name: 'Unsafe runtime', type: 'websocket' },
      websocket: { url: '{{wsBaseUrl}}/ws/echo' },
      runtime: {
        scripts: [{ type: 'before-request', code: 'require("fs").readFileSync("package.json", "utf8");' }],
      } as any,
    }, makeCollection())).rejects.toBeInstanceOf(RuntimeExecutionError);
    expect(client.activeConnectionCount).toBe(0);
  });

  it('cancels WebSocket requests after runtime preparation without leaking sockets', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({ wsBaseUrl: fixture.baseUrl, tenant: 'nz' });
    const client = new WebSocketClient(envService);
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      client,
      undefined,
      new RuntimeExecutionService((collection, folderDefaults, environmentName) =>
        envService.resolveVariables(collection, folderDefaults, environmentName),
      ),
    );
    const pending = execution.send({
      info: { name: 'Runtime hold', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/hold',
        message: { type: 'text', data: 'wait' },
      },
      runtime: {
        scripts: [{ type: 'before-request', code: 'missio.variables.set("prepared", "yes");' }],
      } as any,
    }, makeCollection(), undefined, undefined, undefined, undefined, undefined, { requestId: 'runtime-hold' });

    await waitFor(() => client.activeConnectionCount === 1);
    expect(execution.disconnectWebSocket('runtime-hold')).toBe(true);
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
  it('renders separate WebSocket lifecycle controls and message history shell', () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      { disconnectWebSocketSession: vi.fn(), getWebSocketSession: vi.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const html = (provider as any)._getBodyHtml({} as any) as string;
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'requestPanel.css'), 'utf8');

    expect(html).toContain('id="sendBtn">Send</button>');
    expect(html).toContain('id="wsSendBtn"');
    expect(html).toContain('id="wsDisconnectBtn"');
    expect(html).toContain('id="webSocketSessionPanel"');
    expect(html).toContain('id="webSocketHistory"');
    expect(css).toContain('.websocket-session-panel');
    expect(css).toContain('.websocket-history-row');
  });

  it('wires VS Code bottom status bar session management in extension activation', () => {
    const extensionSource = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const commands = new Set(pkg.contributes.commands.map((command: any) => command.command));

    expect(extensionSource).toContain('webSocketStatusBarItem');
    expect(extensionSource).toContain("webSocketStatusBarItem.command = 'missio.showWebSocketSessions'");
    expect(extensionSource).toContain('requestExecutionService.onDidChangeWebSocketSession');
    expect(commands.has('missio.showWebSocketSessions')).toBe(true);
    expect(commands.has('missio.disconnectAllWebSockets')).toBe(true);
  });

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

  it('connects with the freshly posted WebSocket request when document YAML is stale', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-ws-editor-'));
    const requestFilePath = path.join(rootDir, 'socket.yml');
    const collection = makeCollection(rootDir);
    const requestExecutionService = {
      connectWebSocket: vi.fn().mockResolvedValue({
        requestId: requestFilePath,
        state: 'connected',
        events: [],
        inboundCount: 0,
        outboundCount: 0,
      }),
      getWebSocketSession: vi.fn(),
      disconnectWebSocketSession: vi.fn(),
      sendWebSocketMessage: vi.fn(),
    };
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      requestExecutionService as any,
      { getCollections: () => [collection] } as any,
      makeEnvService({ tenant: 'nz' }),
      {} as any,
      {} as any,
    );
    const staleYaml = [
      'info: { name: Editor Socket, type: websocket }',
      'websocket:',
      '  url: "ws://127.0.0.1:7777/ws/stale"',
      '  message: { type: text, data: "stale" }',
      '',
    ].join('\n');
    const postedRequest: WebSocketRequest = {
      info: { name: 'Editor Socket', type: 'websocket' },
      websocket: {
        url: 'ws://127.0.0.1:7777/ws/current',
        headers: [{ name: 'X-Current', value: 'yes' }],
        message: { type: 'text', data: 'current' },
      },
    };
    const webview = { postMessage: vi.fn().mockResolvedValue(true) };

    try {
      await (provider as any)._connectWebSocket(
        webview,
        { request: postedRequest },
        {
          document: {
            uri: { fsPath: requestFilePath },
            getText: () => staleYaml,
          },
        },
      );

      const connectedRequest = requestExecutionService.connectWebSocket.mock.calls[0][0] as WebSocketRequest;
      expect(connectedRequest.websocket.url).toBe('ws://127.0.0.1:7777/ws/current');
      expect(connectedRequest.websocket.headers).toEqual([{ name: 'X-Current', value: 'yes' }]);
      expect(connectedRequest.websocket.message).toEqual({ type: 'text', data: 'current' });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('sends the freshly posted WebSocket message when document YAML is stale', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-ws-editor-'));
    const requestFilePath = path.join(rootDir, 'socket.yml');
    const requestExecutionService = {
      sendWebSocketMessage: vi.fn().mockResolvedValue({
        requestId: requestFilePath,
        state: 'connected',
        events: [],
        inboundCount: 0,
        outboundCount: 1,
      }),
      getWebSocketSession: vi.fn(),
      disconnectWebSocketSession: vi.fn(),
    };
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      requestExecutionService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const staleYaml = [
      'info: { name: Editor Socket, type: websocket }',
      'websocket:',
      '  url: "ws://127.0.0.1:7777/ws/stale"',
      '  message: { type: text, data: "stale" }',
      '',
    ].join('\n');
    const postedRequest: WebSocketRequest = {
      info: { name: 'Editor Socket', type: 'websocket' },
      websocket: {
        url: 'ws://127.0.0.1:7777/ws/current',
        message: { type: 'text', data: 'current' },
      },
    };
    const webview = { postMessage: vi.fn().mockResolvedValue(true) };

    try {
      await (provider as any)._sendWebSocketMessage(
        webview,
        { request: postedRequest },
        {
          document: {
            uri: { fsPath: requestFilePath },
            getText: () => staleYaml,
          },
        },
      );

      expect(requestExecutionService.sendWebSocketMessage).toHaveBeenCalledWith(
        requestFilePath,
        { type: 'text', data: 'current' },
        expect.any(Function),
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('falls back to the document request consistently when posted send-message data is malformed', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-ws-editor-'));
    const requestFilePath = path.join(rootDir, 'socket.yml');
    const requestExecutionService = {
      sendWebSocketMessage: vi.fn().mockResolvedValue({
        requestId: requestFilePath,
        state: 'connected',
        events: [],
        inboundCount: 0,
        outboundCount: 1,
      }),
      getWebSocketSession: vi.fn(),
      disconnectWebSocketSession: vi.fn(),
    };
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      requestExecutionService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const documentYaml = [
      'info: { name: Editor Socket, type: websocket }',
      'websocket:',
      '  url: "ws://127.0.0.1:7777/ws/document"',
      '  message: { type: text, data: "document" }',
      '',
    ].join('\n');
    const malformedPostedRequest = {
      info: { name: 'Not a socket', type: 'http' },
      http: { method: 'GET', url: 'https://example.com' },
    };
    const webview = { postMessage: vi.fn().mockResolvedValue(true) };

    try {
      await (provider as any)._sendWebSocketMessage(
        webview,
        { request: malformedPostedRequest },
        {
          document: {
            uri: { fsPath: requestFilePath },
            getText: () => documentYaml,
          },
        },
      );

      expect(requestExecutionService.sendWebSocketMessage).toHaveBeenCalledWith(
        requestFilePath,
        { type: 'text', data: 'document' },
        expect.any(Function),
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
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
      'Send Message',
      'Disconnect WebSocket',
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

  it('dry-runs WebSocket requests from send_request and manages live sessions through the lifecycle tool', async () => {
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
    const webSocketClient = new WebSocketClient(envService);
    const execution = new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      webSocketClient,
    );
    const collectionFacade = {
      loadRequestFile: async () => request,
      getCollection: () => collection,
      getCollections: () => [collection],
    } as any;
    const tool = new SendRequestTool(
      collectionFacade,
      envService,
      execution,
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
      success: false,
      protocol: 'websocket',
      code: 'MISSIO_WEBSOCKET_LIFECYCLE_REQUIRED',
    });

    const sessionTool = new WebSocketSessionTool(collectionFacade, envService, execution);
    const connected = JSON.parse(await sessionTool.call(
      { input: { operation: 'connect', requestFilePath, collectionId: collection.id } } as any,
      {} as any,
    ));
    expect(connected).toMatchObject({
      success: true,
      operation: 'connect',
      session: { state: 'connected', outboundCount: 0 },
    });

    const sent = JSON.parse(await sessionTool.call(
      { input: { operation: 'send-message', requestFilePath, collectionId: collection.id } } as any,
      {} as any,
    ));
    expect(sent).toMatchObject({
      success: true,
      operation: 'send-message',
      session: { state: 'connected', outboundCount: 1 },
    });
    await waitFor(() => (execution.getWebSocketSession(requestFilePath)?.inboundCount ?? 0) === 1);
    const status = JSON.parse(await sessionTool.call(
      { input: { operation: 'status', requestFilePath, collectionId: collection.id } } as any,
      {} as any,
    ));
    expect(status.session.events.find((event: any) => event.direction === 'inbound')).toMatchObject({
      data: 'hello Ada',
    });

    const disconnected = JSON.parse(await sessionTool.call(
      { input: { operation: 'disconnect', requestFilePath, collectionId: collection.id } } as any,
      {} as any,
    ));
    expect(disconnected).toMatchObject({
      success: true,
      operation: 'disconnect',
      session: { state: 'closed' },
      response: { status: 101 },
    });
    expect(webSocketClient.activeConnectionCount).toBe(0);
  });

  it('registers command palette lifecycle operations for WebSocket requests', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-ws-commands-'));
    const requestFilePath = path.join(rootDir, 'socket.yml');
    fs.writeFileSync(requestFilePath, [
      'info: { name: Command Socket, type: websocket }',
      'websocket:',
      '  url: "ws://127.0.0.1:3456/ws/session"',
      '  message: { type: text, data: "ping" }',
      '',
    ].join('\n'));
    const handlers = new Map<string, (...args: any[]) => unknown>();
    vi.spyOn(commands, 'registerCommand').mockImplementation((name: string, callback: (...args: any[]) => unknown) => {
      handlers.set(name, callback);
      return { dispose: () => {} } as any;
    });
    vi.spyOn(window, 'withProgress').mockImplementation(async (_options: any, task: any) =>
      task({ report: vi.fn() }, { onCancellationRequested: vi.fn() }),
    );
    const collection = makeCollection(rootDir);
    const requestExecutionService = {
      connectWebSocket: vi.fn().mockResolvedValue({ requestId: requestFilePath, state: 'connected', events: [], inboundCount: 0, outboundCount: 0 }),
      sendWebSocketMessage: vi.fn().mockResolvedValue({ requestId: requestFilePath, state: 'connected', events: [], inboundCount: 0, outboundCount: 1 }),
      disconnectWebSocketSession: vi.fn().mockResolvedValue({ status: 101, statusText: 'WebSocket Session', headers: {}, body: '{}', duration: 1, size: 2 }),
      getWebSocketSession: vi.fn().mockReturnValue({ requestId: requestFilePath, state: 'closed', events: [], inboundCount: 0, outboundCount: 1, requestName: 'Command Socket' }),
      listWebSocketSessions: vi.fn().mockReturnValue([{ requestId: requestFilePath, requestFilePath, requestName: 'Command Socket', state: 'connected', events: [], inboundCount: 0, outboundCount: 0 }]),
      disconnectAllWebSocketSessions: vi.fn(),
      disconnectWebSocket: vi.fn(),
      cancelAll: vi.fn(),
    };

    try {
      registerRequestCommands({
        collectionService: {
          getCollections: () => [collection],
          loadRequestFile: vi.fn(),
        },
        environmentService: makeEnvService({ tenant: 'nz' }),
        httpClient: {},
        requestExecutionService,
        responseProvider: { showResponse: vi.fn() },
        collectionTreeProvider: {},
        extensionContext: {},
      } as any);

      await handlers.get('missio.connectWebSocket')?.(requestFilePath);
      await handlers.get('missio.sendWebSocketMessage')?.(requestFilePath);
      await handlers.get('missio.disconnectWebSocket')?.(requestFilePath);
      await handlers.get('missio.disconnectAllWebSockets')?.();

      expect(requestExecutionService.connectWebSocket).toHaveBeenCalledWith(
        expect.objectContaining({ websocket: expect.objectContaining({ url: 'ws://127.0.0.1:3456/ws/session' }) }),
        collection,
        undefined,
        expect.any(Function),
        undefined,
        undefined,
        { requestId: requestFilePath, requestFilePath, requestName: 'Command Socket' },
      );
      expect(requestExecutionService.sendWebSocketMessage).toHaveBeenCalledWith(requestFilePath, { type: 'text', data: 'ping' });
      expect(requestExecutionService.disconnectWebSocketSession).toHaveBeenCalledWith(requestFilePath);
      expect(requestExecutionService.disconnectAllWebSocketSessions).toHaveBeenCalled();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
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

  it('smoke tests the committed demo WebSocket runtime lifecycle request', async () => {
    const fixture = await startFixture();
    const envService = makeEnvService({
      wsBaseUrl: fixture.baseUrl,
      demoToken: 'token-abc',
      tenant: 'nz',
    });
    const request = parseYaml(fs.readFileSync(path.join(demoRoot, 'WebSocket', 'runtime-lifecycle.yml'), 'utf-8')) as WebSocketRequest;
    const client = new WebSocketClient(envService);
    const response = await new RequestExecutionService(
      { send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any,
      client,
      undefined,
      new RuntimeExecutionService((collection, folderDefaults, environmentName) =>
        envService.resolveVariables(collection, folderDefaults, environmentName),
      ),
    ).send(request, makeCollection(demoRoot), undefined, undefined, undefined, undefined, undefined, { requestId: 'demo-runtime-ws' });

    const inbound = JSON.parse(response.body).events.find((event: any) => event.direction === 'inbound');
    const payload = JSON.parse(inbound.data);
    expect(payload.message).toMatchObject({ user: 'Ada Runtime', count: 7 });
    expect(response.runtime?.success).toBe(true);
    expect(response.runtime?.actions[0]).toMatchObject({ target: 'runtime.runtimeSocketMessages', value: 1 });
    expect(client.activeConnectionCount).toBe(0);
  });
});
