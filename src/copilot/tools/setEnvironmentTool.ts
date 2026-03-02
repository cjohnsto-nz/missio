import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { EnvironmentService } from '../../services/environmentService';

export interface SetEnvironmentParams {
  collectionId?: string;
  environmentName: string;
}

export class SetEnvironmentTool extends ToolBase<SetEnvironmentParams> {
  public readonly toolName = 'missio_set_environment';

  constructor(
    private _collectionService: CollectionService,
    private _environmentService: EnvironmentService,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<SetEnvironmentParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { collectionId, environmentName } = options.input;
    const collection = this._collectionService.resolveCollection(collectionId);
    if (!collection) {
      const hint = collectionId
        ? `Collection not found: ${collectionId}`
        : 'Multiple collections loaded — specify collectionId (use missio_list_collections to find it).';
      return JSON.stringify({ success: false, message: hint });
    }

    const envs = this._environmentService.getCollectionEnvironments(collection);
    if (!envs.some(e => e.name === environmentName)) {
      return JSON.stringify({
        success: false,
        message: `Environment "${environmentName}" not found. Available: ${envs.map(e => e.name).join(', ')}`,
      });
    }

    await this._environmentService.setActiveEnvironment(collection.id, environmentName);
    return JSON.stringify({ success: true, message: `Active environment set to "${environmentName}"` });
  }
}
