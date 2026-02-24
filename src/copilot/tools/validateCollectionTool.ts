import * as vscode from 'vscode';
import * as path from 'path';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { validateCollection, formatReport } from '../../services/validationService';

export interface ValidateCollectionParams {
  collectionId?: string;
}

export class ValidateCollectionTool extends ToolBase<ValidateCollectionParams> {
  public readonly toolName = 'missio_validate_collection';

  constructor(
    private _collectionService: CollectionService,
    private _schemaPath: string,
  ) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<ValidateCollectionParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { collectionId } = options.input;
    const collection = this._collectionService.resolveCollection(collectionId);
    if (!collection) {
      const hint = collectionId
        ? `Collection not found: ${collectionId}`
        : 'Multiple collections loaded — specify collectionId (use missio_list_collections to find it).';
      return JSON.stringify({ success: false, message: hint });
    }

    const report = await validateCollection(collection.rootDir, this._schemaPath);
    return JSON.stringify({ success: true, report: formatReport(report) });
  }
}
