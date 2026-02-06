import * as vscode from 'vscode';
import * as path from 'path';
import type { CollectionService } from '../services/collectionService';
import type { MissioCollection, Item, HttpRequest, Folder, FolderInfo, HttpRequestInfo } from '../models/types';

type TreeNode = CollectionNode | FolderNode | RequestNode;

class CollectionNode extends vscode.TreeItem {
  constructor(public readonly collection: MissioCollection) {
    super(
      collection.data.info?.name ?? path.basename(collection.rootDir),
      vscode.TreeItemCollapsibleState.Expanded,
    );
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
  constructor(
    public readonly folder: Folder,
    public readonly collectionId: string,
  ) {
    super(
      folder.info?.name ?? 'Folder',
      vscode.TreeItemCollapsibleState.Collapsed,
    );
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
    super(name, vscode.TreeItemCollapsibleState.None);
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
    this.iconPath = new vscode.ThemeIcon(methodIcons[method] ?? 'globe');

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

export class CollectionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _disposables: vscode.Disposable[] = [];
  private _itemsCache: Map<string, Item[]> = new Map();

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
      // Root: list all collections
      const collections = this._collectionService.getCollections();
      return collections.map(c => new CollectionNode(c));
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

    return [];
  }

  private _itemsToNodes(items: Item[], collectionId: string): TreeNode[] {
    return items.map(item => {
      if (this._isFolder(item)) {
        return new FolderNode(item as Folder, collectionId);
      }
      return new RequestNode(item as HttpRequest, collectionId);
    });
  }

  private _isFolder(item: Item): item is Folder {
    return (item as Folder).info?.type === 'folder' ||
           (!!(item as Folder).items && !(item as HttpRequest).http);
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
