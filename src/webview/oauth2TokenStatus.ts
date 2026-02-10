export interface OAuth2TokenStatusController {
  requestStatus: () => void;
  handleStatus: (status: any) => void;
  handleProgress: (message: string) => void;
  dispose: () => void;
}

export interface OAuth2TokenStatusControllerOptions {
  /** Element id prefix used by authFields.ts (e.g. 'auth' or 'dAuth') */
  prefix: string;
  /** Build the current oauth2 auth object from the form */
  buildAuth: () => any;
  /** postMessage bridge to extension host */
  postMessage: (msg: any) => void;
  /** HTML escape */
  esc: (s: string) => string;
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function initOAuth2TokenStatusController(opts: OAuth2TokenStatusControllerOptions): OAuth2TokenStatusController {
  const containerId = `${opts.prefix}OAuth2TokenStatus`;
  let tokenStatusTimer: any = null;
  let lastStatus: any = null;

  function getContainer(): HTMLElement | null {
    return document.getElementById(containerId);
  }

  function clearTimer() {
    if (tokenStatusTimer) {
      clearInterval(tokenStatusTimer);
      tokenStatusTimer = null;
    }
  }

  function requestStatus() {
    const auth = opts.buildAuth();
    if (!auth || auth.type !== 'oauth2' || !auth.accessTokenUrl) return;
    opts.postMessage({ type: 'getTokenStatus', auth });
  }

  function renderStatus(status: any) {
    const el = getContainer();
    if (!el) return;

    if (!status?.hasToken) {
      el.innerHTML = '<div class="token-status-text token-none">' +
        '<span class="token-dot dot-none"></span> No token</div>';
      return;
    }

    const now = Date.now();
    const remaining = status.expiresAt ? status.expiresAt - now : undefined;
    const isExpired = remaining !== undefined && remaining <= 0;
    const dotClass = isExpired ? 'dot-expired' : 'dot-valid';
    const label = isExpired
      ? 'Expired'
      : remaining !== undefined
        ? `Expires in ${formatTimeRemaining(remaining)}`
        : 'Valid (no expiry)';
    const expiresAt = status.expiresAt ? new Date(status.expiresAt).toLocaleTimeString() : '';

    el.innerHTML = '<div class="token-status-text ' + (isExpired ? 'token-expired' : 'token-valid') + '">' +
      '<span class="token-dot ' + dotClass + '"></span> ' + label +
      (expiresAt ? '<span class="token-expiry-time"> (' + opts.esc(expiresAt) + ')</span>' : '') +
      '</div>';
  }

  function handleStatus(status: any) {
    lastStatus = status;
    clearTimer();
    renderStatus(status);

    if (status?.expiresAt) {
      tokenStatusTimer = setInterval(() => {
        renderStatus(lastStatus);
        if (lastStatus?.expiresAt && Date.now() > lastStatus.expiresAt) {
          clearTimer();
        }
      }, 1000);
    }
  }

  function handleProgress(message: string) {
    const el = getContainer();
    if (!el) return;
    if (!message) return;

    clearTimer();
    const isError = message.startsWith('Error:');
    el.innerHTML = '<div class="token-status-text ' + (isError ? 'token-error' : 'token-progress') + '">' +
      (isError ? '<span class="token-dot dot-expired"></span> ' : '<span class="token-spinner"></span> ') +
      opts.esc(message) + '</div>';
  }

  function dispose() {
    clearTimer();
  }

  return { requestStatus, handleStatus, handleProgress, dispose };
}
