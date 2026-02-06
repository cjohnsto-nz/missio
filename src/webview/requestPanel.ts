// Webview script for the Request Panel — main orchestrator.
// This runs inside the VS Code webview, NOT in the extension host.

import {
  vscode, $, $input, esc,
  currentRequest, setCurrentRequest,
  setResolvedVariables, getResolvedVariables,
  setVariableSources, getVariableSources,
  setShowResolvedVars, getShowResolvedVars,
  updateDocumentTimer, setUpdateDocumentTimer,
  ignoreNextLoad, setIgnoreNextLoad,
  currentBodyType, setCurrentBodyType,
  currentLang, setCurrentLang,
} from './state';
import { highlight, highlightVariables, escHtml } from './highlight';
import {
  handleAutocomplete,
  handleAutocompleteContentEditable,
  handleAutocompleteKeydown,
  hideAutocomplete,
  isAutocompleteActive,
  setAutocompleteSyncCallbacks,
} from './autocomplete';
import {
  showResponse, showLoading, hideLoading, clearResponse,
  getLastResponse, getLastResponseBody,
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
const respPanelIds = ['resp-body', 'resp-headers'];

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
    switchTab($('respTabs'), (tab as HTMLElement).dataset.tab!, respPanelIds);
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
function updateMethodColor(): void {
  methodSelect.className = 'method-select ' + methodSelect.value.toLowerCase();
}
methodSelect.addEventListener('change', () => {
  updateMethodColor();
  scheduleDocumentUpdate();
  vscode.postMessage({ type: 'methodChanged', method: methodSelect.value });
});

// ── Params ──────────────────────────────────────
function addParam(name = '', value = '', type = 'query', disabled = false): void {
  const tbody = $('paramsBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="checkbox" class="p-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="p-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td><input type="text" class="p-value" value="' + esc(value) + '" placeholder="value" /></td>' +
    '<td><select class="p-type auth-select" style="margin:0;"><option value="query"' + (type === 'query' ? ' selected' : '') + '>query</option><option value="path"' + (type === 'path' ? ' selected' : '') + '>path</option></select></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); updateBadges(); scheduleDocumentUpdate(); });
  tr.addEventListener('input', scheduleDocumentUpdate);
  tr.addEventListener('change', scheduleDocumentUpdate);
  enableVarOverlay(tr.querySelector('.p-name') as HTMLInputElement);
  enableVarOverlay(tr.querySelector('.p-value') as HTMLInputElement);
  tbody.appendChild(tr);
  updateBadges();
}

// ── Headers ─────────────────────────────────────
function addHeader(name = '', value = '', disabled = false): void {
  const tbody = $('headersBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="checkbox" class="h-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="h-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td><input type="text" class="h-value" value="' + esc(value) + '" placeholder="value" /></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); updateBadges(); scheduleDocumentUpdate(); });
  tr.addEventListener('input', scheduleDocumentUpdate);
  tr.addEventListener('change', scheduleDocumentUpdate);
  enableVarOverlay(tr.querySelector('.h-name') as HTMLInputElement);
  enableVarOverlay(tr.querySelector('.h-value') as HTMLInputElement);
  tbody.appendChild(tr);
  updateBadges();
}

// ── Generic Variable Overlay for Text Inputs ────
function enableVarOverlay(input: HTMLInputElement): void {
  const parent = input.parentElement!;
  parent.classList.add('var-cell');
  const overlay = document.createElement('div');
  overlay.className = 'var-overlay';
  parent.appendChild(overlay);

  function sync() {
    overlay.innerHTML = highlightVariables(escHtml(input.value));
  }
  function activate() {
    parent.classList.add('var-overlay-active');
    sync();
  }
  function deactivate() {
    parent.classList.remove('var-overlay-active');
  }

  input.addEventListener('input', () => {
    if (getShowResolvedVars()) {
      breakIllusion();
    }
    sync();
    handleAutocomplete(input as unknown as HTMLTextAreaElement, sync);
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    handleAutocompleteKeydown(e);
  });
  input.addEventListener('focus', deactivate);
  input.addEventListener('blur', activate);

  overlay.addEventListener('click', (e: Event) => {
    const varEl = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
    if (varEl && varEl.dataset.var) {
      showVarTooltipAt(varEl, varEl.dataset.var);
    } else {
      deactivate();
      input.focus();
    }
  });

  // Activate immediately if input is not focused
  if (document.activeElement !== input) {
    activate();
  }
}

function syncAllVarOverlays(): void {
  document.querySelectorAll('.var-cell').forEach((cell) => {
    const input = cell.querySelector('input[type="text"]') as HTMLInputElement | null;
    const overlay = cell.querySelector('.var-overlay') as HTMLElement | null;
    if (input && overlay && cell.classList.contains('var-overlay-active')) {
      overlay.innerHTML = highlightVariables(escHtml(input.value));
    }
  });
}

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
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); scheduleDocumentUpdate(); });
  tr.addEventListener('input', scheduleDocumentUpdate);
  tr.addEventListener('change', scheduleDocumentUpdate);
  enableVarOverlay(tr.querySelector('.f-name') as HTMLInputElement);
  enableVarOverlay(tr.querySelector('.f-value') as HTMLInputElement);
  tbody.appendChild(tr);
}

function updateBadges(): void {
  const params = document.querySelectorAll('#paramsBody tr');
  const headers = document.querySelectorAll('#headersBody tr');
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
  }
}

document.querySelectorAll('#bodyTypePills .pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    setBodyType((pill as HTMLElement).dataset.bodyType!);
  });
});

// ── Syntax Highlighting (body editor) ────────────
function updateLineNumbers(): void {
  const textarea = $('bodyData') as HTMLTextAreaElement;
  const gutter = $('lineNumbers');
  const lineCount = (textarea.value.match(/\n/g) || []).length + 1;
  const current = gutter.children.length;
  if (current !== lineCount) {
    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      html += '<span>' + i + '</span>';
    }
    gutter.innerHTML = html;
  }
  gutter.style.top = -textarea.scrollTop + 'px';
}

function syncHighlight(): void {
  try {
    const textarea = $('bodyData') as HTMLTextAreaElement;
    const pre = $('bodyHighlight');
    pre.innerHTML = highlight(textarea.value, currentLang) + '\n';
    updateLineNumbers();
  } catch {
    // prevent highlighting errors from breaking UI
  }
}

// ── Variable Tooltip ────────────────────────────
let activeTooltip: HTMLElement | null = null;

function findVarAtCursor(text: string, cursorPos: number): string | null {
  const re = /\{\{(\s*[\w.]+\s*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (cursorPos >= m.index && cursorPos <= m.index + m[0].length) {
      return m[1].trim();
    }
  }
  return null;
}

function showVarTooltipAt(anchorEl: HTMLElement, varName: string): void {
  hideVarTooltip();
  const rect = anchorEl.getBoundingClientRect();
  const resolved = varName in getResolvedVariables();
  const tooltip = document.createElement('div');
  tooltip.className = 'var-tooltip';
  const source = getVariableSources()[varName] || 'unknown';
  const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1);
  tooltip.innerHTML =
    "<div class='var-name'>{{" + escHtml(varName) + "}}</div>" +
    (resolved
      ? "<div class='var-source tk-src-" + source + "'>" + sourceLabel + "</div>" +
        "<div class='var-value'>" + escHtml(getResolvedVariables()[varName]) + "</div>"
      : "<div class='var-unresolved'>Unresolved variable</div>") +
    "<div class='var-actions'>" +
    "<button class='var-action-btn' data-action='edit'>Edit Variable</button>" +
    "<button class='var-action-btn' data-action='copy'>" + (resolved ? 'Copy Value' : 'Copy Name') + "</button>" +
    "</div>";

  tooltip.style.left = rect.left + 'px';
  tooltip.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  tooltip.querySelectorAll('.var-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'edit') {
        vscode.postMessage({ type: 'editVariable', variableName: varName });
      } else if (action === 'copy') {
        const text = resolved ? getResolvedVariables()[varName] : '{{' + varName + '}}';
        navigator.clipboard.writeText(text).catch(() => {});
      }
      hideVarTooltip();
    });
  });

  setTimeout(() => {
    document.addEventListener('click', onTooltipOutsideClick);
  }, 0);
}

function hideVarTooltip(): void {
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
  document.removeEventListener('click', onTooltipOutsideClick);
}

function onTooltipOutsideClick(e: MouseEvent): void {
  if (activeTooltip && !activeTooltip.contains(e.target as Node)) {
    hideVarTooltip();
  }
}

$('bodyHighlight').addEventListener('click', (e: Event) => {
  const target = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
  if (target && target.dataset.var) {
    showVarTooltipAt(target, target.dataset.var);
  }
});

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
  if (!_rawUrlTemplate) {
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
  el.innerHTML = highlightVariables(escHtml(_rawUrlTemplate));
  if (sel && document.activeElement === el) {
    restoreCursor(el, cursorOffset);
  }
}

function restoreCursor(el: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let charCount = 0;
  let found = false;

  function walk(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent || '').length;
      if (charCount + len >= offset) {
        range.setStart(node, offset - charCount);
        range.collapse(true);
        return true;
      }
      charCount += len;
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        if (walk(node.childNodes[i])) return true;
      }
    }
    return false;
  }

  found = walk(el);
  if (!found) {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

// Wire autocomplete sync callbacks
setAutocompleteSyncCallbacks(syncHighlight, syncUrlHighlight, restoreCursor, (text: string) => {
  _rawUrlTemplate = text;
});

$('url').addEventListener('click', (e: Event) => {
  const target = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
  if (target && target.dataset.var) {
    showVarTooltipAt(target, target.dataset.var);
  }
});

$('url').addEventListener('input', () => {
  if (getShowResolvedVars()) {
    breakIllusion();
    restoreCursor($('url'), _rawUrlTemplate.length);
    return;
  }
  // Capture cursor offset BEFORE syncUrlHighlight destroys it
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
  _rawUrlTemplate = el.textContent || '';
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
  handleAutocomplete($('bodyData') as HTMLTextAreaElement, syncHighlight);
  scheduleDocumentUpdate();
});
$('bodyData').addEventListener('scroll', syncScroll);

$('bodyData').addEventListener('click', (e: Event) => {
  const me = e as MouseEvent;
  const textarea = $('bodyData');
  textarea.style.pointerEvents = 'none';
  const el = document.elementFromPoint(me.clientX, me.clientY);
  textarea.style.pointerEvents = '';
  if (el) {
    const varEl = (el as HTMLElement).closest('.tk-var') as HTMLElement | null;
    if (varEl && varEl.dataset.var) {
      showVarTooltipAt(varEl, varEl.dataset.var);
    }
  }
});

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

// ── Auth Type ───────────────────────────────────
function onAuthTypeChange(): void {
  const type = ($('authType') as HTMLSelectElement).value;
  const fields = $('authFields');
  fields.innerHTML = '';
  if (type === 'bearer') {
    fields.innerHTML = '<div class="auth-row"><label>Token</label><span class="auth-input-wrap"><input type="text" id="authToken" placeholder="{{token}}" /></span></div>';
  } else if (type === 'basic') {
    fields.innerHTML = '<div class="auth-row"><label>Username</label><span class="auth-input-wrap"><input type="text" id="authUsername" placeholder="username" /></span></div>' +
      '<div class="auth-row"><label>Password</label><input type="password" id="authPassword" placeholder="password" /></div>';
  } else if (type === 'apikey') {
    fields.innerHTML = '<div class="auth-row"><label>Key</label><span class="auth-input-wrap"><input type="text" id="authKey" placeholder="X-Api-Key" /></span></div>' +
      '<div class="auth-row"><label>Value</label><span class="auth-input-wrap"><input type="text" id="authValue" placeholder="{{apiKey}}" /></span></div>' +
      '<div class="auth-row"><label>In</label><select id="authPlacement" class="auth-select" style="margin:0;"><option value="header">Header</option><option value="query">Query</option></select></div>';
  }
  // Enable variable overlays on all auth text inputs
  fields.querySelectorAll('input[type="text"]').forEach((input) => {
    enableVarOverlay(input as HTMLInputElement);
  });
}

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
      value: (tr.querySelector('.p-value') as HTMLInputElement).value,
      type: (tr.querySelector('.p-type') as HTMLSelectElement).value,
      disabled: !(tr.querySelector('.p-enabled') as HTMLInputElement).checked,
    });
  });
  req.http.params = params;

  // Headers
  const headers: any[] = [];
  document.querySelectorAll('#headersBody tr').forEach((tr) => {
    headers.push({
      name: (tr.querySelector('.h-name') as HTMLInputElement).value,
      value: (tr.querySelector('.h-value') as HTMLInputElement).value,
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
  if (authType === 'bearer') {
    req.http.auth = { type: 'bearer', token: $input('authToken')?.value || '' };
  } else if (authType === 'basic') {
    req.http.auth = { type: 'basic', username: $input('authUsername')?.value || '', password: $input('authPassword')?.value || '' };
  } else if (authType === 'apikey') {
    req.http.auth = { type: 'apikey', key: $input('authKey')?.value || '', value: $input('authValue')?.value || '', placement: ($('authPlacement') as HTMLSelectElement)?.value || 'header' };
  } else if (authType === 'inherit') {
    req.http.auth = 'inherit';
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

// ── Send ────────────────────────────────────────
function sendRequest(): void {
  const req = buildRequest();
  $('sendBtn').classList.add('sending');
  ($('sendBtn') as HTMLButtonElement).disabled = true;
  $('sendBtn').textContent = 'Sending...';
  showLoading();
  vscode.postMessage({ type: 'sendRequest', request: req });
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
  clearResponse();
  const http = req.http || {};
  (methodSelect as HTMLSelectElement).value = (http.method || 'GET').toUpperCase();
  updateMethodColor();
  setUrlText(http.url || '');

  // Params
  $('paramsBody').innerHTML = '';
  (http.params || []).forEach((p: any) => addParam(p.name, p.value, p.type || 'query', p.disabled));

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
        if (body.data) {
          ($('bodyData') as HTMLTextAreaElement).value = body.data;
        }
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
    onAuthTypeChange();
    if (auth.type === 'bearer') {
      setTimeout(() => { const el = $input('authToken'); if (el) el.value = auth.token || ''; }, 0);
    } else if (auth.type === 'basic') {
      setTimeout(() => {
        const u = $input('authUsername'); if (u) u.value = auth.username || '';
        const p = $input('authPassword'); if (p) p.value = auth.password || '';
      }, 0);
    } else if (auth.type === 'apikey') {
      setTimeout(() => {
        const k = $input('authKey'); if (k) k.value = auth.key || '';
        const v = $input('authValue'); if (v) v.value = auth.value || '';
        const pl = $('authPlacement') as HTMLSelectElement; if (pl) pl.value = auth.placement || 'header';
      }, 0);
    }
  } else {
    ($('authType') as HTMLSelectElement).value = 'none';
  }
  onAuthTypeChange();

  // Settings
  const settings = req.settings || {};
  $input('settingTimeout').value = settings.timeout !== undefined && settings.timeout !== 'inherit' ? settings.timeout : '30000';
  $input('settingEncodeUrl').checked = settings.encodeUrl !== undefined && settings.encodeUrl !== 'inherit' ? settings.encodeUrl : true;
  $input('settingFollowRedirects').checked = settings.followRedirects !== undefined && settings.followRedirects !== 'inherit' ? settings.followRedirects : true;
  $input('settingMaxRedirects').value = settings.maxRedirects !== undefined && settings.maxRedirects !== 'inherit' ? settings.maxRedirects : '5';

  updateBadges();
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
      showResponse(msg.response);
      break;
    case 'sending':
      $('sendBtn').classList.add('sending');
      ($('sendBtn') as HTMLButtonElement).disabled = true;
      $('sendBtn').textContent = 'Sending...';
      break;
    case 'saved':
      break;
    case 'error':
      hideLoading();
      $('sendBtn').classList.remove('sending');
      ($('sendBtn') as HTMLButtonElement).disabled = false;
      $('sendBtn').textContent = 'Send';
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
      break;
    }
    case 'variablesResolved':
      setResolvedVariables(msg.variables || {});
      setVariableSources(msg.sources || {});
      syncHighlight();
      syncUrlHighlight();
      syncAllVarOverlays();
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
$('sendBtn').addEventListener('click', sendRequest);
$('copyRespBtn').addEventListener('click', () => {
  const body = getLastResponseBody();
  if (!body) return;
  navigator.clipboard.writeText(body).then(() => {
    const btn = $('copyRespBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});
$('saveExampleBtn').addEventListener('click', () => {
  if (!getLastResponse()) return;
  const req = buildRequest();
  vscode.postMessage({ type: 'saveExample', request: req, response: getLastResponse() });
});
$('addParamBtn').addEventListener('click', () => addParam());
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
