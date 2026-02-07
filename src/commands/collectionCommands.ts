import * as vscode from 'vscode';
import * as path from 'path';
import type { CommandContext } from './types';
import type { OpenCollection } from '../models/types';
import { CollectionEditorProvider } from '../panels/collectionPanel';
import { stringifyYaml } from '../services/yamlParser';

export function registerCollectionCommands(ctx: CommandContext): vscode.Disposable[] {
  const { collectionService } = ctx;
  const revealCollectionInExplorer = async (nodeOrId?: any): Promise<void> => {
    const collectionId = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId?.collection?.id;
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
            description: c.rootDir,
            collection: c,
          })),
          { placeHolder: 'Select a collection to reveal in Explorer' },
        );
        collection = pick?.collection;
      }
    }
    if (!collection) return;

    const target = vscode.Uri.file(collection.rootDir);
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', target);
  };

  return [
    vscode.commands.registerCommand('missio.refreshCollections', () => {
      collectionService.refresh();
    }),

    vscode.commands.registerCommand('missio.openCollection', async (nodeOrId?: any) => {
      const collectionId = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId?.collection?.id;
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

      await CollectionEditorProvider.open(collFile.fsPath);
      vscode.window.showInformationMessage(`Collection "${name}" created.`);
    }),

    vscode.commands.registerCommand('missio.showCollectionInExplorer', revealCollectionInExplorer),
    vscode.commands.registerCommand('missio.showCollectionInFinder', revealCollectionInExplorer),
  ];
}
