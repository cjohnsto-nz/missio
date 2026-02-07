// Variable autocomplete dropdown for the webview.

import { escHtml, VAR_PREFIX_RE } from './varlib';

// Injectable getter — each panel sets this to its own resolved variables
let _getResolvedVariables: () => Record<string, string> = () => ({});

export function setResolvedVariablesGetter(fn: () => Record<string, string>): void {
  _getResolvedVariables = fn;
}

let acDropdown: HTMLElement | null = null;
let acItems: { name: string; displayName?: string; detail?: string }[] = [];
let acSelectedIndex = 0;
let acTarget: HTMLTextAreaElement | HTMLElement | null = null;
let acStartPos = 0;
let acIsContentEditable = false;
let acSyncFn: (() => void) | null = null;

// Built-in dynamic variables
const BUILTIN_VARS: { name: string; detail: string }[] = [
  { name: '$guid', detail: 'Generate a random UUID' },
  { name: '$timestamp', detail: 'Current Unix timestamp' },
  { name: '$randomInt', detail: 'Random integer 0–1000' },
];

// Secret provider names and secret names, populated by the extension host
let _secretProviderNames: string[] = [];
let _secretNames: Map<string, string[]> = new Map(); // providerName -> secretName[]

export function setSecretProviderNames(names: string[]): void {
  _secretProviderNames = names;
}

export function setSecretNamesForProvider(provider: string, names: string[]): void {
  _secretNames.set(provider, names);
}

export function getVarPrefix(text: string, cursorPos: number): string | null {
  const before = text.substring(0, cursorPos);
  const openIdx = before.lastIndexOf('{{');
  if (openIdx === -1) return null;
  const afterOpen = before.substring(openIdx + 2);
  if (afterOpen.includes('}}')) return null;
  const prefix = afterOpen.trim();
  if (!VAR_PREFIX_RE.test(prefix)) return null;
  return prefix;
}

export function handleAutocomplete(textarea: HTMLTextAreaElement | HTMLInputElement, syncHighlightFn: () => void): void {
  const pos = textarea.selectionStart ?? 0;
  const prefix = getVarPrefix(textarea.value, pos);
  if (prefix === null) {
    hideAutocomplete();
    return;
  }
  acTarget = textarea;
  acIsContentEditable = false;
  acStartPos = textarea.value.lastIndexOf('{{', pos - 1);
  showAutocompleteDropdown(prefix, textarea as HTMLElement, syncHighlightFn);
}

export function handleAutocompleteContentEditable(el: HTMLElement, syncUrlHighlightFn: () => void): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const text = el.textContent || '';
  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  const pos = preRange.toString().length;

  const prefix = getVarPrefix(text, pos);
  if (prefix === null) {
    hideAutocomplete();
    return;
  }
  acTarget = el;
  acIsContentEditable = true;
  acStartPos = text.lastIndexOf('{{', pos - 1);
  showAutocompleteDropdown(prefix, el, syncUrlHighlightFn);
}

function showAutocompleteDropdown(prefix: string, anchor: HTMLElement, syncFn: () => void): void {
  acSyncFn = syncFn;
  const lowerPrefix = prefix.toLowerCase();

  // Build candidate list: env vars + builtins + secret completions
  const candidates: { name: string; displayName?: string; detail?: string }[] = [];

  // Environment variables
  const vars = _getResolvedVariables();
  for (const k of Object.keys(vars)) {
    candidates.push({ name: k, detail: vars[k] });
  }

  // Built-in dynamic variables
  for (const b of BUILTIN_VARS) {
    candidates.push(b);
  }

  // Secret completions — 3 levels:
  //   Level 1: typing "" or "$" or "$sec..." → offer "$secret"
  //   Level 2: typing "$secret." → offer "$secret.{provider}"
  //   Level 3: typing "$secret.provider." → offer "$secret.provider.{secret}"
  if (lowerPrefix === '' || '$secret'.startsWith(lowerPrefix)) {
    // Level 1: show $secret as a top-level item
    if (_secretProviderNames.length > 0) {
      candidates.push({ name: '$secret', detail: 'Secret provider' });
    }
  } else if (lowerPrefix.startsWith('$secret.')) {
    const afterSecret = lowerPrefix.substring('$secret.'.length);
    const dotIdx = afterSecret.indexOf('.');
    if (dotIdx === -1) {
      // Level 2: completing provider name
      for (const pn of _secretProviderNames) {
        if (pn.toLowerCase().startsWith(afterSecret)) {
          candidates.push({ name: '$secret.' + pn, detail: 'Key Vault provider' });
        }
      }
    } else {
      // Level 3: completing secret name
      const provName = afterSecret.substring(0, dotIdx);
      const secretPrefix = afterSecret.substring(dotIdx + 1);
      const secrets = _secretNames.get(provName) || [];
      for (const sn of secrets) {
        if (sn.toLowerCase().startsWith(secretPrefix)) {
          candidates.push({ name: '$secret.' + provName + '.' + sn, displayName: sn, detail: 'Secret' });
        }
      }
    }
  }

  // Filter by prefix and deduplicate
  const seen = new Set<string>();
  acItems = [];
  for (const c of candidates) {
    if (c.name.toLowerCase().startsWith(lowerPrefix) && !seen.has(c.name)) {
      seen.add(c.name);
      acItems.push(c);
    }
  }

  if (acItems.length === 0) {
    hideAutocomplete();
    return;
  }
  acSelectedIndex = 0;

  if (!acDropdown) {
    acDropdown = document.createElement('div');
    acDropdown.className = 'var-autocomplete';
    document.body.appendChild(acDropdown);
  }

  renderAutocompleteItems();
  positionAutocomplete(anchor);
}

function renderAutocompleteItems(): void {
  if (!acDropdown) return;
  acDropdown.innerHTML = acItems.map((item, i) => {
    const cls = i === acSelectedIndex ? 'var-autocomplete-item selected' : 'var-autocomplete-item';
    return "<div class='" + cls + "' data-index='" + i + "'>" +
      "<span class='var-ac-name'>" + escHtml(item.displayName || item.name) + "</span>" +
      "<span class='var-ac-value'>" + escHtml(item.detail || '') + "</span>" +
      "</div>";
  }).join('');

  acDropdown.querySelectorAll('.var-autocomplete-item').forEach((el) => {
    el.addEventListener('mousedown', (e: Event) => {
      e.preventDefault();
      const idx = parseInt((el as HTMLElement).dataset.index || '0');
      acceptAutocomplete(acItems[idx].name);
    });
  });
}

function getCaretCoords(textarea: HTMLTextAreaElement): { top: number; left: number } {
  const mirror = document.createElement('div');
  const style = window.getComputedStyle(textarea);
  const props = ['fontFamily','fontSize','fontWeight','letterSpacing','lineHeight',
    'paddingTop','paddingLeft','paddingRight','paddingBottom','borderWidth','boxSizing',
    'whiteSpace','wordWrap','overflowWrap','tabSize'];
  props.forEach(p => { (mirror.style as any)[p] = style.getPropertyValue(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase())); });
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = textarea.clientWidth + 'px';
  const text = textarea.value.substring(0, textarea.selectionStart ?? 0);
  mirror.textContent = text;
  const span = document.createElement('span');
  span.textContent = '|';
  mirror.appendChild(span);
  document.body.appendChild(mirror);
  const spanRect = span.getBoundingClientRect();
  const taRect = textarea.getBoundingClientRect();
  const coords = {
    top: taRect.top + (spanRect.top - mirror.getBoundingClientRect().top) - textarea.scrollTop,
    left: taRect.left + (spanRect.left - mirror.getBoundingClientRect().left) - textarea.scrollLeft,
  };
  document.body.removeChild(mirror);
  return coords;
}

function positionAutocomplete(anchor: HTMLElement): void {
  if (!acDropdown) return;
  if (acIsContentEditable) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      acDropdown.style.left = rect.left + 'px';
      acDropdown.style.top = (rect.bottom + 4) + 'px';
    } else {
      const rect = anchor.getBoundingClientRect();
      acDropdown.style.left = rect.left + 'px';
      acDropdown.style.top = (rect.bottom + 2) + 'px';
    }
  } else {
    const coords = getCaretCoords(anchor as HTMLTextAreaElement);
    acDropdown.style.left = coords.left + 'px';
    acDropdown.style.top = (coords.top + 18) + 'px';
  }
  acDropdown.style.minWidth = '220px';
}

// Callbacks set by the main module so acceptAutocomplete can trigger re-highlighting
let _syncHighlightCb: (() => void) | null = null;
let _syncUrlHighlightCb: (() => void) | null = null;
let _restoreCursorCb: ((el: HTMLElement, offset: number) => void) | null = null;
let _setRawUrlCb: ((text: string) => void) | null = null;

export function setAutocompleteSyncCallbacks(
  syncHighlight: () => void,
  syncUrlHighlight: () => void,
  restoreCursor: (el: HTMLElement, offset: number) => void,
  setRawUrl?: (text: string) => void,
): void {
  _syncHighlightCb = syncHighlight;
  _syncUrlHighlightCb = syncUrlHighlight;
  _restoreCursorCb = restoreCursor;
  _setRawUrlCb = setRawUrl || null;
}

function isPartialCompletion(varName: string): boolean {
  // $secret without a provider.secret suffix is partial
  if (varName === '$secret') return true;
  // $secret.provider without a secret name is partial
  if (varName.startsWith('$secret.') && varName.split('.').length === 2) return true;
  return false;
}

function acceptAutocomplete(varName: string): void {
  if (!acTarget) return;
  const partial = isPartialCompletion(varName);
  const savedTarget = acTarget;
  const savedCE = acIsContentEditable;
  const savedSyncFn = acSyncFn;

  if (savedCE) {
    const el = savedTarget as HTMLElement;
    const ceEl = el as any;
    const text = ceEl._getRawText ? ceEl._getRawText() : (el.textContent || '');
    const sel = window.getSelection();
    let cursorPos = text.length;
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      cursorPos = preRange.toString().length;
    }

    let insert: string;
    let newCursorPos: number;
    if (partial) {
      // Insert the partial name + dot, keep {{ open
      insert = '{{' + varName + '.';
      let endPos = cursorPos;
      const after = text.substring(cursorPos);
      if (after.startsWith('}}')) endPos += 2;
      const newText = text.substring(0, acStartPos) + insert + text.substring(endPos);
      newCursorPos = acStartPos + insert.length;
      if (ceEl._setRawText) {
        ceEl._setRawText(newText);
      } else if (_setRawUrlCb) {
        _setRawUrlCb(newText);
      }
    } else {
      // Final: wrap with {{ }}
      insert = '{{' + varName + '}}';
      let endPos = cursorPos;
      const after = text.substring(cursorPos);
      if (after.startsWith('}}')) endPos += 2;
      const newText = text.substring(0, acStartPos) + insert + text.substring(endPos);
      newCursorPos = acStartPos + insert.length;
      if (ceEl._setRawText) {
        ceEl._setRawText(newText);
      } else if (_setRawUrlCb) {
        _setRawUrlCb(newText);
      }
    }

    if (savedSyncFn) savedSyncFn(); else _syncUrlHighlightCb?.();
    _restoreCursorCb?.(el, newCursorPos);

    if (partial) {
      // Re-trigger autocomplete after inserting partial
      hideAutocomplete();
      setTimeout(() => { handleAutocompleteContentEditable(el, savedSyncFn || (() => {})); }, 0);
      return;
    }
  } else {
    const textarea = savedTarget as HTMLTextAreaElement | HTMLInputElement;
    const text = textarea.value;
    const cursorPos = textarea.selectionStart ?? text.length;

    let insert: string;
    let newCursorPos: number;
    if (partial) {
      insert = '{{' + varName + '.';
      let endPos = cursorPos;
      const after = text.substring(cursorPos);
      if (after.startsWith('}}')) endPos += 2;
      textarea.value = text.substring(0, acStartPos) + insert + text.substring(endPos);
      newCursorPos = acStartPos + insert.length;
    } else {
      insert = '{{' + varName + '}}';
      let endPos = cursorPos;
      const after = text.substring(cursorPos);
      if (after.startsWith('}}')) endPos += 2;
      textarea.value = text.substring(0, acStartPos) + insert + text.substring(endPos);
      newCursorPos = acStartPos + insert.length;
    }
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;
    textarea.focus();
    if (savedSyncFn) savedSyncFn(); else _syncHighlightCb?.();

    if (partial) {
      hideAutocomplete();
      setTimeout(() => {
        handleAutocomplete(textarea, savedSyncFn || (() => {}));
      }, 0);
      return;
    }
  }
  hideAutocomplete();
}

export function hideAutocomplete(): void {
  if (acDropdown) {
    acDropdown.remove();
    acDropdown = null;
  }
  acTarget = null;
  acItems = [];
  acSelectedIndex = 0;
  acSyncFn = null;
}

export function handleAutocompleteKeydown(e: KeyboardEvent): boolean {
  if (!acDropdown || acItems.length === 0) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acSelectedIndex = (acSelectedIndex + 1) % acItems.length;
    renderAutocompleteItems();
    return true;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acSelectedIndex = (acSelectedIndex - 1 + acItems.length) % acItems.length;
    renderAutocompleteItems();
    return true;
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    acceptAutocomplete(acItems[acSelectedIndex].name);
    return true;
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideAutocomplete();
    return true;
  }
  return false;
}

export function isAutocompleteActive(): boolean {
  return acDropdown !== null;
}
