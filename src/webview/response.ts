// Response display logic for the webview.

import { $ } from './state';
import { highlightResponse } from './highlight';

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

export function showResponse(resp: any, preRequestMs?: number, sendDoneAt?: number): void {
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
  console.time('resp:highlight');
  const lines = bodyText.split('\n');
  const html = lines.map((line: string) =>
    '<div class="code-line">' + highlightResponse(line, lang) + '\n</div>'
  ).join('');
  console.timeEnd('resp:highlight');
  console.time('resp:innerHTML');
  $('respBodyPre').innerHTML = html;
  console.timeEnd('resp:innerHTML');
  console.time('resp:lineNumbers');
  updateRespLineNumbers();
  console.timeEnd('resp:lineNumbers');

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

  // Timing: pre-request • response • render • size
  const renderMs = Date.now() - renderStart;
  let meta = resp.duration + 'ms';
  if (preRequestMs !== undefined) {
    meta = preRequestMs + 'ms pre \u2022 ' + resp.duration + 'ms response \u2022 ' + renderMs + 'ms render';
  }
  $('responseMeta').textContent = meta + ' \u2022 ' + formatSize(resp.size);
}
