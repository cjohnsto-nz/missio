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
    const inputs = tr.querySelectorAll<HTMLInputElement>('input[type="text"]');
    const chk = tr.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (inputs[0]?.value) {
      const h: any = { name: inputs[0].value, value: inputs[1]?.value || '' };
      if (chk && !chk.checked) h.disabled = true;
      headers.push(h);
    }
  });
  if (!data.request) data.request = {};
  data.request.headers = headers.length > 0 ? headers : undefined;

  // Default auth
  const authType = ($('defaultAuthType') as HTMLSelectElement).value;
  if (authType === 'bearer') {
    data.request.auth = { type: 'bearer', token: ($('dAuthToken') as HTMLInputElement)?.value || '' };
  } else if (authType === 'basic') {
    data.request.auth = { type: 'basic', username: ($('dAuthUser') as HTMLInputElement)?.value || '', password: ($('dAuthPass') as HTMLInputElement)?.value || '' };
  } else if (authType === 'apikey') {
    data.request.auth = { type: 'apikey', key: ($('dAuthKey') as HTMLInputElement)?.value || '', value: ($('dAuthValue') as HTMLInputElement)?.value || '' };
  } else {
    delete data.request.auth;
  }

  // Default variables
  const vars: any[] = [];
  document.querySelectorAll('#defaultVarsBody tr').forEach(tr => {
    const inputs = tr.querySelectorAll<HTMLInputElement>('input[type="text"]');
    const chk = tr.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (inputs[0]?.value) {
      const v: any = { name: inputs[0].value, value: inputs[1]?.value || '' };
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
    `<td><input type="text" value="${esc(value || '')}" placeholder="Header value" /></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); scheduleUpdate(); });
  tr.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', scheduleUpdate);
    inp.addEventListener('change', scheduleUpdate);
  });
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
    `<td><input type="text" value="${esc(val)}" placeholder="Variable value" /></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); scheduleUpdate(); });
  tr.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', scheduleUpdate);
    inp.addEventListener('change', scheduleUpdate);
  });
  tbody.appendChild(tr);
}

// ── Default Auth ─────────────────────────────
function onDefaultAuthChange() {
  const type = ($('defaultAuthType') as HTMLSelectElement).value;
  const fields = $('defaultAuthFields');
  fields.innerHTML = '';
  if (type === 'bearer') {
    fields.innerHTML = '<div class="auth-row"><label>Token</label><input type="text" id="dAuthToken" placeholder="{{token}}" /></div>';
  } else if (type === 'basic') {
    fields.innerHTML =
      '<div class="auth-row"><label>Username</label><input type="text" id="dAuthUser" /></div>' +
      '<div class="auth-row"><label>Password</label><input type="password" id="dAuthPass" /></div>';
  } else if (type === 'apikey') {
    fields.innerHTML =
      '<div class="auth-row"><label>Key</label><input type="text" id="dAuthKey" placeholder="X-Api-Key" /></div>' +
      '<div class="auth-row"><label>Value</label><input type="text" id="dAuthValue" placeholder="{{apiKey}}" /></div>';
  }
  fields.querySelectorAll('input').forEach(inp => inp.addEventListener('input', scheduleUpdate));
  scheduleUpdate();
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
        '<table class="kv-table"><thead><tr><th></th><th>Name</th><th>Value</th><th>Type</th><th></th></tr></thead>' +
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
    `<td>${isSecret
      ? '<div class="secret-value-wrap"><input type="password" value="' + esc(val) + '" data-field="value" /><button class="secret-toggle" title="Show/hide">&#9673;</button></div>'
      : '<input type="text" value="' + esc(val) + '" data-field="value" />'
    }</td>` +
    `<td><select class="type-select" data-field="type"><option value="var"${!isSecret ? ' selected' : ''}>var</option><option value="secret"${isSecret ? ' selected' : ''}>secret</option></select></td>` +
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
    onDefaultAuthChange();
    setTimeout(() => {
      if (auth.type === 'bearer') { const el = $('dAuthToken') as HTMLInputElement; if (el) el.value = auth.token || ''; }
      if (auth.type === 'basic') {
        const u = $('dAuthUser') as HTMLInputElement; if (u) u.value = auth.username || '';
        const p = $('dAuthPass') as HTMLInputElement; if (p) p.value = auth.password || '';
      }
      if (auth.type === 'apikey') {
        const k = $('dAuthKey') as HTMLInputElement; if (k) k.value = auth.key || '';
        const v = $('dAuthValue') as HTMLInputElement; if (v) v.value = auth.value || '';
      }
    }, 0);
  } else {
    ($('defaultAuthType') as HTMLSelectElement).value = 'none';
    onDefaultAuthChange();
  }

  // Badges
  $('headersBadge').textContent = String((data.request?.headers || []).length);
  $('variablesBadge').textContent = String((data.request?.variables || []).length);

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

// ── Init ─────────────────────────────────────
initTabs('mainTabs');

$('addDefaultHeaderBtn').addEventListener('click', () => { addHeaderRow(); scheduleUpdate(); });
$('addDefaultVarBtn').addEventListener('click', () => { addDefaultVarRow(); scheduleUpdate(); });
$('defaultAuthType').addEventListener('change', onDefaultAuthChange);
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
