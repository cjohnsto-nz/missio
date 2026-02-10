/**
 * Shared auth UI module used by request, folder, and collection editors.
 * Centralizes auth type options, field rendering, data building, and data loading.
 */

export interface AuthFieldsConfig {
  /** ID prefix for all generated elements (e.g. 'auth' or 'dAuth') */
  prefix: string;
  /** The container element to render fields into */
  fieldsContainer: HTMLElement;
  /** Called when any field changes */
  onChange: () => void;
  /** Whether to include the "Inherit" option */
  showInherit: boolean;
  /** Whether to wrap text inputs in auth-input-wrap spans (for variable overlays) */
  wrapInputs: boolean;
  /** Optional: called after fields are rendered, receives all new text inputs */
  onFieldsRendered?: (inputs: HTMLInputElement[]) => void;
  /** Whether to show the token status area for OAuth2 */
  showTokenStatus: boolean;
}

/** Returns the HTML for the auth type <select> options. */
export function authTypeOptionsHtml(showInherit: boolean): string {
  return '<option value="none">No Auth</option>' +
    (showInherit ? '<option value="inherit">Inherit</option>' : '') +
    '<option value="bearer">Bearer Token</option>' +
    '<option value="basic">Basic Auth</option>' +
    '<option value="apikey">API Key</option>' +
    '<option value="oauth2">OAuth 2.0</option>';
}

function inp(id: string, placeholder: string, wrap: boolean, type: string = 'text'): string {
  const input = `<input type="${type}" id="${id}" placeholder="${placeholder}" />`;
  return wrap ? `<span class="auth-input-wrap">${input}</span>` : input;
}

/** Render the appropriate fields for the given auth type. */
export function renderAuthFields(type: string, config: AuthFieldsConfig): void {
  const { prefix: p, fieldsContainer: fields, onChange, wrapInputs: w, showTokenStatus } = config;
  fields.innerHTML = '';

  if (type === 'bearer') {
    fields.innerHTML =
      `<div class="auth-row"><label>Token</label>${inp(p + 'Token', '{{token}}', w)}</div>`;
  } else if (type === 'basic') {
    fields.innerHTML =
      `<div class="auth-row"><label>Username</label>${inp(p + 'Username', 'username', w)}</div>` +
      `<div class="auth-row"><label>Password</label>${inp(p + 'Password', 'password', w, 'password')}</div>`;
  } else if (type === 'apikey') {
    fields.innerHTML =
      `<div class="auth-row"><label>Key</label>${inp(p + 'Key', 'X-Api-Key', w)}</div>` +
      `<div class="auth-row"><label>Value</label>${inp(p + 'Value', '{{apiKey}}', w)}</div>` +
      `<div class="auth-row"><label>In</label><select id="${p}Placement" class="auth-select"><option value="header">Header</option><option value="query">Query</option></select></div>`;
  } else if (type === 'oauth2') {
    fields.innerHTML =
      `<div class="auth-row"><label>Grant Type</label>` +
        `<select id="${p}OAuth2Flow" class="auth-select">` +
          `<option value="client_credentials">Client Credentials</option>` +
          `<option value="password">Password</option>` +
          `<option value="authorization_code">Authorization Code</option>` +
        `</select></div>` +
      `<div class="auth-row"><label>Access Token URL</label>${inp(p + 'OAuth2AccessTokenUrl', '{{authUrl}}/token', w)}</div>` +
      `<div class="auth-row"><label>Client ID</label>${inp(p + 'OAuth2ClientId', '{{clientId}}', w)}</div>` +
      `<div class="auth-row"><label>Client Secret</label>${inp(p + 'OAuth2ClientSecret', '{{clientSecret}}', w)}</div>` +
      `<div class="auth-row"><label>Scope</label>${inp(p + 'OAuth2Scope', 'openid profile', w)}</div>` +
      `<div id="${p}OAuth2PasswordFields" style="display:none;">` +
        `<div class="auth-row"><label>Username</label>${inp(p + 'OAuth2Username', '{{username}}', w)}</div>` +
        `<div class="auth-row"><label>Password</label>${inp(p + 'OAuth2Password', 'password', w, 'password')}</div>` +
      `</div>` +
      `<div id="${p}OAuth2AuthCodeFields" style="display:none;">` +
        `<div class="auth-row"><label>Auth URL</label>${inp(p + 'OAuth2AuthorizationUrl', '{{authUrl}}/authorize', w)}</div>` +
        `<div class="auth-row"><label>PKCE</label><input type="checkbox" id="${p}OAuth2Pkce" checked /></div>` +
      `</div>` +
      `<div class="auth-row"><label>Refresh URL</label>${inp(p + 'OAuth2RefreshTokenUrl', '(optional)', w)}</div>` +
      `<div class="auth-row"><label>Credentials In</label>` +
        `<select id="${p}OAuth2CredentialsPlacement" class="auth-select">` +
          `<option value="basic_auth_header">Header</option>` +
          `<option value="body">Body</option>` +
        `</select></div>` +
      `<div class="auth-row"><label>Auto Fetch</label><input type="checkbox" id="${p}OAuth2AutoFetch" checked /></div>` +
      `<div class="auth-row"><label>Auto Refresh</label><input type="checkbox" id="${p}OAuth2AutoRefresh" checked /></div>` +
      (showTokenStatus ? `<div class="oauth2-token-status" id="${p}OAuth2TokenStatus"></div>` : '');

    const flowSelect = document.getElementById(p + 'OAuth2Flow') as HTMLSelectElement;
    const pwFields = document.getElementById(p + 'OAuth2PasswordFields')!;
    const acFields = document.getElementById(p + 'OAuth2AuthCodeFields')!;
    const updateFlowFields = () => {
      const flow = flowSelect.value;
      pwFields.style.display = flow === 'password' ? '' : 'none';
      acFields.style.display = flow === 'authorization_code' ? '' : 'none';
    };
    flowSelect.addEventListener('change', () => { updateFlowFields(); onChange(); });
    updateFlowFields();
  }

  // Wire change listeners
  fields.querySelectorAll('input').forEach(el => {
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  });
  fields.querySelectorAll('select').forEach(el => el.addEventListener('change', onChange));

  // Notify caller of new text inputs (for variable overlays etc.)
  if (config.onFieldsRendered) {
    const textInputs = Array.from(fields.querySelectorAll<HTMLInputElement>('input[type="text"]'));
    config.onFieldsRendered(textInputs);
  }
}

/** Build auth data object from the current form state. Returns the auth value for the YAML. */
export function buildAuthData(type: string, prefix: string): any {
  const p = prefix;
  const $el = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement | null;

  switch (type) {
    case 'bearer':
      return { type: 'bearer', token: $el(p + 'Token')?.value || '' };
    case 'basic':
      return { type: 'basic', username: $el(p + 'Username')?.value || '', password: $el(p + 'Password')?.value || '' };
    case 'apikey':
      return { type: 'apikey', key: $el(p + 'Key')?.value || '', value: $el(p + 'Value')?.value || '', placement: $sel(p + 'Placement')?.value || 'header' };
    case 'oauth2': {
      const flow = $sel(p + 'OAuth2Flow')?.value || 'client_credentials';
      const auth: any = {
        type: 'oauth2', flow,
        accessTokenUrl: $el(p + 'OAuth2AccessTokenUrl')?.value || '',
        clientId: $el(p + 'OAuth2ClientId')?.value || '',
        clientSecret: $el(p + 'OAuth2ClientSecret')?.value || '',
        scope: $el(p + 'OAuth2Scope')?.value || '',
        refreshTokenUrl: $el(p + 'OAuth2RefreshTokenUrl')?.value || '',
        credentialsPlacement: $sel(p + 'OAuth2CredentialsPlacement')?.value || 'basic_auth_header',
        autoFetchToken: ($el(p + 'OAuth2AutoFetch') as HTMLInputElement)?.checked !== false,
        autoRefreshToken: ($el(p + 'OAuth2AutoRefresh') as HTMLInputElement)?.checked !== false,
      };
      if (flow === 'password') {
        auth.username = $el(p + 'OAuth2Username')?.value || '';
        auth.password = $el(p + 'OAuth2Password')?.value || '';
      } else if (flow === 'authorization_code') {
        auth.authorizationUrl = $el(p + 'OAuth2AuthorizationUrl')?.value || '';
        auth.pkce = ($el(p + 'OAuth2Pkce') as HTMLInputElement)?.checked !== false;
      }
      // Remove empty optional fields to keep YAML clean
      if (!auth.refreshTokenUrl) delete auth.refreshTokenUrl;
      if (!auth.scope) delete auth.scope;
      if (!auth.clientSecret) delete auth.clientSecret;
      return auth;
    }
    case 'inherit':
      return 'inherit';
    default:
      return undefined; // 'none' — delete auth
  }
}

/** Populate auth fields from a loaded auth data object. Call after renderAuthFields. */
export function loadAuthData(auth: any, prefix: string): void {
  const p = prefix;
  const $el = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement | null;

  if (!auth || auth === 'inherit') return;
  if (typeof auth !== 'object' || !auth.type) return;

  switch (auth.type) {
    case 'bearer': {
      const el = $el(p + 'Token'); if (el) el.value = auth.token || '';
      break;
    }
    case 'basic': {
      const u = $el(p + 'Username'); if (u) u.value = auth.username || '';
      const pw = $el(p + 'Password'); if (pw) pw.value = auth.password || '';
      break;
    }
    case 'apikey': {
      const k = $el(p + 'Key'); if (k) k.value = auth.key || '';
      const v = $el(p + 'Value'); if (v) v.value = auth.value || '';
      const pl = $sel(p + 'Placement'); if (pl) pl.value = auth.placement || 'header';
      break;
    }
    case 'oauth2': {
      const fl = $sel(p + 'OAuth2Flow');
      if (fl) { fl.value = auth.flow || 'client_credentials'; fl.dispatchEvent(new Event('change')); }
      const atu = $el(p + 'OAuth2AccessTokenUrl'); if (atu) atu.value = auth.accessTokenUrl || '';
      const ci = $el(p + 'OAuth2ClientId'); if (ci) ci.value = auth.clientId || '';
      const cs = $el(p + 'OAuth2ClientSecret'); if (cs) cs.value = auth.clientSecret || '';
      const sc = $el(p + 'OAuth2Scope'); if (sc) sc.value = auth.scope || '';
      const rtu = $el(p + 'OAuth2RefreshTokenUrl'); if (rtu) rtu.value = auth.refreshTokenUrl || '';
      const cp = $sel(p + 'OAuth2CredentialsPlacement'); if (cp) cp.value = auth.credentialsPlacement || 'basic_auth_header';
      const af = $el(p + 'OAuth2AutoFetch') as HTMLInputElement; if (af) af.checked = auth.autoFetchToken !== false;
      const ar = $el(p + 'OAuth2AutoRefresh') as HTMLInputElement; if (ar) ar.checked = auth.autoRefreshToken !== false;
      if (auth.flow === 'password') {
        const un = $el(p + 'OAuth2Username'); if (un) un.value = auth.username || '';
        const pw = $el(p + 'OAuth2Password'); if (pw) pw.value = auth.password || '';
      } else if (auth.flow === 'authorization_code') {
        const au = $el(p + 'OAuth2AuthorizationUrl'); if (au) au.value = auth.authorizationUrl || '';
        const pk = $el(p + 'OAuth2Pkce') as HTMLInputElement; if (pk) pk.checked = auth.pkce !== false;
      }
      break;
    }
  }
}
