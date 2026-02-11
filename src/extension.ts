import * as vscode from 'vscode';
import * as path from 'path';
import { CollectionService } from './services/collectionService';
import { EnvironmentService } from './services/environmentService';
import { SecretService } from './services/secretService';
import { HttpClient } from './services/httpClient';
import { CollectionTreeProvider } from './providers/collectionTreeProvider';
import { EnvironmentTreeProvider } from './providers/environmentTreeProvider';
import { GlobalsTreeProvider } from './providers/globalsTreeProvider';
import { MissioCodeLensProvider } from './providers/codeLensProvider';
import { ResponseDocumentProvider } from './providers/responseProvider';
import { RequestEditorProvider } from './panels/requestPanel';
import { CollectionEditorProvider } from './panels/collectionPanel';
import { FolderEditorProvider } from './panels/folderPanel';
import { OAuth2Service } from './services/oauth2Service';
import {
  registerRequestCommands,
  registerCollectionCommands,
  registerEnvironmentCommands,
  registerFolderCommands,
  registerImportCommands,
  type CommandContext,
} from './commands';
import { GlobalsPanel } from './panels/globalsPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── Services ───────────────────────────────────────────────────

  const secretService = new SecretService();
  const collectionService = new CollectionService();
  const environmentService = new EnvironmentService(context, secretService);
  const httpClient = new HttpClient(environmentService);
  const oauth2Service = new OAuth2Service(context.secrets);
  httpClient.setOAuth2Service(oauth2Service);
  httpClient.setSecretService(secretService);
  const responseProvider = new ResponseDocumentProvider();

  context.subscriptions.push(
    collectionService,
    environmentService,
    secretService,
    httpClient,
    oauth2Service,
    responseProvider,
  );

  // Initialize collections in the background — don't block activate()
  const initPromise = collectionService.initialize().catch(e => {
    console.error('[Missio] Collection initialization failed:', e);
  });

  // ── Tree Views ─────────────────────────────────────────────────

  const collectionTreeProvider = new CollectionTreeProvider(collectionService);
  const environmentTreeProvider = new EnvironmentTreeProvider(collectionService, environmentService);
  const globalsTreeProvider = new GlobalsTreeProvider(environmentService);

  const collectionsTreeView = vscode.window.createTreeView('missio.collections', {
    treeDataProvider: collectionTreeProvider,
    dragAndDropController: collectionTreeProvider,
    canSelectMany: true,
  });

  collectionsTreeView.onDidExpandElement(e => collectionTreeProvider.trackExpand(e.element));
  collectionsTreeView.onDidCollapseElement(e => collectionTreeProvider.trackCollapse(e.element));

  context.subscriptions.push(
    collectionTreeProvider,
    environmentTreeProvider,
    globalsTreeProvider,
    collectionsTreeView,
    vscode.window.registerTreeDataProvider('missio.environments', environmentTreeProvider),
    vscode.window.registerTreeDataProvider('missio.globals', globalsTreeProvider),
  );

  // ── Custom Editor ──────────────────────────────────────────────

  context.subscriptions.push(
    RequestEditorProvider.register(context, httpClient, collectionService, environmentService, oauth2Service, secretService),
    CollectionEditorProvider.register(context, collectionService, environmentService, oauth2Service, secretService),
    FolderEditorProvider.register(context, collectionService, environmentService, oauth2Service, secretService),
  );

  // ── CodeLens ───────────────────────────────────────────────────

  const codeLensProvider = new MissioCodeLensProvider();
  context.subscriptions.push(
    codeLensProvider,
    vscode.languages.registerCodeLensProvider(
      { language: 'yaml', scheme: 'file' },
      codeLensProvider,
    ),
  );

  // ── Commands ───────────────────────────────────────────────────

  const cmdCtx: CommandContext = {
    extensionContext: context,
    collectionService,
    environmentService,
    httpClient,
    responseProvider,
    collectionTreeProvider,
  };

  const globalsPanel = GlobalsPanel.register(context, environmentService);

  context.subscriptions.push(
    globalsPanel,
    vscode.commands.registerCommand('missio.editGlobalVariables', () => globalsPanel.open()),
    ...registerRequestCommands(cmdCtx),
    ...registerCollectionCommands(cmdCtx),
    ...registerEnvironmentCommands(cmdCtx),
    ...registerFolderCommands(cmdCtx),
    ...registerImportCommands(cmdCtx),
  );

  // ── Status Bar ─────────────────────────────────────────────────

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'missio.selectEnvironment';
  statusBarItem.tooltip = 'Missio: Select Active Environment';
  context.subscriptions.push(statusBarItem);

  function getActiveTabFilePath(): string | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (input && typeof input === 'object' && 'uri' in input) {
      return (input as { uri: vscode.Uri }).uri.fsPath;
    }
    return undefined;
  }

  function findCollectionForFile(filePath: string) {
    const collections = collectionService.getCollections();
    const normalized = filePath.replace(/\\/g, '/');
    return collections.find(c => {
      const root = c.rootDir.replace(/\\/g, '/');
      return normalized.startsWith(root + '/') || normalized === root;
    });
  }

  function isMissioRequestFile(filePath: string): boolean {
    const fileName = path.basename(filePath).toLowerCase();
    return (fileName.endsWith('.yml') || fileName.endsWith('.yaml'))
      && fileName !== 'collection.yml' && fileName !== 'collection.yaml'
      && fileName !== 'workspace.yml' && fileName !== 'workspace.yaml';
  }

  function updateStatusBar() {
    const filePath = getActiveTabFilePath();
    if (!filePath || !isMissioRequestFile(filePath)) {
      statusBarItem.hide();
      vscode.commands.executeCommand('setContext', 'missio.isRequestFile', false);
      return;
    }

    vscode.commands.executeCommand('setContext', 'missio.isRequestFile', true);

    const collection = findCollectionForFile(filePath);
    if (!collection) {
      statusBarItem.hide();
      return;
    }

    const envName = environmentService.getActiveEnvironmentName(collection.id);
    const collName = collection.data.info?.name ?? path.basename(collection.rootDir);
    if (envName) {
      statusBarItem.text = `$(server-environment) ${collName}: ${envName}`;
      statusBarItem.backgroundColor = undefined;
    } else {
      const hasEnvironments = (collection.data.config?.environments?.length ?? 0) > 0;
      if (hasEnvironments) {
        statusBarItem.text = `$(warning) ${collName}: No Env`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        statusBarItem.text = `$(server-environment) ${collName}: No Env`;
        statusBarItem.backgroundColor = undefined;
      }
    }
    statusBarItem.show();
  }

  updateStatusBar();
  collectionService.onDidChange(updateStatusBar);
  environmentService.onDidChange(updateStatusBar);

  // Update status bar when active tab changes (covers custom editors)
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => updateStatusBar()),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
  );
}

export function deactivate(): void {
  // All disposables handled via context.subscriptions
}
