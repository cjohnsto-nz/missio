// Syntax highlighting and line numbers for the webview.

import { getResolvedVariables, getVariableSources, getShowResolvedVars } from './state';

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightJSON(code: string): string {
  let h = escHtml(code);
  h = h.replace(/(")((?:[^"\\]|\\.)*)(")\s*:/g, "<span class='tk-key'>&quot;$2&quot;</span>:");
  h = h.replace(/(")((?:[^"\\]|\\.)*)(")/g, "<span class='tk-str'>&quot;$2&quot;</span>");
  h = h.replace(/\b(-?\d+\.?\d*(?:e[+-]?\d+)?)\b/gi, "<span class='tk-num'>$1</span>");
  h = h.replace(/\b(true|false|null)\b/g, "<span class='tk-kw'>$1</span>");
  return h;
}

export function highlightXML(code: string): string {
  let h = escHtml(code);
  h = h.replace(/(&lt;\/?)([\w:-]+)/g, "$1<span class='tk-tag'>$2</span>");
  h = h.replace(/([\w:-]+)(=)(")((?:[^"]*))(")/g, "<span class='tk-attr'>$1</span>$2<span class='tk-str'>&quot;$4&quot;</span>");
  return h;
}

export function highlightVariables(html: string): string {
  const vars = getResolvedVariables();
  const sources = getVariableSources();
  const showResolved = getShowResolvedVars();
  return html.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_match: string, name: string) => {
    const key = name.trim();
    const resolved = key in vars;
    const source = sources[key] || 'unknown';

    if (showResolved && resolved) {
      // Show the resolved value, color-coded by source
      const cls = 'tk-var-resolved tk-src-' + source;
      return "<span class='" + cls + "' data-var='" + escHtml(key) + "' title='{{" + escHtml(key) + "}} (" + source + ")'>" + escHtml(vars[key]) + "</span>";
    }

    // Default: show the template with source class
    const cls = resolved ? 'tk-var tk-src-' + source : 'tk-var tk-var-unresolved';
    return "<span class='" + cls + "' data-var='" + escHtml(key) + "'>{{" + escHtml(name) + "}}</span>";
  });
}

export function highlight(code: string, lang: string): string {
  let h: string;
  if (lang === 'json') h = highlightJSON(code);
  else if (lang === 'xml' || lang === 'html') h = highlightXML(code);
  else h = escHtml(code);
  return highlightVariables(h);
}
