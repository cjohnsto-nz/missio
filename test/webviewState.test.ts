import { JSDOM } from 'jsdom';

describe('webview state HTML encoding', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', {
      value: () => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }),
      configurable: true,
    });
  });

  afterEach(() => {
    dom.window.close();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).acquireVsCodeApi;
    vi.resetModules();
  });

  it.each([
    'res.headers["content-type"]',
    '{"ok":true}',
    'A "quoted" description',
  ])('preserves %s through a double-quoted input value attribute', async (value) => {
    const { esc } = await import('../src/webview/state');
    const host = document.createElement('div');
    host.innerHTML = `<input value="${esc(value)}">`;

    expect(host.querySelector('input')?.value).toBe(value);
  });
});
