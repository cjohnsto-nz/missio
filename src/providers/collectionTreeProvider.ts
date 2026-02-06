import * as vscode from 'vscode';
import * as path from 'path';
import type { CollectionService } from '../services/collectionService';
import type { MissioCollection, Item, HttpRequest, HttpRequestExample, Folder, FolderInfo, HttpRequestInfo } from '../models/types';

type TreeNode = CollectionNode | FolderNode | RequestNode | ExampleNode;

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
    this.command = {
      command: 'missio.openCollection',
      title: 'Configure Collection',
      arguments: [collection.id],
    };
  }
}

class FolderNode extends vscode.TreeItem {
  public readonly dirPath: string;
  constructor(
    public readonly folder: Folder,
    public readonly collectionId: string,
    dirPath: string,
    expanded: boolean,
  ) {
    super(
      folder.info?.name ?? 'Folder',
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.dirPath = dirPath;
    this.id = `folder:${dirPath}`;
    this.contextValue = 'folder';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = typeof folder.info?.description === 'string'
      ? folder.info.description
      : (folder.info?.description as any)?.content ?? '';
  }
}

class RequestNode extends vscode.TreeItem {
  constructor(
    public readonly request: HttpRequest,
    public readonly collectionId: string,
  ) {
    const name = request.info?.name ?? 'Unnamed Request';
    const hasExamples = (request.examples?.length ?? 0) > 0;
    super(name, hasExamples ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'httpRequest';
    this.description = request.http?.method?.toUpperCase() ?? '';
    this.tooltip = request.http?.url ?? '';

    // Color-code by method
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
      GET: 'charts.green',
      POST: 'charts.orange',
      PUT: 'charts.blue',
      PATCH: 'charts.purple',
      DELETE: 'charts.red',
      HEAD: 'terminal.ansiCyan',
      OPTIONS: 'terminal.ansiMagenta',
    };
    const iconName = methodIcons[method] ?? 'globe';
    const colorToken = methodColors[method];
    this.iconPath = colorToken
      ? new vscode.ThemeIcon(iconName, new vscode.ThemeColor(colorToken))
      : new vscode.ThemeIcon(iconName);

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

  readonly dropMimeTypes = [DRAG_MIME];
  readonly dragMimeTypes = [DRAG_MIME];

  constructor(private readonly _collectionService: CollectionService) {
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
      // Root: list all collections, sorted by name ascending
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
      const examples = element.request.examples ?? [];
      const filePath = (element.request as any)._filePath;
      return examples.map((ex, i) => new ExampleNode(ex, i, filePath, element.collectionId));
    }

    return [];
  }

  private _itemsToNodes(items: Item[], collectionId: string): TreeNode[] {
    return items.map(item => {
      if (this._isFolder(item)) {
        const folder = item as Folder;
        const dirPath = (folder as any)._dirPath ?? '';
        const id = `folder:${dirPath}`;
        const expanded = this._expandedIds.has(id);
        return new FolderNode(folder, collectionId, dirPath, expanded);
      }
      return new RequestNode(item as HttpRequest, collectionId);
    });
  }

  trackExpand(element: TreeNode): void {
    if (element.id) {
      this._expandedIds.add(element.id);
      this._collapsedIds.delete(element.id);
    }
  }

  trackCollapse(element: TreeNode): void {
    if (element.id) {
      this._expandedIds.delete(element.id);
      this._collapsedIds.add(element.id);
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

  private _isFolder(item: Item): item is Folder {
    return (item as Folder).info?.type === 'folder' ||
           (!!(item as Folder).items && !(item as HttpRequest).http);
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
