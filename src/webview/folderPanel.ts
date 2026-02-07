import { renderAuthFields, buildAuthData, loadAuthData, type AuthFieldsConfig } from './authFields';
import { initOAuth2TokenStatusController } from './oauth2TokenStatus';
import { escHtml } from './varlib';
import {
  highlightVariables, enableVarOverlay, enableContentEditableValue,
  restoreCursor, syncAllVarOverlays, handleVariablesResolved, initVarFields,
  registerFlushOnSave, setPostMessage,
  getResolvedVariables, getVariableSources, getShowResolvedVars, setShowResolvedVars,
} from './varFields';
import { handleSecretValueResolved } from './varTooltip';

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

const SECURE_PREFIX = 'secure:';
function generateSecureRef(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, hex).join('');
  return SECURE_PREFIX + s(8) + '-' + s(4) + '-4' + s(3) + '-' + s(4) + '-' + s(12);
}
function extractSecureId(value: string | undefined): string | undefined {
  if (value && value.startsWith(SECURE_PREFIX)) return value.slice(SECURE_PREFIX.length);
  return undefined;
}
const _secureValueCache: Record<string, string> = {};

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

  // Default variables — read from defaultVars array (includes secret/secure/value)
  const vars: any[] = defaultVars
    .filter((v: any) => v.name)
    .map((v: any) => {
      const out: any = { name: v.name };
      if (v.value !== undefined && v.value !== '') out.value = v.value;
      if (v.secret) out.secret = true;
      if (v.secure) out.secure = true;
      if (v.disabled) out.disabled = true;
      return out;
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
let defaultVars: any[] = [];

function renderDefaultVars(variables: any[]) {
  defaultVars = variables || [];
  const tbody = $('defaultVarsBody');
  tbody.innerHTML = '';
  defaultVars.forEach((_v: any, i: number) => addDefaultVarRow(i));
  updateDefaultVarsHiddenWarning();
}

function updateDefaultVarsHiddenWarning(): void {
  const warn = document.getElementById('defaultVarsHiddenWarning');
  if (!warn) return;
  const hasHidden = defaultVars.some((v: any) => v.secret === true && !v.secure);
  warn.style.display = hasHidden ? 'block' : 'none';
}

function addDefaultVarRow(idx: number) {
  const tbody = $('defaultVarsBody');
  const v = defaultVars[idx];
  const tr = document.createElement('tr');
  const isSecret = v.secret === true;
  const isSecure = isSecret && v.secure === true;
  const chk = v.disabled ? '' : 'checked';
  const val = isSecret ? (isSecure ? '' : (v.value || '')) : (typeof v.value === 'string' ? v.value : (v.value && v.value.data ? v.value.data : ''));

  tr.innerHTML =
    `<td><input type="checkbox" ${chk} data-field="disabled" /></td>` +
    `<td><input type="text" value="${esc(v.name || '')}" placeholder="Variable name" data-field="name" /></td>` +
    `${isSecret
      ? '<td><div class="secret-value-wrap"><input type="password" value="' + (isSecure ? '' : esc(val)) + '"' + (isSecure ? ' placeholder="\u2022\u2022\u2022\u2022\u2022\u2022"' : '') + ' data-field="value" /><button class="secret-toggle" title="Show/hide">&#9673;</button></div></td>'
      : '<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="Variable value" data-field="value"></div></td>'
    }` +
    `<td><select class="type-select select-borderless" data-field="type"><option value="var"${!isSecret ? ' selected' : ''}>var</option><option value="hidden"${isSecret && !isSecure ? ' selected' : ''}>hidden</option><option value="secure"${isSecure ? ' selected' : ''}>secure</option></select></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;

  // Wire inputs
  tr.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(inp => {
    const field = inp.dataset.field!;
    if (inp.type === 'checkbox') {
      inp.addEventListener('change', () => { defaultVars[idx].disabled = !inp.checked; scheduleUpdate(); });
    } else if (isSecure && field === 'value') {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      inp.addEventListener('input', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const secureId = extractSecureId(defaultVars[idx].value);
          if (secureId) vscode.postMessage({ type: 'storeSecureValue', secureId, value: inp.value });
        }, 500);
      });
    } else {
      inp.addEventListener('input', () => { defaultVars[idx][field] = inp.value; scheduleUpdate(); });
    }
  });

  // Wire contenteditable value for non-secret vars
  if (!isSecret) {
    const valCE = tr.querySelector('.val-ce[data-field="value"]') as HTMLElement;
    if (valCE) {
      enableContentEditableValue(valCE, val, () => {
        defaultVars[idx].value = (valCE as any)._getRawText ? (valCE as any)._getRawText() : (valCE.textContent || '');
        scheduleUpdate();
      });
    }
  }

  // Type dropdown
  const typeSelect = tr.querySelector<HTMLSelectElement>('.type-select');
  typeSelect?.addEventListener('change', () => {
    const newType = typeSelect.value;
    const wasSecure = defaultVars[idx].secure === true;
    let currentPlainValue = '';
    if (!wasSecure) {
      const valCE = tr.querySelector('.val-ce[data-field="value"]') as any;
      const valInp = tr.querySelector<HTMLInputElement>('input[data-field="value"]');
      currentPlainValue = valCE?._getRawText ? valCE._getRawText() : (valInp?.value ?? defaultVars[idx].value ?? '');
    }

    if (newType === 'hidden') {
      if (wasSecure) {
        const oldId = extractSecureId(defaultVars[idx].value);
        defaultVars[idx].value = (oldId && _secureValueCache[oldId]) || '';
      }
      defaultVars[idx].secret = true;
      delete defaultVars[idx].secure;
    } else if (newType === 'secure') {
      defaultVars[idx].secret = true;
      defaultVars[idx].secure = true;
      if (!extractSecureId(defaultVars[idx].value)) {
        const ref = generateSecureRef();
        const secureId = extractSecureId(ref)!;
        defaultVars[idx].value = ref;
        if (currentPlainValue) {
          _secureValueCache[secureId] = currentPlainValue;
          vscode.postMessage({ type: 'storeSecureValue', secureId, value: currentPlainValue });
        }
      }
    } else {
      if (wasSecure) {
        const oldId = extractSecureId(defaultVars[idx].value);
        defaultVars[idx].value = (oldId && _secureValueCache[oldId]) || '';
      } else {
        defaultVars[idx].value = currentPlainValue;
      }
      delete defaultVars[idx].secret;
      delete defaultVars[idx].secure;
    }
    renderDefaultVars(defaultVars);
    scheduleUpdate();
  });

  // Secret toggle
  const toggleBtn = tr.querySelector('.secret-toggle');
  toggleBtn?.addEventListener('click', () => {
    const inp = tr.querySelector<HTMLInputElement>('input[data-field="value"]');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Delete
  tr.querySelector('.row-delete')!.addEventListener('click', () => {
    const oldId = extractSecureId(defaultVars[idx].value);
    if (oldId) vscode.postMessage({ type: 'deleteSecureValue', secureId: oldId });
    defaultVars.splice(idx, 1);
    renderDefaultVars(defaultVars);
    scheduleUpdate();
  });

  // Check secure status
  const secureId = extractSecureId(v.value);
  if (isSecure && secureId) vscode.postMessage({ type: 'getSecureStatus', secureId });

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
  folderData = JSON.parse(JSON.stringify(data));

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
setPostMessage((msg: any) => vscode.postMessage(msg));
registerFlushOnSave(() => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!isLoading && folderData) buildAndSend();
});
initTabs('mainTabs');

$('defaultAuthType').addEventListener('change', onDefaultAuthChange);
$('addDefaultHeaderBtn').addEventListener('click', () => { addHeaderRow(); updateBadges(); scheduleUpdate(); });
$('addDefaultVarBtn').addEventListener('click', () => { defaultVars.push({ name: '', value: '' }); renderDefaultVars(defaultVars); updateBadges(); scheduleUpdate(); });
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
  if (msg.type === 'secretValueResolved') {
    handleSecretValueResolved(msg);
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
