import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import type { OpenCollection } from '../models/types';
import { stringifyYaml } from '../services/yamlParser';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { OAuth2Service } from '../services/oauth2Service';
import type { SecretService } from '../services/secretService';
import { handleOAuth2TokenMessage } from '../services/oauth2TokenHelper';

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
    private readonly _oauth2Service: OAuth2Service,
    private readonly _secretService: SecretService,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
    oauth2Service: OAuth2Service,
    secretService: SecretService,
  ): vscode.Disposable {
    const provider = new CollectionEditorProvider(context, collectionService, environmentService, oauth2Service, secretService);
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

    // Resolve collection ID from the file path
    const collectionId = this._collectionService.getCollections()
      .find(c => c.filePath === document.uri.fsPath)?.id;

    const sendVariables = () => this._sendVariables(webviewPanel.webview, document.uri.fsPath);

    // Live-reload variables when collection or environment data changes
    disposables.push(
      this._collectionService.onDidChange(() => sendVariables()),
      this._environmentService.onDidChange(() => sendVariables()),
    );

    // Listen for messages from the webview
    disposables.push(
      webviewPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ready') {
          sendDocumentToWebview();
          await sendVariables();
          return;
        }
        if (msg.type === 'getTokenStatus' || msg.type === 'getToken') {
          await this._handleTokenMessage(webviewPanel.webview, msg, document.uri.fsPath);
          return;
        }
        if (msg.type === 'testSecretProvider') {
          try {
            const collection = this._collectionService.getCollections().find(c => c.filePath === document.uri.fsPath);
            const variables = collection
              ? await this._environmentService.resolveVariables(collection)
              : new Map<string, string>();
            const result = await this._secretService.testConnection(msg.provider, variables);
            const secretNames = await this._secretService.listSecretNames(msg.provider, variables);
            webviewPanel.webview.postMessage({ type: 'testSecretProviderResult', success: true, secretCount: result.secretCount, providerIdx: msg.providerIdx, providerName: msg.provider.name, secretNames });
          } catch (e: any) {
            webviewPanel.webview.postMessage({ type: 'testSecretProviderResult', success: false, error: e.message, providerIdx: msg.providerIdx });
          }
          return;
        }
        if (msg.type === 'fetchSecretNames') {
          try {
            const collection = this._collectionService.getCollections().find(c => c.filePath === document.uri.fsPath);
            const variables = collection
              ? await this._environmentService.resolveVariables(collection)
              : new Map<string, string>();
            const secretNames = await this._secretService.listSecretNames(msg.provider, variables);
            webviewPanel.webview.postMessage({ type: 'secretNamesResult', providerName: msg.provider.name, secretNames });
          } catch {
            // silently fail — autocomplete just won't have secret names
          }
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
          sendVariables();
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

  private async _handleTokenMessage(webview: vscode.Webview, msg: any, filePath: string): Promise<void> {
    const collection = this._collectionService.getCollections().find(c => c.filePath === filePath);
    if (!collection) return;
    await handleOAuth2TokenMessage(webview, msg, collection, this._environmentService, this._oauth2Service);
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
    <button class="btn btn-toggle" id="varToggleBtn" title="Toggle resolved variables">{{}}</button>
  </div>

  <div class="collection-content">
    <!-- Main Tabs -->
    <div class="tabs" id="mainTabs">
      <div class="tab active" data-tab="overview">Overview</div>
      <div class="tab" data-tab="auth">Auth</div>
      <div class="tab" data-tab="headers">Headers <span class="badge" id="headersBadge">0</span></div>
      <div class="tab" data-tab="variables">Variables <span class="badge" id="variablesBadge">0</span></div>
      <div class="tab" data-tab="environments">Environments <span class="badge" id="envBadge">0</span></div>
      <div class="tab" data-tab="secrets">Secrets <span class="badge" id="secretsBadge">0</span></div>
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
            <option value="oauth2">OAuth 2.0</option>
          </select>
          <div id="defaultAuthFields"></div>
        </div>
      </div>

      <!-- Headers -->
      <div class="tab-panel" id="panel-headers">
        <table class="kv-table" id="defaultHeadersTable">
          <colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:32px"></colgroup>
          <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
          <tbody id="defaultHeadersBody"></tbody>
        </table>
        <button class="add-row-btn" id="addDefaultHeaderBtn">+ Add Header</button>
      </div>

      <!-- Variables -->
      <div class="tab-panel" id="panel-variables">
        <table class="kv-table" id="defaultVarsTable">
          <colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:32px"></colgroup>
          <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
          <tbody id="defaultVarsBody"></tbody>
        </table>
        <button class="add-row-btn" id="addDefaultVarBtn">+ Add Variable</button>
      </div>

      <!-- Secrets -->
      <div class="tab-panel" id="panel-secrets">
        <table class="kv-table" id="secretProvidersTable">
          <colgroup><col style="width:22%"><col style="width:120px"><col><col style="width:70px"><col style="width:32px"></colgroup>
          <thead><tr><th>Name</th><th>Type</th><th>URL</th><th></th><th></th></tr></thead>
          <tbody id="secretProvidersBody"></tbody>
        </table>
        <button class="add-row-btn" id="addSecretProviderBtn">+ Add Secret Provider</button>
        <div id="secretTestResult" style="margin-top:8px;font-size:12px;"></div>
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

  private async _sendVariables(webview: vscode.Webview, filePath: string): Promise<void> {
    try {
      const collection = this._collectionService.getCollections().find(c => c.filePath === filePath);
      if (!collection) return;
      const varsWithSource = await this._environmentService.resolveVariablesWithSource(collection);
      const varsObj: Record<string, string> = {};
      const sourcesObj: Record<string, string> = {};
      for (const [k, v] of varsWithSource) {
        varsObj[k] = v.value;
        sourcesObj[k] = v.source;
      }

      const providers: any[] = collection.data.config?.secretProviders ?? [];
      const enabledProviders = providers.filter((p: any) => !p.disabled);
      const secretProviderNames = enabledProviders.map((p: any) => p.name as string);

      // Use cached secret names (sync), then prefetch in background for next time
      const secretNames: Record<string, string[]> = {};
      for (const p of enabledProviders) {
        const cached = this._secretService.getCachedSecretNames(p.name);
        if (cached.length > 0) {
          secretNames[p.name] = cached;
          // Mark each $secret.provider.key as a resolved variable for highlighting
          for (const sn of cached) {
            const key = `$secret.${p.name}.${sn}`;
            if (!(key in varsObj)) {
              varsObj[key] = '••••••';
              sourcesObj[key] = 'secret';
            }
          }
        }
      }

      webview.postMessage({ type: 'variablesResolved', variables: varsObj, sources: sourcesObj, secretProviderNames, secretNames });

      // Prefetch in background (will be cached for next resolve)
      const variables = await this._environmentService.resolveVariables(collection);
      this._secretService.prefetchSecretNames(enabledProviders, variables).then(() => {
        // If we got new names, re-send variables
        let hasNew = false;
        for (const p of enabledProviders) {
          const fresh = this._secretService.getCachedSecretNames(p.name);
          if (fresh.length > 0 && !secretNames[p.name]) { hasNew = true; break; }
          if (fresh.length !== (secretNames[p.name]?.length ?? 0)) { hasNew = true; break; }
        }
        if (hasNew) { this._sendVariables(webview, filePath); }
      });
    } catch {
      // Variables unavailable
    }
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
