// Webview script for the Request Panel — main orchestrator.
// This runs inside the VS Code webview, NOT in the extension host.

import {
  vscode, $, $input, esc,
  currentRequest, setCurrentRequest,
  updateDocumentTimer, setUpdateDocumentTimer,
  ignoreNextLoad, setIgnoreNextLoad,
  currentBodyType, setCurrentBodyType,
  currentLang, setCurrentLang,
} from './state';
import { highlight, escHtml } from './highlight';
import { findVarAtCursor } from './varlib';
import { authTypeOptionsHtml, renderAuthFields, buildAuthData, loadAuthData } from './authFields';
import { initOAuth2TokenStatusController } from './oauth2TokenStatus';
import {
  handleAutocomplete,
  handleAutocompleteContentEditable,
  handleAutocompleteKeydown,
  hideAutocomplete,
  isAutocompleteActive,
} from './autocomplete';
import {
  highlightVariables, enableVarOverlay, enableContentEditableValue,
  restoreCursor, syncAllVarOverlays, handleVariablesResolved, initVarFields,
  setBreakIllusionCallback, setPostMessage,
  getResolvedVariables, getVariableSources, getSecretKeys, getShowResolvedVars, setShowResolvedVars,
} from './varFields';
import { setupVarHover, showVarTooltipAt, scheduleDismiss, handleSecretValueResolved, handleSetSecretValueResult, cancelHoverTimer } from './varTooltip';
import {
  handleODataAutocomplete, handleODataKeydown,
  hideODataAutocomplete, isODataAutocompleteActive,
} from './odataAutocomplete';
import {
  showResponse, showLoading, hideLoading, clearResponse,
  getLastResponse, getLastResponseBody, setLoadingText,
  renderPreview,
} from './response';

// ── Document update scheduling ───────────────────
function scheduleDocumentUpdate(): void {
  if (updateDocumentTimer) clearTimeout(updateDocumentTimer);
  setUpdateDocumentTimer(setTimeout(() => {
    setIgnoreNextLoad(true);
    const req = buildRequest();
    vscode.postMessage({ type: 'updateDocument', request: req });
  }, 300));
}

// ── Tab switching ──────────────────────────────
const reqPanelIds = ['body', 'auth', 'headers', 'params', 'settings'];
const respPanelIds = ['resp-body', 'resp-headers', 'resp-preview'];

function switchTab(tabBar: HTMLElement, tabId: string, panelIds: string[]): void {
  tabBar.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  const clicked = tabBar.querySelector(`[data-tab="${tabId}"]`);
  if (clicked) clicked.classList.add('active');
  panelIds.forEach((pid) => {
    const p = document.getElementById('panel-' + pid);
    if (p) p.classList.toggle('active', pid === tabId);
  });
}

$('reqTabs').querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchTab($('reqTabs'), (tab as HTMLElement).dataset.tab!, reqPanelIds);
  });
});
$('respTabs').querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabId = (tab as HTMLElement).dataset.tab!;
    switchTab($('respTabs'), tabId, respPanelIds);
    if (tabId === 'resp-preview') renderPreview();
  });
});

// ── Resizable divider ──────────────────────────
const divider = $('divider');
const reqSection = $('requestSection');
const respSection = $('responseSection');
let isDragging = false;

divider.addEventListener('mousedown', () => {
  isDragging = true;
  divider.classList.add('dragging');
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!isDragging) return;
  const container = document.querySelector('.main-content')!;
  const containerRect = container.getBoundingClientRect();
  const offset = e.clientY - containerRect.top;
  const total = containerRect.height;
  const pct = Math.max(15, Math.min(85, (offset / total) * 100));
  reqSection.style.flex = 'none';
  reqSection.style.height = pct + '%';
  respSection.style.flex = 'none';
  respSection.style.height = (100 - pct) + '%';
});

document.addEventListener('mouseup', () => {
  isDragging = false;
  divider.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// ── Method color ────────────────────────────────
const methodSelect = $('method') as HTMLSelectElement;
const methodPicker = $('methodPicker') as HTMLDivElement;
let methodMenu: HTMLDivElement | null = null;
let methodTrigger: HTMLButtonElement | null = null;

function closeMethodMenu(): void {
  if (!methodMenu || !methodTrigger) return;
  methodPicker.classList.remove('open');
  methodTrigger.setAttribute('aria-expanded', 'false');
}

function openMethodMenu(): void {
  if (!methodMenu || !methodTrigger) return;
  methodPicker.classList.add('open');
  methodTrigger.setAttribute('aria-expanded', 'true');
  const selected = methodMenu.querySelector<HTMLButtonElement>('[data-method="' + methodSelect.value + '"]');
  selected?.focus();
}

function setMethodValue(method: string): void {
  if (methodSelect.value === method) return;
  methodSelect.value = method;
  methodSelect.dispatchEvent(new Event('change', { bubbles: true }));
}

function setupMethodPicker(): void {
  methodPicker.classList.add('custom');

  methodTrigger = document.createElement('button');
  methodTrigger.type = 'button';
  methodTrigger.className = 'method-picker-trigger';
  methodTrigger.setAttribute('aria-haspopup', 'listbox');
  methodTrigger.setAttribute('aria-expanded', 'false');
  methodTrigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (methodPicker.classList.contains('open')) closeMethodMenu();
    else openMethodMenu();
  });
  methodTrigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMethodMenu();
    }
  });

  methodMenu = document.createElement('div');
  methodMenu.className = 'method-picker-menu';
  methodMenu.setAttribute('role', 'listbox');
  methodMenu.addEventListener('keydown', (e) => {
    if (!methodMenu) return;
    const items = Array.from(methodMenu.querySelectorAll<HTMLButtonElement>('.method-picker-option'));
    if (!items.length) return;
    const idx = items.findIndex((item) => item === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1 + items.length) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const active = idx >= 0 ? items[idx] : null;
      if (active?.dataset.method) setMethodValue(active.dataset.method);
      closeMethodMenu();
      methodTrigger?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMethodMenu();
      methodTrigger?.focus();
    }
  });

  Array.from(methodSelect.options).forEach((opt) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'method-picker-option ' + opt.value.toLowerCase();
    item.dataset.method = opt.value;
    item.setAttribute('role', 'option');
    item.textContent = opt.value;
    item.addEventListener('click', (e) => {
      e.preventDefault();
      setMethodValue(opt.value);
      closeMethodMenu();
      methodTrigger?.focus();
    });
    methodMenu!.appendChild(item);
  });

  methodPicker.appendChild(methodTrigger);
  methodPicker.appendChild(methodMenu);

  document.addEventListener('click', (e) => {
    if (!methodPicker.contains(e.target as Node)) closeMethodMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMethodMenu();
  });
}

function updateMethodColor(): void {
  methodSelect.className = 'method-select ' + methodSelect.value.toLowerCase();
  if (methodTrigger) {
    methodTrigger.className = 'method-picker-trigger ' + methodSelect.value.toLowerCase();
    methodTrigger.textContent = methodSelect.value;
  }
  if (methodMenu) {
    methodMenu.querySelectorAll<HTMLButtonElement>('.method-picker-option').forEach((item) => {
      const selected = item.dataset.method === methodSelect.value;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }
}
setupMethodPicker();
methodSelect.addEventListener('change', () => {
  updateMethodColor();
  scheduleDocumentUpdate();
  vscode.postMessage({ type: 'methodChanged', method: methodSelect.value });
});
updateMethodColor();

// ── Params ──────────────────────────────────────
let _syncingFromUrl = false; // guard to prevent infinite loops

function addParam(name = '', value = '', type = 'query', disabled = false): void {
  const tbody = $('paramsBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="checkbox" class="p-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="p-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td class="val-cell"><div class="val-ce p-value" contenteditable="true" data-placeholder="value"></div></td>' +
    '<td><select class="p-type select-borderless"><option value="query"' + (type === 'query' ? ' selected' : '') + '>query</option><option value="path"' + (type === 'path' ? ' selected' : '') + '>path</option></select></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); updateBadges(); syncUrlFromParams(); scheduleDocumentUpdate(); });
  const enabledCb = tr.querySelector('.p-enabled') as HTMLInputElement;
  enabledCb.addEventListener('change', () => { syncUrlFromParams(); scheduleDocumentUpdate(); });
  const typeSelect = tr.querySelector('.p-type') as HTMLSelectElement;
  typeSelect.addEventListener('change', () => { syncUrlFromParams(); scheduleDocumentUpdate(); });
  const nameInput = tr.querySelector('.p-name') as HTMLInputElement;
  enableVarOverlay(nameInput);
  nameInput.addEventListener('input', () => { handleODataAutocomplete(nameInput); syncUrlFromParams(); scheduleDocumentUpdate(); });
  nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isODataAutocompleteActive()) handleODataKeydown(e);
  });
  nameInput.addEventListener('blur', () => hideODataAutocomplete());
  enableContentEditableValue(tr.querySelector('.p-value') as HTMLElement, value, () => { syncUrlFromParams(); scheduleDocumentUpdate(); });
  tbody.appendChild(tr);
  updateBadges();
}

/** Build the display URL: base URL + query string from enabled query params */
function composeDisplayUrl(): string {
  let url = _rawUrlTemplate;
  const parts: string[] = [];
  document.querySelectorAll('#paramsBody tr').forEach((tr) => {
    const enabled = (tr.querySelector('.p-enabled') as HTMLInputElement).checked;
    const type = (tr.querySelector('.p-type') as HTMLSelectElement).value;
    if (!enabled || type !== 'query') return;
    const name = (tr.querySelector('.p-name') as HTMLInputElement).value;
    const valEl = tr.querySelector('.p-value') as any;
    const value = valEl._getRawText ? valEl._getRawText() : (valEl.textContent || '');
    if (name) parts.push(name + '=' + value);
  });
  if (parts.length > 0) url += '?' + parts.join('&');
  return url;
}

/** Sync URL bar from params table (params → URL direction) */
function syncUrlFromParams(): void {
  if (_syncingFromUrl) return;
  syncUrlHighlight();
}

/** Parse the URL bar text and sync params table from it (URL → params direction) */
function syncParamsFromUrl(fullUrl: string): void {
  _syncingFromUrl = true;
  const qIdx = fullUrl.indexOf('?');
  const base = qIdx >= 0 ? fullUrl.substring(0, qIdx) : fullUrl;
  const queryString = qIdx >= 0 ? fullUrl.substring(qIdx + 1) : '';
  _rawUrlTemplate = base;

  // Parse query params from URL
  const urlParams: { name: string; value: string }[] = [];
  if (queryString) {
    for (const part of queryString.split('&')) {
      const eqIdx = part.indexOf('=');
      if (eqIdx >= 0) {
        urlParams.push({ name: part.substring(0, eqIdx), value: part.substring(eqIdx + 1) });
      } else if (part) {
        urlParams.push({ name: part, value: '' });
      }
    }
  }

  // Get existing param rows
  const rows = Array.from(document.querySelectorAll('#paramsBody tr'));
  const existingQuery: { tr: Element; name: string; value: string; enabled: boolean }[] = [];
  const nonQuery: Element[] = [];
  for (const tr of rows) {
    const type = (tr.querySelector('.p-type') as HTMLSelectElement).value;
    if (type === 'query') {
      const name = (tr.querySelector('.p-name') as HTMLInputElement).value;
      const valEl = tr.querySelector('.p-value') as any;
      const value = valEl._getRawText ? valEl._getRawText() : (valEl.textContent || '');
      const enabled = (tr.querySelector('.p-enabled') as HTMLInputElement).checked;
      existingQuery.push({ tr, name, value, enabled });
    } else {
      nonQuery.push(tr);
    }
  }

  // Match URL params to existing rows by position, update in place
  const tbody = $('paramsBody');
  // Remove all query param rows
  for (const eq of existingQuery) eq.tr.remove();

  // Keep track of disabled params that aren't in the URL
  const disabledParams = existingQuery.filter(eq => !eq.enabled);

  // Re-add: first the URL-derived enabled params, then any previously disabled ones not in URL
  for (const up of urlParams) {
    addParam(up.name, up.value, 'query', false);
  }
  for (const dp of disabledParams) {
    addParam(dp.name, dp.value, 'query', true);
  }
  // Re-append non-query (path) params at the end
  for (const nq of nonQuery) {
    tbody.appendChild(nq);
  }

  updateBadges();
  _syncingFromUrl = false;
}

// ── Headers ─────────────────────────────────────
function addHeader(name = '', value = '', disabled = false): void {
  const tbody = $('headersBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="checkbox" class="h-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="h-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td class="val-cell"><div class="val-ce h-value" contenteditable="true" data-placeholder="value"></div></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); updateBadges(); syncAutoContentType(); scheduleDocumentUpdate(); });
  tr.addEventListener('change', scheduleDocumentUpdate);
  const hNameInput = tr.querySelector('.h-name') as HTMLInputElement;
  enableVarOverlay(hNameInput);
  hNameInput.addEventListener('input', () => { syncAutoContentType(); scheduleDocumentUpdate(); });
  enableContentEditableValue(tr.querySelector('.h-value') as HTMLElement, value, scheduleDocumentUpdate);
  tbody.appendChild(tr);
  updateBadges();
}

// ── Auto-generated headers (Content-Type, Content-Length) ───────────
const _autoContentTypes: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  sparql: 'application/sparql-query',
  'form-urlencoded': 'application/x-www-form-urlencoded',
  'multipart-form': 'multipart/form-data',
};

function _hasUserHeader(headerName: string): boolean {
  const lower = headerName.toLowerCase();
  let found = false;
  document.querySelectorAll('#headersBody tr:not(.auto-header)').forEach((tr) => {
    const name = (tr.querySelector('.h-name') as HTMLInputElement)?.value ?? '';
    if (name.toLowerCase() === lower) found = true;
  });
  return found;
}

function _makeAutoRow(name: string, value: string): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.classList.add('auto-header');
  tr.innerHTML =
    '<td></td>' +
    '<td><span class="auto-label">' + name + '</span></td>' +
    '<td><span class="auto-label">' + value + '</span></td>' +
    '<td></td>';
  return tr;
}

function _getBodySize(): number {
  if (currentBodyType === 'none') return 0;
  if (currentBodyType === 'form-urlencoded') {
    const params = new URLSearchParams();
    document.querySelectorAll('#bodyFormBody tr').forEach((tr) => {
      if ((tr.querySelector('.f-enabled') as HTMLInputElement)?.checked) {
        params.set(
          (tr.querySelector('.f-name') as HTMLInputElement)?.value ?? '',
          (tr.querySelector('.f-value') as HTMLInputElement)?.value ?? '',
        );
      }
    });
    return new TextEncoder().encode(params.toString()).length;
  }
  if (currentBodyType === 'multipart-form') return 0; // boundary is dynamic, can't predict
  // Raw body types
  const data = ($('bodyData') as HTMLTextAreaElement).value;
  return new TextEncoder().encode(data).length;
}

function syncAutoHeaders(): void {
  const tbody = $('headersBody');
  // Remove all existing auto rows
  tbody.querySelectorAll('tr.auto-header').forEach(r => r.remove());

  if (currentBodyType === 'none') return;

  // Content-Type
  let typeKey: string | null = null;
  if (currentBodyType === 'form-urlencoded' || currentBodyType === 'multipart-form') {
    typeKey = currentBodyType;
  } else {
    typeKey = currentLang;
  }
  const ct = typeKey ? _autoContentTypes[typeKey] : null;
  if (ct && !_hasUserHeader('content-type')) {
    tbody.insertBefore(_makeAutoRow('Content-Type', ct), tbody.firstChild);
  }

  // Content-Length (not for multipart — boundary is dynamic)
  if (currentBodyType !== 'multipart-form' && !_hasUserHeader('content-length')) {
    const size = _getBodySize();
    tbody.insertBefore(_makeAutoRow('Content-Length', String(size)), tbody.firstChild);
  }
}

// Alias for backward compat with existing call sites
const syncAutoContentType = syncAutoHeaders;

// enableVarOverlay, enableContentEditableValue, syncAllVarOverlays, restoreCursor
// are all imported from varFields.ts — single source of truth for all panels.

function breakIllusion(): void {
  setShowResolvedVars(false);
  $('varToggleBtn').classList.remove('active');
  syncHighlight();
  syncUrlHighlight();
  syncAllVarOverlays();
}

// ── Form Fields ─────────────────────────────────
function addFormField(name = '', value = '', disabled = false): void {
  const tbody = $('bodyFormBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="checkbox" class="f-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="f-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td><input type="text" class="f-value" value="' + esc(value) + '" placeholder="value" /></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); syncAutoHeaders(); scheduleDocumentUpdate(); });
  tr.addEventListener('input', () => { syncAutoHeaders(); scheduleDocumentUpdate(); });
  tr.addEventListener('change', () => { syncAutoHeaders(); scheduleDocumentUpdate(); });
  enableVarOverlay(tr.querySelector('.f-name') as HTMLInputElement);
  enableVarOverlay(tr.querySelector('.f-value') as HTMLInputElement);
  tbody.appendChild(tr);
}

function updateBadges(): void {
  const params = document.querySelectorAll('#paramsBody tr');
  const headers = document.querySelectorAll('#headersBody tr:not(.auto-header)');
  $('paramsBadge').textContent = String(params.length);
  $('headersBadge').textContent = String(headers.length);
}

// ── Body Type (pills) ───────────────────────────
function setBodyType(type: string): void {
  setCurrentBodyType(type);
  document.querySelectorAll('#bodyTypePills .pill').forEach((p) => {
    p.classList.toggle('active', (p as HTMLElement).dataset.bodyType === type);
  });
  const raw = $('bodyRawEditor');
  const form = $('bodyFormEditor');
  const langSelect = $('bodyLangMode');
  if (type === 'none') {
    raw.style.display = 'none';
    form.style.display = 'none';
    langSelect.style.display = 'none';
  } else if (type === 'form-urlencoded' || type === 'multipart-form') {
    raw.style.display = 'none';
    form.style.display = 'block';
    langSelect.style.display = 'none';
  } else {
    raw.style.display = 'flex';
    raw.style.flexDirection = 'column';
    raw.style.flex = '1';
    form.style.display = 'none';
    langSelect.style.display = 'block';
    syncHighlight();
  }
  syncAutoContentType();
}

document.querySelectorAll('#bodyTypePills .pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    setBodyType((pill as HTMLElement).dataset.bodyType!);
    scheduleDocumentUpdate();
  });
});

// ── Syntax Highlighting (body editor) ────────────
function updateLineNumbers(): void {
  const textarea = $('bodyData') as HTMLTextAreaElement;
  const gutter = $('lineNumbers');
  const pre = $('bodyHighlight');
  const lineDivs = pre.querySelectorAll(':scope > .code-line');
  const lineCount = lineDivs.length || 1;
  const current = gutter.children.length;
  if (current !== lineCount) {
    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      html += '<span>' + i + '</span>';
    }
    gutter.innerHTML = html;
  }
  // Match each gutter span height to its corresponding content line
  const spans = gutter.children;
  for (let i = 0; i < spans.length; i++) {
    const div = lineDivs[i] as HTMLElement | undefined;
    if (div) {
      (spans[i] as HTMLElement).style.height = div.offsetHeight + 'px';
    }
  }
  gutter.style.top = -textarea.scrollTop + 'px';
}

function syncHighlight(): void {
  try {
    const textarea = $('bodyData') as HTMLTextAreaElement;
    const pre = $('bodyHighlight');
    const lines = textarea.value.split('\n');
    pre.innerHTML = lines.map(line => {
      const h = highlight(line, currentLang);
      return '<div class="code-line">' + (h || '\u00a0') + '\n</div>';
    }).join('');
    updateLineNumbers();
  } catch {
    // prevent highlighting errors from breaking UI
  }
}

// ── Variable Tooltip ────────────────────────────
function tooltipCtx() {
  return {
    getResolvedVariables,
    getVariableSources,
    getSecretKeys,
    postMessage: (msg: any) => vscode.postMessage(msg),
    onEditVariable: (name: string) => vscode.postMessage({ type: 'editVariable', variableName: name }),
  };
}

setupVarHover($('bodyHighlight'), tooltipCtx());

// ── URL contenteditable highlighting ────────────
let _rawUrlTemplate = '';

function getUrlText(): string {
  return _rawUrlTemplate;
}

function setUrlText(text: string): void {
  _rawUrlTemplate = text;
  syncUrlHighlight();
}

function syncUrlHighlight(): void {
  const el = $('url');
  const displayUrl = composeDisplayUrl();
  if (!displayUrl) {
    el.innerHTML = '';
    return;
  }
  const sel = window.getSelection();
  let cursorOffset = 0;
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    cursorOffset = preRange.toString().length;
  }
  el.innerHTML = highlightVariables(escHtml(displayUrl));
  if (sel && document.activeElement === el) {
    restoreCursor(el, cursorOffset);
  }
}

// restoreCursor imported from varFields.ts

// Wire autocomplete and variable fields
initVarFields({
  extraSyncHighlight: syncHighlight,
  extraSyncUrlHighlight: syncUrlHighlight,
  setRawUrl: (text: string) => { syncParamsFromUrl(text); },
});
setPostMessage((msg: any) => vscode.postMessage(msg));
setBreakIllusionCallback(() => {
  $('varToggleBtn').classList.remove('active');
  syncHighlight();
  syncUrlHighlight();
});

setupVarHover($('url'), tooltipCtx());

$('url').addEventListener('paste', (e: Event) => {
  e.preventDefault();
  const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
  } else {
    $('url').textContent = ($('url').textContent ?? '') + text;
  }
  $('url').dispatchEvent(new Event('input', { bubbles: true }));
});

$('url').addEventListener('input', () => {
  if (getShowResolvedVars()) {
    breakIllusion();
    restoreCursor($('url'), composeDisplayUrl().length);
    return;
  }
  // Capture cursor offset BEFORE sync destroys it
  const el = $('url');
  const sel = window.getSelection();
  let cursorOffset = 0;
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    cursorOffset = preRange.toString().length;
  }
  const fullText = el.textContent || '';
  syncParamsFromUrl(fullText);
  syncUrlHighlight();
  // Restore cursor so autocomplete can read it
  restoreCursor(el, cursorOffset);
  handleAutocompleteContentEditable(el, syncUrlHighlight);
  scheduleDocumentUpdate();
});

function syncScroll(): void {
  const textarea = $('bodyData') as HTMLTextAreaElement;
  const pre = $('bodyHighlight');
  pre.scrollTop = textarea.scrollTop;
  pre.scrollLeft = textarea.scrollLeft;
  updateLineNumbers();
}

$('bodyData').addEventListener('input', () => {
  if (getShowResolvedVars()) {
    breakIllusion();
  }
  syncHighlight();
  syncAutoHeaders();
  handleAutocomplete($('bodyData') as HTMLTextAreaElement, syncHighlight);
  scheduleDocumentUpdate();
});
$('bodyData').addEventListener('scroll', syncScroll);

// Hover-based tooltip for body textarea (peeks through to highlight layer)
{
  let _lastBodyVar = '';
  let _bodyHoverTimer: ReturnType<typeof setTimeout> | null = null;
  $('bodyData').addEventListener('mousemove', (e: Event) => {
    const me = e as MouseEvent;
    const textarea = $('bodyData');
    textarea.style.pointerEvents = 'none';
    const el = document.elementFromPoint(me.clientX, me.clientY);
    textarea.style.pointerEvents = '';
    if (el) {
      const varEl = (el as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
      if (varEl && varEl.dataset.var && varEl.dataset.var !== _lastBodyVar) {
        _lastBodyVar = varEl.dataset.var;
        if (_bodyHoverTimer) { clearTimeout(_bodyHoverTimer); }
        cancelHoverTimer();
        const varName = varEl.dataset.var;
        _bodyHoverTimer = setTimeout(() => {
          _bodyHoverTimer = null;
          showVarTooltipAt(varEl, varName, tooltipCtx());
        }, 250);
      }
    } else {
      _lastBodyVar = '';
      if (_bodyHoverTimer) { clearTimeout(_bodyHoverTimer); _bodyHoverTimer = null; }
    }
  });
  $('bodyData').addEventListener('mouseleave', (e: Event) => {
    _lastBodyVar = '';
    if (_bodyHoverTimer) { clearTimeout(_bodyHoverTimer); _bodyHoverTimer = null; }
    scheduleDismiss(e as MouseEvent);
  });
}

// ── Autocomplete keyboard ────────────────────────
$('bodyData').addEventListener('keydown', (e: Event) => {
  if (isAutocompleteActive()) handleAutocompleteKeydown(e as KeyboardEvent);
});
$('url').addEventListener('keydown', (e: Event) => {
  if (isAutocompleteActive()) {
    handleAutocompleteKeydown(e as KeyboardEvent);
    return;
  }
  if ((e as KeyboardEvent).key === 'Enter') {
    e.preventDefault();
  }
});

$('bodyData').addEventListener('blur', () => { setTimeout(hideAutocomplete, 150); });
$('url').addEventListener('blur', () => { setTimeout(hideAutocomplete, 150); });

// ── Auth Type ───────────────────────────────
const requestAuthConfig: import('./authFields').AuthFieldsConfig = {
  prefix: 'auth',
  get fieldsContainer() { return $('authFields'); },
  onChange: () => scheduleDocumentUpdate(),
  showInherit: true,
  wrapInputs: true,
  showTokenStatus: true,
  onFieldsRendered: (elements) => elements.forEach(el => enableContentEditableValue(el, '', scheduleDocumentUpdate)),
  authTypeSelectId: 'authType',
  postMessage: (msg) => vscode.postMessage(msg),
};

function onAuthTypeChange(): void {
  const type = ($('authType') as HTMLSelectElement).value;
  renderAuthFields(type, requestAuthConfig);
}

// ── OAuth2 Token Status ─────────────────────────
const tokenStatusCtrl = initOAuth2TokenStatusController({
  prefix: 'auth',
  buildAuth: () => buildAuthData(($('authType') as HTMLSelectElement).value, 'auth'),
  postMessage: (msg) => vscode.postMessage(msg),
  esc,
});

// ── Build request object ────────────────────────
function buildRequest(): any {
  // Start from a deep clone of the original parsed object to preserve all unknown fields
  const req: any = currentRequest ? JSON.parse(JSON.stringify(currentRequest)) : {};

  // Ensure top-level structures exist
  if (!req.info) req.info = { type: 'http' };
  if (!req.http) req.http = {};
  if (!req.settings) req.settings = {};

  // Update only the fields the UI manages
  req.http.method = (methodSelect as HTMLSelectElement).value;
  req.http.url = getUrlText();

  // Params
  const params: any[] = [];
  document.querySelectorAll('#paramsBody tr').forEach((tr) => {
    params.push({
      name: (tr.querySelector('.p-name') as HTMLInputElement).value,
      value: ((tr.querySelector('.p-value') as any)._getRawText ? (tr.querySelector('.p-value') as any)._getRawText() : (tr.querySelector('.p-value') as HTMLElement).textContent || ''),
      type: (tr.querySelector('.p-type') as HTMLSelectElement).value,
      disabled: !(tr.querySelector('.p-enabled') as HTMLInputElement).checked,
    });
  });
  req.http.params = params;

  // Headers
  const headers: any[] = [];
  document.querySelectorAll('#headersBody tr:not(.auto-header)').forEach((tr) => {
    headers.push({
      name: (tr.querySelector('.h-name') as HTMLInputElement).value,
      value: ((tr.querySelector('.h-value') as any)._getRawText ? (tr.querySelector('.h-value') as any)._getRawText() : (tr.querySelector('.h-value') as HTMLElement).textContent || ''),
      disabled: !(tr.querySelector('.h-enabled') as HTMLInputElement).checked,
    });
  });
  req.http.headers = headers;

  // Body
  if (currentBodyType !== 'none') {
    if (currentBodyType === 'form-urlencoded' || currentBodyType === 'multipart-form') {
      const data: any[] = [];
      document.querySelectorAll('#bodyFormBody tr').forEach((tr) => {
        data.push({
          name: (tr.querySelector('.f-name') as HTMLInputElement).value,
          value: (tr.querySelector('.f-value') as HTMLInputElement).value,
          disabled: !(tr.querySelector('.f-enabled') as HTMLInputElement).checked,
        });
      });
      req.http.body = { type: currentBodyType, data };
    } else {
      req.http.body = { type: currentLang, data: ($('bodyData') as HTMLTextAreaElement).value };
    }
  } else {
    delete req.http.body;
  }

  // Auth
  const authType = ($('authType') as HTMLSelectElement).value;
  const authData = buildAuthData(authType, 'auth');
  if (authData !== undefined) {
    req.http.auth = authData;
  } else {
    delete req.http.auth;
  }

  // Settings — merge onto existing
  req.settings.timeout = parseInt($input('settingTimeout').value) || 30000;
  req.settings.encodeUrl = $input('settingEncodeUrl').checked;
  req.settings.followRedirects = $input('settingFollowRedirects').checked;
  req.settings.maxRedirects = parseInt($input('settingMaxRedirects').value) || 5;

  return req;
}

// ── Send / Cancel ────────────────────────────────
let isSending = false;

function sendRequest(): void {
  const req = buildRequest();
  vscode.postMessage({ type: 'sendRequest', request: req });
}

function cancelRequest(): void {
  vscode.postMessage({ type: 'cancelRequest' });
  setSendingState(false);
  hideLoading();
}

function setSendingState(sending: boolean): void {
  isSending = sending;
  const btn = $('sendBtn') as HTMLButtonElement;
  if (sending) {
    btn.classList.add('sending');
    btn.classList.add('btn-cancel');
    btn.textContent = 'Cancel';
    btn.disabled = false;
  } else {
    btn.classList.remove('sending');
    btn.classList.remove('btn-cancel');
    btn.textContent = 'Send';
    btn.disabled = false;
  }
}

// ── Save ────────────────────────────────────────
function saveRequest(): void {
  if (updateDocumentTimer) {
    clearTimeout(updateDocumentTimer);
    setUpdateDocumentTimer(null);
  }
  setIgnoreNextLoad(true);
  const req = buildRequest();
  vscode.postMessage({ type: 'saveDocument', request: req });
}

// ── Load request into UI ────────────────────────
function loadRequest(req: any): void {
  setCurrentRequest(req);
  $('exampleIndicator').style.display = 'none';
  const http = req.http || {};
  (methodSelect as HTMLSelectElement).value = (http.method || 'GET').toUpperCase();
  updateMethodColor();

  // Params — load first so composeDisplayUrl works when we set the URL
  $('paramsBody').innerHTML = '';
  (http.params || []).forEach((p: any) => addParam(p.name, p.value, p.type || 'query', p.disabled));

  // Strip baked-in query string from URL when params array has query params
  let loadUrl = http.url || '';
  const hasQueryParams = (http.params || []).some((p: any) => (p.type || 'query') === 'query');
  if (hasQueryParams && loadUrl.includes('?')) {
    loadUrl = loadUrl.split('?')[0];
  }
  setUrlText(loadUrl);

  // Headers
  $('headersBody').innerHTML = '';
  (http.headers || []).forEach((h: any) => addHeader(h.name, h.value, h.disabled));

  // Body
  if (http.body) {
    const body = Array.isArray(http.body)
      ? ((http.body.find((v: any) => v.selected) || http.body[0])?.body)
      : http.body;
    if (body) {
      if (body.type === 'form-urlencoded' || body.type === 'multipart-form') {
        setBodyType(body.type);
        $('bodyFormBody').innerHTML = '';
        (body.data || []).forEach((f: any) => addFormField(f.name, f.value, f.disabled));
      } else {
        setBodyType('raw');
        setCurrentLang(body.type || 'json');
        ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
        syncAutoContentType();
        ($('bodyData') as HTMLTextAreaElement).value = body.data ?? '';
        syncHighlight();
      }
    }
  } else {
    setBodyType('none');
  }

  // Auth
  const auth = http.auth;
  if (auth === 'inherit') {
    ($('authType') as HTMLSelectElement).value = 'inherit';
  } else if (auth && auth.type) {
    ($('authType') as HTMLSelectElement).value = auth.type;
  } else {
    ($('authType') as HTMLSelectElement).value = 'none';
  }
  onAuthTypeChange();
  if (auth && auth !== 'inherit' && auth.type) {
    setTimeout(() => {
      loadAuthData(auth, 'auth');
      syncAllVarOverlays();
      tokenStatusCtrl.requestStatus();
    }, 0);
  }

  // Settings
  const settings = req.settings || {};
  $input('settingTimeout').value = settings.timeout !== undefined && settings.timeout !== 'inherit' ? settings.timeout : '30000';
  $input('settingEncodeUrl').checked = settings.encodeUrl !== undefined && settings.encodeUrl !== 'inherit' ? settings.encodeUrl : true;
  $input('settingFollowRedirects').checked = settings.followRedirects !== undefined && settings.followRedirects !== 'inherit' ? settings.followRedirects : true;
  $input('settingMaxRedirects').value = settings.maxRedirects !== undefined && settings.maxRedirects !== 'inherit' ? settings.maxRedirects : '5';

  updateBadges();
}

// ── Unresolved Variables Modal ───────────────────
function showUnresolvedVarsModal(variables: string[]): void {
  // Remove any existing modal
  const existing = document.getElementById('unresolvedVarsModal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'unresolvedVarsModal';
  overlay.className = 'uv-modal-overlay';

  const card = document.createElement('div');
  card.className = 'uv-modal-card';

  // Header
  const header = document.createElement('div');
  header.className = 'uv-modal-header';
  header.innerHTML =
    '<div class="uv-modal-title">Unresolved Variables</div>' +
    '<div class="uv-modal-subtitle">Enter values to continue or cancel the request.</div>';
  card.appendChild(header);

  // Fields
  const fields = document.createElement('div');
  fields.className = 'uv-modal-fields';
  for (const name of variables) {
    const row = document.createElement('div');
    row.className = 'uv-modal-field';
    row.innerHTML =
      '<label class="uv-modal-label">{{' + name.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '}}</label>' +
      '<input type="text" class="uv-modal-input" data-var="' + name.replace(/"/g, '&quot;') + '" placeholder="Enter value" />';
    fields.appendChild(row);
  }
  card.appendChild(fields);

  // Buttons
  const actions = document.createElement('div');
  actions.className = 'uv-modal-actions';
  actions.innerHTML =
    '<button class="uv-modal-cancel">Cancel</button>' +
    '<button class="uv-modal-send">Send</button>';
  card.appendChild(actions);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Focus first input
  const firstInput = card.querySelector('.uv-modal-input') as HTMLInputElement;
  if (firstInput) setTimeout(() => firstInput.focus(), 50);

  // Wire cancel
  const cancelBtn = card.querySelector('.uv-modal-cancel') as HTMLButtonElement;
  cancelBtn.addEventListener('click', () => {
    overlay.remove();
    vscode.postMessage({ type: 'unresolvedVarsResponse', cancelled: true });
  });

  // Wire send
  const sendBtn = card.querySelector('.uv-modal-send') as HTMLButtonElement;
  sendBtn.addEventListener('click', () => {
    const values: Record<string, string> = {};
    card.querySelectorAll('.uv-modal-input').forEach(inp => {
      const input = inp as HTMLInputElement;
      values[input.dataset.var!] = input.value;
    });
    overlay.remove();
    vscode.postMessage({ type: 'unresolvedVarsResponse', cancelled: false, values });
  });

  // Enter in last input triggers send, Escape cancels
  card.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove();
      vscode.postMessage({ type: 'unresolvedVarsResponse', cancelled: true });
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      sendBtn.click();
    }
  });
}

// ── Message handler ─────────────────────────────
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;
  switch (msg.type) {
    case 'requestLoaded':
      if (ignoreNextLoad) {
        setIgnoreNextLoad(false);
        break;
      }
      loadRequest(msg.request);
      break;
    case 'response':
      $('exampleIndicator').style.display = 'none';
      showResponse(msg.response, msg.preRequestMs, msg.timing, msg.usedOAuth2);
      setSendingState(false);
      tokenStatusCtrl.requestStatus();
      break;
    case 'sending':
      if (!isSending) showLoading();
      setSendingState(true);
      if (msg.message) setLoadingText(msg.message);
      break;
    case 'saved':
      break;
    case 'saveBinaryResponse': {
      const r = getLastResponse();
      if (r && r.bodyBase64) {
        vscode.postMessage({ type: 'saveBinaryResponse', bodyBase64: r.bodyBase64, contentType: r.headers?.['content-type'] ?? '' });
      }
      break;
    }
    case 'cancelled': {
      hideLoading();
      setSendingState(false);
      $('responseBar').style.display = 'flex';
      $('respTabs').style.display = 'flex';
      const badge = $('statusBadge');
      badge.textContent = '0 Cancelled';
      badge.className = 'status-badge s0xx';
      break;
    }
    case 'error':
      hideLoading();
      setSendingState(false);
      break;
    case 'languageChanged':
      setCurrentLang(msg.language);
      ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
      syncHighlight();
      break;
    case 'bodyUpdated':
      ($('bodyData') as HTMLTextAreaElement).value = msg.content;
      syncHighlight();
      break;
    case 'examplesUpdated':
      if (currentRequest) currentRequest.examples = msg.examples || [];
      break;
    case 'loadExample': {
      const ex = msg.example;
      if (ex.response) {
        const headers: Record<string, string> = {};
        if (ex.response.headers) {
          for (const h of ex.response.headers) {
            headers[h.name] = h.value;
          }
        }
        showResponse({
          status: ex.response.status,
          statusText: ex.response.statusText,
          headers,
          body: ex.response.body?.data ?? '',
          duration: 0,
          size: (ex.response.body?.data ?? '').length,
        });
      }
      // Show example name indicator
      const indicator = $('exampleIndicator');
      indicator.textContent = msg.exampleName || 'Example';
      indicator.style.display = 'inline-block';
      break;
    }
    case 'clearExample':
      clearResponse();
      $('exampleIndicator').style.display = 'none';
      break;
    case 'variablesResolved': {
      handleVariablesResolved(msg);
      syncHighlight();
      syncUrlHighlight();
      tokenStatusCtrl.requestStatus();
      break;
    }
    case 'secretValueResolved':
      handleSecretValueResolved(msg);
      break;
    case 'setSecretValueResult':
      handleSetSecretValueResult(msg);
      break;
    case 'oauth2TokenStatus':
      tokenStatusCtrl.handleStatus(msg.status);
      break;
    case 'oauth2Progress':
      tokenStatusCtrl.handleProgress(msg.message);
      break;
    case 'promptUnresolvedVars':
      showUnresolvedVarsModal(msg.variables as string[]);
      break;
  }
});

// ── Wire up buttons & selects ───────────────────
$('varToggleBtn').addEventListener('click', () => {
  const newVal = !getShowResolvedVars();
  setShowResolvedVars(newVal);
  $('varToggleBtn').classList.toggle('active', newVal);
  syncHighlight();
  syncUrlHighlight();
  syncAllVarOverlays();
});
$('sendBtn').addEventListener('click', () => {
  if (isSending) { cancelRequest(); } else { sendRequest(); }
});
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    sendRequest();
  }
});
$('showRawBtn').addEventListener('click', () => {
  const overlay = document.getElementById('respBinaryOverlay');
  const wrap = document.getElementById('respBodyWrap');
  if (overlay) overlay.style.display = 'none';
  if (wrap) wrap.style.display = 'block';
  // Render the raw body now
  const body = getLastResponseBody();
  if (body) {
    const lines = body.split('\n');
    $('respBodyPre').innerHTML = lines.map((line: string) =>
      '<div class="code-line">' + line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '\n</div>'
    ).join('');
  }
});
$('copyRespBtn').addEventListener('click', () => {
  const body = getLastResponseBody();
  if (!body) return;
  navigator.clipboard.writeText(body).then(() => {
    const btn = $('copyRespBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});
// Right-click context menu on preview panel for saving/copying binary content
document.getElementById('panel-resp-preview')!.addEventListener('contextmenu', (e: MouseEvent) => {
  const r = getLastResponse();
  if (!r || !r.bodyBase64) return;
  e.preventDefault();

  const old = document.getElementById('previewContextMenu');
  if (old) old.remove();

  const menu = document.createElement('div');
  menu.id = 'previewContextMenu';
  menu.style.cssText = 'position:fixed;z-index:9999;background:var(--vscode-menu-background,#252526);border:1px solid var(--vscode-menu-border,#454545);border-radius:4px;padding:4px 0;box-shadow:0 2px 8px rgba(0,0,0,.3);min-width:160px;';

  const addItem = (label: string, onClick: () => void) => {
    const item = document.createElement('div');
    item.textContent = label;
    item.style.cssText = 'padding:6px 16px;cursor:pointer;color:var(--vscode-menu-foreground,#ccc);font-size:13px;font-family:var(--vscode-font-family,system-ui);';
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--vscode-menu-selectionBackground,#094771)'; item.style.color = 'var(--vscode-menu-selectionForeground,#fff)'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; item.style.color = 'var(--vscode-menu-foreground,#ccc)'; });
    item.addEventListener('click', () => { menu.remove(); onClick(); });
    menu.appendChild(item);
  };

  const ct = (r.headers?.['content-type'] ?? '').toLowerCase();
  const isImage = ct.startsWith('image/');

  // Copy
  addItem(isImage ? 'Copy Image' : 'Copy', () => {
    if (isImage) {
      // Convert to PNG via canvas — clipboard API only supports image/png
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx2d = canvas.getContext('2d')!;
        ctx2d.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {
              navigator.clipboard.writeText(r.bodyBase64);
            });
          }
        }, 'image/png');
      };
      const mimeType = ct.split(';')[0].trim() || 'image/png';
      img.src = `data:${mimeType};base64,${r.bodyBase64}`;
    } else {
      navigator.clipboard.writeText(r.bodyBase64);
    }
  });

  // Save to Disk
  addItem('Save to Disk', () => {
    vscode.postMessage({ type: 'saveBinaryResponse', bodyBase64: r.bodyBase64, contentType: ct });
  });

  // Open in Browser (PDF only)
  if (ct.includes('application/pdf')) {
    addItem('Open in Browser', () => {
      vscode.postMessage({ type: 'openInBrowser', bodyBase64: r.bodyBase64, contentType: ct });
    });
  }

  document.body.appendChild(menu);
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
});
$('refreshOAuthRetryBtn').addEventListener('click', () => {
  const req = buildRequest();
  vscode.postMessage({ type: 'refreshOAuthAndRetry', request: req });
});
$('saveExampleBtn').addEventListener('click', () => {
  if (!getLastResponse()) return;
  const req = buildRequest();
  vscode.postMessage({ type: 'saveExample', request: req, response: getLastResponse() });
});
$('addParamBtn').addEventListener('click', () => { addParam(); syncUrlFromParams(); });
$('addHeaderBtn').addEventListener('click', () => addHeader());
$('addFormFieldBtn').addEventListener('click', () => addFormField());
$('authType').addEventListener('change', () => { onAuthTypeChange(); scheduleDocumentUpdate(); });
$('panel-auth').addEventListener('input', scheduleDocumentUpdate);
$('panel-auth').addEventListener('change', scheduleDocumentUpdate);
$('panel-settings').addEventListener('input', scheduleDocumentUpdate);
$('panel-settings').addEventListener('change', scheduleDocumentUpdate);
$('bodyLangMode').addEventListener('change', () => {
  setCurrentLang(($('bodyLangMode') as HTMLSelectElement).value);
  syncHighlight();
  syncAutoContentType();
  scheduleDocumentUpdate();
});

// Ctrl+S / Cmd+S to save
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveRequest();
  }
});

// Notify extension we're ready
vscode.postMessage({ type: 'ready' });
