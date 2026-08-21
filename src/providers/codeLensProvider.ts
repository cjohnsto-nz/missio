import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { isGraphQLRequest, isGrpcRequest, isHttpRequest, isWebSocketRequest } from '../models/types';
import { describeGraphQLOperation } from '../services/graphqlSupport';

export class MissioCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private _disposables: vscode.Disposable[] = [];

  constructor() {
    this._disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => this._onDidChangeCodeLenses.fire()),
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const text = document.getText();
    if (!text.includes('http:') && !text.includes('graphql:') && !text.includes('grpc:') && !text.includes('websocket:')) {
      return [];
    }

    try {
      const parsed = parseYaml(text);
      if (isHttpRequest(parsed) && parsed.http?.method) {
        return this._httpLenses(document, parsed);
      }
      if (isGraphQLRequest(parsed) && parsed.graphql?.url) {
        return this._graphqlLenses(document, parsed);
      }
      if (isGrpcRequest(parsed) && parsed.grpc?.method) {
        return this._grpcLenses(document, parsed);
      }
      if (isWebSocketRequest(parsed) && parsed.websocket?.url) {
        return this._webSocketLenses(document, parsed);
      }
    } catch {
      // Invalid YAML or not a request file.
    }

    return [];
  }

  private _httpLenses(document: vscode.TextDocument, request: import('../models/types').HttpRequest): vscode.CodeLens[] {
    const range = new vscode.Range(0, 0, 0, 0);
    const method = request.http?.method?.toUpperCase() ?? 'HTTP';
    const url = request.http?.url ?? '';
    const lenses = [
      new vscode.CodeLens(range, {
        title: 'Send Request',
        command: 'missio.sendRequest',
        arguments: [document.uri.fsPath],
        tooltip: `${method} ${url}`,
      }),
    ];

    if (url) {
      lenses.push(new vscode.CodeLens(range, {
        title: `${method} ${url}`,
        command: '',
      }));
    }

    return lenses;
  }

  private _graphqlLenses(document: vscode.TextDocument, request: import('../models/types').GraphQLRequest): vscode.CodeLens[] {
    const range = new vscode.Range(0, 0, 0, 0);
    const operation = describeGraphQLOperation(request);
    const url = request.graphql?.url ?? '';

    return [
      new vscode.CodeLens(range, {
        title: 'Send GraphQL',
        command: 'missio.sendRequest',
        arguments: [document.uri.fsPath],
        tooltip: `${operation} ${url}`,
      }),
      new vscode.CodeLens(range, {
        title: `GRAPHQL ${operation} ${url}`,
        command: '',
      }),
    ];
  }

  private _grpcLenses(document: vscode.TextDocument, request: import('../models/types').GrpcRequest): vscode.CodeLens[] {
    const range = new vscode.Range(0, 0, 0, 0);
    const method = request.grpc?.method ?? '';
    const url = request.grpc?.url ?? '';

    return [
      new vscode.CodeLens(range, {
        title: 'Send gRPC',
        command: 'missio.sendRequest',
        arguments: [document.uri.fsPath],
        tooltip: `${method} ${url}`,
      }),
      new vscode.CodeLens(range, {
        title: `gRPC ${method}`,
        command: '',
      }),
    ];
  }

  private _webSocketLenses(document: vscode.TextDocument, request: import('../models/types').WebSocketRequest): vscode.CodeLens[] {
    const range = new vscode.Range(0, 0, 0, 0);
    const url = request.websocket?.url ?? '';

    return [
      new vscode.CodeLens(range, {
        title: 'Connect WebSocket',
        command: 'missio.sendRequest',
        arguments: [document.uri.fsPath],
        tooltip: `WS ${url}`,
      }),
      new vscode.CodeLens(range, {
        title: `WS ${url}`,
        command: '',
      }),
    ];
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeCodeLenses.dispose();
  }
}
