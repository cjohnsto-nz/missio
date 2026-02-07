import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type { AuthOAuth2 } from '../models/types';

/**
 * Stored token data from an OAuth2 token endpoint response.
 */
export interface OAuth2TokenData {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  created_at: number;
}

/**
 * OAuth2 token service.
 *
 * Tokens are stored securely in VS Code's SecretStorage, keyed by:
 *   missio:oauth2:{collectionId}:{envName}:{accessTokenUrl}:{credentialsId}
 *
 * Changing environment = different key = different token.
 */
export class OAuth2Service implements vscode.Disposable {
  constructor(private readonly _secrets: vscode.SecretStorage) {}

  /**
   * Get a valid access token for the given OAuth2 config.
   * Will auto-fetch or refresh as needed based on config settings.
   *
   * @param auth - The OAuth2 auth config (with variables already interpolated)
   * @param collectionId - Collection identifier
   * @param envName - Active environment name (for scoping tokens)
   */
  async getToken(
    auth: AuthOAuth2,
    collectionId: string,
    envName: string | undefined,
  ): Promise<string | null> {
    const flow = auth.flow ?? 'client_credentials';
    const accessTokenUrl = auth.accessTokenUrl;
    if (!accessTokenUrl) {
      throw new Error('OAuth2: Access Token URL is required');
    }

    const credentialsId = auth.credentialsId ?? 'default';
    const autoFetchToken = auth.autoFetchToken !== false; // default true
    const autoRefreshToken = auth.autoRefreshToken !== false; // default true
    const storageKey = this._buildKey(collectionId, envName, accessTokenUrl, credentialsId);

    // 1. Check for stored token
    const stored = await this._loadToken(storageKey);
    if (stored) {
      if (!this._isExpired(stored)) {
        return stored.access_token;
      }

      // Token expired — try refresh
      if (autoRefreshToken && stored.refresh_token) {
        try {
          const refreshed = await this._refreshToken(auth, stored.refresh_token);
          await this._saveToken(storageKey, refreshed);
          return refreshed.access_token;
        } catch {
          // Refresh failed — clear and re-fetch if allowed
          await this._deleteToken(storageKey);
        }
      } else {
        await this._deleteToken(storageKey);
      }

      if (!autoFetchToken) {
        return null;
      }
    } else if (!autoFetchToken) {
      return null;
    }

    // 2. Fetch new token
    let tokenData: OAuth2TokenData;
    switch (flow) {
      case 'client_credentials':
        tokenData = await this._fetchClientCredentials(auth);
        break;
      case 'password':
        tokenData = await this._fetchPassword(auth);
        break;
      case 'authorization_code':
        throw new Error('OAuth2: Authorization Code flow is not yet supported in Missio');
      default:
        throw new Error(`OAuth2: Unsupported flow: ${flow}`);
    }

    await this._saveToken(storageKey, tokenData);
    return tokenData.access_token;
  }

  /**
   * Clear stored token for a specific config.
   */
  async clearToken(
    collectionId: string,
    envName: string | undefined,
    accessTokenUrl: string,
    credentialsId?: string,
  ): Promise<void> {
    const key = this._buildKey(collectionId, envName, accessTokenUrl, credentialsId ?? 'default');
    await this._deleteToken(key);
  }

  /**
   * Clear all tokens for a collection+environment.
   */
  async clearAllTokens(_collectionId: string, _envName: string | undefined): Promise<void> {
    // SecretStorage doesn't support listing keys, so we can only clear known keys.
    // For now, this is a no-op placeholder. Individual tokens are cleared via clearToken.
  }

  /**
   * Check the status of a stored token without fetching.
   */
  async getTokenStatus(
    collectionId: string,
    envName: string | undefined,
    accessTokenUrl: string,
    credentialsId?: string,
  ): Promise<{ hasToken: boolean; expiresAt?: number; isExpired?: boolean; timeRemaining?: number }> {
    const key = this._buildKey(collectionId, envName, accessTokenUrl, credentialsId ?? 'default');
    const token = await this._loadToken(key);
    if (!token) {
      return { hasToken: false };
    }
    const expiresAt = token.expires_in && token.created_at
      ? token.created_at + token.expires_in * 1000
      : undefined;
    const isExpired = this._isExpired(token);
    const timeRemaining = expiresAt ? Math.max(0, expiresAt - Date.now()) : undefined;
    return { hasToken: true, expiresAt, isExpired, timeRemaining };
  }

  dispose(): void {}

  // ── Private: Storage ────────────────────────────────────────────────

  private _buildKey(collectionId: string, envName: string | undefined, url: string, credentialsId: string): string {
    return `missio:oauth2:${collectionId}:${envName ?? '_none_'}:${url}:${credentialsId}`;
  }

  private async _loadToken(key: string): Promise<OAuth2TokenData | null> {
    try {
      const raw = await this._secrets.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as OAuth2TokenData;
    } catch {
      return null;
    }
  }

  private async _saveToken(key: string, token: OAuth2TokenData): Promise<void> {
    await this._secrets.store(key, JSON.stringify(token));
  }

  private async _deleteToken(key: string): Promise<void> {
    await this._secrets.delete(key);
  }

  private _isExpired(token: OAuth2TokenData): boolean {
    if (!token.expires_in || !token.created_at) {
      return false; // No expiration info — assume valid
    }
    const expiryMs = token.created_at + token.expires_in * 1000;
    // Expire 30 seconds early to avoid edge cases
    return Date.now() > (expiryMs - 30_000);
  }

  // ── Private: Token Fetch ────────────────────────────────────────────

  private async _fetchClientCredentials(auth: AuthOAuth2): Promise<OAuth2TokenData> {
    if (!auth.clientId) {
      throw new Error('OAuth2: Client ID is required for client_credentials flow');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };

    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');

    if (auth.scope) {
      params.set('scope', auth.scope);
    }

    const placement = auth.credentialsPlacement ?? 'basic_auth_header';
    if (placement === 'basic_auth_header') {
      const secret = auth.clientSecret ?? '';
      headers['Authorization'] = `Basic ${Buffer.from(`${auth.clientId}:${secret}`).toString('base64')}`;
    } else {
      params.set('client_id', auth.clientId);
      if (auth.clientSecret) {
        params.set('client_secret', auth.clientSecret);
      }
    }

    return this._postTokenRequest(auth.accessTokenUrl!, headers, params.toString());
  }

  private async _fetchPassword(auth: AuthOAuth2): Promise<OAuth2TokenData> {
    if (!auth.clientId) throw new Error('OAuth2: Client ID is required for password flow');
    if (!auth.username) throw new Error('OAuth2: Username is required for password flow');
    if (!auth.password) throw new Error('OAuth2: Password is required for password flow');

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };

    const params = new URLSearchParams();
    params.set('grant_type', 'password');
    params.set('username', auth.username);
    params.set('password', auth.password);

    if (auth.scope) {
      params.set('scope', auth.scope);
    }

    const placement = auth.credentialsPlacement ?? 'basic_auth_header';
    if (placement === 'basic_auth_header') {
      const secret = auth.clientSecret ?? '';
      headers['Authorization'] = `Basic ${Buffer.from(`${auth.clientId}:${secret}`).toString('base64')}`;
    } else {
      params.set('client_id', auth.clientId);
      if (auth.clientSecret) {
        params.set('client_secret', auth.clientSecret);
      }
    }

    return this._postTokenRequest(auth.accessTokenUrl!, headers, params.toString());
  }

  private async _refreshToken(auth: AuthOAuth2, refreshToken: string): Promise<OAuth2TokenData> {
    const url = auth.refreshTokenUrl ?? auth.accessTokenUrl;
    if (!url) throw new Error('OAuth2: No URL available for token refresh');

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };

    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);

    if (auth.clientId) {
      const placement = auth.credentialsPlacement ?? 'basic_auth_header';
      if (placement === 'basic_auth_header') {
        const secret = auth.clientSecret ?? '';
        headers['Authorization'] = `Basic ${Buffer.from(`${auth.clientId}:${secret}`).toString('base64')}`;
      } else {
        params.set('client_id', auth.clientId);
        if (auth.clientSecret) {
          params.set('client_secret', auth.clientSecret);
        }
      }
    }

    return this._postTokenRequest(url, headers, params.toString());
  }

  // ── Private: HTTP ───────────────────────────────────────────────────

  private _postTokenRequest(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<OAuth2TokenData> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const mod = isHttps ? https : http;

      const options: http.RequestOptions = {
        method: 'POST',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      };

      const req = mod.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            const data = JSON.parse(raw);
            if (data.error) {
              reject(new Error(`OAuth2 error: ${data.error} — ${data.error_description ?? ''}`));
              return;
            }
            if (!data.access_token) {
              reject(new Error(`OAuth2: No access_token in response. Body: ${raw.substring(0, 200)}`));
              return;
            }
            const tokenData: OAuth2TokenData = {
              access_token: data.access_token,
              token_type: data.token_type,
              expires_in: data.expires_in,
              refresh_token: data.refresh_token,
              scope: data.scope,
              created_at: Date.now(),
            };
            resolve(tokenData);
          } catch {
            reject(new Error(`OAuth2: Failed to parse token response. Status: ${res.statusCode}. Body: ${raw.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`OAuth2: Token request failed — ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('OAuth2: Token request timed out'));
      });
      req.setTimeout(15_000);
      req.write(body);
      req.end();
    });
  }
}
