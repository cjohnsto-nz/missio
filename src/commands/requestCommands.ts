import * as vscode from 'vscode';
import * as path from 'path';
import type { CommandContext } from './types';
import type { MissioCollection, OpenCollectionRequest, RequestDefaults } from '../models/types';
import { getItemKind, isGraphQLRequest, isGrpcRequest, isHttpRequest, isProtocolRequest, isWebSocketRequest } from '../models/types';
import { RequestEditorProvider } from '../panels/requestPanel';
import { readRequestFile, readFolderFile, stringifyYaml } from '../services/yamlParser';
import { promptForUnresolvedVars } from '../services/unresolvedVars';
import { createRequestTemplate, REQUEST_PROTOCOL_CHOICES, requestProtocolLabel, slugifyRequestName } from '../services/requestTemplates';

export function registerRequestCommands(ctx: CommandContext): vscode.Disposable[] {
  const { collectionService, httpClient, requestExecutionService, responseProvider } = ctx;

  function findCollectionForFile(filePath: string): MissioCollection | undefined {
    const collections = collectionService.getCollections();
    const normalized = filePath.replace(/\\/g, '/');
    return collections.find(c => {
      const root = c.rootDir.replace(/\\/g, '/');
      return normalized.startsWith(root + '/') || normalized === root;
    });
  }

  async function getFolderDefaults(filePath: string, collection: MissioCollection): Promise<RequestDefaults | undefined> {
    const dir = path.dirname(filePath);
    if (dir.toLowerCase() === collection.rootDir.toLowerCase()) return undefined;
    for (const name of ['folder.yml', 'folder.yaml']) {
      try {
        const folderData = await readFolderFile(path.join(dir, name));
        if (folderData?.request) return folderData.request;
        break;
      } catch { /* No folder.yml */ }
    }
    return undefined;
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
        if (!isProtocolRequest(request)) {
          vscode.window.showWarningMessage('File does not contain an executable OpenCollection request.');
          return;
        }

        const collection = findCollectionForFile(filePath);
        if (!collection) {
          vscode.window.showWarningMessage('Could not find a collection for this request file. Ensure a collection.yml exists in a parent directory.');
          return;
        }

        // Resolve folder defaults (auth, headers, variables) from folder.yml
        const folderDefaults = await getFolderDefaults(filePath, collection);

        // Prompt for unresolved variables before sending
        let extraVariables: Map<string, string> | undefined;
        if (isHttpRequest(request) || isGraphQLRequest(request) || isWebSocketRequest(request) || isGrpcRequest(request)) {
          extraVariables = await promptForUnresolvedVars(request, collection, ctx.environmentService, folderDefaults);
          if (extraVariables === undefined) return; // User cancelled
        }

        const protocolLabel = describeRequestForProgress(request);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Sending ${protocolLabel}`,
            cancellable: true,
          },
          async (_progress, token) => {
            token.onCancellationRequested(() => requestExecutionService.cancelAll());
            const response = await requestExecutionService.send(
              request,
              collection,
              folderDefaults,
              undefined,
              extraVariables && extraVariables.size > 0 ? extraVariables : undefined,
              undefined,
              undefined,
              { requestId: filePath },
            );
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
        if (!isHttpRequest(request) || !request.examples?.[exampleIndex]) return;
      const example = request.examples[exampleIndex];
      RequestEditorProvider.postMessageToPanel(requestFilePath, {
        type: 'loadExample',
        example,
        exampleName: example.name || `Example ${exampleIndex + 1}`,
      });
    }),

    vscode.commands.registerCommand('missio.cancelRequest', () => {
      requestExecutionService.cancelAll();
      vscode.window.showInformationMessage('All active requests cancelled.');
    }),

    vscode.commands.registerCommand('missio.newRequest', async (node?: any) => {
      // Derive target directory from tree node context
      let targetDir: string | undefined;
      if (node?.dirPath) {
        // Folder node
        targetDir = node.dirPath;
      } else if (node?.collection?.rootDir) {
        // Collection node
        targetDir = node.collection.rootDir;
      } else {
        // Fallback: pick a collection
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
        if (!collection) { return; }
        targetDir = collection.rootDir;
      }

      const protocolPick = await vscode.window.showQuickPick(
        REQUEST_PROTOCOL_CHOICES.map(choice => ({
          label: choice.label,
          description: choice.description,
          protocol: choice.protocol,
        })),
        { placeHolder: 'Select request type' },
      );
      if (!protocolPick) { return; }

      const protocolLabel = requestProtocolLabel(protocolPick.protocol);
      const name = await vscode.window.showInputBox({
        prompt: `${protocolLabel} request name`,
        placeHolder: protocolPick.protocol === 'graphql'
          ? 'graphql-health'
          : protocolPick.protocol === 'websocket'
            ? 'socket-echo'
            : protocolPick.protocol === 'grpc'
              ? 'echo-unary'
              : 'get-users',
      });
      if (!name) { return; }

      if (!targetDir) { return; }
      const slug = slugifyRequestName(name);
      const fileName = `${slug}.yml`;
      const filePath = path.join(targetDir, fileName);

      const template = createRequestTemplate(protocolPick.protocol, name);

      const content = stringifyYaml(template, { lineWidth: 120 });
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf-8'));

      // Open in the Missio request editor
      await RequestEditorProvider.open(filePath);
    }),

    vscode.commands.registerCommand('missio.renameRequest', async (node: any) => {
      const filePath = node?.resourceUri?.fsPath ?? node?.request?._filePath;
      if (!filePath) {
        vscode.window.showWarningMessage('No request file found.');
        return;
      }
      try {
        const request = await readRequestFile(filePath);
        if (!isHttpRequest(request)) {
          vscode.window.showWarningMessage('Only HTTP requests can be renamed from this command.');
          return;
        }
        const currentName = request.info?.name ?? path.basename(filePath, path.extname(filePath));
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
        if (!isHttpRequest(request)) {
          vscode.window.showWarningMessage('Only HTTP requests can be duplicated from this command.');
          return;
        }
        const currentName = request.info?.name ?? path.basename(filePath, path.extname(filePath));
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

function describeRequestForProgress(request: OpenCollectionRequest): string {
  if (isHttpRequest(request)) {
    return `${request.http?.method?.toUpperCase() ?? 'HTTP'} ${request.http?.url ?? request.info?.name ?? 'request'}`;
  }
  const kind = getItemKind(request);
  const labels: Record<string, string> = {
    graphql: 'GraphQL request',
    websocket: 'WebSocket request',
    grpc: 'gRPC request',
  };
  return `${labels[kind] ?? 'OpenCollection request'} ${request.info?.name ?? ''}`.trim();
}
