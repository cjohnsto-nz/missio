// Centralized variable handling for all webview panels.
// Pure functions — no global state. Each panel passes its own state.

/** Regex pattern for matching {{variable}} placeholders (supports $, -, . in names). */
export const VAR_PATTERN = /\{\{(\s*[\w.$-]+\s*)\}\}/g;

/** Regex for testing if a string is a valid variable-name prefix (used by autocomplete). */
export const VAR_PREFIX_RE = /^[\w.$-]*$/;

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface VarState {
  resolved: Record<string, string>;
  sources: Record<string, string>;
  showResolved: boolean;
  /** Known $secret.provider.key names — treated as resolved for highlighting but not shown in autocomplete level 1 */
  secretKeys?: Set<string>;
  /** Names of environment variables with secret: true — their resolved values should be masked */
  secretVarNames?: Set<string>;
}

const BUILTIN_NAMES = new Set(['$guid', '$timestamp', '$randomInt']);

export function highlightVariables(html: string, state: VarState): string {
  return html.replace(VAR_PATTERN, (_match: string, name: string) => {
    const key = name.trim();
    const isResolved = key in state.resolved;
    const isBuiltin = BUILTIN_NAMES.has(key);
    const isSecret = state.secretKeys?.has(key) ?? false;
    const isKnown = isResolved || isBuiltin || isSecret;
    const source = state.sources[key] || (isSecret ? 'secret' : isBuiltin ? 'dynamic' : 'unknown');

    if (state.showResolved && isResolved) {
      const isMaskedSecret = source === 'secret' || (state.secretVarNames?.has(key) ?? false);
      const displayValue = isMaskedSecret ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : escHtml(state.resolved[key]);
      const cls = 'tk-var-resolved tk-src-' + source;
      return "<span class='" + cls + "' data-var='" + escHtml(key) + "' title='{{" + escHtml(key) + "}} (" + source + ")'>"
        + displayValue + "</span>";
    }

    const cls = isKnown ? 'tk-var tk-src-' + source : 'tk-var tk-var-unresolved';
    return "<span class='" + cls + "' data-var='" + escHtml(key) + "'>{{" + escHtml(name) + "}}</span>";
  });
}

export function findVarAtCursor(text: string, cursorPos: number): string | null {
  const re = new RegExp(VAR_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (cursorPos >= m.index && cursorPos <= m.index + m[0].length) {
      return m[1].trim();
    }
  }
  return null;
}
