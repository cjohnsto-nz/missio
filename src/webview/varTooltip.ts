export interface VarTooltipContext {
  getResolvedVariables: () => Record<string, string>;
  getVariableSources: () => Record<string, string>;
  getSecretKeys?: () => Set<string>;
  postMessage?: (msg: any) => void;
  onEditVariable?: (name: string) => void;
}

let activeTooltip: HTMLElement | null = null;
let _pendingSecretRef: string | null = null;

function escHtml(s: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function onTooltipOutsideClick(e: MouseEvent): void {
  if (activeTooltip && !activeTooltip.contains(e.target as Node)) {
    hideVarTooltip();
  }
}

export function hideVarTooltip(): void {
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
  _pendingSecretRef = null;
  document.removeEventListener('click', onTooltipOutsideClick);
}

/** Called when the extension host responds with a resolved secret value. */
export function handleSecretValueResolved(msg: { secretRef: string; value?: string; error?: string }): void {
  if (!activeTooltip || msg.secretRef !== _pendingSecretRef) return;
  const valueEl = activeTooltip.querySelector('.var-secret-value') as HTMLElement;
  const revealBtn = activeTooltip.querySelector('.var-action-btn[data-action="reveal"]') as HTMLElement;

  if (msg.error) {
    if (valueEl) {
      valueEl.textContent = msg.error;
      valueEl.style.color = '#f48771';
      valueEl.style.fontStyle = 'normal';
    }
    if (revealBtn) revealBtn.textContent = 'Reveal Value';
    return;
  }

  const val = msg.value ?? '';
  _resolvedSecretValue = val;

  // Show revealed value immediately
  if (valueEl) {
    valueEl.textContent = val;
    valueEl.style.cssText = '';
  }
  if (revealBtn) revealBtn.textContent = 'Hide Value';
  _secretRevealed = true;

  // Update copy button
  const copyBtn = activeTooltip.querySelector('.var-action-btn[data-action="copy"]') as HTMLElement;
  if (copyBtn) {
    copyBtn.textContent = 'Copy Value';
    copyBtn.dataset.secretValue = val;
  }
}

let _resolvedSecretValue: string | null = null;
let _secretRevealed = false;

export function showVarTooltipAt(anchorEl: HTMLElement, varName: string, ctx: VarTooltipContext): void {
  hideVarTooltip();
  _resolvedSecretValue = null;
  _secretRevealed = false;

  const rect = anchorEl.getBoundingClientRect();
  const vars = ctx.getResolvedVariables();
  const sources = ctx.getVariableSources();
  const secretKeys = ctx.getSecretKeys?.() ?? new Set<string>();
  const resolved = varName in vars;
  const isSecret = secretKeys.has(varName);
  const source = sources[varName] || (isSecret ? 'secret' : 'unknown');
  const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1);
  const isKnown = resolved || isSecret;

  const tooltip = document.createElement('div');
  tooltip.className = 'var-tooltip';

  // Build value section
  let valueHtml: string;
  if (resolved) {
    valueHtml =
      "<div class='var-source tk-src-" + escHtml(source) + "'>" + escHtml(sourceLabel) + "</div>" +
      "<div class='var-value'>" + escHtml(vars[varName]) + "</div>";
  } else if (isSecret) {
    valueHtml =
      "<div class='var-source tk-src-secret'>Secret</div>" +
      "<div class='var-secret-value var-value' style='font-style:italic;opacity:0.7'>Value hidden</div>";
  } else {
    valueHtml = "<div class='var-unresolved'>Unresolved variable</div>";
  }

  // Build actions
  const actions: string[] = [];
  if (ctx.onEditVariable && !isSecret) {
    actions.push("<button class='var-action-btn' data-action='edit'>Edit</button>");
  }
  if (isSecret && !resolved && ctx.postMessage) {
    actions.push("<button class='var-action-btn' data-action='reveal'>Reveal Value</button>");
  }
  actions.push("<button class='var-action-btn' data-action='copy'>" + (resolved ? 'Copy Value' : 'Copy Name') + "</button>");

  tooltip.innerHTML =
    "<div class='var-name'>{{" + escHtml(varName) + "}}</div>" +
    valueHtml +
    "<div class='var-actions'>" + actions.join('') + "</div>";

  tooltip.style.left = rect.left + 'px';
  tooltip.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  tooltip.querySelectorAll('.var-action-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'edit' && ctx.onEditVariable) {
        ctx.onEditVariable(varName);
        hideVarTooltip();
      } else if (action === 'copy') {
        const secretVal = (btn as HTMLElement).dataset.secretValue;
        const text = secretVal ?? (resolved ? vars[varName] : '{{' + varName + '}}');
        navigator.clipboard.writeText(text).catch(() => {});
        hideVarTooltip();
      } else if (action === 'reveal') {
        const valueEl = tooltip.querySelector('.var-secret-value') as HTMLElement;
        if (_resolvedSecretValue !== null) {
          // Already fetched — toggle show/hide
          _secretRevealed = !_secretRevealed;
          if (valueEl) {
            if (_secretRevealed) {
              valueEl.textContent = _resolvedSecretValue;
              valueEl.style.cssText = '';
            } else {
              valueEl.textContent = '\u2022'.repeat(Math.min(_resolvedSecretValue.length, 20));
              valueEl.style.cssText = '';
            }
          }
          (btn as HTMLElement).textContent = _secretRevealed ? 'Hide Value' : 'Show Value';
        } else {
          // First click — fetch from extension host
          _pendingSecretRef = varName;
          if (valueEl) {
            valueEl.textContent = 'Resolving\u2026';
            valueEl.style.cssText = 'font-style:italic;opacity:0.7';
          }
          (btn as HTMLElement).textContent = 'Resolving\u2026';
          ctx.postMessage!({ type: 'resolveSecret', secretRef: varName });
        }
      }
    });
  });

  setTimeout(() => {
    document.addEventListener('click', onTooltipOutsideClick);
  }, 0);
}
