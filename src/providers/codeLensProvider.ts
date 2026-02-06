import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';

/**
 * Provides "▶ Send Request" CodeLens above HTTP request definitions in YAML files.
 * Detects requests by looking for `info.type: http` + `http.method` patterns.
 */
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
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();

    // Quick check — only provide lenses for files that look like OpenCollection requests
    if (!text.includes('http:') || !text.includes('method:')) {
      return lenses;
    }

    try {
      const parsed = parseYaml(text);
      if (parsed && parsed.http && parsed.http.method) {
        // Single-request file — add lens at line 0
        const range = new vscode.Range(0, 0, 0, 0);
        lenses.push(new vscode.CodeLens(range, {
          title: '▶ Send Request',
          command: 'missio.sendRequest',
          arguments: [document.uri.fsPath],
          tooltip: `${parsed.http.method.toUpperCase()} ${parsed.http.url ?? ''}`,
        }));

        if (parsed.http.url) {
          lenses.push(new vscode.CodeLens(range, {
            title: `${parsed.http.method.toUpperCase()} ${parsed.http.url}`,
            command: '',
          }));
        }
      }
    } catch {
      // Not valid YAML or not a request file
    }

    return lenses;
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeCodeLenses.dispose();
  }
}
