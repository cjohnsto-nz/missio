import type * as vscode from 'vscode';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { HttpClient } from '../services/httpClient';
import type { ResponseDocumentProvider } from '../providers/responseProvider';
import type { CollectionTreeProvider } from '../providers/collectionTreeProvider';

export interface CommandContext {
  extensionContext: vscode.ExtensionContext;
  collectionService: CollectionService;
  environmentService: EnvironmentService;
  httpClient: HttpClient;
  responseProvider: ResponseDocumentProvider;
  collectionTreeProvider: CollectionTreeProvider;
}
