import { renderAuthFields, buildAuthData, loadAuthData, type AuthFieldsConfig } from './authFields';
import { initOAuth2TokenStatusController } from './oauth2TokenStatus';
import { escHtml } from './varlib';
import {
  setSecretNamesForProvider,
} from './autocomplete';
import {
  highlightVariables, enableVarOverlay, enableContentEditableValue,
  restoreCursor, syncAllVarOverlays, handleVariablesResolved, initVarFields,
  registerFlushOnSave, setPostMessage,
  getResolvedVariables, getVariableSources, getShowResolvedVars, setShowResolvedVars,
} from './varFields';
import { handleSecretValueResolved } from './varTooltip';

declare function acquireVsCodeApi(): { postMessage(msg: any): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();

let collectionData: any = null;
let ignoreNextLoad = false;
let isLoading = false;
let activeEnvIdx = -1;
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
    if (!collectionData) return;
    buildAndSend();
  }, 400);
}


function buildAndSend() {
  const data = JSON.parse(JSON.stringify(collectionData));

  // Overview
  data.info = data.info || {};
  data.info.name = ($('infoName') as HTMLInputElement).value || undefined;
  data.info.version = ($('infoVersion') as HTMLInputElement).value || undefined;
  const summary = ($('infoSummary') as HTMLTextAreaElement).value;
  if (summary) data.info.summary = summary;
  else delete data.info.summary;

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

  // Secret providers
  const secretProviders = buildSecretProviders();
  if (!data.config) data.config = {};
  data.config.secretProviders = secretProviders.length > 0 ? secretProviders : undefined;

  ignoreNextLoad = true;
  vscode.postMessage({ type: 'updateDocument', collection: data });
}

// ── Tab Switching ────────────────────────────
function initTabs(tabsContainerId: string) {
  const container = $(tabsContainerId);
  if (!container) return;
  container.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = (tab as HTMLElement).dataset.tab!;
      // Deactivate siblings
      container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // Show matching panel
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
const collectionAuthConfig: AuthFieldsConfig = {
  prefix: 'dAuth',
  get fieldsContainer() { return $('defaultAuthFields'); },
  onChange: () => scheduleUpdate(),
  showInherit: false,
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
  renderAuthFields(type, collectionAuthConfig);
  if (type === 'oauth2') {
    tokenStatusCtrl.requestStatus();
  }
}

// ── Swatch Colors (ThemeColor tokens → display hex for webview) ──
const SWATCH_COLORS: { token: string; hex: string }[] = [
  { token: 'charts.red',        hex: 'var(--vscode-charts-red, #f14c4c)' },
  { token: 'charts.orange',     hex: 'var(--vscode-charts-orange, #d18616)' },
  { token: 'charts.yellow',     hex: 'var(--vscode-charts-yellow, #cca700)' },
  { token: 'charts.green',      hex: 'var(--vscode-charts-green, #89d185)' },
  { token: 'charts.blue',       hex: 'var(--vscode-charts-blue, #3794ff)' },
  { token: 'charts.purple',     hex: 'var(--vscode-charts-purple, #b180d7)' },
  { token: 'charts.foreground', hex: 'var(--vscode-charts-foreground, #cccccc)' },
  { token: 'terminal.ansiRed',       hex: 'var(--vscode-terminal-ansiRed, #cd3131)' },
  { token: 'terminal.ansiGreen',     hex: 'var(--vscode-terminal-ansiGreen, #0dbc79)' },
  { token: 'terminal.ansiYellow',    hex: 'var(--vscode-terminal-ansiYellow, #e5e510)' },
  { token: 'terminal.ansiBlue',      hex: 'var(--vscode-terminal-ansiBlue, #2472c8)' },
  { token: 'terminal.ansiMagenta',   hex: 'var(--vscode-terminal-ansiMagenta, #bc3fbc)' },
  { token: 'terminal.ansiCyan',      hex: 'var(--vscode-terminal-ansiCyan, #11a8cd)' },
  { token: 'terminal.ansiWhite',     hex: 'var(--vscode-terminal-ansiWhite, #e5e5e5)' },
];

// ── Environments ─────────────────────────────
function renderEnvSelector() {
  const sel = $('envSelector') as HTMLSelectElement;
  sel.innerHTML = '';
  const envs = collectionData?.config?.environments || [];
  if (envs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '-1';
    opt.textContent = 'No environments';
    sel.appendChild(opt);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    envs.forEach((env: any, idx: number) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = env.name || 'Unnamed';
      sel.appendChild(opt);
    });
    sel.value = String(activeEnvIdx);
  }
}

function selectEnv(idx: number) {
  activeEnvIdx = idx;
  renderEnvSelector();
  renderEnvDetail();
}

function removeEnv() {
  const envs = collectionData?.config?.environments || [];
  if (activeEnvIdx < 0 || activeEnvIdx >= envs.length) return;
  envs.splice(activeEnvIdx, 1);
  if (activeEnvIdx >= envs.length) activeEnvIdx = envs.length - 1;
  renderEnvSelector();
  renderEnvDetail();
  scheduleUpdate();
}

function addEnv() {
  if (!collectionData.config) collectionData.config = {};
  if (!collectionData.config.environments) collectionData.config.environments = [];
  collectionData.config.environments.push({ name: 'new-environment', variables: [] });
  activeEnvIdx = collectionData.config.environments.length - 1;
  renderEnvSelector();
  renderEnvDetail();
  scheduleUpdate();
}

function closeSwatchPopover() {
  const existing = document.querySelector('.swatch-popover');
  if (existing) existing.remove();
}

function openSwatchPopover(anchor: HTMLElement, env: any) {
  closeSwatchPopover();
  const pop = document.createElement('div');
  pop.className = 'swatch-popover';
  SWATCH_COLORS.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch' + (c.token === env.color ? ' active' : '');
    btn.style.background = c.hex;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      env.color = c.token;
      closeSwatchPopover();
      renderEnvSelector();
      renderEnvDetail();
      scheduleUpdate();
    });
    pop.appendChild(btn);
  });
  // Position below the anchor
  const rect = anchor.getBoundingClientRect();
  pop.style.top = rect.bottom + 4 + 'px';
  pop.style.left = rect.left + 'px';
  document.body.appendChild(pop);
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler() {
      closeSwatchPopover();
      document.removeEventListener('click', handler);
    });
  }, 0);
}

function renderEnvDetail() {
  const detail = $('envDetail');
  const envs = collectionData?.config?.environments || [];
  if (activeEnvIdx < 0 || activeEnvIdx >= envs.length) {
    detail.innerHTML = '<div class="env-detail-empty">Add an environment to get started</div>';
    return;
  }

  const env = envs[activeEnvIdx];
  const colorToken = env.color || '';
  const colorEntry = SWATCH_COLORS.find(c => c.token === colorToken);
  const displayColor = colorEntry ? colorEntry.hex : 'var(--vscode-charts-foreground, #888)';

  detail.innerHTML =
    // Meta row
    '<div class="env-meta">' +
      '<button class="color-dot-btn" id="envColorBtn" style="background:' + displayColor + '" title="Pick color"></button>' +
      '<div class="form-field name"><label>Name</label><input type="text" id="envName" value="' + esc(env.name) + '" /></div>' +
      '<div class="form-field extends"><label>Extends</label><input type="text" id="envExtends" value="' + esc(env.extends || '') + '" placeholder="parent env name" /></div>' +
    '</div>' +
    // Env tabs
    '<div class="tabs" id="envTabs">' +
      '<div class="tab active" data-tab="env-vars">Variables <span class="badge" id="envVarsBadge">' + (env.variables ? env.variables.length : 0) + '</span></div>' +
      '<div class="tab" data-tab="env-settings">Settings</div>' +
    '</div>' +
    '<div class="tab-content">' +
      '<div class="tab-panel active" id="panel-env-vars">' +
        '<table class="kv-table"><colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:70px"><col style="width:32px"></colgroup><thead><tr><th></th><th>Name</th><th>Value</th><th>Type</th><th></th></tr></thead>' +
        '<tbody id="envVarsBody"></tbody></table>' +
        '<button class="add-row-btn" id="addEnvVarBtn">+ Add Variable</button>' +
      '</div>' +
      '<div class="tab-panel" id="panel-env-settings">' +
        '<div class="auth-section">' +
          '<div class="auth-row"><label>dotenv File</label><input type="text" id="envDotenv" value="' + esc(env.dotEnvFilePath || '') + '" placeholder=".env.local" /></div>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Wire meta fields
  $('envName').addEventListener('input', () => {
    env.name = ($('envName') as HTMLInputElement).value;
    renderEnvSelector();
    scheduleUpdate();
  });
  $('envColorBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openSwatchPopover($('envColorBtn'), env);
  });
  $('envExtends').addEventListener('input', () => {
    const val = ($('envExtends') as HTMLInputElement).value;
    if (val) env.extends = val; else delete env.extends;
    scheduleUpdate();
  });
  $('envDotenv')?.addEventListener('input', () => {
    const val = ($('envDotenv') as HTMLInputElement).value;
    if (val) env.dotEnvFilePath = val; else delete env.dotEnvFilePath;
    scheduleUpdate();
  });

  // Render variables
  const tbody = $('envVarsBody');
  (env.variables || []).forEach((v: any, vi: number) => {
    addEnvVarRow(tbody, env, vi);
  });

  // Wire add button
  $('addEnvVarBtn').addEventListener('click', () => {
    if (!env.variables) env.variables = [];
    env.variables.push({ name: '', value: '' });
    renderEnvDetail();
    scheduleUpdate();
  });

  // Init env tabs
  initTabs('envTabs');
}

function addEnvVarRow(tbody: HTMLElement, env: any, varIdx: number) {
  const v = env.variables[varIdx];
  const tr = document.createElement('tr');
  const isSecret = v.secret === true;
  const chk = v.disabled ? '' : 'checked';
  const val = isSecret ? (v.value || '') : (typeof v.value === 'string' ? v.value : (v.value && v.value.data ? v.value.data : ''));

  tr.innerHTML =
    `<td><input type="checkbox" ${chk} data-field="disabled" /></td>` +
    `<td><input type="text" value="${esc(v.name || '')}" data-field="name" /></td>` +
    `${isSecret
      ? '<td><div class="secret-value-wrap"><input type="password" value="' + esc(val) + '" data-field="value" /><button class="secret-toggle" title="Show/hide">&#9673;</button></div></td>'
      : '<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="value" data-field="value"></div></td>'
    }` +
    `<td><select class="type-select select-borderless" data-field="type"><option value="var"${!isSecret ? ' selected' : ''}>var</option><option value="secret"${isSecret ? ' selected' : ''}>secret</option></select></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;

  // Wire inputs
  tr.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(inp => {
    const field = inp.dataset.field!;
    if (inp.type === 'checkbox') {
      inp.addEventListener('change', () => { env.variables[varIdx].disabled = !inp.checked; scheduleUpdate(); });
    } else {
      inp.addEventListener('input', () => { env.variables[varIdx][field] = inp.value; scheduleUpdate(); });
    }
  });

  // Type dropdown
  const typeSelect = tr.querySelector<HTMLSelectElement>('.type-select');
  typeSelect?.addEventListener('change', () => {
    const newType = typeSelect.value;
    if (newType === 'secret') {
      env.variables[varIdx].secret = true;
    } else {
      delete env.variables[varIdx].secret;
    }
    renderEnvDetail();
    scheduleUpdate();
  });

  // Secret toggle
  const toggleBtn = tr.querySelector('.secret-toggle');
  toggleBtn?.addEventListener('click', () => {
    const inp = tr.querySelector<HTMLInputElement>('input[data-field="value"]');
    if (inp) {
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }
  });

  // Delete
  tr.querySelector('.row-delete')?.addEventListener('click', () => {
    env.variables.splice(varIdx, 1);
    renderEnvDetail();
    scheduleUpdate();
  });

  // Wire contenteditable value for non-secret env vars
  if (!isSecret) {
    const valCE = tr.querySelector('.val-ce[data-field="value"]') as HTMLElement;
    if (valCE) {
      enableContentEditableValue(valCE, val, () => {
        env.variables[varIdx].value = (valCE as any)._getRawText ? (valCE as any)._getRawText() : (valCE.textContent || '');
        scheduleUpdate();
      });
    }
  }

  tbody.appendChild(tr);
}

// ── Load Collection ──────────────────────────
function loadCollection(data: any) {
  isLoading = true;
  collectionData = JSON.parse(JSON.stringify(data));

  // Header
  $('collectionName').textContent = data.info?.name || 'Collection';

  // Overview
  ($('infoName') as HTMLInputElement).value = data.info?.name || '';
  ($('infoVersion') as HTMLInputElement).value = data.info?.version || '';
  ($('infoSummary') as HTMLTextAreaElement).value = data.info?.summary || '';

  // Default headers
  renderDefaultHeaders(data.request?.headers || []);

  // Default variables
  renderDefaultVars(data.request?.variables || []);

  // Default auth
  const auth = data.request?.auth;
  if (auth && typeof auth === 'object' && auth.type) {
    ($('defaultAuthType') as HTMLSelectElement).value = auth.type;
  } else {
    ($('defaultAuthType') as HTMLSelectElement).value = 'none';
  }
  onDefaultAuthChange();
  if (auth && typeof auth === 'object' && auth.type) {
    setTimeout(() => { loadAuthData(auth, 'dAuth'); }, 0);
  }

  // Badges
  $('headersBadge').textContent = String((data.request?.headers || []).length);
  $('variablesBadge').textContent = String((data.request?.variables || []).length);

  // Secret providers
  renderSecretProviders(data.config?.secretProviders || []);

  // Environments
  const envs = collectionData?.config?.environments || [];
  $('envBadge').textContent = String(envs.length);
  if (activeEnvIdx < 0 && envs.length > 0) activeEnvIdx = 0;
  if (activeEnvIdx >= envs.length) activeEnvIdx = envs.length - 1;
  renderEnvSelector();
  renderEnvDetail();
  // Allow scheduleUpdate after all sync + async field population is done
  setTimeout(() => { isLoading = false; }, 50);
}

// ── Message Handler ──────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'collectionLoaded') {
    if (ignoreNextLoad) {
      ignoreNextLoad = false;
      return;
    }
    loadCollection(msg.collection);
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
  if (msg.type === 'testSecretProviderResult') {
    // Restore the test button on the target row
    const rows = $('secretProvidersBody').children;
    const targetRow = rows[msg.providerIdx] as HTMLElement | undefined;
    if (targetRow) {
      const btn = targetRow.querySelector('.btn-test-vault') as HTMLButtonElement;
      if (btn) { btn.disabled = false; btn.textContent = 'Test'; }
    }
    // Store secret names for autocomplete
    if (msg.success && msg.providerName && msg.secretNames) {
      setSecretNamesForProvider(msg.providerName, msg.secretNames);
    }
    // Show result
    const resultDiv = $('secretTestResult');
    if (msg.success) {
      resultDiv.innerHTML = `<span style="color:var(--badge-success);">\u2713 Connected \u2014 ${msg.secretCount} secret${msg.secretCount === 1 ? '' : 's'} found</span>`;
    } else {
      resultDiv.innerHTML = `<span style="color:var(--badge-error);">\u2717 ${esc(msg.error || 'Connection failed')}</span>`;
    }
    setTimeout(() => { resultDiv.innerHTML = ''; }, 10000);
  }
  if (msg.type === 'secretNamesResult') {
    if (msg.providerName && msg.secretNames) {
      setSecretNamesForProvider(msg.providerName, msg.secretNames);
    }
  }
  if (msg.type === 'secretValueResolved') {
    handleSecretValueResolved(msg);
  }
  if (msg.type === 'switchTab') {
    const tab = msg.tab;
    const container = $('mainTabs');
    const target = container.querySelector(`.tab[data-tab="${tab}"]`) as HTMLElement | null;
    if (target) target.click();
    // If an environment name was specified, select it
    if (msg.envName && collectionData?.config?.environments) {
      const envs = collectionData.config.environments;
      const idx = envs.findIndex((e: any) => e.name === msg.envName);
      if (idx >= 0) {
        selectEnv(idx);
      }
    }
  }
});

// ── Secret Providers ─────────────────────────
function renderSecretProviders(providers: any[]) {
  const tbody = $('secretProvidersBody');
  tbody.innerHTML = '';
  (providers || []).forEach(p => addSecretProviderRow(p.name, p.type, p.url, p.disabled));
  $('secretsBadge').textContent = String((providers || []).length);
}

function addSecretProviderRow(name?: string, providerType?: string, url?: string, disabled?: boolean) {
  const tbody = $('secretProvidersBody');
  const tr = document.createElement('tr');
  const t = providerType || 'azure-keyvault';
  tr.innerHTML =
    `<td><input type="text" value="${esc(name || '')}" placeholder="my-vault" class="sp-name" /></td>` +
    `<td><select class="type-select select-borderless sp-type"><option value="azure-keyvault"${t === 'azure-keyvault' ? ' selected' : ''}>Azure Key Vault</option></select></td>` +
    `<td class="val-cell"><div class="val-ce sp-url" contenteditable="true" data-placeholder="https://{{vault-name}}.vault.azure.net"></div></td>` +
    `<td><button class="btn-test-vault" title="Test connection">Test</button></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); $('secretsBadge').textContent = String(tbody.children.length); scheduleUpdate(); });
  tr.querySelector<HTMLInputElement>('.sp-name')!.addEventListener('input', scheduleUpdate);
  tr.querySelector<HTMLSelectElement>('.sp-type')!.addEventListener('change', scheduleUpdate);
  enableContentEditableValue(tr.querySelector('.sp-url') as HTMLElement, url || '', scheduleUpdate);
  const testBtn = tr.querySelector('.btn-test-vault') as HTMLButtonElement;
  testBtn.addEventListener('click', () => {
    const providerName = (tr.querySelector('.sp-name') as HTMLInputElement).value;
    const selectedType = (tr.querySelector('.sp-type') as HTMLSelectElement).value;
    const valEl = tr.querySelector('.sp-url') as any;
    const providerUrl = valEl._getRawText ? valEl._getRawText() : (valEl.textContent || '');
    // Show spinner
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="spinner"></span>';
    // Clear any previous result
    const existingResult = tr.querySelector('.sp-test-result');
    if (existingResult) existingResult.remove();
    vscode.postMessage({ type: 'testSecretProvider', providerIdx: Array.from(tbody.children).indexOf(tr), provider: { name: providerName, type: selectedType, url: providerUrl } });
  });
  tbody.appendChild(tr);
}

function buildSecretProviders(): any[] {
  const providers: any[] = [];
  document.querySelectorAll('#secretProvidersBody tr').forEach(tr => {
    const nameInput = tr.querySelector<HTMLInputElement>('.sp-name');
    const typeSelect = tr.querySelector<HTMLSelectElement>('.sp-type');
    const valEl = tr.querySelector('.sp-url') as any;
    if (nameInput?.value) {
      providers.push({
        name: nameInput.value,
        type: typeSelect?.value || 'azure-keyvault',
        url: valEl?._getRawText ? valEl._getRawText() : (valEl?.textContent || ''),
      });
    }
  });
  return providers;
}

// ── Init ─────────────────────────────────────
initVarFields();
setPostMessage((msg: any) => vscode.postMessage(msg));
registerFlushOnSave(() => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!isLoading && collectionData) buildAndSend();
});
initTabs('mainTabs');

$('addDefaultHeaderBtn').addEventListener('click', () => { addHeaderRow(); scheduleUpdate(); });
$('addDefaultVarBtn').addEventListener('click', () => { addDefaultVarRow(); scheduleUpdate(); });
$('defaultAuthType').addEventListener('change', onDefaultAuthChange);
$('varToggleBtn').addEventListener('click', () => {
  setShowResolvedVars(!getShowResolvedVars());
  $('varToggleBtn').classList.toggle('active', getShowResolvedVars());
  syncAllVarOverlays();
});
$('addSecretProviderBtn').addEventListener('click', () => { addSecretProviderRow(); $('secretsBadge').textContent = String($('secretProvidersBody').children.length); scheduleUpdate(); });
$('addEnvBtn').addEventListener('click', addEnv);
$('removeEnvBtn').addEventListener('click', removeEnv);
$('envSelector').addEventListener('change', () => {
  const idx = parseInt(($('envSelector') as HTMLSelectElement).value, 10);
  if (idx >= 0) selectEnv(idx);
});

// Wire overview fields
['infoName', 'infoVersion'].forEach(id => {
  $(id).addEventListener('input', scheduleUpdate);
});
$('infoSummary').addEventListener('input', scheduleUpdate);

vscode.postMessage({ type: 'ready' });
