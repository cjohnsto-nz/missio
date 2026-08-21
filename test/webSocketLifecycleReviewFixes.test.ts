import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as path from 'path';
import WebSocket from 'ws';
import { WebSocketSessionTool } from '../src/copilot/tools/webSocketSessionTool';
import { RequestEditorProvider } from '../src/panels/requestPanel';
import {
  MAX_WEBSOCKET_SESSION_EVENTS,
  WebSocketClient,
} from '../src/services/webSocketClient';

function makeEnvironmentService() {
  return {
    interpolate: (value: string, variables: Map<string, string>) =>
      value.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, name) => variables.get(name) ?? match),
    interpolateJson: (value: string, variables: Map<string, string>) =>
      value.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, name) => variables.get(name) ?? match),
    resolveVariables: vi.fn().mockResolvedValue(new Map()),
  } as any;
}

function activeSession(socket: any) {
  const now = new Date().toISOString();
  return {
    requestId: 'socket.yml',
    requestFilePath: 'socket.yml',
    requestName: 'Review socket',
    state: 'connected',
    socket,
    resolved: {
      url: 'wss://example.test/ws?sig=live-signature&mode=echo',
      headers: {},
      variables: new Map<string, string>(),
      secretProviders: [{ name: 'kv', type: 'azure-keyvault', namespace: 'example' }],
      message: { type: 'text', data: 'default' },
    },
    events: [],
    inboundCount: 0,
    outboundCount: 0,
    createdAt: now,
    updatedAt: now,
    closeWaiters: [],
  };
}

function makeProvider(): RequestEditorProvider {
  return new RequestEditorProvider(
    { extensionUri: { fsPath: process.cwd() } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

async function loadRequestPanel(): Promise<{ dom: JSDOM; messages: any[] }> {
  vi.resetModules();
  const body = (makeProvider() as any)._getBodyHtml({} as any) as string;
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: 'https://missio.test' });
  const messages: any[] = [];
  const win = dom.window as any;

  Object.assign(globalThis as any, {
    window: win,
    document: win.document,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLPreElement: win.HTMLPreElement,
    HTMLImageElement: win.HTMLImageElement,
    HTMLCanvasElement: win.HTMLCanvasElement,
    Event: win.Event,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    WheelEvent: win.WheelEvent,
    ClipboardEvent: win.ClipboardEvent,
    DOMParser: win.DOMParser,
    Image: win.Image,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    acquireVsCodeApi: () => ({
      postMessage: (message: unknown) => messages.push(message),
      getState: vi.fn(),
      setState: vi.fn(),
    }),
  });
  Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', { value: vi.fn(() => ({})), configurable: true });
  await import('../src/webview/requestPanel');
  return { dom, messages };
}

function dispatchPanelMessage(dom: JSDOM, data: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const key of [
    'window', 'document', 'Node', 'NodeFilter', 'HTMLElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLPreElement',
    'HTMLImageElement', 'HTMLCanvasElement', 'Event', 'KeyboardEvent', 'MouseEvent',
    'WheelEvent', 'ClipboardEvent', 'DOMParser', 'Image', 'requestAnimationFrame',
    'cancelAnimationFrame', 'acquireVsCodeApi',
  ]) {
    delete (globalThis as any)[key];
  }
});

describe('OC-140 review fixes', () => {
  it('redacts all model-visible WebSocket payload and URL credential channels', async () => {
    const session = {
      requestId: 'socket.yml',
      state: 'closed',
      url: 'wss://user:password@example.test/ws?sig=live-signature&mode=echo',
      events: [
        { timestamp: '2026-07-21T00:00:00.000Z', direction: 'outbound', type: 'json', data: '{"token":"live-token"}' },
        { timestamp: '2026-07-21T00:00:01.000Z', direction: 'inbound', type: 'text', data: 'live-token' },
        { timestamp: '2026-07-21T00:00:02.000Z', direction: 'event', type: 'close', reason: 'live-token' },
      ],
      inboundCount: 1,
      outboundCount: 1,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:02.000Z',
      lastError: 'Handshake failed for wss://example.test/ws?code=live-code',
    } as any;
    const response = {
      status: 101,
      statusText: 'WebSocket Session',
      headers: { 'x-missio-websocket-url': session.url },
      body: JSON.stringify({ events: session.events, url: session.url }),
      duration: 12,
      size: 500,
    };
    const execution = {
      getWebSocketSession: vi.fn().mockReturnValue(session),
      disconnectWebSocketSession: vi.fn().mockResolvedValue(response),
    } as any;
    const tool = new WebSocketSessionTool(
      { getCollections: () => [], getCollection: vi.fn() } as any,
      makeEnvironmentService(),
      execution,
    );
    const requestFilePath = path.resolve('socket.yml');

    const statusText = await tool.call({ input: { operation: 'status', requestFilePath } } as any, {} as any);
    const messagesText = await tool.call({ input: { operation: 'list-messages', requestFilePath } } as any, {} as any);
    const disconnectText = await tool.call({ input: { operation: 'disconnect', requestFilePath } } as any, {} as any);
    const combined = statusText + messagesText + disconnectText;

    expect(combined).not.toContain('live-token');
    expect(combined).not.toContain('live-signature');
    expect(combined).not.toContain('live-code');
    expect(combined).not.toContain('password');
    expect(JSON.parse(messagesText).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'outbound', data: '[redacted]' }),
      expect.objectContaining({ direction: 'inbound', data: '[redacted]' }),
      expect.objectContaining({ type: 'close', reason: '[redacted]' }),
    ]));
    expect(JSON.parse(disconnectText).response).toEqual({
      status: 101,
      statusText: 'WebSocket Session',
      duration: 12,
      size: 500,
    });
  });

  it('resolves secret references for editor-supplied messages and bounds retained history', async () => {
    const sentPayloads: unknown[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (payload: unknown, callback: (error?: Error) => void) => {
        sentPayloads.push(payload);
        callback();
      },
      close: vi.fn(),
    };
    const client = new WebSocketClient(makeEnvironmentService());
    client.setSecretService({
      resolveSecretReferences: vi.fn(async (value: string) => value.replace('$secret.kv.token', 'resolved-token')),
    } as any);
    (client as any)._sessions.set('socket.yml', activeSession(socket));

    await client.sendMessage('socket.yml', { type: 'json', data: '{"token":"$secret.kv.token"}' });
    expect(String(sentPayloads[0])).toContain('resolved-token');

    const internal = (client as any)._sessions.get('socket.yml');
    for (let index = 0; index < MAX_WEBSOCKET_SESSION_EVENTS + 25; index++) {
      (client as any)._recordEvent(internal, { direction: 'inbound', type: 'text', data: `message-${index}` });
    }
    const capped = client.getSession('socket.yml')!;
    expect(capped.events).toHaveLength(MAX_WEBSOCKET_SESSION_EVENTS);
    expect(capped.inboundCount).toBe(MAX_WEBSOCKET_SESSION_EVENTS + 25);
    expect(capped.events.at(-1)?.data).toBe(`message-${MAX_WEBSOCKET_SESSION_EVENTS + 24}`);

    const cleared = client.clearSessionEvents('socket.yml')!;
    expect(cleared.events).toEqual([]);
    expect(cleared.inboundCount).toBe(MAX_WEBSOCKET_SESSION_EVENTS + 25);
    client.dispose();
  });

  it('bounds retained terminal sessions', () => {
    const client = new WebSocketClient(makeEnvironmentService());
    for (let index = 0; index < 25; index++) {
      const session = {
        ...activeSession(undefined),
        requestId: `closed-${index}.yml`,
        state: 'closed',
        updatedAt: new Date(Date.UTC(2026, 6, 21, 0, 0, index)).toISOString(),
      };
      (client as any)._sessions.set(session.requestId, session);
      (client as any)._scheduleSessionEviction(session);
    }

    expect((client as any)._sessions.size).toBe(20);
    expect(client.getSession('closed-0.yml')).toBeUndefined();
    expect(client.getSession('closed-24.yml')).toBeDefined();
    client.dispose();
  });

  it('appends new history rows, clears host history, and disconnects Ctrl+Enter while connecting', async () => {
    const { dom, messages } = await loadRequestPanel();
    dispatchPanelMessage(dom, {
      type: 'requestLoaded',
      request: {
        info: { name: 'Socket', type: 'websocket' },
        websocket: { url: 'wss://example.test/ws', message: { type: 'text', data: 'ping' } },
      },
      filePath: 'socket.yml',
    });

    const firstEvent = { timestamp: '2026-07-21T00:00:00.000Z', direction: 'inbound', type: 'text', data: 'one' };
    dispatchPanelMessage(dom, {
      type: 'webSocketSession',
      session: { requestId: 'socket.yml', state: 'connected', events: [firstEvent], inboundCount: 1, outboundCount: 0 },
    });
    const firstRow = document.querySelector('.websocket-history-row');

    dispatchPanelMessage(dom, {
      type: 'webSocketSession',
      session: {
        requestId: 'socket.yml',
        state: 'connected',
        events: [firstEvent, { timestamp: '2026-07-21T00:00:01.000Z', direction: 'inbound', type: 'text', data: 'two' }],
        inboundCount: 2,
        outboundCount: 0,
      },
    });
    expect(document.querySelectorAll('.websocket-history-row')).toHaveLength(2);
    expect(document.querySelector('.websocket-history-row')).toBe(firstRow);

    (document.getElementById('wsClearHistoryBtn') as HTMLButtonElement).click();
    expect(messages).toContainEqual({ type: 'webSocketClearHistory' });
    expect(document.querySelectorAll('.websocket-history-row')).toHaveLength(0);

    dispatchPanelMessage(dom, { type: 'webSocketConnecting' });
    const beforeShortcut = messages.length;
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(messages.slice(beforeShortcut)).toContainEqual({ type: 'webSocketDisconnect' });
    expect(messages.slice(beforeShortcut)).not.toContainEqual(expect.objectContaining({ type: 'webSocketConnect' }));
  });

  it('clears retained history through the extension host', async () => {
    const session = {
      requestId: 'socket.yml',
      state: 'connected',
      events: [],
      inboundCount: 2,
      outboundCount: 1,
    };
    const execution = { clearWebSocketSessionHistory: vi.fn().mockReturnValue(session) };
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      execution as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const webview = { postMessage: vi.fn() };

    const handled = await (provider as any)._onMessage(
      webview,
      { type: 'webSocketClearHistory' },
      { document: { uri: { fsPath: 'socket.yml' } } },
    );

    expect(handled).toBe(true);
    expect(execution.clearWebSocketSessionHistory).toHaveBeenCalledWith('socket.yml');
    expect(webview.postMessage).toHaveBeenCalledWith({ type: 'webSocketSession', session });
  });

  it('disconnects the request session when its editor panel is disposed', () => {
    const execution = { disconnectWebSocketSession: vi.fn().mockResolvedValue(undefined) };
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      execution as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    (provider as any)._onPanelDisposed({ uri: { fsPath: 'socket.yml' } });

    expect(execution.disconnectWebSocketSession).toHaveBeenCalledWith('socket.yml', 'Missio editor closed');
  });
});
