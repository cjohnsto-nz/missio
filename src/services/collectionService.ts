import * as vscode from 'vscode';
import * as path from 'path';
import { readCollectionFile, readWorkspaceFile, readRequestFile, isRequestFile } from './yamlParser';
import type { MissioCollection, OpenCollection, OpenCollectionWorkspace, HttpRequest, Item, Folder } from '../models/types';

export class CollectionService implements vscode.Disposable {
  private _collections: Map<string, MissioCollection> = new Map();
  private _workspaces: Map<string, OpenCollectionWorkspace> = new Map();
  private _watchers: vscode.FileSystemWatcher[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  async initialize(): Promise<void> {
    await this._scanWorkspaceFolders();
    this._setupWatchers();
  }

  getCollections(): MissioCollection[] {
    return Array.from(this._collections.values());
  }

  getCollection(id: string): MissioCollection | undefined {
    return this._collections.get(id);
  }

  getWorkspaces(): OpenCollectionWorkspace[] {
    return Array.from(this._workspaces.values());
  }

  async refresh(): Promise<void> {
    this._collections.clear();
    this._workspaces.clear();
    await this._scanWorkspaceFolders();
    this._onDidChange.fire();
  }

  async loadRequestFile(filePath: string): Promise<HttpRequest | undefined> {
    try {
      return await readRequestFile(filePath);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to parse request file: ${filePath}`);
      return undefined;
    }
  }

  /**
   * Resolve the items tree for a collection, reading individual YAML files
   * from the filesystem when `bundled` is false/absent.
   */
  async resolveItems(collection: MissioCollection): Promise<Item[]> {
    if (collection.data.bundled) {
      return collection.data.items ?? [];
    }
    return this._scanDirectoryForItems(collection.rootDir);
  }

  // ── Private ──────────────────────────────────────────────────────

  private async _scanWorkspaceFolders(): Promise<void> {
    const config = vscode.workspace.getConfiguration('missio');
    const collectionPatterns = config.get<string[]>('collectionFilePatterns', ['**/collection.yml', '**/collection.yaml']);
    const workspacePatterns = config.get<string[]>('workspaceFilePatterns', ['**/workspace.yml', '**/workspace.yaml']);

    // Find workspace files first (they may reference collections)
    for (const pattern of workspacePatterns) {
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
      for (const uri of files) {
        await this._loadWorkspaceFile(uri.fsPath);
      }
    }

    // Find collection files via glob patterns
    for (const pattern of collectionPatterns) {
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
      for (const uri of files) {
        await this._loadCollectionFile(uri.fsPath);
      }
    }

    // Also resolve collections referenced by workspace files
    for (const [wsPath, ws] of this._workspaces) {
      const wsDir = path.dirname(wsPath);
      for (const ref of ws.collections) {
        const collPath = path.resolve(wsDir, ref.path, 'collection.yml');
        const collPathAlt = path.resolve(wsDir, ref.path, 'collection.yaml');
        if (!this._collections.has(collPath) && !this._collections.has(collPathAlt)) {
          await this._loadCollectionFile(collPath).catch(() =>
            this._loadCollectionFile(collPathAlt).catch(() => { /* not found */ })
          );
        }
      }
    }
  }

  private async _loadCollectionFile(filePath: string): Promise<void> {
    try {
      const data = await readCollectionFile(filePath);
      const rootDir = path.dirname(filePath);
      const id = filePath;
      this._collections.set(id, { id, filePath, rootDir, data });
    } catch {
      // Ignore unreadable files
    }
  }

  private async _loadWorkspaceFile(filePath: string): Promise<void> {
    try {
      const data = await readWorkspaceFile(filePath);
      this._workspaces.set(filePath, data);
    } catch {
      // Ignore
    }
  }

  private async _scanDirectoryForItems(dir: string): Promise<Item[]> {
    const items: Item[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      for (const [name, type] of entries) {
        const fullPath = path.join(dir, name);
        if (type === vscode.FileType.Directory) {
          // Check if it has a folder.yml inside — otherwise treat as plain folder
          const folderItems = await this._scanDirectoryForItems(fullPath);
          if (folderItems.length > 0) {
            const folder: Folder = {
              info: { name, type: 'folder' },
              items: folderItems,
            };
            items.push(folder);
          }
        } else if (type === vscode.FileType.File && isRequestFile(name)) {
          try {
            const req = await readRequestFile(fullPath);
            if (req.info || req.http) {
              // Tag with the source path via extensions for runtime use
              (req as any)._filePath = fullPath;
              items.push(req);
            }
          } catch {
            // Skip unparseable files
          }
        }
      }
    } catch {
      // Directory unreadable
    }

    // Sort by seq if available
    items.sort((a, b) => {
      const seqA = (a as any).info?.seq ?? 999;
      const seqB = (b as any).info?.seq ?? 999;
      return seqA - seqB;
    });

    return items;
  }

  private _setupWatchers(): void {
    const collectionWatcher = vscode.workspace.createFileSystemWatcher('**/collection.{yml,yaml}');
    const workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/workspace.{yml,yaml}');
    const requestWatcher = vscode.workspace.createFileSystemWatcher('**/*.{yml,yaml}');

    const debounceRefresh = this._debounce(() => this.refresh(), 500);

    collectionWatcher.onDidChange(debounceRefresh);
    collectionWatcher.onDidCreate(debounceRefresh);
    collectionWatcher.onDidDelete(debounceRefresh);

    workspaceWatcher.onDidChange(debounceRefresh);
    workspaceWatcher.onDidCreate(debounceRefresh);
    workspaceWatcher.onDidDelete(debounceRefresh);

    requestWatcher.onDidChange(debounceRefresh);
    requestWatcher.onDidCreate(debounceRefresh);
    requestWatcher.onDidDelete(debounceRefresh);

    this._watchers.push(collectionWatcher, workspaceWatcher, requestWatcher);
  }

  private _debounce(fn: () => void, ms: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    return () => {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(fn, ms);
    };
  }

  dispose(): void {
    this._watchers.forEach(w => w.dispose());
    this._onDidChange.dispose();
  }
}
