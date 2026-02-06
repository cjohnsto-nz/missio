// Response display logic for the webview.

import { $ } from './state';
import { highlight } from './highlight';

let lastResponse: any = null;
let lastResponseBody = '';

export function getLastResponse(): any { return lastResponse; }
export function getLastResponseBody(): string { return lastResponseBody; }

export function showLoading(text?: string): void {
  $('respLoading').style.display = 'flex';
  $('respEmpty').style.display = 'none';
  $('respBodyWrap').style.display = 'none';
  $('responseBar').style.display = 'none';
  $('respTabs').style.display = 'none';
  if (text) setLoadingText(text);
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
  const gutter = $('respLineNumbers');
  const pre = $('respBodyPre');
  const lineDivs = pre.querySelectorAll(':scope > .code-line');
  const lineCount = lineDivs.length || 1;
  let html = '';
  for (let i = 1; i <= lineCount; i++) {
    html += '<span>' + i + '</span>';
  }
  gutter.innerHTML = html;
  // Match each gutter span height to its corresponding content line
  const spans = gutter.children;
  for (let i = 0; i < spans.length; i++) {
    const div = lineDivs[i] as HTMLElement | undefined;
    if (div) {
      (spans[i] as HTMLElement).style.height = div.offsetHeight + 'px';
    }
  }
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

export function showResponse(resp: any): void {
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

  $('responseMeta').textContent = resp.duration + 'ms \u2022 ' + formatSize(resp.size);

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
  const lines = bodyText.split('\n');
  $('respBodyPre').innerHTML = lines.map((line: string) =>
    '<div class="code-line">' + highlight(line, lang) + '\n</div>'
  ).join('');
  updateRespLineNumbers();

  // Headers
  const tbody = $('respHeadersBody');
  tbody.innerHTML = '';
  if (resp.headers) {
    Object.entries(resp.headers).forEach(([k, v]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(k) + '</td><td>' + esc(String(v)) + '</td>';
      tbody.appendChild(tr);
    });
  }
}
