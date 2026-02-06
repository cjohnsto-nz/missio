import * as vscode from 'vscode';
import type { SecretProviderConfig } from '../models/types';

/**
 * Abstract interface for secret providers.
 */
export interface ISecretProvider {
  readonly name: string;
  initialize(config: Record<string, unknown>): Promise<void>;
  getSecret(secretName: string): Promise<string | undefined>;
  dispose?(): void;
}

/**
 * Azure Key Vault secret provider.
 * Uses @azure/identity DefaultAzureCredential for authentication.
 */
class AzureKeyVaultProvider implements ISecretProvider {
  readonly name = 'azureKeyVault';
  private _client: any;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const vaultUrl = config.vaultUrl as string;
    if (!vaultUrl) {
      throw new Error('Azure Key Vault: vaultUrl is required');
    }
    try {
      const { DefaultAzureCredential } = await import('@azure/identity');
      const { SecretClient } = await import('@azure/keyvault-secrets');
      const credential = new DefaultAzureCredential();
      this._client = new SecretClient(vaultUrl, credential);
    } catch (e: any) {
      throw new Error(`Azure Key Vault initialization failed: ${e.message}`);
    }
  }

  async getSecret(secretName: string): Promise<string | undefined> {
    if (!this._client) { return undefined; }
    try {
      const secret = await this._client.getSecret(secretName);
      return secret.value;
    } catch (e: any) {
      vscode.window.showWarningMessage(`Azure Key Vault: failed to retrieve "${secretName}": ${e.message}`);
      return undefined;
    }
  }
}

/**
 * Keeper Secrets Manager provider.
 */
class KeeperProvider implements ISecretProvider {
  readonly name = 'keeper';
  private _client: any;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const configFile = config.configFile as string;
    if (!configFile) {
      throw new Error('Keeper: configFile (path or base64 token) is required');
    }
    try {
      const ksm = await import('@keeper-security/secrets-manager-core');
      const storage = ksm.localConfigStorage(configFile);
      this._client = ksm.getSecrets({ storage });
    } catch (e: any) {
      throw new Error(`Keeper initialization failed: ${e.message}`);
    }
  }

  async getSecret(secretName: string): Promise<string | undefined> {
    if (!this._client) { return undefined; }
    try {
      const records = await this._client;
      // secretName format: "recordUID/fieldType" e.g. "xxxx/password"
      const [recordUid, fieldType] = secretName.split('/');
      const record = records.find((r: any) => r.recordUid === recordUid);
      if (!record) { return undefined; }
      const field = record.data?.fields?.find((f: any) => f.type === (fieldType || 'password'));
      return field?.value?.[0];
    } catch (e: any) {
      vscode.window.showWarningMessage(`Keeper: failed to retrieve "${secretName}": ${e.message}`);
      return undefined;
    }
  }
}

/**
 * Orchestrates multiple secret providers.
 */
export class SecretService implements vscode.Disposable {
  private _providers: Map<string, ISecretProvider> = new Map();
  private _initialized = false;

  async initialize(): Promise<void> {
    if (this._initialized) { return; }
    const config = vscode.workspace.getConfiguration('missio');
    const secretConfig = config.get<SecretProviderConfig>('secretProviders', {});

    if (secretConfig.azureKeyVault?.vaultUrl) {
      const provider = new AzureKeyVaultProvider();
      try {
        await provider.initialize(secretConfig.azureKeyVault as any);
        this._providers.set('azureKeyVault', provider);
      } catch (e: any) {
        vscode.window.showWarningMessage(`Missio: ${e.message}`);
      }
    }

    if (secretConfig.keeper?.configFile) {
      const provider = new KeeperProvider();
      try {
        await provider.initialize(secretConfig.keeper as any);
        this._providers.set('keeper', provider);
      } catch (e: any) {
        vscode.window.showWarningMessage(`Missio: ${e.message}`);
      }
    }

    this._initialized = true;
  }

  /**
   * Resolve a secret by name.
   * Format: "providerName:secretName" e.g. "azureKeyVault:my-api-key"
   * If no provider prefix, tries all providers in order.
   */
  async resolveSecret(secretName: string): Promise<string | undefined> {
    await this.initialize();

    const colonIdx = secretName.indexOf(':');
    if (colonIdx > 0) {
      const providerName = secretName.substring(0, colonIdx);
      const name = secretName.substring(colonIdx + 1);
      const provider = this._providers.get(providerName);
      if (provider) {
        return provider.getSecret(name);
      }
      return undefined;
    }

    // Try all providers
    for (const provider of this._providers.values()) {
      const value = await provider.getSecret(secretName);
      if (value !== undefined) { return value; }
    }
    return undefined;
  }

  getProviderNames(): string[] {
    return Array.from(this._providers.keys());
  }

  dispose(): void {
    for (const provider of this._providers.values()) {
      provider.dispose?.();
    }
    this._providers.clear();
  }
}
