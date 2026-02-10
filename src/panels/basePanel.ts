import * as vscode from 'vscode';
import * as path from 'path';
import type { MissioCollection } from '../models/types';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { OAuth2Service } from '../services/oauth2Service';
import type { SecretService } from '../services/secretService';
import { handleOAuth2TokenMessage } from '../services/oauth2TokenHelper';
import { sendVariablesAndPrefetch } from './panelHelper';

/** Context passed to subclass message handlers for safe document editing. */
export interface EditorContext {
  document: vscode.TextDocument;
  webviewPanel: vscode.WebviewPanel;
  /** Apply a YAML edit to the document with proper isUpdatingDocument guarding. */
  applyEdit: (data: any) => Promise<void>;
}

/**
 * Base class for all CustomTextEditorProviders in Missio.
 * Owns shared infrastructure: service dependencies, variable resolution,
 * OAuth2 token handling, HTML boilerplate, nonce generation.
 *
 * Subclasses must implement:
 * - _findCollection(filePath): find the MissioCollection for a given file
 * - _getBodyHtml(webview): return the <body> inner HTML (no <html>/<head>)
 * - _getScriptFilename(): return the JS filename in media/ (e.g. 'requestPanel.js')
 * - _getCssFilenames(): return CSS filenames in media/ to load
 *
 * Subclasses may override:
 * - _getFolderDefaults(filePath, collection): return folder-level RequestDefaults (request panel only)
 * - _onMessage(webview, msg, document): handle panel-specific messages
 * - _onReady(webview, document): called after sending initial document + variables
 */
export abstract class BaseEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  protected _disposables: vscode.Disposable[] = [];

  constructor(
    protected readonly _context: vscode.ExtensionContext,
    protected readonly _collectionService: CollectionService,
    protected readonly _environmentService: EnvironmentService,
    protected readonly _oauth2Service: OAuth2Service,
    protected readonly _secretService: SecretService,
  ) {}

  // ── Abstract methods subclasses must implement ──

  /** Find the MissioCollection for a given file path. */
  protected abstract _findCollection(filePath: string): MissioCollection | undefined;

  /** Return the inner HTML for the <body> element. */
  protected abstract _getBodyHtml(webview: vscode.Webview): string;

  /** Return the JS script filename in media/ (e.g. 'requestPanel.js'). */
  protected abstract _getScriptFilename(): string;

  /** Return CSS filenames in media/ to load (e.g. ['requestPanel.css']). */
  protected abstract _getCssFilenames(): string[];

  /** Parse the document text and send it to the webview. */
  protected abstract _sendDocumentToWebview(webview: vscode.Webview, document: vscode.TextDocument): void;

  // ── Optional overrides ──

  /** Handle panel-specific messages. Return true if handled. */
  protected async _onMessage(
    _webview: vscode.Webview,
    _msg: any,
    _ctx: EditorContext,
  ): Promise<boolean> {
    return false;
  }

  // ── Shared implementation ──

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

    // Context object passed to subclass message handlers
    const ctx: EditorContext = {
      document,
      webviewPanel,
      applyEdit: async (data: any) => {
        if (isUpdatingDocument) return;
        isUpdatingDocument = true;
        try {
          const { stringifyYaml } = await import('../services/yamlParser');
          const yaml = stringifyYaml(data, { lineWidth: 120 });
          if (yaml === document.getText()) return;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), yaml);
          await vscode.workspace.applyEdit(edit);
        } finally {
          isUpdatingDocument = false;
        }
      },
    };

    const sendVariables = () => this._sendVariables(webviewPanel.webview, document.uri.fsPath);

    // Live-reload variables when collection or environment data changes
    disposables.push(
      this._collectionService.onDidChange(() => sendVariables()),
      this._environmentService.onDidChange(() => {
        this._secretService.clearSecretNamesCache();
        sendVariables();
      }),
    );

    // Handle messages from webview
    disposables.push(
      webviewPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ready') {
          this._sendDocumentToWebview(webviewPanel.webview, document);
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
            await this._applyDocumentEdit(document, msg);
          } finally {
            isUpdatingDocument = false;
          }
          return;
        }
        if (msg.type === 'fetchSecretNames') {
          try {
            const collection = this._findCollection(document.uri.fsPath);
            if (!collection) return;
            const variables = await this._environmentService.resolveVariables(collection);
            const secretNames = await this._secretService.listSecretNames(msg.provider, variables);
            webviewPanel.webview.postMessage({ type: 'secretNamesResult', providerName: msg.provider.name, secretNames });
          } catch { /* silently fail */ }
          return;
        }
        if (msg.type === 'storeSecretValue') {
          try {
            if (!msg.collectionRoot || !msg.envName || !msg.varName) return;
            await this._environmentService.storeSecretValue(msg.collectionRoot, msg.envName, msg.varName, msg.value ?? '');
            webviewPanel.webview.postMessage({ type: 'secretValueStored', envName: msg.envName, varName: msg.varName });
            await sendVariables();
          } catch { /* silently fail */ }
          return;
        }
        if (msg.type === 'peekSecretValue') {
          try {
            if (!msg.collectionRoot || !msg.envName || !msg.varName) return;
            const val = await this._environmentService.getSecretValue(msg.collectionRoot, msg.envName, msg.varName);
            webviewPanel.webview.postMessage({
              type: 'secretValuePeek',
              envName: msg.envName,
              varName: msg.varName,
              value: val ?? '',
            });
          } catch { /* silently fail */ }
          return;
        }
        if (msg.type === 'deleteSecretValue') {
          try {
            if (!msg.collectionRoot || !msg.envName || !msg.varName) return;
            await this._environmentService.deleteSecretValue(msg.collectionRoot, msg.envName, msg.varName);
          } catch { /* silently fail */ }
          return;
        }
        if (msg.type === 'renameSecretValue') {
          try {
            if (!msg.collectionRoot || !msg.envName || !msg.oldName || !msg.newName) return;
            await this._environmentService.renameSecretValue(msg.collectionRoot, msg.envName, msg.oldName, msg.newName);
          } catch { /* silently fail */ }
          return;
        }
        if (msg.type === 'updateVariable' || msg.type === 'addVariable') {
          try {
            const { varName, value, scope } = msg;
            if (!varName) return;
            if (scope === 'global') {
              const globals = this._environmentService.getGlobalVariables();
              const existing = globals.find(g => g.name === varName);
              if (existing) { existing.value = value ?? ''; } else { globals.push({ name: varName, value: value ?? '' }); }
              await this._environmentService.setGlobalVariables(globals);
            } else {
              // collection or environment — edit the collection.yml file (not the current document)
              const collection = this._findCollection(document.uri.fsPath);
              if (!collection) return;
              const collUri = vscode.Uri.file(collection.filePath);
              const fs = await import('fs');
              const collText = await fs.promises.readFile(collection.filePath, 'utf-8');
              const { parseYaml, stringifyYaml } = await import('../services/yamlParser');
              const data = parseYaml(collText);
              if (scope === 'collection') {
                if (!data.request) data.request = {};
                if (!data.request.variables) data.request.variables = [];
                const existing = data.request.variables.find((v: any) => v.name === varName);
                if (existing) { existing.value = value ?? ''; } else { data.request.variables.push({ name: varName, value: value ?? '' }); }
              } else if (scope === 'environment') {
                const envName = this._environmentService.getActiveEnvironmentName(collection.id);
                if (envName && data.config?.environments) {
                  const env = data.config.environments.find((e: any) => e.name === envName);
                  if (env) {
                    if (!env.variables) env.variables = [];
                    const existing = env.variables.find((v: any) => v.name === varName);
                    if (existing && existing.secret) {
                      // Secret env var — store value in SecretStorage, don't write to YAML
                      const collRoot = path.dirname(collection.filePath);
                      await this._environmentService.storeSecretValue(collRoot, envName, varName, value ?? '');
                    } else if (existing) {
                      existing.value = value ?? '';
                    } else {
                      env.variables.push({ name: varName, value: value ?? '' });
                    }
                  }
                }
              }
              const yaml = stringifyYaml(data, { lineWidth: 120 });
              if (yaml !== collText) {
                // Use workspace edit on the collection.yml URI
                const collDoc = await vscode.workspace.openTextDocument(collUri);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(collUri, new vscode.Range(0, 0, collDoc.lineCount, 0), yaml);
                await vscode.workspace.applyEdit(edit);
                await collDoc.save();
              }
            }
            await sendVariables();
          } catch { /* silently fail */ }
          return;
        }
        if (msg.type === 'resolveSecret') {
          try {
            const secretRef: string = msg.secretRef; // e.g. "$secret.kv-name.my-key"
            const match = /^\$secret\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/.exec(secretRef);
            if (!match) return;
            const [, providerName, secretName] = match;
            const collection = this._findCollection(document.uri.fsPath);
            if (!collection) return;
            const providers = collection.data.config?.secretProviders || [];
            const variables = await this._environmentService.resolveVariables(collection);
            const value = await this._secretService.resolveSecret(providerName, secretName, providers, variables);
            webviewPanel.webview.postMessage({ type: 'secretValueResolved', secretRef, value: value ?? '' });
          } catch (e: any) {
            webviewPanel.webview.postMessage({ type: 'secretValueResolved', secretRef: msg.secretRef, error: e.message });
          }
          return;
        }
        // Delegate to subclass
        await this._onMessage(webviewPanel.webview, msg, ctx);
      }),
    );

    // Listen for external changes to the document
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && !isUpdatingDocument) {
          this._sendDocumentToWebview(webviewPanel.webview, document);
          sendVariables();
        }
      }),
    );

    // Clean up on dispose
    webviewPanel.onDidDispose(() => {
      this._onPanelDisposed(document);
      disposables.forEach(d => d.dispose());
    });

    // Let subclass do additional setup
    this._onPanelCreated(document, webviewPanel, disposables);
  }

  /** Called when a panel is created. Subclasses can override to track panels. */
  protected _onPanelCreated(
    _document: vscode.TextDocument,
    _webviewPanel: vscode.WebviewPanel,
    _disposables: vscode.Disposable[],
  ): void {}

  /** Called when a panel is disposed. Subclasses can override to untrack panels. */
  protected _onPanelDisposed(_document: vscode.TextDocument): void {}

  /** Return the key in the updateDocument message that contains the document data (e.g. 'request', 'collection', 'folder'). */
  protected abstract _getDocumentDataKey(): string;

  /** Apply a document edit from the webview's updateDocument message. */
  protected async _applyDocumentEdit(document: vscode.TextDocument, msg: any): Promise<void> {
    const { stringifyYaml } = await import('../services/yamlParser');
    const data = msg[this._getDocumentDataKey()];
    if (!data) return;
    const yaml = stringifyYaml(data, { lineWidth: 120 });
    if (yaml === document.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      yaml,
    );
    await vscode.workspace.applyEdit(edit);
  }

  protected async _sendVariables(webview: vscode.Webview, filePath: string): Promise<void> {
    try {
      const collection = this._findCollection(filePath);
      if (!collection) return;
      const folderDefaults = await this._getFolderDefaults(filePath, collection);
      await sendVariablesAndPrefetch(
        webview, collection, this._environmentService, this._secretService,
        folderDefaults, () => this._sendVariables(webview, filePath),
      );
    } catch { /* Variables unavailable */ }
  }

  /** Return folder-level RequestDefaults for variable resolution. Override in request panel. */
  protected async _getFolderDefaults(
    _filePath: string,
    _collection: MissioCollection,
  ): Promise<any | undefined> {
    return undefined;
  }

  protected async _handleTokenMessage(webview: vscode.Webview, msg: any, filePath: string): Promise<void> {
    const collection = this._findCollection(filePath);
    if (!collection) return;
    await handleOAuth2TokenMessage(webview, msg, collection, this._environmentService, this._oauth2Service, this._secretService);
  }

  protected _getHtml(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    const themeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'theme.css'));
    const codiconFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'codicon.ttf'));
    const cssLinks = this._getCssFilenames()
      .map(f => {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', f));
        return `<link rel="stylesheet" href="${uri}">`;
      })
      .join('\n');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', this._getScriptFilename()),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; font-src ${webview.cspSource};">
<style>@font-face { font-family: 'codicon'; src: url('${codiconFontUri}') format('truetype'); }
.codicon { font-family: 'codicon'; font-size: 20px; line-height: 1; display: inline-block; -webkit-font-smoothing: antialiased; }
.codicon-folder-library::before { content: '\\ebdf'; }
.codicon-folder::before { content: '\\ea83'; }
.codicon-globe::before { content: '\\eb01'; }
.codicon-add::before { content: '\\ea60'; }
.codicon-desktop-download::before { content: '\\ec74'; }
.codicon-trash::before { content: '\\ea81'; }
.codicon.icon-collection { color: var(--m-src-collection); }
.codicon.icon-folder { color: var(--m-src-folder); }
.codicon.icon-global { color: var(--m-src-global); }
</style>
<link rel="stylesheet" href="${themeUri}">
${cssLinks}
</head>
<body>
${this._getBodyHtml(webview)}
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  protected _getNonce(): string {
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
