import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import type { OpenCollection } from '../models/types';
import { stringifyYaml } from '../services/yamlParser';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';

/**
 * CustomTextEditorProvider for OpenCollection collection.yml files.
 * Uses the native TextDocument as the source of truth, giving us:
 * - Native dirty indicator (dot replacing X on tab)
 * - Native "unsaved changes" close warning
 * - Native Ctrl+S save
 * - Undo/redo support
 * - Proper restore on window reload
 */
export class CollectionEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  public static readonly viewType = 'missio.collectionEditor';
  private static _panels = new Map<string, vscode.WebviewPanel>();
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _collectionService: CollectionService,
    private readonly _environmentService: EnvironmentService,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
  ): vscode.Disposable {
    const provider = new CollectionEditorProvider(context, collectionService, environmentService);
    const registration = vscode.window.registerCustomEditorProvider(
      CollectionEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
    return vscode.Disposable.from(registration, provider);
  }

  /**
   * Open a collection file in the custom editor.
   */
  static async open(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('vscode.openWith', uri, CollectionEditorProvider.viewType);
  }

  /**
   * Open a collection file and switch to a specific tab (e.g. 'environments').
   */
  static async openTab(filePath: string, tab: string, envName?: string): Promise<void> {
    await CollectionEditorProvider.open(filePath);
    // Give the webview a moment to initialize, then send the tab switch
    const key = vscode.Uri.file(filePath).toString();
    const sendSwitch = () => {
      const panel = CollectionEditorProvider._panels.get(key);
      if (panel) {
        panel.webview.postMessage({ type: 'switchTab', tab, envName });
      }
    };
    // Retry briefly in case the panel hasn't registered yet
    setTimeout(sendSwitch, 100);
    setTimeout(sendSwitch, 500);
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const disposables: vscode.Disposable[] = [];

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
    };

    webviewPanel.webview.html = this._getHtml(webviewPanel.webview);

    const docKey = document.uri.toString();
    CollectionEditorProvider._panels.set(docKey, webviewPanel);

    let isUpdatingDocument = false;

    function sendDocumentToWebview() {
      const text = document.getText();
      let collection: OpenCollection;
      try {
        collection = parseYaml(text) || {};
      } catch {
        collection = {} as OpenCollection;
      }
      webviewPanel.webview.postMessage({
        type: 'collectionLoaded',
        collection,
        filePath: document.uri.fsPath,
      });
    }

    // Listen for messages from the webview
    disposables.push(
      webviewPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ready') {
          sendDocumentToWebview();
          return;
        }
        if (msg.type === 'updateDocument') {
          if (isUpdatingDocument) return;
          isUpdatingDocument = true;
          try {
            // Detect env rename: compare old env names with new
            this._trackEnvRename(document, msg.collection);

            const yaml = stringifyYaml(msg.collection, { lineWidth: 120 });
            // Skip if content hasn't actually changed
            if (yaml === document.getText()) return;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              document.uri,
              new vscode.Range(0, 0, document.lineCount, 0),
              yaml,
            );
            await vscode.workspace.applyEdit(edit);
          } finally {
            isUpdatingDocument = false;
          }
        }
      }),
    );

    // Listen for external changes to the document
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && !isUpdatingDocument) {
          sendDocumentToWebview();
        }
      }),
    );

    // Clean up on dispose
    webviewPanel.onDidDispose(() => {
      CollectionEditorProvider._panels.delete(docKey);
      disposables.forEach(d => d.dispose());
    });
  }

  private _trackEnvRename(document: vscode.TextDocument, newCollection: any): void {
    // Find which collection this file belongs to
    const filePath = document.uri.fsPath;
    const collection = this._collectionService.getCollections().find(c => c.filePath === filePath);
    if (!collection) return;

    const activeName = this._environmentService.getActiveEnvironmentName(collection.id);
    if (!activeName) return;

    // Parse old env names from current document
    let oldData: any;
    try { oldData = parseYaml(document.getText()); } catch { return; }
    const oldEnvs: any[] = oldData?.config?.environments || [];
    const newEnvs: any[] = newCollection?.config?.environments || [];

    // Check if active env name still exists in new data
    if (newEnvs.some((e: any) => e.name === activeName)) return;

    // Find the old index of the active env
    const oldIdx = oldEnvs.findIndex((e: any) => e.name === activeName);
    if (oldIdx < 0) return;

    // If there's an env at the same index with a different name, it was renamed
    if (oldIdx < newEnvs.length && newEnvs[oldIdx].name) {
      this._environmentService.setActiveEnvironment(collection.id, newEnvs[oldIdx].name);
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = this._getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'collectionPanel.js'),
    );
    const sharedCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'requestPanel.css'),
    );
    const collCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'collectionPanel.css'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${sharedCssUri}">
<link rel="stylesheet" href="${collCssUri}">
</head>
<body>
  <!-- Collection Header -->
  <div class="collection-header">
    <span class="collection-icon">\u{1F4DA}</span>
    <div class="collection-info">
      <span class="collection-name" id="collectionName">Collection</span>
    </div>
  </div>

  <div class="collection-content">
    <!-- Main Tabs -->
    <div class="tabs" id="mainTabs">
      <div class="tab active" data-tab="overview">Overview</div>
      <div class="tab" data-tab="auth">Auth</div>
      <div class="tab" data-tab="headers">Headers <span class="badge" id="headersBadge">0</span></div>
      <div class="tab" data-tab="variables">Variables <span class="badge" id="variablesBadge">0</span></div>
      <div class="tab" data-tab="environments">Environments <span class="badge" id="envBadge">0</span></div>
    </div>
    <div class="tab-content">

      <!-- Overview -->
      <div class="tab-panel active" id="panel-overview">
        <div class="overview-form">
          <div class="form-row">
            <div class="form-group">
              <label>Collection Name</label>
              <input type="text" id="infoName" placeholder="My Collection" />
            </div>
            <div class="form-group">
              <label>Version</label>
              <input type="text" id="infoVersion" placeholder="1.0.0" />
            </div>
          </div>
          <div class="form-group">
            <label>Summary</label>
            <textarea id="infoSummary" placeholder="A brief description of this collection..."></textarea>
          </div>
        </div>
      </div>

      <!-- Auth -->
      <div class="tab-panel" id="panel-auth">
        <div class="auth-section">
          <select class="auth-select" id="defaultAuthType">
            <option value="none">No Auth</option>
            <option value="bearer">Bearer Token</option>
            <option value="basic">Basic Auth</option>
            <option value="apikey">API Key</option>
          </select>
          <div id="defaultAuthFields"></div>
        </div>
      </div>

      <!-- Headers -->
      <div class="tab-panel" id="panel-headers">
        <table class="kv-table" id="defaultHeadersTable">
          <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
          <tbody id="defaultHeadersBody"></tbody>
        </table>
        <button class="add-row-btn" id="addDefaultHeaderBtn">+ Add Header</button>
      </div>

      <!-- Variables -->
      <div class="tab-panel" id="panel-variables">
        <table class="kv-table" id="defaultVarsTable">
          <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
          <tbody id="defaultVarsBody"></tbody>
        </table>
        <button class="add-row-btn" id="addDefaultVarBtn">+ Add Variable</button>
      </div>

      <!-- Environments -->
      <div class="tab-panel" id="panel-environments">
        <div class="env-toolbar">
          <select class="auth-select" id="envSelector"></select>
          <button class="env-toolbar-btn" id="addEnvBtn" title="Add Environment">+</button>
          <button class="env-toolbar-btn env-toolbar-delete" id="removeEnvBtn" title="Remove Environment">\u00d7</button>
        </div>
        <div id="envDetail"></div>
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
