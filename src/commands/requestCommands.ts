import * as vscode from 'vscode';
import * as path from 'path';
import type { CommandContext } from './types';
import type { MissioCollection, OpenCollectionRequest, RequestDefaults, WebSocketMessage, WebSocketRequest } from '../models/types';
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

  async function resolveRequestContext(filePathOrNode?: any): Promise<{
    filePath: string;
    request: OpenCollectionRequest;
    collection: MissioCollection;
    folderDefaults: RequestDefaults | undefined;
  } | undefined> {
    let filePath: string | undefined;

    if (typeof filePathOrNode === 'string') {
      filePath = filePathOrNode;
    } else if (filePathOrNode?.fsPath) {
      filePath = filePathOrNode.fsPath;
    } else if (filePathOrNode?.resourceUri?.fsPath) {
      filePath = filePathOrNode.resourceUri.fsPath;
    } else if (filePathOrNode?.request?._filePath) {
      filePath = filePathOrNode.request._filePath;
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
      return undefined;
    }

    const request = await readRequestFile(filePath);
    if (!isProtocolRequest(request)) {
      vscode.window.showWarningMessage('File does not contain an executable OpenCollection request.');
      return undefined;
    }

    const collection = findCollectionForFile(filePath);
    if (!collection) {
      vscode.window.showWarningMessage('Could not find a collection for this request file. Ensure a collection.yml exists in a parent directory.');
      return undefined;
    }

    return {
      filePath,
      request,
      collection,
      folderDefaults: await getFolderDefaults(filePath, collection),
    };
  }

  async function promptWebSocketVariables(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults: RequestDefaults | undefined,
  ): Promise<Map<string, string> | undefined> {
    return promptForUnresolvedVars(request, collection, ctx.environmentService, folderDefaults);
  }

  function selectedWebSocketMessage(request: WebSocketRequest): WebSocketMessage | undefined {
    const message = request.websocket?.message;
    if (!message) return undefined;
    if (!Array.isArray(message)) return message;
    const selected = message.find(variant => variant.selected) ?? message[0];
    return selected?.message;
  }

  async function connectWebSocketFromContext(filePathOrNode?: any): Promise<void> {
    const resolved = await resolveRequestContext(filePathOrNode);
    if (!resolved) return;
    const { filePath, request, collection, folderDefaults } = resolved;
    if (!isWebSocketRequest(request)) {
      vscode.window.showWarningMessage('The selected request is not a WebSocket request.');
      return;
    }

    const extraVariables = await promptWebSocketVariables(request, collection, folderDefaults);
    if (extraVariables === undefined) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Connecting WebSocket ${request.info?.name ?? path.basename(filePath)}`,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => requestExecutionService.disconnectWebSocket(filePath));
        const session = await requestExecutionService.connectWebSocket(
          request,
          collection,
          folderDefaults,
          message => progress.report({ message }),
          extraVariables.size > 0 ? extraVariables : undefined,
          undefined,
          { requestId: filePath, requestFilePath: filePath, requestName: request.info?.name },
        );
        RequestEditorProvider.postMessageToPanel(filePath, { type: 'webSocketSession', session });
        vscode.window.showInformationMessage(`Connected WebSocket: ${request.info?.name ?? path.basename(filePath)}`);
      },
    );
  }

  async function sendWebSocketMessageFromContext(filePathOrNode?: any): Promise<void> {
    const resolved = await resolveRequestContext(filePathOrNode);
    if (!resolved) return;
    const { filePath, request } = resolved;
    if (!isWebSocketRequest(request)) {
      vscode.window.showWarningMessage('The selected request is not a WebSocket request.');
      return;
    }
    try {
      const session = await requestExecutionService.sendWebSocketMessage(filePath, selectedWebSocketMessage(request));
      RequestEditorProvider.postMessageToPanel(filePath, { type: 'webSocketSession', session });
    } catch (error: any) {
      vscode.window.showErrorMessage(`WebSocket send failed: ${error.message ?? error}`);
    }
  }

  async function disconnectWebSocketFromContext(filePathOrNode?: any): Promise<void> {
    const directFilePath = typeof filePathOrNode === 'string'
      ? filePathOrNode
      : filePathOrNode?.resourceUri?.fsPath ?? filePathOrNode?.request?._filePath;
    const resolved = directFilePath ? undefined : await resolveRequestContext(filePathOrNode);
    const filePath = directFilePath ?? resolved?.filePath;
    if (!filePath) {
      vscode.window.showWarningMessage('No WebSocket request selected.');
      return;
    }
    const response = await requestExecutionService.disconnectWebSocketSession(filePath);
    const session = requestExecutionService.getWebSocketSession(filePath);
    if (session) RequestEditorProvider.postMessageToPanel(filePath, { type: 'webSocketSession', session });
    if (response) {
      await responseProvider.showResponse(response, session?.requestName);
    }
  }

  async function showWebSocketSessions(): Promise<void> {
    const sessions = requestExecutionService.listWebSocketSessions({ includeClosed: false });
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No active WebSocket sessions.');
      return;
    }

    const items = [
      { label: '$(close-all) Disconnect All WebSockets', action: 'disconnectAll' as const },
      ...sessions.flatMap(session => [
        {
          label: `$(go-to-file) Focus ${session.requestName ?? path.basename(session.requestFilePath ?? session.requestId)}`,
          description: session.state,
          detail: session.url,
          action: 'focus' as const,
          session,
        },
        {
          label: `$(debug-disconnect) Disconnect ${session.requestName ?? path.basename(session.requestFilePath ?? session.requestId)}`,
          description: session.state,
          detail: session.url,
          action: 'disconnect' as const,
          session,
        },
      ]),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Manage active WebSocket sessions' });
    if (!pick) return;
    if (pick.action === 'disconnectAll') {
      requestExecutionService.disconnectAllWebSocketSessions();
      vscode.window.showInformationMessage('Disconnected all WebSocket sessions.');
      return;
    }
    if (pick.action === 'focus' && pick.session?.requestFilePath) {
      await RequestEditorProvider.open(pick.session.requestFilePath);
      return;
    }
    if (pick.action === 'disconnect' && pick.session) {
      await requestExecutionService.disconnectWebSocketSession(pick.session.requestId);
    }
  }

  return [
    vscode.commands.registerCommand('missio.sendRequest', async (filePathOrUri?: any) => {
      try {
        const resolved = await resolveRequestContext(filePathOrUri);
        if (!resolved) return;
        const { filePath, request, collection, folderDefaults } = resolved;

        if (isWebSocketRequest(request)) {
          await connectWebSocketFromContext(filePath);
          return;
        }

        // Prompt for unresolved variables before sending
        let extraVariables: Map<string, string> | undefined;
        if (isHttpRequest(request) || isGraphQLRequest(request) || isGrpcRequest(request)) {
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

    vscode.commands.registerCommand('missio.connectWebSocket', connectWebSocketFromContext),
    vscode.commands.registerCommand('missio.sendWebSocketMessage', sendWebSocketMessageFromContext),
    vscode.commands.registerCommand('missio.disconnectWebSocket', disconnectWebSocketFromContext),
    vscode.commands.registerCommand('missio.showWebSocketSessions', showWebSocketSessions),
    vscode.commands.registerCommand('missio.disconnectAllWebSockets', () => {
      requestExecutionService.disconnectAllWebSocketSessions();
      vscode.window.showInformationMessage('Disconnected all WebSocket sessions.');
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
