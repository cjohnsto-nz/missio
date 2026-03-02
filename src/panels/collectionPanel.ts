import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import type { OpenCollection, MissioCollection } from '../models/types';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { OAuth2Service } from '../services/oauth2Service';
import type { SecretService } from '../services/secretService';
import { migrateCollection } from '../services/migrations';
import { BaseEditorProvider, type EditorContext } from './basePanel';

/**
 * CustomTextEditorProvider for OpenCollection collection.yml files.
 * Uses the native TextDocument as the source of truth, giving us:
 * - Native dirty indicator (dot replacing X on tab)
 * - Native "unsaved changes" close warning
 * - Native Ctrl+S save
 * - Undo/redo support
 * - Proper restore on window reload
 */
export class CollectionEditorProvider extends BaseEditorProvider {
  public static readonly viewType = 'missio.collectionEditor';
  private static _panels = new Map<string, vscode.WebviewPanel>();

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
    const key = vscode.Uri.file(filePath).toString();
    const sendSwitch = () => {
      const panel = CollectionEditorProvider._panels.get(key);
      if (panel) {
        panel.webview.postMessage({ type: 'switchTab', tab, envName });
      }
    };
    setTimeout(sendSwitch, 100);
    setTimeout(sendSwitch, 500);
  }

  // ── BaseEditorProvider implementation ──

  protected _findCollection(filePath: string): MissioCollection | undefined {
    return this._collectionService.getCollections().find(c => c.filePath === filePath);
  }

  protected _sendDocumentToWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
    let collection: OpenCollection;
    try {
      collection = parseYaml(document.getText()) || {};
    } catch {
      collection = {} as OpenCollection;
    }
    migrateCollection(collection);
    const collectionRoot = require('path').dirname(document.uri.fsPath);
    webview.postMessage({ type: 'collectionLoaded', collection, filePath: document.uri.fsPath, collectionRoot });
  }

  protected _getDocumentDataKey(): string { return 'collection'; }
  protected _getScriptFilename(): string { return 'collectionPanel.js'; }
  protected _getCssFilenames(): string[] { return ['requestPanel.css', 'collectionPanel.css']; }

  protected _onPanelCreated(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _disposables: vscode.Disposable[],
  ): void {
    CollectionEditorProvider._panels.set(document.uri.toString(), webviewPanel);
  }

  protected _onPanelDisposed(document: vscode.TextDocument): void {
    CollectionEditorProvider._panels.delete(document.uri.toString());
  }

  protected async _applyDocumentEdit(document: vscode.TextDocument, msg: any): Promise<void> {
    // Detect env rename before applying the edit
    this._trackEnvRename(document, msg.collection);
    await super._applyDocumentEdit(document, msg);
  }

  protected async _onMessage(
    webview: vscode.Webview,
    msg: any,
    ctx: EditorContext,
  ): Promise<boolean> {
    if (msg.type === 'importEnvironment') {
      await vscode.commands.executeCommand('missio.importEnvironment');
      return true;
    }
    if (msg.type === 'testSecretProvider') {
      try {
        const collection = this._findCollection(ctx.document.uri.fsPath);
        const variables = collection
          ? await this._environmentService.resolveVariables(collection)
          : new Map<string, string>();
        const result = await this._secretService.testConnection(msg.provider, variables);
        const secretNames = await this._secretService.listSecretNames(msg.provider, variables);
        webview.postMessage({ type: 'testSecretProviderResult', success: true, secretCount: result.secretCount, canWrite: result.canWrite, role: result.role, providerIdx: msg.providerIdx, providerName: msg.provider.name, secretNames });
      } catch (e: any) {
        webview.postMessage({ type: 'testSecretProviderResult', success: false, error: e.message, providerIdx: msg.providerIdx });
      }
      return true;
    }
    if (msg.type === 'createSecretInVault') {
      try {
        const collection = this._findCollection(ctx.document.uri.fsPath);
        const variables = collection
          ? await this._environmentService.resolveVariables(collection)
          : new Map<string, string>();
        const providers = collection?.data.config?.secretProviders || [];
        await this._secretService.setSecret(msg.providerName, msg.secretName, msg.value, providers, variables);
        this._secretService.clearSecretNamesCache();
        const provider = providers.find((p: any) => p.name === msg.providerName);
        const secretNames = provider ? await this._secretService.listSecretNames(provider, variables) : [];
        webview.postMessage({ type: 'createSecretInVaultResult', success: true, providerName: msg.providerName, secretName: msg.secretName, secretNames });
      } catch (e: any) {
        webview.postMessage({ type: 'createSecretInVaultResult', success: false, providerName: msg.providerName, error: e.message });
      }
      return true;
    }
    return false;
  }

  // ── Collection-specific logic ──

  private _trackEnvRename(document: vscode.TextDocument, newCollection: any): void {
    const filePath = document.uri.fsPath;
    const collection = this._collectionService.getCollections().find(c => c.filePath === filePath);
    if (!collection) return;

    const activeName = this._environmentService.getActiveEnvironmentName(collection.id);
    if (!activeName) return;

    let oldData: any;
    try { oldData = parseYaml(document.getText()); } catch { return; }
    const oldEnvs: any[] = oldData?.config?.environments || [];
    const newEnvs: any[] = newCollection?.config?.environments || [];

    if (newEnvs.some((e: any) => e.name === activeName)) return;

    const oldIdx = oldEnvs.findIndex((e: any) => e.name === activeName);
    if (oldIdx < 0) return;

    if (oldIdx < newEnvs.length && newEnvs[oldIdx].name) {
      this._environmentService.setActiveEnvironment(collection.id, newEnvs[oldIdx].name);
    }
  }

  protected _getBodyHtml(_webview: vscode.Webview): string {
    return `
  <!-- Collection Header -->
  <div class="collection-header">
    <span class="codicon codicon-folder-library icon-collection"></span>
    <div class="collection-info">
      <span class="collection-type-label">Collection:</span> <span class="collection-name" id="collectionName">Collection</span>
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
          <div class="form-field"><label>Type</label><select class="auth-select" id="defaultAuthType">
            <option value="none">No Auth</option>
            <option value="bearer">Bearer Token</option>
            <option value="basic">Basic Auth</option>
            <option value="apikey">API Key</option>
            <option value="oauth2">OAuth 2.0</option>
          </select></div>
          <div id="defaultAuthFields"></div>
          <div class="form-field" style="margin-top:12px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="forceAuthInherit" />
              Force Auth Inherit
            </label>
            <div class="field-hint">When enabled, all requests in this collection use the collection-level auth above, ignoring any auth set on individual requests or folders.</div>
          </div>
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
          <colgroup><col style="width:18%"><col style="width:120px"><col><col style="width:22%"><col style="width:140px"><col style="width:70px"><col style="width:32px"></colgroup>
          <thead><tr><th>Name</th><th>Type</th><th>Namespace</th><th>Subscription</th><th>Role</th><th></th><th></th></tr></thead>
          <tbody id="secretProvidersBody"></tbody>
        </table>
        <button class="add-row-btn" id="addSecretProviderBtn">+ Add Secret Provider</button>
        <div id="createSecretFormContainer"></div>
        <div id="secretTestResult" style="margin-top:8px;font-size:12px;"></div>
      </div>

      <!-- Environments -->
      <div class="tab-panel" id="panel-environments">
        <div class="env-toolbar">
          <div class="form-field"><label>Environment</label><select class="auth-select" id="envSelector"></select></div>
          <button class="env-toolbar-btn env-toolbar-add" id="addEnvBtn" title="Add Environment"><span class="codicon codicon-add"></span></button>
          <button class="env-toolbar-btn env-toolbar-import" id="importEnvBtn" title="Import Environment"><span class="codicon codicon-desktop-download"></span></button>
          <button class="env-toolbar-btn env-toolbar-delete" id="removeEnvBtn" title="Remove Environment"><span class="codicon codicon-trash"></span></button>
        </div>
        <div id="envDetail"></div>
      </div>

    </div>
  </div>`;
  }
}
