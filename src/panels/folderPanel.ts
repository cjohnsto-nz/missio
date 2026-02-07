import * as vscode from 'vscode';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { Folder, MissioCollection } from '../models/types';
import { stringifyYaml } from '../services/yamlParser';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { OAuth2Service } from '../services/oauth2Service';
import type { SecretService } from '../services/secretService';
import { BaseEditorProvider } from './basePanel';

/**
 * CustomTextEditorProvider for OpenCollection folder.yml files.
 * Allows editing folder-level request defaults: auth, headers, variables.
 */
export class FolderEditorProvider extends BaseEditorProvider {
  public static readonly viewType = 'missio.folderEditor';

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

  protected _findCollection(filePath: string): MissioCollection | undefined {
    const folderDir = path.dirname(filePath);
    return this._collectionService.getCollections().find(c =>
      folderDir.toLowerCase().startsWith(c.rootDir.toLowerCase()),
    );
  }

  protected _sendDocumentToWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
    let folder: Folder;
    try {
      folder = parseYaml(document.getText()) || {};
    } catch {
      folder = {} as Folder;
    }
    webview.postMessage({ type: 'folderLoaded', folder, filePath: document.uri.fsPath });
  }

  protected _getDocumentDataKey(): string { return 'folder'; }
  protected _getScriptFilename(): string { return 'folderPanel.js'; }
  protected _getCssFilenames(): string[] { return ['requestPanel.css', 'collectionPanel.css']; }

  protected _getBodyHtml(_webview: vscode.Webview): string {
    return `
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
          <div class="form-field"><label>Type</label><select class="auth-select" id="defaultAuthType">
            <option value="none">No Auth</option>
            <option value="inherit">Inherit</option>
            <option value="bearer">Bearer Token</option>
            <option value="basic">Basic Auth</option>
            <option value="apikey">API Key</option>
            <option value="oauth2">OAuth 2.0</option>
          </select></div>
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
  </div>`;
  }
}
