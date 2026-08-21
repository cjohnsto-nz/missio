import * as vscode from 'vscode';
import type { HttpResponse } from '../models/types';

const SCHEME = 'missio-response';

/**
 * Provides virtual documents displaying HTTP response data.
 */
export class ResponseDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private _responses: Map<string, string> = new Map();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private _disposables: vscode.Disposable[] = [];

  constructor() {
    this._disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
    );
  }

  async showResponse(response: HttpResponse, requestName?: string): Promise<void> {
    const label = requestName ?? 'Response';
    const id = `${label}-${Date.now()}`;
    const content = this._formatResponse(response);
    this._responses.set(id, content);

    const uri = vscode.Uri.parse(`${SCHEME}:${label}.http-response?id=${id}`);
    this._onDidChange.fire(uri);

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
      preview: true,
    });

    // Try to set language for syntax highlighting
    try {
      const contentType = response.headers['content-type'] ?? '';
      let lang = 'plaintext';
      if (contentType.includes('json')) { lang = 'json'; }
      else if (contentType.includes('xml')) { lang = 'xml'; }
      else if (contentType.includes('html')) { lang = 'html'; }
      await vscode.languages.setTextDocumentLanguage(doc, lang);
    } catch {
      // Language not available
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const id = params.get('id') ?? '';
    return this._responses.get(id) ?? 'No response data';
  }

  private _formatResponse(response: HttpResponse): string {
    const lines: string[] = [];

    // Status line
    lines.push(`HTTP ${response.status} ${response.statusText}`);
    lines.push(`Duration: ${response.duration}ms | Size: ${this._formatSize(response.size)}`);
    lines.push('');

    // Headers
    lines.push('── Response Headers ──────────────────────────────────');
    for (const [key, value] of Object.entries(response.headers)) {
      lines.push(`${key}: ${value}`);
    }
    lines.push('');

    // Body
    lines.push('── Response Body ─────────────────────────────────────');
    const contentType = response.headers['content-type'] ?? '';
    if (contentType.includes('json')) {
      try {
        const formatted = JSON.stringify(JSON.parse(response.body), null, 2);
        lines.push(formatted);
      } catch {
        lines.push(response.body);
      }
    } else {
      lines.push(response.body);
    }

    if (response.runtime) {
      lines.push('');
      lines.push('-- Runtime Results ------------------------------------');
      lines.push(`Success: ${response.runtime.success ? 'yes' : 'no'} | Passed: ${response.runtime.summary.passed} | Failed: ${response.runtime.summary.failed} | Skipped: ${response.runtime.summary.skipped}`);

      if (response.runtime.tests.length > 0) {
        lines.push('');
        lines.push('Tests:');
        for (const test of response.runtime.tests) {
          lines.push(`  ${test.passed ? 'PASS' : 'FAIL'} ${test.name}${test.message ? ` - ${test.message}` : ''}`);
        }
      }

      if (response.runtime.assertions.length > 0) {
        lines.push('');
        lines.push('Assertions:');
        for (const assertion of response.runtime.assertions) {
          const state = assertion.skipped ? 'SKIP' : assertion.passed ? 'PASS' : 'FAIL';
          lines.push(`  ${state} ${assertion.expression} ${assertion.operator} ${this._formatRuntimeValue(assertion.expected)}${assertion.message ? ` - ${assertion.message}` : ''}`);
        }
      }

      if (response.runtime.actions.length > 0) {
        lines.push('');
        lines.push('Actions:');
        for (const action of response.runtime.actions) {
          const state = action.skipped ? 'SKIP' : action.passed ? 'PASS' : 'FAIL';
          lines.push(`  ${state} ${action.phase} ${action.type}${action.target ? ` ${action.target}` : ''}${action.message ? ` - ${action.message}` : ''}`);
        }
      }

      if (response.runtime.variableMutations.length > 0) {
        lines.push('');
        lines.push('Variable Mutations:');
        for (const mutation of response.runtime.variableMutations) {
          lines.push(`  ${mutation.scope}.${mutation.name} = ${mutation.value}`);
        }
      }

      if (response.runtime.logs.length > 0) {
        lines.push('');
        lines.push('Logs:');
        for (const log of response.runtime.logs) {
          lines.push(`  [${log.phase}] ${log.level}: ${log.message}`);
        }
      }

      if (response.runtime.errors.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const error of response.runtime.errors) {
          lines.push(`  [${error.phase}] ${error.message}`);
        }
      }
    }

    return lines.join('\n');
  }

  private _formatRuntimeValue(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private _formatSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}
