import { renderAuthFields, buildAuthData, loadAuthData, type AuthFieldsConfig } from './authFields';
import { initOAuth2TokenStatusController } from './oauth2TokenStatus';
import { escHtml } from './varlib';
import {
  highlightVariables, enableVarOverlay, enableContentEditableValue,
  restoreCursor, syncAllVarOverlays, handleVariablesResolved, initVarFields,
  getResolvedVariables, getVariableSources, getShowResolvedVars, setShowResolvedVars,
} from './varFields';

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

// Variable state and field infrastructure imported from varFields.ts

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
initVarFields();
initTabs('mainTabs');

$('defaultAuthType').addEventListener('change', onDefaultAuthChange);
$('addDefaultHeaderBtn').addEventListener('click', () => { addHeaderRow(); updateBadges(); scheduleUpdate(); });
$('addDefaultVarBtn').addEventListener('click', () => { addDefaultVarRow(); updateBadges(); scheduleUpdate(); });
$('varToggleBtn').addEventListener('click', () => {
  setShowResolvedVars(!getShowResolvedVars());
  $('varToggleBtn').classList.toggle('active', getShowResolvedVars());
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
  if (handleVariablesResolved(msg)) {
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
