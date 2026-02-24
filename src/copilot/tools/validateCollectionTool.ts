import * as vscode from 'vscode';
import * as path from 'path';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { validateCollection, formatReport } from '../../services/validationService';

export interface ValidateCollectionParams {
  collectionId: string;
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
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) {
      return JSON.stringify({ success: false, message: `Collection not found: ${collectionId}` });
    }

    const report = await validateCollection(collection.rootDir, this._schemaPath);
    return JSON.stringify({ success: true, report: formatReport(report) });
  }
}
