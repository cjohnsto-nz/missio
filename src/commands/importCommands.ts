import * as vscode from 'vscode';
import * as path from 'path';
import type { CommandContext } from './types';
import { importers, PostmanImporter } from '../importers';

export function registerImportCommands(ctx: CommandContext): vscode.Disposable[] {
  const { collectionService } = ctx;

  return [
    vscode.commands.registerCommand('missio.importCollection', async () => {
      // Pick format
      const formatPick = importers.length === 1
        ? importers[0]
        : await vscode.window.showQuickPick(
            importers.map(imp => ({
              label: imp.label,
              description: imp.description,
              importer: imp,
            })),
            { placeHolder: 'Select import format' },
          ).then(r => r?.importer);

      if (!formatPick) return;

      // Pick source file
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: `Select ${formatPick.label} file`,
        filters: { [`${formatPick.label} files`]: formatPick.fileExtensions },
      });

      if (!files || files.length === 0) return;
      const sourceFile = files[0].fsPath;

      // Pick target directory
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri: folders[0].uri,
        openLabel: 'Select destination folder',
      });
      if (!picked || picked.length === 0) return;
      const targetDir = picked[0].fsPath;

      // Run import
      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Importing ${formatPick.label} collection...`,
          },
          async () => formatPick.import(sourceFile, targetDir),
        );

        // Refresh collections tree
        collectionService.refresh();

        vscode.window.showInformationMessage(
          `Imported "${path.basename(result.collectionDir)}": ${result.requestCount} requests, ${result.folderCount} folders.`,
        );

        // Open the collection.yml
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.collectionFile));
        await vscode.window.showTextDocument(doc);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Import failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('missio.importEnvironment', async () => {
      // Find which collection to add the environment to
      const collections = collectionService.getCollections();
      if (collections.length === 0) {
        vscode.window.showWarningMessage('No collections found. Import a collection first.');
        return;
      }

      // Auto-detect from active tab or pick
      let collection;
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const tabInput = tab?.input;
      if (tabInput && typeof tabInput === 'object' && 'uri' in tabInput) {
        const filePath = (tabInput as { uri: vscode.Uri }).uri.fsPath.replace(/\\/g, '/');
        collection = collections.find(c => {
          const root = c.rootDir.replace(/\\/g, '/');
          return filePath.startsWith(root + '/') || filePath === root;
        });
      }

      if (!collection) {
        collection = collections.length === 1
          ? collections[0]
          : await vscode.window.showQuickPick(
              collections.map(c => ({
                label: c.data.info?.name ?? path.basename(c.rootDir),
                description: c.filePath,
                collection: c,
              })),
              { placeHolder: 'Select collection to add environment to' },
            ).then(r => r?.collection);
      }

      if (!collection) return;

      // Pick environment file (currently only Postman environments)
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: 'Select Postman environment file(s)',
        filters: { 'JSON files': ['json'] },
      });

      if (!files || files.length === 0) return;

      const importer = new PostmanImporter();
      let imported = 0;

      for (const file of files) {
        try {
          const result = await importer.importEnvironment(file.fsPath, collection.filePath);
          imported++;
          vscode.window.showInformationMessage(
            `Imported environment "${result.name}" (${result.variableCount} variables).`,
          );
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to import ${path.basename(file.fsPath)}: ${e.message}`);
        }
      }

      if (imported > 0) {
        collectionService.refresh();
      }
    }),
  ];
}
