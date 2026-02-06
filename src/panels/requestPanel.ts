import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import type { HttpRequest } from '../models/types';
import type { HttpClient } from '../services/httpClient';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import { stringifyYaml } from '../services/yamlParser';

/**
 * CustomTextEditorProvider for OpenCollection request YAML files.
 * Uses the native TextDocument as the source of truth, giving us:
 * - Native dirty indicator (dot replacing X on tab)
 * - Native "unsaved changes" close warning
 * - Native Ctrl+S save
 * - Undo/redo support
 * - Proper restore on window reload
 */
export class RequestEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  public static readonly viewType = 'missio.requestEditor';
  private static _panels = new Map<string, vscode.WebviewPanel>();
  private _disposables: vscode.Disposable[] = [];

  static postMessageToPanel(filePath: string, message: any): boolean {
    const panel = RequestEditorProvider._panels.get(filePath.toLowerCase());
    if (panel) {
      panel.webview.postMessage(message);
      return true;
    }
    return false;
  }

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _httpClient: HttpClient,
    private readonly _collectionService: CollectionService,
    private readonly _environmentService: EnvironmentService,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    httpClient: HttpClient,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
  ): vscode.Disposable {
    const provider = new RequestEditorProvider(context, httpClient, collectionService, environmentService);
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

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const disposables: vscode.Disposable[] = [];

    // Configure webview
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    // Set HTML
    webviewPanel.webview.html = this._getHtml(webviewPanel.webview);

    // Track if we're currently pushing an edit from the webview to the document
    let isUpdatingDocument = false;

    // Find collection for this file
    const filePath = document.uri.fsPath;
    const collectionId = this._findCollectionId(filePath);

    // Track this panel
    RequestEditorProvider._panels.set(filePath.toLowerCase(), webviewPanel);
    disposables.push({
      dispose: () => RequestEditorProvider._panels.delete(filePath.toLowerCase()),
    });

    // Parse document and send to webview
    const updateWebview = () => {
      if (isUpdatingDocument) return;
      try {
        const request = parseYaml(document.getText()) as HttpRequest;
        webviewPanel.webview.postMessage({
          type: 'requestLoaded',
          request,
          filePath: document.uri.fsPath,
        });
      } catch {
        // Invalid YAML, don't update webview
      }
    };

    // Listen for document changes (external edits, undo/redo)
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          updateWebview();
        }
      }),
    );

    // Live-reload variables when collection or environment data changes
    disposables.push(
      this._collectionService.onDidChange(() => {
        this._sendVariables(webviewPanel.webview, collectionId);
      }),
      this._environmentService.onDidChange(() => {
        this._sendVariables(webviewPanel.webview, collectionId);
      }),
    );

    // Handle messages from webview
    disposables.push(
      webviewPanel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case 'ready': {
            updateWebview();
            await this._sendVariables(webviewPanel.webview, collectionId);
            break;
          }
          case 'updateDocument': {
            // Webview wants to update the document content (makes it dirty)
            const yaml = stringifyYaml(msg.request, { lineWidth: 120 });
            // Skip if content hasn't actually changed
            if (yaml === document.getText()) break;
            isUpdatingDocument = true;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              document.uri,
              new vscode.Range(0, 0, document.lineCount, 0),
              yaml,
            );
            await vscode.workspace.applyEdit(edit);
            isUpdatingDocument = false;
            break;
          }
          case 'saveDocument': {
            // Webview wants to save (build request -> update doc -> save)
            const saveYaml = stringifyYaml(msg.request, { lineWidth: 120 });
            if (saveYaml !== document.getText()) {
              isUpdatingDocument = true;
              const saveEdit = new vscode.WorkspaceEdit();
              saveEdit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                saveYaml,
              );
              await vscode.workspace.applyEdit(saveEdit);
              isUpdatingDocument = false;
            }
            await document.save();
            webviewPanel.webview.postMessage({ type: 'saved' });
            break;
          }
          case 'sendRequest': {
            await this._sendRequest(webviewPanel.webview, msg.request, collectionId);
            break;
          }
          case 'editVariable': {
            await this._editVariable(msg.variableName, collectionId);
            break;
          }
          case 'resolveVariables': {
            await this._sendVariables(webviewPanel.webview, collectionId);
            break;
          }
          case 'methodChanged': {
            // Could update tab icon here if supported
            break;
          }
          case 'saveExample': {
            const exampleName = await vscode.window.showInputBox({
              prompt: 'Name for this example',
              value: `Example ${msg.response.status}`,
            });
            if (!exampleName) break;

            // Parse current document, add example, write back
            try {
              const current = parseYaml(document.getText()) as any;
              if (!current.examples) current.examples = [];

              // Build example response headers as array
              const respHeaders: any[] = [];
              if (msg.response.headers) {
                for (const [k, v] of Object.entries(msg.response.headers)) {
                  respHeaders.push({ name: k, value: String(v) });
                }
              }

              // Detect body type from content-type
              const ct = (msg.response.headers?.['content-type'] ?? '') as string;
              let bodyType = 'text';
              if (ct.includes('json')) bodyType = 'json';
              else if (ct.includes('xml')) bodyType = 'xml';
              else if (ct.includes('html')) bodyType = 'html';

              current.examples.push({
                name: exampleName,
                request: {
                  method: msg.request?.http?.method,
                  url: msg.request?.http?.url,
                },
                response: {
                  status: msg.response.status,
                  statusText: msg.response.statusText,
                  headers: respHeaders,
                  body: {
                    type: bodyType,
                    data: msg.response.body ?? '',
                  },
                },
              });

              const yaml = stringifyYaml(current, { lineWidth: 120 });
              isUpdatingDocument = true;
              const exEdit = new vscode.WorkspaceEdit();
              exEdit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                yaml,
              );
              await vscode.workspace.applyEdit(exEdit);
              isUpdatingDocument = false;
              // Update webview's examples cache
              webviewPanel.webview.postMessage({
                type: 'examplesUpdated',
                examples: current.examples,
              });
              vscode.window.showInformationMessage(`Saved example "${exampleName}".`);
            } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to save example: ${e.message}`);
            }
            break;
          }
        }
      }),
    );

    // Clean up on dispose
    webviewPanel.onDidDispose(() => {
      disposables.forEach(d => d.dispose());
    });
  }

  private _findCollectionId(filePath: string): string | undefined {
    const collections = this._collectionService.getCollections();
    const normalized = filePath.replace(/\\/g, '/');
    const collection = collections.find(c => {
      const root = c.rootDir.replace(/\\/g, '/');
      return normalized.startsWith(root + '/') || normalized === root;
    });
    return collection?.id;
  }

  private async _sendVariables(webview: vscode.Webview, collectionId: string | undefined): Promise<void> {
    if (!collectionId) return;
    try {
      const collection = this._collectionService.getCollection(collectionId);
      if (!collection) return;
      const varsWithSource = await this._environmentService.resolveVariablesWithSource(collection);
      const varsObj: Record<string, string> = {};
      const sourcesObj: Record<string, string> = {};
      for (const [k, v] of varsWithSource) {
        varsObj[k] = v.value;
        sourcesObj[k] = v.source;
      }
      webview.postMessage({ type: 'variablesResolved', variables: varsObj, sources: sourcesObj });
    } catch {
      // Variables unavailable
    }
  }

  private async _editVariable(variableName: string, collectionId: string | undefined): Promise<void> {
    if (!collectionId) return;
    const collection = this._collectionService.getCollection(collectionId);
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

  private async _sendRequest(webview: vscode.Webview, requestData: HttpRequest, collectionId: string | undefined): Promise<void> {
    if (!collectionId) {
      webview.postMessage({ type: 'error', message: 'Collection not found' });
      return;
    }
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) {
      webview.postMessage({ type: 'error', message: 'Collection not found' });
      return;
    }

    webview.postMessage({ type: 'sending' });

    try {
      const response = await this._httpClient.send(requestData, collection);
      webview.postMessage({ type: 'response', response });
    } catch (e: any) {
      webview.postMessage({
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

  private _getHtml(webview: vscode.Webview): string {
    const nonce = this._getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'requestPanel.js'),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'requestPanel.css'),
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
    this._disposables.forEach(d => d.dispose());
  }
}
