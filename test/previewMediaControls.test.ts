import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { configurePdfPreviewHtml, RequestEditorProvider } from '../src/panels/requestPanel';

type ResponseModule = typeof import('../src/webview/response');

function defer<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function flushMicrotasks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

async function loadResponseModule(): Promise<ResponseModule> {
  vi.resetModules();
  (globalThis as any).acquireVsCodeApi = () => ({
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
  });
  return import('../src/webview/response');
}

function mountResponseDom(): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="respLoading" style="display:none;"><span></span><span id="loadingTimer"></span></div>
    <div id="responseBar"></div>
    <div id="respTabs"><div class="tab" data-tab="resp-body"></div><div class="tab" data-tab="resp-preview" id="respPreviewTab"></div></div>
    <div id="respBodyWrap"></div>
    <div id="respEmpty"></div>
    <span id="statusBadge"></span>
    <button id="refreshOAuthRetryBtn"></button>
    <div id="respRuntimeTab"></div>
    <div id="runtimeResults"></div>
    <div id="respBinaryOverlay"></div>
    <div id="respBinaryInfo"></div>
    <div id="respLineNumbers"></div>
    <pre id="respBodyPre"></pre>
    <table><tbody id="respHeadersBody"></tbody></table>
    <span id="responseMeta"></span>
    <div class="response-section" id="responseSection">
      <div class="response-body">
        <div class="tab-panel" id="panel-resp-body"></div>
        <div class="tab-panel" id="panel-resp-preview">
          <div class="preview-media-bar" id="previewMediaBar" style="display:none;">
            <button id="previewZoomOutBtn"></button>
            <span id="previewZoomLabel"></span>
            <button id="previewZoomInBtn"></button>
            <button id="previewFitBtn"></button>
            <button id="previewResetBtn"></button>
            <button id="previewRotateLeftBtn"></button>
            <button id="previewRotateRightBtn"></button>
          </div>
          <iframe id="respPreviewFrame"></iframe>
          <div id="respImageContainer"></div>
          <div id="respPdfContainer"></div>
        </div>
      </div>
    </div>
  </body></html>`, { url: 'https://missio.test' });

  const win = dom.window as any;
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  (globalThis as any).NodeFilter = win.NodeFilter;
  (globalThis as any).HTMLElement = win.HTMLElement;
  (globalThis as any).HTMLImageElement = win.HTMLImageElement;
  (globalThis as any).HTMLIFrameElement = win.HTMLIFrameElement;
  (globalThis as any).HTMLCanvasElement = win.HTMLCanvasElement;
  (globalThis as any).WheelEvent = win.WheelEvent;
  (globalThis as any).Blob = win.Blob;
  (globalThis as any).URL = win.URL;
  (globalThis as any).atob = (value: string) => Buffer.from(value, 'base64').toString('binary');
  (globalThis as any).btoa = (value: string) => Buffer.from(value, 'binary').toString('base64');
  win.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({}));
  win.URL.createObjectURL = vi.fn(() => 'blob:preview');
  win.URL.revokeObjectURL = vi.fn();
  Object.defineProperty(win.document.getElementById('panel-resp-preview'), 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(win.document.getElementById('respPdfContainer'), 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(win.document.getElementById('respImageContainer'), 'clientWidth', { value: 800, configurable: true });
  return dom;
}

function getCspDirective(html: string, directiveName: string): string | undefined {
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
  return csp.split(';').map(part => part.trim()).find(part => part.startsWith(`${directiveName} `));
}

function imageResponse() {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'image/png' },
    body: '',
    bodyBase64: 'iVBORw0KGgo=',
    duration: 7,
    size: 8,
  };
}

function pdfResponse() {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/pdf' },
    body: '',
    bodyBase64: 'JVBERi0x',
    duration: 7,
    size: 8,
  };
}

function textResponse() {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    duration: 7,
    size: 11,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).acquireVsCodeApi;
});

describe('preview media transform helpers', () => {
  it('clamps zoom, resets, toggles fit, and normalizes rotation', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    const base = { zoom: 1, rotation: 0, fit: false };

    expect(response.clampMediaZoom(99)).toBe(5);
    expect(response.clampMediaZoom(0)).toBe(0.25);
    expect(response.normalizeMediaRotation(-90)).toBe(270);
    expect(response.applyMediaTransformAction(base, 'zoomIn')).toEqual({ zoom: 1.25, rotation: 0, fit: false });
    expect(response.applyMediaTransformAction(base, 'wheelZoomOut')).toEqual({ zoom: 0.9, rotation: 0, fit: false });
    expect(response.applyMediaTransformAction({ zoom: 2, rotation: 270, fit: true }, 'reset')).toEqual(base);
    expect(response.applyMediaTransformAction(base, 'fit')).toEqual({ zoom: 1, rotation: 0, fit: true });
    expect(response.applyMediaTransformAction(base, 'rotateLeft')).toEqual({ zoom: 1, rotation: 270, fit: false });
    expect(response.applyMediaTransformAction(base, 'rotateRight')).toEqual({ zoom: 1, rotation: 90, fit: false });
  });
});

describe('preview media toolbar markup', () => {
  it('renders compact media controls and preview containers in the request editor shell', () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const html = (provider as any)._getBodyHtml({} as any) as string;

    expect(html).toContain('id="previewMediaBar"');
    expect(html).toContain('id="previewZoomOutBtn"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('id="previewFitBtn"');
    expect(html).toContain('aria-label="Fit to width"');
    expect(html).toContain('id="previewRotateLeftBtn"');
    expect(html).toContain('codicon-debug-step-back');
    expect(html).toContain('codicon-debug-step-over');
    expect(html).not.toContain('codicon-discard');
    expect(html).not.toContain('codicon-redo');
    expect(html).not.toContain('codicon-arrow-left');
    expect(html).not.toContain('codicon-arrow-right');
    expect(html).toContain('id="respImageContainer"');
    expect(html).toContain('id="respPdfContainer"');
    expect(html).not.toContain('id="previewOverlay"');
  });

  it('defines toolbar, icon, image, PDF, and package asset surfaces', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'requestPanel.css'), 'utf8');
    const basePanel = fs.readFileSync(path.join(process.cwd(), 'src', 'panels', 'basePanel.ts'), 'utf8');
    const ignore = fs.readFileSync(path.join(process.cwd(), '.vscodeignore'), 'utf8');
    const esbuild = fs.readFileSync(path.join(process.cwd(), 'esbuild.js'), 'utf8');

    expect(css).toContain('.preview-media-bar');
    expect(css).toContain('.preview-media-btn');
    expect(css).toContain('.preview-image-frame');
    expect(css).toContain('.preview-pdf-container');
    for (const icon of ['zoom-in', 'zoom-out', 'screen-full', 'refresh', 'debug-step-back', 'debug-step-over']) {
      expect(basePanel).toContain(`.codicon-${icon}::before`);
    }
    expect(basePanel).not.toContain('.codicon-discard::before');
    expect(basePanel).not.toContain('.codicon-redo::before');
    expect(esbuild).toContain('pdf.min.mjs');
    expect(esbuild).toContain('pdf.worker.min.mjs');
    expect(ignore).not.toMatch(/^media\/pdf\.min\.mjs$/m);
    expect(ignore).not.toMatch(/^media\/pdf\.worker\.min\.mjs$/m);
    expect(fs.existsSync(path.join(process.cwd(), 'media', 'pdf.min.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'media', 'pdf.worker.min.mjs'))).toBe(true);
  });

  it('allows packaged PDF.js modules and workers in the request panel CSP', () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const webview = {
      cspSource: 'vscode-webview://missio-test',
      asWebviewUri: (uri: { fsPath: string }) => `webview-resource://${uri.fsPath.replace(/\\/g, '/')}`,
    };

    const html = (provider as any)._getHtml(webview) as string;
    const scriptDirective = getCspDirective(html, 'script-src');
    const workerDirective = getCspDirective(html, 'worker-src');

    expect(html).toContain('type="module"');
    expect(html).toContain('window.missioPdfJsReady');
    expect(html).toContain("import('webview-resource://");
    expect(html).toContain('pdf.min.mjs');
    expect(html).toContain('pdf.worker.min.mjs');
    expect(scriptDirective).toMatch(/^script-src 'nonce-[^']+' vscode-webview:\/\/missio-test$/);
    expect(workerDirective).toBe('worker-src vscode-webview://missio-test blob:');
  });

  it('fails loudly when the base CSP template no longer exposes required directives', () => {
    expect(() => configurePdfPreviewHtml(
      '<html><body></body></html>',
      '<script nonce="test"></script>',
      'vscode-webview://missio-test',
    )).toThrow('missing script-src nonce directive');
  });
});

describe('preview media controls in the response webview', () => {
  it('shows controls for image previews and applies button and Ctrl+wheel zoom', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    response.initPreviewMediaControls();

    response.showResponse(imageResponse());
    response.renderPreview();

    expect(document.getElementById('previewMediaBar')?.style.display).toBe('flex');
    expect(document.getElementById('previewZoomLabel')?.textContent).toBe('100%');
    expect(document.getElementById('respPreviewImage')).toBeTruthy();
    expect((document.getElementById('respPreviewImage') as HTMLImageElement).src).toContain('data:image/png;base64');
    const image = document.getElementById('respPreviewImage') as HTMLImageElement;
    const frame = document.getElementById('respImageFrame') as HTMLElement;
    expect(frame.style.visibility).toBe('hidden');
    expect(frame.style.width).toBe('');
    Object.defineProperty(image, 'complete', { value: true, configurable: true });
    Object.defineProperty(image, 'naturalWidth', { value: 640, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: 480, configurable: true });
    image.dispatchEvent(new window.Event('load'));
    expect(frame.style.visibility).toBe('visible');
    expect(frame.style.width).toBe('640px');

    document.getElementById('previewZoomInBtn')?.click();
    expect(response.getPreviewMediaTransform()).toMatchObject({ zoom: 1.25, rotation: 0, fit: false });
    expect(document.getElementById('previewZoomLabel')?.textContent).toBe('125%');

    const ordinaryWheel = new WheelEvent('wheel', { deltaY: -1, cancelable: true });
    document.getElementById('panel-resp-preview')?.dispatchEvent(ordinaryWheel);
    expect(ordinaryWheel.defaultPrevented).toBe(false);
    expect(response.getPreviewMediaTransform().zoom).toBe(1.25);

    const zoomWheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -1, cancelable: true });
    document.getElementById('panel-resp-preview')?.dispatchEvent(zoomWheel);
    expect(zoomWheel.defaultPrevented).toBe(true);
    expect(response.getPreviewMediaTransform().zoom).toBe(1.35);
  });

  it('rejects hostile image Content-Type values without creating injected markup', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    const hostile = imageResponse();
    hostile.headers['content-type'] = 'image/svg"><iframe src=data:text/html,<script>evil()</script>';

    response.showResponse(hostile);
    response.renderPreview();

    expect(response.getPreviewMediaKind(hostile.headers['content-type'], hostile)).toBe('none');
    expect(document.getElementById('respPreviewImage')).toBeNull();
    expect(document.querySelector('#respImageContainer iframe')).toBeNull();
    expect((document.getElementById('respPreviewFrame') as HTMLIFrameElement).style.display).toBe('block');
  });

  it('renders SVG data through an image property sink', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    const svg = {
      ...imageResponse(),
      headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
      body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>',
      bodyBase64: undefined,
    };

    response.showResponse(svg);
    response.renderPreview();

    const image = document.getElementById('respPreviewImage') as HTMLImageElement;
    expect(image).toBeTruthy();
    expect(image.src).toContain('data:image/svg+xml;charset=utf-8,');
    expect(document.querySelector('#respImageContainer iframe')).toBeNull();
  });

  it('resets and hides controls for new non-media responses and clear-response paths', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    response.initPreviewMediaControls();

    response.showResponse(imageResponse());
    response.renderPreview();
    document.getElementById('previewZoomInBtn')?.click();
    document.getElementById('previewRotateRightBtn')?.click();
    expect(response.getPreviewMediaTransform()).toMatchObject({ zoom: 1.25, rotation: 90 });

    response.showResponse(textResponse());
    response.renderPreview();
    expect(response.getPreviewMediaTransform()).toMatchObject({ zoom: 1, rotation: 0, fit: false });
    expect(document.getElementById('previewMediaBar')?.style.display).toBe('none');

    response.showResponse(imageResponse());
    response.renderPreview();
    expect(document.getElementById('previewMediaBar')?.style.display).toBe('flex');
    response.clearResponse();
    expect(response.getPreviewMediaTransform()).toMatchObject({ zoom: 1, rotation: 0, fit: false });
    expect(document.getElementById('previewMediaBar')?.style.display).toBe('none');
  });

  it('renders PDF pages with zoom, fit, and rotation through PDF.js', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    response.initPreviewMediaControls();

    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const page = {
      getViewport: vi.fn(({ scale, rotation = 0 }) => ({
        width: (rotation % 180 === 0 ? 400 : 600) * scale,
        height: (rotation % 180 === 0 ? 600 : 400) * scale,
      })),
      render: vi.fn(() => renderTask),
    };
    (window as any).pdfjsLib = {
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue(page) }),
      })),
    };

    response.showResponse(pdfResponse());
    response.renderPreview();
    await flushPromises();

    expect(document.getElementById('previewMediaBar')?.style.display).toBe('flex');
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 1, rotation: 0 });
    expect(document.querySelectorAll('#respPdfContainer canvas')).toHaveLength(1);

    document.getElementById('previewFitBtn')?.click();
    await flushPromises();
    expect(response.getPreviewMediaTransform().fit).toBe(true);
    expect(document.getElementById('previewZoomLabel')?.textContent).toBe('Fit 192%');

    document.getElementById('previewRotateRightBtn')?.click();
    await flushPromises();
    expect(response.getPreviewMediaTransform().rotation).toBe(90);
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 1, rotation: 90 });
  });

  it('coalesces repeated PDF toolbar zooms before rerendering', async () => {
    vi.useFakeTimers();
    mountResponseDom();
    const response = await loadResponseModule();
    response.initPreviewMediaControls();

    const page = {
      getViewport: vi.fn(({ scale, rotation = 0 }) => ({
        width: (rotation % 180 === 0 ? 400 : 600) * scale,
        height: (rotation % 180 === 0 ? 600 : 400) * scale,
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    };
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue(page) }),
      destroy: vi.fn(),
    }));
    (window as any).pdfjsLib = { getDocument };

    response.showResponse(pdfResponse());
    response.renderPreview();
    await flushMicrotasks();
    expect(getDocument).toHaveBeenCalledTimes(1);

    document.getElementById('previewZoomInBtn')?.click();
    document.getElementById('previewZoomInBtn')?.click();
    document.getElementById('previewZoomInBtn')?.click();
    expect(response.getPreviewMediaTransform().zoom).toBe(1.75);
    expect(getDocument).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(response.PDF_RENDER_DEBOUNCE_MS - 1);
    expect(getDocument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(getDocument).toHaveBeenCalledTimes(2);
  });

  it('caps large PDF canvas pixels while preserving visual zoom dimensions', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    const container = document.getElementById('respPdfContainer')!;

    const page = {
      getViewport: vi.fn(({ scale }) => ({ width: 5000 * scale, height: 4000 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    };
    const loadingTask = {
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue(page) }),
      destroy: vi.fn(),
    };
    (window as any).pdfjsLib = {
      getDocument: vi.fn(() => loadingTask),
    };

    await response.renderPdfPreview(container, 'JVBERi0x');

    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(response.PDF_MAX_CANVAS_PIXELS + 5000);
    expect(canvas.width).toBeLessThan(5000);
    expect(canvas.style.width).toBe('5000px');
    expect(canvas.style.height).toBe('4000px');
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it('renders PDF failures as text instead of HTML', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    const container = document.getElementById('respPdfContainer')!;
    (window as any).pdfjsLib = {
      getDocument: vi.fn(() => ({
        promise: Promise.reject(new Error('<img id="pdf-error-injection" src=x>')),
        destroy: vi.fn(),
      })),
    };

    await response.renderPdfPreview(container, 'JVBERi0x');

    expect(container.textContent).toContain('<img id="pdf-error-injection" src=x>');
    expect(document.getElementById('pdf-error-injection')).toBeNull();
  });

  it('cancels stale PDF renders and prevents old canvases from being appended', async () => {
    mountResponseDom();
    const response = await loadResponseModule();
    const container = document.getElementById('respPdfContainer')!;

    const firstRender = defer();
    const firstRenderTask = { promise: firstRender.promise, cancel: vi.fn() };
    const firstPage = {
      getViewport: vi.fn(({ scale }) => ({ width: 400 * scale, height: 600 * scale })),
      render: vi.fn(() => firstRenderTask),
    };
    const secondPage = {
      getViewport: vi.fn(({ scale }) => ({ width: 400 * scale, height: 600 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    };
    const firstLoadingTask = {
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue(firstPage) }),
      destroy: vi.fn(),
    };
    const secondLoadingTask = {
      promise: Promise.resolve({ numPages: 1, getPage: vi.fn().mockResolvedValue(secondPage) }),
      destroy: vi.fn(),
    };
    (window as any).pdfjsLib = {
      getDocument: vi.fn()
        .mockReturnValueOnce(firstLoadingTask)
        .mockReturnValueOnce(secondLoadingTask),
    };

    const oldRender = response.renderPdfPreview(container, 'JVBERi0x');
    await flushPromises();
    expect(firstPage.render).toHaveBeenCalledOnce();

    const newRender = response.renderPdfPreview(container, 'JVBERi0x');
    firstRender.resolve();
    await Promise.all([oldRender, newRender]);

    expect(firstRenderTask.cancel).toHaveBeenCalledOnce();
    expect(firstLoadingTask.destroy).toHaveBeenCalledOnce();
    expect(secondLoadingTask.destroy).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    expect(secondPage.render).toHaveBeenCalledOnce();
  });
});
