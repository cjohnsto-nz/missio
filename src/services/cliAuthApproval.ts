import * as vscode from 'vscode';
import * as crypto from 'crypto';

const APPROVED_COMMANDS_KEY = 'missio.approvedCliCommands';

/**
 * Service to manage user approval of CLI auth commands.
 * Commands must be approved before execution to prevent malicious commands
 * in imported collections from running without user consent.
 */
export class CliAuthApprovalService implements vscode.Disposable {
  constructor(private readonly _context: vscode.ExtensionContext) {}

  dispose(): void {}

  /**
   * Generate a stable hash for a command template.
   * We hash the raw command (before variable interpolation) so approval
   * persists even when variable values change.
   */
  private _hashCommand(command: string): string {
    return crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
  }

  /**
   * Get the set of approved command hashes.
   */
  private _getApprovedHashes(): Set<string> {
    const stored = this._context.globalState.get<string[]>(APPROVED_COMMANDS_KEY, []);
    return new Set(stored);
  }

  /**
   * Save the set of approved command hashes.
   */
  private async _saveApprovedHashes(hashes: Set<string>): Promise<void> {
    await this._context.globalState.update(APPROVED_COMMANDS_KEY, Array.from(hashes));
  }

  /**
   * Check if a command template is approved.
   */
  isApproved(commandTemplate: string): boolean {
    const hash = this._hashCommand(commandTemplate);
    return this._getApprovedHashes().has(hash);
  }

  /**
   * Mark a command template as approved.
   */
  async approve(commandTemplate: string): Promise<void> {
    const hash = this._hashCommand(commandTemplate);
    const hashes = this._getApprovedHashes();
    hashes.add(hash);
    await this._saveApprovedHashes(hashes);
  }

  /**
   * Revoke approval for a command template.
   */
  async revoke(commandTemplate: string): Promise<void> {
    const hash = this._hashCommand(commandTemplate);
    const hashes = this._getApprovedHashes();
    hashes.delete(hash);
    await this._saveApprovedHashes(hashes);
  }

  /**
   * Clear all approved commands.
   */
  async clearAll(): Promise<void> {
    await this._context.globalState.update(APPROVED_COMMANDS_KEY, []);
  }
}
