// Shared variable field infrastructure for all webview panels.
// Owns: variable state, highlighting wrapper, enableVarOverlay, enableContentEditableValue,
// restoreCursor, syncAllVarOverlays, handleVariablesResolved.
// Each panel imports from here instead of duplicating.

import { escHtml, highlightVariables as _hlVars } from './varlib';
import { showVarTooltipAt } from './varTooltip';
import {
  handleAutocomplete,
  handleAutocompleteContentEditable,
  handleAutocompleteKeydown,
  hideAutocomplete,
  isAutocompleteActive,
  setAutocompleteSyncCallbacks,
  setResolvedVariablesGetter,
  setSecretProviderNames,
  setSecretNamesForProvider,
} from './autocomplete';

// ── Variable state ──────────────────────────────
let _resolved: Record<string, string> = {};
let _sources: Record<string, string> = {};
let _showResolved = false;
let _secretKeys: Set<string> = new Set();
let _onBreakIllusion: (() => void) | null = null;

/** Register a callback for when the resolved-vars illusion is broken (e.g. user edits a field while resolved vars are shown). */
export function setBreakIllusionCallback(fn: () => void): void { _onBreakIllusion = fn; }

export function getResolvedVariables(): Record<string, string> { return _resolved; }
export function getVariableSources(): Record<string, string> { return _sources; }
export function getShowResolvedVars(): boolean { return _showResolved; }
export function setShowResolvedVars(val: boolean): void { _showResolved = val; }
export function getSecretKeys(): Set<string> { return _secretKeys; }

// ── Highlighting wrapper ────────────────────────
export function highlightVariables(html: string): string {
  return _hlVars(html, {
    resolved: _resolved,
    sources: _sources,
    showResolved: _showResolved,
    secretKeys: _secretKeys,
  });
}

// ── Restore cursor in contenteditable ───────────
export function restoreCursor(el: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let charCount = 0;
  let found = false;
  function walk(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent || '').length;
      if (charCount + len >= offset) {
        range.setStart(node, offset - charCount);
        range.collapse(true);
        return true;
      }
      charCount += len;
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        if (walk(node.childNodes[i])) return true;
      }
    }
    return false;
  }
  found = walk(el);
  if (!found) {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── Sync all variable overlays ──────────────────
export function syncAllVarOverlays(): void {
  document.querySelectorAll('.var-cell').forEach((cell) => {
    const input = cell.querySelector('input[type="text"]') as HTMLInputElement | null;
    const overlay = cell.querySelector('.var-overlay') as HTMLElement | null;
    if (input && overlay && cell.classList.contains('var-overlay-active')) {
      overlay.innerHTML = highlightVariables(escHtml(input.value));
    }
  });
  document.querySelectorAll('.val-ce').forEach((el) => {
    const getRaw = (el as any)._getRawText;
    if (getRaw && document.activeElement !== el) {
      const raw = getRaw();
      if (raw) {
        el.innerHTML = highlightVariables(escHtml(raw));
      }
    }
  });
}

// ── Enable variable overlay on an <input> ───────
export function enableVarOverlay(input: HTMLInputElement): void {
  const parent = input.parentElement!;
  parent.classList.add('var-cell');
  const overlay = document.createElement('div');
  overlay.className = 'var-overlay';
  parent.appendChild(overlay);

  function sync() {
    overlay.innerHTML = highlightVariables(escHtml(input.value));
  }
  function activate() {
    parent.classList.add('var-overlay-active');
    sync();
  }
  function deactivate() {
    parent.classList.remove('var-overlay-active');
  }

  input.addEventListener('input', () => { sync(); handleAutocomplete(input, sync); });
  input.addEventListener('focus', deactivate);
  input.addEventListener('blur', () => { activate(); hideAutocomplete(); });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isAutocompleteActive() && handleAutocompleteKeydown(e)) return;
  });

  overlay.addEventListener('click', (e: Event) => {
    const varEl = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
    if (varEl && varEl.dataset.var) {
      showVarTooltipAt(varEl, varEl.dataset.var, {
        getResolvedVariables: () => _resolved,
        getVariableSources: () => _sources,
      });
    } else {
      deactivate();
      input.focus();
    }
  });

  if (document.activeElement !== input) {
    activate();
  }
}

// ── Enable contenteditable value field ──────────
export function enableContentEditableValue(el: HTMLElement, initialValue: string, onChange: () => void): void {
  let rawText = initialValue || '';
  (el as any)._getRawText = () => rawText;
  (el as any)._setRawText = (t: string) => { rawText = t; };

  function syncHighlightCE(): void {
    if (!rawText) {
      el.innerHTML = '';
      return;
    }
    const sel = window.getSelection();
    let cursorOffset = 0;
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      cursorOffset = preRange.toString().length;
    }
    el.innerHTML = highlightVariables(escHtml(rawText));
    if (sel && document.activeElement === el) {
      restoreCursor(el, cursorOffset);
    }
  }

  syncHighlightCE();

  el.addEventListener('input', () => {
    if (_showResolved) {
      _showResolved = false;
      syncAllVarOverlays();
      _onBreakIllusion?.();
      return;
    }
    const sel = window.getSelection();
    let cursorOffset = 0;
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      cursorOffset = preRange.toString().length;
    }
    rawText = el.textContent || '';
    syncHighlightCE();
    restoreCursor(el, cursorOffset);
    onChange();
    handleAutocompleteContentEditable(el, syncHighlightCE);
  });

  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isAutocompleteActive() && handleAutocompleteKeydown(e)) return;
  });

  el.addEventListener('blur', () => { hideAutocomplete(); });

  el.addEventListener('click', (e: Event) => {
    const target = (e.target as HTMLElement).closest('.tk-var, .tk-var-resolved') as HTMLElement | null;
    if (target && target.dataset.var) {
      showVarTooltipAt(target, target.dataset.var, {
        getResolvedVariables: () => _resolved,
        getVariableSources: () => _sources,
      });
    }
  });
}

// ── Handle variablesResolved message ────────────
// Call this from each panel's message handler. Returns true if handled.
export function handleVariablesResolved(msg: any): boolean {
  if (msg.type !== 'variablesResolved') return false;
  _resolved = msg.variables || {};
  _sources = msg.sources || {};
  setSecretProviderNames(msg.secretProviderNames || []);
  // Build secretKeys for highlighting and populate autocomplete
  const sn: Record<string, string[]> = msg.secretNames || {};
  const sk = new Set<string>();
  for (const [prov, names] of Object.entries(sn)) {
    setSecretNamesForProvider(prov, names as string[]);
    for (const n of names as string[]) { sk.add(`$secret.${prov}.${n}`); }
  }
  _secretKeys = sk;
  syncAllVarOverlays();
  return true;
}

// ── Initialize autocomplete for a panel ─────────
// Call once at panel startup.
// extraSyncHighlight/extraSyncUrlHighlight: optional extra sync functions for panel-specific fields (e.g. URL bar, body).
// setRawUrl: optional callback for autocomplete to set the URL bar's raw text.
export function initVarFields(opts?: {
  extraSyncHighlight?: () => void;
  extraSyncUrlHighlight?: () => void;
  setRawUrl?: (text: string) => void;
}): void {
  setResolvedVariablesGetter(() => _resolved);
  const syncHL = () => { syncAllVarOverlays(); opts?.extraSyncHighlight?.(); };
  const syncUrl = () => { syncAllVarOverlays(); opts?.extraSyncUrlHighlight?.(); };
  setAutocompleteSyncCallbacks(syncHL, syncUrl, restoreCursor, opts?.setRawUrl);
}
