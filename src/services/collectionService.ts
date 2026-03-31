import * as vscode from 'vscode';
import * as path from 'path';
import { readCollectionFile, readWorkspaceFile, readRequestFile, readFolderFile, isRequestFile, getPendingMigrations, persistPendingMigrations, clearPendingMigrations } from './yamlParser';
import type { MissioCollection, OpenCollectionWorkspace, HttpRequest, Item, Folder } from '../models/types';

const _log = vscode.window.createOutputChannel('Missio');

export interface WorkspaceEntry {
  key: string | null; // null = current VS Code workspace
  label: string;
  folderPath: string | null;
  error?: string;
}

export class CollectionService implements vscode.Disposable {
  private _collections: Map<string, MissioCollection> = new Map();
  private _workspaces: Map<string, OpenCollectionWorkspace> = new Map();
  private _activePinnedCollections: Map<string, MissioCollection> = new Map();
  private _pinnedFailedPaths: Set<string> = new Set();
  private _activeWorkspaceKey: string | null = null;
  private _loadToken = 0; // incremented on each load to detect stale concurrent loads
  private _pinnedWatchers: vscode.FileSystemWatcher[] = [];
  private _watchers: vscode.FileSystemWatcher[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _pollTimer: NodeJS.Timeout | undefined;
  private _lastFingerprint = '';
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;
  private static readonly POLL_INTERVAL = 5_000; // 5s

  async initialize(): Promise<void> {
    const t0 = performance.now();
    await this._scanWorkspaceFolders();
    const t1 = performance.now();
    // Active workspace is null (current VS Code workspace) on startup — no pinned path to load
    this._lastFingerprint = this._computeFingerprintFromCollections();
    this._setupWatchers();
    this._startPolling();
    this._onDidChange.fire();
    _log.appendLine(`initialize: scanWorkspaceFolders=${(t1 - t0).toFixed(1)}ms, total=${(performance.now() - t0).toFixed(1)}ms, collections=${this._collections.size}, workspaces=${this._workspaces.size}`);
  }

  getCollections(): MissioCollection[] {
    if (this._activeWorkspaceKey === null) {
      return Array.from(this._collections.values());
    }
    return Array.from(this._activePinnedCollections.values());
  }

  getPinnedCollections(): MissioCollection[] {
    return Array.from(this._activePinnedCollections.values());
  }

  getActiveWorkspaceKey(): string | null {
    return this._activeWorkspaceKey;
  }

  setActiveWorkspace(key: string | null): void {
    this._activeWorkspaceKey = key;
    // Clear stale collections immediately so getCollections() doesn't return the previous
    // workspace's data while the async load for the new key is in flight.
    this._activePinnedCollections = new Map();
    this._pinnedFailedPaths = new Set();
    // Fire immediately so the UI responds, then load the pinned workspace in the background
    this._onDidChange.fire();
    void this._loadActivePinnedWorkspace()
      .then(() => this._onDidChange.fire())
      .catch(err => _log.appendLine(`[pinned] setActiveWorkspace load failed: ${String(err)}`));
  }

  getWorkspaceEntries(): WorkspaceEntry[] {
    const config = vscode.workspace.getConfiguration('missio');
    const pinnedPaths = config.get<string[]>('pinnedWorkspacePaths', []);
    const wsName = vscode.workspace.name ?? 'Editor Workspace';
    const currentWsFile = vscode.workspace.workspaceFile?.fsPath;
    const normCurrent = currentWsFile ? path.normalize(currentWsFile).toLowerCase() : null;
    return [
      { key: null, label: wsName, folderPath: null },
      ...pinnedPaths
        .filter(p => {
          if (!normCurrent) return true;
          return path.normalize(p).toLowerCase() !== normCurrent;
        })
        .map(p => ({
          key: p,
          label: path.basename(p, path.extname(p)),
          folderPath: p,
          error: this._pinnedFailedPaths.has(p) ? `Path not found or inaccessible: ${p}` : undefined,
        })),
    ];
  }

  getCollection(id: string): MissioCollection | undefined {
    // Exact match in workspace collections first, then active pinned
    let result = this._collections.get(id);
    if (result) return result;
    result = this._activePinnedCollections.get(id);
    if (result) return result;

    // Normalize path separators and try case-insensitive match
    const norm = path.normalize(id).toLowerCase();
    for (const [key, val] of this._collections) {
      if (path.normalize(key).toLowerCase() === norm) return val;
    }
    for (const [key, val] of this._activePinnedCollections) {
      if (path.normalize(key).toLowerCase() === norm) return val;
    }
    return undefined;
  }

  getPinnedCollection(id: string): MissioCollection | undefined {
    const norm = path.normalize(id).toLowerCase();
    const c = this._activePinnedCollections.get(id);
    if (c) return c;
    for (const [key, val] of this._activePinnedCollections) {
      if (path.normalize(key).toLowerCase() === norm) return val;
    }
    return undefined;
  }

  /**
   * Resolve a collection by optional ID with single-collection auto-selection.
   * If id is provided, performs a path-normalized lookup across workspace and pinned.
   * If id is omitted and exactly one collection is loaded, returns it.
   * Used by Copilot tools where collectionId may be omitted.
   */
  resolveCollection(id?: string): MissioCollection | undefined {
    if (id) return this.getCollection(id);
    const all = this.getCollections();
    return all.length === 1 ? all[0] : undefined;
  }

  getWorkspaces(): OpenCollectionWorkspace[] {
    return Array.from(this._workspaces.values());
  }

  async refresh(): Promise<void> {
    this._collections.clear();
    this._workspaces.clear();
    await this._scanWorkspaceFolders();
    this._lastFingerprint = this._computeFingerprintFromCollections();
    this._onDidChange.fire();
  }

  async refreshPinned(): Promise<void> {
    await this._loadActivePinnedWorkspace();
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
    const items = await this._scanDirectoryForItems(collection.rootDir);
    this._debouncedMigrationPrompt();
    return items;
  }

  // ── Private ──────────────────────────────────────────────────────

  private async _scanWorkspaceFolders(): Promise<void> {
    const t0 = performance.now();
    const config = vscode.workspace.getConfiguration('missio');
    const collectionPatterns = config.get<string[]>('collectionFilePatterns', ['**/opencollection.yml', '**/opencollection.yaml', '**/collection.yml', '**/collection.yaml']);
    const workspacePatterns = config.get<string[]>('workspaceFilePatterns', ['**/workspace.yml', '**/workspace.yaml']);

    // Find workspace files first (they may reference collections)
    for (const pattern of workspacePatterns) {
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
      for (const uri of files) {
        await this._loadWorkspaceFile(uri.fsPath);
      }
    }
    const t1 = performance.now();

    // Find collection files via glob patterns
    for (const pattern of collectionPatterns) {
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
      for (const uri of files) {
        await this._loadCollectionFile(uri.fsPath);
      }
    }
    const t2 = performance.now();

    // Also resolve collections referenced by workspace files
    for (const [wsPath, ws] of this._workspaces) {
      const wsDir = path.dirname(wsPath);
      for (const ref of ws.collections) {
        const candidates = [
          path.resolve(wsDir, ref.path, 'opencollection.yml'),
          path.resolve(wsDir, ref.path, 'opencollection.yaml'),
          path.resolve(wsDir, ref.path, 'collection.yml'),
          path.resolve(wsDir, ref.path, 'collection.yaml'),
        ];
        const alreadyLoaded = candidates.some(c => this._collections.has(c));
        if (!alreadyLoaded) {
          for (const candidate of candidates) {
            try { await this._loadCollectionFile(candidate); break; } catch { /* try next */ }
          }
        }
      }
    }
    const t3 = performance.now();
    _log.appendLine(`_scanWorkspaceFolders: findWorkspaces=${(t1 - t0).toFixed(1)}ms, findCollections=${(t2 - t1).toFixed(1)}ms, resolveWsRefs=${(t3 - t2).toFixed(1)}ms`);
  }

  private async _loadActivePinnedWorkspace(): Promise<void> {
    const token = ++this._loadToken; // capture token; bail if superseded

    // Reset active key if it's been removed from config (e.g. via removePinnedWorkspace)
    if (this._activeWorkspaceKey !== null) {
      const config = vscode.workspace.getConfiguration('missio');
      const rawPaths = config.get<string[]>('pinnedWorkspacePaths', []);
      if (!rawPaths.includes(this._activeWorkspaceKey)) {
        this._activeWorkspaceKey = null;
      }
    }

    const rawPath = this._activeWorkspaceKey;
    if (rawPath === null) {
      if (token !== this._loadToken) return;
      this._activePinnedCollections.clear();
      this._pinnedFailedPaths.clear();
      this._setupPinnedWatchers(null);
      return;
    }

    const expanded = this._expandHome(rawPath);

    let statResult: vscode.FileStat;
    try {
      statResult = await vscode.workspace.fs.stat(vscode.Uri.file(expanded));
    } catch {
      if (token !== this._loadToken) return;
      _log.appendLine(`[pinned] Path not found or inaccessible: ${expanded}`);
      this._activePinnedCollections.clear();
      this._pinnedFailedPaths.clear();
      this._pinnedFailedPaths.add(rawPath);
      this._setupPinnedWatchers(null);
      return;
    }

    const newCollections = new Map<string, MissioCollection>();
    const isFile = (statResult.type & vscode.FileType.File) !== 0;

    if (isFile) {
      // Pinned path is a specific workspace file (.code-workspace or workspace.yml)
      const pinnedWorkspaces = new Map<string, OpenCollectionWorkspace>();
      const ext = path.extname(expanded).toLowerCase();
      if (ext === '.code-workspace') {
        const refs = await this._parseCodeWorkspaceFolders(expanded);
        if (refs.length) {
          pinnedWorkspaces.set(expanded, { collections: refs });
        }
      } else if (ext === '.yml' || ext === '.yaml') {
        try {
          const data = await readWorkspaceFile(expanded);
          pinnedWorkspaces.set(expanded, data);
        } catch { /* ignore */ }
      }
      for (const [wsPath, ws] of pinnedWorkspaces) {
        const wsDir = path.dirname(wsPath);
        for (const ref of ws.collections) {
          const resolvedDir = path.resolve(wsDir, ref.path);
          const candidates = [
            path.join(resolvedDir, 'opencollection.yml'),
            path.join(resolvedDir, 'opencollection.yaml'),
            path.join(resolvedDir, 'collection.yml'),
            path.join(resolvedDir, 'collection.yaml'),
          ];
          // Try the folder root first as a single collection
          let loaded = false;
          for (const candidate of candidates) {
            if (await this._loadPinnedCollectionFile(candidate, newCollections)) { loaded = true; break; }
          }
          // If no root-level collection file, walk the folder for nested collections
          if (!loaded) {
            const collectionFileNames = new Set(['opencollection.yml', 'opencollection.yaml', 'collection.yml', 'collection.yaml']);
            const uris: vscode.Uri[] = [];
            await this._walkDir(vscode.Uri.file(resolvedDir), collectionFileNames, uris);
            for (const uri of uris) {
              await this._loadPinnedCollectionFile(uri.fsPath, newCollections);
            }
          }
        }
      }
    } else {
      // Pinned path is a directory — walk it for workspace/collection files
      const collectionFileNames = new Set(['opencollection.yml', 'opencollection.yaml', 'collection.yml', 'collection.yaml']);
      const workspaceFileNames = new Set(['workspace.yml', 'workspace.yaml']);
      const rootUri = vscode.Uri.file(expanded);

      // Use fs.readDirectory walk instead of findFiles — findFiles only searches within
      // the open VS Code workspace folders, missing pinned paths outside the workspace.
      const pinnedWorkspaces = new Map<string, OpenCollectionWorkspace>();
      const workspaceUris: vscode.Uri[] = [];
      await this._walkDir(rootUri, workspaceFileNames, workspaceUris);
      for (const uri of workspaceUris) {
        try {
          const data = await readWorkspaceFile(uri.fsPath);
          pinnedWorkspaces.set(uri.fsPath, data);
        } catch { /* ignore */ }
      }

      // Also discover .code-workspace files and treat their folder list as
      // additional collection folder references (like workspace.yml but read-only).
      const codeWorkspaceUris: vscode.Uri[] = [];
      await this._findCodeWorkspaces(rootUri, codeWorkspaceUris);
      for (const codeWsUri of codeWorkspaceUris) {
        const refs = await this._parseCodeWorkspaceFolders(codeWsUri.fsPath);
        if (refs.length) {
          pinnedWorkspaces.set(codeWsUri.fsPath, { collections: refs });
        }
      }

      const collectionUris: vscode.Uri[] = [];
      await this._walkDir(rootUri, collectionFileNames, collectionUris);
      for (const uri of collectionUris) {
        await this._loadPinnedCollectionFile(uri.fsPath, newCollections);
      }

      for (const [wsPath, ws] of pinnedWorkspaces) {
        const wsDir = path.dirname(wsPath);
        for (const ref of ws.collections) {
          const resolvedDir = path.resolve(wsDir, ref.path);
          const candidates = [
            path.join(resolvedDir, 'opencollection.yml'),
            path.join(resolvedDir, 'opencollection.yaml'),
            path.join(resolvedDir, 'collection.yml'),
            path.join(resolvedDir, 'collection.yaml'),
          ];
          const alreadyLoaded = candidates.some(c => newCollections.has(c));
          if (!alreadyLoaded) {
            let loaded = false;
            for (const candidate of candidates) {
              if (await this._loadPinnedCollectionFile(candidate, newCollections)) { loaded = true; break; }
            }
            // If no root-level collection file, walk the folder for nested collections
            if (!loaded) {
              const collectionFileNames = new Set(['opencollection.yml', 'opencollection.yaml', 'collection.yml', 'collection.yaml']);
              const uris: vscode.Uri[] = [];
              await this._walkDir(vscode.Uri.file(resolvedDir), collectionFileNames, uris);
              for (const uri of uris) {
                await this._loadPinnedCollectionFile(uri.fsPath, newCollections);
              }
            }
          }
        }
      }
    }

    // Bail if another load started while we were awaiting
    if (token !== this._loadToken) return;

    this._activePinnedCollections = newCollections;
    this._pinnedFailedPaths = new Set();
    this._setupPinnedWatchers(rawPath);
    _log.appendLine(`[pinned] Loaded ${newCollections.size} collections from: ${expanded}`);
  }

  private async _loadPinnedCollectionFile(filePath: string, pathMap: Map<string, MissioCollection>): Promise<boolean> {
    try {
      const data = await readCollectionFile(filePath);
      const rootDir = path.dirname(filePath);
      pathMap.set(filePath, { id: filePath, filePath, rootDir, data });
      return true;
    } catch {
      return false;
    }
  }

  private async _walkDir(dir: vscode.Uri, fileNames: Set<string>, results: vscode.Uri[]): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return; // unreadable — skip
    }
    for (const [name, type] of entries) {
      // Use bitwise checks: FileType is a bitmask (e.g. SymbolicLink|Directory),
      // so strict equality misses symlinked folders/files.
      if ((type & vscode.FileType.Directory) !== 0) {
        if (name === 'node_modules' || name === '.git') continue;
        await this._walkDir(vscode.Uri.joinPath(dir, name), fileNames, results);
      } else if ((type & vscode.FileType.File) !== 0 && fileNames.has(name)) {
        results.push(vscode.Uri.joinPath(dir, name));
      }
    }
  }

  private async _findCodeWorkspaces(dir: vscode.Uri, results: vscode.Uri[]): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.Directory) !== 0) {
        if (name === 'node_modules' || name === '.git') continue;
        await this._findCodeWorkspaces(vscode.Uri.joinPath(dir, name), results);
      } else if ((type & vscode.FileType.File) !== 0 && name.endsWith('.code-workspace')) {
        results.push(vscode.Uri.joinPath(dir, name));
      }
    }
  }

  private async _parseCodeWorkspaceFolders(codeWsPath: string): Promise<{ name: string; path: string }[]> {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(codeWsPath));
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
      const folders: { path: string; name?: string }[] = parsed?.folders ?? [];
      const codeWsDir = path.dirname(codeWsPath);
      return folders.map(f => ({
        name: f.name ?? path.basename(path.resolve(codeWsDir, f.path)),
        path: f.path,
      }));
    } catch {
      _log.appendLine(`[pinned] Could not parse .code-workspace: ${codeWsPath}`);
      return [];
    }
  }

  private _expandHome(p: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (p === '~') return home;
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
    return p;
  }

  private _setupPinnedWatchers(rawPath: string | null): void {
    for (const w of this._pinnedWatchers) w.dispose();
    this._pinnedWatchers = [];

    if (!rawPath) return;
    const expanded = this._expandHome(rawPath);
    // When the pinned path is a file, watch its parent directory
    const ext = path.extname(expanded).toLowerCase();
    const watchBase = (ext === '.code-workspace' || ext === '.yml' || ext === '.yaml')
      ? path.dirname(expanded)
      : expanded;
    const debounceRefreshPinned = this._debounce(
      () => { void this.refreshPinned().catch(err => _log.appendLine(`[pinned] Refresh failed: ${String(err)}`)); },
      500,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(watchBase, '**/*.{yml,yaml}'),
    );
    watcher.onDidChange(debounceRefreshPinned);
    watcher.onDidCreate(debounceRefreshPinned);
    watcher.onDidDelete(debounceRefreshPinned);
    this._pinnedWatchers.push(watcher);

    // Watch .code-workspace files so folder list changes trigger a re-scan
    const codeWsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(watchBase, '**/*.code-workspace'),
    );
    codeWsWatcher.onDidChange(debounceRefreshPinned);
    codeWsWatcher.onDidCreate(debounceRefreshPinned);
    codeWsWatcher.onDidDelete(debounceRefreshPinned);
    this._pinnedWatchers.push(codeWsWatcher);
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
        if ((type & vscode.FileType.Directory) !== 0) {
          if (name === 'node_modules' || name.startsWith('.')) continue;
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
        } else if ((type & vscode.FileType.File) !== 0 && isRequestFile(name)) {
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
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('missio.pinnedWorkspacePaths')) {
          void this._loadActivePinnedWorkspace().then(() => this._onDidChange.fire()).catch(
            err => _log.appendLine(`[pinned] Config reload failed: ${String(err)}`),
          );
        }
      }),
    );
  }

  private _startPolling(): void {
    const tick = async () => {
      try {
        const fingerprint = await this._computeFingerprintScoped();
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

  /** Cheap synchronous fingerprint from already-loaded collection data (file paths + count). */
  private _computeFingerprintFromCollections(): string {
    const parts: string[] = [];
    for (const [id] of this._collections) {
      parts.push(id);
    }
    for (const [id] of this._workspaces) {
      parts.push(id);
    }
    parts.sort();
    return parts.join('\n');
  }

  /** Scoped fingerprint: only stat yml files within known collection root dirs (parallel). */
  private async _computeFingerprintScoped(): Promise<string> {
    const rootDirs = new Set<string>();
    for (const col of this._collections.values()) {
      rootDirs.add(col.rootDir);
    }

    // If no collections loaded yet, fall back to scanning for collection files only
    if (rootDirs.size === 0) {
      const files = await vscode.workspace.findFiles('**/collection.{yml,yaml}', '**/node_modules/**');
      return files.map(f => f.fsPath).sort().join('\n');
    }

    // Find yml files only within known collection directories
    const allFiles: vscode.Uri[] = [];
    for (const rootDir of rootDirs) {
      const pattern = new vscode.RelativePattern(rootDir, '**/*.{yml,yaml}');
      const files = await vscode.workspace.findFiles(pattern);
      allFiles.push(...files);
    }

    // Stat in parallel
    const parts = await Promise.all(
      allFiles.map(async (uri) => {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          return `${uri.fsPath}:${stat.mtime}`;
        } catch {
          return '';
        }
      }),
    );

    return parts.filter(Boolean).sort().join('\n');
  }

  private _debounce(fn: () => void, ms: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    return () => {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(fn, ms);
    };
  }

  private _migrationPromptShown = false;
  private _migrationPromptTimer: NodeJS.Timeout | undefined;

  private _debouncedMigrationPrompt(): void {
    if (this._migrationPromptShown) return;
    if (this._migrationPromptTimer) clearTimeout(this._migrationPromptTimer);
    this._migrationPromptTimer = setTimeout(() => this._promptMigrationPersist(), 500);
  }

  private _promptMigrationPersist(): void {
    const pending = getPendingMigrations();
    if (pending.size === 0 || this._migrationPromptShown) return;
    this._migrationPromptShown = true;

    const fileCount = pending.size;
    const migrations = new Set<string>();
    for (const { applied } of pending.values()) {
      for (const id of applied) migrations.add(id);
    }

    const msg = `Missio applied ${migrations.size} migration${migrations.size > 1 ? 's' : ''} to ${fileCount} file${fileCount > 1 ? 's' : ''}. Save changes to disk?`;
    vscode.window.showInformationMessage(msg, 'Save', 'Dismiss').then(async (choice) => {
      if (choice === 'Save') {
        const count = await persistPendingMigrations();
        vscode.window.showInformationMessage(`${count} migrated file${count !== 1 ? 's' : ''} saved to disk.`);
        this._migrationPromptShown = true;
        await this.refresh();
      } else {
        clearPendingMigrations();
      }
      this._migrationPromptShown = false;
    });
  }

  dispose(): void {
    if (this._pollTimer) { clearTimeout(this._pollTimer); }
    this._pinnedWatchers.forEach(w => w.dispose());
    this._watchers.forEach(w => w.dispose());
    this._disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}
