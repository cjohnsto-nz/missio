// Variable autocomplete dropdown for the webview.

import { resolvedVariables } from './state';
import { escHtml, highlightVariables } from './highlight';

let acDropdown: HTMLElement | null = null;
let acItems: string[] = [];
let acSelectedIndex = 0;
let acTarget: HTMLTextAreaElement | HTMLElement | null = null;
let acStartPos = 0;
let acIsContentEditable = false;

export function getVarPrefix(text: string, cursorPos: number): string | null {
  const before = text.substring(0, cursorPos);
  const openIdx = before.lastIndexOf('{{');
  if (openIdx === -1) return null;
  const afterOpen = before.substring(openIdx + 2);
  if (afterOpen.includes('}}')) return null;
  const prefix = afterOpen.trim();
  if (!/^[\w.]*$/.test(prefix)) return null;
  return prefix;
}

export function handleAutocomplete(textarea: HTMLTextAreaElement, syncHighlightFn: () => void): void {
  const pos = textarea.selectionStart ?? 0;
  const prefix = getVarPrefix(textarea.value, pos);
  if (prefix === null) {
    hideAutocomplete();
    return;
  }
  acTarget = textarea;
  acIsContentEditable = false;
  acStartPos = textarea.value.lastIndexOf('{{', pos - 1);
  showAutocompleteDropdown(prefix, textarea, syncHighlightFn);
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

function showAutocompleteDropdown(prefix: string, anchor: HTMLElement, _syncFn: () => void): void {
  const keys = Object.keys(resolvedVariables);
  if (keys.length === 0) {
    hideAutocomplete();
    return;
  }
  const lowerPrefix = prefix.toLowerCase();
  acItems = keys.filter(k => k.toLowerCase().startsWith(lowerPrefix));
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
  acDropdown.innerHTML = acItems.map((name, i) => {
    const val = resolvedVariables[name] || '';
    const cls = i === acSelectedIndex ? 'var-autocomplete-item selected' : 'var-autocomplete-item';
    return "<div class='" + cls + "' data-index='" + i + "'>" +
      "<span class='var-ac-name'>" + escHtml(name) + "</span>" +
      "<span class='var-ac-value'>" + escHtml(val) + "</span>" +
      "</div>";
  }).join('');

  acDropdown.querySelectorAll('.var-autocomplete-item').forEach((item) => {
    item.addEventListener('mousedown', (e: Event) => {
      e.preventDefault();
      const idx = parseInt((item as HTMLElement).dataset.index || '0');
      acceptAutocomplete(acItems[idx]);
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

export function setAutocompleteSyncCallbacks(
  syncHighlight: () => void,
  syncUrlHighlight: () => void,
  restoreCursor: (el: HTMLElement, offset: number) => void,
): void {
  _syncHighlightCb = syncHighlight;
  _syncUrlHighlightCb = syncUrlHighlight;
  _restoreCursorCb = restoreCursor;
}

function acceptAutocomplete(varName: string): void {
  if (!acTarget) return;
  if (acIsContentEditable) {
    const el = acTarget as HTMLElement;
    const text = el.textContent || '';
    const sel = window.getSelection();
    let cursorPos = text.length;
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      cursorPos = preRange.toString().length;
    }
    const suffix = '{{' + varName + '}}';
    let endPos = cursorPos;
    const after = text.substring(cursorPos);
    if (after.startsWith('}}')) endPos += 2;
    const newText = text.substring(0, acStartPos) + suffix + text.substring(endPos);
    el.textContent = newText;
    _syncUrlHighlightCb?.();
    const newCursorPos = acStartPos + suffix.length;
    _restoreCursorCb?.(el, newCursorPos);
  } else {
    const textarea = acTarget as HTMLTextAreaElement;
    const text = textarea.value;
    const cursorPos = textarea.selectionStart ?? text.length;
    const suffix = '{{' + varName + '}}';
    let endPos = cursorPos;
    const after = text.substring(cursorPos);
    if (after.startsWith('}}')) endPos += 2;
    textarea.value = text.substring(0, acStartPos) + suffix + text.substring(endPos);
    const newCursorPos = acStartPos + suffix.length;
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;
    textarea.focus();
    _syncHighlightCb?.();
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
    acceptAutocomplete(acItems[acSelectedIndex]);
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
