import * as vscode from 'vscode';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { HttpRequest, RequestDefaults, AuthOAuth2, MissioCollection } from '../models/types';
import type { HttpClient } from '../services/httpClient';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { OAuth2Service } from '../services/oauth2Service';
import type { SecretService } from '../services/secretService';
import { readFolderFile } from '../services/yamlParser';
import { BaseEditorProvider, type EditorContext } from './basePanel';

/**
 * CustomTextEditorProvider for OpenCollection request YAML files.
 * Uses the native TextDocument as the source of truth, giving us:
 * - Native dirty indicator (dot replacing X on tab)
 * - Native "unsaved changes" close warning
 * - Native Ctrl+S save
 * - Undo/redo support
 * - Proper restore on window reload
 */
export class RequestEditorProvider extends BaseEditorProvider {
  public static readonly viewType = 'missio.requestEditor';
  private static _panels = new Map<string, vscode.WebviewPanel>();
  private readonly _httpClient: HttpClient;

  static postMessageToPanel(filePath: string, message: any): boolean {
    const panel = RequestEditorProvider._panels.get(filePath.toLowerCase());
    if (panel) {
      panel.webview.postMessage(message);
      return true;
    }
    return false;
  }

  constructor(
    context: vscode.ExtensionContext,
    httpClient: HttpClient,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
    oauth2Service: OAuth2Service,
    secretService: SecretService,
  ) {
    super(context, collectionService, environmentService, oauth2Service, secretService);
    this._httpClient = httpClient;
  }

  static register(
    context: vscode.ExtensionContext,
    httpClient: HttpClient,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
    oauth2Service: OAuth2Service,
    secretService: SecretService,
  ): vscode.Disposable {
    const provider = new RequestEditorProvider(context, httpClient, collectionService, environmentService, oauth2Service, secretService);
    const registration = vscode.window.registerCustomEditorProvider(
      RequestEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
    return vscode.Disposable.from(registration, provider);
  }

  /**
   * Open a request file in the custom editor.
   */
  static async open(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('vscode.openWith', uri, RequestEditorProvider.viewType);
  }

  // ── BaseEditorProvider implementation ──

  protected _findCollection(filePath: string): MissioCollection | undefined {
    const normalized = filePath.replace(/\\/g, '/');
    return this._collectionService.getCollections().find(c => {
      const root = c.rootDir.replace(/\\/g, '/');
      return normalized.startsWith(root + '/') || normalized === root;
    });
  }

  protected _sendDocumentToWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
    try {
      const request = parseYaml(document.getText()) as HttpRequest;
      webview.postMessage({ type: 'requestLoaded', request, filePath: document.uri.fsPath });
    } catch { /* Invalid YAML, don't update webview */ }
  }

  protected _getDocumentDataKey(): string { return 'request'; }
  protected _getScriptFilename(): string { return 'requestPanel.js'; }
  protected _getCssFilenames(): string[] { return ['requestPanel.css']; }

  protected _onPanelCreated(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _disposables: vscode.Disposable[],
  ): void {
    RequestEditorProvider._panels.set(document.uri.fsPath.toLowerCase(), webviewPanel);
  }

  protected _onPanelDisposed(document: vscode.TextDocument): void {
    RequestEditorProvider._panels.delete(document.uri.fsPath.toLowerCase());
  }

  protected async _getFolderDefaults(filePath: string, collection: MissioCollection): Promise<RequestDefaults | undefined> {
    const dir = path.dirname(filePath);
    if (dir.toLowerCase() === collection.rootDir.toLowerCase()) return undefined;
    for (const name of ['folder.yml', 'folder.yaml']) {
      try {
        const folderData = await readFolderFile(path.join(dir, name));
        if (folderData?.request) return folderData.request;
        break;
      } catch { /* No folder.yml */ }
    }
    return undefined;
  }

  protected async _onMessage(
    webview: vscode.Webview,
    msg: any,
    ctx: EditorContext,
  ): Promise<boolean> {
    const filePath = ctx.document.uri.fsPath;
    switch (msg.type) {
      case 'saveDocument': {
        await ctx.applyEdit(msg.request);
        await ctx.document.save();
        webview.postMessage({ type: 'saved' });
        return true;
      }
      case 'sendRequest': {
        const collection = this._findCollection(filePath);
        if (!collection) {
          webview.postMessage({ type: 'error', message: 'Collection not found' });
          return true;
        }
        const folderDefaults = await this._getFolderDefaults(filePath, collection);
        await this._sendRequest(webview, msg.request, collection, folderDefaults);
        return true;
      }
      case 'editVariable': {
        const collection = this._findCollection(filePath);
        await this._editVariable(msg.variableName, collection);
        return true;
      }
      case 'resolveVariables': {
        await this._sendVariables(webview, filePath);
        return true;
      }
      case 'methodChanged':
        return true;
      case 'saveExample': {
        await this._saveExample(webview, msg, ctx);
        return true;
      }
    }
    return false;
  }

  // ── Request-specific logic ──

  private async _editVariable(variableName: string, collection: MissioCollection | undefined): Promise<void> {
    if (!collection) return;
    const vars = await this._environmentService.resolveVariables(collection);
    const currentValue = vars.get(variableName) || '';
    const newValue = await vscode.window.showInputBox({
      title: `Edit variable: ${variableName}`,
      value: currentValue,
      prompt: `Current value of {{${variableName}}}`,
    });
    if (newValue !== undefined) {
      vscode.window.showInformationMessage(
        `To persist changes to {{${variableName}}}, edit the environment in your collection.yml`,
      );
    }
  }

  private async _sendRequest(webview: vscode.Webview, requestData: HttpRequest, collection: MissioCollection, folderDefaults?: RequestDefaults): Promise<void> {
    // Determine effective auth for progress reporting
    let effectiveAuth = requestData.http?.auth;
    if (!effectiveAuth || effectiveAuth === 'inherit') effectiveAuth = folderDefaults?.auth;
    if (!effectiveAuth || effectiveAuth === 'inherit') effectiveAuth = collection.data.request?.auth;
    const isOAuth2 = effectiveAuth && effectiveAuth !== 'inherit' && (effectiveAuth as any).type === 'oauth2';

    if (isOAuth2) {
      webview.postMessage({ type: 'sending', message: 'Acquiring OAuth2 token…' });
    } else {
      webview.postMessage({ type: 'sending' });
    }

    try {
      if (isOAuth2) {
        const auth = effectiveAuth as AuthOAuth2;
        const vars = await this._environmentService.resolveVariables(collection);
        const interpolated: AuthOAuth2 = {
          type: 'oauth2', flow: auth.flow,
          accessTokenUrl: auth.accessTokenUrl ? this._environmentService.interpolate(auth.accessTokenUrl, vars) : undefined,
          refreshTokenUrl: auth.refreshTokenUrl ? this._environmentService.interpolate(auth.refreshTokenUrl, vars) : undefined,
          clientId: auth.clientId ? this._environmentService.interpolate(auth.clientId, vars) : undefined,
          clientSecret: auth.clientSecret ? this._environmentService.interpolate(auth.clientSecret, vars) : undefined,
          username: auth.username ? this._environmentService.interpolate(auth.username, vars) : undefined,
          password: auth.password ? this._environmentService.interpolate(auth.password, vars) : undefined,
          scope: auth.scope ? this._environmentService.interpolate(auth.scope, vars) : undefined,
          credentialsPlacement: auth.credentialsPlacement,
          credentialsId: auth.credentialsId,
          autoFetchToken: true,
          autoRefreshToken: auth.autoRefreshToken,
        };
        const envName = this._environmentService.getActiveEnvironmentName(collection.id);
        await this._oauth2Service.getToken(interpolated, collection.id, envName);
        webview.postMessage({ type: 'sending', message: 'Sending request…' });
      }
      const response = await this._httpClient.send(requestData, collection, folderDefaults);
      webview.postMessage({ type: 'response', response });
    } catch (e: any) {
      webview.postMessage({
        type: 'response',
        response: { status: 0, statusText: 'Error', headers: {}, body: e.message, duration: 0, size: 0 },
      });
    }
  }

  private async _saveExample(webview: vscode.Webview, msg: any, ctx: EditorContext): Promise<void> {
    const exampleName = await vscode.window.showInputBox({
      prompt: 'Name for this example',
      value: `Example ${msg.response.status}`,
    });
    if (!exampleName) return;

    try {
      const current = parseYaml(ctx.document.getText()) as any;
      if (!current.examples) current.examples = [];

      const respHeaders: any[] = [];
      if (msg.response.headers) {
        for (const [k, v] of Object.entries(msg.response.headers)) {
          respHeaders.push({ name: k, value: String(v) });
        }
      }

      const ct = (msg.response.headers?.['content-type'] ?? '') as string;
      let bodyType = 'text';
      if (ct.includes('json')) bodyType = 'json';
      else if (ct.includes('xml')) bodyType = 'xml';
      else if (ct.includes('html')) bodyType = 'html';

      current.examples.push({
        name: exampleName,
        request: { method: msg.request?.http?.method, url: msg.request?.http?.url },
        response: {
          status: msg.response.status,
          statusText: msg.response.statusText,
          headers: respHeaders,
          body: { type: bodyType, data: msg.response.body ?? '' },
        },
      });

      await ctx.applyEdit(current);
      webview.postMessage({ type: 'examplesUpdated', examples: current.examples });
      vscode.window.showInformationMessage(`Saved example "${exampleName}".`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to save example: ${e.message}`);
    }
  }

  protected _getBodyHtml(_webview: vscode.Webview): string {
    return `
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
    <div class="url-wrap" id="urlWrap"><div class="url-input" id="url" contenteditable="true" spellcheck="false" data-placeholder="{{baseUrl}}/api/endpoint"></div></div>
    <button class="btn btn-toggle" id="varToggleBtn" title="Toggle resolved variables">{{}}</button>
    <button class="btn btn-primary" id="sendBtn">Send</button>
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
            <colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:70px"><col style="width:32px"></colgroup>
            <thead><tr><th></th><th>Name</th><th>Value</th><th>Type</th><th></th></tr></thead>
            <tbody id="paramsBody"></tbody>
          </table>
          <button class="add-row-btn" id="addParamBtn">+ Add Parameter</button>
        </div>
        <!-- Headers -->
        <div class="tab-panel" id="panel-headers">
          <table class="kv-table" id="headersTable">
            <colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:32px"></colgroup>
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
              <textarea class="code-input" id="bodyData" spellcheck="false"></textarea>
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
              <option value="inherit">Inherit</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
              <option value="apikey">API Key</option>
              <option value="oauth2">OAuth 2.0</option>
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
        <span class="example-indicator" id="exampleIndicator"></span>
        <button class="save-example-btn" id="saveExampleBtn" title="Save as example">Save as Example</button>
      </div>
      <div class="tabs" id="respTabs" style="display:none;">
        <div class="tab active" data-tab="resp-body">Body</div>
        <div class="tab" data-tab="resp-headers">Headers</div>
      </div>
      <div class="response-body">
        <div class="loading-overlay" id="respLoading" style="display:none;">
          <div class="spinner"></div>
          <span>Sending request…</span>
        </div>
        <div class="tab-panel active" id="panel-resp-body">
          <div class="empty-state" id="respEmpty">Send a request to see the response</div>
          <div id="respBodyWrap" class="resp-body-wrap" style="display:none;">
            <button class="copy-btn" id="copyRespBtn" title="Copy to clipboard">Copy</button>
            <div class="code-wrap resp-code-wrap">
              <div class="line-numbers" id="respLineNumbers"></div>
              <pre class="code-highlight" id="respBodyPre"></pre>
            </div>
          </div>
        </div>
        <div class="tab-panel" id="panel-resp-headers">
          <table class="resp-headers-table" id="respHeadersTable"><tbody id="respHeadersBody"></tbody></table>
        </div>
      </div>
    </div>
  </div>`;
  }
}
