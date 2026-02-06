import * as vscode from 'vscode';
import * as path from 'path';
import type { CommandContext } from './types';
import type { HttpRequest, MissioCollection } from '../models/types';
import { RequestEditorProvider } from '../panels/requestPanel';
import { readRequestFile, stringifyYaml } from '../services/yamlParser';

export function registerRequestCommands(ctx: CommandContext): vscode.Disposable[] {
  const { collectionService, httpClient, responseProvider } = ctx;

  function findCollectionForFile(filePath: string): MissioCollection | undefined {
    const collections = collectionService.getCollections();
    const normalized = filePath.replace(/\\/g, '/');
    return collections.find(c => {
      const root = c.rootDir.replace(/\\/g, '/');
      return normalized.startsWith(root + '/') || normalized === root;
    });
  }

  return [
    vscode.commands.registerCommand('missio.sendRequest', async (filePathOrUri?: string) => {
      try {
        let filePath: string | undefined;

        if (typeof filePathOrUri === 'string') {
          filePath = filePathOrUri;
        } else {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            filePath = editor.document.uri.fsPath;
          } else {
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            const input = tab?.input;
            if (input && typeof input === 'object' && 'uri' in input) {
              filePath = (input as { uri: vscode.Uri }).uri.fsPath;
            }
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

    vscode.commands.registerCommand('missio.openRequest', async (filePath: string, _collectionId?: string) => {
      if (filePath) {
        await RequestEditorProvider.open(filePath);
      }
    }),

    vscode.commands.registerCommand('missio.loadExample', async (requestFilePath: string, _collectionId: string, exampleIndex: number) => {
      if (!requestFilePath) return;
      await RequestEditorProvider.open(requestFilePath);
      const request = await collectionService.loadRequestFile(requestFilePath);
      if (!request?.examples?.[exampleIndex]) return;
      const example = request.examples[exampleIndex];
      RequestEditorProvider.postMessageToPanel(requestFilePath, {
        type: 'loadExample',
        example,
      });
    }),

    vscode.commands.registerCommand('missio.cancelRequest', () => {
      httpClient.cancelAll();
      vscode.window.showInformationMessage('All active requests cancelled.');
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

        if (request.info) {
          request.info.name = newName;
        } else {
          request.info = { name: newName, type: 'http' };
        }
        const content = stringifyYaml(request, { lineWidth: 120 });
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf-8'));

        const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);
        const newFilePath = path.join(dir, slug + ext);

        if (newFilePath !== filePath) {
          const oldUri = vscode.Uri.file(filePath);
          const newUri = vscode.Uri.file(newFilePath);
          const edit = new vscode.WorkspaceEdit();
          edit.renameFile(oldUri, newUri);
          await vscode.workspace.applyEdit(edit);

          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
          await RequestEditorProvider.open(newFilePath);
        }

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

        if (request.info) {
          request.info.name = newName;
        } else {
          request.info = { name: newName, type: 'http' };
        }

        const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);
        let newFilePath = path.join(dir, slug + ext);

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
