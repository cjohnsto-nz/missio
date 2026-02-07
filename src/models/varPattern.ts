// Centralized variable pattern — single source of truth for both extension host and webview.
// Matches {{variableName}} where variableName can contain word chars, $, ., -

/** Regex source for matching variable names inside {{ }} */
export const VAR_NAME_CHARS = '[\\w.$-]+';

/** Full pattern for matching {{variable}} placeholders (use with 'g' flag) */
export const VAR_PATTERN_SOURCE = '\\{\\{(\\s*' + VAR_NAME_CHARS + '\\s*)\\}\\}';

export function varPatternGlobal(): RegExp {
  return new RegExp(VAR_PATTERN_SOURCE, 'g');
}
