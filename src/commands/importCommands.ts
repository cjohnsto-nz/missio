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

        // Check if the imported collection is inside an existing workspace folder
        const collUri = vscode.Uri.file(result.collectionDir);
        const inWorkspace = !!vscode.workspace.getWorkspaceFolder(collUri);

        if (!inWorkspace) {
          const action = await vscode.window.showInformationMessage(
            `Imported "${path.basename(result.collectionDir)}": ${result.requestCount} requests, ${result.folderCount} folders.`,
            'Add to Workspace',
            'Open Folder',
          );
          if (action === 'Add to Workspace') {
            vscode.workspace.updateWorkspaceFolders(
              vscode.workspace.workspaceFolders?.length ?? 0, 0,
              { uri: collUri, name: path.basename(result.collectionDir) },
            );
          } else if (action === 'Open Folder') {
            await vscode.commands.executeCommand('revealFileInOS', collUri);
          }
        } else {
          vscode.window.showInformationMessage(
            `Imported "${path.basename(result.collectionDir)}": ${result.requestCount} requests, ${result.folderCount} folders.`,
          );
        }

        // Open the collection.yml
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.collectionFile));
        await vscode.window.showTextDocument(doc);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Import failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('missio.importEnvironment', async () => {
      const { environmentService } = ctx;

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

      // Pick environment file(s)
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: 'Select Postman environment file(s)',
        filters: { 'JSON files': ['json'] },
      });

      if (!files || files.length === 0) return;

      // Ask how to handle Postman secrets
      const secretPick = await vscode.window.showQuickPick(
        [
          { label: 'Store as plain variables', description: 'Secret values will be stored in the collection YAML (visible in source control)', mode: 'plain' as const },
          { label: 'Store in secure storage', description: 'Secret values will be stored in VS Code SecretStorage (not in YAML)', mode: 'secret' as const },
        ],
        { placeHolder: 'How should Postman secret variables be imported?' },
      );
      if (!secretPick) return;
      const secretMode = secretPick.mode;

      const importer = new PostmanImporter();
      let imported = 0;

      for (const file of files) {
        try {
          // Parse the environment file
          const parsed = importer.parseEnvironment(file.fsPath);
          const secretCount = parsed.variables.filter(v => v.isSecret).length;

          // Determine target environment name
          const existingEnvs = environmentService.getCollectionEnvironments(collection);
          const matchingEnv = existingEnvs.find(e => e.name === parsed.name);

          let targetName = parsed.name;
          if (matchingEnv) {
            // Existing environment with same name — ask user
            const action = await vscode.window.showQuickPick(
              [
                { label: `Update "${parsed.name}"`, description: 'Replace the existing environment with imported variables', action: 'update' as const },
                { label: 'Import as new environment', description: 'Create a new environment with a different name', action: 'new' as const },
              ],
              { placeHolder: `Environment "${parsed.name}" already exists` },
            );
            if (!action) continue;
            if (action.action === 'new') {
              const newName = await vscode.window.showInputBox({
                prompt: 'Enter name for the new environment',
                value: `${parsed.name} (imported)`,
                validateInput: (v) => v.trim() ? null : 'Name cannot be empty',
              });
              if (!newName) continue;
              targetName = newName.trim();
            }
          }

          // Write to collection YAML
          const result = importer.importEnvironment(
            collection.filePath, targetName, parsed.variables, secretMode,
          );

          // Store secrets in SecretStorage if needed
          for (const secret of result.secrets) {
            await environmentService.storeSecretValue(
              collection.rootDir, targetName, secret.name, secret.value,
            );
          }

          imported++;
          const parts = [`${result.variableCount} variables`];
          if (secretCount > 0) {
            parts.push(`${secretCount} secrets → ${secretMode === 'secret' ? 'secure storage' : 'plain text'}`);
          }
          vscode.window.showInformationMessage(
            `Imported environment "${targetName}" (${parts.join(', ')}).`,
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
