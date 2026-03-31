import * as vscode from 'vscode';
import type { CollectionService, WorkspaceEntry } from '../services/collectionService';

class WorkspaceEntryNode extends vscode.TreeItem {
  constructor(
    public readonly entry: WorkspaceEntry,
    isActive: boolean,
  ) {
    super(entry.label, vscode.TreeItemCollapsibleState.None);
    this.id = `workspace:${entry.key ?? '__current__'}`;
    if (entry.error) {
      this.description = 'Not found';
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      this.tooltip = entry.error;
    } else {
      this.description = isActive ? '● Active' : (entry.folderPath ?? '(editor workspace)');
      this.iconPath = new vscode.ThemeIcon(entry.key === null ? 'project' : 'pin');
    }
    this.contextValue = entry.key === null ? 'workspaceEntryCurrent' : (entry.error ? 'workspaceEntryPinnedError' : (isActive ? 'workspaceEntryPinnedActive' : 'workspaceEntryPinned'));
    this.command = {
      command: 'missio.selectWorkspace',
      title: 'Select Workspace',
      arguments: [entry.key],
    };
  }
}

export class WorkspaceSelectorTreeProvider implements vscode.TreeDataProvider<WorkspaceEntryNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkspaceEntryNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly _collectionService: CollectionService) {
    this._disposables.push(
      this._collectionService.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: WorkspaceEntryNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorkspaceEntryNode): Promise<WorkspaceEntryNode[]> {
    if (element) return [];
    const activeKey = this._collectionService.getActiveWorkspaceKey();
    return this._collectionService.getWorkspaceEntries().map(
      e => new WorkspaceEntryNode(e, e.key === activeKey),
    );
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
