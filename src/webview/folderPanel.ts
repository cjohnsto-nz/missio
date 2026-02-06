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
  } else if (authType === 'inherit') {
    data.request.auth = 'inherit';
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
    onDefaultAuthChange();
    if (auth.type === 'bearer') {
      const el = document.getElementById('dAuthToken') as HTMLInputElement;
      if (el) el.value = auth.token || '';
    } else if (auth.type === 'basic') {
      const u = document.getElementById('dAuthUser') as HTMLInputElement;
      const p = document.getElementById('dAuthPass') as HTMLInputElement;
      if (u) u.value = auth.username || '';
      if (p) p.value = auth.password || '';
    } else if (auth.type === 'apikey') {
      const k = document.getElementById('dAuthKey') as HTMLInputElement;
      const v = document.getElementById('dAuthValue') as HTMLInputElement;
      if (k) k.value = auth.key || '';
      if (v) v.value = auth.value || '';
    }
  } else {
    ($('defaultAuthType') as HTMLSelectElement).value = 'none';
  }

  // Headers
  renderDefaultHeaders(data.request?.headers || []);

  // Variables
  renderDefaultVars(data.request?.variables || []);

  updateBadges();
  isLoading = false;
}

// ── Wire up events ───────────────────────────
initTabs('mainTabs');

$('defaultAuthType').addEventListener('change', onDefaultAuthChange);
$('addDefaultHeaderBtn').addEventListener('click', () => { addHeaderRow(); updateBadges(); scheduleUpdate(); });
$('addDefaultVarBtn').addEventListener('click', () => { addDefaultVarRow(); updateBadges(); scheduleUpdate(); });

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
});

// Notify extension we're ready
vscode.postMessage({ type: 'ready' });
