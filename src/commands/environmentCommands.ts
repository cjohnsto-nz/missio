import * as vscode from 'vscode';
import * as path from 'path';
import type { CommandContext } from './types';
import { CollectionPanel } from '../panels/collectionPanel';
import { stringifyYaml } from '../services/yamlParser';

export function registerEnvironmentCommands(ctx: CommandContext): vscode.Disposable[] {
  const { collectionService, environmentService, extensionContext } = ctx;

  return [
    vscode.commands.registerCommand('missio.selectEnvironment', async (collectionId?: string, envName?: string) => {
      if (collectionId && envName) {
        await environmentService.setActiveEnvironment(collectionId, envName);
        vscode.window.showInformationMessage(`Environment set to: ${envName}`);
        return;
      }

      const collections = collectionService.getCollections();
      if (collections.length === 0) {
        vscode.window.showWarningMessage('No collections found.');
        return;
      }

      // Auto-detect collection from the active editor tab
      let collPick = undefined;
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const tabInput = tab?.input;
      if (tabInput && typeof tabInput === 'object' && 'uri' in tabInput) {
        const filePath = (tabInput as { uri: vscode.Uri }).uri.fsPath;
        const normalized = filePath.replace(/\\/g, '/');
        collPick = collections.find(c => {
          const root = c.rootDir.replace(/\\/g, '/');
          return normalized.startsWith(root + '/') || normalized === root;
        });
      }

      // Fall back to picker only if we couldn't detect from the active tab
      if (!collPick) {
        collPick = collections.length === 1
          ? collections[0]
          : await vscode.window.showQuickPick(
              collections.map(c => ({
                label: c.data.info?.name ?? path.basename(c.rootDir),
                description: c.filePath,
                collection: c,
              })),
              { placeHolder: 'Select a collection' },
            ).then(r => r?.collection);
      }

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
        await CollectionPanel.open(collection, collectionService, extensionContext.extensionUri);
      }
    }),

    vscode.commands.registerCommand('missio.configureSecrets', async () => {
      const options = ['Azure Key Vault', 'Keeper Secrets Manager'];
      const pick = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select a secret provider to configure',
      });

      if (pick) {
        const key = pick === 'Azure Key Vault'
          ? 'missio.secretProviders.azureKeyVault'
          : 'missio.secretProviders.keeper';
        await vscode.commands.executeCommand('workbench.action.openSettings', key);
      }
    }),
  ];
}
