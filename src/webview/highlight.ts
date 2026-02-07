// Syntax highlighting and line numbers for the webview.

import { escHtml as _escHtml } from './varlib';
import { highlightVariables } from './varFields';

export { escHtml } from './varlib';
export { highlightVariables } from './varFields';

export function highlightJSON(code: string): string {
  // Tokenize the raw string, then escape each token individually
  const tokens: string[] = [];
  let i = 0;
  while (i < code.length) {
    // String literal
    if (code[i] === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') {
        if (code[j] === '\\') j++; // skip escaped char
        j++;
      }
      j++; // include closing quote
      const raw = code.substring(i, j);
      // Check if this is a key (followed by optional whitespace and colon)
      const rest = code.substring(j);
      const isKey = /^\s*:/.test(rest);
      const cls = isKey ? 'tk-key' : 'tk-str';
      tokens.push("<span class='" + cls + "'>" + _escHtml(raw) + "</span>");
      i = j;
      continue;
    }
    // Number
    const numMatch = code.substring(i).match(/^-?\d+\.?\d*(?:e[+-]?\d+)?/i);
    if (numMatch && (i === 0 || /[\s,\[:({]/.test(code[i - 1]))) {
      tokens.push("<span class='tk-num'>" + _escHtml(numMatch[0]) + "</span>");
      i += numMatch[0].length;
      continue;
    }
    // Keyword
    const kwMatch = code.substring(i).match(/^(true|false|null)\b/);
    if (kwMatch) {
      tokens.push("<span class='tk-kw'>" + kwMatch[0] + "</span>");
      i += kwMatch[0].length;
      continue;
    }
    // Plain character
    tokens.push(_escHtml(code[i]));
    i++;
  }
  return tokens.join('');
}

export function highlightXML(code: string): string {
  let h = _escHtml(code);
  h = h.replace(/(&lt;\/?)([\w:-]+)/g, "$1<span class='tk-tag'>$2</span>");
  h = h.replace(/([\w:-]+)(=)(")((?:[^"]*))(")/g, "<span class='tk-attr'>$1</span>$2<span class='tk-str'>&quot;$4&quot;</span>");
  return h;
}

export function highlight(code: string, lang: string): string {
  let h: string;
  if (lang === 'json') h = highlightJSON(code);
  else if (lang === 'xml' || lang === 'html') h = highlightXML(code);
  else h = _escHtml(code);
  return highlightVariables(h);
}

/** Highlight without variable overlay — for response bodies */
export function highlightResponse(code: string, lang: string): string {
  if (lang === 'json') return highlightJSON(code);
  if (lang === 'xml' || lang === 'html') return highlightXML(code);
  return _escHtml(code);
}
