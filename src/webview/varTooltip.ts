/**
 * Centralized variable tooltip component shared by all panels.
 * Identical layout for every variable type: editable input + scope dropdown.
 * For secrets (env secrets & provider secrets) the input starts as
 * type="password" with a small reveal toggle; otherwise type="text".
 */

export interface VarTooltipContext {
  getResolvedVariables: () => Record<string, string>;
  getVariableSources: () => Record<string, string>;
  getSecretKeys?: () => Set<string>;
  getSecretVarNames?: () => Set<string>;
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

// SVG eye icon that works in both light and dark themes
const EYE_SVG = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3'/></svg>";

function scopeDefForSource(source: string): ScopeDef {
  if (source === 'environment' || source === 'dotenv') return SCOPES[0];
  if (source === 'collection' || source === 'folder') return SCOPES[1];
  if (source === 'global') return SCOPES[2];
  return SCOPES[0]; // default
}

// ── State ──

let activeTooltip: HTMLElement | null = null;
let _pendingSecretRef: string | null = null;
let _dismissTimer: ReturnType<typeof setTimeout> | null = null;
const DISMISS_DELAY = 300; // ms before tooltip disappears after mouse leaves

// ── Helpers ──

function esc(s: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cancelDismiss(): void {
  if (_dismissTimer) { clearTimeout(_dismissTimer); _dismissTimer = null; }
}

export function scheduleDismiss(): void {
  cancelDismiss();
  _dismissTimer = setTimeout(() => hideVarTooltip(), DISMISS_DELAY);
}

// ── Public API ──

export function hideVarTooltip(): void {
  cancelDismiss();
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
  _pendingSecretRef = null;
}

/** Called when the extension host responds with a resolved secret provider value. */
export function handleSecretValueResolved(msg: { secretRef: string; value?: string; error?: string }): void {
  if (!activeTooltip || msg.secretRef !== _pendingSecretRef) return;
  const valueInput = activeTooltip.querySelector('.var-tooltip-value-input') as HTMLInputElement;
  if (!valueInput) return;

  if (msg.error) {
    valueInput.value = '';
    valueInput.placeholder = msg.error;
    return;
  }
  valueInput.value = msg.value ?? '';
}

export function showVarTooltipAt(anchorEl: HTMLElement, varName: string, ctx: VarTooltipContext): void {
  hideVarTooltip();

  const rect = anchorEl.getBoundingClientRect();
  const vars = ctx.getResolvedVariables();
  const sources = ctx.getVariableSources();
  const secretKeys = ctx.getSecretKeys?.() ?? new Set<string>();
  const secretVarNames = ctx.getSecretVarNames?.() ?? new Set<string>();
  const resolved = varName in vars;
  const isProviderSecret = secretKeys.has(varName);
  const isEnvSecret = secretVarNames.has(varName);
  const isAnySecret = isProviderSecret || isEnvSecret;
  const source = sources[varName] || (isProviderSecret ? 'secret' : '');

  const tooltip = document.createElement('div');
  tooltip.className = 'var-tooltip';

  // ── Build HTML — identical layout for every type ──

  const currentValue = resolved ? vars[varName] : '';
  const inputType = isAnySecret ? 'password' : 'text';

  // Value input row — for secrets, add a reveal toggle button
  let inputHtml = "<div class='var-tooltip-input-row'>" +
    "<input type='" + inputType + "' class='var-tooltip-value-input' placeholder='Enter value' value='" + esc(currentValue).replace(/'/g, '&#39;') + "' />";
  if (isAnySecret) {
    inputHtml += "<button class='var-tooltip-reveal' title='Show/hide value'>" + EYE_SVG + "</button>";
  }
  inputHtml += "</div>";

  // Scope selector row — identical for all types
  const currentScope = resolved ? scopeDefForSource(source) : (isProviderSecret ? { badge: 'S', badgeClass: 'var-scope-badge-secret', label: 'Secret Provider', key: 'secret' } as any : null);
  const selectedScope = currentScope || SCOPES[0];

  const scopeHtml = "<div class='var-tooltip-scope-row'>" +
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

  tooltip.innerHTML = inputHtml + scopeHtml;

  // ── Position ──
  tooltip.style.left = rect.left + 'px';
  tooltip.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  // Keep tooltip open while mouse is over it
  tooltip.addEventListener('mouseenter', cancelDismiss);
  tooltip.addEventListener('mouseleave', scheduleDismiss);

  // ── Wire interactions ──

  // Scope dropdown
  let selectedScopeKey = (currentScope?.key ?? SCOPES[0].key);
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

  // Reveal toggle for secrets
  const revealBtn = tooltip.querySelector('.var-tooltip-reveal') as HTMLElement;
  const valueInput = tooltip.querySelector('.var-tooltip-value-input') as HTMLInputElement;
  if (revealBtn && valueInput) {
    revealBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isProviderSecret && !valueInput.value) {
        // Provider secret — need to fetch from extension host first
        _pendingSecretRef = varName;
        valueInput.placeholder = 'Resolving\u2026';
        ctx.postMessage?.({ type: 'resolveSecret', secretRef: varName });
      }
      valueInput.type = valueInput.type === 'password' ? 'text' : 'password';
    });
  }

  // Value input — Enter to save, Escape to close
  if (valueInput) {
    valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = valueInput.value ?? '';
        if (ctx.postMessage) {
          ctx.postMessage({ type: 'updateVariable', varName, value, scope: selectedScopeKey });
        }
        hideVarTooltip();
      }
      if (e.key === 'Escape') {
        hideVarTooltip();
      }
    });
  }

}

/**
 * Wire up a container so that hovering over a variable span shows the tooltip.
 * Call this once per container element (overlay, contenteditable, highlight div, etc.).
 */
export function setupVarHover(container: HTMLElement, ctx: VarTooltipContext): void {
  container.addEventListener('mouseover', (e: Event) => {
    const target = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
    if (target && target.dataset.var) {
      cancelDismiss();
      showVarTooltipAt(target, target.dataset.var, ctx);
    }
  });
  container.addEventListener('mouseleave', () => {
    scheduleDismiss();
  });
}
