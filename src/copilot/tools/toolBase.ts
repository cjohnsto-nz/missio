import * as vscode from 'vscode';

export abstract class ToolBase<T> implements vscode.LanguageModelTool<T> {
  abstract toolName: string;

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<T>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const response = await this.call(options, token);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(response),
      ]);
    } catch (error) {
      const errorPayload = {
        isError: true,
        message: error instanceof Error ? error.message : String(error),
      };
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(errorPayload)),
      ]);
    }
  }

  abstract call(
    options: vscode.LanguageModelToolInvocationOptions<T>,
    token: vscode.CancellationToken,
  ): Promise<string>;
}
