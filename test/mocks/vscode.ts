/**
 * Minimal vscode mock for unit testing extension-host code.
 */
export class EventEmitter<T> {
  private _listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this._listeners.push(listener);
    return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
  };
  fire(data: T) { this._listeners.forEach(l => l(data)); }
  dispose() { this._listeners = []; }
}

export class Uri {
  static file(path: string) { return { fsPath: path, toString: () => `file://${path}` }; }
  static joinPath(base: any, ...segments: string[]) { return Uri.file([base.fsPath, ...segments].join('/')); }
}

export const workspace = {
  fs: {
    readDirectory: async () => [],
    stat: async () => ({}),
    readFile: async () => Buffer.from(''),
    writeFile: async () => {},
    createDirectory: async () => {},
    delete: async () => {},
  },
  getConfiguration: () => ({
    get: (key: string, defaultValue: any) => defaultValue,
  }),
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  applyEdit: async () => true,
};

export const window = {
  showInformationMessage: async () => {},
  showWarningMessage: async () => {},
  showErrorMessage: async () => {},
  showInputBox: async () => undefined,
  createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
  createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
  registerTreeDataProvider: () => ({ dispose: () => {} }),
  registerCustomEditorProvider: () => ({ dispose: () => {} }),
  createTreeView: () => ({
    onDidExpandElement: () => ({ dispose: () => {} }),
    onDidCollapseElement: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  tabGroups: { activeTabGroup: { activeTab: null } },
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => {},
};

export const languages = {
  registerCodeLensProvider: () => ({ dispose: () => {} }),
};

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class Range {
  constructor(public startLine: number, public startChar: number, public endLine: number, public endChar?: number) {}
}

export class WorkspaceEdit {
  replace() {}
}

export const Disposable = {
  from: (...disposables: any[]) => ({ dispose: () => disposables.forEach((d: any) => d.dispose?.()) }),
};

export class ThemeIcon {
  constructor(public id: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label?: string;
  collapsibleState?: TreeItemCollapsibleState;
  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
