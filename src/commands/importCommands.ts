import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import type { CommandContext } from './types';
import { importers, PostmanImporter, detectRequestFormat, requestImporters } from '../importers';
import { stringifyYaml } from '../services/yamlParser';
import { RequestEditorProvider } from '../panels/requestPanel';

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

      // Determine source: file or URL
      let sourceFile: string = '';
      let tempFile: string | undefined;

      if (formatPick.supportsUrl) {
        const sourcePick = await vscode.window.showQuickPick(
          [
            { label: 'From File', description: 'Select a local file', mode: 'file' as const },
            { label: 'From URL', description: 'Download from a URL', mode: 'url' as const },
          ],
          { placeHolder: `Import ${formatPick.label} specification` },
        );
        if (!sourcePick) return;

        if (sourcePick.mode === 'url') {
          const url = await vscode.window.showInputBox({
            prompt: `Enter the URL of the ${formatPick.label} specification`,
            placeHolder: 'https://example.com/openapi.json',
            validateInput: v => {
              if (!v.trim()) return 'URL is required';
              if (!v.startsWith('http://') && !v.startsWith('https://')) return 'Must be an HTTP or HTTPS URL';
              return null;
            },
          });
          if (!url) return;

          try {
            tempFile = await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Downloading ${formatPick.label} specification...` },
              () => downloadToTempFile(url.trim()),
            );
            sourceFile = tempFile;
          } catch (e: any) {
            vscode.window.showErrorMessage(`Download failed: ${e.message}`);
            return;
          }
        } else {
          const files = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: `Select ${formatPick.label} file`,
            filters: { [`${formatPick.label} files`]: formatPick.fileExtensions },
          });
          if (!files || files.length === 0) return;
          sourceFile = files[0].fsPath;
        }
      } else {
        const files = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: `Select ${formatPick.label} file`,
          filters: { [`${formatPick.label} files`]: formatPick.fileExtensions },
        });
        if (!files || files.length === 0) return;
        sourceFile = files[0].fsPath;
      }

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
          async () => {
            try {
              return await formatPick.import(sourceFile, targetDir);
            } finally {
              // Clean up temp file if we downloaded from URL
              if (tempFile) {
                try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
              }
            }
          },
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

    vscode.commands.registerCommand('missio.importRequest', async (node?: any) => {
      // Read clipboard
      const clipboard = await vscode.env.clipboard.readText();

      // Show input box pre-filled with clipboard content
      const text = await vscode.window.showInputBox({
        prompt: `Paste a request to import (${requestImporters.map(i => i.label).join(', ')})`,
        value: clipboard.trim().startsWith('curl') ? clipboard.trim() : '',
        ignoreFocusOut: true,
      });
      if (!text?.trim()) return;

      // Auto-detect format
      const importer = detectRequestFormat(text.trim());
      if (!importer) {
        vscode.window.showWarningMessage(
          `Could not detect format. Supported: ${requestImporters.map(i => i.label).join(', ')}`,
        );
        return;
      }

      // Parse
      let request;
      try {
        request = importer.parse(text.trim());
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to parse ${importer.label}: ${e.message}`);
        return;
      }

      // Determine target directory
      let targetDir: string | undefined;
      if (node?.dirPath) {
        targetDir = node.dirPath;
      } else if (node?.collection?.rootDir) {
        targetDir = node.collection.rootDir;
      } else {
        const collections = collectionService.getCollections();
        if (collections.length === 0) {
          vscode.window.showWarningMessage('No collections found. Create one first.');
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
        if (!collection) return;
        targetDir = collection.rootDir;
      }
      if (!targetDir) return;

      // Generate file name from request name
      const name = request.info?.name ?? 'imported-request';
      let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'request';
      let filePath = path.join(targetDir, `${slug}.yml`);

      // Avoid overwriting existing files
      let counter = 1;
      while (await fileExists(filePath)) {
        filePath = path.join(targetDir, `${slug}-${counter}.yml`);
        counter++;
      }

      const content = stringifyYaml(request, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf-8'));

      collectionService.refresh();
      await RequestEditorProvider.open(filePath);

      vscode.window.showInformationMessage(
        `Imported ${importer.label} request as "${path.basename(filePath)}".`,
      );
    }),
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

function downloadToTempFile(url: string, maxRedirects = 5): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'missio-import');
  fs.mkdirSync(tmpDir, { recursive: true });
  const ext = /\.ya?ml(\?|$)/i.test(url) ? '.yaml' : '.json';
  const tmpFile = path.join(tmpDir, `openapi-${Date.now()}${ext}`);

  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl: string, redirectsLeft: number) => {
      const mod = requestUrl.startsWith('https') ? https : http;
      const req = mod.get(requestUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const location = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, requestUrl).href;
          doRequest(location, redirectsLeft - 1);
          return;
        }
        if (!res.statusCode || res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          fs.writeFileSync(tmpFile, Buffer.concat(chunks));
          resolve(tmpFile);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Download timed out'));
      });
    };
    doRequest(url, maxRedirects);
  });
}
