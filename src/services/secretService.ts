import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SecretProvider } from '../models/types';
import { varPatternGlobal } from '../models/varPattern';

const execFileAsync = promisify(execFile);

// ── Azure CLI token cache ────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresOn: number; // epoch ms
}

let _azTokenCache: CachedToken | undefined;

async function getAzAccessToken(): Promise<string> {
  // Return cached token if still valid (30s buffer)
  if (_azTokenCache && Date.now() < _azTokenCache.expiresOn - 30_000) {
    return _azTokenCache.accessToken;
  }

  try {
    const { stdout } = await execFileAsync('az', [
      'account', 'get-access-token',
      '--resource', 'https://vault.azure.net',
      '--output', 'json',
    ], { shell: true, timeout: 15_000 });

    const result = JSON.parse(stdout);
    _azTokenCache = {
      accessToken: result.accessToken,
      expiresOn: new Date(result.expiresOn).getTime(),
    };
    return _azTokenCache.accessToken;
  } catch (e: any) {
    throw new Error(
      'Failed to get Azure access token via az cli. ' +
      'Ensure you are logged in with `az login`. ' +
      (e.stderr || e.message),
    );
  }
}

// ── Secret cache (per vault URL + secret name) ───────────────────────

const _secretCache = new Map<string, { value: string; fetchedAt: number }>();
const SECRET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Key Vault REST API ───────────────────────────────────────────────

async function fetchKeyVaultSecret(vaultUrl: string, secretName: string): Promise<string> {
  const cacheKey = `${vaultUrl}|${secretName}`;
  const cached = _secretCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SECRET_CACHE_TTL) {
    return cached.value;
  }

  const token = await getAzAccessToken();
  const url = `${vaultUrl.replace(/\/+$/, '')}/secrets/${secretName}?api-version=7.4`;

  // Use dynamic import for fetch (Node 18+)
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Key Vault ${response.status}: ${body}`);
  }

  const data = await response.json() as { value: string };
  _secretCache.set(cacheKey, { value: data.value, fetchedAt: Date.now() });
  return data.value;
}

// ── List secret names (for intellisense) ─────────────────────────────

async function listKeyVaultSecretNames(vaultUrl: string): Promise<string[]> {
  const token = await getAzAccessToken();
  const url = `${vaultUrl.replace(/\/+$/, '')}/secrets?api-version=7.4`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e: any) {
    if (e.cause?.code === 'ENOTFOUND') {
      throw new Error(`DNS lookup failed for vault URL — check the URL is correct: ${vaultUrl}`);
    }
    if (e.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Connection refused — vault may be unreachable: ${vaultUrl}`);
    }
    throw new Error(`Network error connecting to vault: ${e.message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new Error('Authentication failed — your az cli token may have expired. Run `az login` to re-authenticate.');
    }
    if (response.status === 403) {
      throw new Error('Access denied — you do not have permission to list secrets on this vault. Check your RBAC role assignments.');
    }
    if (response.status === 404) {
      throw new Error(`Vault not found at ${vaultUrl} — check the URL is correct.`);
    }
    let detail = '';
    try { detail = JSON.parse(body)?.error?.message || body; } catch { detail = body; }
    throw new Error(`Key Vault returned ${response.status}: ${detail}`);
  }

  const data = await response.json() as { value: { id: string }[] };
  return data.value.map(s => {
    const parts = s.id.split('/');
    return parts[parts.length - 1];
  });
}

// ── Secret names cache (per provider) ─────────────────────────────────

const _secretNamesCache = new Map<string, { names: string[]; fetchedAt: number }>();
const SECRET_NAMES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── SecretService ────────────────────────────────────────────────────

/**
 * Resolves secrets from collection-defined providers (e.g. Azure Key Vault).
 * Config lives in collection.yml — fully portable.
 * Auth is via `az cli` — user just needs `az login` and RBAC on the vault.
 *
 * Secret reference syntax: $secret.{providerName}.{secretName}
 */
export class SecretService implements vscode.Disposable {

  /**
   * Resolve a $secret.{vault}.{key} reference.
   * @param providerName - the name of the secret provider (matches SecretProvider.name in collection.yml)
   * @param secretName - the secret key name in the vault
   * @param providers - the secretProviders array from the collection config
   * @param variables - resolved variables for interpolating the vault URL
   */
  async resolveSecret(
    providerName: string,
    secretName: string,
    providers: SecretProvider[],
    variables: Map<string, string>,
  ): Promise<string | undefined> {
    const provider = providers.find(p => p.name === providerName && !p.disabled);
    if (!provider) { return undefined; }

    // Interpolate {{var}} in the vault URL using current environment variables
    const vaultUrl = provider.url.replace(varPatternGlobal(), (_match, name) => {
      const key = name.trim();
      return variables.has(key) ? variables.get(key)! : _match;
    });

    if (provider.type === 'azure-keyvault') {
      return fetchKeyVaultSecret(vaultUrl, secretName);
    }

    return undefined;
  }

  /**
   * Resolve all $secret.{vault}.{key} references in a string.
   */
  async resolveSecretReferences(
    value: string,
    providers: SecretProvider[],
    variables: Map<string, string>,
  ): Promise<string> {
    const pattern = /\$secret\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)/g;
    const matches = [...value.matchAll(pattern)];
    if (matches.length === 0) { return value; }

    let result = value;
    for (const match of matches) {
      const [fullMatch, providerName, secretName] = match;
      try {
        const secret = await this.resolveSecret(providerName, secretName, providers, variables);
        if (secret !== undefined) {
          result = result.replace(fullMatch, secret);
        }
      } catch (e: any) {
        // Leave unresolved — will show as-is
        vscode.window.showWarningMessage(`Secret resolution failed: ${fullMatch} — ${e.message}`);
      }
    }
    return result;
  }

  /**
   * Test connection to a vault. Returns secret count on success, throws on failure.
   */
  async testConnection(provider: SecretProvider, variables: Map<string, string>): Promise<{ secretCount: number }> {
    if (!provider.name) {
      throw new Error('Provider name is required.');
    }
    if (!provider.url) {
      throw new Error('Vault URL is required.');
    }

    const vaultUrl = provider.url.replace(varPatternGlobal(), (_match, name) => {
      const key = name.trim();
      return variables.has(key) ? variables.get(key)! : _match;
    });

    // Check for unresolved variables in the URL
    const unresolvedMatch = /\{\{(\s*[\w.$-]+\s*)\}\}/.exec(vaultUrl);
    if (unresolvedMatch) {
      throw new Error(`Vault URL contains unresolved variable: {{${unresolvedMatch[1].trim()}}}. Select an environment that defines this variable.`);
    }

    if (provider.type === 'azure-keyvault') {
      const names = await listKeyVaultSecretNames(vaultUrl);
      return { secretCount: names.length };
    }

    throw new Error(`Unknown provider type: ${provider.type}`);
  }

  /**
   * List secret names from a vault (for intellisense). Caches results.
   */
  async listSecretNames(provider: SecretProvider, variables: Map<string, string>): Promise<string[]> {
    const vaultUrl = provider.url.replace(varPatternGlobal(), (_match, name) => {
      const key = name.trim();
      return variables.has(key) ? variables.get(key)! : _match;
    });

    const cacheKey = `${provider.name}|${vaultUrl}`;
    const cached = _secretNamesCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < SECRET_NAMES_CACHE_TTL) {
      return cached.names;
    }

    let names: string[] = [];
    if (provider.type === 'azure-keyvault') {
      names = await listKeyVaultSecretNames(vaultUrl);
    }

    _secretNamesCache.set(cacheKey, { names, fetchedAt: Date.now() });
    return names;
  }

  /**
   * Get cached secret names for a provider (sync, no network call).
   * Returns empty array if not cached yet.
   */
  getCachedSecretNames(providerName: string): string[] {
    // Cache keys are "name|resolvedUrl" — find the most recent entry for this provider
    const prefix = providerName + '|';
    let best: { names: string[]; fetchedAt: number } | undefined;
    for (const [key, entry] of _secretNamesCache) {
      if (key.startsWith(prefix) && Date.now() - entry.fetchedAt < SECRET_NAMES_CACHE_TTL) {
        if (!best || entry.fetchedAt > best.fetchedAt) best = entry;
      }
    }
    return best?.names ?? [];
  }

  /**
   * Prefetch and cache secret names for all enabled providers.
   * Runs in background — failures are silently ignored.
   */
  async prefetchSecretNames(providers: SecretProvider[], variables: Map<string, string>): Promise<void> {
    for (const p of providers) {
      if (p.disabled) continue;
      try {
        await this.listSecretNames(p, variables);
      } catch { /* skip unavailable vaults */ }
    }
  }

  /** Clear only the secret names cache (e.g. on environment change). */
  clearSecretNamesCache(): void {
    _secretNamesCache.clear();
  }

  clearCache(): void {
    _azTokenCache = undefined;
    _secretCache.clear();
    _secretNamesCache.clear();
  }

  dispose(): void {
    this.clearCache();
  }
}
