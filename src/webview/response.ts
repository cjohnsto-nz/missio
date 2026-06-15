// Response display logic for the webview.

import { $ } from './state';
import { highlightResponse } from './highlight';

export type ResponseSearchMatch = {
  line: number;
  start: number;
  end: number;
  index: number;
};

let lastResponse: any = null;
let lastResponseBody = '';
let lastContentType = '';
let lastResponseLines: string[] = [];
let lastResponseLowerLines: Array<string | undefined> = [];
let lastBlobUrl: string | undefined;
let loadingTimerInterval: ReturnType<typeof setInterval> | null = null;
let loadingStartTime = 0;

export type PreviewMediaKind = 'none' | 'image' | 'pdf';
export type PreviewMediaTransform = {
  zoom: number;
  rotation: number;
  fit: boolean;
};
export type PreviewMediaTransformAction =
  | 'zoomIn'
  | 'zoomOut'
  | 'wheelZoomIn'
  | 'wheelZoomOut'
  | 'reset'
  | 'fit'
  | 'rotateLeft'
  | 'rotateRight';

export const MEDIA_ZOOM_MIN = 0.25;
export const MEDIA_ZOOM_MAX = 5;
export const MEDIA_ZOOM_STEP = 0.25;
export const MEDIA_WHEEL_ZOOM_STEP = 0.1;
export const PDF_RENDER_DEBOUNCE_MS = 160;
export const PDF_MAX_RENDER_SCALE = 2.5;
export const PDF_MAX_CANVAS_PIXELS = 4_000_000;

type PdfLoadingTask = {
  promise: Promise<any>;
  destroy?: () => Promise<void> | void;
};

const DEFAULT_MEDIA_TRANSFORM: PreviewMediaTransform = {
  zoom: 1,
  rotation: 0,
  fit: false,
};

let mediaTransform: PreviewMediaTransform = { ...DEFAULT_MEDIA_TRANSFORM };
let mediaKind: PreviewMediaKind = 'none';
let mediaControlsInitialized = false;
let pdfRenderGeneration = 0;
let pdfRenderTimer: ReturnType<typeof setTimeout> | null = null;
const activePdfRenderTasks = new Set<{ cancel?: () => void }>();
const activePdfLoadingTasks = new Set<PdfLoadingTask>();

// Virtualized response rendering (for very large text responses)
let virtLines: string[] | null = null;
let virtLang = 'text';
let virtLineHeight = 18;
let virtLastStart = -1;
let virtLastEnd = -1;
let virtScrollerEl: HTMLElement | null = null;
let virtScrollHandler: (() => void) | null = null;
let virtRafPending = false;
let virtViewportHeight = 0;
let virtHighlightCache: Map<number, string> | null = null;
let virtHighlightCacheOrder: number[] | null = null;
let lastResponseLang = 'text';
let virtSearchMatchesByLine: Map<number, ResponseSearchMatch[]> | null = null;
let virtCurrentSearchIndex = -1;
let virtSearchRevision = 0;
let virtLastSearchRevision = -1;

const VIRT_MIN_CHARS = 1_000_000;
const VIRT_MIN_LINES = 20_000;
const VIRT_WINDOW_LINES = 1200;
const VIRT_OVERSCAN_LINES = 200;
const VIRT_CHECKPOINT_LINES = 100;
const VIRT_MAX_HIGHLIGHT_CACHE = 5000;

export function getLastResponse(): any { return lastResponse; }
export function getLastResponseBody(): string { return lastResponseBody; }
export function getLastContentType(): string { return lastContentType; }
export function getLastResponseLines(): readonly string[] { return lastResponseLines; }
export function getLastResponseLowerLine(index: number): string {
  const cached = lastResponseLowerLines[index];
  if (cached !== undefined) {
    return cached;
  }

  const computed = (lastResponseLines[index] ?? '').toLowerCase();
  lastResponseLowerLines[index] = computed;
  return computed;
}
export function isResponseVirtualized(): boolean { return virtLines !== null; }

function renderFullResponseLines(lines: string[]): void {
  $('respBodyPre').innerHTML = lines.map((line: string, idx: number) =>
    `<div class="code-line" data-line="${idx + 1}">` + getRenderedLineHtml(idx, line) + '</div>'
  ).join('');
}

type TextPosition = {
  node: Text;
  offset: number;
};

function findTextPosition(root: Node, targetOffset: number): TextPosition | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let traversed = 0;
  let textNode: Text | null;

  while ((textNode = walker.nextNode() as Text | null)) {
    const textLength = textNode.textContent?.length ?? 0;
    const nextTraversed = traversed + textLength;
    if (targetOffset <= nextTraversed) {
      return {
        node: textNode,
        offset: Math.min(targetOffset - traversed, textLength),
      };
    }
    traversed = nextTraversed;
  }

  return null;
}

function revealMatchHorizontally(): void {
  const current = document.querySelector('.resp-search-current');
  const codeWrap = document.querySelector('.resp-code-wrap') as HTMLElement | null;
  if (!(current instanceof HTMLElement) || !codeWrap) {
    return;
  }

  const markRect = current.getBoundingClientRect();
  const wrapRect = codeWrap.getBoundingClientRect();
  const horizontalPadding = 24;

  if (markRect.right > wrapRect.right - horizontalPadding) {
    codeWrap.scrollLeft += (markRect.right - wrapRect.right) + horizontalPadding;
  } else if (markRect.left < wrapRect.left + horizontalPadding) {
    codeWrap.scrollLeft -= (wrapRect.left - markRect.left) + horizontalPadding;
  }
}

function applySearchHighlights(html: string, lineMatches: ResponseSearchMatch[], currentIndex: number): string {
  if (lineMatches.length === 0) return html;

  const container = document.createElement('div');
  container.innerHTML = html;

  for (let index = lineMatches.length - 1; index >= 0; index--) {
    const match = lineMatches[index];
    const startPos = findTextPosition(container, match.start);
    const endPos = findTextPosition(container, match.end);
    if (!startPos || !endPos) {
      continue;
    }

    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    if (range.collapsed) {
      continue;
    }

    const mark = document.createElement('mark');
    mark.className = 'resp-search-match';
    if (match.index === currentIndex) {
      mark.classList.add('resp-search-current');
    }

    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  }

  return container.innerHTML;
}

/** Content types that support rich preview in a separate tab */
function isPreviewable(ct: string): boolean {
  const lower = ct.toLowerCase();
  return lower.includes('text/html')
    || lower.includes('application/xhtml')
    || lower.includes('application/pdf')
    || lower.startsWith('image/');
}

export function clampMediaZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_MEDIA_TRANSFORM.zoom;
  return Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, Math.round(zoom * 100) / 100));
}

export function normalizeMediaRotation(rotation: number): number {
  const normalized = rotation % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function applyMediaTransformAction(
  state: PreviewMediaTransform,
  action: PreviewMediaTransformAction,
): PreviewMediaTransform {
  switch (action) {
    case 'zoomIn':
      return { ...state, zoom: clampMediaZoom(state.zoom + MEDIA_ZOOM_STEP), fit: false };
    case 'zoomOut':
      return { ...state, zoom: clampMediaZoom(state.zoom - MEDIA_ZOOM_STEP), fit: false };
    case 'wheelZoomIn':
      return { ...state, zoom: clampMediaZoom(state.zoom + MEDIA_WHEEL_ZOOM_STEP), fit: false };
    case 'wheelZoomOut':
      return { ...state, zoom: clampMediaZoom(state.zoom - MEDIA_WHEEL_ZOOM_STEP), fit: false };
    case 'reset':
      return { ...DEFAULT_MEDIA_TRANSFORM };
    case 'fit':
      return { ...state, fit: true };
    case 'rotateLeft':
      return { ...state, rotation: normalizeMediaRotation(state.rotation - 90) };
    case 'rotateRight':
      return { ...state, rotation: normalizeMediaRotation(state.rotation + 90) };
    default:
      return state;
  }
}

export function getPreviewMediaKind(contentType: string, response: any): PreviewMediaKind {
  const lower = contentType.toLowerCase();
  if (lower.includes('application/pdf') && response?.bodyBase64) {
    return 'pdf';
  }
  if (lower.startsWith('image/') && (response?.bodyBase64 || (lower.startsWith('image/svg') && response?.body))) {
    return 'image';
  }
  return 'none';
}

export function getPreviewMediaTransform(): PreviewMediaTransform {
  return { ...mediaTransform };
}

function formatZoomLabel(zoom: number): string {
  return Math.round(clampMediaZoom(zoom) * 100) + '%';
}

function getMediaToolbarLabel(resolvedZoom?: number): string {
  const zoom = resolvedZoom ?? mediaTransform.zoom;
  return mediaTransform.fit ? `Fit ${formatZoomLabel(zoom)}` : formatZoomLabel(zoom);
}

function clearScheduledPdfRender(): void {
  if (pdfRenderTimer) {
    clearTimeout(pdfRenderTimer);
    pdfRenderTimer = null;
  }
}

function cancelActivePdfRenderTasks(): void {
  activePdfRenderTasks.forEach((task) => {
    try {
      task.cancel?.();
    } catch {
      // Best effort only; generation checks still prevent stale canvases.
    }
  });
  activePdfRenderTasks.clear();
}

function cancelActivePdfLoadingTasks(): void {
  const loadingTasks = Array.from(activePdfLoadingTasks);
  activePdfLoadingTasks.clear();
  loadingTasks.forEach((task) => {
    try {
      void task.destroy?.();
    } catch {
      // Best effort; generation checks still prevent stale canvases.
    }
  });
}

function invalidatePdfRender(): void {
  pdfRenderGeneration++;
  clearScheduledPdfRender();
  cancelActivePdfRenderTasks();
  cancelActivePdfLoadingTasks();
}

function beginPdfRender(): number {
  invalidatePdfRender();
  return pdfRenderGeneration;
}

export function isCurrentPdfRenderGeneration(generation: number): boolean {
  return generation === pdfRenderGeneration;
}

function updateMediaToolbar(resolvedZoom?: number): void {
  const toolbar = document.getElementById('previewMediaBar') as HTMLElement | null;
  const label = document.getElementById('previewZoomLabel') as HTMLElement | null;
  if (toolbar) {
    toolbar.style.display = mediaKind === 'none' ? 'none' : 'flex';
  }
  if (label) {
    label.textContent = getMediaToolbarLabel(resolvedZoom);
  }
}

function setMediaKind(kind: PreviewMediaKind): void {
  mediaKind = kind;
  updateMediaToolbar();
}

function resetPreviewMediaState(hideControls = true): void {
  mediaTransform = { ...DEFAULT_MEDIA_TRANSFORM };
  if (hideControls) {
    mediaKind = 'none';
  }
  invalidatePdfRender();
  updateMediaToolbar();
}

function getPreviewPanel(): HTMLElement | null {
  return document.getElementById('panel-resp-preview') as HTMLElement | null;
}

function getImageNaturalSize(img: HTMLImageElement): { width: number; height: number } {
  return {
    width: Math.max(1, img.naturalWidth || img.width || 1),
    height: Math.max(1, img.naturalHeight || img.height || 1),
  };
}

function getRotatedBox(width: number, height: number, rotation: number): { width: number; height: number } {
  const quarterTurn = normalizeMediaRotation(rotation) % 180 !== 0;
  return quarterTurn ? { width: height, height: width } : { width, height };
}

function getAvailablePreviewWidth(container: HTMLElement): number {
  const panel = getPreviewPanel();
  return Math.max(1, (panel?.clientWidth || container.clientWidth || 1) - 32);
}

export function getSafePdfRenderScale(width: number, height: number, requestedScale: number): number {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const maxAreaScale = Math.sqrt(PDF_MAX_CANVAS_PIXELS / (safeWidth * safeHeight));
  return Math.max(0.1, Math.min(requestedScale, PDF_MAX_RENDER_SCALE, maxAreaScale));
}

function resolveImageZoom(img: HTMLImageElement, frame: HTMLElement): number {
  if (!mediaTransform.fit) {
    return mediaTransform.zoom;
  }

  const natural = getImageNaturalSize(img);
  const rotated = getRotatedBox(natural.width, natural.height, mediaTransform.rotation);
  return clampMediaZoom(getAvailablePreviewWidth(frame) / rotated.width);
}

function applyImageTransform(): void {
  const frame = document.getElementById('respImageFrame') as HTMLElement | null;
  const img = document.getElementById('respPreviewImage') as HTMLImageElement | null;
  if (!frame || !img) return;

  const natural = getImageNaturalSize(img);
  const resolvedZoom = resolveImageZoom(img, frame);
  const rotated = getRotatedBox(natural.width, natural.height, mediaTransform.rotation);

  frame.style.width = Math.ceil(rotated.width * resolvedZoom) + 'px';
  frame.style.height = Math.ceil(rotated.height * resolvedZoom) + 'px';
  img.style.width = natural.width + 'px';
  img.style.height = natural.height + 'px';
  img.style.transform = `translate(-50%, -50%) rotate(${mediaTransform.rotation}deg) scale(${resolvedZoom})`;
  updateMediaToolbar(resolvedZoom);
}

function rerenderCurrentPreview(coalescePdf = false): void {
  if (mediaKind === 'image') {
    applyImageTransform();
    return;
  }

  if (mediaKind !== 'pdf') {
    updateMediaToolbar();
    return;
  }

  const resp = lastResponse;
  const pdfContainer = document.getElementById('respPdfContainer');
  if (!resp?.bodyBase64 || !pdfContainer) return;

  if (coalescePdf) {
    clearScheduledPdfRender();
    pdfRenderTimer = setTimeout(() => {
      pdfRenderTimer = null;
      void renderPdfPreview(pdfContainer, resp.bodyBase64);
    }, PDF_RENDER_DEBOUNCE_MS);
    return;
  }

  void renderPdfPreview(pdfContainer, resp.bodyBase64);
}

function applyPreviewMediaAction(action: PreviewMediaTransformAction, coalescePdf = false): void {
  if (mediaKind === 'none') return;
  mediaTransform = applyMediaTransformAction(mediaTransform, action);
  updateMediaToolbar();
  rerenderCurrentPreview(coalescePdf);
}

export function handlePreviewMediaWheel(event: WheelEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || mediaKind === 'none') {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  applyPreviewMediaAction(event.deltaY < 0 ? 'wheelZoomIn' : 'wheelZoomOut', true);
  return true;
}

export function initPreviewMediaControls(): void {
  if (mediaControlsInitialized) return;
  mediaControlsInitialized = true;

  document.getElementById('previewZoomOutBtn')?.addEventListener('click', () => applyPreviewMediaAction('zoomOut', true));
  document.getElementById('previewZoomInBtn')?.addEventListener('click', () => applyPreviewMediaAction('zoomIn', true));
  document.getElementById('previewResetBtn')?.addEventListener('click', () => applyPreviewMediaAction('reset'));
  document.getElementById('previewFitBtn')?.addEventListener('click', () => applyPreviewMediaAction('fit'));
  document.getElementById('previewRotateLeftBtn')?.addEventListener('click', () => applyPreviewMediaAction('rotateLeft'));
  document.getElementById('previewRotateRightBtn')?.addEventListener('click', () => applyPreviewMediaAction('rotateRight'));
  getPreviewPanel()?.addEventListener('wheel', handlePreviewMediaWheel, { passive: false });
  updateMediaToolbar();
}

export function showLoading(text?: string): void {
  $('respLoading').style.display = 'flex';
  if (text) setLoadingText(text);
  startLoadingTimer();
}

export function setLoadingText(text: string): void {
  const el = $('respLoading').querySelector('span');
  if (el) el.textContent = text;
}

export function hideLoading(): void {
  stopLoadingTimer();
  $('respLoading').style.display = 'none';
}

function startLoadingTimer(): void {
  stopLoadingTimer();
  loadingStartTime = Date.now();
  const el = document.getElementById('loadingTimer');
  if (el) el.textContent = '0.0s';
  loadingTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - loadingStartTime) / 1000;
    if (el) el.textContent = elapsed < 10 ? elapsed.toFixed(1) + 's' : elapsed.toFixed(0) + 's';
  }, 100);
}

function stopLoadingTimer(): void {
  if (loadingTimerInterval) {
    clearInterval(loadingTimerInterval);
    loadingTimerInterval = null;
  }
}

export function clearResponse(): void {
  resetPreviewMediaState();
  if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = undefined; }
  $('responseBar').style.display = 'none';
  $('respTabs').style.display = 'none';
  $('respBodyWrap').style.display = 'none';
  $('respEmpty').style.display = 'block';
  lastResponse = null;
  lastResponseBody = '';
  lastContentType = '';
  lastResponseLines = [];
  lastResponseLowerLines = [];
  lastResponseLang = 'text';

  // Clear virtualization state
  teardownVirtualization();
}

function teardownVirtualization(): void {
  virtLines = null;
  virtLang = 'text';
  virtLastStart = -1;
  virtLastEnd = -1;
  virtRafPending = false;
  virtHighlightCache = null;
  virtHighlightCacheOrder = null;
  virtSearchMatchesByLine = null;
  virtCurrentSearchIndex = -1;
  virtSearchRevision = 0;
  virtLastSearchRevision = -1;
  if (virtScrollerEl && virtScrollHandler) {
    virtScrollerEl.removeEventListener('scroll', virtScrollHandler);
  }
  virtScrollerEl = null;
  virtScrollHandler = null;
  const pre = document.getElementById('respBodyPre');
  if (pre) pre.classList.remove('virtualized');
}

function measureLineHeight(lang: string): number {
  const pre = document.getElementById('respBodyPre');
  if (!pre) return 18;

  const probe = document.createElement('div');
  probe.className = 'code-line';
  probe.style.visibility = 'hidden';
  probe.style.position = 'absolute';
  probe.style.top = '0';
  probe.style.left = '0';
  probe.innerHTML = highlightResponse('X', lang);
  pre.appendChild(probe);
  const h = Math.max(14, Math.round(probe.getBoundingClientRect().height));
  probe.remove();
  return h;
}

function getVirtHighlightedLine(idx: number, line: string): string {
  const highlightLang = virtLines ? virtLang : lastResponseLang;

  if (!virtHighlightCache || !virtHighlightCacheOrder) {
    return highlightResponse(line, highlightLang);
  }

  const cached = virtHighlightCache.get(idx);
  if (cached !== undefined) return cached;

  const v = highlightResponse(line, highlightLang);
  virtHighlightCache.set(idx, v);
  virtHighlightCacheOrder.push(idx);
  if (virtHighlightCacheOrder.length > VIRT_MAX_HIGHLIGHT_CACHE) {
    const evict = virtHighlightCacheOrder.shift();
    if (evict !== undefined) virtHighlightCache.delete(evict);
  }
  return v;
}

function getRenderedLineHtml(idx: number, line: string): string {
  const base = getVirtHighlightedLine(idx, line);
  const lineMatches = virtSearchMatchesByLine?.get(idx);
  if (!lineMatches || lineMatches.length === 0) {
    return base;
  }
  return applySearchHighlights(base, lineMatches, virtCurrentSearchIndex);
}

function getLineForMatchIndex(
  matchesByLine: Map<number, ResponseSearchMatch[]> | null,
  currentIndex: number,
): number | null {
  if (!matchesByLine || currentIndex < 0) return null;

  for (const [lineIndex, matches] of matchesByLine) {
    if (matches.some((match) => match.index === currentIndex)) {
      return lineIndex;
    }
  }

  return null;
}

function haveSameMatchLayout(
  prevMatchesByLine: Map<number, ResponseSearchMatch[]> | null,
  nextMatchesByLine: Map<number, ResponseSearchMatch[]>,
): boolean {
  if (!prevMatchesByLine || prevMatchesByLine.size !== nextMatchesByLine.size) {
    return false;
  }

  for (const [lineIndex, nextMatches] of nextMatchesByLine) {
    const prevMatches = prevMatchesByLine.get(lineIndex);
    if (!prevMatches || prevMatches.length !== nextMatches.length) {
      return false;
    }

    for (let idx = 0; idx < nextMatches.length; idx++) {
      const prevMatch = prevMatches[idx];
      const nextMatch = nextMatches[idx];
      if (
        prevMatch.index !== nextMatch.index
        || prevMatch.start !== nextMatch.start
        || prevMatch.end !== nextMatch.end
      ) {
        return false;
      }
    }
  }

  return true;
}

function rerenderNonVirtualizedLines(lineIndices: Iterable<number>): void {
  for (const lineIndex of lineIndices) {
    const lineEl = document.querySelector(`.code-line[data-line="${lineIndex + 1}"]`);
    if (!(lineEl instanceof HTMLElement)) {
      continue;
    }

    lineEl.innerHTML = getRenderedLineHtml(lineIndex, lastResponseLines[lineIndex] ?? '');
  }
}

function renderVirtualized(scrollTop: number): void {
  if (!virtLines) return;

  const pre = document.getElementById('respBodyPre') as HTMLElement | null;
  if (!pre) return;

  const total = virtLines.length;
  const viewportLines = Math.max(1, Math.floor(virtViewportHeight / virtLineHeight));
  const firstVisible = Math.floor(scrollTop / virtLineHeight);

  // Checkpointed/quantized virtualization:
  // Don't shift the virtual window for every scroll tick. Instead, move it in
  // larger jumps so scroll remains smooth even with highlighting enabled.
  const firstVisibleCheckpoint = Math.floor(firstVisible / VIRT_CHECKPOINT_LINES) * VIRT_CHECKPOINT_LINES;
  const start = Math.max(0, firstVisibleCheckpoint - VIRT_OVERSCAN_LINES);
  const end = Math.min(total, start + Math.max(VIRT_WINDOW_LINES, viewportLines + (VIRT_OVERSCAN_LINES * 2)));

  if (start === virtLastStart && end === virtLastEnd && virtSearchRevision === virtLastSearchRevision) return;
  virtLastStart = start;
  virtLastEnd = end;
  virtLastSearchRevision = virtSearchRevision;

  const slice = virtLines.slice(start, end);
  const topOffsetPx = start * virtLineHeight;
  const canvasHeightPx = total * virtLineHeight;

  const linesHtml = slice.map((line: string, idx: number) => {
    const absIdx = start + idx;
    return `<span class="code-line" data-line="${absIdx + 1}">` + getRenderedLineHtml(absIdx, line) + `</span>`;
  }).join('');

  // Use a fixed-height canvas to ensure correct scroll range, and position
  // the visible line window at the correct offset.
  pre.innerHTML =
    `<span class="resp-virt-canvas" style="height:${canvasHeightPx}px">` +
    `<span class="resp-virt-lines" style="transform: translateY(${topOffsetPx}px)">` +
    linesHtml +
    `</span>` +
    `</span>`;
}

function setupVirtualization(lines: string[], lang: string): void {
  teardownVirtualization();
  virtLines = lines;
  virtLang = lang;
  virtHighlightCache = new Map();
  virtHighlightCacheOrder = [];
  const pre = document.getElementById('respBodyPre');
  if (pre) pre.classList.add('virtualized');

  virtLineHeight = measureLineHeight(lang);

  // .response-body is the actual scroll container (not .resp-code-wrap which
  // grows to full content height due to unconstrained flex ancestors).
  const scroller = document.querySelector('.response-body') as HTMLElement | null;
  if (!scroller) {
    console.warn('[Missio] .response-body not found!');
    return;
  }
  virtScrollerEl = scroller;
  // Cache viewport height BEFORE setting tall innerHTML (cheap reflow on empty element)
  virtViewportHeight = scroller.clientHeight;

  // Initial render
  renderVirtualized(0);

  // Scroll event: schedule one rAF to render. Only reads scrollTop.
  virtScrollHandler = () => {
    if (virtRafPending) return;
    virtRafPending = true;
    requestAnimationFrame(() => {
      virtRafPending = false;
      if (virtLines && virtScrollerEl) {
        renderVirtualized(virtScrollerEl.scrollTop);
      }
    });
  };
  scroller.addEventListener('scroll', virtScrollHandler, { passive: true });
}

export function setVirtualizedResponseSearch(matches: ResponseSearchMatch[], currentIndex: number): void {
  const prevMatchesByLine = virtSearchMatchesByLine;
  const prevCurrentIndex = virtCurrentSearchIndex;
  const byLine = new Map<number, ResponseSearchMatch[]>();
  for (const match of matches) {
    const existing = byLine.get(match.line);
    if (existing) existing.push(match);
    else byLine.set(match.line, [match]);
  }

  virtSearchMatchesByLine = byLine;
  virtCurrentSearchIndex = currentIndex;
  virtSearchRevision++;
  if (virtLines) {
    renderVirtualized(virtScrollerEl?.scrollTop ?? 0);
    return;
  }

  const linesToUpdate = new Set<number>();
  if (!haveSameMatchLayout(prevMatchesByLine, byLine)) {
    prevMatchesByLine?.forEach((_, lineIndex) => linesToUpdate.add(lineIndex));
    byLine.forEach((_, lineIndex) => linesToUpdate.add(lineIndex));
  }

  const prevCurrentLine = getLineForMatchIndex(prevMatchesByLine, prevCurrentIndex);
  const currentLine = getLineForMatchIndex(byLine, currentIndex);
  if (prevCurrentLine !== null) linesToUpdate.add(prevCurrentLine);
  if (currentLine !== null) linesToUpdate.add(currentLine);

  rerenderNonVirtualizedLines(linesToUpdate);
}

export function clearVirtualizedResponseSearch(): void {
  if (!virtLines && !virtSearchMatchesByLine) return;
  const prevMatchesByLine = virtSearchMatchesByLine;
  virtSearchMatchesByLine = null;
  virtCurrentSearchIndex = -1;
  virtSearchRevision++;
  if (virtLines) {
    renderVirtualized(virtScrollerEl?.scrollTop ?? 0);
    return;
  }

  if (lastResponseLines.length > 0) {
    rerenderNonVirtualizedLines(prevMatchesByLine?.keys() ?? []);
  }
}

export function revealVirtualizedResponseSearchMatch(match: ResponseSearchMatch): void {
  if (!virtLines || !virtScrollerEl) {
    const activeLine = document.querySelector(`.code-line[data-line="${match.line + 1}"] .resp-search-current`);
    const fallbackLine = document.querySelector(`.code-line[data-line="${match.line + 1}"]`);
    const target = activeLine instanceof HTMLElement ? activeLine : fallbackLine;
    if (target instanceof HTMLElement) {
      target.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      requestAnimationFrame(() => {
        revealMatchHorizontally();
      });
    }
    return;
  }

  const centeredTop = Math.max(0, (match.line * virtLineHeight) - Math.max(0, (virtViewportHeight - virtLineHeight) / 2));
  virtScrollerEl.scrollTop = centeredTop;
  renderVirtualized(centeredTop);

  requestAnimationFrame(() => {
    revealMatchHorizontally();
  });
}

function updateRespLineNumbers(): void {
  // Line numbers are now rendered via CSS counter on .code-line::before
  // No JS measurement needed; gutter is part of each line element.
  $('respLineNumbers').style.display = 'none';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

type TimingEntry = { label: string; start: number; end: number };

export function showResponse(resp: any, preRequestMs?: number, timing?: TimingEntry[], usedOAuth2?: boolean): void {
  const renderStart = Date.now();
  hideLoading();
  resetPreviewMediaState();
  // Reset virtualization for new response
  teardownVirtualization();
  // Invalidate previous preview content
  const iframe = document.getElementById('respPreviewFrame') as HTMLIFrameElement | null;
  if (iframe) { iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc'); iframe.style.display = 'none'; }
  const imageContainer = document.getElementById('respImageContainer');
  if (imageContainer) { imageContainer.innerHTML = ''; imageContainer.style.display = 'none'; }
  const pdfContainer = document.getElementById('respPdfContainer');
  if (pdfContainer) { pdfContainer.innerHTML = ''; pdfContainer.style.display = 'none'; }
  if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = undefined; }
  lastResponse = resp;
  $('responseBar').style.display = 'flex';
  $('respTabs').style.display = 'flex';
  $('respEmpty').style.display = 'none';
  $('respBodyWrap').style.display = 'block';

  const badge = $('statusBadge');
  badge.textContent = resp.status + ' ' + resp.statusText;
  const cat = Math.floor(resp.status / 100);
  badge.className = 'status-badge s' + cat + 'xx';

  // Show "Refresh OAuth & Retry" button on 4xx when OAuth2 was used
  const oauthRetryBtn = document.getElementById('refreshOAuthRetryBtn');
  if (oauthRetryBtn) {
    oauthRetryBtn.style.display = (cat === 4 && usedOAuth2) ? '' : 'none';
  }

  // Body: detect language from content-type and apply highlighting.
  let bodyText = resp.body || '';
  let ct = '';
  if (resp.headers) {
    for (const k of Object.keys(resp.headers)) {
      if (k.toLowerCase() === 'content-type') { ct = resp.headers[k]; break; }
    }
  }
  let lang = 'text';
  if (ct.includes('json')) {
    lang = 'json';
    try { bodyText = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* keep raw */ }
  } else if (ct.includes('xml')) {
    lang = 'xml';
  } else if (ct.includes('html')) {
    lang = 'html';
  }

  const isBinary = !!resp.bodyBase64;
  lastResponseBody = bodyText;
  lastContentType = ct;
  lastResponseLines = isBinary ? [] : bodyText.split('\n');
  lastResponseLowerLines = [];
  lastResponseLang = lang;

  // Show/hide Preview tab for previewable content types
  const previewTab = document.getElementById('respPreviewTab');
  if (previewTab) {
    previewTab.style.display = isPreviewable(ct) ? '' : 'none';
  }

  const runtimeTab = document.getElementById('respRuntimeTab');
  const runtimePanel = document.getElementById('runtimeResults');
  if (runtimeTab && runtimePanel) {
    const hasRuntime = !!resp.runtime;
    runtimeTab.style.display = hasRuntime ? '' : 'none';
    runtimePanel.innerHTML = hasRuntime ? renderRuntimeResults(resp.runtime) : '';
    if (!hasRuntime && runtimeTab.classList.contains('active')) {
      (document.querySelector('#respTabs [data-tab="resp-body"]') as HTMLElement | null)?.click();
    }
  }

  // Auto-switch to Preview tab for images and PDFs (not HTML)
  const autoPreview = ct.toLowerCase().startsWith('image/') || ct.toLowerCase().includes('application/pdf');
  // Also render preview if user is already on the Preview tab
  const previewActive = previewTab?.classList.contains('active');
  if (autoPreview && previewTab) {
    setTimeout(() => { (previewTab as HTMLElement).click(); }, 0);
  } else if (previewActive && isPreviewable(ct)) {
    setTimeout(() => renderPreview(), 0);
  }

  // Binary content: show overlay instead of raw body
  const binaryOverlay = document.getElementById('respBinaryOverlay');
  const bodyWrap = document.getElementById('respBodyWrap');
  if (binaryOverlay && bodyWrap) {
    if (isBinary) {
      const sizeKB = resp.size < 1024 ? resp.size + ' B' : (resp.size / 1024).toFixed(1) + ' KB';
      const infoEl = document.getElementById('respBinaryInfo');
      if (infoEl) infoEl.textContent = ct + ' \u2022 ' + sizeKB;
      binaryOverlay.style.display = 'block';
      bodyWrap.style.display = 'none';
    } else {
      binaryOverlay.style.display = 'none';
      bodyWrap.style.display = 'block';
    }
  }

  const renderTiming: TimingEntry[] = [];
  const rBase = timing && timing.length > 0 ? timing[timing.length - 1].end : 0;
  const lastRenderEnd = (): number => (renderTiming.length > 0 ? renderTiming[renderTiming.length - 1].end : rBase);

  let rPhase = Date.now();
  const lines = lastResponseLines;
  const splitEnd = Date.now();
  if (!isBinary) {
    renderTiming.push({ label: 'Split Lines', start: rBase, end: rBase + (splitEnd - rPhase) });
  }

  rPhase = splitEnd;

  const useVirtual = !isBinary && (bodyText.length >= VIRT_MIN_CHARS || lines.length >= VIRT_MIN_LINES);
  if (useVirtual) {
    const vStart = Date.now();
    setupVirtualization(lines, lang);
    const vEnd = Date.now();
    const lastEnd = lastRenderEnd();
    renderTiming.push({ label: 'Virtualize', start: lastEnd, end: lastEnd + (vEnd - vStart) });
  } else {
    {
      const lastEnd = lastRenderEnd();
      renderTiming.push({ label: 'Highlight', start: lastEnd, end: lastEnd + (Date.now() - rPhase) });
    }

    rPhase = Date.now();
    renderFullResponseLines(lines);
    {
      const lastEnd = lastRenderEnd();
      renderTiming.push({ label: 'DOM Update', start: lastEnd, end: lastEnd + (Date.now() - rPhase) });
    }
  }

  rPhase = Date.now();
  updateRespLineNumbers();
  renderTiming.push({ label: 'Line Numbers', start: lastRenderEnd(), end: rBase + (Date.now() - renderStart) });

  // Headers
  rPhase = Date.now();
  const tbody = $('respHeadersBody');
  tbody.innerHTML = '';
  if (resp.headers) {
    Object.entries(resp.headers).forEach(([k, v]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(k) + '</td><td>' + esc(String(v)) + '</td>';
      tbody.appendChild(tr);
    });
  }
  renderTiming.push({ label: 'Headers', start: lastRenderEnd(), end: rBase + (Date.now() - renderStart) });

  // Timing display
  const renderMs = Date.now() - renderStart;
  let meta = resp.duration + 'ms';
  if (preRequestMs !== undefined) {
    meta = preRequestMs + 'ms pre \u2022 ' + resp.duration + 'ms response \u2022 ' + renderMs + 'ms render';
  }
  const metaEl = $('responseMeta');
  let metaText = meta + ' \u2022 ' + formatSize(resp.size);
  if (resp.stream?.protocol === 'grpc') {
    metaText += ` \u2022 ${resp.stream.sentMessageCount ?? 0} sent \u2022 ${resp.stream.receivedMessageCount ?? 0} received`;
  }
  metaEl.innerHTML = esc(metaText) + (useVirtual ? ' <span class="resp-virt-notice">Large response was virtualized</span>' : '');

  // Remove old tooltip
  const old = document.getElementById('timingTooltip');
  if (old) old.remove();
  metaEl.classList.remove('has-timing');

  // Build waterfall tooltip
  const allTiming = [...(timing ?? []), ...renderTiming];
  if (allTiming.length > 0) {
    const totalMs = allTiming[allTiming.length - 1].end;

    const tooltip = document.createElement('div');
    tooltip.id = 'timingTooltip';
    tooltip.className = 'timing-tooltip';

    const colors: Record<string, string> = {
      'OAuth2 Resolve': '#e8a838',
      'OAuth2 Token': '#e87838',
      'Resolve Variables': '#5b9bd5',
      'Interpolate + Params': '#7bc67e',
      'Auth': '#c678dd',
      'Body': '#56b6c2',
      'Secrets': '#d19a66',
      'HTTP': '#61afef',
      'Split Lines': '#8a8a8a',
      'Highlight': '#98c379',
      'Virtualize': '#e06c75',
      'DOM Update': '#e06c75',
      'Line Numbers': '#c678dd',
      'Headers': '#56b6c2',
    };

    for (const t of allTiming) {
      const dur = t.end - t.start;
      if (dur < 1 && t.label !== 'HTTP') continue;
      const pctLeft = totalMs > 0 ? (t.start / totalMs) * 100 : 0;
      const pctWidth = totalMs > 0 ? Math.max((dur / totalMs) * 100, 1) : 0;
      const color = colors[t.label] || '#888';

      const row = document.createElement('div');
      row.className = 'timing-row';

      const label = document.createElement('span');
      label.className = 'timing-label';
      label.textContent = t.label;

      const track = document.createElement('div');
      track.className = 'timing-track';

      const bar = document.createElement('div');
      bar.className = 'timing-bar';
      bar.style.left = pctLeft + '%';
      bar.style.width = pctWidth + '%';
      bar.style.background = color;

      const durLabel = document.createElement('span');
      durLabel.className = 'timing-dur';
      durLabel.textContent = dur + 'ms';

      track.appendChild(bar);
      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(durLabel);
      tooltip.appendChild(row);
    }

    // Total row
    const totalRow = document.createElement('div');
    totalRow.className = 'timing-row timing-total';
    totalRow.innerHTML = '<span class="timing-label">Total</span><div class="timing-track"></div><span class="timing-dur">' + totalMs + 'ms</span>';
    tooltip.appendChild(totalRow);

    // Append to body so overflow:hidden doesn't clip it
    document.body.appendChild(tooltip);
    metaEl.classList.add('has-timing');

    // Position on hover using fixed positioning
    metaEl.onmouseenter = () => {
      const rect = metaEl.getBoundingClientRect();
      tooltip.style.display = 'block';
      tooltip.style.position = 'fixed';
      tooltip.style.left = Math.max(0, rect.right - tooltip.offsetWidth) + 'px';
      tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
    };
    metaEl.onmouseleave = () => {
      tooltip.style.display = 'none';
    };
  }
}

function renderRuntimeResults(runtime: any): string {
  const summary = runtime.summary ?? { passed: 0, failed: 0, skipped: 0 };
  const statusClass = runtime.success ? 'runtime-ok' : 'runtime-fail';
  const sections = [
    `<div class="runtime-summary ${statusClass}">` +
      `<span>${runtime.success ? 'Passed' : 'Failed'}</span>` +
      `<span>${summary.passed ?? 0} passed</span>` +
      `<span>${summary.failed ?? 0} failed</span>` +
      `<span>${summary.skipped ?? 0} skipped</span>` +
    `</div>`,
  ];

  sections.push(renderRuntimeTable('Tests', ['Result', 'Name', 'Message'], runtime.tests ?? [], (test: any) => [
    runtimeStateCell(test.passed, test.skipped),
    esc(String(test.name ?? '')),
    esc(String(test.message ?? '')),
  ]));

  sections.push(renderRuntimeTable('Assertions', ['Result', 'Expression', 'Expected', 'Actual'], runtime.assertions ?? [], (assertion: any) => [
    runtimeStateCell(assertion.passed, assertion.skipped),
    esc(`${assertion.expression ?? ''} ${assertion.operator ?? ''}`),
    esc(formatRuntimeValue(assertion.expected)),
    esc(formatRuntimeValue(assertion.actual)),
  ]));

  sections.push(renderRuntimeTable('Actions', ['Result', 'Phase', 'Target', 'Value'], runtime.actions ?? [], (action: any) => [
    runtimeStateCell(action.passed, action.skipped),
    esc(String(action.phase ?? '')),
    esc(String(action.target ?? action.type ?? '')),
    esc(action.message ? String(action.message) : formatRuntimeValue(action.value)),
  ]));

  sections.push(renderRuntimeTable('Variables', ['Scope', 'Name', 'Value'], runtime.variableMutations ?? [], (mutation: any) => [
    esc(String(mutation.scope ?? '')),
    esc(String(mutation.name ?? '')),
    esc(String(mutation.value ?? '')),
  ]));

  sections.push(renderRuntimeTable('Logs', ['Phase', 'Level', 'Message'], runtime.logs ?? [], (log: any) => [
    esc(String(log.phase ?? '')),
    esc(String(log.level ?? '')),
    esc(String(log.message ?? '')),
  ]));

  sections.push(renderRuntimeTable('Errors', ['Phase', 'Message'], runtime.errors ?? [], (error: any) => [
    esc(String(error.phase ?? '')),
    esc(String(error.message ?? '')),
  ]));

  return sections.filter(Boolean).join('');
}

function renderRuntimeTable(
  title: string,
  headers: string[],
  rows: any[],
  mapRow: (row: any) => string[],
): string {
  if (!rows.length) return '';
  const head = headers.map(header => `<th>${esc(header)}</th>`).join('');
  const body = rows.map(row => `<tr>${mapRow(row).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('');
  return `<section class="runtime-section"><h3>${esc(title)}</h3><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function runtimeStateCell(passed: boolean, skipped?: boolean): string {
  const label = skipped ? 'Skip' : passed ? 'Pass' : 'Fail';
  const cls = skipped ? 'runtime-skip' : passed ? 'runtime-pass' : 'runtime-failed';
  return `<span class="runtime-pill ${cls}">${label}</span>`;
}

function formatRuntimeValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Track the last blob URL so we can revoke it to avoid memory leaks */

function setIframeBlobSrc(iframe: HTMLIFrameElement, blob: Blob): void {
  if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
  lastBlobUrl = URL.createObjectURL(blob);
  iframe.removeAttribute('srcdoc');
  iframe.src = lastBlobUrl;
}

/** Populate the preview with the last response content. Called when Preview tab is activated. */
export function renderPreview(): void {
  const iframe = document.getElementById('respPreviewFrame') as HTMLIFrameElement | null;
  const imageContainer = document.getElementById('respImageContainer');
  const pdfContainer = document.getElementById('respPdfContainer');
  if (!iframe || !imageContainer || !pdfContainer) return;

  const resp = lastResponse;
  if (!resp) {
    resetPreviewMediaState();
    return;
  }

  const ct = lastContentType.toLowerCase();
  const previewKind = getPreviewMediaKind(ct, resp);
  const isPdf = previewKind === 'pdf';
  const isImage = previewKind === 'image';

  // Toggle visibility: media uses controlled containers, everything else uses iframe.
  iframe.style.display = (isPdf || isImage) ? 'none' : 'block';
  imageContainer.style.display = isImage ? 'flex' : 'none';
  pdfContainer.style.display = isPdf ? 'block' : 'none';

  const overlay = document.getElementById('previewOverlay');
  if (overlay) overlay.style.display = 'none';

  if (isPdf) {
    setMediaKind('pdf');
    void renderPdfPreview(pdfContainer, resp.bodyBase64!);
  } else if (isImage) {
    setMediaKind('image');
    renderImagePreview(imageContainer, resp, ct);
  } else if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    resetPreviewMediaState();
    setIframeBlobSrc(iframe, new Blob([resp.body ?? ''], { type: 'text/html' }));
    iframe.style.background = 'transparent';
  } else {
    resetPreviewMediaState();
    const escaped = (resp.body ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const html = `<pre style="margin:16px;font-family:monospace;white-space:pre-wrap;">${escaped}</pre>`;
    setIframeBlobSrc(iframe, new Blob([html], { type: 'text/html' }));
    iframe.style.background = 'transparent';
  }
}

function renderImagePreview(container: HTMLElement, resp: any, contentType: string): void {
  const mimeType = contentType.split(';')[0].trim() || 'image/png';
  const src = resp.bodyBase64
    ? `data:${mimeType};base64,${resp.bodyBase64}`
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(resp.body ?? '')}`;

  container.innerHTML =
    '<div class="preview-image-frame" id="respImageFrame">' +
    `<img class="preview-image" id="respPreviewImage" alt="Response preview" src="${src}" />` +
    '</div>';

  const img = document.getElementById('respPreviewImage') as HTMLImageElement | null;
  if (!img) return;
  img.addEventListener('load', applyImageTransform, { once: true });
  applyImageTransform();
}

/** Render PDF pages to canvas elements using PDF.js (loaded in the webview) */
export async function renderPdfPreview(container: HTMLElement, base64: string): Promise<void> {
  const generation = beginPdfRender();
  container.innerHTML = '';
  let loadingTask: PdfLoadingTask | undefined;

  const pdfjsLib = (window as any).pdfjsLib ?? await (window as any).missioPdfJsReady;
  if (!isCurrentPdfRenderGeneration(generation)) return;
  if (!pdfjsLib) {
    container.innerHTML = '<div style="padding:24px;color:var(--vscode-foreground);font-family:system-ui;">PDF.js not available</div>';
    return;
  }

  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    loadingTask = pdfjsLib.getDocument({ data: bytes });
    activePdfLoadingTasks.add(loadingTask);
    const pdf = await loadingTask.promise;
    if (!isCurrentPdfRenderGeneration(generation)) return;
    const containerWidth = Math.max(1, container.clientWidth - 32); // 16px padding each side

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      if (!isCurrentPdfRenderGeneration(generation)) return;
      const unscaledVp = page.getViewport({ scale: 1, rotation: mediaTransform.rotation });
      const requestedScale = mediaTransform.fit
        ? clampMediaZoom(containerWidth / unscaledVp.width)
        : mediaTransform.zoom;
      const renderScale = getSafePdfRenderScale(unscaledVp.width, unscaledVp.height, requestedScale);
      const renderVp = page.getViewport({ scale: renderScale, rotation: mediaTransform.rotation });
      const displayVp = renderScale === requestedScale
        ? renderVp
        : page.getViewport({ scale: requestedScale, rotation: mediaTransform.rotation });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderVp.width);
      canvas.height = Math.ceil(renderVp.height);
      canvas.style.width = Math.ceil(displayVp.width) + 'px';
      canvas.style.height = Math.ceil(displayVp.height) + 'px';
      canvas.style.display = 'block';
      canvas.style.margin = '0 auto 8px';
      canvas.style.boxShadow = '0 2px 8px rgba(0,0,0,.4)';

      const renderTask = page.render({ canvasContext: canvas.getContext('2d')!, viewport: renderVp });
      activePdfRenderTasks.add(renderTask);
      try {
        await renderTask.promise;
      } finally {
        activePdfRenderTasks.delete(renderTask);
      }
      if (!isCurrentPdfRenderGeneration(generation)) {
        canvas.remove();
        return;
      }
      container.appendChild(canvas);
      if (i === 1) {
        updateMediaToolbar(requestedScale);
      }
    }
  } catch (e: any) {
    if (!isCurrentPdfRenderGeneration(generation)) return;
    container.innerHTML = `<div style="padding:24px;color:var(--vscode-errorForeground);font-family:system-ui;">Failed to render PDF: ${e.message}</div>`;
  } finally {
    if (loadingTask && activePdfLoadingTasks.delete(loadingTask)) {
      try {
        await loadingTask.destroy?.();
      } catch {
        // Ignore PDF.js cleanup failures after the canvases have rendered.
      }
    }
  }
}
