// Response body search — Ctrl+F find-in-response for the webview.

import {
  clearVirtualizedResponseSearch,
  getLastResponseBody,
  isResponseVirtualized,
  revealVirtualizedResponseSearchMatch,
  type ResponseSearchMatch,
  setVirtualizedResponseSearch,
} from './response';

let isOpen = false;
let matches: ResponseSearchMatch[] = [];
let currentMatch = -1;
let lastQuery = '';
let highlightedElements: HTMLElement[] = [];

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

/** Open the search bar and focus the input */
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

/** Close the search bar and clear highlights */
export function closeSearch(): void {
  const { bar, input, section } = getElements();
  bar.style.display = 'none';
  section?.classList.remove('resp-search-open');
  isOpen = false;
  input.value = '';
  lastQuery = '';
  clearHighlights();
  clearVirtualizedResponseSearch();
  matches = [];
  currentMatch = -1;
  updateCount();
}

export function isSearchOpen(): boolean {
  return isOpen;
}

/** Clear all search highlight marks from the response body */
function clearHighlights(): void {
  const parentsToNormalize = new Set<Node>();

  for (const el of highlightedElements) {
    const parent = el.parentNode;
    if (parent) {
      const text = document.createTextNode(el.textContent || '');
      parent.replaceChild(text, el);
      parentsToNormalize.add(parent);
    }
  }

  for (const parent of parentsToNormalize) {
    parent.normalize();
  }

  highlightedElements = [];
}

function buildMatches(query: string): ResponseSearchMatch[] {
  const lines = getLastResponseBody().split('\n');
  const lowerQuery = query.toLowerCase();
  const found: ResponseSearchMatch[] = [];
  let matchNumber = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lowerLine = line.toLowerCase();
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

function syncVirtualizedSearchResults(): void {
  if (!isResponseVirtualized()) {
    return;
  }

  if (matches.length === 0 || currentMatch < 0) {
    clearVirtualizedResponseSearch();
    return;
  }

  setVirtualizedResponseSearch(matches, currentMatch);
  revealVirtualizedResponseSearchMatch(matches[currentMatch]);
}

/** Update the match count display */
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
 * Perform the search across the text content of respBodyPre.
 * We use a TreeWalker to find text nodes, then wrap matches with <mark> elements.
 */
function performSearch(query: string): void {
  clearHighlights();
  clearVirtualizedResponseSearch();
  matches = [];
  currentMatch = -1;
  lastQuery = query;

  if (!query) {
    updateCount();
    return;
  }

  if (isResponseVirtualized()) {
    matches = buildMatches(query);

    if (matches.length > 0) {
      currentMatch = 0;
      syncVirtualizedSearchResults();
    }

    updateCount();
    return;
  }

  const { pre } = getElements();
  const lowerQuery = query.toLowerCase();

  // Gather all text nodes in the pre element
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    textNodes.push(node);
  }

  // Search and wrap matches with <mark> elements
  // Process in reverse so DOM modifications don't affect subsequent node positions
  const marks: HTMLElement[] = [];
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const textNode = textNodes[i];
    const text = textNode.textContent || '';
    const lowerText = text.toLowerCase();
    const nodeMatches: { start: number; end: number }[] = [];

    let searchFrom = 0;
    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(lowerQuery, searchFrom);
      if (idx === -1) break;
      nodeMatches.push({ start: idx, end: idx + query.length });
      searchFrom = idx + Math.max(query.length, 1);
    }

    if (nodeMatches.length === 0) continue;

    // Split this text node and wrap matches
    const parent = textNode.parentNode;
    if (!parent) continue;

    const frag = document.createDocumentFragment();
    let lastEnd = 0;

    for (const m of nodeMatches) {
      // Text before match
      if (m.start > lastEnd) {
        frag.appendChild(document.createTextNode(text.substring(lastEnd, m.start)));
      }
      // The match
      const mark = document.createElement('mark');
      mark.className = 'resp-search-match';
      mark.textContent = text.substring(m.start, m.end);
      marks.unshift(mark); // unshift because we're iterating in reverse
      frag.appendChild(mark);
      lastEnd = m.end;
    }

    // Text after last match
    if (lastEnd < text.length) {
      frag.appendChild(document.createTextNode(text.substring(lastEnd)));
    }

    parent.replaceChild(frag, textNode);
  }

  highlightedElements = marks;
  matches = marks.map((_, index) => ({ line: -1, start: 0, end: 0, index }));

  if (marks.length > 0) {
    currentMatch = 0;
    marks[0].classList.add('resp-search-current');
    scrollToMatch(marks[0]);
  }

  updateCount();
}

/** Scroll to the current match mark element */
function scrollToMatch(mark: HTMLElement): void {
  mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Navigate to the next match */
function goToNext(): void {
  if (matches.length === 0) return;

  if (isResponseVirtualized()) {
    currentMatch = (currentMatch + 1) % matches.length;
    syncVirtualizedSearchResults();
    updateCount();
    return;
  }

  if (highlightedElements.length === 0) return;
  highlightedElements[currentMatch]?.classList.remove('resp-search-current');
  currentMatch = (currentMatch + 1) % highlightedElements.length;
  highlightedElements[currentMatch].classList.add('resp-search-current');
  scrollToMatch(highlightedElements[currentMatch]);
  updateCount();
}

/** Navigate to the previous match */
function goToPrev(): void {
  if (matches.length === 0) return;

  if (isResponseVirtualized()) {
    currentMatch = (currentMatch - 1 + matches.length) % matches.length;
    syncVirtualizedSearchResults();
    updateCount();
    return;
  }

  if (highlightedElements.length === 0) return;
  highlightedElements[currentMatch]?.classList.remove('resp-search-current');
  currentMatch = (currentMatch - 1 + highlightedElements.length) % highlightedElements.length;
  highlightedElements[currentMatch].classList.add('resp-search-current');
  scrollToMatch(highlightedElements[currentMatch]);
  updateCount();
}

/** Initialize the search bar event listeners. Call once after DOM is ready. */
export function initResponseSearch(): void {
  const { input, prev, next, close } = getElements();

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performSearch(input.value);
    }, 150);
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
      // Return focus to the response body
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
