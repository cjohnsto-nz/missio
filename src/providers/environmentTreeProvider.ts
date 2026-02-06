import * as vscode from 'vscode';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { MissioCollection, Environment } from '../models/types';

type EnvTreeNode = CollectionEnvGroupNode | EnvironmentNode;

class CollectionEnvGroupNode extends vscode.TreeItem {
  constructor(
    public readonly collection: MissioCollection,
    activeEnvName?: string,
  ) {
    super(
      collection.data.info?.name ?? 'Collection',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.contextValue = 'envGroup';
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.description = activeEnvName ? `Active: ${activeEnvName}` : 'No environment selected';
  }
}

class EnvironmentNode extends vscode.TreeItem {
  constructor(
    public readonly environment: Environment,
    public readonly collectionId: string,
    public readonly isActive: boolean,
  ) {
    super(environment.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'environment';
    this.description = isActive ? '● Active' : '';
    this.iconPath = new vscode.ThemeIcon(
      isActive ? 'server-environment' : 'circle-outline',
    );
    this.tooltip = typeof environment.description === 'string'
      ? environment.description
      : (environment.description as any)?.content ?? `${environment.variables?.length ?? 0} variables`;

    this.command = {
      command: 'missio.selectEnvironment',
      title: 'Select Environment',
      arguments: [collectionId, environment.name],
    };
  }
}

export class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvTreeNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<EnvTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _collectionService: CollectionService,
    private readonly _environmentService: EnvironmentService,
  ) {
    this._disposables.push(
      this._collectionService.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
      this._environmentService.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: EnvTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: EnvTreeNode): Promise<EnvTreeNode[]> {
    if (!element) {
      const collections = this._collectionService.getCollections();
      return collections
        .filter(c => (c.data.config?.environments?.length ?? 0) > 0)
        .map(c => new CollectionEnvGroupNode(
          c,
          this._environmentService.getActiveEnvironmentName(c.id),
        ));
    }

    if (element instanceof CollectionEnvGroupNode) {
      const collection = element.collection;
      const environments = this._environmentService.getCollectionEnvironments(collection);
      const activeName = this._environmentService.getActiveEnvironmentName(collection.id);
      return environments.map(env =>
        new EnvironmentNode(env, collection.id, env.name === activeName),
      );
    }

    return [];
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
