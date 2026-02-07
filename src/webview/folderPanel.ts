import { renderAuthFields, buildAuthData, loadAuthData, type AuthFieldsConfig } from './authFields';
import { showVarTooltipAt, hideVarTooltip } from './varTooltip';
import { initOAuth2TokenStatusController } from './oauth2TokenStatus';
import { escHtml, highlightVariables as _hlVars } from './varlib';
import {
  handleAutocomplete,
  handleAutocompleteContentEditable,
  handleAutocompleteKeydown,
  hideAutocomplete,
  isAutocompleteActive,
  setAutocompleteSyncCallbacks,
  setResolvedVariablesGetter,
  setSecretProviderNames,
} from './autocomplete';

declare function acquireVsCodeApi(): { postMessage(msg: any): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();

let folderData: any = null;
let ignoreNextLoad = false;
let isLoading = false;
let saveTimer: any = null;

// ── Helpers ──────────────────────────────────
function $(id: string) { return document.getElementById(id)!; }
function esc(s: string): string {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Variable Resolution State ────────────────
let resolvedVariables: Record<string, string> = {};
let variableSources: Record<string, string> = {};
let showResolvedVars = false;

function highlightVariables(html: string): string {
  return _hlVars(html, { resolved: resolvedVariables, sources: variableSources, showResolved: showResolvedVars });
}

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

  input.addEventListener('input', () => { sync(); handleAutocomplete(input, sync); });
  input.addEventListener('focus', deactivate);
  input.addEventListener('blur', () => { activate(); hideAutocomplete(); });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isAutocompleteActive() && handleAutocompleteKeydown(e)) return;
  });

  overlay.addEventListener('click', (e: Event) => {
    const varEl = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
    if (varEl && varEl.dataset.var) {
      showVarTooltipAt(varEl, varEl.dataset.var, {
        getResolvedVariables: () => resolvedVariables,
        getVariableSources: () => variableSources,
      });
    } else {
      deactivate();
      input.focus();
    }
  });

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
  document.querySelectorAll('.val-ce').forEach((el) => {
    const getRaw = (el as any)._getRawText;
    if (getRaw && document.activeElement !== el) {
      const raw = getRaw();
      if (raw) {
        el.innerHTML = highlightVariables(escHtml(raw));
      }
    }
  });
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

function enableContentEditableValue(el: HTMLElement, initialValue: string, onChange: () => void): void {
  let rawText = initialValue || '';
  (el as any)._getRawText = () => rawText;
  (el as any)._setRawText = (t: string) => { rawText = t; };

  function syncHighlightCE(): void {
    if (!rawText) {
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
    el.innerHTML = highlightVariables(escHtml(rawText));
    if (sel && document.activeElement === el) {
      restoreCursor(el, cursorOffset);
    }
  }

  syncHighlightCE();

  el.addEventListener('input', () => {
    if (showResolvedVars) {
      showResolvedVars = false;
      syncAllVarOverlays();
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
    rawText = el.textContent || '';
    syncHighlightCE();
    restoreCursor(el, cursorOffset);
    onChange();
    handleAutocompleteContentEditable(el, syncHighlightCE);
  });

  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isAutocompleteActive() && handleAutocompleteKeydown(e)) return;
  });

  el.addEventListener('blur', () => { hideAutocomplete(); });

  el.addEventListener('click', (e: Event) => {
    const target = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
    if (target && target.dataset.var) {
      showVarTooltipAt(target, target.dataset.var, {
        getResolvedVariables: () => resolvedVariables,
        getVariableSources: () => variableSources,
      });
    }
  });
}

// ── Debounced auto-save ──────────────────────
function scheduleUpdate() {
  if (isLoading) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!folderData) return;
    buildAndSend();
  }, 400);
}

function buildAndSend() {
  const data = JSON.parse(JSON.stringify(folderData));

  // Overview
  data.info = data.info || {};
  data.info.type = 'folder';
  data.info.name = ($('infoName') as HTMLInputElement).value || undefined;
  const desc = ($('infoDescription') as HTMLTextAreaElement).value;
  if (desc) data.info.description = desc;
  else delete data.info.description;

  // Default headers
  const headers: any[] = [];
  document.querySelectorAll('#defaultHeadersBody tr').forEach(tr => {
    const nameInput = tr.querySelector<HTMLInputElement>('input[type="text"]');
    const valEl = tr.querySelector('.val-ce') as any;
    const chk = tr.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (nameInput?.value) {
      const h: any = { name: nameInput.value, value: valEl?._getRawText ? valEl._getRawText() : (valEl?.textContent || '') };
      if (chk && !chk.checked) h.disabled = true;
      headers.push(h);
    }
  });
  if (!data.request) data.request = {};
  data.request.headers = headers.length > 0 ? headers : undefined;

  // Default auth
  const authType = ($('defaultAuthType') as HTMLSelectElement).value;
  const authData = buildAuthData(authType, 'dAuth');
  if (authData !== undefined) {
    data.request.auth = authData;
  } else {
    delete data.request.auth;
  }

  // Default variables
  const vars: any[] = [];
  document.querySelectorAll('#defaultVarsBody tr').forEach(tr => {
    const nameInput = tr.querySelector<HTMLInputElement>('input[type="text"]');
    const valEl = tr.querySelector('.val-ce') as any;
    const chk = tr.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (nameInput?.value) {
      const v: any = { name: nameInput.value, value: valEl?._getRawText ? valEl._getRawText() : (valEl?.textContent || '') };
      if (chk && !chk.checked) v.disabled = true;
      vars.push(v);
    }
  });
  data.request = data.request || {};
  data.request.variables = vars.length > 0 ? vars : undefined;

  // Clean empty request
  if (data.request && Object.keys(data.request).every((k: string) => data.request[k] === undefined)) {
    delete data.request;
  }

  ignoreNextLoad = true;
  vscode.postMessage({ type: 'updateDocument', folder: data });
}

// ── Tab Switching ────────────────────────────
function initTabs(tabsContainerId: string) {
  const container = $(tabsContainerId);
  if (!container) return;
  container.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = (tab as HTMLElement).dataset.tab!;
      container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const parent = container.parentElement!;
      parent.querySelectorAll(':scope > .tab-content > .tab-panel').forEach(p => p.classList.remove('active'));
      const panel = parent.querySelector(`#panel-${tabName}`);
      if (panel) panel.classList.add('active');
    });
  });
}

// ── Default Headers ──────────────────────────
function renderDefaultHeaders(headers: any[]) {
  const tbody = $('defaultHeadersBody');
  tbody.innerHTML = '';
  (headers || []).forEach(h => addHeaderRow(h.name, h.value, h.disabled));
}

function addHeaderRow(name?: string, value?: string, disabled?: boolean) {
  const tbody = $('defaultHeadersBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td><input type="checkbox" ${disabled ? '' : 'checked'} /></td>` +
    `<td><input type="text" value="${esc(name || '')}" placeholder="Header name" /></td>` +
    `<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="Header value"></div></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); scheduleUpdate(); });
  tr.querySelector<HTMLInputElement>('input[type="text"]')!.addEventListener('input', scheduleUpdate);
  tr.querySelector<HTMLInputElement>('input[type="checkbox"]')!.addEventListener('change', scheduleUpdate);
  enableContentEditableValue(tr.querySelector('.val-ce') as HTMLElement, value || '', scheduleUpdate);
  tbody.appendChild(tr);
}

// ── Default Variables ────────────────────────
function renderDefaultVars(variables: any[]) {
  const tbody = $('defaultVarsBody');
  tbody.innerHTML = '';
  (variables || []).forEach(v => addDefaultVarRow(v.name, v.value, v.disabled));
}

function addDefaultVarRow(name?: string, value?: string, disabled?: boolean) {
  const tbody = $('defaultVarsBody');
  const tr = document.createElement('tr');
  const val = typeof value === 'string' ? value : (value && (value as any).data ? (value as any).data : '');
  tr.innerHTML =
    `<td><input type="checkbox" ${disabled ? '' : 'checked'} /></td>` +
    `<td><input type="text" value="${esc(name || '')}" placeholder="Variable name" /></td>` +
    `<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="Variable value"></div></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); scheduleUpdate(); });
  tr.querySelector<HTMLInputElement>('input[type="text"]')!.addEventListener('input', scheduleUpdate);
  tr.querySelector<HTMLInputElement>('input[type="checkbox"]')!.addEventListener('change', scheduleUpdate);
  enableContentEditableValue(tr.querySelector('.val-ce') as HTMLElement, val, scheduleUpdate);
  tbody.appendChild(tr);
}

// ── Default Auth ─────────────────────────────
const folderAuthConfig: AuthFieldsConfig = {
  prefix: 'dAuth',
  get fieldsContainer() { return $('defaultAuthFields'); },
  onChange: () => scheduleUpdate(),
  showInherit: true,
  wrapInputs: true,
  showTokenStatus: true,
  onFieldsRendered: (inputs) => inputs.forEach(inp => enableVarOverlay(inp)),
};

const tokenStatusCtrl = initOAuth2TokenStatusController({
  prefix: 'dAuth',
  buildAuth: () => buildAuthData(($('defaultAuthType') as HTMLSelectElement).value, 'dAuth'),
  postMessage: (msg) => vscode.postMessage(msg),
  esc,
});

function onDefaultAuthChange() {
  const type = ($('defaultAuthType') as HTMLSelectElement).value;
  renderAuthFields(type, folderAuthConfig);
  if (type === 'oauth2') {
    tokenStatusCtrl.requestStatus();
  }
}

// ── Update Badges ────────────────────────────
function updateBadges() {
  $('headersBadge').textContent = String(document.querySelectorAll('#defaultHeadersBody tr').length);
  $('variablesBadge').textContent = String(document.querySelectorAll('#defaultVarsBody tr').length);
}

// ── Load Folder Data ─────────────────────────
function loadFolder(data: any) {
  isLoading = true;
  folderData = data;

  // Overview
  ($('infoName') as HTMLInputElement).value = data.info?.name || '';
  const desc = data.info?.description;
  ($('infoDescription') as HTMLTextAreaElement).value =
    typeof desc === 'string' ? desc : (desc?.content || '');
  $('folderName').textContent = data.info?.name || 'Folder';

  // Auth
  const auth = data.request?.auth;
  if (auth === 'inherit') {
    ($('defaultAuthType') as HTMLSelectElement).value = 'inherit';
  } else if (auth?.type) {
    ($('defaultAuthType') as HTMLSelectElement).value = auth.type;
  } else {
    ($('defaultAuthType') as HTMLSelectElement).value = 'none';
  }
  onDefaultAuthChange();
  if (auth && auth !== 'inherit' && auth.type) {
    loadAuthData(auth, 'dAuth');
  }

  // Headers
  renderDefaultHeaders(data.request?.headers || []);

  // Variables
  renderDefaultVars(data.request?.variables || []);

  updateBadges();
  isLoading = false;
}

// ── Wire up events ───────────────────────────
setResolvedVariablesGetter(() => resolvedVariables);
setAutocompleteSyncCallbacks(syncAllVarOverlays, syncAllVarOverlays, restoreCursor);
initTabs('mainTabs');

$('defaultAuthType').addEventListener('change', onDefaultAuthChange);
$('addDefaultHeaderBtn').addEventListener('click', () => { addHeaderRow(); updateBadges(); scheduleUpdate(); });
$('addDefaultVarBtn').addEventListener('click', () => { addDefaultVarRow(); updateBadges(); scheduleUpdate(); });
$('varToggleBtn').addEventListener('click', () => {
  showResolvedVars = !showResolvedVars;
  $('varToggleBtn').classList.toggle('active', showResolvedVars);
  syncAllVarOverlays();
});

// Overview fields
$('infoName').addEventListener('input', () => {
  $('folderName').textContent = ($('infoName') as HTMLInputElement).value || 'Folder';
  scheduleUpdate();
});
$('infoDescription').addEventListener('input', scheduleUpdate);

// ── Message handler ──────────────────────────
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === 'folderLoaded') {
    if (ignoreNextLoad) {
      ignoreNextLoad = false;
      return;
    }
    loadFolder(msg.folder);
  }
  if (msg.type === 'variablesResolved') {
    resolvedVariables = msg.variables || {};
    variableSources = msg.sources || {};
    setSecretProviderNames(msg.secretProviderNames || []);
    syncAllVarOverlays();
    tokenStatusCtrl.requestStatus();
  }
  if (msg.type === 'oauth2TokenStatus') {
    tokenStatusCtrl.handleStatus(msg.status);
  }
  if (msg.type === 'oauth2Progress') {
    tokenStatusCtrl.handleProgress(msg.message);
  }
});

// Notify extension we're ready
vscode.postMessage({ type: 'ready' });
