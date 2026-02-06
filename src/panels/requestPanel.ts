import * as vscode from 'vscode';
import * as path from 'path';
import type { HttpRequest, HttpRequestHeader, HttpRequestParam, HttpRequestBody, HttpResponse, MissioCollection, Auth } from '../models/types';
import type { HttpClient } from '../services/httpClient';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import { readRequestFile, stringifyYaml } from '../services/yamlParser';
import { ResponseDocumentProvider } from '../providers/responseProvider';

export class RequestPanel implements vscode.Disposable {
  public static readonly viewType = 'missio.requestEditor';
  private static _panels: Map<string, RequestPanel> = new Map();

  private readonly _panel: vscode.WebviewPanel;
  private _filePath: string;
  private readonly _collectionId: string;
  private readonly _extensionUri: vscode.Uri;
  private _request: HttpRequest | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _baseTitle = '';
  private _dirty = false;

  private constructor(
    panel: vscode.WebviewPanel,
    filePath: string,
    collectionId: string,
    extensionUri: vscode.Uri,
    private readonly _httpClient: HttpClient,
    private readonly _collectionService: CollectionService,
    private readonly _environmentService: EnvironmentService,
  ) {
    this._panel = panel;
    this._filePath = filePath;
    this._collectionId = collectionId;
    this._extensionUri = extensionUri;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables,
    );
  }

  static handleRename(oldPath: string, newPath: string, newTitle: string): void {
    const panel = RequestPanel._panels.get(oldPath);
    if (panel) {
      RequestPanel._panels.delete(oldPath);
      panel._filePath = newPath;
      panel._baseTitle = newTitle;
      panel._panel.title = panel._dirty ? `\u25cf ${newTitle}` : newTitle;
      RequestPanel._panels.set(newPath, panel);
      // Notify webview so it updates currentRequest.info.name and filePath
      panel._panel.webview.postMessage({
        type: 'renamed',
        filePath: newPath,
        name: newTitle,
      });
      // Update persisted state
      panel._panel.webview.postMessage({
        type: 'setState',
        state: { filePath: newPath, collectionId: panel._collectionId },
      });
    }
  }

  static handleDelete(filePath: string): void {
    const panel = RequestPanel._panels.get(filePath);
    if (panel) {
      panel._panel.dispose();
    }
  }

  static registerSerializer(
    context: vscode.ExtensionContext,
    httpClient: HttpClient,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
  ): void {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(RequestPanel.viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any) {
          const filePath = state?.filePath;
          const collectionId = state?.collectionId;
          if (!filePath || !collectionId) {
            panel.dispose();
            return;
          }
          const rp = new RequestPanel(
            panel, filePath, collectionId, context.extensionUri,
            httpClient, collectionService, environmentService,
          );
          RequestPanel._panels.set(filePath, rp);
          panel.webview.html = rp._getHtml();
        },
      }),
    );
  }

  static async open(
    filePath: string,
    collectionId: string,
    httpClient: HttpClient,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
    extensionUri: vscode.Uri,
  ): Promise<RequestPanel> {
    const existing = RequestPanel._panels.get(filePath);
    if (existing) {
      existing._panel.reveal();
      return existing;
    }

    const fileName = path.basename(filePath, path.extname(filePath));
    const panel = vscode.window.createWebviewPanel(
      RequestPanel.viewType,
      fileName,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    const rp = new RequestPanel(panel, filePath, collectionId, extensionUri, httpClient, collectionService, environmentService);
    RequestPanel._panels.set(filePath, rp);

    panel.webview.html = rp._getHtml();
    await rp._loadRequest();
    return rp;
  }

  private static readonly _methodIcons: Record<string, string> = {
    GET: 'arrow-down',
    POST: 'arrow-up',
    PUT: 'arrow-swap',
    PATCH: 'edit',
    DELETE: 'trash',
    HEAD: 'eye',
    OPTIONS: 'settings-gear',
  };

  private static readonly _methodColors: Record<string, string> = {
    GET: 'missio.methodGet',
    POST: 'missio.methodPost',
    PUT: 'missio.methodPut',
    PATCH: 'missio.methodPatch',
    DELETE: 'missio.methodDelete',
    HEAD: 'missio.methodHead',
    OPTIONS: 'missio.methodOptions',
  };

  private _updateIcon(method?: string): void {
    const m = (method ?? this._request?.http?.method ?? 'GET').toUpperCase();
    const icon = RequestPanel._methodIcons[m] ?? 'globe';
    const color = RequestPanel._methodColors[m];
    // ThemeIcon with color for tab icon
    try {
      this._panel.iconPath = color
        ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(color))
        : new vscode.ThemeIcon(icon);
    } catch {
      // Fallback: iconPath may not accept ThemeIcon in older VS Code
    }
  }

  private _setDirty(dirty: boolean): void {
    this._dirty = dirty;
    this._panel.title = dirty ? `● ${this._baseTitle}` : this._baseTitle;
  }

  private async _loadRequest(): Promise<void> {
    try {
      this._request = await readRequestFile(this._filePath);
      const title = this._request?.info?.name;
      if (title) {
        this._baseTitle = title;
        this._panel.title = title;
      }
      this._updateIcon();
      this._panel.webview.postMessage({
        type: 'requestLoaded',
        request: this._request,
        filePath: this._filePath,
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to load request: ${e.message}`);
    }
  }

  private async _handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'sendRequest': {
        await this._sendRequest(msg.request);
        break;
      }
      case 'saveRequest': {
        await this._saveRequest(msg.request);
        break;
      }
      case 'ready': {
        await this._loadRequest();
        await this._sendVariables();
        // Save state for webview restore
        this._panel.webview.postMessage({
          type: 'setState',
          state: { filePath: this._filePath, collectionId: this._collectionId },
        });
        break;
      }
      case 'changeBodyLanguage': {
        await this._pickLanguage(msg.currentLang);
        break;
      }
      case 'editVariable': {
        await this._editVariable(msg.variableName);
        break;
      }
      case 'resolveVariables': {
        await this._sendVariables();
        break;
      }
      case 'dirtyChanged': {
        this._setDirty(msg.dirty);
        break;
      }
      case 'methodChanged': {
        this._updateIcon(msg.method);
        break;
      }
    }
  }

  private async _sendVariables(): Promise<void> {
    try {
      const collection = this._collectionService.getCollection(this._collectionId);
      if (!collection) return;
      const vars = await this._environmentService.resolveVariables(collection);
      const varsObj: Record<string, string> = {};
      for (const [k, v] of vars) {
        varsObj[k] = v;
      }
      this._panel.webview.postMessage({ type: 'variablesResolved', variables: varsObj });
    } catch {
      // Variables unavailable
    }
  }

  private async _editVariable(variableName: string): Promise<void> {
    const collection = this._collectionService.getCollection(this._collectionId);
    if (!collection) return;
    const vars = await this._environmentService.resolveVariables(collection);
    const currentValue = vars.get(variableName) || '';
    const newValue = await vscode.window.showInputBox({
      title: `Edit variable: ${variableName}`,
      value: currentValue,
      prompt: `Current value of {{${variableName}}}`,
    });
    if (newValue !== undefined) {
      // For now, show info that runtime edits aren't persisted
      // In the future this could update the environment file
      vscode.window.showInformationMessage(
        `To persist changes to {{${variableName}}}, edit the environment in your collection.yml`,
      );
    }
  }

  private async _pickLanguage(currentLang: string): Promise<void> {
    const langs = ['json', 'xml', 'html', 'yaml', 'text'];
    const pick = await vscode.window.showQuickPick(
      langs.map(l => ({ label: l.toUpperCase(), description: l === currentLang ? '● Active' : '', lang: l })),
      { placeHolder: 'Select body language mode' },
    );
    if (pick) {
      this._panel.webview.postMessage({ type: 'languageChanged', language: pick.lang });
    }
  }

  private async _sendRequest(requestData: HttpRequest): Promise<void> {
    const collection = this._collectionService.getCollection(this._collectionId);
    if (!collection) {
      this._panel.webview.postMessage({ type: 'error', message: 'Collection not found' });
      return;
    }

    this._panel.webview.postMessage({ type: 'sending' });

    try {
      const response = await this._httpClient.send(requestData, collection);
      this._panel.webview.postMessage({ type: 'response', response });
    } catch (e: any) {
      this._panel.webview.postMessage({
        type: 'response',
        response: {
          status: 0,
          statusText: 'Error',
          headers: {},
          body: e.message,
          duration: 0,
          size: 0,
        },
      });
    }
  }

  private async _saveRequest(requestData: HttpRequest): Promise<void> {
    try {
      const content = stringifyYaml(requestData, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(this._filePath),
        Buffer.from(content, 'utf-8'),
      );
      this._request = requestData;
      this._panel.webview.postMessage({ type: 'saved' });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to save: ${e.message}`);
    }
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
    const nonce = this._getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'requestPanel.js'),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'requestPanel.css'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <!-- URL Bar -->
  <div class="url-bar">
    <select class="method-select" id="method">
      <option value="GET">GET</option>
      <option value="POST">POST</option>
      <option value="PUT">PUT</option>
      <option value="PATCH">PATCH</option>
      <option value="DELETE">DELETE</option>
      <option value="HEAD">HEAD</option>
      <option value="OPTIONS">OPTIONS</option>
    </select>
    <div class="url-input" id="url" contenteditable="true" spellcheck="false" data-placeholder="{{baseUrl}}/api/endpoint"></div>
    <button class="btn btn-primary" id="sendBtn">Send</button>
    <button class="btn btn-secondary" id="saveBtn">Save</button>
  </div>

  <div class="main-content">
    <!-- Request Section -->
    <div class="request-section" id="requestSection">
      <div class="tabs" id="reqTabs">
        <div class="tab active" data-tab="body">Body</div>
        <div class="tab" data-tab="auth">Auth</div>
        <div class="tab" data-tab="headers">Headers <span class="badge" id="headersBadge">0</span></div>
        <div class="tab" data-tab="params">Params <span class="badge" id="paramsBadge">0</span></div>
        <div class="tab" data-tab="settings">Settings</div>
      </div>
      <div class="tab-content">
        <!-- Params -->
        <div class="tab-panel" id="panel-params">
          <table class="kv-table" id="paramsTable">
            <thead><tr><th></th><th>Name</th><th>Value</th><th>Type</th><th></th></tr></thead>
            <tbody id="paramsBody"></tbody>
          </table>
          <button class="add-row-btn" id="addParamBtn">+ Add Parameter</button>
        </div>
        <!-- Headers -->
        <div class="tab-panel" id="panel-headers">
          <table class="kv-table" id="headersTable">
            <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
            <tbody id="headersBody"></tbody>
          </table>
          <button class="add-row-btn" id="addHeaderBtn">+ Add Header</button>
        </div>
        <!-- Body -->
        <div class="tab-panel active" id="panel-body">
          <div class="body-toolbar">
            <div class="body-type-pills" id="bodyTypePills">
              <button class="pill active" data-body-type="none">None</button>
              <button class="pill" data-body-type="raw">Raw</button>
              <button class="pill" data-body-type="form-urlencoded">Form Encoded</button>
              <button class="pill" data-body-type="multipart-form">Multipart</button>
            </div>
            <select class="lang-select" id="bodyLangMode">
              <option value="json">JSON</option>
              <option value="xml">XML</option>
              <option value="html">HTML</option>
              <option value="yaml">YAML</option>
              <option value="text">Text</option>
            </select>
          </div>
          <div id="bodyRawEditor" style="display:none;">
            <div class="code-wrap">
              <div class="line-numbers" id="lineNumbers"></div>
              <pre class="code-highlight" id="bodyHighlight"></pre>
              <textarea class="code-input" id="bodyData" spellcheck="false" placeholder="Request body..."></textarea>
            </div>
          </div>
          <div id="bodyFormEditor" style="display:none;">
            <table class="kv-table" id="bodyFormTable">
              <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
              <tbody id="bodyFormBody"></tbody>
            </table>
            <button class="add-row-btn" id="addFormFieldBtn">+ Add Field</button>
          </div>
        </div>
        <!-- Auth -->
        <div class="tab-panel" id="panel-auth">
          <div class="auth-section">
            <select class="auth-select" id="authType">
              <option value="none">No Auth</option>
              <option value="inherit">Inherit from Collection</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
              <option value="apikey">API Key</option>
            </select>
            <div id="authFields"></div>
          </div>
        </div>
        <!-- Settings -->
        <div class="tab-panel" id="panel-settings">
          <div class="auth-section">
            <div class="auth-row">
              <label>Timeout (ms)</label>
              <input type="number" id="settingTimeout" value="30000" />
            </div>
            <div class="auth-row">
              <label>Encode URL</label>
              <input type="checkbox" id="settingEncodeUrl" checked />
            </div>
            <div class="auth-row">
              <label>Follow Redirects</label>
              <input type="checkbox" id="settingFollowRedirects" checked />
            </div>
            <div class="auth-row">
              <label>Max Redirects</label>
              <input type="number" id="settingMaxRedirects" value="5" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Resizable Divider -->
    <div class="divider" id="divider"></div>

    <!-- Response Section -->
    <div class="response-section" id="responseSection">
      <div class="response-bar" id="responseBar" style="display:none;">
        <span class="label">Response</span>
        <span class="status-badge" id="statusBadge"></span>
        <span class="meta" id="responseMeta"></span>
      </div>
      <div class="tabs" id="respTabs" style="display:none;">
        <div class="tab active" data-tab="resp-body">Body</div>
        <div class="tab" data-tab="resp-headers">Headers</div>
      </div>
      <div class="response-body">
        <div class="tab-panel active" id="panel-resp-body">
          <div class="empty-state" id="respEmpty">Send a request to see the response</div>
          <pre id="respBodyPre" style="display:none;"></pre>
        </div>
        <div class="tab-panel" id="panel-resp-headers">
          <table class="resp-headers-table" id="respHeadersTable"><tbody id="respHeadersBody"></tbody></table>
        </div>
      </div>
    </div>
  </div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
  }

  dispose(): void {
    RequestPanel._panels.delete(this._filePath);
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
