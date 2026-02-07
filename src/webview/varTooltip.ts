/**
 * Centralized variable tooltip component shared by all panels.
 * Shows an editable value field for both resolved and unresolved variables,
 * with Postman-style color-coded scope badges and a dropdown to choose
 * where to persist the variable.
 */

export interface VarTooltipContext {
  getResolvedVariables: () => Record<string, string>;
  getVariableSources: () => Record<string, string>;
  getSecretKeys?: () => Set<string>;
  postMessage?: (msg: any) => void;
  onEditVariable?: (name: string) => void;
}

// ── Scope definitions with Postman-style badges ──

interface ScopeDef { key: string; label: string; badge: string; badgeClass: string; }
const SCOPES: ScopeDef[] = [
  { key: 'environment', label: 'Environment', badge: 'E', badgeClass: 'var-scope-badge-E' },
  { key: 'collection',  label: 'Collection',  badge: 'C', badgeClass: 'var-scope-badge-C' },
  { key: 'global',      label: 'Globals',      badge: 'G', badgeClass: 'var-scope-badge-G' },
];

function scopeDefForSource(source: string): ScopeDef {
  if (source === 'environment' || source === 'dotenv') return SCOPES[0];
  if (source === 'collection' || source === 'folder') return SCOPES[1];
  if (source === 'global') return SCOPES[2];
  return SCOPES[0]; // default
}

// ── State ──

let activeTooltip: HTMLElement | null = null;
let _pendingSecretRef: string | null = null;
let _resolvedSecretValue: string | null = null;
let _secretRevealed = false;

// ── Helpers ──

function esc(s: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function onTooltipOutsideClick(e: MouseEvent): void {
  if (activeTooltip && !activeTooltip.contains(e.target as Node)) {
    hideVarTooltip();
  }
}

// ── Public API ──

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
    if (valueEl) { valueEl.textContent = msg.error; valueEl.style.color = '#f48771'; valueEl.style.fontStyle = 'normal'; }
    if (revealBtn) revealBtn.textContent = 'Reveal Value';
    return;
  }

  const val = msg.value ?? '';
  _resolvedSecretValue = val;
  if (valueEl) { valueEl.textContent = val; valueEl.style.cssText = ''; }
  if (revealBtn) revealBtn.textContent = 'Hide Value';
  _secretRevealed = true;

  const copyBtn = activeTooltip.querySelector('.var-action-btn[data-action="copy"]') as HTMLElement;
  if (copyBtn) { copyBtn.textContent = 'Copy Value'; copyBtn.dataset.secretValue = val; }
}

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
  const source = sources[varName] || (isSecret ? 'secret' : '');
  const isSecretProvider = isSecret && !resolved;

  const tooltip = document.createElement('div');
  tooltip.className = 'var-tooltip';

  // ── Build HTML ──

  let html = '';

  if (isSecretProvider) {
    // Secret provider reference — show reveal/copy only
    html +=
      "<div class='var-name'>{{" + esc(varName) + "}}</div>" +
      "<div class='var-source tk-src-secret'>Secret Provider</div>" +
      "<div class='var-secret-value var-value' style='font-style:italic;opacity:0.7'>Value hidden</div>" +
      "<div class='var-actions'>" +
        (ctx.postMessage ? "<button class='var-action-btn' data-action='reveal'>Reveal Value</button>" : '') +
        "<button class='var-action-btn' data-action='copy'>Copy Name</button>" +
      "</div>";
  } else {
    // Resolved or unresolved — editable value + scope selector
    const currentValue = resolved ? vars[varName] : '';
    const currentScope = resolved ? scopeDefForSource(source) : null;

    // Editable value input
    html += "<input type='text' class='var-tooltip-value-input' placeholder='Enter value' value='" + esc(currentValue).replace(/'/g, '&#39;') + "' />";

    // Scope selector row
    const selectedScope = currentScope || SCOPES[0];
    html += "<div class='var-tooltip-scope-row'>" +
      "<div class='var-scope-dropdown'>" +
        "<button class='var-scope-trigger'>" +
          "<span class='var-scope-badge " + selectedScope.badgeClass + "'>" + selectedScope.badge + "</span>" +
          "<span>Save to " + selectedScope.label + " \u25BE</span>" +
        "</button>" +
        "<div class='var-scope-menu'>" +
          SCOPES.map(s =>
            "<button class='var-scope-option' data-scope='" + s.key + "'>" +
              "<span class='var-scope-badge " + s.badgeClass + "'>" + s.badge + "</span>" +
              "<span>" + s.label + "</span>" +
            "</button>"
          ).join('') +
        "</div>" +
      "</div>" +
    "</div>";
  }

  tooltip.innerHTML = html;

  // ── Position ──
  tooltip.style.left = rect.left + 'px';
  tooltip.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  // ── Wire interactions ──

  // Scope dropdown
  let selectedScopeKey = (resolved ? scopeDefForSource(source) : SCOPES[0]).key;
  const scopeTrigger = tooltip.querySelector('.var-scope-trigger');
  const scopeMenu = tooltip.querySelector('.var-scope-menu');
  if (scopeTrigger && scopeMenu) {
    scopeTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      scopeMenu.classList.toggle('open');
    });
    tooltip.querySelectorAll('.var-scope-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const scope = (opt as HTMLElement).dataset.scope!;
        selectedScopeKey = scope;
        const sd = SCOPES.find(s => s.key === scope) || SCOPES[0];
        scopeTrigger.innerHTML =
          "<span class='var-scope-badge " + sd.badgeClass + "'>" + sd.badge + "</span>" +
          "<span>Save to " + sd.label + " \u25BE</span>";
        scopeMenu.classList.remove('open');
      });
    });
  }

  // Value input — Enter to save
  const valueInput = tooltip.querySelector('.var-tooltip-value-input') as HTMLInputElement;
  if (valueInput) {
    setTimeout(() => valueInput.focus(), 0);
    valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitValue();
      }
      if (e.key === 'Escape') {
        hideVarTooltip();
      }
    });
  }

  function submitValue(): void {
    const value = valueInput?.value ?? '';
    if (!ctx.postMessage) return;
    ctx.postMessage({ type: 'updateVariable', varName, value, scope: selectedScopeKey });
    hideVarTooltip();
  }

  // Secret provider reveal
  tooltip.querySelectorAll('.var-action-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'copy') {
        const secretVal = (btn as HTMLElement).dataset.secretValue;
        const text = secretVal ?? (resolved ? vars[varName] : '{{' + varName + '}}');
        navigator.clipboard.writeText(text).catch(() => {});
        hideVarTooltip();
      } else if (action === 'reveal') {
        const valueEl = tooltip.querySelector('.var-secret-value') as HTMLElement;
        if (_resolvedSecretValue !== null) {
          _secretRevealed = !_secretRevealed;
          if (valueEl) {
            valueEl.textContent = _secretRevealed ? _resolvedSecretValue : '\u2022'.repeat(Math.min(_resolvedSecretValue.length, 20));
          }
          (btn as HTMLElement).textContent = _secretRevealed ? 'Hide Value' : 'Show Value';
        } else {
          _pendingSecretRef = varName;
          if (valueEl) { valueEl.textContent = 'Resolving\u2026'; valueEl.style.cssText = 'font-style:italic;opacity:0.7'; }
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
