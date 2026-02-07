import * as vscode from 'vscode';
import type { EnvironmentService, GlobalVariable } from '../services/environmentService';

type GlobalsTreeNode = GlobalVariableNode | EmptyGlobalsNode;

class GlobalVariableNode extends vscode.TreeItem {
  constructor(
    public readonly variable: GlobalVariable,
    public readonly index: number,
  ) {
    super(variable.name || '(unnamed)', vscode.TreeItemCollapsibleState.None);
    this.id = `globalVar:${index}:${variable.name || 'unnamed'}`;
    this.contextValue = 'globalVariable';
    this.iconPath = new vscode.ThemeIcon(variable.disabled ? 'circle-slash' : 'symbol-variable');
    this.description = variable.disabled ? 'Disabled' : (variable.value ?? '');
    this.tooltip = variable.name
      ? `${variable.name} = ${variable.value ?? ''}${variable.disabled ? ' (disabled)' : ''}`
      : 'Unnamed global variable';
    this.command = {
      command: 'missio.editGlobalVariable',
      title: 'Edit Global Variable',
      arguments: [this],
    };
  }
}

class EmptyGlobalsNode extends vscode.TreeItem {
  constructor() {
    super('No global variables', vscode.TreeItemCollapsibleState.None);
    this.id = 'globalVar:empty';
    this.contextValue = 'globalVariablesEmpty';
    this.iconPath = new vscode.ThemeIcon('info');
    this.description = 'Use + to add one';
  }
}

export class GlobalsTreeProvider implements vscode.TreeDataProvider<GlobalsTreeNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<GlobalsTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly _environmentService: EnvironmentService) {
    this._disposables.push(
      this._environmentService.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: GlobalsTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GlobalsTreeNode): Promise<GlobalsTreeNode[]> {
    if (element) return [];

    const globals = this._environmentService.getGlobalVariables();
    if (globals.length === 0) {
      return [new EmptyGlobalsNode()];
    }

    return globals
      .map((variable, index) => ({ variable, index }))
      .sort((a, b) => (a.variable.name || '').toLowerCase().localeCompare((b.variable.name || '').toLowerCase()))
      .map(entry => new GlobalVariableNode(entry.variable, entry.index));
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
