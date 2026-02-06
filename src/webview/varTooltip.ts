export interface VarTooltipContext {
  getResolvedVariables: () => Record<string, string>;
  getVariableSources: () => Record<string, string>;
  onEditVariable?: (name: string) => void;
}

let activeTooltip: HTMLElement | null = null;

function escHtml(s: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  document.removeEventListener('click', onTooltipOutsideClick);
}

export function showVarTooltipAt(anchorEl: HTMLElement, varName: string, ctx: VarTooltipContext): void {
  hideVarTooltip();

  const rect = anchorEl.getBoundingClientRect();
  const vars = ctx.getResolvedVariables();
  const sources = ctx.getVariableSources();
  const resolved = varName in vars;
  const source = sources[varName] || 'unknown';
  const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1);

  const tooltip = document.createElement('div');
  tooltip.className = 'var-tooltip';

  const actions: string[] = [];
  if (ctx.onEditVariable) {
    actions.push("<button class='var-action-btn' data-action='edit'>Edit</button>");
  }
  actions.push("<button class='var-action-btn' data-action='copy'>" + (resolved ? 'Copy Value' : 'Copy Name') + "</button>");

  tooltip.innerHTML =
    "<div class='var-name'>{{" + escHtml(varName) + "}}</div>" +
    (resolved
      ? "<div class='var-source tk-src-" + escHtml(source) + "'>" + escHtml(sourceLabel) + "</div>" +
        "<div class='var-value'>" + escHtml(vars[varName]) + "</div>"
      : "<div class='var-unresolved'>Unresolved variable</div>") +
    "<div class='var-actions'>" + actions.join('') + "</div>";

  tooltip.style.left = rect.left + 'px';
  tooltip.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  tooltip.querySelectorAll('.var-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'edit' && ctx.onEditVariable) {
        ctx.onEditVariable(varName);
      } else if (action === 'copy') {
        const text = resolved ? vars[varName] : '{{' + varName + '}}';
        navigator.clipboard.writeText(text).catch(() => {});
      }
      hideVarTooltip();
    });
  });

  setTimeout(() => {
    document.addEventListener('click', onTooltipOutsideClick);
  }, 0);
}
