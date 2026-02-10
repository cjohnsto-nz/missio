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
  /** Optional: called after fields are rendered, receives all new contenteditable value elements */
  onFieldsRendered?: (elements: HTMLElement[]) => void;
  /** Whether to show the token status area for OAuth2 */
  showTokenStatus: boolean;
  /** ID of the auth type select element (needed to build auth data for token actions) */
  authTypeSelectId?: string;
  /** postMessage bridge for token actions (get/refresh/delete) */
  postMessage?: (msg: any) => void;
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
  if (type === 'password') {
    const input = `<input type="password" id="${id}" placeholder="${placeholder}" />`;
    return wrap ? `<span class="auth-input-wrap">${input}</span>` : input;
  }
  // Text fields use contenteditable divs for live variable highlighting
  return `<div class="auth-val-ce" id="${id}" contenteditable="true" data-placeholder="${placeholder}"></div>`;
}

// In-session cache: preserves auth field values when switching between auth types.
// Keyed by prefix → auth type → auth data object.
const _authCache: Record<string, Record<string, any>> = {};

/** Detect which auth type is currently rendered by checking for known element IDs. */
function _detectCurrentAuthType(prefix: string): string | null {
  if (document.getElementById(prefix + 'Token')) return 'bearer';
  if (document.getElementById(prefix + 'Username') && !document.getElementById(prefix + 'OAuth2Flow')) return 'basic';
  if (document.getElementById(prefix + 'Key')) return 'apikey';
  if (document.getElementById(prefix + 'OAuth2Flow')) return 'oauth2';
  return null;
}

/** Render the appropriate fields for the given auth type. */
export function renderAuthFields(type: string, config: AuthFieldsConfig): void {
  const { prefix: p, fieldsContainer: fields, onChange, wrapInputs: w, showTokenStatus } = config;

  // Snapshot current auth data before replacing fields
  const prevType = _detectCurrentAuthType(p);
  if (prevType && prevType !== 'none' && prevType !== 'inherit') {
    if (!_authCache[p]) _authCache[p] = {};
    _authCache[p][prevType] = buildAuthData(prevType, p);
  }

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
      `<div id="${p}OAuth2PasswordFields" class="auth-fields-group" style="display:none;">` +
        `<div class="auth-row"><label>Username</label>${inp(p + 'OAuth2Username', '{{username}}', w)}</div>` +
        `<div class="auth-row"><label>Password</label>${inp(p + 'OAuth2Password', 'password', w, 'password')}</div>` +
      `</div>` +
      `<div id="${p}OAuth2AuthCodeFields" class="auth-fields-group" style="display:none;">` +
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
      (showTokenStatus
        ? `<div class="auth-token-actions">` +
            `<button class="auth-btn auth-btn-get" id="${p}OAuth2GetTokenBtn">Get Token</button>` +
            `<button class="auth-btn auth-btn-refresh" id="${p}OAuth2RefreshTokenBtn" style="display:none">Refresh</button>` +
            `<button class="auth-btn auth-btn-delete" id="${p}OAuth2DeleteTokenBtn" style="display:none">Delete</button>` +
          `</div>` +
          `<div class="oauth2-token-status" id="${p}OAuth2TokenStatus"></div>`
        : '');

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

    if (showTokenStatus && config.postMessage && config.authTypeSelectId) {
      const getAuthData = () => buildAuthData(
        (document.getElementById(config.authTypeSelectId!) as HTMLSelectElement).value, p
      );
      const getBtn = document.getElementById(p + 'OAuth2GetTokenBtn');
      const refreshBtn = document.getElementById(p + 'OAuth2RefreshTokenBtn');
      const deleteBtn = document.getElementById(p + 'OAuth2DeleteTokenBtn');
      if (getBtn) getBtn.addEventListener('click', () => config.postMessage!({ type: 'getToken', auth: getAuthData() }));
      if (refreshBtn) refreshBtn.addEventListener('click', () => config.postMessage!({ type: 'getToken', auth: getAuthData() }));
      if (deleteBtn) deleteBtn.addEventListener('click', () => config.postMessage!({ type: 'deleteToken', auth: getAuthData() }));
    }
  }

  // Wire change listeners for password inputs and selects
  fields.querySelectorAll('input').forEach(el => {
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  });
  fields.querySelectorAll('select').forEach(el => el.addEventListener('change', onChange));

  // Notify caller of new contenteditable value elements
  if (config.onFieldsRendered) {
    const ceElements = Array.from(fields.querySelectorAll<HTMLElement>('.auth-val-ce'));
    config.onFieldsRendered(ceElements);
  }

  // Restore cached auth data if available (preserves values when switching between types)
  const cached = _authCache[p]?.[type];
  if (cached) {
    loadAuthData(cached, p);
  }
}

/** Read the raw text from a contenteditable auth field. */
function ceVal(id: string): string {
  const el = document.getElementById(id) as any;
  if (!el) return '';
  return el._getRawText ? el._getRawText() : (el.textContent || '');
}

/** Build auth data object from the current form state. Returns the auth value for the YAML. */
export function buildAuthData(type: string, prefix: string): any {
  const p = prefix;
  const $el = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement | null;

  switch (type) {
    case 'bearer':
      return { type: 'bearer', token: ceVal(p + 'Token') };
    case 'basic':
      return { type: 'basic', username: ceVal(p + 'Username'), password: $el(p + 'Password')?.value || '' };
    case 'apikey':
      return { type: 'apikey', key: ceVal(p + 'Key'), value: ceVal(p + 'Value'), placement: $sel(p + 'Placement')?.value || 'header' };
    case 'oauth2': {
      const flow = $sel(p + 'OAuth2Flow')?.value || 'client_credentials';
      const auth: any = {
        type: 'oauth2', flow,
        accessTokenUrl: ceVal(p + 'OAuth2AccessTokenUrl'),
        clientId: ceVal(p + 'OAuth2ClientId'),
        clientSecret: ceVal(p + 'OAuth2ClientSecret'),
        scope: ceVal(p + 'OAuth2Scope'),
        refreshTokenUrl: ceVal(p + 'OAuth2RefreshTokenUrl'),
        credentialsPlacement: $sel(p + 'OAuth2CredentialsPlacement')?.value || 'basic_auth_header',
        autoFetchToken: ($el(p + 'OAuth2AutoFetch') as HTMLInputElement)?.checked !== false,
        autoRefreshToken: ($el(p + 'OAuth2AutoRefresh') as HTMLInputElement)?.checked !== false,
      };
      if (flow === 'password') {
        auth.username = ceVal(p + 'OAuth2Username');
        auth.password = $el(p + 'OAuth2Password')?.value || '';
      } else if (flow === 'authorization_code') {
        auth.authorizationUrl = ceVal(p + 'OAuth2AuthorizationUrl');
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

/** Set the raw text of a contenteditable auth field and re-highlight. */
function ceSet(id: string, value: string): void {
  const el = document.getElementById(id) as any;
  if (!el) return;
  if (el._setRawText) {
    el._setRawText(value);
    if (el._syncHighlight) el._syncHighlight();
  } else {
    el.textContent = value;
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
      ceSet(p + 'Token', auth.token || '');
      break;
    }
    case 'basic': {
      ceSet(p + 'Username', auth.username || '');
      const pw = $el(p + 'Password'); if (pw) pw.value = auth.password || '';
      break;
    }
    case 'apikey': {
      ceSet(p + 'Key', auth.key || '');
      ceSet(p + 'Value', auth.value || '');
      const pl = $sel(p + 'Placement'); if (pl) pl.value = auth.placement || 'header';
      break;
    }
    case 'oauth2': {
      const fl = $sel(p + 'OAuth2Flow');
      if (fl) { fl.value = auth.flow || 'client_credentials'; fl.dispatchEvent(new Event('change')); }
      ceSet(p + 'OAuth2AccessTokenUrl', auth.accessTokenUrl || '');
      ceSet(p + 'OAuth2ClientId', auth.clientId || '');
      ceSet(p + 'OAuth2ClientSecret', auth.clientSecret || '');
      ceSet(p + 'OAuth2Scope', auth.scope || '');
      ceSet(p + 'OAuth2RefreshTokenUrl', auth.refreshTokenUrl || '');
      const cp = $sel(p + 'OAuth2CredentialsPlacement'); if (cp) cp.value = auth.credentialsPlacement || 'basic_auth_header';
      const af = $el(p + 'OAuth2AutoFetch') as HTMLInputElement; if (af) af.checked = auth.autoFetchToken !== false;
      const ar = $el(p + 'OAuth2AutoRefresh') as HTMLInputElement; if (ar) ar.checked = auth.autoRefreshToken !== false;
      if (auth.flow === 'password') {
        ceSet(p + 'OAuth2Username', auth.username || '');
        const pw = $el(p + 'OAuth2Password'); if (pw) pw.value = auth.password || '';
      } else if (auth.flow === 'authorization_code') {
        ceSet(p + 'OAuth2AuthorizationUrl', auth.authorizationUrl || '');
        const pk = $el(p + 'OAuth2Pkce') as HTMLInputElement; if (pk) pk.checked = auth.pkce !== false;
      }
      break;
    }
  }
}
