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
import { showVarTooltipAt, handleSecretValueResolved } from './varTooltip';
import {
  handleODataAutocomplete, handleODataKeydown,
  hideODataAutocomplete, isODataAutocompleteActive,
} from './odataAutocomplete';
import {
  showResponse, showLoading, hideLoading, clearResponse,
  getLastResponse, getLastResponseBody, setLoadingText,
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
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); updateBadges(); scheduleDocumentUpdate(); });
  tr.addEventListener('change', scheduleDocumentUpdate);
  const hNameInput = tr.querySelector('.h-name') as HTMLInputElement;
  enableVarOverlay(hNameInput);
  hNameInput.addEventListener('input', scheduleDocumentUpdate);
  enableContentEditableValue(tr.querySelector('.h-value') as HTMLElement, value, scheduleDocumentUpdate);
  tbody.appendChild(tr);
  updateBadges();
}

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
    pre.innerHTML = lines.map(line =>
      '<div class="code-line">' + highlight(line, currentLang) + '\n</div>'
    ).join('');
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

$('bodyHighlight').addEventListener('click', (e: Event) => {
  const target = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
  if (target && target.dataset.var) {
    showVarTooltipAt(target, target.dataset.var, tooltipCtx());
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

$('url').addEventListener('click', (e: Event) => {
  const target = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
  if (target && target.dataset.var) {
    showVarTooltipAt(target, target.dataset.var, tooltipCtx());
  }
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
      showVarTooltipAt(varEl, varEl.dataset.var, tooltipCtx());
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

// ── Auth Type ───────────────────────────────
const requestAuthConfig: import('./authFields').AuthFieldsConfig = {
  prefix: 'auth',
  get fieldsContainer() { return $('authFields'); },
  onChange: () => scheduleDocumentUpdate(),
  showInherit: true,
  wrapInputs: true,
  showTokenStatus: true,
  onFieldsRendered: (inputs) => inputs.forEach(enableVarOverlay),
};

function onAuthTypeChange(): void {
  const type = ($('authType') as HTMLSelectElement).value;
  renderAuthFields(type, requestAuthConfig);
}

// ── OAuth2 Token Status ─────────────────────────
function getOAuth2AuthFromForm(): any {
  const flow = ($('oauth2Flow') as HTMLSelectElement)?.value || 'client_credentials';
  const auth: any = {
    type: 'oauth2',
    flow,
    accessTokenUrl: $input('oauth2AccessTokenUrl')?.value || '',
    clientId: $input('oauth2ClientId')?.value || '',
    clientSecret: $input('oauth2ClientSecret')?.value || '',
    scope: $input('oauth2Scope')?.value || '',
    refreshTokenUrl: $input('oauth2RefreshTokenUrl')?.value || '',
    credentialsPlacement: ($('oauth2CredentialsPlacement') as HTMLSelectElement)?.value || 'basic_auth_header',
    credentialsId: (currentRequest as any)?.http?.auth?.credentialsId,
    autoFetchToken: ($('oauth2AutoFetch') as HTMLInputElement)?.checked !== false,
    autoRefreshToken: ($('oauth2AutoRefresh') as HTMLInputElement)?.checked !== false,
  };
  if (flow === 'password') {
    auth.username = $input('oauth2Username')?.value || '';
    auth.password = $input('oauth2Password')?.value || '';
  }
  return auth;
}

function requestTokenStatus(): void {
  if (($('authType') as HTMLSelectElement)?.value !== 'oauth2') return;
  const auth = getOAuth2AuthFromForm();
  if (auth.accessTokenUrl) {
    vscode.postMessage({ type: 'getTokenStatus', auth });
  }
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

let tokenStatusTimer: any = null;

function updateOAuth2TokenStatus(status: any): void {
  const el = document.getElementById('oauth2TokenStatus');
  if (!el) return;

  if (tokenStatusTimer) { clearInterval(tokenStatusTimer); tokenStatusTimer = null; }

  if (!status.hasToken) {
    el.innerHTML = '<div class="token-status token-none">' +
      '<span class="token-dot dot-none"></span> No token' +
      '<button class="token-btn" id="oauth2GetTokenBtn">Get Token</button></div>';
    el.querySelector('#oauth2GetTokenBtn')?.addEventListener('click', () => {
      const auth = getOAuth2AuthFromForm();
      vscode.postMessage({ type: 'getToken', auth });
    });
    return;
  }

  const renderStatus = () => {
    const now = Date.now();
    const remaining = status.expiresAt ? status.expiresAt - now : undefined;
    const isExpired = remaining !== undefined && remaining <= 0;
    const dotClass = isExpired ? 'dot-expired' : 'dot-valid';
    const label = isExpired ? 'Expired' : remaining !== undefined ? `Expires in ${formatTimeRemaining(remaining)}` : 'Valid (no expiry)';
    const expiresAt = status.expiresAt ? new Date(status.expiresAt).toLocaleTimeString() : '';
    el.innerHTML = '<div class="token-status ' + (isExpired ? 'token-expired' : 'token-valid') + '">' +
      '<span class="token-dot ' + dotClass + '"></span> ' + label +
      (expiresAt ? '<span class="token-expiry-time"> (' + expiresAt + ')</span>' : '') +
      '<button class="token-btn" id="oauth2RefreshTokenBtn">' + (isExpired ? 'Get Token' : 'Refresh') + '</button>' +
      '</div>';
    el.querySelector('#oauth2RefreshTokenBtn')?.addEventListener('click', () => {
      const auth = getOAuth2AuthFromForm();
      vscode.postMessage({ type: 'getToken', auth });
    });
  };

  renderStatus();
  if (status.expiresAt) {
    tokenStatusTimer = setInterval(() => {
      renderStatus();
      if (status.expiresAt && Date.now() > status.expiresAt) {
        clearInterval(tokenStatusTimer);
        tokenStatusTimer = null;
      }
    }, 1000);
  }
}

function updateOAuth2Progress(message: string): void {
  const el = document.getElementById('oauth2TokenStatus');
  if (!el) return;
  if (message) {
    const isError = message.startsWith('Error:');
    el.innerHTML = '<div class="token-status ' + (isError ? 'token-error' : 'token-progress') + '">' +
      (isError ? '<span class="token-dot dot-expired"></span> ' : '<span class="token-spinner"></span> ') +
      esc(message) + '</div>';
  }
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
      value: ((tr.querySelector('.p-value') as any)._getRawText ? (tr.querySelector('.p-value') as any)._getRawText() : (tr.querySelector('.p-value') as HTMLElement).textContent || ''),
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
  } else {
    ($('authType') as HTMLSelectElement).value = 'none';
  }
  onAuthTypeChange();
  if (auth && auth !== 'inherit' && auth.type) {
    setTimeout(() => {
      loadAuthData(auth, 'auth');
      syncAllVarOverlays();
      requestTokenStatus();
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
      showResponse(msg.response);
      requestTokenStatus();
      break;
    case 'sending':
      $('sendBtn').classList.add('sending');
      ($('sendBtn') as HTMLButtonElement).disabled = true;
      $('sendBtn').textContent = 'Sending...';
      if (msg.message) setLoadingText(msg.message);
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
      requestTokenStatus();
      break;
    }
    case 'secretValueResolved':
      handleSecretValueResolved(msg);
      break;
    case 'oauth2TokenStatus':
      updateOAuth2TokenStatus(msg.status);
      break;
    case 'oauth2Progress':
      updateOAuth2Progress(msg.message);
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
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    sendRequest();
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
