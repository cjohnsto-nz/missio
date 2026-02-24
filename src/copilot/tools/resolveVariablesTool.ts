import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { EnvironmentService } from '../../services/environmentService';
import { readFolderFile } from '../../services/yamlParser';
import * as path from 'path';

export interface ResolveVariablesParams {
  collectionId?: string;
  environment?: string;
  requestFilePath?: string;
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
    const { collectionId, environment, requestFilePath } = options.input;
    const collection = this._collectionService.resolveCollection(collectionId);
    if (!collection) {
      const hint = collectionId
        ? `Collection not found: ${collectionId}`
        : 'Multiple collections loaded — specify collectionId (use missio_list_collections to find it).';
      return JSON.stringify({ success: false, message: hint });
    }

    // If requestFilePath is provided, read folder defaults for folder-scoped resolution
    let folderDefaults: import('../../models/types').RequestDefaults | undefined;
    if (requestFilePath) {
      const absPath = path.isAbsolute(requestFilePath)
        ? requestFilePath
        : path.join(collection.rootDir, requestFilePath.replace(/\//g, path.sep));
      folderDefaults = await this._readFolderDefaults(absPath, collection.rootDir);
    }

    const activeEnv = this._environmentService.getActiveEnvironmentName(collection.id);
    const effectiveEnv = environment ?? activeEnv;
    const varsWithSource = await this._environmentService.resolveVariablesWithSource(collection, folderDefaults, environment);
    const variables: Record<string, { value: string; source: string }> = {};
    for (const [k, v] of varsWithSource) {
      variables[k] = v;
    }

    return JSON.stringify({
      success: true,
      activeEnvironment: effectiveEnv ?? null,
      variables,
      ...(folderDefaults ? { folderScoped: true } : {}),
    });
  }

  private async _readFolderDefaults(requestFilePath: string, collectionRoot: string) {
    let dir = path.dirname(requestFilePath);
    while (dir !== collectionRoot && dir.startsWith(collectionRoot)) {
      for (const name of ['folder.yml', 'folder.yaml']) {
        try {
          const data = await readFolderFile(path.join(dir, name));
          if (data?.request) return data.request;
        } catch { /* no folder file */ }
      }
      dir = path.dirname(dir);
    }
    return undefined;
  }
}
