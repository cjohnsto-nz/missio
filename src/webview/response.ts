// Response display logic for the webview.

import { $ } from './state';
import { highlightResponse } from './highlight';

let lastResponse: any = null;
let lastResponseBody = '';
let lastContentType = '';
let lastBlobUrl: string | undefined;

export function getLastResponse(): any { return lastResponse; }
export function getLastResponseBody(): string { return lastResponseBody; }
export function getLastContentType(): string { return lastContentType; }

/** Content types that support rich preview in a separate tab */
function isPreviewable(ct: string): boolean {
  const lower = ct.toLowerCase();
  return lower.includes('text/html')
    || lower.includes('application/xhtml')
    || lower.includes('application/pdf')
    || lower.startsWith('image/');
}

export function showLoading(text?: string): void {
  $('respLoading').style.display = 'flex';
  $('respEmpty').style.display = 'none';
  $('respBodyWrap').style.display = 'none';
  $('responseBar').style.display = 'none';
  $('respTabs').style.display = 'none';
  if (text) setLoadingText(text);
  // Invalidate preview content
  const iframe = document.getElementById('respPreviewFrame') as HTMLIFrameElement | null;
  if (iframe) { iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc'); iframe.style.display = 'none'; }
  const pdfContainer = document.getElementById('respPdfContainer');
  if (pdfContainer) { pdfContainer.innerHTML = ''; pdfContainer.style.display = 'none'; }
  if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = undefined; }
}

export function setLoadingText(text: string): void {
  const el = $('respLoading').querySelector('span');
  if (el) el.textContent = text;
}

export function hideLoading(): void {
  $('respLoading').style.display = 'none';
}

export function clearResponse(): void {
  $('responseBar').style.display = 'none';
  $('respTabs').style.display = 'none';
  $('respBodyWrap').style.display = 'none';
  $('respEmpty').style.display = 'block';
  lastResponse = null;
  lastResponseBody = '';
}

function updateRespLineNumbers(): void {
  // Line numbers are now rendered via CSS counter on .code-line::before
  // No JS measurement needed — gutter is part of each line element
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

export function showResponse(resp: any, preRequestMs?: number, timing?: TimingEntry[]): void {
  const renderStart = Date.now();
  hideLoading();
  lastResponse = resp;
  $('sendBtn').classList.remove('sending');
  ($('sendBtn') as HTMLButtonElement).disabled = false;
  $('sendBtn').textContent = 'Send';
  $('responseBar').style.display = 'flex';
  $('respTabs').style.display = 'flex';
  $('respEmpty').style.display = 'none';
  $('respBodyWrap').style.display = 'block';

  const badge = $('statusBadge');
  badge.textContent = resp.status + ' ' + resp.statusText;
  const cat = Math.floor(resp.status / 100);
  badge.className = 'status-badge s' + cat + 'xx';

  // Body — detect language from content-type and apply highlighting
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

  lastResponseBody = bodyText;
  lastContentType = ct;

  // Show/hide Preview tab for previewable content types
  const previewTab = document.getElementById('respPreviewTab');
  if (previewTab) {
    previewTab.style.display = isPreviewable(ct) ? '' : 'none';
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
  const isBinary = !!resp.bodyBase64;
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

  let rPhase = Date.now();
  if (!isBinary) {
    console.time('resp:highlight');
  }
  const lines = isBinary ? [] : bodyText.split('\n');
  const html = lines.map((line: string) =>
    '<div class="code-line">' + highlightResponse(line, lang) + '\n</div>'
  ).join('');
  if (!isBinary) {
    console.timeEnd('resp:highlight');
  }
  renderTiming.push({ label: 'Highlight', start: rBase, end: rBase + (Date.now() - rPhase) });

  rPhase = Date.now();
  console.time('resp:innerHTML');
  $('respBodyPre').innerHTML = html;
  console.timeEnd('resp:innerHTML');
  renderTiming.push({ label: 'DOM Update', start: renderTiming[renderTiming.length - 1].end, end: rBase + (Date.now() - renderStart) });

  rPhase = Date.now();
  console.time('resp:lineNumbers');
  updateRespLineNumbers();
  console.timeEnd('resp:lineNumbers');
  renderTiming.push({ label: 'Line Numbers', start: renderTiming[renderTiming.length - 1].end, end: rBase + (Date.now() - renderStart) });

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
  renderTiming.push({ label: 'Headers', start: renderTiming[renderTiming.length - 1].end, end: rBase + (Date.now() - renderStart) });

  // Timing display
  const renderMs = Date.now() - renderStart;
  let meta = resp.duration + 'ms';
  if (preRequestMs !== undefined) {
    meta = preRequestMs + 'ms pre \u2022 ' + resp.duration + 'ms response \u2022 ' + renderMs + 'ms render';
  }
  const metaEl = $('responseMeta');
  metaEl.textContent = meta + ' \u2022 ' + formatSize(resp.size);

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
      'Highlight': '#98c379',
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
  const pdfContainer = document.getElementById('respPdfContainer');
  if (!iframe || !pdfContainer) return;

  const resp = lastResponse;
  if (!resp) return;

  const ct = lastContentType.toLowerCase();
  const isPdf = ct.includes('application/pdf') && resp.bodyBase64;

  // Toggle visibility: PDF uses canvas container, everything else uses iframe
  iframe.style.display = isPdf ? 'none' : 'block';
  pdfContainer.style.display = isPdf ? 'block' : 'none';

  if (isPdf) {
    renderPdfPreview(pdfContainer, resp.bodyBase64!);
  } else if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    setIframeBlobSrc(iframe, new Blob([resp.body ?? ''], { type: 'text/html' }));
    iframe.style.background = 'transparent';
  } else if (ct.startsWith('image/') && resp.bodyBase64) {
    const mimeType = ct.split(';')[0].trim();
    const html = `<!DOCTYPE html>
<html><head><style>
  body { margin:0; display:flex; align-items:center; justify-content:center;
    min-height:100vh; background:transparent; }
  img { max-width:100%; max-height:100vh; object-fit:contain; }
</style></head><body>
<img src="data:${mimeType};base64,${resp.bodyBase64}" />
</body></html>`;
    setIframeBlobSrc(iframe, new Blob([html], { type: 'text/html' }));
    iframe.style.background = 'transparent';
  } else if (ct.startsWith('image/svg') && resp.body) {
    setIframeBlobSrc(iframe, new Blob([resp.body], { type: 'text/html' }));
    iframe.style.background = 'transparent';
  } else {
    const escaped = (resp.body ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const html = `<pre style="margin:16px;font-family:monospace;white-space:pre-wrap;">${escaped}</pre>`;
    setIframeBlobSrc(iframe, new Blob([html], { type: 'text/html' }));
    iframe.style.background = 'transparent';
  }
}

/** Render PDF pages to canvas elements using PDF.js (loaded in the webview) */
async function renderPdfPreview(container: HTMLElement, base64: string): Promise<void> {
  container.innerHTML = '';

  const pdfjsLib = (window as any).pdfjsLib;
  if (!pdfjsLib) {
    container.innerHTML = '<div style="padding:24px;color:var(--vscode-foreground);font-family:system-ui;">PDF.js not available</div>';
    return;
  }

  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const containerWidth = container.clientWidth - 32; // 16px padding each side

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const unscaledVp = page.getViewport({ scale: 1 });
      const scale = Math.min(containerWidth / unscaledVp.width, 2);
      const vp = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.display = 'block';
      canvas.style.margin = '0 auto 8px';
      canvas.style.boxShadow = '0 2px 8px rgba(0,0,0,.4)';
      container.appendChild(canvas);

      await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    }
  } catch (e: any) {
    container.innerHTML = `<div style="padding:24px;color:var(--vscode-errorForeground);font-family:system-ui;">Failed to render PDF: ${e.message}</div>`;
  }
}
