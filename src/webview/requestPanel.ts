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
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import clojure from 'highlight.js/lib/languages/clojure';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import http from 'highlight.js/lib/languages/http';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import kotlin from 'highlight.js/lib/languages/kotlin';
import objectivec from 'highlight.js/lib/languages/objectivec';
import ocaml from 'highlight.js/lib/languages/ocaml';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import swift from 'highlight.js/lib/languages/swift';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('clojure', clojure);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('go', go);
hljs.registerLanguage('http', http);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('objectivec', objectivec);
hljs.registerLanguage('ocaml', ocaml);
hljs.registerLanguage('php', php);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('r', r);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('swift', swift);

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
  renderPreview, initPreviewMediaControls,
} from './response';
import { initResponseSearch, openSearch, closeSearch, isSearchOpen } from './responseSearch';
import { canFormatRawBody, formatRawBody } from './requestBodyFormatter';
import {
  applyRequestEditorModel,
  cloneJson,
  detectRequestProtocol,
  isVisualEditableRequest,
  type FormFieldEditorRow,
  type KeyValueEditorRow,
  type RequestEditorBodyModel,
  type RequestEditorModel,
  type RuntimeEditorModel,
} from '../models/schemaRoundTrip';

// ── Document update scheduling ───────────────────
let _selectedBodyVariantIndex: number | undefined;
let _selectedFileVariantIndex: number | undefined;
type PanelProtocol = 'http' | 'graphql' | 'websocket' | 'grpc';
let _currentProtocol: PanelProtocol = 'http';
type WebSocketSessionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'closed' | 'error';
interface WebSocketSessionEvent {
  timestamp: string;
  direction: 'event' | 'outbound' | 'inbound' | 'error';
  type: string;
  data?: string;
  closeCode?: number;
  reason?: string;
}
interface WebSocketSessionSnapshot {
  requestId: string;
  state: WebSocketSessionState;
  url?: string;
  events: WebSocketSessionEvent[];
  inboundCount: number;
  outboundCount: number;
  lastError?: string;
}
let _webSocketSession: WebSocketSessionSnapshot = {
  requestId: '',
  state: 'disconnected',
  events: [],
  inboundCount: 0,
  outboundCount: 0,
};
let _webSocketVisibleEvents: WebSocketSessionEvent[] = [];

function detectPanelProtocol(req: any): PanelProtocol {
  const detectedProtocol = detectRequestProtocol(req);
  return detectedProtocol === 'graphql' || detectedProtocol === 'websocket' || detectedProtocol === 'grpc'
    ? detectedProtocol
    : 'http';
}

function setEditorHydrationState(
  state: 'pending' | 'ready' | 'invalid',
  protocol: PanelProtocol | 'pending' = 'pending',
  message?: string,
): void {
  const shell = $('requestEditorShell');
  const startup = $('requestStartupShell');
  const title = $('requestStartupTitle');
  const detail = $('requestStartupDetail');

  shell.classList.toggle('is-hydrating', state === 'pending');
  shell.classList.toggle('is-ready', state === 'ready');
  shell.classList.toggle('is-invalid-yaml', state === 'invalid');
  shell.dataset.hydrationState = state;
  shell.dataset.protocol = protocol;
  shell.setAttribute('aria-busy', state === 'pending' ? 'true' : 'false');

  startup.style.display = state === 'ready' ? 'none' : 'flex';
  if (state === 'invalid') {
    title.textContent = 'Request YAML could not be loaded';
    detail.textContent = message || 'Fix the YAML source and the editor will reload.';
  } else {
    title.textContent = 'Loading request';
    detail.textContent = protocol === 'pending' ? 'Preparing editor...' : 'Preparing ' + protocol + ' editor...';
  }
}

function scheduleDocumentUpdate(): void {
  if (updateDocumentTimer) clearTimeout(updateDocumentTimer);
  setUpdateDocumentTimer(setTimeout(() => {
    setIgnoreNextLoad(true);
    const req = buildRequest();
    vscode.postMessage({ type: 'updateDocument', request: req });
  }, 300));
}

function webSocketCanSend(): boolean {
  return _currentProtocol === 'websocket' && _webSocketSession.state === 'connected';
}

function updateWebSocketControls(): void {
  const isWebSocket = _currentProtocol === 'websocket';
  const connectBtn = $('sendBtn') as HTMLButtonElement;
  const sendMessageBtn = $('wsSendBtn') as HTMLButtonElement;
  const disconnectBtn = $('wsDisconnectBtn') as HTMLButtonElement;
  sendMessageBtn.style.display = isWebSocket ? '' : 'none';
  disconnectBtn.style.display = isWebSocket ? '' : 'none';
  if (!isWebSocket) return;

  const state = _webSocketSession.state;
  const connecting = state === 'connecting';
  const connected = state === 'connected';
  const disconnecting = state === 'disconnecting';
  connectBtn.textContent = connecting ? 'Connecting' : connected ? 'Connected' : 'Connect';
  connectBtn.disabled = connecting || connected || disconnecting;
  sendMessageBtn.disabled = !connected;
  disconnectBtn.disabled = !(connecting || connected || disconnecting);
  disconnectBtn.textContent = disconnecting ? 'Disconnecting' : 'Disconnect';
}

function setWebSocketSession(session: WebSocketSessionSnapshot): void {
  _webSocketSession = {
    requestId: session.requestId,
    state: session.state || 'disconnected',
    url: session.url,
    events: Array.isArray(session.events) ? session.events : [],
    inboundCount: session.inboundCount ?? 0,
    outboundCount: session.outboundCount ?? 0,
    lastError: session.lastError,
  };
  _webSocketVisibleEvents = _webSocketSession.events.slice();
  renderWebSocketSession();
}

function renderWebSocketSession(): void {
  const panel = $('webSocketSessionPanel');
  panel.style.display = _currentProtocol === 'websocket' ? 'flex' : 'none';
  const badge = $('webSocketStateBadge');
  const meta = $('webSocketSessionMeta');
  const history = $('webSocketHistory');
  const state = _webSocketSession.state || 'disconnected';
  badge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  badge.className = 'websocket-state-badge websocket-state-' + state;
  meta.textContent = [
    _webSocketSession.url || '',
    `${_webSocketSession.outboundCount ?? 0} sent`,
    `${_webSocketSession.inboundCount ?? 0} received`,
    _webSocketSession.lastError ? `Error: ${_webSocketSession.lastError}` : '',
  ].filter(Boolean).join(' · ');

  if (_webSocketVisibleEvents.length === 0) {
    history.innerHTML = '<div class="websocket-history-empty">No messages</div>';
  } else {
    history.innerHTML = _webSocketVisibleEvents.map((event) => {
      const label = event.direction === 'outbound'
        ? 'Sent'
        : event.direction === 'inbound'
          ? 'Received'
          : event.direction === 'error'
            ? 'Error'
            : event.type === 'close'
              ? 'Closed'
              : 'Event';
      const detail = event.type === 'close'
        ? [event.closeCode ? String(event.closeCode) : '', event.reason || ''].filter(Boolean).join(' ')
        : event.data ?? event.reason ?? '';
      const time = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';
      return [
        '<div class="websocket-history-row websocket-history-' + event.direction + '">',
        '<span class="websocket-history-time">' + escHtml(time) + '</span>',
        '<span class="websocket-history-label">' + escHtml(label) + '</span>',
        '<span class="websocket-history-type">' + escHtml(event.type) + '</span>',
        '<code class="websocket-history-data">' + escHtml(detail) + '</code>',
        '</div>',
      ].join('');
    }).join('');
    history.scrollTop = history.scrollHeight;
  }
  updateWebSocketControls();
}

function connectWebSocket(): void {
  const req = buildRequest();
  vscode.postMessage({ type: 'webSocketConnect', request: req });
}

function sendWebSocketMessage(): void {
  const req = buildRequest();
  vscode.postMessage({ type: 'webSocketSendMessage', request: req });
}

function disconnectWebSocket(): void {
  vscode.postMessage({ type: 'webSocketDisconnect' });
}

// ── Tab switching ──────────────────────────────
const reqPanelIds = ['body', 'auth', 'headers', 'params', 'runtime', 'settings', 'export'];
const respPanelIds = ['resp-body', 'resp-headers', 'resp-runtime', 'resp-preview'];

function updateBodyFormatterState(): void {
  const button = $('bodyFormatBtn') as HTMLButtonElement;
  if (_currentProtocol === 'graphql') {
    button.style.display = 'inline-flex';
    button.disabled = false;
    button.title = 'Format GraphQL variables';
    return;
  }

  const isRawBody = currentBodyType === 'raw';
  const canFormat = isRawBody && currentLang !== 'binary' && canFormatRawBody(currentLang);

  button.style.display = isRawBody ? 'inline-flex' : 'none';
  button.disabled = !canFormat;
  button.title = canFormat
    ? (_currentProtocol === 'websocket' ? 'Format WebSocket message' : 'Format request body')
    : 'Formatting is available for JSON, XML, HTML, and YAML raw bodies';
}

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
    const tabId = (tab as HTMLElement).dataset.tab!;
    switchTab($('reqTabs'), tabId, reqPanelIds);
    if (tabId === 'export') requestExportPreview();
  });
});
$('respTabs').querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabId = (tab as HTMLElement).dataset.tab!;
    switchTab($('respTabs'), tabId, respPanelIds);
    if (tabId !== 'resp-body') closeSearch();
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

function addParam(name = '', value = '', type = 'query', disabled = false, originalIndex?: number): void {
  const tbody = $('paramsBody');
  const tr = document.createElement('tr');
  if (originalIndex !== undefined) tr.dataset.originalIndex = String(originalIndex);
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
function addHeader(name = '', value = '', disabled = false, originalIndex?: number): void {
  const tbody = $('headersBody');
  const tr = document.createElement('tr');
  if (originalIndex !== undefined) tr.dataset.originalIndex = String(originalIndex);
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
  if (_currentProtocol === 'graphql') {
    const query = ($('bodyData') as HTMLTextAreaElement).value;
    const variables = ($('graphqlVariablesData') as HTMLTextAreaElement).value.trim();
    const payload = `{"query":${JSON.stringify(query)},"variables":${variables || '{}'}}`;
    return new TextEncoder().encode(payload).length;
  }
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
  if (currentBodyType === 'file') return 0; // file size unknown in webview
  // Raw body types
  const data = ($('bodyData') as HTMLTextAreaElement).value;
  return new TextEncoder().encode(data).length;
}

function syncAutoHeaders(): void {
  const tbody = $('headersBody');
  // Remove all existing auto rows
  tbody.querySelectorAll('tr.auto-header').forEach(r => r.remove());

  if (_currentProtocol === 'websocket') return;
  if (currentBodyType === 'none') return;

  // Content-Type
  let ct: string | null = null;
  if (currentBodyType === 'form-urlencoded' || currentBodyType === 'multipart-form') {
    ct = _autoContentTypes[currentBodyType] ?? null;
  } else if (currentBodyType === 'file') {
    // Only advertise a Content-Type when a file has actually been selected;
    // an empty path means no body will be sent, so no header is appropriate.
    const filePath = ($('binaryFilePath') as HTMLInputElement).value.trim();
    if (filePath) {
      ct = ($('binaryContentType') as HTMLInputElement).value.trim() || 'application/octet-stream';
    }
  } else {
    ct = _currentProtocol === 'graphql'
      ? 'application/json'
      : currentLang ? (_autoContentTypes[currentLang] ?? null) : null;
  }
  if (ct && !_hasUserHeader('content-type')) {
    tbody.insertBefore(_makeAutoRow('Content-Type', ct), tbody.firstChild);
  }

  // Content-Length (not for multipart or file — size unknown in webview)
  if (currentBodyType !== 'multipart-form' && currentBodyType !== 'file' && !_hasUserHeader('content-length')) {
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
function addFormField(name = '', value: unknown = '', disabled = false, partType?: string, originalIndex?: number): void {
  const tbody = $('bodyFormBody');
  const tr = document.createElement('tr');
  if (partType) tr.dataset.partType = partType;
  if (originalIndex !== undefined) tr.dataset.originalIndex = String(originalIndex);
  const displayValue = Array.isArray(value) ? value.join(',') : String(value ?? '');
  tr.innerHTML =
    '<td><input type="checkbox" class="f-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="f-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td><input type="text" class="f-value" value="' + esc(displayValue) + '" placeholder="value" /></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); syncAutoHeaders(); scheduleDocumentUpdate(); });
  tr.addEventListener('input', () => { syncAutoHeaders(); scheduleDocumentUpdate(); });
  tr.addEventListener('change', () => { syncAutoHeaders(); scheduleDocumentUpdate(); });
  enableVarOverlay(tr.querySelector('.f-name') as HTMLInputElement);
  enableVarOverlay(tr.querySelector('.f-value') as HTMLInputElement);
  tbody.appendChild(tr);
}

const runtimeScriptTypes = ['before-request', 'after-response', 'tests'];
const runtimeAssertionOperators = [
  'equals',
  'not-equals',
  'contains',
  'exists',
  'not-exists',
  'greater-than',
  'greater-than-or-equal',
  'less-than',
  'less-than-or-equal',
  'matches',
];
const runtimeActionPhases = ['before-request', 'after-response'];
const runtimeVariableScopes = ['runtime', 'request'];
const unsupportedRuntimeScriptTypeLabels: Record<string, string> = {
  hooks: 'hooks (not executed)',
};
const unsupportedRuntimeVariableScopeLabels: Record<string, string> = {
  folder: 'folder (not persisted)',
  collection: 'collection (not persisted)',
  environment: 'environment (not persisted)',
};

function unsupportedRuntimeOptionLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? `${value} (unsupported)`;
}

function optionsHtml(values: string[], selected: string | undefined, unsupportedLabels?: Record<string, string>): string {
  const knownOptions = values.map(value => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(value) + '</option>').join('');
  if (selected && !values.includes(selected)) {
    return '<option value="' + esc(selected) + '" selected disabled data-runtime-unsupported="true">' + esc(unsupportedRuntimeOptionLabel(selected, unsupportedLabels ?? {})) + '</option>' + knownOptions;
  }
  return knownOptions;
}

function moveRuntimeRow(row: HTMLElement, direction: -1 | 1): void {
  const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling || !row.parentElement) return;
  if (direction < 0) row.parentElement.insertBefore(row, sibling);
  else row.parentElement.insertBefore(sibling, row);
  scheduleDocumentUpdate();
}

function wireRuntimeRow(row: HTMLElement): void {
  row.addEventListener('input', scheduleDocumentUpdate);
  row.addEventListener('change', scheduleDocumentUpdate);
  row.querySelector<HTMLButtonElement>('.runtime-move-up')?.addEventListener('click', () => moveRuntimeRow(row, -1));
  row.querySelector<HTMLButtonElement>('.runtime-move-down')?.addEventListener('click', () => moveRuntimeRow(row, 1));
  row.querySelector<HTMLButtonElement>('.runtime-delete')?.addEventListener('click', () => {
    row.remove();
    updateRuntimeBadge();
    scheduleDocumentUpdate();
  });
}

function addRuntimeScript(type = 'before-request', code = '', disabled = false, originalIndex?: number): void {
  const list = $('runtimeScriptsList');
  const row = document.createElement('div');
  row.className = 'runtime-editor-row runtime-script-row';
  const unsupportedType = !runtimeScriptTypes.includes(type);
  if (unsupportedType) row.classList.add('runtime-unsupported-row');
  if (originalIndex !== undefined) row.dataset.originalIndex = String(originalIndex);
  row.innerHTML =
    '<div class="runtime-row-toolbar">' +
      '<input type="checkbox" class="runtime-enabled rt-script-enabled" title="Enabled" ' + (disabled ? '' : 'checked') + ' />' +
      '<select class="runtime-select rt-script-type">' + optionsHtml(runtimeScriptTypes, type, unsupportedRuntimeScriptTypeLabels) + '</select>' +
      (unsupportedType ? '<span class="runtime-unsupported-note" title="This schema-valid script type is not executed by the Missio runtime yet.">Not executed</span>' : '') +
      '<div class="runtime-row-actions">' +
        '<button class="runtime-icon-btn runtime-move-up" type="button" title="Move up">&#8593;</button>' +
        '<button class="runtime-icon-btn runtime-move-down" type="button" title="Move down">&#8595;</button>' +
        '<button class="runtime-icon-btn runtime-delete" type="button" title="Remove">&times;</button>' +
      '</div>' +
    '</div>' +
    '<textarea class="runtime-code rt-script-code" spellcheck="false" placeholder="JavaScript">' + esc(code) + '</textarea>';
  wireRuntimeRow(row);
  list.appendChild(row);
  updateRuntimeBadge();
}

function addRuntimeAssertion(
  expression = 'res.status',
  operator = 'equals',
  value = '200',
  disabled = false,
  description = '',
  originalIndex?: number,
): void {
  const list = $('runtimeAssertionsList');
  const row = document.createElement('div');
  row.className = 'runtime-editor-row runtime-assertion-row';
  if (originalIndex !== undefined) row.dataset.originalIndex = String(originalIndex);
  row.innerHTML =
    '<div class="runtime-row-toolbar">' +
      '<input type="checkbox" class="runtime-enabled rt-assertion-enabled" title="Enabled" ' + (disabled ? '' : 'checked') + ' />' +
      '<input type="text" class="runtime-input rt-assertion-expression" value="' + esc(expression) + '" placeholder="res.status" />' +
      '<select class="runtime-select rt-assertion-operator">' + optionsHtml(runtimeAssertionOperators, operator) + '</select>' +
      '<input type="text" class="runtime-input rt-assertion-value" value="' + esc(value) + '" placeholder="expected" />' +
      '<div class="runtime-row-actions">' +
        '<button class="runtime-icon-btn runtime-move-up" type="button" title="Move up">&#8593;</button>' +
        '<button class="runtime-icon-btn runtime-move-down" type="button" title="Move down">&#8595;</button>' +
        '<button class="runtime-icon-btn runtime-delete" type="button" title="Remove">&times;</button>' +
      '</div>' +
    '</div>' +
    '<input type="text" class="runtime-input runtime-description rt-assertion-description" value="' + esc(description) + '" placeholder="description" />';
  wireRuntimeRow(row);
  list.appendChild(row);
  updateRuntimeBadge();
}

function addRuntimeAction(
  phase = 'after-response',
  selectorExpression = '$.token',
  variableScope = 'runtime',
  variableName = 'token',
  disabled = false,
  description = '',
  originalIndex?: number,
): void {
  const list = $('runtimeActionsList');
  const row = document.createElement('div');
  row.className = 'runtime-editor-row runtime-action-row';
  const unsupportedScope = !runtimeVariableScopes.includes(variableScope);
  if (unsupportedScope) row.classList.add('runtime-unsupported-row');
  if (originalIndex !== undefined) row.dataset.originalIndex = String(originalIndex);
  row.innerHTML =
    '<div class="runtime-row-toolbar">' +
      '<input type="checkbox" class="runtime-enabled rt-action-enabled" title="Enabled" ' + (disabled ? '' : 'checked') + ' />' +
      '<select class="runtime-select rt-action-phase">' + optionsHtml(runtimeActionPhases, phase) + '</select>' +
      '<span class="runtime-action-type">set-variable</span>' +
      '<input type="text" class="runtime-input rt-action-selector" value="' + esc(selectorExpression) + '" placeholder="$.token" />' +
      '<select class="runtime-select rt-action-scope">' + optionsHtml(runtimeVariableScopes, variableScope, unsupportedRuntimeVariableScopeLabels) + '</select>' +
      '<input type="text" class="runtime-input rt-action-name" value="' + esc(variableName) + '" placeholder="name" />' +
      (unsupportedScope ? '<span class="runtime-unsupported-note" title="This schema-valid scope is not persisted by the Missio runtime yet.">Not persisted</span>' : '') +
      '<div class="runtime-row-actions">' +
        '<button class="runtime-icon-btn runtime-move-up" type="button" title="Move up">&#8593;</button>' +
        '<button class="runtime-icon-btn runtime-move-down" type="button" title="Move down">&#8595;</button>' +
        '<button class="runtime-icon-btn runtime-delete" type="button" title="Remove">&times;</button>' +
      '</div>' +
    '</div>' +
    '<input type="text" class="runtime-input runtime-description rt-action-description" value="' + esc(description) + '" placeholder="description" />';
  wireRuntimeRow(row);
  list.appendChild(row);
  updateRuntimeBadge();
}

function loadRuntimeEditor(runtime: any): void {
  $('runtimeScriptsList').innerHTML = '';
  $('runtimeAssertionsList').innerHTML = '';
  $('runtimeActionsList').innerHTML = '';
  (runtime?.scripts || []).forEach((script: any, index: number) => {
    addRuntimeScript(script.type || 'before-request', script.code || '', script.disabled, index);
  });
  (runtime?.assertions || []).forEach((assertion: any, index: number) => {
    const description = typeof assertion.description === 'string'
      ? assertion.description
      : assertion.description?.content || '';
    addRuntimeAssertion(
      assertion.expression || '',
      assertion.operator || 'equals',
      assertion.value ?? '',
      assertion.disabled,
      description,
      index,
    );
  });
  (runtime?.actions || []).forEach((action: any, index: number) => {
    const description = typeof action.description === 'string'
      ? action.description
      : action.description?.content || '';
    addRuntimeAction(
      action.phase || 'after-response',
      action.selector?.expression || '',
      action.variable?.scope || 'runtime',
      action.variable?.name || '',
      action.disabled,
      description,
      index,
    );
  });
  updateRuntimeBadge();
}

function updateRuntimeBadge(): void {
  const count =
    document.querySelectorAll('#runtimeScriptsList .runtime-editor-row').length +
    document.querySelectorAll('#runtimeAssertionsList .runtime-editor-row').length +
    document.querySelectorAll('#runtimeActionsList .runtime-editor-row').length;
  const badge = document.getElementById('runtimeBadge');
  if (badge) badge.textContent = String(count);
}

function updateBadges(): void {
  const params = document.querySelectorAll('#paramsBody tr');
  const headers = document.querySelectorAll('#headersBody tr:not(.auto-header)');
  $('paramsBadge').textContent = String(params.length);
  $('headersBadge').textContent = String(headers.length);
  updateRuntimeBadge();
}

// ── Body Type (pills) ───────────────────────────
function setBodyType(type: string): void {
  setCurrentBodyType(type);
  document.querySelectorAll('#bodyTypePills .pill').forEach((p) => {
    p.classList.toggle('active', (p as HTMLElement).dataset.bodyType === type);
  });
  const raw = $('bodyRawEditor');
  const form = $('bodyFormEditor');
  const binary = $('bodyBinaryEditor');
  const graphQLVariables = $('graphqlVariablesEditor');
  const langSelect = $('bodyLangMode');
  if (type === 'none') {
    raw.style.display = 'none';
    form.style.display = 'none';
    binary.style.display = 'none';
    graphQLVariables.style.display = 'none';
    langSelect.style.display = 'none';
  } else if (type === 'form-urlencoded' || type === 'multipart-form') {
    raw.style.display = 'none';
    form.style.display = 'block';
    binary.style.display = 'none';
    graphQLVariables.style.display = 'none';
    langSelect.style.display = 'none';
  } else if (type === 'file') {
    raw.style.display = 'none';
    form.style.display = 'none';
    binary.style.display = 'flex';
    graphQLVariables.style.display = 'none';
    langSelect.style.display = 'none';
  } else {
    raw.style.display = 'flex';
    raw.style.flexDirection = 'column';
    raw.style.flex = '1';
    form.style.display = 'none';
    binary.style.display = 'none';
    graphQLVariables.style.display = _currentProtocol === 'graphql' ? 'flex' : 'none';
    langSelect.style.display = _currentProtocol === 'graphql' ? 'none' : 'block';
    syncHighlight();
  }
  updateBodyFormatterState();
  syncAutoContentType();
}

function setRequestTabVisible(tabId: string, visible: boolean): void {
  const tab = document.querySelector<HTMLElement>('#reqTabs [data-tab="' + tabId + '"]');
  const panel = document.getElementById('panel-' + tabId);
  if (tab) tab.style.display = visible ? '' : 'none';
  if (panel) panel.style.display = visible ? '' : 'none';
}

function setProtocolUi(protocol: PanelProtocol): void {
  _currentProtocol = protocol;
  const isGraphQL = protocol === 'graphql';
  const isWebSocket = protocol === 'websocket';
  const isGrpc = protocol === 'grpc';
  const methodPicker = $('methodPicker') as HTMLElement;
  const protocolIcon = $('protocolIcon') as HTMLElement;
  const protocolLabels: Record<PanelProtocol, string> = {
    http: 'HTTP',
    graphql: 'GraphQL',
    websocket: 'WebSocket',
    grpc: 'gRPC',
  };
  const protocolIcons: Record<PanelProtocol, string> = {
    http: 'globe',
    graphql: 'type-hierarchy',
    websocket: 'plug',
    grpc: 'radio-tower',
  };
  methodPicker.style.display = (isWebSocket || isGrpc) ? 'none' : '';
  protocolIcon.className = 'codicon codicon-' + protocolIcons[protocol] + ' protocol-icon protocol-icon-' + protocol;
  protocolIcon.dataset.protocol = protocol;
  protocolIcon.setAttribute('aria-label', protocolLabels[protocol] + ' request type');
  protocolIcon.setAttribute('title', protocolLabels[protocol] + ' request type');

  setRequestTabVisible('params', !isWebSocket && !isGrpc);
  setRequestTabVisible('settings', !isWebSocket && !isGrpc);
  setRequestTabVisible('export', !isWebSocket && !isGrpc);
  const bodyTab = document.querySelector<HTMLElement>('#reqTabs [data-tab="body"]');
  if (bodyTab) bodyTab.textContent = (isWebSocket || isGrpc) ? 'Message' : 'Body';
  if ((isWebSocket || isGrpc) && ['params', 'settings', 'export'].some(tabId => document.getElementById('panel-' + tabId)?.classList.contains('active'))) {
    switchTab($('reqTabs'), 'body', reqPanelIds);
  }

  $('bodyTypePills').style.display = (isGraphQL || isWebSocket || isGrpc) ? 'none' : 'flex';
  const bodyData = $('bodyData') as HTMLTextAreaElement;
  bodyData.placeholder = isGraphQL
    ? 'query Example { viewer { id name } }'
    : isWebSocket || isGrpc
      ? 'Message payload'
      : '';
  (document.getElementById('url') as HTMLElement).setAttribute(
    'data-placeholder',
    isWebSocket ? '{{wsBaseUrl}}/echo' : isGrpc ? '{{grpcBaseUrl}}' : '{{baseUrl}}/api/endpoint',
  );

  if (!isSending) {
    $('sendBtn').textContent = isWebSocket ? 'Connect' : isGrpc ? 'Invoke' : 'Send';
  }
  ($('wsSendBtn') as HTMLElement).style.display = isWebSocket ? '' : 'none';
  ($('wsDisconnectBtn') as HTMLElement).style.display = isWebSocket ? '' : 'none';
  $('webSocketSessionPanel').style.display = isWebSocket ? 'flex' : 'none';
  $('saveExampleBtn').style.display = (isWebSocket || isGrpc) ? 'none' : '';
  $('refreshOAuthRetryBtn').style.display = 'none';

  if (isGraphQL) {
    setCurrentLang('text');
    ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
    setBodyType('raw');
  } else if (isWebSocket || isGrpc) {
    setCurrentLang(isGrpc ? 'json' : 'text');
    ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
    setBodyType('raw');
  } else {
    $('graphqlVariablesEditor').style.display = 'none';
  }
  updateBodyFormatterState();
  renderWebSocketSession();
  syncAutoHeaders();
}

document.querySelectorAll('#bodyTypePills .pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    setBodyType((pill as HTMLElement).dataset.bodyType!);
    scheduleDocumentUpdate();
  });
});

// ── Binary file chooser ──────────────────
$('chooseBinaryFileBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'chooseFile' });
});
$('binaryContentType').addEventListener('input', () => {
  syncAutoHeaders();
  scheduleDocumentUpdate();
});
$('binaryFilePath').addEventListener('input', () => {
  syncAutoHeaders();
  scheduleDocumentUpdate();
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

function applyFormattedBody(formatted: string): void {
  const textarea = $('bodyData') as HTMLTextAreaElement;
  textarea.value = formatted;
  syncHighlight();
  syncAutoContentType();
  scheduleDocumentUpdate();
}

function formatCurrentBody(): void {
  if (_currentProtocol === 'graphql') {
    const textarea = $('graphqlVariablesData') as HTMLTextAreaElement;
    try {
      const raw = textarea.value.trim();
      if (!raw) return;
      const formatted = JSON.stringify(JSON.parse(raw), null, _indentChar);
      if (formatted === textarea.value) return;
      textarea.value = formatted;
      scheduleDocumentUpdate();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to format GraphQL variables';
      vscode.postMessage({ type: 'showError', message: `Could not format GraphQL variables: ${message}` });
    }
    return;
  }

  if (currentBodyType !== 'raw' || !canFormatRawBody(currentLang)) {
    return;
  }

  const textarea = $('bodyData') as HTMLTextAreaElement;

  try {
    const formatted = formatRawBody(textarea.value, currentLang, _indentChar);
    if (formatted === textarea.value) {
      return;
    }

    applyFormattedBody(formatted);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to format request body';
    vscode.postMessage({ type: 'showError', message: `Could not format ${currentLang.toUpperCase()} body: ${message}` });
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

$('graphqlVariablesData').addEventListener('input', () => {
  if (getShowResolvedVars()) {
    breakIllusion();
  }
  handleAutocomplete($('graphqlVariablesData') as HTMLTextAreaElement, () => {});
  scheduleDocumentUpdate();
});

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

// ── Body indent char (kept in sync with VS Code editor.insertSpaces / editor.tabSize) ──
let _indentChar = '  ';

// ── Autocomplete keyboard ────────────────────────
$('bodyData').addEventListener('keydown', (e: Event) => {
  const ke = e as KeyboardEvent;
  if (isAutocompleteActive() && handleAutocompleteKeydown(ke)) return;
  if (ke.key === 'Tab') {
    e.preventDefault();
    const ta = e.target as HTMLTextAreaElement;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const indentLen = _indentChar.length;
    if (ke.shiftKey) {
      // Shift+Tab: outdent selected lines
      const val = ta.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = end;
      const block = val.substring(lineStart, lineEnd);
      const outdentRe = new RegExp('^' + _indentChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
      const outdented = block.replace(outdentRe, '');
      const removed = block.length - outdented.length;
      ta.value = val.substring(0, lineStart) + outdented + val.substring(lineEnd);
      ta.selectionStart = Math.max(lineStart, start - (val.substring(lineStart, start).startsWith(_indentChar) ? indentLen : 0));
      ta.selectionEnd = Math.max(ta.selectionStart, end - removed);
    } else if (start !== end) {
      // Tab with selection: indent all selected lines
      const val = ta.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const block = val.substring(lineStart, end);
      const indented = block.replace(/^/gm, _indentChar);
      const added = indented.length - block.length;
      ta.value = val.substring(0, lineStart) + indented + val.substring(end);
      ta.selectionStart = start + indentLen;
      ta.selectionEnd = end + added;
    } else {
      // No selection: insert indent at cursor
      ta.value = ta.value.substring(0, start) + _indentChar + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + indentLen;
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
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
function originalIndexFrom(row: Element): number | undefined {
  const raw = (row as HTMLElement).dataset.originalIndex;
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collectParams(): KeyValueEditorRow[] {
  const params: KeyValueEditorRow[] = [];
  document.querySelectorAll('#paramsBody tr').forEach((tr) => {
    const valueEl = tr.querySelector('.p-value') as any;
    params.push({
      name: (tr.querySelector('.p-name') as HTMLInputElement).value,
      value: valueEl?._getRawText ? valueEl._getRawText() : ((valueEl as HTMLElement)?.textContent || ''),
      type: (tr.querySelector('.p-type') as HTMLSelectElement).value,
      disabled: !(tr.querySelector('.p-enabled') as HTMLInputElement).checked,
      originalIndex: originalIndexFrom(tr),
    });
  });
  return params;
}

function collectHeaders(): KeyValueEditorRow[] {
  const headers: KeyValueEditorRow[] = [];
  document.querySelectorAll('#headersBody tr:not(.auto-header)').forEach((tr) => {
    const valueEl = tr.querySelector('.h-value') as any;
    headers.push({
      name: (tr.querySelector('.h-name') as HTMLInputElement).value,
      value: valueEl?._getRawText ? valueEl._getRawText() : ((valueEl as HTMLElement)?.textContent || ''),
      disabled: !(tr.querySelector('.h-enabled') as HTMLInputElement).checked,
      originalIndex: originalIndexFrom(tr),
    });
  });
  return headers;
}

function collectBodyModel(): RequestEditorBodyModel {
  if (_currentProtocol === 'graphql') {
    return {
      kind: 'graphql',
      query: ($('bodyData') as HTMLTextAreaElement).value,
      variables: ($('graphqlVariablesData') as HTMLTextAreaElement).value,
      bodyVariantIndex: _selectedBodyVariantIndex,
    };
  }

  if (currentBodyType === 'none') {
    return { kind: 'none', bodyVariantIndex: _selectedBodyVariantIndex };
  }

  if (currentBodyType === 'form-urlencoded' || currentBodyType === 'multipart-form') {
    const fields: FormFieldEditorRow[] = [];
    document.querySelectorAll('#bodyFormBody tr').forEach((tr) => {
      fields.push({
        name: (tr.querySelector('.f-name') as HTMLInputElement).value,
        value: (tr.querySelector('.f-value') as HTMLInputElement).value,
        disabled: !(tr.querySelector('.f-enabled') as HTMLInputElement).checked,
        partType: (tr as HTMLElement).dataset.partType,
        originalIndex: originalIndexFrom(tr),
      });
    });
    return { kind: currentBodyType, fields, bodyVariantIndex: _selectedBodyVariantIndex };
  }

  if (currentBodyType === 'file') {
    return {
      kind: 'file',
      filePath: ($('binaryFilePath') as HTMLInputElement).value.trim(),
      contentType: ($('binaryContentType') as HTMLInputElement).value.trim() || 'application/octet-stream',
      bodyVariantIndex: _selectedBodyVariantIndex,
      fileVariantIndex: _selectedFileVariantIndex,
    };
  }

  return {
    kind: 'raw',
    rawType: currentLang,
    data: ($('bodyData') as HTMLTextAreaElement).value,
    bodyVariantIndex: _selectedBodyVariantIndex,
  };
}

function collectRuntimeModel(): RuntimeEditorModel {
  const scripts: RuntimeEditorModel['scripts'] = [];
  document.querySelectorAll('#runtimeScriptsList .runtime-script-row').forEach((row) => {
    scripts.push({
      type: (row.querySelector('.rt-script-type') as HTMLSelectElement).value,
      code: (row.querySelector('.rt-script-code') as HTMLTextAreaElement).value,
      disabled: !(row.querySelector('.rt-script-enabled') as HTMLInputElement).checked,
      originalIndex: originalIndexFrom(row),
    });
  });

  const assertions: RuntimeEditorModel['assertions'] = [];
  document.querySelectorAll('#runtimeAssertionsList .runtime-assertion-row').forEach((row) => {
    assertions.push({
      expression: (row.querySelector('.rt-assertion-expression') as HTMLInputElement).value.trim(),
      operator: (row.querySelector('.rt-assertion-operator') as HTMLSelectElement).value,
      value: (row.querySelector('.rt-assertion-value') as HTMLInputElement).value,
      disabled: !(row.querySelector('.rt-assertion-enabled') as HTMLInputElement).checked,
      description: (row.querySelector('.rt-assertion-description') as HTMLInputElement).value,
      originalIndex: originalIndexFrom(row),
    });
  });

  const actions: RuntimeEditorModel['actions'] = [];
  document.querySelectorAll('#runtimeActionsList .runtime-action-row').forEach((row) => {
    actions.push({
      type: 'set-variable',
      phase: (row.querySelector('.rt-action-phase') as HTMLSelectElement).value,
      selectorMethod: 'jsonq',
      selectorExpression: (row.querySelector('.rt-action-selector') as HTMLInputElement).value.trim(),
      variableScope: (row.querySelector('.rt-action-scope') as HTMLSelectElement).value,
      variableName: (row.querySelector('.rt-action-name') as HTMLInputElement).value.trim(),
      disabled: !(row.querySelector('.rt-action-enabled') as HTMLInputElement).checked,
      description: (row.querySelector('.rt-action-description') as HTMLInputElement).value,
      originalIndex: originalIndexFrom(row),
    });
  });

  return { scripts, assertions, actions };
}

function buildRequestWithSchemaMerge(): any {
  if (!isVisualEditableRequest(currentRequest)) {
    return cloneJson(currentRequest ?? {});
  }

  const authType = ($('authType') as HTMLSelectElement).value;
  const model: RequestEditorModel = {
    protocol: _currentProtocol,
    method: (_currentProtocol === 'http' || _currentProtocol === 'graphql') ? (methodSelect as HTMLSelectElement).value : undefined,
    url: getUrlText(),
    params: (_currentProtocol === 'http' || _currentProtocol === 'graphql') ? collectParams() : undefined,
    headers: collectHeaders(),
    body: collectBodyModel(),
    auth: buildAuthData(authType, 'auth'),
    runtime: collectRuntimeModel(),
    settings: {
      timeout: parseInt($input('settingTimeout').value) || 30000,
      encodeUrl: $input('settingEncodeUrl').checked,
      followRedirects: $input('settingFollowRedirects').checked,
      maxRedirects: parseInt($input('settingMaxRedirects').value) || 5,
    },
  };

  return applyRequestEditorModel(currentRequest ?? {}, model);
}

function buildRequest(): any {
  return buildRequestWithSchemaMerge();
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
    btn.textContent = _currentProtocol === 'websocket' ? 'Connect' : _currentProtocol === 'grpc' ? 'Invoke' : 'Send';
    btn.disabled = false;
  }
  updateWebSocketControls();
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
function loadRequest(req: any): PanelProtocol {
  setCurrentRequest(req);
  $('exampleIndicator').style.display = 'none';
  const protocol = detectPanelProtocol(req);
  setProtocolUi(protocol);
  const details = protocol === 'websocket'
    ? (req.websocket || {})
    : protocol === 'graphql'
      ? (req.graphql || {})
      : protocol === 'grpc'
        ? (req.grpc || {})
        : (req.http || {});
  if (protocol === 'http' || protocol === 'graphql') {
    (methodSelect as HTMLSelectElement).value = (details.method || (protocol === 'graphql' ? 'POST' : 'GET')).toUpperCase();
    updateMethodColor();
  }

  // Params — load first so composeDisplayUrl works when we set the URL
  $('paramsBody').innerHTML = '';
  (details.params || []).forEach((p: any, index: number) => addParam(p.name, p.value, p.type || 'query', p.disabled, index));

  // Strip baked-in query string from URL when params array has query params
  let loadUrl = details.url || '';
  const hasQueryParams = (details.params || []).some((p: any) => (p.type || 'query') === 'query');
  if (hasQueryParams && loadUrl.includes('?')) {
    loadUrl = loadUrl.split('?')[0];
  }
  setUrlText(loadUrl);

  // Headers
  $('headersBody').innerHTML = '';
  const headerRows = protocol === 'grpc' ? details.metadata : details.headers;
  (headerRows || []).forEach((h: any, index: number) => addHeader(h.name, h.value, h.disabled, index));

  // Body
  _selectedBodyVariantIndex = undefined;
  _selectedFileVariantIndex = undefined;
  ($('graphqlVariablesData') as HTMLTextAreaElement).value = '';
  const requestBody = (protocol === 'websocket' || protocol === 'grpc') ? details.message : details.body;
  if (requestBody) {
    _selectedBodyVariantIndex = Array.isArray(requestBody)
      ? Math.max(0, requestBody.findIndex((v: any) => v.selected))
      : undefined;
    const body = Array.isArray(requestBody)
      ? (protocol === 'websocket' || protocol === 'grpc'
          ? requestBody[_selectedBodyVariantIndex ?? 0]?.message
          : requestBody[_selectedBodyVariantIndex ?? 0]?.body)
      : requestBody;
    if (body) {
      if (protocol === 'graphql') {
        setBodyType('raw');
        setCurrentLang('text');
        ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
        updateBodyFormatterState();
        syncAutoContentType();
        ($('bodyData') as HTMLTextAreaElement).value = body.query ?? '';
        ($('graphqlVariablesData') as HTMLTextAreaElement).value = body.variables ?? '';
        syncHighlight();
      } else if (protocol === 'websocket') {
        setBodyType('raw');
        setCurrentLang(body.type || 'text');
        ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
        updateBodyFormatterState();
        ($('bodyData') as HTMLTextAreaElement).value = body.data ?? '';
        syncHighlight();
      } else if (protocol === 'grpc') {
        setBodyType('raw');
        setCurrentLang('json');
        ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
        updateBodyFormatterState();
        ($('bodyData') as HTMLTextAreaElement).value = typeof body === 'string' ? body : (body.message ?? '');
        syncHighlight();
      } else if (body.type === 'form-urlencoded' || body.type === 'multipart-form') {
        setBodyType(body.type);
        $('bodyFormBody').innerHTML = '';
        (body.data || []).forEach((f: any, index: number) => addFormField(f.name, f.value, f.disabled, f.type, index));
      } else if (body.type === 'file') {
        setBodyType('file');
        _selectedFileVariantIndex = Math.max(0, (body.data || []).findIndex((v: any) => v.selected));
        const variant = body.data?.[_selectedFileVariantIndex ?? 0];
        ($('binaryFilePath') as HTMLInputElement).value = variant?.filePath ?? '';
        ($('binaryContentType') as HTMLInputElement).value = variant?.contentType ?? '';
        syncAutoHeaders();
      } else {
        setBodyType('raw');
        setCurrentLang(body.type || 'json');
        ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
        updateBodyFormatterState();
        syncAutoContentType();
        ($('bodyData') as HTMLTextAreaElement).value = body.data ?? '';
        syncHighlight();
      }
    }
  } else {
    if (protocol === 'graphql') {
      setBodyType('raw');
      ($('bodyData') as HTMLTextAreaElement).value = '';
      syncHighlight();
    } else if (protocol === 'websocket' || protocol === 'grpc') {
      setBodyType('raw');
      ($('bodyData') as HTMLTextAreaElement).value = '';
      syncHighlight();
    } else {
      setBodyType('none');
    }
  }

  // Auth — read from runtime.auth per OpenCollection schema
  const runtime = currentRequest.runtime || {};
  loadRuntimeEditor(runtime);
  const auth = runtime.auth;
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
  return protocol;
}

// ── CLI Approval Modal ───────────────────────────
function showCliApprovalModal(commandTemplate: string, interpolatedCommand: string): void {
  // Remove any existing modal
  const existing = document.getElementById('cliApprovalModal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cliApprovalModal';
  overlay.className = 'uv-modal-overlay';

  const card = document.createElement('div');
  card.className = 'uv-modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'cliApprovalModalTitle');

  // Header
  const header = document.createElement('div');
  header.className = 'uv-modal-header';
  header.innerHTML =
    '<div class="uv-modal-title" id="cliApprovalModalTitle">Approve CLI Auth Command</div>' +
    '<div class="uv-modal-subtitle">This request uses CLI-based authentication. Review and approve the command before it runs.</div>';
  card.appendChild(header);

  // Content
  const content = document.createElement('div');
  content.className = 'uv-modal-fields';

  // Warning
  const warning = document.createElement('div');
  warning.className = 'cli-approval-warning';
  warning.innerHTML =
    '<span class="cli-approval-warning-icon">⚠️</span>' +
    '<span>CLI commands can execute arbitrary code on your system. Only approve commands from collections you trust.</span>';
  content.appendChild(warning);

  // Command display
  const cmdLabel = document.createElement('div');
  cmdLabel.className = 'uv-modal-label';
  cmdLabel.style.marginTop = '8px';
  cmdLabel.textContent = 'Command to execute:';
  content.appendChild(cmdLabel);

  const cmdDisplay = document.createElement('div');
  cmdDisplay.className = 'cli-approval-command';
  cmdDisplay.textContent = interpolatedCommand;
  content.appendChild(cmdDisplay);

  card.appendChild(content);

  // Buttons
  const actions = document.createElement('div');
  actions.className = 'uv-modal-actions';
  actions.innerHTML =
    '<button class="uv-modal-cancel">Deny</button>' +
    '<button class="uv-modal-send">Approve &amp; Run</button>';
  card.appendChild(actions);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', keyHandler);
    overlay.remove();
  };

  const deny = () => {
    cleanup();
    vscode.postMessage({ type: 'cliApprovalResponse', approved: false });
  };

  const approve = () => {
    cleanup();
    vscode.postMessage({ type: 'cliApprovalResponse', approved: true });
  };

  // Wire deny
  const denyBtn = card.querySelector('.uv-modal-cancel') as HTMLButtonElement;
  denyBtn.addEventListener('click', deny);

  // Wire approve
  const approveBtn = card.querySelector('.uv-modal-send') as HTMLButtonElement;
  approveBtn.addEventListener('click', approve);

  // Escape denies, Enter approves
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      deny();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      approve();
    }
  };
  document.addEventListener('keydown', keyHandler);

  // Focus approve button
  setTimeout(() => approveBtn.focus(), 50);
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
      try {
        const protocol = loadRequest(msg.request);
        setEditorHydrationState('ready', protocol);
      } catch (error) {
        console.error('Failed to render request editor state', error);
        setEditorHydrationState('invalid', 'pending', 'Unable to render this request.');
      }
      break;
    case 'requestLoadError':
      setEditorHydrationState('invalid', 'pending', msg.message);
      break;
    case 'response':
      $('exampleIndicator').style.display = 'none';
      closeSearch();
      showResponse(msg.response, msg.preRequestMs, msg.timing, msg.usedOAuth2);
      setSendingState(false);
      tokenStatusCtrl.requestStatus();
      break;
    case 'webSocketSession':
      hideLoading();
      setSendingState(false);
      setWebSocketSession(msg.session as WebSocketSessionSnapshot);
      break;
    case 'webSocketConnecting':
      showLoading();
      setLoadingText('Connecting WebSocket...');
      setWebSocketSession({
        ..._webSocketSession,
        state: 'connecting',
      });
      break;
    case 'webSocketProgress':
      if (msg.message) setLoadingText(msg.message);
      break;
    case 'webSocketError':
      hideLoading();
      setSendingState(false);
      setWebSocketSession({
        ..._webSocketSession,
        state: 'error',
        lastError: msg.message ?? 'WebSocket error',
      });
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
    case 'exportComplete': {
      if (msg.action === 'copy') {
        const btn = $('exportCopyBtn');
        const orig = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }
      break;
    }
    case 'exportPreview': {
      // Ignore stale responses from superseded requests
      if (msg.seq !== undefined && msg.seq !== _exportSeq) break;
      clearTimeout(_exportTimeoutTimer);
      clearTimeout(_exportSpinnerTimer);
      $('exportSpinner').style.display = 'none';
      if (msg.lang) {
        try {
          $('exportPreview').innerHTML = hljs.highlight(msg.content, { language: msg.lang }).value;
        } catch {
          $('exportPreview').textContent = msg.content;
        }
      } else {
        $('exportPreview').textContent = msg.content;
      }
      break;
    }
    case 'languageChanged':
      setCurrentLang(msg.language);
      ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
      updateBodyFormatterState();
      syncHighlight();
      break;
    case 'bodyUpdated':
      ($('bodyData') as HTMLTextAreaElement).value = msg.content;
      syncHighlight();
      break;
    case 'formatBody':
      formatCurrentBody();
      break;
    case 'fileChosen': {
      ($('binaryFilePath') as HTMLInputElement).value = msg.filePath ?? '';
      if (msg.contentType) {
        const ctInput = $('binaryContentType') as HTMLInputElement;
        const currentCt = ctInput.value.trim();
        // Always apply a specific detected type; only apply the generic fallback
        // if the field is currently empty or already holds the generic fallback.
        if (msg.contentType !== 'application/octet-stream' ||
            currentCt === '' || currentCt === 'application/octet-stream') {
          ctInput.value = msg.contentType;
        }
      }
      syncAutoHeaders();
      scheduleDocumentUpdate();
      break;
    }
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
        closeSearch();
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
      closeSearch();
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
    case 'promptCliApproval':
      showCliApprovalModal(msg.commandTemplate as string, msg.interpolatedCommand as string);
      break;
    case 'indentation':
      _indentChar = msg.insertSpaces ? ' '.repeat(msg.tabSize) : '\t';
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
  if (_currentProtocol === 'websocket') {
    connectWebSocket();
    return;
  }
  if (isSending) { cancelRequest(); } else { sendRequest(); }
});
$('wsSendBtn').addEventListener('click', () => {
  sendWebSocketMessage();
});
$('wsDisconnectBtn').addEventListener('click', () => {
  disconnectWebSocket();
});
$('wsClearHistoryBtn').addEventListener('click', () => {
  _webSocketVisibleEvents = [];
  renderWebSocketSession();
});
$('wsCopyHistoryBtn').addEventListener('click', () => {
  const text = JSON.stringify(_webSocketVisibleEvents, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    const btn = $('wsCopyHistoryBtn');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = original; }, 1200);
  });
});
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (_currentProtocol === 'websocket') {
      if (webSocketCanSend()) sendWebSocketMessage();
      else connectWebSocket();
      return;
    }
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
  menu.style.cssText = 'position:absolute;z-index:1002;background:var(--vscode-menu-background,#252526);border:1px solid var(--vscode-menu-border,#454545);border-radius:4px;padding:4px 0;box-shadow:0 2px 8px rgba(0,0,0,.3);min-width:160px;';

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
// ── Export tab ──────────────────────────────────
function getExportOptions() {
  return {
    format: ($('exportFormat') as HTMLSelectElement).value,
    includeHeaders: ($('exportIncludeHeaders') as HTMLInputElement).checked,
    includeAuth: ($('exportIncludeAuth') as HTMLInputElement).checked,
    includeBody: ($('exportIncludeBody') as HTMLInputElement).checked,
    resolveVariables: ($('exportResolveVars') as HTMLInputElement).checked,
  };
}

let _exportSeq = 0;
let _exportTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
let _exportSpinnerTimer: ReturnType<typeof setTimeout> | undefined;
function requestExportPreview(): void {
  const seq = ++_exportSeq;
  const opts = getExportOptions();
  // Delay showing spinner — if the response arrives fast, no flicker
  clearTimeout(_exportSpinnerTimer);
  _exportSpinnerTimer = setTimeout(() => {
    if (_exportSeq === seq) $('exportSpinner').style.display = '';
  }, 150);
  const req = buildRequest();
  vscode.postMessage({ type: 'exportRequest', request: req, ...opts, action: 'preview', seq });
  // Safety timeout — if no response within 5s, hide spinner and show retry link
  clearTimeout(_exportTimeoutTimer);
  _exportTimeoutTimer = setTimeout(() => {
    if (_exportSeq === seq) {
      clearTimeout(_exportSpinnerTimer);
      $('exportSpinner').style.display = 'none';
      $('exportPreview').innerHTML = '<span class="export-generating">Generation timed out. <a href="#" id="exportRetryLink">Retry</a></span>';
      document.getElementById('exportRetryLink')?.addEventListener('click', (e) => { e.preventDefault(); requestExportPreview(); });
    }
  }, 5000);
}

let _exportPreviewTimer: ReturnType<typeof setTimeout> | undefined;
function requestExportPreviewDebounced(): void {
  clearTimeout(_exportPreviewTimer);
  _exportPreviewTimer = setTimeout(requestExportPreview, 50);
}

$('exportFormat').addEventListener('change', requestExportPreviewDebounced);
$('exportIncludeHeaders').addEventListener('change', requestExportPreviewDebounced);
$('exportIncludeAuth').addEventListener('change', requestExportPreviewDebounced);
$('exportIncludeBody').addEventListener('change', requestExportPreviewDebounced);
$('exportResolveVars').addEventListener('change', requestExportPreviewDebounced);

$('bodyFormatBtn').addEventListener('click', () => formatCurrentBody());

$('exportCopyBtn').addEventListener('click', () => {
  const opts = getExportOptions();
  const req = buildRequest();
  vscode.postMessage({ type: 'exportRequest', request: req, ...opts, action: 'copy' });
});

$('exportSaveBtn').addEventListener('click', () => {
  const opts = getExportOptions();
  const req = buildRequest();
  vscode.postMessage({ type: 'exportRequest', request: req, ...opts, action: 'save' });
});

$('addParamBtn').addEventListener('click', () => { addParam(); syncUrlFromParams(); });
$('addHeaderBtn').addEventListener('click', () => addHeader());
$('addFormFieldBtn').addEventListener('click', () => addFormField());
$('addRuntimeScriptBtn').addEventListener('click', () => { addRuntimeScript('before-request', 'console.log("before request");'); scheduleDocumentUpdate(); });
$('addRuntimeTestBtn').addEventListener('click', () => { addRuntimeScript('tests', 'test("response is successful", () => assert(response.status < 400));'); scheduleDocumentUpdate(); });
$('addRuntimeAssertionBtn').addEventListener('click', () => { addRuntimeAssertion(); scheduleDocumentUpdate(); });
$('addRuntimeActionBtn').addEventListener('click', () => { addRuntimeAction(); scheduleDocumentUpdate(); });
 ($('authType') as HTMLSelectElement).innerHTML = authTypeOptionsHtml(true);
$('authType').addEventListener('change', () => { onAuthTypeChange(); scheduleDocumentUpdate(); });
$('panel-auth').addEventListener('input', scheduleDocumentUpdate);
$('panel-auth').addEventListener('change', scheduleDocumentUpdate);
$('panel-settings').addEventListener('input', scheduleDocumentUpdate);
$('panel-settings').addEventListener('change', scheduleDocumentUpdate);
$('bodyLangMode').addEventListener('change', () => {
  setCurrentLang(($('bodyLangMode') as HTMLSelectElement).value);
  updateBodyFormatterState();
  syncHighlight();
  syncAutoContentType();
  scheduleDocumentUpdate();
});

// Ctrl+S / Cmd+S to save
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'f') {
    if (currentBodyType === 'raw' && canFormatRawBody(currentLang)) {
      e.preventDefault();
      e.stopPropagation();
      formatCurrentBody();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveRequest();
  }
}, true);

// ── Response body keyboard shortcuts ─────────────
// Ctrl+A inside the response body selects only the response text
// Ctrl+F inside the response body opens the search bar
initResponseSearch();
initPreviewMediaControls();

function getSelectedResponseText(selection: Selection): string {
  if (selection.rangeCount === 0) {
    return '';
  }

  const fragment = selection.getRangeAt(0).cloneContents();
  const container = document.createElement('div');
  container.appendChild(fragment);
  const selectedLines = Array.from(container.querySelectorAll('.code-line'));

  if (selectedLines.length === 0) {
    return selection.toString();
  }

  return selectedLines
    .map((line) => line.textContent ?? '')
    .join('\n');
}

// Make contenteditable pre read-only: block all input and prevent paste/drop
const respPre = document.getElementById('respBodyPre');
if (respPre) {
  respPre.addEventListener('beforeinput', (e) => e.preventDefault());
  respPre.addEventListener('paste', (e) => e.preventDefault());
  respPre.addEventListener('drop', (e) => e.preventDefault());
  // Block typing but allow Ctrl+A, Ctrl+C, Ctrl+F, arrows, etc.
  respPre.addEventListener('keydown', (e: KeyboardEvent) => {
    const allow = e.ctrlKey || e.metaKey || e.altKey
      || e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End'
      || e.key === 'PageUp' || e.key === 'PageDown'
      || e.key === 'Escape' || e.key === 'Tab'
      || e.key === 'F5' || e.key === 'F12';
    if (!allow) {
      e.preventDefault();
    }
  });
  respPre.addEventListener('copy', (e: ClipboardEvent) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!respPre.contains(range.commonAncestorContainer)) {
      return;
    }

    const selectedText = getSelectedResponseText(selection);
    if (!selectedText) {
      return;
    }

    e.preventDefault();
    e.clipboardData?.setData('text/plain', selectedText);
  });
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!(e.ctrlKey || e.metaKey)) return;

  const pre = document.getElementById('respBodyPre');
  const respBodyWrap = document.getElementById('respBodyWrap');
  const respBodyTab = document.getElementById('panel-resp-body');

  // Check if the response body panel is visible
  const isRespBodyVisible = respBodyWrap && respBodyWrap.style.display !== 'none'
    && respBodyTab && respBodyTab.classList.contains('active');

  // Check if focus is within the response section (not in request-side inputs/textareas)
  const respSection = document.getElementById('responseSection');
  const activeEl = document.activeElement;
  const isInResponseSearchInput = activeEl instanceof HTMLInputElement && activeEl.classList.contains('resp-search-input');
  const isInRequestInput = activeEl instanceof HTMLInputElement && !isInResponseSearchInput;
  const isInTextArea = activeEl instanceof HTMLTextAreaElement;
  const isFocusInResponse = pre && respSection && (
    activeEl === pre
    || pre.contains(activeEl)
    || (respSection.contains(activeEl) && !isInRequestInput && !isInTextArea)
  );
  const isFocusInResponseForSelectAll = isFocusInResponse && !isInResponseSearchInput;

  if (e.key === 'a' && isFocusInResponseForSelectAll && isRespBodyVisible) {
    e.preventDefault();
    e.stopPropagation();
    // Select only the response body text
    const selection = window.getSelection();
    if (selection && pre) {
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(pre);
      selection.addRange(range);
    }
    return;
  }

  if (e.key === 'f' && isFocusInResponse && isRespBodyVisible) {
    e.preventDefault();
    openSearch();
    return;
  }
}, true);

// Canonical Escape-closes-search handler. Lives at the document level so it
// works regardless of whether the search input, the response pre, or any other
// element inside the response section has focus. The isSearchOpen guard keeps
// us from preventDefault-ing Escape in unrelated contexts (modals, menus).
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && isSearchOpen()) {
    e.preventDefault();
    closeSearch();
    const pre = document.getElementById('respBodyPre');
    if (pre) pre.focus();
  }
});

// Notify extension we're ready
vscode.postMessage({ type: 'ready' });
