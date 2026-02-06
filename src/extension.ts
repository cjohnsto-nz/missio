import * as vscode from 'vscode';
import * as path from 'path';
import { CollectionService } from './services/collectionService';
import { EnvironmentService } from './services/environmentService';
import { SecretService } from './services/secretService';
import { HttpClient } from './services/httpClient';
import { CollectionTreeProvider } from './providers/collectionTreeProvider';
import { EnvironmentTreeProvider } from './providers/environmentTreeProvider';
import { MissioCodeLensProvider } from './providers/codeLensProvider';
import { ResponseDocumentProvider } from './providers/responseProvider';
import { RequestPanel } from './panels/requestPanel';
import { CollectionPanel } from './panels/collectionPanel';
import { readRequestFile, stringifyYaml } from './services/yamlParser';
import type { HttpRequest, OpenCollection } from './models/types';

let collectionService: CollectionService;
let environmentService: EnvironmentService;
let secretService: SecretService;
let httpClient: HttpClient;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── Services ───────────────────────────────────────────────────

  secretService = new SecretService();
  collectionService = new CollectionService();
  environmentService = new EnvironmentService(context, secretService);
  httpClient = new HttpClient(environmentService);

  const responseProvider = new ResponseDocumentProvider();

  context.subscriptions.push(
    collectionService,
    environmentService,
    secretService,
    httpClient,
    responseProvider,
  );

  // Initialize collections (scan workspace)
  await collectionService.initialize();
  // Lazy-init secret providers on first use
  secretService.initialize().catch(() => { /* handled internally */ });

  // ── Tree Views ─────────────────────────────────────────────────

  const collectionTreeProvider = new CollectionTreeProvider(collectionService);
  const environmentTreeProvider = new EnvironmentTreeProvider(collectionService, environmentService);

  context.subscriptions.push(
    collectionTreeProvider,
    environmentTreeProvider,
    vscode.window.registerTreeDataProvider('missio.collections', collectionTreeProvider),
    vscode.window.registerTreeDataProvider('missio.environments', environmentTreeProvider),
  );

  // ── Webview Serializer (restore panels on reload) ────────────
  RequestPanel.registerSerializer(context, httpClient, collectionService, environmentService);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('missio.sendRequest', async (filePathOrUri?: string) => {
      try {
        let filePath: string | undefined;

        if (typeof filePathOrUri === 'string') {
          filePath = filePathOrUri;
        } else {
          // Use active editor
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            filePath = editor.document.uri.fsPath;
          }
        }

        if (!filePath) {
          vscode.window.showWarningMessage('No request file selected.');
          return;
        }

        const request = await readRequestFile(filePath);
        if (!request?.http?.method || !request?.http?.url) {
          vscode.window.showWarningMessage('File does not contain a valid HTTP request.');
          return;
        }

        // Find which collection this request belongs to
        const collection = findCollectionForFile(filePath);
        if (!collection) {
          vscode.window.showWarningMessage('Could not find a collection for this request file. Ensure a collection.yml exists in a parent directory.');
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Sending ${request.http.method.toUpperCase()} ${request.http.url}`,
            cancellable: true,
          },
          async (_progress, token) => {
            token.onCancellationRequested(() => httpClient.cancelAll());
            const response = await httpClient.send(request, collection);
            await responseProvider.showResponse(response, request.info?.name);
          },
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Request failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('missio.refreshCollections', () => {
      collectionService.refresh();
    }),

    vscode.commands.registerCommand('missio.openRequest', async (filePath: string, collectionId?: string) => {
      if (filePath) {
        const cId = collectionId ?? findCollectionForFile(filePath)?.id;
        if (cId) {
          await RequestPanel.open(filePath, cId, httpClient, collectionService, environmentService, context.extensionUri);
        } else {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
          await vscode.window.showTextDocument(doc);
        }
      }
    }),

    vscode.commands.registerCommand('missio.openCollection', async (collectionId?: string) => {
      let collection;
      if (collectionId) {
        collection = collectionService.getCollection(collectionId);
      } else {
        const collections = collectionService.getCollections();
        if (collections.length === 1) {
          collection = collections[0];
        } else if (collections.length > 1) {
          const pick = await vscode.window.showQuickPick(
            collections.map(c => ({
              label: c.data.info?.name ?? path.basename(c.rootDir),
              description: c.filePath,
              collection: c,
            })),
            { placeHolder: 'Select a collection to configure' },
          );
          collection = pick?.collection;
        }
      }
      if (collection) {
        await CollectionPanel.open(collection, collectionService, context.extensionUri);
      }
    }),

    vscode.commands.registerCommand('missio.selectEnvironment', async (collectionId?: string, envName?: string) => {
      if (collectionId && envName) {
        await environmentService.setActiveEnvironment(collectionId, envName);
        vscode.window.showInformationMessage(`Environment set to: ${envName}`);
        return;
      }

      // Interactive picker
      const collections = collectionService.getCollections();
      if (collections.length === 0) {
        vscode.window.showWarningMessage('No collections found.');
        return;
      }

      const collPick = collections.length === 1
        ? collections[0]
        : await vscode.window.showQuickPick(
            collections.map(c => ({
              label: c.data.info?.name ?? path.basename(c.rootDir),
              description: c.filePath,
              collection: c,
            })),
            { placeHolder: 'Select a collection' },
          ).then(r => r?.collection);

      if (!collPick) { return; }

      const environments = environmentService.getCollectionEnvironments(collPick);
      if (environments.length === 0) {
        vscode.window.showWarningMessage('No environments defined in this collection.');
        return;
      }

      const activeName = environmentService.getActiveEnvironmentName(collPick.id);
      const envPick = await vscode.window.showQuickPick(
        environments.map(e => ({
          label: e.name,
          description: e.name === activeName ? '● Active' : '',
          picked: e.name === activeName,
        })),
        { placeHolder: 'Select an environment' },
      );

      if (envPick) {
        await environmentService.setActiveEnvironment(collPick.id, envPick.label);
        vscode.window.showInformationMessage(`Environment set to: ${envPick.label}`);
      }
    }),

    vscode.commands.registerCommand('missio.newCollection', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Collection name',
        placeHolder: 'my-api',
      });
      if (!name) { return; }

      const parentFolder = folders.length === 1
        ? folders[0].uri
        : await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select parent folder',
          }).then(r => r?.[0]);

      if (!parentFolder) { return; }

      const collDir = vscode.Uri.joinPath(parentFolder, name);
      const collFile = vscode.Uri.joinPath(collDir, 'collection.yml');

      const template: OpenCollection = {
        opencollection: '1.0.0',
        info: { name, version: '1.0.0' },
        config: { environments: [] },
        items: [],
      };

      await vscode.workspace.fs.createDirectory(collDir);
      const content = stringifyYaml(template, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(collFile, Buffer.from(content, 'utf-8'));

      const doc = await vscode.workspace.openTextDocument(collFile);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Collection "${name}" created.`);
    }),

    vscode.commands.registerCommand('missio.newRequest', async () => {
      const collections = collectionService.getCollections();
      if (collections.length === 0) {
        vscode.window.showWarningMessage('No collections found. Create one first.');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Request name',
        placeHolder: 'get-users',
      });
      if (!name) { return; }

      const method = await vscode.window.showQuickPick(
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        { placeHolder: 'HTTP method' },
      );
      if (!method) { return; }

      const collection = collections.length === 1
        ? collections[0]
        : await vscode.window.showQuickPick(
            collections.map(c => ({
              label: c.data.info?.name ?? path.basename(c.rootDir),
              collection: c,
            })),
            { placeHolder: 'Select a collection' },
          ).then(r => r?.collection);

      if (!collection) { return; }

      const fileName = `${name}.yml`;
      const filePath = vscode.Uri.file(path.join(collection.rootDir, fileName));

      const template: HttpRequest = {
        info: { name, type: 'http', seq: 1 },
        http: {
          method,
          url: '{{baseUrl}}/',
          headers: [],
          params: [],
        },
        settings: {
          encodeUrl: true,
          timeout: 0,
          followRedirects: true,
          maxRedirects: 5,
        },
      };

      const content = stringifyYaml(template, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(filePath, Buffer.from(content, 'utf-8'));

      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('missio.newEnvironment', async () => {
      const collections = collectionService.getCollections();
      if (collections.length === 0) {
        vscode.window.showWarningMessage('No collections found.');
        return;
      }

      const collection = collections.length === 1
        ? collections[0]
        : await vscode.window.showQuickPick(
            collections.map(c => ({
              label: c.data.info?.name ?? path.basename(c.rootDir),
              collection: c,
            })),
            { placeHolder: 'Select a collection' },
          ).then(r => r?.collection);

      if (!collection) { return; }

      const name = await vscode.window.showInputBox({
        prompt: 'Environment name',
        placeHolder: 'development',
      });
      if (!name) { return; }

      // Add environment to collection.yml
      if (!collection.data.config) {
        collection.data.config = {};
      }
      if (!collection.data.config.environments) {
        collection.data.config.environments = [];
      }
      collection.data.config.environments.push({
        name,
        variables: [
          { name: 'baseUrl', value: 'http://localhost:3000' },
        ],
      });

      const content = stringifyYaml(collection.data, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(collection.filePath),
        Buffer.from(content, 'utf-8'),
      );

      vscode.window.showInformationMessage(`Environment "${name}" added to collection.`);
    }),

    vscode.commands.registerCommand('missio.editEnvironment', async (collectionId?: string) => {
      let collection;
      if (collectionId) {
        collection = collectionService.getCollection(collectionId);
      } else {
        const collections = collectionService.getCollections();
        if (collections.length > 0) { collection = collections[0]; }
      }
      if (collection) {
        await CollectionPanel.open(collection, collectionService, context.extensionUri);
      }
    }),

    vscode.commands.registerCommand('missio.configureSecrets', async () => {
      const options = ['Azure Key Vault', 'Keeper Secrets Manager'];
      const pick = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select a secret provider to configure',
      });

      if (pick) {
        // Open settings filtered to the relevant section
        const key = pick === 'Azure Key Vault'
          ? 'missio.secretProviders.azureKeyVault'
          : 'missio.secretProviders.keeper';
        await vscode.commands.executeCommand('workbench.action.openSettings', key);
      }
    }),

    vscode.commands.registerCommand('missio.cancelRequest', () => {
      httpClient.cancelAll();
      vscode.window.showInformationMessage('All active requests cancelled.');
    }),

    vscode.commands.registerCommand('missio.renameRequest', async (node: any) => {
      const filePath = node?.resourceUri?.fsPath ?? node?.request?._filePath;
      if (!filePath) {
        vscode.window.showWarningMessage('No request file found.');
        return;
      }
      try {
        const request = await readRequestFile(filePath);
        const currentName = request?.info?.name ?? path.basename(filePath, path.extname(filePath));
        const newName = await vscode.window.showInputBox({
          prompt: 'New request name',
          value: currentName,
        });
        if (!newName || newName === currentName) return;

        // Update info.name in the YAML
        if (request.info) {
          request.info.name = newName;
        } else {
          request.info = { name: newName, type: 'http' };
        }
        const content = stringifyYaml(request, { lineWidth: 120 });
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf-8'));

        // Rename the file to match the new title (slugified)
        const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);
        const newFilePath = path.join(dir, slug + ext);

        if (newFilePath !== filePath) {
          const oldUri = vscode.Uri.file(filePath);
          const newUri = vscode.Uri.file(newFilePath);
          // Use workspace edit so git detects it as a rename
          const edit = new vscode.WorkspaceEdit();
          edit.renameFile(oldUri, newUri);
          await vscode.workspace.applyEdit(edit);
        }

        // Sync any open RequestPanel
        RequestPanel.handleRename(filePath, newFilePath !== filePath ? newFilePath : filePath, newName);

        vscode.window.showInformationMessage(`Renamed to "${newName}".`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to rename: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('missio.deleteRequest', async (node: any) => {
      const filePath = node?.resourceUri?.fsPath ?? node?.request?._filePath;
      if (!filePath) {
        vscode.window.showWarningMessage('No request file found.');
        return;
      }
      const name = path.basename(filePath);
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${name}"? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      try {
        RequestPanel.handleDelete(filePath);
        await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
        vscode.window.showInformationMessage(`Deleted "${name}".`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to delete: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('missio.duplicateRequest', async (node: any) => {
      const filePath = node?.resourceUri?.fsPath ?? node?.request?._filePath;
      if (!filePath) {
        vscode.window.showWarningMessage('No request file found.');
        return;
      }
      try {
        const request = await readRequestFile(filePath);
        const currentName = request?.info?.name ?? path.basename(filePath, path.extname(filePath));
        const newName = await vscode.window.showInputBox({
          prompt: 'Name for the duplicate',
          value: currentName + ' Copy',
        });
        if (!newName) return;

        // Update info.name
        if (request.info) {
          request.info.name = newName;
        } else {
          request.info = { name: newName, type: 'http' };
        }

        const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);
        let newFilePath = path.join(dir, slug + ext);

        // Avoid overwriting existing files
        let counter = 1;
        while (await fileExists(newFilePath)) {
          newFilePath = path.join(dir, `${slug}-${counter}${ext}`);
          counter++;
        }

        const content = stringifyYaml(request, { lineWidth: 120 });
        await vscode.workspace.fs.writeFile(vscode.Uri.file(newFilePath), Buffer.from(content, 'utf-8'));

        vscode.window.showInformationMessage(`Request duplicated as "${newName}".`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to duplicate: ${e.message}`);
      }
    }),
  );

  // ── Status Bar ─────────────────────────────────────────────────

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'missio.selectEnvironment';
  statusBarItem.tooltip = 'Missio: Select Active Environment';
  context.subscriptions.push(statusBarItem);

  function updateStatusBar() {
    const collections = collectionService.getCollections();
    if (collections.length === 0) {
      statusBarItem.hide();
      return;
    }
    const envNames: string[] = [];
    for (const c of collections) {
      const name = environmentService.getActiveEnvironmentName(c.id);
      if (name) { envNames.push(name); }
    }
    if (envNames.length > 0) {
      statusBarItem.text = `$(server-environment) ${envNames.join(', ')}`;
    } else {
      statusBarItem.text = '$(server-environment) No Env';
    }
    statusBarItem.show();
  }

  updateStatusBar();
  collectionService.onDidChange(updateStatusBar);
  environmentService.onDidChange(updateStatusBar);

  // ── Context Key ────────────────────────────────────────────────

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      const fileName = path.basename(editor.document.fileName).toLowerCase();
      const isReq = (fileName.endsWith('.yml') || fileName.endsWith('.yaml'))
        && fileName !== 'collection.yml' && fileName !== 'collection.yaml'
        && fileName !== 'workspace.yml' && fileName !== 'workspace.yaml';
      vscode.commands.executeCommand('setContext', 'missio.isRequestFile', isReq);
    }
  }, null, context.subscriptions);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

function findCollectionForFile(filePath: string): import('./models/types').MissioCollection | undefined {
  const collections = collectionService.getCollections();
  // Find the collection whose rootDir is a parent of this file
  const normalized = filePath.replace(/\\/g, '/');
  return collections.find(c => {
    const root = c.rootDir.replace(/\\/g, '/');
    return normalized.startsWith(root + '/') || normalized === root;
  });
}

export function deactivate(): void {
  // All disposables handled via context.subscriptions
}
