import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { JSDOM } from 'jsdom';
import {
  applyRequestEditorModel,
  createRequestEditorModelFromRequest,
} from '../src/models/schemaRoundTrip';
import type { RequestProtocol } from '../src/models/types';
import { RequestEditorProvider } from '../src/panels/requestPanel';
import { MissioCodeLensProvider } from '../src/providers/codeLensProvider';

const schema = require('../schema/opencollectionschema.json');
const protocolRoots: RequestProtocol[] = ['http', 'graphql', 'websocket', 'grpc'];
const schemaByProtocol: Record<RequestProtocol, string> = {
  http: 'HttpRequest',
  graphql: 'GraphQLRequest',
  websocket: 'WebSocketRequest',
  grpc: 'GrpcRequest',
};

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

function requestForProtocol(protocol: RequestProtocol): any {
  if (protocol === 'graphql') {
    return {
      info: { name: 'GraphQL health', type: 'graphql' },
      graphql: {
        method: 'POST',
        url: '{{baseUrl}}/graphql',
        headers: [{ name: 'X-Trace', value: '{{traceId}}' }],
        body: { query: 'query Health { health { status } }', variables: '{"trace":"{{traceId}}"}' },
      },
      runtime: { scripts: [{ type: 'tests', code: 'test("ok", () => assert(true));' }] },
      settings: { timeout: 5000 },
    };
  }

  if (protocol === 'websocket') {
    return {
      info: { name: 'Socket echo', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/echo',
        headers: [{ name: 'X-Trace', value: '{{traceId}}' }],
        message: { type: 'json', data: '{"ping":true}' },
      },
      runtime: { scripts: [{ type: 'after-response', code: 'console.log("socket");' }] },
    };
  }

  if (protocol === 'grpc') {
    return {
      info: { name: 'gRPC echo', type: 'grpc' },
      grpc: {
        url: '{{grpcBaseUrl}}',
        method: 'missio.demo.DemoService/EchoUnary',
        methodType: 'unary',
        protoFilePath: 'proto/services/missio_demo.proto',
        metadata: [{ name: 'x-trace-id', value: '{{traceId}}' }],
        message: '{"name":"Ada","trace":{"requestId":"{{traceId}}"}}',
      },
      runtime: { scripts: [{ type: 'before-request', code: 'console.log("grpc");' }] },
    };
  }

  return {
    info: { name: 'HTTP health', type: 'http' },
    http: {
      method: 'GET',
      url: '{{baseUrl}}/health',
      headers: [{ name: 'Accept', value: 'application/json' }],
    },
    runtime: { scripts: [{ type: 'before-request', code: 'console.log("http");' }] },
    settings: { timeout: 5000 },
  };
}

function validateSubschema(protocol: RequestProtocol, data: unknown): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const defName = schemaByProtocol[protocol];
  const validate = ajv.compile({
    $schema: schema.$schema,
    $id: `${schema.$id}#test-oc130-${defName}`,
    $ref: `${schema.$id}#/$defs/${defName}`,
    $defs: schema.$defs,
  });
  expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function mountRequestPanelDom(): { dom: JSDOM; messages: unknown[] } {
  const body = (makeProvider() as any)._getBodyHtml({} as any) as string;
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: 'https://missio.test' });
  const messages: unknown[] = [];
  const win = dom.window as any;

  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  (globalThis as any).Node = win.Node;
  (globalThis as any).NodeFilter = win.NodeFilter;
  (globalThis as any).HTMLElement = win.HTMLElement;
  (globalThis as any).HTMLInputElement = win.HTMLInputElement;
  (globalThis as any).HTMLTextAreaElement = win.HTMLTextAreaElement;
  (globalThis as any).HTMLSelectElement = win.HTMLSelectElement;
  (globalThis as any).HTMLButtonElement = win.HTMLButtonElement;
  (globalThis as any).HTMLPreElement = win.HTMLPreElement;
  (globalThis as any).HTMLImageElement = win.HTMLImageElement;
  (globalThis as any).HTMLCanvasElement = win.HTMLCanvasElement;
  (globalThis as any).Event = win.Event;
  (globalThis as any).KeyboardEvent = win.KeyboardEvent;
  (globalThis as any).MouseEvent = win.MouseEvent;
  (globalThis as any).WheelEvent = win.WheelEvent;
  (globalThis as any).ClipboardEvent = win.ClipboardEvent;
  (globalThis as any).DOMParser = win.DOMParser;
  (globalThis as any).Image = win.Image;
  (globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0);
  (globalThis as any).cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle);
  (globalThis as any).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => messages.push(message),
    getState: vi.fn(),
    setState: vi.fn(),
  });
  Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', { value: vi.fn(() => ({})), configurable: true });
  return { dom, messages };
}

async function loadRequestPanel(): Promise<{ dom: JSDOM; messages: unknown[] }> {
  vi.resetModules();
  const mounted = mountRequestPanelDom();
  await import('../src/webview/requestPanel');
  return mounted;
}

function dispatchPanelMessage(dom: JSDOM, data: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

function messagesOfType(messages: unknown[], type: string, startIndex = 0): any[] {
  return messages.slice(startIndex).filter((message: any) => message?.type === type);
}

function dispatchMouseDown(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView!;
  element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
}

function dispatchMouseActivationSequence(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView!;
  element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  element.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  element.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function dispatchKeyboardActivation(element: HTMLElement, key: 'Enter' | ' '): void {
  const view = element.ownerDocument.defaultView!;
  element.dispatchEvent(new view.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const key of [
    'window',
    'document',
    'Node',
    'NodeFilter',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLButtonElement',
    'HTMLPreElement',
    'HTMLImageElement',
    'HTMLCanvasElement',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'WheelEvent',
    'ClipboardEvent',
    'DOMParser',
    'Image',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'acquireVsCodeApi',
  ]) {
    delete (globalThis as any)[key];
  }
});

describe('OC-130 request editor first paint', () => {
  it('renders a neutral startup shell instead of a visible HTTP default', () => {
    const html = (makeProvider() as any)._getBodyHtml({} as any) as string;

    expect(html).toContain('id="requestEditorShell"');
    expect(html).toContain('class="request-editor-shell is-hydrating"');
    expect(html).toContain('data-hydration-state="pending"');
    expect(html).toContain('data-protocol="pending"');
    expect(html).toContain('id="requestStartupShell"');
    expect(html).toContain('protocol-icon-pending');
    expect(html).toContain('aria-label="Request type loading"');
    expect(html).not.toContain('aria-label="HTTP request type"');
  });

  it('hides request controls during pending and invalid states while preserving layout dimensions', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'requestPanel.css'), 'utf8');

    expect(css).toMatch(/\.request-editor-shell\s*\{[\s\S]*height:\s*100vh;[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/);
    expect(css).toMatch(/\.request-editor-shell\.is-hydrating \.url-bar,[\s\S]*\.request-editor-shell\.is-invalid-yaml \.main-content\s*\{[\s\S]*visibility:\s*hidden;[\s\S]*pointer-events:\s*none;/);
    expect(css).toMatch(/\.request-startup-shell\s*\{[\s\S]*position:\s*absolute;[\s\S]*inset:\s*0;[\s\S]*display:\s*flex;/);
    expect(css).toMatch(/\.request-startup-card\s*\{[\s\S]*min-height:\s*44px;/);
    expect(css).toContain('.protocol-icon-pending');
  });

  it.each(protocolRoots)('hydrates directly to the %s request layout', async (protocol) => {
    const { dom, messages } = await loadRequestPanel();
    const request = requestForProtocol(protocol);

    expect(document.getElementById('requestEditorShell')?.dataset.hydrationState).toBe('pending');
    expect(document.getElementById('protocolIcon')?.className).toContain('protocol-icon-pending');
    expect(messages).toContainEqual({ type: 'ready' });

    dispatchPanelMessage(dom, { type: 'requestLoaded', request, filePath: `${protocol}.yml` });

    const shell = document.getElementById('requestEditorShell') as HTMLElement;
    const methodPicker = document.getElementById('methodPicker') as HTMLElement;
    const protocolIcon = document.getElementById('protocolIcon') as HTMLElement;
    const responseSection = document.getElementById('responseSection') as HTMLElement;
    const responseTabs = document.getElementById('respTabs') as HTMLElement;
    const responseBodyTab = document.querySelector<HTMLElement>('#respTabs [data-tab="resp-body"]');
    const runtimeTab = document.getElementById('respRuntimeTab') as HTMLElement;
    const bodyTab = document.querySelector<HTMLElement>('#reqTabs [data-tab="body"]');

    expect(shell.dataset.hydrationState).toBe('ready');
    expect(shell.dataset.protocol).toBe(protocol);
    expect(shell.classList.contains('is-hydrating')).toBe(false);
    expect((document.getElementById('requestStartupShell') as HTMLElement).style.display).toBe('none');
    expect(protocolIcon.dataset.protocol).toBe(protocol);
    expect(protocolIcon.className).toContain(`protocol-icon-${protocol}`);
    expect(protocolIcon.className).not.toContain('protocol-icon-pending');

    if (protocol === 'websocket' || protocol === 'grpc') {
      expect(methodPicker.style.display).toBe('none');
      expect(bodyTab?.textContent).toBe('Message');
      expect((document.querySelector('#reqTabs [data-tab="params"]') as HTMLElement).style.display).toBe('none');
      expect((document.querySelector('#reqTabs [data-tab="settings"]') as HTMLElement).style.display).toBe('none');
      expect((document.querySelector('#reqTabs [data-tab="export"]') as HTMLElement).style.display).toBe('none');
      expect(document.getElementById('sendBtn')?.textContent).toBe(protocol === 'grpc' ? 'Invoke' : 'Connect');
    } else {
      expect(methodPicker.style.display).toBe('');
      expect(bodyTab?.textContent).toBe('Body');
      expect((document.querySelector('#reqTabs [data-tab="params"]') as HTMLElement).style.display).toBe('');
    }

    if (protocol === 'graphql') {
      expect((document.getElementById('bodyTypePills') as HTMLElement).style.display).toBe('none');
      expect((document.getElementById('graphqlVariablesEditor') as HTMLElement).style.display).toBe('flex');
      expect((document.getElementById('method') as HTMLSelectElement).value).toBe('POST');
    }

    if (protocol === 'websocket') {
      const connectBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      const sendMessageBtn = document.getElementById('wsSendBtn') as HTMLButtonElement;

      expect(connectBtn.textContent).toBe('Connect');
      expect(connectBtn.className).toContain('ws-lifecycle-action');
      expect(connectBtn.className).not.toContain('ws-disconnect-state');
      expect(sendMessageBtn.textContent).toBe('Send');
      expect(sendMessageBtn.className).toContain('btn-primary');
      expect(document.getElementById('wsDisconnectBtn')).toBeNull();
      expect(responseSection.className).toContain('websocket-response-tabs');
      expect(responseSection.className).not.toContain('websocket-response-ledger-only');
      expect(responseTabs.style.display).toBe('flex');
      expect(responseBodyTab?.textContent).toBe('Messages');
      expect(runtimeTab.style.display).toBe('');
      expect(document.getElementById('webSocketSessionPanel')?.parentElement?.id).toBe('panel-resp-body');
      expect((document.getElementById('respEmpty') as HTMLElement).style.display).toBe('none');
      expect((document.getElementById('respBodyWrap') as HTMLElement).style.display).toBe('none');

      dispatchPanelMessage(dom, { type: 'webSocketConnecting' });
      expect(connectBtn.textContent).toBe('Disconnect');
      expect(connectBtn.className).toContain('ws-disconnect-state');

      dispatchPanelMessage(dom, {
        type: 'webSocketSession',
        session: {
          requestId: 'websocket.yml',
          state: 'connected',
          events: [{ timestamp: '2026-06-15T01:02:03.456Z', direction: 'inbound', type: 'text', data: 'hello' }],
          inboundCount: 1,
          outboundCount: 0,
        },
      });
      expect(connectBtn.textContent).toBe('Disconnect');
      expect(connectBtn.disabled).toBe(false);
      expect(document.querySelector('.websocket-history-time')?.textContent).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);

      const messageCount = messages.length;
      connectBtn.click();
      expect(messages.slice(messageCount)).toContainEqual({ type: 'webSocketDisconnect' });
    } else {
      expect(responseSection.className).not.toContain('websocket-response-tabs');
      expect(responseSection.className).not.toContain('websocket-response-ledger-only');
      expect(responseBodyTab?.textContent).toBe('Body');
      expect(runtimeTab.style.display).toBe('none');
    }
  });

  it('keeps the WebSocket Runtime tab visible before runtime results exist', async () => {
    const { dom } = await loadRequestPanel();
    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol('websocket'), filePath: 'websocket.yml' });

    const runtimeTab = document.getElementById('respRuntimeTab') as HTMLElement;
    const runtimeResults = document.getElementById('runtimeResults') as HTMLElement;
    expect(runtimeTab.style.display).toBe('');
    expect(runtimeResults.textContent).toBe('');

    dispatchPanelMessage(dom, {
      type: 'response',
      response: {
        status: 101,
        statusText: 'WebSocket Session',
        headers: { 'content-type': 'application/json', 'x-missio-protocol': 'websocket' },
        body: JSON.stringify({
          protocol: 'websocket',
          url: 'ws://example.test/socket',
          state: 'connected',
          messageCount: 1,
          events: [{ timestamp: '2026-06-15T01:02:03.789Z', direction: 'inbound', type: 'text', data: 'hello' }],
        }),
        duration: 12,
        size: 0,
      },
    });

    expect(document.getElementById('responseSection')?.className).toContain('websocket-response-tabs');
    expect(document.querySelector<HTMLElement>('#respTabs [data-tab="resp-body"]')?.textContent).toBe('Messages');
    expect(runtimeTab.style.display).toBe('');
    expect(runtimeResults.textContent).toBe('');
    expect((document.getElementById('webSocketHistory') as HTMLElement).textContent).toContain('hello');
    expect((document.getElementById('respEmpty') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('respBodyWrap') as HTMLElement).style.display).toBe('none');
  });

  it('renders WebSocket messages and runtime results in the existing response tabs', async () => {
    const { dom } = await loadRequestPanel();
    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol('websocket'), filePath: 'websocket.yml' });

    dispatchPanelMessage(dom, {
      type: 'response',
      response: {
        status: 101,
        statusText: 'WebSocket Session',
        headers: { 'content-type': 'application/json', 'x-missio-protocol': 'websocket' },
        body: JSON.stringify({
          protocol: 'websocket',
          url: 'ws://example.test/socket',
          state: 'closed',
          messageCount: 1,
          events: [
            { timestamp: '2026-06-15T01:02:03.456Z', direction: 'outbound', type: 'text', data: 'ping' },
            { timestamp: '2026-06-15T01:02:03.789Z', direction: 'inbound', type: 'text', data: 'hello' },
          ],
        }),
        runtime: {
          success: false,
          summary: { passed: 1, failed: 1, skipped: 0 },
          tests: [{ name: 'socket echoed', passed: true }],
          assertions: [{
            expression: 'res.body.message',
            operator: 'equals',
            expected: 'ok',
            actual: 'hello',
            passed: false,
            message: 'Expected hello equals ok',
          }],
          actions: [{ type: 'set-variable', phase: 'after-response', target: 'runtime.wsMessageCount', value: 1, passed: true }],
          variableMutations: [],
          logs: [{ phase: 'after-response', level: 'log', message: 'websocket after hello' }],
          errors: [],
        },
        duration: 12,
        size: 0,
      },
    });

    const responseSection = document.getElementById('responseSection') as HTMLElement;
    const responseTabs = document.getElementById('respTabs') as HTMLElement;
    const runtimeTab = document.getElementById('respRuntimeTab') as HTMLElement;
    const history = document.getElementById('webSocketHistory') as HTMLElement;
    const runtimeResults = document.getElementById('runtimeResults') as HTMLElement;

    expect(responseSection.className).toContain('websocket-response-tabs');
    expect(responseSection.className).not.toContain('websocket-response-ledger-only');
    expect(responseTabs.style.display).toBe('flex');
    expect(document.querySelector<HTMLElement>('#respTabs [data-tab="resp-body"]')?.textContent).toBe('Messages');
    expect((document.getElementById('panel-resp-body') as HTMLElement).className).toContain('active');
    expect(history.textContent).toContain('ping');
    expect(history.textContent).toContain('hello');
    expect((document.getElementById('respEmpty') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('respBodyWrap') as HTMLElement).style.display).toBe('none');
    expect(runtimeTab.style.display).toBe('');
    expect(runtimeResults.textContent).toContain('Assertions');
    expect(runtimeResults.textContent).toContain('Expected hello equals ok');
  });

  it.each(['http', 'graphql', 'grpc'] as RequestProtocol[])('restores normal response layout when switching from WebSocket to %s', async (protocol) => {
    const { dom } = await loadRequestPanel();
    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol('websocket'), filePath: 'websocket.yml' });
    dispatchPanelMessage(dom, {
      type: 'response',
      response: {
        status: 101,
        statusText: 'WebSocket Session',
        headers: { 'content-type': 'application/json', 'x-missio-protocol': 'websocket' },
        body: JSON.stringify({
          protocol: 'websocket',
          state: 'closed',
          events: [{ timestamp: '2026-06-15T01:02:03.789Z', direction: 'inbound', type: 'text', data: 'hello' }],
        }),
        duration: 12,
        size: 0,
      },
    });

    expect(document.getElementById('responseSection')?.className).toContain('websocket-response-tabs');
    expect((document.getElementById('respEmpty') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('respBodyWrap') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('respRuntimeTab') as HTMLElement).style.display).toBe('');

    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol(protocol), filePath: `${protocol}.yml` });

    expect(document.getElementById('responseSection')?.className).not.toContain('websocket-response-tabs');
    expect(document.querySelector<HTMLElement>('#respTabs [data-tab="resp-body"]')?.textContent).toBe('Body');
    expect((document.getElementById('respTabs') as HTMLElement).style.display).toBe('flex');
    expect((document.getElementById('respEmpty') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('respBodyWrap') as HTMLElement).style.display).toBe('block');
    expect((document.getElementById('respBinaryOverlay') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('respRuntimeTab') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('webSocketSessionPanel') as HTMLElement).style.display).toBe('none');
  });

  it('keeps invalid YAML in a neutral fallback instead of revealing HTTP controls', async () => {
    const { dom } = await loadRequestPanel();

    dispatchPanelMessage(dom, {
      type: 'requestLoadError',
      filePath: 'bad.yml',
      message: 'Nested mappings are not allowed in compact mappings',
    });

    const shell = document.getElementById('requestEditorShell') as HTMLElement;
    expect(shell.dataset.hydrationState).toBe('invalid');
    expect(shell.dataset.protocol).toBe('pending');
    expect(shell.classList.contains('is-invalid-yaml')).toBe(true);
    expect((document.getElementById('requestStartupShell') as HTMLElement).style.display).toBe('flex');
    expect(document.getElementById('requestStartupTitle')?.textContent).toBe('Request YAML could not be loaded');
    expect(document.getElementById('requestStartupDetail')?.textContent).toContain('Nested mappings');
    expect(document.getElementById('protocolIcon')?.className).toContain('protocol-icon-pending');
  });

  it('sends an explicit invalid-YAML fallback message from the extension host', () => {
    const messages: any[] = [];

    (makeProvider() as any)._sendDocumentToWebview(
      { postMessage: (message: unknown) => messages.push(message) },
      {
        uri: { fsPath: path.join(process.cwd(), 'bad.yml') },
        getText: () => 'info: { name: Bad, type: websocket\nwebsocket: { url: "wss://example.com" }',
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'requestLoadError',
      filePath: path.join(process.cwd(), 'bad.yml'),
    });
    expect(messages[0].message).toEqual(expect.any(String));
  });

  it('preserves protocol round trips and validation for request editor no-op saves', () => {
    for (const protocol of protocolRoots) {
      const request = requestForProtocol(protocol);
      const model = createRequestEditorModelFromRequest(request);
      const updated = applyRequestEditorModel(request, model);
      const roots = protocolRoots.filter(root => Object.prototype.hasOwnProperty.call(updated as object, root));

      expect(updated).toEqual(request);
      expect(parseYaml(stringifyYaml(updated, { lineWidth: 120 }))).toEqual(updated);
      expect(roots).toEqual([protocol]);
      if (protocol !== 'http') {
        expect((updated as any).http).toBeUndefined();
      }
      validateSubschema(protocol, updated);
    }
  });
});

describe('OC-170 request action first-click reliability', () => {
  it.each(['http', 'graphql', 'grpc'] as RequestProtocol[])('fires %s Send on the first mouse-down after hydration', async (protocol) => {
    const { dom, messages } = await loadRequestPanel();
    const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;

    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.getAttribute('aria-disabled')).toBe('true');
    expect(sendBtn.title).toBe('Request editor is loading');
    const pendingCount = messages.length;
    dispatchMouseDown(sendBtn);
    expect(messages).toHaveLength(pendingCount);

    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol(protocol), filePath: `${protocol}.yml` });

    expect(sendBtn.disabled).toBe(false);
    expect(sendBtn.hasAttribute('aria-disabled')).toBe(false);

    if (protocol === 'graphql') {
      (document.getElementById('bodyData') as HTMLTextAreaElement).value = 'query EditedFirstClick { health { status } }';
    }

    const beforeAction = messages.length;
    dispatchMouseDown(sendBtn);
    const sent = messagesOfType(messages, 'sendRequest', beforeAction);

    expect(sent).toHaveLength(1);
    expect(sent[0].request.info.type).toBe(protocol);
    if (protocol === 'graphql') {
      expect(sent[0].request.graphql.body.query).toBe('query EditedFirstClick { health { status } }');
    }
  });

  it('fires WebSocket Connect, Send Message, and Disconnect on first mouse-down actions', async () => {
    const { dom, messages } = await loadRequestPanel();
    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol('websocket'), filePath: 'websocket.yml' });

    const lifecycleBtn = document.getElementById('sendBtn') as HTMLButtonElement;
    const sendMessageBtn = document.getElementById('wsSendBtn') as HTMLButtonElement;

    expect(lifecycleBtn.disabled).toBe(false);
    expect(lifecycleBtn.textContent).toBe('Connect');
    expect(sendMessageBtn.disabled).toBe(true);
    expect(sendMessageBtn.getAttribute('aria-disabled')).toBe('true');

    let beforeAction = messages.length;
    dispatchMouseDown(lifecycleBtn);
    let posted = messagesOfType(messages, 'webSocketConnect', beforeAction);
    expect(posted).toHaveLength(1);
    expect(posted[0].request.info.type).toBe('websocket');

    dispatchPanelMessage(dom, {
      type: 'webSocketSession',
      session: {
        requestId: 'websocket.yml',
        state: 'connected',
        events: [],
        inboundCount: 0,
        outboundCount: 0,
      },
    });

    expect(lifecycleBtn.textContent).toBe('Disconnect');
    expect(lifecycleBtn.disabled).toBe(false);
    expect(sendMessageBtn.disabled).toBe(false);
    expect(sendMessageBtn.hasAttribute('aria-disabled')).toBe(false);

    beforeAction = messages.length;
    dispatchMouseDown(sendMessageBtn);
    posted = messagesOfType(messages, 'webSocketSendMessage', beforeAction);
    expect(posted).toHaveLength(1);
    expect(posted[0].request.info.type).toBe('websocket');

    beforeAction = messages.length;
    dispatchMouseDown(lifecycleBtn);
    posted = messagesOfType(messages, 'webSocketDisconnect', beforeAction);
    expect(posted).toHaveLength(1);
  });

  it('suppresses the click that follows a handled first mouse-down action', async () => {
    const { dom, messages } = await loadRequestPanel();
    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol('graphql'), filePath: 'graphql.yml' });

    const beforeAction = messages.length;
    dispatchMouseActivationSequence(document.getElementById('sendBtn') as HTMLButtonElement);
    expect(messagesOfType(messages, 'sendRequest', beforeAction)).toHaveLength(1);
  });

  it.each(['http', 'graphql', 'grpc'] as RequestProtocol[])('supports keyboard activation for %s Send', async (protocol) => {
    const { dom, messages } = await loadRequestPanel();
    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol(protocol), filePath: `${protocol}.yml` });

    const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
    let beforeAction = messages.length;
    dispatchKeyboardActivation(sendBtn, 'Enter');
    expect(messagesOfType(messages, 'sendRequest', beforeAction)).toHaveLength(1);

    beforeAction = messages.length;
    dispatchKeyboardActivation(sendBtn, ' ');
    expect(messagesOfType(messages, 'sendRequest', beforeAction)).toHaveLength(1);
  });

  it('supports keyboard activation for WebSocket lifecycle controls', async () => {
    const { dom, messages } = await loadRequestPanel();
    dispatchPanelMessage(dom, { type: 'requestLoaded', request: requestForProtocol('websocket'), filePath: 'websocket.yml' });

    const lifecycleBtn = document.getElementById('sendBtn') as HTMLButtonElement;
    const sendMessageBtn = document.getElementById('wsSendBtn') as HTMLButtonElement;

    let beforeAction = messages.length;
    dispatchKeyboardActivation(lifecycleBtn, 'Enter');
    expect(messagesOfType(messages, 'webSocketConnect', beforeAction)).toHaveLength(1);

    dispatchPanelMessage(dom, {
      type: 'webSocketSession',
      session: {
        requestId: 'websocket.yml',
        state: 'connected',
        events: [],
        inboundCount: 0,
        outboundCount: 0,
      },
    });

    beforeAction = messages.length;
    dispatchKeyboardActivation(sendMessageBtn, ' ');
    expect(messagesOfType(messages, 'webSocketSendMessage', beforeAction)).toHaveLength(1);

    beforeAction = messages.length;
    dispatchKeyboardActivation(lifecycleBtn, ' ');
    expect(messagesOfType(messages, 'webSocketDisconnect', beforeAction)).toHaveLength(1);
  });

  it('keeps command, editor toolbar, and CodeLens routes armed for every protocol', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const editorTitleSend = packageJson.contributes.menus['editor/title'].find((entry: any) => entry.command === 'missio.sendRequest');
    const provider = new MissioCodeLensProvider();

    expect(editorTitleSend).toMatchObject({
      command: 'missio.sendRequest',
      group: 'navigation',
    });

    for (const protocol of protocolRoots) {
      const request = requestForProtocol(protocol);
      const yaml = stringifyYaml(request, { lineWidth: 120 });
      const lenses = provider.provideCodeLenses({
        getText: () => yaml,
        uri: { fsPath: path.join(process.cwd(), `${protocol}.yml`) },
      } as any);
      const commandLens = lenses.find(lens => lens.command?.command);

      expect(commandLens?.command?.arguments).toEqual([path.join(process.cwd(), `${protocol}.yml`)]);
      if (protocol === 'websocket') {
        expect(lenses.map(lens => lens.command?.command).filter(Boolean)).toEqual([
          'missio.connectWebSocket',
          'missio.sendWebSocketMessage',
          'missio.disconnectWebSocket',
        ]);
      } else {
        expect(commandLens?.command?.command).toBe('missio.sendRequest');
      }
    }

    provider.dispose();
  });
});
