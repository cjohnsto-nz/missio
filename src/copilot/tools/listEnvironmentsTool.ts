import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { EnvironmentService } from '../../services/environmentService';

export interface ListEnvironmentsParams {
  collectionId: string;
}

export class ListEnvironmentsTool extends ToolBase<ListEnvironmentsParams> {
  public readonly toolName = 'missio_list_environments';

  constructor(
    private _collectionService: CollectionService,
    private _environmentService: EnvironmentService,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<ListEnvironmentsParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { collectionId } = options.input;
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) {
      return JSON.stringify({ success: false, message: `Collection not found: ${collectionId}` });
    }

    const envs = this._environmentService.getCollectionEnvironments(collection);
    const active = this._environmentService.getActiveEnvironmentName(collectionId);
    const result = envs.map(e => ({
      name: e.name,
      color: e.color,
      variableCount: e.variables?.length ?? 0,
      active: e.name === active,
    }));
    return JSON.stringify({ success: true, environments: result, activeEnvironment: active ?? null });
  }
}
