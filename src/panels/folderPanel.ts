import * as vscode from 'vscode';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { Folder } from '../models/types';
import { stringifyYaml } from '../services/yamlParser';

/**
 * CustomTextEditorProvider for OpenCollection folder.yml files.
 * Allows editing folder-level request defaults: auth, headers, variables.
 */
export class FolderEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  public static readonly viewType = 'missio.folderEditor';
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
  ) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new FolderEditorProvider(context);
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
