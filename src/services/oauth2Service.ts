import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
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
    const autoFetchToken = auth.settings?.autoFetchToken !== false; // default true
    const autoRefreshToken = auth.settings?.autoRefreshToken !== false; // default true
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
      case 'resource_owner_password_credentials':
        tokenData = await this._fetchPassword(auth as any);
        break;
      case 'authorization_code':
        tokenData = await this._fetchAuthorizationCode(auth as any);
        break;
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
    const creds = auth.credentials;
    if (!creds?.clientId) {
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

    this._applyCredentials(creds, headers, params);

    return this._postTokenRequest(auth.accessTokenUrl!, headers, params.toString());
  }

  private async _fetchPassword(auth: import('../models/types').AuthOAuth2ResourceOwnerPassword): Promise<OAuth2TokenData> {
    const creds = auth.credentials;
    const owner = auth.resourceOwner;
    if (!creds?.clientId) throw new Error('OAuth2: Client ID is required for password flow');
    if (!owner?.username) throw new Error('OAuth2: Username is required for password flow');
    if (!owner?.password) throw new Error('OAuth2: Password is required for password flow');

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };

    const params = new URLSearchParams();
    params.set('grant_type', 'password');
    params.set('username', owner.username);
    params.set('password', owner.password);

    if (auth.scope) {
      params.set('scope', auth.scope);
    }

    this._applyCredentials(creds, headers, params);

    return this._postTokenRequest(auth.accessTokenUrl!, headers, params.toString());
  }

  private async _fetchAuthorizationCode(auth: import('../models/types').AuthOAuth2AuthorizationCode): Promise<OAuth2TokenData> {
    const creds = auth.credentials;
    if (!creds?.clientId) throw new Error('OAuth2: Client ID is required for authorization_code flow');
    if (!auth.authorizationUrl) throw new Error('OAuth2: Authorization URL is required for authorization_code flow');

    const usePkce = auth.pkce?.enabled !== false; // default true for auth code flow
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;

    if (usePkce) {
      // Generate PKCE code_verifier (43–128 chars, URL-safe)
      codeVerifier = crypto.randomBytes(32).toString('base64url');
      // S256 challenge
      codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    }

    const state = crypto.randomBytes(16).toString('hex');

    // Start a temporary local HTTP server to receive the callback, with cancel support
    const { code, callbackUrl } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'OAuth2: Waiting for browser authorization…',
        cancellable: true,
      },
      (_progress, cancelToken) => this._waitForAuthorizationCode(auth, state, codeChallenge, cancelToken),
    );

    // Exchange authorization code for tokens
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };

    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', callbackUrl);

    if (usePkce && codeVerifier) {
      params.set('code_verifier', codeVerifier);
    }

    this._applyCredentials(creds, headers, params);

    return this._postTokenRequest(auth.accessTokenUrl!, headers, params.toString());
  }

  /**
   * Start a local HTTP server on a random port, open the browser to the
   * authorization URL, and wait for the redirect callback with the code.
   */
  private _waitForAuthorizationCode(
    auth: import('../models/types').AuthOAuth2AuthorizationCode,
    state: string,
    codeChallenge?: string,
    cancelToken?: vscode.CancellationToken,
  ): Promise<{ code: string; callbackUrl: string }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const cleanup = () => { clearTimeout(timer); server.close(); };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('OAuth2: Authorization timed out (120s). No callback received.'));
      }, 120_000);

      // Cancel support
      if (cancelToken) {
        cancelToken.onCancellationRequested(() => {
          cleanup();
          reject(new Error('OAuth2: Authorization cancelled by user.'));
        });
      }

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        const callbackUrl = `http://localhost:${addr.port}`;

        // Build authorization URL
        const authUrl = new URL(auth.authorizationUrl!);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', auth.credentials?.clientId ?? '');
        authUrl.searchParams.set('redirect_uri', callbackUrl);
        authUrl.searchParams.set('state', state);
        if (auth.scope) authUrl.searchParams.set('scope', auth.scope);
        if (codeChallenge) {
          authUrl.searchParams.set('code_challenge', codeChallenge);
          authUrl.searchParams.set('code_challenge_method', 'S256');
        }

        // Open browser
        vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

        server.on('request', (req, res) => {
          const reqUrl = new URL(req.url ?? '/', `http://localhost:${addr.port}`);

          const error = reqUrl.searchParams.get('error');
          if (error) {
            const desc = reqUrl.searchParams.get('error_description') ?? '';
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this._callbackHtml(false, `Authorization denied: ${error} — ${desc}`));
            cleanup();
            reject(new Error(`OAuth2: Authorization denied — ${error}: ${desc}`));
            return;
          }

          const code = reqUrl.searchParams.get('code');
          const returnedState = reqUrl.searchParams.get('state');

          if (!code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this._callbackHtml(false, 'No authorization code received.'));
            cleanup();
            reject(new Error('OAuth2: No authorization code in callback'));
            return;
          }

          if (returnedState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this._callbackHtml(false, 'State mismatch — possible CSRF attack.'));
            cleanup();
            reject(new Error('OAuth2: State parameter mismatch'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this._callbackHtml(true, 'Authorization successful! You can close this tab.'));
          cleanup();
          resolve({ code, callbackUrl });
        });
      });

      server.on('error', (err) => {
        cleanup();
        reject(new Error(`OAuth2: Failed to start callback server — ${err.message}`));
      });
    });
  }

  private _callbackHtml(success: boolean, message: string): string {
    const color = success ? '#4ec9b0' : '#f44747';
    const statusIcon = success ? '✓' : '✗';
    // Inline SVG of the Missio logo (extracted from media/icon2.svg)
    const logo = `<svg width="40" height="36" viewBox="0 0 125 114" fill="#ccc" xmlns="http://www.w3.org/2000/svg"><path d="M44.6 20.7C26.3 51.4 16.9 67.2 0.8 94.2a5.8 5.8 47.3 0 0 7.5 8.1c8.9-4.3 17.7-8.7 26.6-13a4.3 4.3 11.5 0 1 5.1 1c6.4 7.3 12.7 14.7 19.1 22a4.6 4.6 180 0 0 6.9 0c6.4-7.3 12.7-14.7 19.1-22a4.3 4.3 168.5 0 1 5.2-1c8.8 4.3 17.5 8.6 26.3 12.9a5.8 5.8 132.7 0 0 7.6-8.2C106.5 64.3 88.8 34.6 71.1 4.8a9.9 9.9 0 0 0-17.1 0c-1.5 2.4-2.9 4.8-4 6.7l-5.4 9.1zm65.4 70.9c-7.5-3.9-13.7-7.3-21.5-11.3a5.7 5.7 50.2 0 1-2.9-3.5c-6.6-22.1-13.1-41.9-19.7-63.8a0.7 0.7 156.6 0 1 1.2-0.5c15.7 26.6 29.1 50.3 44.9 77a1.5 1.5 133.3 0 1-2 2.1zm-50.8 7.5L44.4 82.8a4.6 4.6 76.4 0 1-1-4.2l17.5-65.7a0.7 0.7 7.3 0 1 1.4 0.2l0.5 84.7a2 2 158.8 0 1-3.5 1.4z"/></svg>`;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Missio</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e1e;color:#ccc;}
.card{text-align:center;padding:2.5rem 3rem;border-radius:10px;background:#252526;border:1px solid #333;min-width:300px;}
.logo{margin-bottom:0.5rem;}
.brand{font-size:1.1rem;font-weight:600;color:#888;margin-bottom:1.5rem;letter-spacing:0.05em;}
.status{font-size:2.5rem;color:${color};margin-bottom:0.5rem;}
.msg{font-size:0.95rem;line-height:1.5;}</style></head>
<body><div class="card"><div class="logo">${logo}</div><div class="brand">MISSIO</div><div class="status">${statusIcon}</div><p class="msg">${message}</p></div></body></html>`;
  }

  /** Apply client credentials to headers/params based on placement setting. */
  private _applyCredentials(
    creds: import('../models/types').OAuth2Credentials,
    headers: Record<string, string>,
    params: URLSearchParams,
  ): void {
    const placement = creds.placement ?? 'basic_auth_header';
    if (placement === 'basic_auth_header') {
      const secret = creds.clientSecret ?? '';
      headers['Authorization'] = `Basic ${Buffer.from(`${creds.clientId}:${secret}`).toString('base64')}`;
    } else {
      params.set('client_id', creds.clientId ?? '');
      if (creds.clientSecret) {
        params.set('client_secret', creds.clientSecret);
      }
    }
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

    const creds = auth.credentials;
    if (creds?.clientId) {
      this._applyCredentials(creds, headers, params);
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
