import { renderAuthFields, buildAuthData, loadAuthData, type AuthFieldsConfig } from './authFields';
import { initOAuth2TokenStatusController } from './oauth2TokenStatus';
import { escHtml } from './varlib';
import {
  setSecretNamesForProvider,
  getSecretNamesForProvider,
} from './autocomplete';
import {
  highlightVariables, enableVarOverlay, enableContentEditableValue,
  restoreCursor, syncAllVarOverlays, handleVariablesResolved, initVarFields,
  registerFlushOnSave, setPostMessage,
  getResolvedVariables, getVariableSources, getShowResolvedVars, setShowResolvedVars,
} from './varFields';
import { handleSecretValueResolved, handleSetSecretValueResult as handleSetSecretValueResultTooltip } from './varTooltip';

declare function acquireVsCodeApi(): { postMessage(msg: any): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();

let collectionData: any = null;
let collectionRoot = '';
let ignoreNextLoad = false;
let isLoading = false;
let activeEnvIdx = -1;
let saveTimer: any = null;

// Track which providers have write access (set after testConnection)
const _providerWriteAccess = new Map<string, boolean>();

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

// ── Default Variables (plain vars only per schema) ────────────────────────
let defaultVars: any[] = [];

function renderDefaultVars(variables: any[]) {
  defaultVars = variables || [];
  const tbody = $('defaultVarsBody');
  tbody.innerHTML = '';
  defaultVars.forEach((_v: any, i: number) => addDefaultVarRow(i));
}

function addDefaultVarRow(idx: number) {
  const tbody = $('defaultVarsBody');
  const v = defaultVars[idx];
  const tr = document.createElement('tr');
  const chk = v.disabled ? '' : 'checked';
  const val = typeof v.value === 'string' ? v.value : (v.value && v.value.data ? v.value.data : '');

  tr.innerHTML =
    `<td><input type="checkbox" ${chk} data-field="disabled" /></td>` +
    `<td><input type="text" value="${esc(v.name || '')}" placeholder="Variable name" data-field="name" /></td>` +
    '<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="Variable value" data-field="value"></div></td>' +
    `<td><button class="row-delete">\u00d7</button></td>`;

  // Wire inputs
  tr.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(inp => {
    const field = inp.dataset.field!;
    if (inp.type === 'checkbox') {
      inp.addEventListener('change', () => { defaultVars[idx].disabled = !inp.checked; scheduleUpdate(); });
    } else {
      inp.addEventListener('input', () => { defaultVars[idx][field] = inp.value; scheduleUpdate(); });
    }
  });

  // Wire contenteditable value
  const valCE = tr.querySelector('.val-ce[data-field="value"]') as HTMLElement;
  if (valCE) {
    enableContentEditableValue(valCE, val, () => {
      defaultVars[idx].value = (valCE as any)._getRawText ? (valCE as any)._getRawText() : (valCE.textContent || '');
      scheduleUpdate();
    });
  }

  // Delete
  tr.querySelector('.row-delete')!.addEventListener('click', () => {
    defaultVars.splice(idx, 1);
    renderDefaultVars(defaultVars);
    scheduleUpdate();
  });

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
  onFieldsRendered: (elements) => elements.forEach(el => enableContentEditableValue(el, '', scheduleUpdate)),
  authTypeSelectId: 'defaultAuthType',
  postMessage: (msg) => vscode.postMessage(msg),
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

function hasActiveEnvironment(): boolean {
  const envs = collectionData?.config?.environments || [];
  return activeEnvIdx >= 0 && activeEnvIdx < envs.length;
}

function buildUniqueEnvironmentName(baseName: string): string {
  const envs = collectionData?.config?.environments || [];
  const existing = new Set(
    envs
      .map((env: any) => (typeof env?.name === 'string' ? env.name : ''))
      .filter((name: string) => !!name),
  );
  if (!existing.has(baseName)) return baseName;

  let suffix = 2;
  while (existing.has(`${baseName}-${suffix}`)) suffix++;
  return `${baseName}-${suffix}`;
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

function addEnv(mode: 'blank' | 'clone' = 'blank') {
  if (!collectionData.config) collectionData.config = {};
  if (!collectionData.config.environments) collectionData.config.environments = [];

  let newEnv: any;
  if (mode === 'clone' && hasActiveEnvironment()) {
    const source = collectionData.config.environments[activeEnvIdx];
    newEnv = JSON.parse(JSON.stringify(source || {}));
    const sourceName = typeof source?.name === 'string' && source.name.trim()
      ? source.name.trim()
      : 'environment';
    newEnv.name = buildUniqueEnvironmentName(`${sourceName}-copy`);
  } else {
    newEnv = { name: buildUniqueEnvironmentName('new-environment'), variables: [] };
  }

  collectionData.config.environments.push(newEnv);
  activeEnvIdx = collectionData.config.environments.length - 1;
  renderEnvSelector();
  renderEnvDetail();
  scheduleUpdate();
}

function closeAddEnvMenu() {
  const existing = document.querySelector('.env-add-menu');
  if (existing) existing.remove();
}

function openAddEnvMenu(anchor: HTMLElement) {
  closeAddEnvMenu();
  const menu = document.createElement('div');
  menu.className = 'env-add-menu';

  const addOption = (label: string, mode: 'blank' | 'clone') => {
    const btn = document.createElement('button');
    btn.className = 'env-add-menu-item';
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAddEnvMenu();
      addEnv(mode);
    });
    menu.appendChild(btn);
  };

  addOption('Blank', 'blank');
  if (hasActiveEnvironment()) addOption('Clone', 'clone');

  const rect = anchor.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + 'px';
  menu.style.left = rect.right + 'px';
  menu.style.transform = 'translateX(-100%)';
  menu.style.transformOrigin = 'top right';
  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', function handler() {
      closeAddEnvMenu();
      document.removeEventListener('click', handler);
    });
  }, 0);
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
        '<table class="kv-table"><colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:100px"><col style="width:32px"></colgroup><thead><tr><th></th><th>Name</th><th>Value</th><th>Type</th><th></th></tr></thead>' +
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

  const eyeSvg = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3'/></svg>";
  const valueTd = isSecret
    ? '<td class="val-cell"><div class="secret-val-row"><input type="password" class="secret-val-input" data-field="value" placeholder="secret value" /><button class="secret-reveal-btn" title="Show/hide value">' + eyeSvg + '</button></div></td>'
    : '<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="value" data-field="value"></div></td>';

  tr.innerHTML =
    `<td><input type="checkbox" ${chk} data-field="disabled" /></td>` +
    `<td><input type="text" value="${esc(v.name || '')}" data-field="name" /></td>` +
    valueTd +
    `<td><select class="type-select select-borderless" data-field="type"><option value="var"${!isSecret ? ' selected' : ''}>var</option><option value="secret"${isSecret ? ' selected' : ''}>secret</option></select></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;

  // Wire checkbox
  const chkInp = tr.querySelector<HTMLInputElement>('input[data-field="disabled"]');
  chkInp?.addEventListener('change', () => { env.variables[varIdx].disabled = !chkInp.checked; scheduleUpdate(); });

  // Wire name input with rename support for secrets
  const nameInp = tr.querySelector<HTMLInputElement>('input[data-field="name"]');
  if (nameInp) {
    let prevName = v.name || '';
    nameInp.addEventListener('input', () => {
      const newName = nameInp.value;
      if (env.variables[varIdx].secret && prevName && newName && prevName !== newName) {
        vscode.postMessage({ type: 'renameSecretValue', collectionRoot, envName: env.name, oldName: prevName, newName });
      }
      env.variables[varIdx].name = newName;
      prevName = newName;
      scheduleUpdate();
    });
  }

  // Wire value field
  if (isSecret) {
    // Password input for secret vars
    const secretInp = tr.querySelector<HTMLInputElement>('.secret-val-input');
    const revealBtn = tr.querySelector('.secret-reveal-btn') as HTMLElement;
    if (secretInp) {
      // Fetch stored value from SecretStorage to populate
      if (v.name) {
        vscode.postMessage({ type: 'peekSecretValue', collectionRoot, envName: env.name, varName: v.name });
      }
      secretInp.addEventListener('input', () => {
        if (env.variables[varIdx].name) {
          vscode.postMessage({ type: 'storeSecretValue', collectionRoot, envName: env.name, varName: env.variables[varIdx].name, value: secretInp.value });
        }
        scheduleUpdate();
      });
    }
    if (revealBtn && secretInp) {
      revealBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        secretInp.type = secretInp.type === 'password' ? 'text' : 'password';
      });
    }
  } else {
    // Contenteditable for normal vars
    const valCE = tr.querySelector('.val-ce[data-field="value"]') as HTMLElement;
    if (valCE) {
      const initialVal = typeof v.value === 'string' ? v.value : (v.value && v.value.data ? v.value.data : '');
      enableContentEditableValue(valCE, initialVal, () => {
        env.variables[varIdx].value = (valCE as any)._getRawText ? (valCE as any)._getRawText() : (valCE.textContent || '');
        scheduleUpdate();
      });
    }
  }

  // Type dropdown
  const typeSelect = tr.querySelector<HTMLSelectElement>('.type-select');
  typeSelect?.addEventListener('change', () => {
    const newType = typeSelect.value;
    const wasSecret = env.variables[varIdx].secret === true;
    const varName = env.variables[varIdx].name || '';

    if (newType === 'secret' && !wasSecret) {
      // Switching to secret: move current value to SecretStorage, remove from YAML
      const valCE2 = tr.querySelector('.val-ce[data-field="value"]') as any;
      const currentVal = valCE2?._getRawText ? valCE2._getRawText() : (env.variables[varIdx].value ?? '');
      env.variables[varIdx].secret = true;
      delete env.variables[varIdx].value;
      if (varName && currentVal) {
        vscode.postMessage({ type: 'storeSecretValue', collectionRoot, envName: env.name, varName, value: currentVal });
      }
    } else if (newType === 'var' && wasSecret) {
      // Switching to var: value will be empty (secret is in SecretStorage, can't retrieve synchronously)
      delete env.variables[varIdx].secret;
      env.variables[varIdx].value = '';
      if (varName) {
        vscode.postMessage({ type: 'deleteSecretValue', collectionRoot, envName: env.name, varName });
      }
    }
    renderEnvDetail();
    scheduleUpdate();
  });

  // Delete
  tr.querySelector('.row-delete')?.addEventListener('click', () => {
    if (isSecret && v.name) {
      vscode.postMessage({ type: 'deleteSecretValue', collectionRoot, envName: env.name, varName: v.name });
    }
    env.variables.splice(varIdx, 1);
    renderEnvDetail();
    scheduleUpdate();
  });

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
    if (msg.collectionRoot) collectionRoot = msg.collectionRoot;
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
      // Populate role cell
      const roleCell = targetRow.querySelector('.sp-role-cell') as HTMLElement;
      if (roleCell && msg.success) {
        const roleName = msg.role || '';
        const shortRole = roleName.replace('Key Vault ', '');
        if (msg.canWrite) {
          roleCell.innerHTML = '<span class="sp-access-badge writable">' + esc(shortRole) + '</span>';
        } else if (roleName) {
          roleCell.innerHTML = '<span class="sp-access-badge read-only">' + esc(shortRole) + '</span>';
        } else {
          roleCell.innerHTML = '<span class="sp-access-badge read-only">No role</span>';
        }
      }
    }
    // Store secret names for autocomplete
    if (msg.success && msg.providerName && msg.secretNames) {
      setSecretNamesForProvider(msg.providerName, msg.secretNames);
    }
    // Track write access
    if (msg.success && msg.providerName) {
      _providerWriteAccess.set(msg.providerName, !!msg.canWrite);
    }
    // Show result
    const resultDiv = $('secretTestResult');
    if (msg.success) {
      resultDiv.innerHTML = `<span style="color:var(--badge-success);">\u2713 Connected \u2014 ${msg.secretCount} secret${msg.secretCount === 1 ? '' : 's'} found</span>`;
    } else {
      resultDiv.innerHTML = `<span style="color:var(--badge-error);">\u2717 ${esc(msg.error || 'Connection failed')}</span>`;
    }
    // Update create secret form visibility
    updateCreateSecretForm();
    setTimeout(() => { resultDiv.innerHTML = ''; }, 15000);
  }
  if (msg.type === 'secretNamesResult') {
    if (msg.providerName && msg.secretNames) {
      setSecretNamesForProvider(msg.providerName, msg.secretNames);
    }
  }
  if (msg.type === 'secretValuePeek') {
    // Populate the password input for a secret env var with its stored value
    const envs = collectionData?.config?.environments || [];
    const env = envs[activeEnvIdx];
    if (env?.variables && msg.envName === env.name) {
      const rows = $('envVarsBody')?.children;
      if (rows) {
        for (let i = 0; i < rows.length && i < env.variables.length; i++) {
          if (env.variables[i].name === msg.varName && env.variables[i].secret) {
            const inp = (rows[i] as HTMLElement).querySelector<HTMLInputElement>('.secret-val-input');
            if (inp) inp.value = msg.value || '';
            break;
          }
        }
      }
    }
  }
  if (msg.type === 'secretValueResolved') {
    handleSecretValueResolved(msg);
  }
  if (msg.type === 'createSecretInVaultResult') {
    const resultDiv = $('createSecretResult');
    const btn = $('createSecretBtn') as HTMLButtonElement;
    if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
    if (msg.success) {
      if (resultDiv) resultDiv.innerHTML = `<span style="color:var(--badge-success);">✓ Secret "${esc(msg.secretName)}" saved to ${esc(msg.providerName)}</span>`;
      // Clear form inputs
      const nameInp = $('createSecretName') as HTMLInputElement;
      const valInp = $('createSecretValue') as HTMLInputElement;
      if (nameInp) nameInp.value = '';
      if (valInp) valInp.value = '';
      // Update autocomplete
      if (msg.providerName && msg.secretNames) {
        setSecretNamesForProvider(msg.providerName, msg.secretNames);
      }
    } else {
      if (resultDiv) resultDiv.innerHTML = `<span style="color:var(--badge-error);">✗ ${esc(msg.error || 'Failed to create secret')}</span>`;
    }
    if (resultDiv) setTimeout(() => { resultDiv.innerHTML = ''; }, 10000);
  }
  if (msg.type === 'setSecretValueResult') {
    handleSetSecretValueResultTooltip(msg);
    handleSetSecretValueResult(msg);
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
  (providers || []).forEach(p => addSecretProviderRow(p.name, p.type, p.namespace, p.subscription, p.disabled));
  $('secretsBadge').textContent = String((providers || []).length);
}

function addSecretProviderRow(name?: string, providerType?: string, namespace?: string, subscription?: string, disabled?: boolean) {
  const tbody = $('secretProvidersBody');
  const tr = document.createElement('tr');
  const t = providerType || 'azure-keyvault';
  tr.innerHTML =
    `<td><input type="text" value="${esc(name || '')}" placeholder="my-vault" class="sp-name" /></td>` +
    `<td><select class="type-select select-borderless sp-type"><option value="azure-keyvault"${t === 'azure-keyvault' ? ' selected' : ''}>Azure Key Vault</option></select></td>` +
    `<td class="val-cell"><div class="val-ce sp-ns" contenteditable="true" data-placeholder="{{vault-name}}"></div></td>` +
    `<td class="val-cell"><div class="val-ce sp-sub" contenteditable="true" data-placeholder="subscription name or ID (optional)"></div></td>` +
    `<td class="sp-role-cell"></td>` +
    `<td><button class="btn-test-vault" title="Test connection">Test</button></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); $('secretsBadge').textContent = String(tbody.children.length); scheduleUpdate(); });
  tr.querySelector<HTMLInputElement>('.sp-name')!.addEventListener('input', scheduleUpdate);
  tr.querySelector<HTMLSelectElement>('.sp-type')!.addEventListener('change', scheduleUpdate);
  enableContentEditableValue(tr.querySelector('.sp-ns') as HTMLElement, namespace || '', scheduleUpdate);
  enableContentEditableValue(tr.querySelector('.sp-sub') as HTMLElement, subscription || '', scheduleUpdate);
  const testBtn = tr.querySelector('.btn-test-vault') as HTMLButtonElement;
  testBtn.addEventListener('click', () => {
    const providerName = (tr.querySelector('.sp-name') as HTMLInputElement).value;
    const selectedType = (tr.querySelector('.sp-type') as HTMLSelectElement).value;
    const nsEl = tr.querySelector('.sp-ns') as any;
    const providerNs = nsEl._getRawText ? nsEl._getRawText() : (nsEl.textContent || '');
    const subEl = tr.querySelector('.sp-sub') as any;
    const providerSub = subEl?._getRawText ? subEl._getRawText() : (subEl?.textContent || '');
    // Show spinner
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="spinner"></span>';
    // Clear any previous result
    const existingResult = tr.querySelector('.sp-test-result');
    if (existingResult) existingResult.remove();
    vscode.postMessage({ type: 'testSecretProvider', providerIdx: Array.from(tbody.children).indexOf(tr), provider: { name: providerName, type: selectedType, namespace: providerNs, subscription: providerSub || undefined } });
  });
  tbody.appendChild(tr);
}

function buildSecretProviders(): any[] {
  const providers: any[] = [];
  document.querySelectorAll('#secretProvidersBody tr').forEach(tr => {
    const nameInput = tr.querySelector<HTMLInputElement>('.sp-name');
    const typeSelect = tr.querySelector<HTMLSelectElement>('.sp-type');
    const nsEl = tr.querySelector('.sp-ns') as any;
    if (nameInput?.value) {
      const subEl = tr.querySelector('.sp-sub') as any;
      const sub = subEl?._getRawText ? subEl._getRawText() : (subEl?.textContent || '');
      const entry: any = {
        name: nameInput.value,
        type: typeSelect?.value || 'azure-keyvault',
        namespace: nsEl?._getRawText ? nsEl._getRawText() : (nsEl?.textContent || ''),
      };
      if (sub) entry.subscription = sub;
      providers.push(entry);
    }
  });
  return providers;
}

// ── Create Secret Form ───────────────────────
function getWritableProviders(): string[] {
  const names: string[] = [];
  for (const [name, canWrite] of _providerWriteAccess) {
    if (canWrite) names.push(name);
  }
  return names;
}

function updateCreateSecretForm() {
  const container = $('createSecretFormContainer');
  if (!container) return;
  const writable = getWritableProviders();
  if (writable.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML =
    '<div class="create-secret-form">' +
      '<div class="form-title">Create / Update Secret</div>' +
      '<div class="form-row">' +
        '<div class="form-field">' +
          '<label>Provider</label>' +
          '<select id="createSecretProvider">' +
            writable.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('') +
          '</select>' +
        '</div>' +
        '<div class="form-field" style="position:relative;">' +
          '<label>Secret Name</label>' +
          '<input type="text" id="createSecretName" placeholder="my-secret-key" autocomplete="off" />' +
          '<div id="createSecretNameDropdown" class="secret-name-dropdown"></div>' +
        '</div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-field">' +
          '<label>Value</label>' +
          '<input type="password" id="createSecretValue" placeholder="secret value" />' +
        '</div>' +
        '<button class="create-secret-btn" id="createSecretBtn" style="width:80px;flex-shrink:0;">Create</button>' +
      '</div>' +
      '<div id="createSecretResult" class="create-secret-result"></div>' +
    '</div>';

  // Wire create button
  const btn = $('createSecretBtn') as HTMLButtonElement;
  btn.addEventListener('click', () => {
    const providerName = ($('createSecretProvider') as HTMLSelectElement).value;
    const secretName = ($('createSecretName') as HTMLInputElement).value.trim();
    const value = ($('createSecretValue') as HTMLInputElement).value;
    if (!providerName || !secretName) {
      const rd = $('createSecretResult');
      if (rd) rd.innerHTML = '<span style="color:var(--badge-error);">Provider and secret name are required.</span>';
      return;
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    vscode.postMessage({ type: 'createSecretInVault', providerName, secretName, value });
  });

  // Wire reveal toggle on value input
  const valInp = $('createSecretValue') as HTMLInputElement;
  valInp?.addEventListener('dblclick', () => {
    valInp.type = valInp.type === 'password' ? 'text' : 'password';
  });

  // Custom autocomplete dropdown for secret name
  const providerSelect = $('createSecretProvider') as HTMLSelectElement;
  const nameInp = $('createSecretName') as HTMLInputElement;
  const dropdown = $('createSecretNameDropdown') as HTMLElement;

  function showSecretNameDropdown() {
    if (!dropdown || !nameInp) return;
    const names = getSecretNamesForProvider(providerSelect.value);
    const filter = nameInp.value.toLowerCase();
    const filtered = filter ? names.filter(n => n.toLowerCase().includes(filter)) : names;
    if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = filtered.map(n =>
      '<div class="secret-name-option">' + esc(n) + '</div>'
    ).join('');
    dropdown.style.display = 'block';
    dropdown.querySelectorAll('.secret-name-option').forEach(opt => {
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        nameInp.value = (opt as HTMLElement).textContent || '';
        dropdown.style.display = 'none';
      });
    });
  }

  nameInp?.addEventListener('focus', showSecretNameDropdown);
  nameInp?.addEventListener('input', showSecretNameDropdown);
  nameInp?.addEventListener('blur', () => { if (dropdown) dropdown.style.display = 'none'; });
  providerSelect?.addEventListener('change', () => { if (dropdown) dropdown.style.display = 'none'; });
}

function handleSetSecretValueResult(msg: { secretRef: string; success: boolean; error?: string }) {
  // This is called from the tooltip's setSecretValue flow
  // The tooltip itself is in varTooltip.ts — we just need to forward the result
  // The tooltip listens for this via the message handler
  if (!msg.success && msg.error) {
    // Show a toast-style error in the test result area as a fallback
    const resultDiv = $('secretTestResult');
    if (resultDiv) {
      resultDiv.innerHTML = '<span style="color:var(--badge-error);">\u2717 ' + esc(msg.error) + '</span>';
      setTimeout(() => { resultDiv.innerHTML = ''; }, 10000);
    }
  }
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
$('addDefaultVarBtn').addEventListener('click', () => { defaultVars.push({ name: '', value: '' }); renderDefaultVars(defaultVars); scheduleUpdate(); });
$('defaultAuthType').addEventListener('change', onDefaultAuthChange);
$('varToggleBtn').addEventListener('click', () => {
  setShowResolvedVars(!getShowResolvedVars());
  $('varToggleBtn').classList.toggle('active', getShowResolvedVars());
  syncAllVarOverlays();
});
$('addSecretProviderBtn').addEventListener('click', () => { addSecretProviderRow(); $('secretsBadge').textContent = String($('secretProvidersBody').children.length); scheduleUpdate(); });
$('addEnvBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (hasActiveEnvironment()) {
    openAddEnvMenu($('addEnvBtn'));
  } else {
    addEnv('blank');
  }
});
$('importEnvBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'importEnvironment' });
});
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
