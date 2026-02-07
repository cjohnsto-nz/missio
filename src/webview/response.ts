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
  const renderTiming: TimingEntry[] = [];
  const rBase = timing && timing.length > 0 ? timing[timing.length - 1].end : 0;

  let rPhase = Date.now();
  console.time('resp:highlight');
  const lines = bodyText.split('\n');
  const html = lines.map((line: string) =>
    '<div class="code-line">' + highlightResponse(line, lang) + '\n</div>'
  ).join('');
  console.timeEnd('resp:highlight');
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
