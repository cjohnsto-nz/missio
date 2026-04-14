import * as vscode from 'vscode';
import * as path from 'path';
import type { CommandContext } from './types';
import type { MissioCollection, OpenCollection } from '../models/types';
import { CollectionEditorProvider } from '../panels/collectionPanel';
import { stringifyYaml } from '../services/yamlParser';
import { validateCollection, formatReport } from '../services/validationService';

export function registerCollectionCommands(ctx: CommandContext): vscode.Disposable[] {
  const { collectionService, collectionTreeProvider } = ctx;

  const resolveCollection = async (
    nodeOrId: any,
    placeHolder: string,
  ): Promise<MissioCollection | undefined> => {
    const collectionId = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId?.collection?.id;
    if (collectionId) {
      return collectionService.getCollection(collectionId);
    }

    const collections = collectionService.getCollections();
    if (collections.length === 1) {
      return collections[0];
    }
    if (collections.length > 1) {
      const pick = await vscode.window.showQuickPick(
        collections.map(c => ({
          label: c.data.info?.name ?? path.basename(c.rootDir),
          description: c.rootDir,
          collection: c,
        })),
        { placeHolder },
      );
      return pick?.collection;
    }
    return undefined;
  };

  const revealCollectionInExplorer = async (nodeOrId?: any): Promise<void> => {
    const collection = await resolveCollection(nodeOrId, 'Select a collection to reveal in Explorer');
    if (!collection) return;

    const target = vscode.Uri.file(collection.rootDir);
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', target);
  };
  const deleteCollection = async (nodeOrId?: any): Promise<void> => {
    const collection = await resolveCollection(nodeOrId, 'Select a collection to delete');
    if (!collection) return;

    const name = collection.data.info?.name ?? path.basename(collection.rootDir);
    const confirm = await vscode.window.showWarningMessage(
      `Delete collection "${name}"?`,
      {
        modal: true,
        detail: 'This will delete the entire collection folder and all files inside it.',
      },
      'Delete Collection',
    );
    if (confirm !== 'Delete Collection') return;

    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(collection.rootDir), {
        recursive: true,
        useTrash: true,
      });
      collectionService.refresh();
      vscode.window.showInformationMessage(`Collection "${name}" deleted.`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to delete collection "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const expandFirstLevelFolders = async (nodeOrId?: any): Promise<void> => {
    const collection = await resolveCollection(nodeOrId, 'Select a collection to expand first-level folders');
    if (!collection) return;
    await collectionTreeProvider.setFirstLevelFoldersExpanded(collection.id, true);
  };

  const collapseFirstLevelFolders = async (nodeOrId?: any): Promise<void> => {
    const collection = await resolveCollection(nodeOrId, 'Select a collection to collapse first-level folders');
    if (!collection) return;
    await collectionTreeProvider.setFirstLevelFoldersExpanded(collection.id, false);
  };

  return [
    vscode.commands.registerCommand('missio.refreshCollections', () => {
      collectionService.refresh();
    }),

    vscode.commands.registerCommand('missio.openCollection', async (nodeOrId?: any) => {
      const collection = await resolveCollection(nodeOrId, 'Select a collection to configure');
      if (collection) {
        await CollectionEditorProvider.open(collection.filePath);
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
      const collFile = vscode.Uri.joinPath(collDir, 'opencollection.yml');

      const template: OpenCollection = {
        opencollection: '1.0.0',
        info: { name, version: '1.0.0' },
        config: { environments: [] },
        items: [],
      };

      await vscode.workspace.fs.createDirectory(collDir);
      const content = stringifyYaml(template, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(collFile, Buffer.from(content, 'utf-8'));

      await CollectionEditorProvider.open(collFile.fsPath);
      vscode.window.showInformationMessage(`Collection "${name}" created.`);
    }),

    vscode.commands.registerCommand('missio.showCollectionInExplorer', revealCollectionInExplorer),
    vscode.commands.registerCommand('missio.showCollectionInFinder', revealCollectionInExplorer),
    vscode.commands.registerCommand('missio.expandFirstLevelFolders', expandFirstLevelFolders),
    vscode.commands.registerCommand('missio.collapseFirstLevelFolders', collapseFirstLevelFolders),
    vscode.commands.registerCommand('missio.deleteCollection', deleteCollection),

    vscode.commands.registerCommand('missio.selectWorkspace', (key: string | null) => {
      collectionService.setActiveWorkspace(key ?? null);
    }),

    vscode.commands.registerCommand('missio.locatePinnedWorkspace', async (node?: any) => {
      const oldPath: string | undefined = node?.entry?.folderPath;
      if (!oldPath) return;
      const result = await vscode.window.showOpenDialog({
        canSelectFolders: false,
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'Workspace files': ['code-workspace', 'yml', 'yaml'] },
        openLabel: 'Select Workspace File',
        title: `Locate "${path.basename(oldPath)}"`,
      });
      if (!result || result.length === 0) return;
      const newPath = result[0].fsPath;
      const config = vscode.workspace.getConfiguration('missio');
      const current = config.get<string[]>('pinnedWorkspacePaths', []);
      const updated = current.map((p: string) => p === oldPath ? newPath : p);
      await config.update('pinnedWorkspacePaths', updated, vscode.ConfigurationTarget.Global);
      // If the active pinned workspace was the one we just relocated, update it to the new path
      // so the config change handler doesn't reset the selection back to null.
      if (collectionService.getActiveWorkspaceKey() === oldPath) {
        collectionService.setActiveWorkspace(newPath);
      }
      // The config update triggers the configuration change handler which reloads pinned state;
      // no need for an extra refreshPinned() call.
    }),

    vscode.commands.registerCommand('missio.addPinnedWorkspace', async () => {
      const result = await vscode.window.showOpenDialog({
        canSelectFolders: false,
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'Workspace files': ['code-workspace', 'yml', 'yaml'] },
        openLabel: 'Add as Pinned Workspace',
        title: 'Select Workspace File (.code-workspace or workspace.yml)',
      });
      if (!result || result.length === 0) return;
      const folderPath = result[0].fsPath;
      const config = vscode.workspace.getConfiguration('missio');
      const current = config.get<string[]>('pinnedWorkspacePaths', []);
      if (current.includes(folderPath)) {
        vscode.window.showInformationMessage(`"${folderPath}" is already pinned.`);
        return;
      }
      await config.update('pinnedWorkspacePaths', [...current, folderPath], vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Pinned: ${folderPath}`);
    }),

    vscode.commands.registerCommand('missio.removePinnedWorkspace', async (node?: any) => {
      const config = vscode.workspace.getConfiguration('missio');
      const current = config.get<string[]>('pinnedWorkspacePaths', []);

      // If called from context menu with a specific path, remove it directly
      if (node?.entry?.folderPath) {
        const updated = current.filter((p: string) => p !== node.entry.folderPath);
        await config.update('pinnedWorkspacePaths', updated, vscode.ConfigurationTarget.Global);
        return;
      }

      if (current.length === 0) {
        vscode.window.showInformationMessage('No pinned workspaces to remove.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        current.map((p: string) => ({ label: path.basename(p), description: p, value: p })),
        { placeHolder: 'Select pinned workspaces to remove', canPickMany: true },
      );
      if (!pick || pick.length === 0) return;
      const toRemove = new Set(pick.map((p: any) => p.value));
      const updated = current.filter((p: string) => !toRemove.has(p));
      await config.update('pinnedWorkspacePaths', updated, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Removed ${pick.length} pinned workspace${pick.length > 1 ? 's' : ''}.`);
    }),

    vscode.commands.registerCommand('missio.refreshPinnedCollections', () => {
      void collectionService.refreshPinned().catch(err =>
        vscode.window.showErrorMessage(`Failed to refresh pinned collections: ${err instanceof Error ? err.message : String(err)}`),
      );
    }),

    vscode.commands.registerCommand('missio.openPinnedWorkspaceInNewWindow', async (node?: any) => {
      const filePath: string | undefined = node?.entry?.folderPath;
      if (!filePath) return;
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(filePath), true);
    }),

    vscode.commands.registerCommand('missio.validateCollection', async (nodeOrId?: any) => {
      const collection = await resolveCollection(nodeOrId, 'Select a collection to validate');
      if (!collection) return;

      const schemaPath = path.join(ctx.extensionContext.extensionPath, 'schema', 'opencollectionschema.json');
      const name = collection.data.info?.name ?? path.basename(collection.rootDir);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Validating "${name}"...`, cancellable: false },
        async () => {
          const report = await validateCollection(collection.rootDir, schemaPath);

          if (report.issues.length === 0) {
            vscode.window.showInformationMessage(
              `Collection "${name}" is valid — ${report.passCount} file${report.passCount === 1 ? '' : 's'} checked.`,
            );
            return;
          }

          const markdown = formatReport(report);
          const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
          await vscode.window.showTextDocument(doc, { preview: true });
        },
      );
    }),
  ];
}
