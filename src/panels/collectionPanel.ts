import * as vscode from 'vscode';
import type { MissioCollection, OpenCollection, Environment, Variable, SecretVariable } from '../models/types';
import type { CollectionService } from '../services/collectionService';
import { stringifyYaml } from '../services/yamlParser';

export class CollectionPanel implements vscode.Disposable {
  public static readonly viewType = 'missio.collectionEditor';
  private static _panels: Map<string, CollectionPanel> = new Map();

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _collection: MissioCollection,
    private readonly _collectionService: CollectionService,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables,
    );
  }

  static async open(
    collection: MissioCollection,
    collectionService: CollectionService,
    extensionUri: vscode.Uri,
  ): Promise<CollectionPanel> {
    const existing = CollectionPanel._panels.get(collection.id);
    if (existing) {
      existing._panel.reveal();
      return existing;
    }

    const title = collection.data.info?.name ?? 'Collection';
    const panel = vscode.window.createWebviewPanel(
      CollectionPanel.viewType,
      `${title} — Settings`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );

    const cp = new CollectionPanel(panel, collection, collectionService);
    CollectionPanel._panels.set(collection.id, cp);
    panel.webview.html = cp._getHtml();
    panel.webview.postMessage({ type: 'collectionLoaded', collection: collection.data, filePath: collection.filePath });
    return cp;
  }

  private async _handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'save': {
        await this._save(msg.collection);
        break;
      }
      case 'ready': {
        this._panel.webview.postMessage({ type: 'collectionLoaded', collection: this._collection.data, filePath: this._collection.filePath });
        break;
      }
    }
  }

  private async _save(data: OpenCollection): Promise<void> {
    try {
      this._collection.data = data;
      const content = stringifyYaml(data, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(this._collection.filePath),
        Buffer.from(content, 'utf-8'),
      );
      this._panel.webview.postMessage({ type: 'saved' });
      vscode.window.showInformationMessage('Collection saved.');
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to save collection: ${e.message}`);
    }
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #333);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #444);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --danger: #ef4444;
    --success: #22c55e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg);
    background: var(--bg);
    overflow-y: auto;
    padding: 0 0 40px 0;
  }

  /* ── Layout ──────────────────────────────── */
  .header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 10;
  }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header .actions { display: flex; gap: 8px; }
  .btn {
    padding: 6px 16px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }
  .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
  .btn-primary:hover { background: var(--btn-hover); }
  .btn-secondary { background: transparent; color: var(--fg); border: 1px solid var(--input-border); }
  .btn-secondary:hover { border-color: var(--btn-bg); }
  .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
  .btn-danger:hover { background: rgba(239,68,68,0.1); }
  .btn-sm { padding: 4px 10px; font-size: 12px; }

  .content { padding: 0 24px; }

  /* ── Sections ────────────────────────────── */
  .section {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-top: 16px;
    overflow: hidden;
  }
  .section-header {
    padding: 10px 16px;
    background: var(--vscode-sideBar-background, rgba(0,0,0,0.1));
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    user-select: none;
  }
  .section-header h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .section-header .chevron { transition: transform 0.2s; font-size: 12px; }
  .section-header .chevron.collapsed { transform: rotate(-90deg); }
  .section-body { padding: 16px; }
  .section-body.collapsed { display: none; }

  /* ── Forms ───────────────────────────────── */
  .form-group { margin-bottom: 12px; }
  .form-group label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
    margin-bottom: 4px;
  }
  .form-group input, .form-group select, .form-group textarea {
    width: 100%;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
    font-family: inherit;
  }
  .form-group textarea { min-height: 60px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
    outline: 1px solid var(--btn-bg); border-color: var(--btn-bg);
  }
  .form-row { display: flex; gap: 12px; }
  .form-row .form-group { flex: 1; }

  /* ── Environment Cards ───────────────────── */
  .env-list { display: flex; flex-direction: column; gap: 8px; }
  .env-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .env-card-header {
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    user-select: none;
  }
  .env-card-header .env-name {
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .env-color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    border: 1px solid var(--border);
  }
  .env-card-body { padding: 12px; border-top: 1px solid var(--border); }
  .env-card-body.collapsed { display: none; }

  /* ── Variable Table ──────────────────────── */
  .var-table { width: 100%; border-collapse: collapse; }
  .var-table th {
    text-align: left;
    padding: 4px 8px;
    font-size: 11px;
    text-transform: uppercase;
    color: #888;
    border-bottom: 1px solid var(--border);
    font-weight: 500;
  }
  .var-table td { padding: 3px 6px; border-bottom: 1px solid var(--border); }
  .var-table input[type="text"] {
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    color: var(--fg);
    padding: 3px 6px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    border-radius: 3px;
  }
  .var-table input[type="text"]:focus { border-color: var(--btn-bg); outline: none; background: var(--input-bg); }
  .var-table input[type="checkbox"] { cursor: pointer; }
  .var-table .row-delete {
    background: none; border: none; color: #666; cursor: pointer; padding: 3px; font-size: 14px; border-radius: 3px;
  }
  .var-table .row-delete:hover { color: var(--danger); }
  .add-row-btn {
    background: transparent;
    color: var(--btn-bg);
    border: 1px dashed var(--input-border);
    padding: 5px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    margin-top: 6px;
    width: 100%;
  }
  .add-row-btn:hover { border-color: var(--btn-bg); }
  .secret-badge {
    background: rgba(239,68,68,0.15);
    color: var(--danger);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
  }

  /* ── Headers Table ───────────────────────── */
  .hdr-table { width: 100%; border-collapse: collapse; }
  .hdr-table th {
    text-align: left; padding: 4px 8px; font-size: 11px; text-transform: uppercase;
    color: #888; border-bottom: 1px solid var(--border); font-weight: 500;
  }
  .hdr-table td { padding: 3px 6px; border-bottom: 1px solid var(--border); }
  .hdr-table input[type="text"] {
    width: 100%; background: transparent; border: 1px solid transparent;
    color: var(--fg); padding: 3px 6px; font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace); border-radius: 3px;
  }
  .hdr-table input[type="text"]:focus { border-color: var(--btn-bg); outline: none; background: var(--input-bg); }
  .hdr-table input[type="checkbox"] { cursor: pointer; }
  .hdr-table .row-delete { background: none; border: none; color: #666; cursor: pointer; padding: 3px; font-size: 14px; border-radius: 3px; }
  .hdr-table .row-delete:hover { color: var(--danger); }

  .file-path { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: #888; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1 id="collectionTitle">Collection Settings</h1>
      <span class="file-path" id="filePath"></span>
    </div>
    <div class="actions">
      <button class="btn btn-primary" id="saveCollectionBtn">Save Collection</button>
    </div>
  </div>

  <div class="content">
    <!-- Info Section -->
    <div class="section">
      <div class="section-header">
        <h2>Collection Info</h2>
        <span class="chevron">▼</span>
      </div>
      <div class="section-body">
        <div class="form-row">
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="infoName" placeholder="My API Collection" />
          </div>
          <div class="form-group">
            <label>Version</label>
            <input type="text" id="infoVersion" placeholder="1.0.0" />
          </div>
        </div>
        <div class="form-group">
          <label>Summary</label>
          <textarea id="infoSummary" placeholder="A short description of this collection"></textarea>
        </div>
      </div>
    </div>

    <!-- Environments Section -->
    <div class="section">
      <div class="section-header">
        <h2>Environments</h2>
        <span class="chevron">▼</span>
      </div>
      <div class="section-body">
        <div class="env-list" id="envList"></div>
        <button class="add-row-btn" id="addEnvBtn" style="margin-top:12px;">+ Add Environment</button>
      </div>
    </div>

    <!-- Request Defaults Section -->
    <div class="section">
      <div class="section-header">
        <h2>Default Headers</h2>
        <span class="chevron">▼</span>
      </div>
      <div class="section-body">
        <table class="hdr-table">
          <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
          <tbody id="defaultHeadersBody"></tbody>
        </table>
        <button class="add-row-btn" id="addDefaultHeaderBtn">+ Add Header</button>
      </div>
    </div>

    <!-- Auth Defaults Section -->
    <div class="section">
      <div class="section-header">
        <h2>Default Auth</h2>
        <span class="chevron">▼</span>
      </div>
      <div class="section-body">
        <div class="form-group">
          <label>Auth Type</label>
          <select id="defaultAuthType">
            <option value="none">None</option>
            <option value="bearer">Bearer Token</option>
            <option value="basic">Basic Auth</option>
            <option value="apikey">API Key</option>
          </select>
        </div>
        <div id="defaultAuthFields"></div>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let collectionData = null;

  // ── Section Toggle ─────────────────────────
  function toggleSection(header) {
    const body = header.nextElementSibling;
    const chevron = header.querySelector('.chevron');
    body.classList.toggle('collapsed');
    chevron.classList.toggle('collapsed');
  }

  // ── Environments ───────────────────────────
  function renderEnvironments(environments) {
    const list = document.getElementById('envList');
    list.innerHTML = '';
    (environments || []).forEach(function(env, idx) {
      const card = document.createElement('div');
      card.className = 'env-card';
      card.dataset.idx = idx;

      const color = env.color || '#888';
      card.innerHTML =
        '<div class="env-card-header">' +
          '<div class="env-name"><span class="env-color-dot" style="background:' + esc(color) + '"></span>' + esc(env.name) + '</div>' +
          '<div style="display:flex;gap:6px;align-items:center;">' +
            '<span style="color:#888;font-size:12px;">' + (env.variables ? env.variables.length : 0) + ' vars</span>' +
            '<button class="btn btn-danger btn-sm env-remove-btn">Remove</button>' +
          '</div>' +
        '</div>' +
        '<div class="env-card-body collapsed" id="envBody-' + idx + '">' +
          '<div class="form-row" style="margin-bottom:8px;">' +
            '<div class="form-group"><label>Name</label><input type="text" class="env-input-name" value="' + esc(env.name) + '" /></div>' +
            '<div class="form-group"><label>Color</label><input type="color" class="env-input-color" value="' + esc(color) + '" style="width:100%;height:30px;padding:2px;border-radius:4px;" /></div>' +
            '<div class="form-group"><label>Extends</label><input type="text" class="env-input-extends" value="' + esc(env.extends || '') + '" placeholder="parent env name" /></div>' +
          '</div>' +
          '<div class="form-group"><label>dotenv File</label><input type="text" class="env-input-dotenv" value="' + esc(env.dotEnvFilePath || '') + '" placeholder=".env.local" /></div>' +
          '<label style="font-size:11px;text-transform:uppercase;color:#888;letter-spacing:0.5px;margin:8px 0 4px;display:block;">Variables</label>' +
          '<table class="var-table"><thead><tr><th></th><th>Name</th><th>Value</th><th>Type</th><th></th></tr></thead>' +
          '<tbody id="envVars-' + idx + '"></tbody></table>' +
          '<button class="add-row-btn env-add-var-btn">+ Add Variable</button>' +
          '<button class="add-row-btn env-add-secret-btn" style="margin-top:4px;">+ Add Secret Variable</button>' +
        '</div>';

      list.appendChild(card);

      // Wire env card header toggle
      var header = card.querySelector('.env-card-header');
      header.addEventListener('click', function(e) {
        if (e.target.closest('.env-remove-btn')) return;
        toggleEnvCard(header);
      });
      // Wire remove button
      card.querySelector('.env-remove-btn').addEventListener('click', function(e) {
        e.stopPropagation();
        removeEnvironment(idx);
      });
      // Wire field change events
      card.querySelector('.env-input-name').addEventListener('change', function() { updateEnvName(idx, this.value); });
      card.querySelector('.env-input-color').addEventListener('change', function() { updateEnvColor(idx, this.value); });
      card.querySelector('.env-input-extends').addEventListener('change', function() { updateEnvExtends(idx, this.value); });
      card.querySelector('.env-input-dotenv').addEventListener('change', function() { updateEnvDotenv(idx, this.value); });
      // Wire add variable buttons
      card.querySelector('.env-add-var-btn').addEventListener('click', function() { addEnvVar(idx); });
      card.querySelector('.env-add-secret-btn').addEventListener('click', function() { addEnvSecret(idx); });

      // Render variables
      const tbody = document.getElementById('envVars-' + idx);
      (env.variables || []).forEach(function(v, vi) {
        addVarRow(tbody, v, idx, vi);
      });
    });
  }

  function addVarRow(tbody, v, envIdx, varIdx) {
    const tr = document.createElement('tr');
    tr.dataset.envIdx = envIdx;
    tr.dataset.varIdx = varIdx;
    const isSecret = v.secret === true;
    const chk = v.disabled ? '' : 'checked';
    const ei = envIdx;
    const vi = varIdx;
    if (isSecret) {
      tr.innerHTML =
        '<td><input type="checkbox" ' + chk + ' data-field="disabled" /></td>' +
        '<td><input type="text" value="' + esc(v.name || '') + '" data-field="name" /></td>' +
        '<td style="color:#888;font-style:italic;">— secret —</td>' +
        '<td><span class="secret-badge">SECRET</span></td>' +
        '<td><button class="row-delete">×</button></td>';
    } else {
      const val = typeof v.value === 'string' ? v.value : (v.value && v.value.data ? v.value.data : '');
      tr.innerHTML =
        '<td><input type="checkbox" ' + chk + ' data-field="disabled" /></td>' +
        '<td><input type="text" value="' + esc(v.name || '') + '" data-field="name" /></td>' +
        '<td><input type="text" value="' + esc(val) + '" data-field="value" /></td>' +
        '<td style="color:#888;font-size:11px;">var</td>' +
        '<td><button class="row-delete">×</button></td>';
    }
    // Wire events
    tr.querySelectorAll('input[data-field]').forEach(function(inp) {
      var field = inp.dataset.field;
      if (inp.type === 'checkbox') {
        inp.addEventListener('change', function() { updateVarField(ei, vi, field, !this.checked); });
      } else {
        inp.addEventListener('change', function() { updateVarField(ei, vi, field, this.value); });
      }
    });
    var delBtn = tr.querySelector('.row-delete');
    if (delBtn) delBtn.addEventListener('click', function() { removeVar(ei, vi); });
    tbody.appendChild(tr);
  }

  function toggleEnvCard(header) {
    const body = header.nextElementSibling;
    body.classList.toggle('collapsed');
  }

  function addEnvironment() {
    if (!collectionData.config) collectionData.config = {};
    if (!collectionData.config.environments) collectionData.config.environments = [];
    collectionData.config.environments.push({ name: 'new-environment', variables: [] });
    renderEnvironments(collectionData.config.environments);
  }

  function removeEnvironment(idx) {
    collectionData.config.environments.splice(idx, 1);
    renderEnvironments(collectionData.config.environments);
  }

  function updateEnvName(idx, val) { collectionData.config.environments[idx].name = val; }
  function updateEnvColor(idx, val) { collectionData.config.environments[idx].color = val; }
  function updateEnvExtends(idx, val) {
    if (val) collectionData.config.environments[idx].extends = val;
    else delete collectionData.config.environments[idx].extends;
  }
  function updateEnvDotenv(idx, val) {
    if (val) collectionData.config.environments[idx].dotEnvFilePath = val;
    else delete collectionData.config.environments[idx].dotEnvFilePath;
  }

  function addEnvVar(envIdx) {
    if (!collectionData.config.environments[envIdx].variables) collectionData.config.environments[envIdx].variables = [];
    collectionData.config.environments[envIdx].variables.push({ name: '', value: '' });
    renderEnvironments(collectionData.config.environments);
    // Expand the card
    const body = document.getElementById('envBody-' + envIdx);
    if (body) body.classList.remove('collapsed');
  }

  function addEnvSecret(envIdx) {
    if (!collectionData.config.environments[envIdx].variables) collectionData.config.environments[envIdx].variables = [];
    collectionData.config.environments[envIdx].variables.push({ secret: true, name: '' });
    renderEnvironments(collectionData.config.environments);
    const body = document.getElementById('envBody-' + envIdx);
    if (body) body.classList.remove('collapsed');
  }

  function removeVar(envIdx, varIdx) {
    collectionData.config.environments[envIdx].variables.splice(varIdx, 1);
    renderEnvironments(collectionData.config.environments);
    const body = document.getElementById('envBody-' + envIdx);
    if (body) body.classList.remove('collapsed');
  }

  function updateVarField(envIdx, varIdx, field, val) {
    collectionData.config.environments[envIdx].variables[varIdx][field] = val;
  }

  // ── Default Headers ────────────────────────
  function renderDefaultHeaders(headers) {
    const tbody = document.getElementById('defaultHeadersBody');
    tbody.innerHTML = '';
    (headers || []).forEach(function(h, i) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="checkbox" ' + (h.disabled ? '' : 'checked') + ' /></td>' +
        '<td><input type="text" value="' + esc(h.name) + '" placeholder="Header name" /></td>' +
        '<td><input type="text" value="' + esc(h.value) + '" placeholder="Header value" /></td>' +
        '<td><button class="row-delete">×</button></td>';
      tr.querySelector('.row-delete').addEventListener('click', function() { tr.remove(); });
      tbody.appendChild(tr);
    });
  }

  function addDefaultHeader(name, value) {
    const tbody = document.getElementById('defaultHeadersBody');
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="checkbox" checked /></td>' +
      '<td><input type="text" value="' + esc(name || '') + '" placeholder="Header name" /></td>' +
      '<td><input type="text" value="' + esc(value || '') + '" placeholder="Header value" /></td>' +
      '<td><button class="row-delete">×</button></td>';
    tr.querySelector('.row-delete').addEventListener('click', function() { tr.remove(); });
    tbody.appendChild(tr);
  }

  // ── Default Auth ───────────────────────────
  function onDefaultAuthChange() {
    const type = document.getElementById('defaultAuthType').value;
    const fields = document.getElementById('defaultAuthFields');
    fields.innerHTML = '';
    if (type === 'bearer') {
      fields.innerHTML = '<div class="form-group"><label>Token</label><input type="text" id="dAuthToken" placeholder="{{token}}" /></div>';
    } else if (type === 'basic') {
      fields.innerHTML =
        '<div class="form-group"><label>Username</label><input type="text" id="dAuthUser" /></div>' +
        '<div class="form-group"><label>Password</label><input type="password" id="dAuthPass" /></div>';
    } else if (type === 'apikey') {
      fields.innerHTML =
        '<div class="form-group"><label>Key</label><input type="text" id="dAuthKey" placeholder="X-Api-Key" /></div>' +
        '<div class="form-group"><label>Value</label><input type="text" id="dAuthValue" placeholder="{{apiKey}}" /></div>';
    }
  }

  // ── Build & Save ───────────────────────────
  function saveCollection() {
    // Info
    collectionData.info = collectionData.info || {};
    collectionData.info.name = document.getElementById('infoName').value || undefined;
    collectionData.info.version = document.getElementById('infoVersion').value || undefined;
    collectionData.info.summary = document.getElementById('infoSummary').value || undefined;

    // Default headers
    const headers = [];
    document.querySelectorAll('#defaultHeadersBody tr').forEach(tr => {
      const inputs = tr.querySelectorAll('input[type="text"]');
      const enabled = tr.querySelector('input[type="checkbox"]');
      if (inputs[0].value) {
        headers.push({ name: inputs[0].value, value: inputs[1].value, disabled: !enabled.checked || undefined });
      }
    });
    if (!collectionData.request) collectionData.request = {};
    collectionData.request.headers = headers.length > 0 ? headers : undefined;

    // Default auth
    const authType = document.getElementById('defaultAuthType').value;
    if (authType === 'bearer') {
      collectionData.request.auth = { type: 'bearer', token: document.getElementById('dAuthToken')?.value || '' };
    } else if (authType === 'basic') {
      collectionData.request.auth = { type: 'basic', username: document.getElementById('dAuthUser')?.value || '', password: document.getElementById('dAuthPass')?.value || '' };
    } else if (authType === 'apikey') {
      collectionData.request.auth = { type: 'apikey', key: document.getElementById('dAuthKey')?.value || '', value: document.getElementById('dAuthValue')?.value || '' };
    } else {
      delete collectionData.request.auth;
    }

    // Clean empty objects
    if (collectionData.request && Object.keys(collectionData.request).every(k => collectionData.request[k] === undefined)) {
      delete collectionData.request;
    }

    vscode.postMessage({ type: 'save', collection: collectionData });
  }

  // ── Load ───────────────────────────────────
  function loadCollection(data, filePath) {
    collectionData = JSON.parse(JSON.stringify(data)); // deep clone

    document.getElementById('collectionTitle').textContent = (data.info?.name || 'Collection') + ' — Settings';
    document.getElementById('filePath').textContent = filePath;

    // Info
    document.getElementById('infoName').value = data.info?.name || '';
    document.getElementById('infoVersion').value = data.info?.version || '';
    document.getElementById('infoSummary').value = data.info?.summary || '';

    // Environments
    renderEnvironments(collectionData.config?.environments);

    // Default headers
    renderDefaultHeaders(data.request?.headers);

    // Default auth
    const auth = data.request?.auth;
    if (auth && typeof auth === 'object' && auth.type) {
      document.getElementById('defaultAuthType').value = auth.type;
      onDefaultAuthChange();
      setTimeout(() => {
        if (auth.type === 'bearer') { const el = document.getElementById('dAuthToken'); if (el) el.value = auth.token || ''; }
        if (auth.type === 'basic') {
          const u = document.getElementById('dAuthUser'); if (u) u.value = auth.username || '';
          const p = document.getElementById('dAuthPass'); if (p) p.value = auth.password || '';
        }
        if (auth.type === 'apikey') {
          const k = document.getElementById('dAuthKey'); if (k) k.value = auth.key || '';
          const v = document.getElementById('dAuthValue'); if (v) v.value = auth.value || '';
        }
      }, 0);
    }
  }

  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Message handler ────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'collectionLoaded') {
      loadCollection(msg.collection, msg.filePath);
    } else if (msg.type === 'saved') {
      // flash feedback
    }
  });

  // ── Wire up static elements ─────────────────
  document.getElementById('saveCollectionBtn').addEventListener('click', saveCollection);
  document.getElementById('addEnvBtn').addEventListener('click', addEnvironment);
  document.getElementById('addDefaultHeaderBtn').addEventListener('click', function() { addDefaultHeader(); });
  document.getElementById('defaultAuthType').addEventListener('change', onDefaultAuthChange);

  // Section header toggles
  document.querySelectorAll('.section-header').forEach(function(header) {
    header.addEventListener('click', function() { toggleSection(header); });
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  dispose(): void {
    CollectionPanel._panels.delete(this._collection.id);
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
