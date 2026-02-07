// OData query parameter autocomplete for param name fields.

import { escHtml } from './highlight';

const ODATA_PARAMS: { name: string; description: string }[] = [
  { name: '$select', description: 'Choose which properties to return' },
  { name: '$filter', description: 'Filter results based on conditions' },
  { name: '$orderby', description: 'Sort results by properties' },
  { name: '$top', description: 'Limit the number of results' },
  { name: '$skip', description: 'Skip a number of results' },
  { name: '$count', description: 'Include total count of results' },
  { name: '$expand', description: 'Include related entities inline' },
  { name: '$search', description: 'Free-text search expression' },
  { name: '$format', description: 'Response format (json, xml, etc.)' },
  { name: '$compute', description: 'Define computed properties' },
  { name: '$index', description: 'Positional insert index' },
  { name: '$schemaversion', description: 'Target a specific schema version' },
  { name: '$apply', description: 'Aggregation and grouping' },
  { name: '$skiptoken', description: 'Server-driven paging token' },
  { name: '$deltatoken', description: 'Delta tracking token' },
];

let odDropdown: HTMLElement | null = null;
let odItems: typeof ODATA_PARAMS = [];
let odSelectedIndex = 0;
let odTarget: HTMLInputElement | null = null;

export function getODataPrefix(text: string, cursorPos: number): string | null {
  const before = text.substring(0, cursorPos);
  const dollarIdx = before.lastIndexOf('$');
  if (dollarIdx === -1) return null;
  // $ must be at start of value or preceded by nothing meaningful
  if (dollarIdx > 0 && /\w/.test(before[dollarIdx - 1])) return null;
  const prefix = before.substring(dollarIdx);
  if (!/^\$[\w]*$/.test(prefix)) return null;
  return prefix;
}

export function handleODataAutocomplete(input: HTMLInputElement): void {
  const pos = input.selectionStart ?? 0;
  const prefix = getODataPrefix(input.value, pos);
  if (prefix === null) {
    hideODataAutocomplete();
    return;
  }
  odTarget = input;
  const lowerPrefix = prefix.toLowerCase();
  odItems = ODATA_PARAMS.filter(p => p.name.toLowerCase().startsWith(lowerPrefix));
  if (odItems.length === 0) {
    hideODataAutocomplete();
    return;
  }
  odSelectedIndex = 0;

  if (!odDropdown) {
    odDropdown = document.createElement('div');
    odDropdown.className = 'var-autocomplete';
    document.body.appendChild(odDropdown);
  }

  renderODataItems();
  positionODataDropdown(input);
}

function renderODataItems(): void {
  if (!odDropdown) return;
  odDropdown.innerHTML = odItems.map((item, i) => {
    const cls = i === odSelectedIndex ? 'var-autocomplete-item selected' : 'var-autocomplete-item';
    return "<div class='" + cls + "' data-index='" + i + "'>" +
      "<span class='var-ac-name'>" + escHtml(item.name) + "</span>" +
      "<span class='var-ac-value'>" + escHtml(item.description) + "</span>" +
      "</div>";
  }).join('');

  odDropdown.querySelectorAll('.var-autocomplete-item').forEach((el) => {
    el.addEventListener('mousedown', (e: Event) => {
      e.preventDefault();
      const idx = parseInt((el as HTMLElement).dataset.index || '0');
      acceptODataItem(odItems[idx].name);
    });
  });
}

function positionODataDropdown(input: HTMLInputElement): void {
  if (!odDropdown) return;
  const rect = input.getBoundingClientRect();
  odDropdown.style.left = rect.left + 'px';
  odDropdown.style.top = (rect.bottom + 2) + 'px';
  odDropdown.style.minWidth = '280px';
}

function acceptODataItem(name: string): void {
  if (!odTarget) return;
  odTarget.value = name;
  odTarget.focus();
  odTarget.dispatchEvent(new Event('input', { bubbles: true }));
  hideODataAutocomplete();
}

export function hideODataAutocomplete(): void {
  if (odDropdown) {
    odDropdown.remove();
    odDropdown = null;
  }
  odTarget = null;
  odItems = [];
  odSelectedIndex = 0;
}

export function handleODataKeydown(e: KeyboardEvent): boolean {
  if (!odDropdown || odItems.length === 0) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    odSelectedIndex = (odSelectedIndex + 1) % odItems.length;
    renderODataItems();
    return true;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    odSelectedIndex = (odSelectedIndex - 1 + odItems.length) % odItems.length;
    renderODataItems();
    return true;
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    acceptODataItem(odItems[odSelectedIndex].name);
    return true;
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideODataAutocomplete();
    return true;
  }
  return false;
}

export function isODataAutocompleteActive(): boolean {
  return odDropdown !== null;
}
