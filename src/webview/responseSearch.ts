// Response body search — Ctrl+F find-in-response for the webview.

import {
  clearVirtualizedResponseSearch,
  getLastResponseBody,
  getLastResponseLines,
  getLastResponseLowerLines,
  revealVirtualizedResponseSearchMatch,
  type ResponseSearchMatch,
  setVirtualizedResponseSearch,
} from './response';

let isOpen = false;
let matches: ResponseSearchMatch[] = [];
let currentMatch = -1;
let lastQuery = '';

function getSearchDebounceMs(): number {
  const bodyLength = getLastResponseBody().length;
  if (bodyLength >= 5_000_000) return 450;
  if (bodyLength >= 1_000_000) return 300;
  return 150;
}

function getElements() {
  return {
    bar: document.getElementById('respSearchBar')!,
    input: document.getElementById('respSearchInput') as HTMLInputElement,
    count: document.getElementById('respSearchCount')!,
    prev: document.getElementById('respSearchPrev')!,
    next: document.getElementById('respSearchNext')!,
    close: document.getElementById('respSearchClose')!,
    pre: document.getElementById('respBodyPre')!,
    section: document.getElementById('responseSection'),
  };
}

export function openSearch(): void {
  if (!getLastResponseBody()) {
    return;
  }

  const { bar, input, section } = getElements();
  bar.style.display = 'flex';
  section?.classList.add('resp-search-open');
  isOpen = true;
  input.focus();
  input.select();
}

export function closeSearch(): void {
  const { bar, input, section } = getElements();
  bar.style.display = 'none';
  section?.classList.remove('resp-search-open');
  isOpen = false;
  input.value = '';
  lastQuery = '';
  clearVirtualizedResponseSearch();
  matches = [];
  currentMatch = -1;
  updateCount();
}

export function isSearchOpen(): boolean {
  return isOpen;
}

function buildMatches(query: string): ResponseSearchMatch[] {
  const lines = getLastResponseLines();
  const lowerLines = getLastResponseLowerLines();
  const lowerQuery = query.toLowerCase();
  const found: ResponseSearchMatch[] = [];
  let matchNumber = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lowerLine = lowerLines[lineIndex] ?? line.toLowerCase();
    let searchFrom = 0;

    while (searchFrom < lowerLine.length) {
      const idx = lowerLine.indexOf(lowerQuery, searchFrom);
      if (idx === -1) break;

      found.push({
        line: lineIndex,
        start: idx,
        end: idx + query.length,
        index: matchNumber++,
      });
      searchFrom = idx + Math.max(query.length, 1);
    }
  }

  return found;
}

function syncSearchResults(): void {
  if (matches.length === 0 || currentMatch < 0) {
    clearVirtualizedResponseSearch();
    return;
  }

  setVirtualizedResponseSearch(matches, currentMatch);
  revealVirtualizedResponseSearchMatch(matches[currentMatch]);
}

function updateCount(): void {
  const { count } = getElements();
  if (matches.length === 0 && lastQuery) {
    count.textContent = 'No results';
  } else if (matches.length > 0) {
    count.textContent = `${currentMatch + 1} of ${matches.length}`;
  } else {
    count.textContent = '';
  }
}

/**
 * Build line-based matches for the current response body and sync them to the
 * renderer, which applies <mark> highlights for the active search state.
 */
function performSearch(query: string): void {
  clearVirtualizedResponseSearch();
  matches = [];
  currentMatch = -1;
  lastQuery = query;

  if (!query) {
    updateCount();
    return;
  }

  matches = buildMatches(query);

  if (matches.length > 0) {
    currentMatch = 0;
    syncSearchResults();
  }

  updateCount();
}

function goToNext(): void {
  if (matches.length === 0) return;

  currentMatch = (currentMatch + 1) % matches.length;
  syncSearchResults();
  updateCount();
}

function goToPrev(): void {
  if (matches.length === 0) return;

  currentMatch = (currentMatch - 1 + matches.length) % matches.length;
  syncSearchResults();
  updateCount();
}

export function initResponseSearch(): void {
  const { input, prev, next, close } = getElements();

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performSearch(input.value);
    }, getSearchDebounceMs());
  });

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPrev();
      } else {
        goToNext();
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
      const pre = document.getElementById('respBodyPre');
      if (pre) pre.focus();
    }
  });

  prev.addEventListener('click', goToPrev);
  next.addEventListener('click', goToNext);
  close.addEventListener('click', () => {
    closeSearch();
    const pre = document.getElementById('respBodyPre');
    if (pre) pre.focus();
  });
}
