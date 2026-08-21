import * as vscode from 'vscode';
import * as path from 'path';
import type { CollectionService } from '../services/collectionService';
import type { MissioCollection, Item, OpenCollectionRequest, HttpRequestExample, Folder, ScriptFile } from '../models/types';
import {
  getItemKind,
  isFolder as isOpenCollectionFolder,
  isGraphQLRequest,
  isGrpcRequest,
  isHttpRequest,
  isProtocolRequest,
  isScriptFile,
  isWebSocketRequest,
} from '../models/types';
import { describeGraphQLOperation } from '../services/graphqlSupport';

type TreeNode = CollectionNode | FolderNode | RequestNode | ScriptNode | ExampleNode;

const DRAG_MIME = 'application/vnd.code.tree.missio.collections';

class CollectionNode extends vscode.TreeItem {
  constructor(public readonly collection: MissioCollection, expanded: boolean) {
    super(
      collection.data.info?.name ?? path.basename(collection.rootDir),
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `collection:${collection.id}`;
    this.contextValue = 'collection';
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.tooltip = collection.data.info?.summary ?? collection.filePath;
    this.description = collection.data.opencollection ? `v${collection.data.opencollection}` : '';
  }
}

class FolderNode extends vscode.TreeItem {
  public readonly dirPath: string;
  public readonly stateId: string;
  constructor(
    public readonly folder: Folder,
    public readonly collectionId: string,
    dirPath: string,
    stateId: string,
    hasSubfolders: boolean,
    expanded: boolean,
    version: number,
  ) {
    super(
      folder.info?.name ?? 'Folder',
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.dirPath = dirPath;
    this.stateId = stateId;
    this.id = `${stateId}#${version}`;
    this.contextValue = hasSubfolders ? 'folderWithSubdirs' : 'folder';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = typeof folder.info?.description === 'string'
      ? folder.info.description
      : (folder.info?.description as any)?.content ?? '';
  }
}

class RequestNode extends vscode.TreeItem {
  constructor(
    public readonly request: OpenCollectionRequest,
    public readonly collectionId: string,
  ) {
    const name = request.info?.name ?? 'Unnamed Request';
    const hasExamples = isHttpRequest(request) && (request.examples?.length ?? 0) > 0;
    super(name, hasExamples ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const kind = getItemKind(request);
    this.contextValue = kind === 'http' ? 'httpRequest' : `${kind}Request`;
    this.description = describeRequest(request);
    this.tooltip = requestTooltip(request);

    if (isHttpRequest(request)) {
      const method = (request.http?.method ?? 'GET').toUpperCase();
      const methodIcons: Record<string, string> = {
        GET: 'arrow-down',
        POST: 'arrow-up',
        PUT: 'arrow-swap',
        PATCH: 'edit',
        DELETE: 'trash',
        HEAD: 'eye',
        OPTIONS: 'settings-gear',
      };
      const methodColors: Record<string, string> = {
        GET: 'missio.methodGet',
        POST: 'missio.methodPost',
        PUT: 'missio.methodPut',
        PATCH: 'missio.methodPatch',
        DELETE: 'missio.methodDelete',
        HEAD: 'missio.methodHead',
        OPTIONS: 'missio.methodOptions',
      };
      const iconName = methodIcons[method] ?? 'globe';
      const colorToken = methodColors[method];
      this.iconPath = colorToken
        ? new vscode.ThemeIcon(iconName, new vscode.ThemeColor(colorToken))
        : new vscode.ThemeIcon(iconName);
    } else {
      const protocolIcons: Record<string, string> = {
        graphql: 'type-hierarchy',
        websocket: 'plug',
        grpc: 'radio-tower',
      };
      this.iconPath = new vscode.ThemeIcon(protocolIcons[kind] ?? 'symbol-method');
    }

    // Open the YAML file when clicked
    const filePath = (request as any)._filePath;
    if (filePath) {
      this.command = {
        command: 'missio.openRequest',
        title: 'Open Request',
        arguments: [filePath, this.collectionId],
      };
      this.resourceUri = vscode.Uri.file(filePath);
    }
  }
}

class ScriptNode extends vscode.TreeItem {
  constructor(
    public readonly scriptFile: ScriptFile,
    public readonly collectionId: string,
  ) {
    super('Script', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'scriptFile';
    this.description = 'SCRIPT';
    this.iconPath = new vscode.ThemeIcon('code');

    const filePath = (scriptFile as any)._filePath;
    if (filePath) {
      this.command = {
        command: 'missio.openRequest',
        title: 'Open Script',
        arguments: [filePath, this.collectionId],
      };
      this.resourceUri = vscode.Uri.file(filePath);
      this.tooltip = filePath;
    }
  }
}

function describeRequest(request: OpenCollectionRequest): string {
  if (isHttpRequest(request)) {
    return request.http?.method?.toUpperCase() ?? 'HTTP';
  }
  if (isGraphQLRequest(request)) {
    return describeGraphQLOperation(request);
  }
  const kind = getItemKind(request);
  const labels: Record<string, string> = {
    graphql: 'GRAPHQL',
    websocket: 'WS',
    grpc: 'gRPC',
  };
  return labels[kind] ?? 'REQUEST';
}

function requestTooltip(request: OpenCollectionRequest): string {
  if (isHttpRequest(request)) {
    return request.http?.url ?? '';
  }
  if (isGraphQLRequest(request)) {
    return request.graphql?.url ?? '';
  }
  if (isWebSocketRequest(request)) {
    return request.websocket?.url ?? '';
  }
  if (isGrpcRequest(request)) {
    const url = request.grpc?.url ?? '';
    const method = request.grpc?.method ?? '';
    return [url, method].filter(Boolean).join(' ');
  }
  return '';
}

class ExampleNode extends vscode.TreeItem {
  constructor(
    public readonly example: HttpRequestExample,
    public readonly index: number,
    public readonly requestFilePath: string,
    public readonly collectionId: string,
  ) {
    const name = example.name ?? `Example ${index + 1}`;
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'httpExample';

    const status = example.response?.status;
    const statusCat = status ? Math.floor(status / 100) : 0;
    const statusIcons: Record<number, string> = {
      2: 'pass',
      3: 'arrow-right',
      4: 'warning',
      5: 'error',
    };
    this.iconPath = new vscode.ThemeIcon(statusIcons[statusCat] ?? 'bookmark');
    this.description = status ? `${status} ${example.response?.statusText ?? ''}` : '';
    this.tooltip = example.response?.body?.data
      ? `${name}\n${example.response.body.data.substring(0, 200)}`
      : name;
    this.command = {
      command: 'missio.loadExample',
      title: 'Load Example',
      arguments: [requestFilePath, collectionId, index],
    };
  }
}

export class CollectionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _disposables: vscode.Disposable[] = [];
  private _itemsCache: Map<string, Item[]> = new Map();
  private _expandedIds = new Set<string>();
  private _collapsedIds = new Set<string>();
  private _folderRenderVersions = new Map<string, number>();

  readonly dropMimeTypes = [DRAG_MIME];
  readonly dragMimeTypes = [DRAG_MIME];

  constructor(
    private readonly _collectionService: CollectionService,
  ) {
    this._disposables.push(
      this._collectionService.onDidChange(() => {
        this._itemsCache.clear();
        this._onDidChangeTreeData.fire(undefined);
      }),
    );
  }

  refresh(): void {
    this._itemsCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      // Root: list all collections for the active workspace, sorted by name ascending
      const collections = this._collectionService.getCollections()
        .sort((a, b) => {
          const nameA = (a.data.info?.name ?? path.basename(a.rootDir)).toLowerCase();
          const nameB = (b.data.info?.name ?? path.basename(b.rootDir)).toLowerCase();
          return nameA.localeCompare(nameB);
        });
      return collections.map(c => {
        const id = `collection:${c.id}`;
        // Default to expanded for collections (expanded unless explicitly collapsed)
        const expanded = this._expandedIds.has(id) || !this._collapsedIds.has(id);
        return new CollectionNode(c, expanded);
      });
    }

    if (element instanceof CollectionNode) {
      const collection = element.collection;
      let items = this._itemsCache.get(collection.id);
      if (!items) {
        items = await this._collectionService.resolveItems(collection);
        this._itemsCache.set(collection.id, items);
      }
      return this._itemsToNodes(items, collection.id);
    }

    if (element instanceof FolderNode) {
      const folder = element.folder;
      return this._itemsToNodes(folder.items ?? [], element.collectionId);
    }

    if (element instanceof RequestNode) {
      if (!isHttpRequest(element.request)) return [];
      const examples = element.request.examples ?? [];
      const filePath = (element.request as any)._filePath;
      return examples.map((ex, i) => new ExampleNode(ex, i, filePath, element.collectionId));
    }

    return [];
  }

  private _itemsToNodes(items: Item[], collectionId: string): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const item of items) {
      if (this._isFolder(item)) {
        const folder = item as Folder;
        const dirPath = (folder as any)._dirPath ?? '';
        const stateId = `folder:${dirPath}`;
        const hasSubfolders = (folder.items ?? []).some(child => this._isFolder(child));
        const expanded = this._expandedIds.has(stateId);
        const version = this._folderRenderVersions.get(stateId) ?? 0;
        nodes.push(new FolderNode(folder, collectionId, dirPath, stateId, hasSubfolders, expanded, version));
      } else if (isProtocolRequest(item)) {
        nodes.push(new RequestNode(item, collectionId));
      } else if (isScriptFile(item)) {
        nodes.push(new ScriptNode(item, collectionId));
      }
    }
    return nodes;
  }

  trackExpand(element: TreeNode): void {
    const id = this._getStateId(element);
    if (id) {
      this._expandedIds.add(id);
      this._collapsedIds.delete(id);
    }
  }

  trackCollapse(element: TreeNode): void {
    const id = this._getStateId(element);
    if (id) {
      this._expandedIds.delete(id);
      this._collapsedIds.add(id);
    }
  }

  updateExpandedPath(oldDir: string, newDir: string): void {
    const oldPrefix = `folder:${oldDir}`;
    const toAdd: string[] = [];
    for (const id of this._expandedIds) {
      if (id.startsWith(oldPrefix)) {
        this._expandedIds.delete(id);
        toAdd.push(`folder:${newDir}${id.substring(oldPrefix.length)}`);
      }
    }
    toAdd.forEach(id => this._expandedIds.add(id));
  }

  async setFirstLevelFoldersExpanded(collectionId: string, expanded: boolean): Promise<number> {
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) return 0;

    let items = this._itemsCache.get(collection.id);
    if (!items) {
      items = await this._collectionService.resolveItems(collection);
      this._itemsCache.set(collection.id, items);
    }

    let changed = 0;
    for (const item of items) {
      if (!this._isFolder(item)) continue;
      const dirPath = (item as any)._dirPath as string | undefined;
      if (!dirPath) continue;
      const id = `folder:${dirPath}`;
      let toggled = false;

      if (expanded) {
        if (!this._expandedIds.has(id)) {
          changed++;
          toggled = true;
        }
        this._expandedIds.add(id);
        this._collapsedIds.delete(id);
      } else {
        if (this._expandedIds.delete(id)) {
          changed++;
          toggled = true;
        }
        this._collapsedIds.add(id);
      }

      if (toggled) {
        this._folderRenderVersions.set(id, (this._folderRenderVersions.get(id) ?? 0) + 1);
      }
    }

    if (changed > 0) {
      this._onDidChangeTreeData.fire(undefined);
    }
    return changed;
  }

  async setFolderChildFoldersExpanded(collectionId: string, folderDirPath: string, expanded: boolean): Promise<number> {
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) return 0;

    let items = this._itemsCache.get(collection.id);
    if (!items) {
      items = await this._collectionService.resolveItems(collection);
      this._itemsCache.set(collection.id, items);
    }

    const folder = this._findFolderByDirPath(items, folderDirPath);
    if (!folder) return 0;

    let changed = 0;
    for (const child of folder.items ?? []) {
      if (!this._isFolder(child)) continue;
      const dirPath = (child as any)._dirPath as string | undefined;
      if (!dirPath) continue;
      const id = `folder:${dirPath}`;
      let toggled = false;

      if (expanded) {
        if (!this._expandedIds.has(id)) {
          changed++;
          toggled = true;
        }
        this._expandedIds.add(id);
        this._collapsedIds.delete(id);
      } else {
        if (this._expandedIds.delete(id)) {
          changed++;
          toggled = true;
        }
        this._collapsedIds.add(id);
      }

      if (toggled) {
        this._folderRenderVersions.set(id, (this._folderRenderVersions.get(id) ?? 0) + 1);
      }
    }

    if (changed > 0) {
      this._onDidChangeTreeData.fire(undefined);
    }
    return changed;
  }

  private _isFolder(item: Item): item is Folder {
    return isOpenCollectionFolder(item);
  }

  private _findFolderByDirPath(items: Item[], folderDirPath: string): Folder | undefined {
    for (const item of items) {
      if (!this._isFolder(item)) continue;
      const folder = item as Folder;
      const dirPath = (folder as any)._dirPath as string | undefined;
      if (dirPath === folderDirPath) {
        return folder;
      }
      const found = this._findFolderByDirPath(folder.items ?? [], folderDirPath);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private _getStateId(element: TreeNode): string | undefined {
    if (element instanceof FolderNode) {
      return element.stateId;
    }
    return element.id;
  }

  // ── Drag and Drop ──────────────────────────────

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    // Only allow dragging requests and folders
    const draggable = source.filter(n => n instanceof RequestNode || n instanceof FolderNode);
    if (draggable.length === 0) return;
    dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(draggable));
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(DRAG_MIME);
    if (!item) return;
    const sources: TreeNode[] = item.value;
    if (!sources || sources.length === 0) return;

    // Determine target directory
    let targetDir: string | undefined;
    if (target instanceof FolderNode) {
      targetDir = target.dirPath;
    } else if (target instanceof CollectionNode) {
      targetDir = target.collection.rootDir;
    } else if (target instanceof RequestNode) {
      // Drop on a request → move to same folder as that request
      const filePath = (target.request as any)._filePath;
      if (filePath) targetDir = path.dirname(filePath);
    }
    if (!targetDir) return;

    for (const node of sources) {
      if (node instanceof RequestNode) {
        const srcPath = (node.request as any)._filePath;
        if (!srcPath) continue;
        const fileName = path.basename(srcPath);
        const destPath = path.join(targetDir, fileName);
        if (srcPath === destPath) continue;
        try {
          const edit = new vscode.WorkspaceEdit();
          edit.renameFile(vscode.Uri.file(srcPath), vscode.Uri.file(destPath));
          await vscode.workspace.applyEdit(edit);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to move ${fileName}: ${e.message}`);
        }
      } else if (node instanceof FolderNode) {
        const srcDir = node.dirPath;
        if (!srcDir) continue;
        const folderName = path.basename(srcDir);
        const destDir = path.join(targetDir, folderName);
        if (srcDir === destDir) continue;
        try {
          const edit = new vscode.WorkspaceEdit();
          edit.renameFile(vscode.Uri.file(srcDir), vscode.Uri.file(destDir));
          await vscode.workspace.applyEdit(edit);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to move ${folderName}: ${e.message}`);
        }
      }
    }
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
