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
   * Generate a stable hash for an executable command string.
   * Approvals are keyed to the fully resolved command so changes introduced
   * by interpolation or secret resolution require fresh approval.
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
   * Check if a resolved command is approved.
   */
  isApproved(command: string): boolean {
    const hash = this._hashCommand(command);
    return this._getApprovedHashes().has(hash);
  }

  /**
   * Mark a resolved command as approved.
   */
  async approve(command: string): Promise<void> {
    const hash = this._hashCommand(command);
    const hashes = this._getApprovedHashes();
    hashes.add(hash);
    await this._saveApprovedHashes(hashes);
  }

  /**
   * Clear all approved commands.
   */
  async clearAll(): Promise<void> {
    await this._context.globalState.update(APPROVED_COMMANDS_KEY, []);
  }
}
