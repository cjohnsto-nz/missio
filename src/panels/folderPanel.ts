import * as vscode from 'vscode';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { Folder } from '../models/types';
import { stringifyYaml } from '../services/yamlParser';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { OAuth2Service } from '../services/oauth2Service';
import type { SecretService } from '../services/secretService';
import { handleOAuth2TokenMessage } from '../services/oauth2TokenHelper';

/**
 * CustomTextEditorProvider for OpenCollection folder.yml files.
 * Allows editing folder-level request defaults: auth, headers, variables.
 */
export class FolderEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  public static readonly viewType = 'missio.folderEditor';
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
    const provider = new FolderEditorProvider(context, collectionService, environmentService, oauth2Service, secretService);
    const registration = vscode.window.registerCustomEditorProvider(
      FolderEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
    return vscode.Disposable.from(registration, provider);
  }

  /**
   * Open a folder.yml file in the custom editor, creating it if it doesn't exist.
   */
  static async open(dirPath: string): Promise<void> {
    let folderFilePath = path.join(dirPath, 'folder.yml');
    const uri = vscode.Uri.file(folderFilePath);

    // Create folder.yml if it doesn't exist
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const folderName = path.basename(dirPath);
      const initial: Folder = {
        info: { name: folderName, type: 'folder' },
        request: { auth: 'inherit' },
      };
      const content = stringifyYaml(initial, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
    }

    await vscode.commands.executeCommand('vscode.openWith', uri, FolderEditorProvider.viewType);
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

    let isUpdatingDocument = false;

    function sendDocumentToWebview() {
      const text = document.getText();
      let folder: Folder;
      try {
        folder = parseYaml(text) || {};
      } catch {
        folder = {} as Folder;
      }
      webviewPanel.webview.postMessage({
        type: 'folderLoaded',
        folder,
        filePath: document.uri.fsPath,
      });
    }

    const sendVariables = () => this._sendVariables(webviewPanel.webview, document.uri.fsPath);

    // Live-reload variables when collection or environment data changes
    disposables.push(
      this._collectionService.onDidChange(() => sendVariables()),
      this._environmentService.onDidChange(() => sendVariables()),
    );

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
        if (msg.type === 'updateDocument') {
          if (isUpdatingDocument) return;
          isUpdatingDocument = true;
          try {
            const yaml = stringifyYaml(msg.folder, { lineWidth: 120 });
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

    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && !isUpdatingDocument) {
          sendDocumentToWebview();
          sendVariables();
        }
      }),
    );

    webviewPanel.onDidDispose(() => {
      disposables.forEach(d => d.dispose());
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = this._getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'folderPanel.js'),
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
  <!-- Folder Header -->
  <div class="collection-header">
    <span class="collection-icon">\u{1F4C1}</span>
    <div class="collection-info">
      <span class="collection-name" id="folderName">Folder</span>
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
    </div>
    <div class="tab-content">

      <!-- Overview -->
      <div class="tab-panel active" id="panel-overview">
        <div class="overview-form">
          <div class="form-group">
            <label>Folder Name</label>
            <input type="text" id="infoName" placeholder="My Folder" />
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="infoDescription" placeholder="A brief description of this folder..."></textarea>
          </div>
        </div>
      </div>

      <!-- Auth -->
      <div class="tab-panel" id="panel-auth">
        <div class="auth-section">
          <select class="auth-select" id="defaultAuthType">
            <option value="none">No Auth</option>
            <option value="inherit">Inherit</option>
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

    </div>
  </div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async _handleTokenMessage(webview: vscode.Webview, msg: any, filePath: string): Promise<void> {
    const folderDir = path.dirname(filePath);
    const collection = this._collectionService.getCollections().find(c =>
      folderDir.toLowerCase().startsWith(c.rootDir.toLowerCase()),
    );
    if (!collection) return;
    await handleOAuth2TokenMessage(webview, msg, collection, this._environmentService, this._oauth2Service);
  }

  private async _sendVariables(webview: vscode.Webview, filePath: string): Promise<void> {
    try {
      // Find which collection this folder belongs to
      const folderDir = path.dirname(filePath);
      const collection = this._collectionService.getCollections().find(c =>
        folderDir.toLowerCase().startsWith(c.rootDir.toLowerCase()),
      );
      if (!collection) return;
      const varsWithSource = await this._environmentService.resolveVariablesWithSource(collection);
      const varsObj: Record<string, string> = {};
      const sourcesObj: Record<string, string> = {};
      for (const [k, v] of varsWithSource) {
        varsObj[k] = v.value;
        sourcesObj[k] = v.source;
      }

      const enabledProviders = (collection.data.config?.secretProviders ?? []).filter((p: any) => !p.disabled);
      const secretProviderNames = enabledProviders.map((p: any) => p.name as string);

      const secretNames: Record<string, string[]> = {};
      for (const p of enabledProviders) {
        const cached = this._secretService.getCachedSecretNames(p.name);
        if (cached.length > 0) {
          secretNames[p.name] = cached;
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

      const variables = await this._environmentService.resolveVariables(collection);
      this._secretService.prefetchSecretNames(enabledProviders, variables).then(() => {
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
