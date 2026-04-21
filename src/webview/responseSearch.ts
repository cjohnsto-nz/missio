// Response body search — Ctrl+F find-in-response for the webview.

import { getLastResponseBody } from './response';

let isOpen = false;
let matches: { start: number; end: number }[] = [];
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
  matches = [];
  currentMatch = -1;
  updateCount();
}

export function isSearchOpen(): boolean {
  return isOpen;
}

/** Clear all search highlight marks from the response body */
function clearHighlights(): void {
  for (const el of highlightedElements) {
    // Replace mark with its text content
    const parent = el.parentNode;
    if (parent) {
      const text = document.createTextNode(el.textContent || '');
      parent.replaceChild(text, el);
      parent.normalize();
    }
  }
  highlightedElements = [];
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
  matches = [];
  currentMatch = -1;
  lastQuery = query;

  if (!query) {
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
      searchFrom = idx + 1;
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
  matches = marks.map(() => ({ start: 0, end: 0 })); // We just need the count; navigation uses the marks array

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
  if (highlightedElements.length === 0) return;
  highlightedElements[currentMatch]?.classList.remove('resp-search-current');
  currentMatch = (currentMatch + 1) % highlightedElements.length;
  highlightedElements[currentMatch].classList.add('resp-search-current');
  scrollToMatch(highlightedElements[currentMatch]);
  updateCount();
}

/** Navigate to the previous match */
function goToPrev(): void {
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
