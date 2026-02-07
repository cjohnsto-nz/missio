import * as vscode from 'vscode';
import type { EnvironmentService, GlobalVariable } from '../services/environmentService';

/**
 * Standalone WebviewPanel for managing global variables.
 * Not file-backed — data lives in VS Code globalState + SecretStorage.
 */
export class GlobalsPanel implements vscode.Disposable {
  private static _instance: GlobalsPanel | undefined;
  private _panel: vscode.WebviewPanel | undefined;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _environmentService: EnvironmentService,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    environmentService: EnvironmentService,
  ): GlobalsPanel {
    const panel = new GlobalsPanel(context, environmentService);
    GlobalsPanel._instance = panel;
    return panel;
  }

  /** Open (or reveal) the globals editor panel. */
  open(): void {
    if (this._panel) {
      this._panel.reveal();
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'missio.globalsEditor',
      'Missio: Global Variables',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
      },
    );

    this._panel.webview.html = this._getHtml(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      undefined,
      this._disposables,
    );

    this._panel.onDidDispose(() => {
      this._panel = undefined;
    }, undefined, this._disposables);

    // Re-send data when global vars change externally (not from our own save)
    const sub = this._environmentService.onDidChange(() => {
      if (this._panel && !this._isSelfUpdate) {
        this._sendData(this._panel.webview);
      }
    });
    this._disposables.push(sub);
  }

  private _isSelfUpdate = false;

  private async _handleMessage(msg: any): Promise<void> {
    if (msg.type === 'ready') {
      if (this._panel) this._sendData(this._panel.webview);
      return;
    }
    if (msg.type === 'updateVariables') {
      const vars: GlobalVariable[] = msg.variables ?? [];
      this._isSelfUpdate = true;
      try {
        await this._environmentService.setGlobalVariables(vars);
      } finally {
        this._isSelfUpdate = false;
      }
      // Only refresh variable highlighting, don't re-render the DOM
      if (this._panel) this._sendVariablesResolved(this._panel.webview);
      return;
    }
    if (msg.type === 'addVariable') {
      // Only global scope is supported in the globals panel
      if (msg.varName) {
        const globals = this._environmentService.getGlobalVariables();
        if (!globals.find(g => g.name === msg.varName)) {
          globals.push({ name: msg.varName, value: msg.value ?? '' });
          await this._environmentService.setGlobalVariables(globals);
          if (this._panel) this._sendData(this._panel.webview);
        }
      }
      return;
    }
  }

  private async _sendData(webview: vscode.Webview): Promise<void> {
    const variables = this._environmentService.getGlobalVariables();
    webview.postMessage({ type: 'load', variables });
    await this._sendVariablesResolved(webview);
  }

  private _sendVariablesResolved(webview: vscode.Webview): void {
    const variables = this._environmentService.getGlobalVariables();
    const resolved: Record<string, string> = {};
    const sources: Record<string, string> = {};
    for (const v of variables) {
      if (!v.name || v.disabled) continue;
      if (v.value !== undefined) {
        resolved[v.name] = v.value;
        sources[v.name] = 'global';
      }
    }
    webview.postMessage({ type: 'variablesResolved', variables: resolved, sources });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    const themeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'theme.css'),
    );
    const collCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'collectionPanel.css'),
    );
    const reqCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'requestPanel.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'globalsPanel.js'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<link rel="stylesheet" href="${themeUri}">
<link rel="stylesheet" href="${collCssUri}">
<link rel="stylesheet" href="${reqCssUri}">
</head>
<body>
<div class="panel-wrap">
  <div class="panel-header">
    <h2>Global Variables</h2>
    <p class="hint" style="opacity:0.6;margin:4px 0 12px;font-size:12px;">Global variables apply across all collections. For better organization, consider using collection or environment variables instead.</p>
  </div>
  <div class="panel-body">
    <table class="kv-table">
      <colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:32px"></colgroup>
      <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
      <tbody id="varsBody"></tbody>
    </table>
    <button class="add-row-btn" id="addVarBtn">+ Add Variable</button>
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
    this._panel?.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}
