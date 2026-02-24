import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { EnvironmentService } from '../../services/environmentService';

export interface ResolveVariablesParams {
  collectionId: string;
}

export class ResolveVariablesTool extends ToolBase<ResolveVariablesParams> {
  public readonly toolName = 'missio_resolve_variables';

  constructor(
    private _collectionService: CollectionService,
    private _environmentService: EnvironmentService,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<ResolveVariablesParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { collectionId } = options.input;
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) {
      return JSON.stringify({ success: false, message: `Collection not found: ${collectionId}` });
    }

    const activeEnv = this._environmentService.getActiveEnvironmentName(collectionId);
    const varsWithSource = await this._environmentService.resolveVariablesWithSource(collection);
    const variables: Record<string, { value: string; source: string }> = {};
    for (const [k, v] of varsWithSource) {
      variables[k] = v;
    }

    return JSON.stringify({
      success: true,
      activeEnvironment: activeEnv ?? null,
      variables,
    });
  }
}
