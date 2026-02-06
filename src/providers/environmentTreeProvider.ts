import * as vscode from 'vscode';
import * as path from 'path';
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
    this.id = `envGroup:${collection.id}`;
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
    this.id = `env:${collectionId}:${environment.name}`;
    this.contextValue = 'environment';
    this.description = isActive ? '● Active' : '';

    // Color the icon using the stored ThemeColor token
    const iconName = isActive ? 'circle-filled' : 'circle-outline';
    if (environment.color) {
      this.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor(environment.color));
    } else {
      this.iconPath = new vscode.ThemeIcon(iconName);
    }

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
      const collections = this._collectionService.getCollections()
        .filter(c => (c.data.config?.environments?.length ?? 0) > 0)
        .sort((a, b) => {
          const nameA = (a.data.info?.name ?? path.basename(a.rootDir)).toLowerCase();
          const nameB = (b.data.info?.name ?? path.basename(b.rootDir)).toLowerCase();
          return nameA.localeCompare(nameB);
        });
      return collections.map(c => new CollectionEnvGroupNode(
          c,
          this._environmentService.getActiveEnvironmentName(c.id),
        ));
    }

    if (element instanceof CollectionEnvGroupNode) {
      const collection = element.collection;
      const environments = this._environmentService.getCollectionEnvironments(collection)
        .slice()
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
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
