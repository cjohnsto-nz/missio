import * as vscode from 'vscode';
import * as path from 'path';
import { readCollectionFile, readWorkspaceFile, readRequestFile, readFolderFile, isRequestFile } from './yamlParser';
import type { MissioCollection, OpenCollectionWorkspace, HttpRequest, Item, Folder } from '../models/types';

export class CollectionService implements vscode.Disposable {
  private _collections: Map<string, MissioCollection> = new Map();
  private _workspaces: Map<string, OpenCollectionWorkspace> = new Map();
  private _watchers: vscode.FileSystemWatcher[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _pollTimer: NodeJS.Timeout | undefined;
  private _lastFingerprint = '';
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;
  private static readonly POLL_INTERVAL = 5_000; // 5s

  async initialize(): Promise<void> {
    await this._scanWorkspaceFolders();
    this._lastFingerprint = await this._computeFingerprint();
    this._setupWatchers();
    this._startPolling();
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
    this._lastFingerprint = await this._computeFingerprint();
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
          const folderItems = await this._scanDirectoryForItems(fullPath);
          const folder: Folder = {
            info: { name, type: 'folder' },
            items: folderItems,
          };
          // Try to read folder.yml for request defaults (auth, headers, variables)
          for (const folderFileName of ['folder.yml', 'folder.yaml']) {
            const folderFilePath = path.join(fullPath, folderFileName);
            try {
              const folderData = await readFolderFile(folderFilePath);
              if (folderData) {
                if (folderData.info) Object.assign(folder.info!, folderData.info);
                if (folderData.request) folder.request = folderData.request;
                if (folderData.docs) folder.docs = folderData.docs;
              }
              break;
            } catch {
              // No folder.yml — that's fine
            }
          }
          // Tag with the actual directory path for tree operations
          (folder as any)._dirPath = fullPath;
          items.push(folder);
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

    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => debounceRefresh()),
      vscode.workspace.onDidRenameFiles(() => debounceRefresh()),
      vscode.workspace.onDidCreateFiles(() => debounceRefresh()),
      vscode.workspace.onDidDeleteFiles(() => debounceRefresh()),
    );
  }

  private _startPolling(): void {
    const tick = async () => {
      try {
        const fingerprint = await this._computeFingerprint();
        if (fingerprint !== this._lastFingerprint) {
          this._lastFingerprint = fingerprint;
          await this.refresh();
        }
      } catch {
        // Swallow — transient FS errors shouldn't crash the poll loop
      }
      this._pollTimer = setTimeout(tick, CollectionService.POLL_INTERVAL);
    };
    this._pollTimer = setTimeout(tick, CollectionService.POLL_INTERVAL);
  }

  /** Build a lightweight fingerprint from yml file paths + mtimes to detect external changes. */
  private async _computeFingerprint(): Promise<string> {
    const files = await vscode.workspace.findFiles('**/*.{yml,yaml}', '**/node_modules/**');
    const parts: string[] = [];
    for (const uri of files) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        parts.push(`${uri.fsPath}:${stat.mtime}`);
      } catch { /* deleted between find and stat */ }
    }
    parts.sort();
    return parts.join('\n');
  }

  private _debounce(fn: () => void, ms: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    return () => {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(fn, ms);
    };
  }

  dispose(): void {
    if (this._pollTimer) { clearTimeout(this._pollTimer); }
    this._watchers.forEach(w => w.dispose());
    this._disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}
