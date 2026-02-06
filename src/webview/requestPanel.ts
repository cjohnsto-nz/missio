// Webview script for the Request Panel
// This runs inside the VS Code webview, NOT in the extension host.

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const vscode: VsCodeApi = acquireVsCodeApi();
let currentRequest: any = null;
let resolvedVariables: Record<string, string> = {};
let updateDocumentTimer: ReturnType<typeof setTimeout> | null = null;
let ignoreNextLoad = false;

function scheduleDocumentUpdate(): void {
  if (updateDocumentTimer) clearTimeout(updateDocumentTimer);
  updateDocumentTimer = setTimeout(() => {
    ignoreNextLoad = true;
    const req = buildRequest();
    vscode.postMessage({ type: 'updateDocument', request: req });
  }, 300);
}

// ── Helpers ───────────────────────────────────
function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function $input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Tab switching ──────────────────────────────
const reqPanelIds = ['body', 'auth', 'headers', 'params', 'settings'];
const respPanelIds = ['resp-body', 'resp-headers'];

function switchTab(tabBar: HTMLElement, tabId: string, panelIds: string[]): void {
  tabBar.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  const clicked = tabBar.querySelector(`[data-tab="${tabId}"]`);
  if (clicked) clicked.classList.add('active');
  panelIds.forEach((pid) => {
    const p = document.getElementById('panel-' + pid);
    if (p) p.classList.toggle('active', pid === tabId);
  });
}

$('reqTabs').querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchTab($('reqTabs'), (tab as HTMLElement).dataset.tab!, reqPanelIds);
  });
});
$('respTabs').querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchTab($('respTabs'), (tab as HTMLElement).dataset.tab!, respPanelIds);
  });
});

// ── Resizable divider ──────────────────────────
const divider = $('divider');
const reqSection = $('requestSection');
const respSection = $('responseSection');
let isDragging = false;

divider.addEventListener('mousedown', () => {
  isDragging = true;
  divider.classList.add('dragging');
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!isDragging) return;
  const container = document.querySelector('.main-content')!;
  const containerRect = container.getBoundingClientRect();
  const offset = e.clientY - containerRect.top;
  const total = containerRect.height;
  const pct = Math.max(15, Math.min(85, (offset / total) * 100));
  reqSection.style.flex = 'none';
  reqSection.style.height = pct + '%';
  respSection.style.flex = 'none';
  respSection.style.height = (100 - pct) + '%';
});

document.addEventListener('mouseup', () => {
  isDragging = false;
  divider.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// ── Method color ────────────────────────────────
const methodSelect = $('method') as HTMLSelectElement;
function updateMethodColor(): void {
  methodSelect.className = 'method-select ' + methodSelect.value.toLowerCase();
}
methodSelect.addEventListener('change', () => {
  updateMethodColor();
  scheduleDocumentUpdate();
  vscode.postMessage({ type: 'methodChanged', method: methodSelect.value });
});

// ── Params ──────────────────────────────────────
function addParam(name = '', value = '', type = 'query', disabled = false): void {
  const tbody = $('paramsBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="checkbox" class="p-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="p-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td><input type="text" class="p-value" value="' + esc(value) + '" placeholder="value" /></td>' +
    '<td><select class="p-type auth-select" style="margin:0;"><option value="query"' + (type === 'query' ? ' selected' : '') + '>query</option><option value="path"' + (type === 'path' ? ' selected' : '') + '>path</option></select></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); updateBadges(); scheduleDocumentUpdate(); });
  tr.addEventListener('input', scheduleDocumentUpdate);
  tr.addEventListener('change', scheduleDocumentUpdate);
  tbody.appendChild(tr);
  updateBadges();
}

// ── Headers ─────────────────────────────────────
function addHeader(name = '', value = '', disabled = false): void {
  const tbody = $('headersBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="checkbox" class="h-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="h-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td><input type="text" class="h-value" value="' + esc(value) + '" placeholder="value" /></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); updateBadges(); scheduleDocumentUpdate(); });
  tr.addEventListener('input', scheduleDocumentUpdate);
  tr.addEventListener('change', scheduleDocumentUpdate);
  tbody.appendChild(tr);
  updateBadges();
}

// ── Form Fields ─────────────────────────────────
function addFormField(name = '', value = '', disabled = false): void {
  const tbody = $('bodyFormBody');
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="checkbox" class="f-enabled" ' + (disabled ? '' : 'checked') + ' /></td>' +
    '<td><input type="text" class="f-name" value="' + esc(name) + '" placeholder="name" /></td>' +
    '<td><input type="text" class="f-value" value="' + esc(value) + '" placeholder="value" /></td>' +
    '<td><button class="row-delete">\u00d7</button></td>';
  tr.querySelector('.row-delete')!.addEventListener('click', () => { tr.remove(); scheduleDocumentUpdate(); });
  tr.addEventListener('input', scheduleDocumentUpdate);
  tr.addEventListener('change', scheduleDocumentUpdate);
  tbody.appendChild(tr);
}

function updateBadges(): void {
  const params = document.querySelectorAll('#paramsBody tr');
  const headers = document.querySelectorAll('#headersBody tr');
  $('paramsBadge').textContent = String(params.length);
  $('headersBadge').textContent = String(headers.length);
}

// ── Body Type (pills) ───────────────────────────
let currentBodyType = 'none';
let currentLang = 'json';

function setBodyType(type: string): void {
  currentBodyType = type;
  document.querySelectorAll('#bodyTypePills .pill').forEach((p) => {
    p.classList.toggle('active', (p as HTMLElement).dataset.bodyType === type);
  });
  const raw = $('bodyRawEditor');
  const form = $('bodyFormEditor');
  const langSelect = $('bodyLangMode');
  if (type === 'none') {
    raw.style.display = 'none';
    form.style.display = 'none';
    langSelect.style.display = 'none';
  } else if (type === 'form-urlencoded' || type === 'multipart-form') {
    raw.style.display = 'none';
    form.style.display = 'block';
    langSelect.style.display = 'none';
  } else {
    raw.style.display = 'flex';
    raw.style.flexDirection = 'column';
    raw.style.flex = '1';
    form.style.display = 'none';
    langSelect.style.display = 'block';
  }
}

document.querySelectorAll('#bodyTypePills .pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    setBodyType((pill as HTMLElement).dataset.bodyType!);
  });
});

// ── Syntax Highlighting ─────────────────────────
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightJSON(code: string): string {
  let h = escHtml(code);
  // Keys (before colon) — single-quote attrs + &quot; to prevent re-matching
  h = h.replace(/(")((?:[^"\\]|\\.)*)(")\s*:/g, "<span class='tk-key'>&quot;$2&quot;</span>:");
  // Strings
  h = h.replace(/(")((?:[^"\\]|\\.)*)(")/g, "<span class='tk-str'>&quot;$2&quot;</span>");
  // Numbers
  h = h.replace(/\b(-?\d+\.?\d*(?:e[+-]?\d+)?)\b/gi, "<span class='tk-num'>$1</span>");
  // Keywords
  h = h.replace(/\b(true|false|null)\b/g, "<span class='tk-kw'>$1</span>");
  return h;
}

function highlightXML(code: string): string {
  let h = escHtml(code);
  // Tags
  h = h.replace(/(&lt;\/?)([\w:-]+)/g, "$1<span class='tk-tag'>$2</span>");
  // Attributes
  h = h.replace(/([\w:-]+)(=)(")((?:[^"]*))(")/g, "<span class='tk-attr'>$1</span>$2<span class='tk-str'>&quot;$4&quot;</span>");
  return h;
}

function highlightVariables(html: string): string {
  return html.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_match: string, name: string) => {
    const key = name.trim();
    const resolved = key in resolvedVariables;
    const cls = resolved ? 'tk-var' : 'tk-var tk-var-unresolved';
    return "<span class='" + cls + "' data-var='" + escHtml(key) + "'>{{" + escHtml(name) + "}}</span>";
  });
}

function highlight(code: string, lang: string): string {
  let h: string;
  if (lang === 'json') h = highlightJSON(code);
  else if (lang === 'xml' || lang === 'html') h = highlightXML(code);
  else h = escHtml(code);
  return highlightVariables(h);
}

function updateLineNumbers(): void {
  const textarea = $('bodyData') as HTMLTextAreaElement;
  const gutter = $('lineNumbers');
  const lineCount = (textarea.value.match(/\n/g) || []).length + 1;
  const current = gutter.children.length;
  if (current !== lineCount) {
    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      html += '<span>' + i + '</span>';
    }
    gutter.innerHTML = html;
  }
  gutter.style.top = -textarea.scrollTop + 'px';
}

function syncHighlight(): void {
  try {
    const textarea = $('bodyData') as HTMLTextAreaElement;
    const pre = $('bodyHighlight');
    pre.innerHTML = highlight(textarea.value, currentLang) + '\n';
    updateLineNumbers();
  } catch {
    // prevent highlighting errors from breaking UI
  }
}

// ── Variable Tooltip ────────────────────────────
let activeTooltip: HTMLElement | null = null;

function findVarAtCursor(text: string, cursorPos: number): string | null {
  const re = /\{\{(\s*[\w.]+\s*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (cursorPos >= m.index && cursorPos <= m.index + m[0].length) {
      return m[1].trim();
    }
  }
  return null;
}

function showVarTooltipAt(anchorEl: HTMLElement, varName: string): void {
  hideVarTooltip();
  const rect = anchorEl.getBoundingClientRect();
  const resolved = varName in resolvedVariables;
  const tooltip = document.createElement('div');
  tooltip.className = 'var-tooltip';
  tooltip.innerHTML =
    "<div class='var-name'>{{" + escHtml(varName) + "}}</div>" +
    (resolved
      ? "<div class='var-value'>" + escHtml(resolvedVariables[varName]) + "</div>"
      : "<div class='var-unresolved'>Unresolved variable</div>") +
    "<div class='var-actions'>" +
    "<button class='var-action-btn' data-action='edit'>Edit Variable</button>" +
    "<button class='var-action-btn' data-action='copy'>" + (resolved ? 'Copy Value' : 'Copy Name') + "</button>" +
    "</div>";

  tooltip.style.left = rect.left + 'px';
  tooltip.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  tooltip.querySelectorAll('.var-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'edit') {
        vscode.postMessage({ type: 'editVariable', variableName: varName });
      } else if (action === 'copy') {
        const text = resolved ? resolvedVariables[varName] : '{{' + varName + '}}';
        navigator.clipboard.writeText(text).catch(() => {});
      }
      hideVarTooltip();
    });
  });

  setTimeout(() => {
    document.addEventListener('click', onTooltipOutsideClick);
  }, 0);
}

function hideVarTooltip(): void {
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
  document.removeEventListener('click', onTooltipOutsideClick);
}

function onTooltipOutsideClick(e: MouseEvent): void {
  if (activeTooltip && !activeTooltip.contains(e.target as Node)) {
    hideVarTooltip();
  }
}

// Delegate click on .tk-var spans in the body highlight overlay
$('bodyHighlight').addEventListener('click', (e: Event) => {
  const target = (e.target as HTMLElement).closest('.tk-var') as HTMLElement | null;
  if (target && target.dataset.var) {
    showVarTooltipAt(target, target.dataset.var);
  }
});

// ── URL contenteditable highlighting ────────────
function getUrlText(): string {
  return $('url').textContent || '';
}

function setUrlText(text: string): void {
  $('url').textContent = text;
  syncUrlHighlight();
}

function syncUrlHighlight(): void {
  const el = $('url');
  const text = el.textContent || '';
  if (!text) {
    el.innerHTML = '';
    return;
  }
  // Save cursor position
  const sel = window.getSelection();
  let cursorOffset = 0;
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    cursorOffset = preRange.toString().length;
  }
  // Re-render with highlighted variables
  el.innerHTML = highlightVariables(escHtml(text));
  // Restore cursor position
  if (sel && document.activeElement === el) {
    restoreCursor(el, cursorOffset);
  }
}

function restoreCursor(el: HTMLElement, offset: number): void {
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

// Click on .tk-var in URL bar shows tooltip
$('url').addEventListener('click', (e: Event) => {
  const target = (e.target as HTMLElement).closest('.tk-var') as HTMLElement | null;
  if (target && target.dataset.var) {
    showVarTooltipAt(target, target.dataset.var);
  }
});

// Re-highlight + autocomplete on input
$('url').addEventListener('input', () => {
  syncUrlHighlight();
  handleAutocompleteContentEditable($('url'));
  scheduleDocumentUpdate();
});

function syncScroll(): void {
  const textarea = $('bodyData') as HTMLTextAreaElement;
  const pre = $('bodyHighlight');
  pre.scrollTop = textarea.scrollTop;
  pre.scrollLeft = textarea.scrollLeft;
  updateLineNumbers();
}

$('bodyData').addEventListener('input', () => {
  syncHighlight();
  handleAutocomplete($('bodyData') as HTMLTextAreaElement);
  scheduleDocumentUpdate();
});
$('bodyData').addEventListener('scroll', syncScroll);

// Click on variable in body editor — peek through textarea to highlight layer
$('bodyData').addEventListener('click', (e: Event) => {
  const me = e as MouseEvent;
  const textarea = $('bodyData');
  textarea.style.pointerEvents = 'none';
  const el = document.elementFromPoint(me.clientX, me.clientY);
  textarea.style.pointerEvents = '';
  if (el) {
    const varEl = (el as HTMLElement).closest('.tk-var') as HTMLElement | null;
    if (varEl && varEl.dataset.var) {
      showVarTooltipAt(varEl, varEl.dataset.var);
    }
  }
});


// ── Variable Autocomplete ───────────────────────
let acDropdown: HTMLElement | null = null;
let acItems: string[] = [];
let acSelectedIndex = 0;
let acTarget: HTMLTextAreaElement | HTMLElement | null = null;
let acStartPos = 0;
let acIsContentEditable = false;

function getVarPrefix(text: string, cursorPos: number): string | null {
  // Look backwards from cursor for {{ not yet closed by }}
  const before = text.substring(0, cursorPos);
  const openIdx = before.lastIndexOf('{{');
  if (openIdx === -1) return null;
  const afterOpen = before.substring(openIdx + 2);
  // If there's a }} between {{ and cursor, not in a variable
  if (afterOpen.includes('}}')) return null;
  // The prefix is everything after {{
  const prefix = afterOpen.trim();
  // Only allow word chars and dots
  if (!/^[\w.]*$/.test(prefix)) return null;
  return prefix;
}

function handleAutocomplete(textarea: HTMLTextAreaElement): void {
  const pos = textarea.selectionStart ?? 0;
  const prefix = getVarPrefix(textarea.value, pos);
  if (prefix === null) {
    hideAutocomplete();
    return;
  }
  acTarget = textarea;
  acIsContentEditable = false;
  acStartPos = textarea.value.lastIndexOf('{{', pos - 1);
  showAutocompleteDropdown(prefix, textarea);
}

function handleAutocompleteContentEditable(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const text = el.textContent || '';
  // Calculate cursor offset in plain text
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
  showAutocompleteDropdown(prefix, el);
}

function showAutocompleteDropdown(prefix: string, anchor: HTMLElement): void {
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
    // For contenteditable, use selection range
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
    // For textarea, use mirror div to get caret position
    const coords = getCaretCoords(anchor as HTMLTextAreaElement);
    acDropdown.style.left = coords.left + 'px';
    acDropdown.style.top = (coords.top + 18) + 'px';
  }
  acDropdown.style.minWidth = '220px';
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
    // Skip trailing }} if already present after cursor
    let endPos = cursorPos;
    const after = text.substring(cursorPos);
    if (after.startsWith('}}')) endPos += 2;
    const newText = text.substring(0, acStartPos) + suffix + text.substring(endPos);
    el.textContent = newText;
    syncUrlHighlight();
    const newCursorPos = acStartPos + suffix.length;
    restoreCursor(el, newCursorPos);
  } else {
    const textarea = acTarget as HTMLTextAreaElement;
    const text = textarea.value;
    const cursorPos = textarea.selectionStart ?? text.length;
    const suffix = '{{' + varName + '}}';
    // Skip trailing }} if already present after cursor
    let endPos = cursorPos;
    const after = text.substring(cursorPos);
    if (after.startsWith('}}')) endPos += 2;
    textarea.value = text.substring(0, acStartPos) + suffix + text.substring(endPos);
    const newCursorPos = acStartPos + suffix.length;
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;
    textarea.focus();
    syncHighlight();
  }
  hideAutocomplete();
}

function hideAutocomplete(): void {
  if (acDropdown) {
    acDropdown.remove();
    acDropdown = null;
  }
  acTarget = null;
  acItems = [];
  acSelectedIndex = 0;
}

// Keyboard navigation for autocomplete
function handleAutocompleteKeydown(e: KeyboardEvent): void {
  if (!acDropdown || acItems.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acSelectedIndex = (acSelectedIndex + 1) % acItems.length;
    renderAutocompleteItems();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acSelectedIndex = (acSelectedIndex - 1 + acItems.length) % acItems.length;
    renderAutocompleteItems();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    acceptAutocomplete(acItems[acSelectedIndex]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideAutocomplete();
  }
}

$('bodyData').addEventListener('keydown', (e: Event) => {
  if (acDropdown) handleAutocompleteKeydown(e as KeyboardEvent);
});
$('url').addEventListener('keydown', (e: Event) => {
  if (acDropdown) {
    handleAutocompleteKeydown(e as KeyboardEvent);
    return;
  }
  // Existing: prevent Enter from creating new lines
  if ((e as KeyboardEvent).key === 'Enter') {
    e.preventDefault();
  }
});

// Close autocomplete on blur
$('bodyData').addEventListener('blur', () => { setTimeout(hideAutocomplete, 150); });
$('url').addEventListener('blur', () => { setTimeout(hideAutocomplete, 150); });

// ── Auth Type ───────────────────────────────────
function onAuthTypeChange(): void {
  const type = ($('authType') as HTMLSelectElement).value;
  const fields = $('authFields');
  fields.innerHTML = '';
  if (type === 'bearer') {
    fields.innerHTML = '<div class="auth-row"><label>Token</label><input type="text" id="authToken" placeholder="{{token}}" /></div>';
  } else if (type === 'basic') {
    fields.innerHTML = '<div class="auth-row"><label>Username</label><input type="text" id="authUsername" placeholder="username" /></div>' +
      '<div class="auth-row"><label>Password</label><input type="password" id="authPassword" placeholder="password" /></div>';
  } else if (type === 'apikey') {
    fields.innerHTML = '<div class="auth-row"><label>Key</label><input type="text" id="authKey" placeholder="X-Api-Key" /></div>' +
      '<div class="auth-row"><label>Value</label><input type="text" id="authValue" placeholder="{{apiKey}}" /></div>' +
      '<div class="auth-row"><label>In</label><select id="authPlacement" class="auth-select" style="margin:0;"><option value="header">Header</option><option value="query">Query</option></select></div>';
  }
}

// ── Build request object ────────────────────────
function buildRequest(): any {
  // Start from a deep clone of the original parsed object to preserve all unknown fields
  const req: any = currentRequest ? JSON.parse(JSON.stringify(currentRequest)) : {};

  // Ensure top-level structures exist
  if (!req.info) req.info = { type: 'http' };
  if (!req.http) req.http = {};
  if (!req.settings) req.settings = {};

  // Update only the fields the UI manages
  req.http.method = (methodSelect as HTMLSelectElement).value;
  req.http.url = getUrlText();

  // Params
  const params: any[] = [];
  document.querySelectorAll('#paramsBody tr').forEach((tr) => {
    params.push({
      name: (tr.querySelector('.p-name') as HTMLInputElement).value,
      value: (tr.querySelector('.p-value') as HTMLInputElement).value,
      type: (tr.querySelector('.p-type') as HTMLSelectElement).value,
      disabled: !(tr.querySelector('.p-enabled') as HTMLInputElement).checked,
    });
  });
  req.http.params = params;

  // Headers
  const headers: any[] = [];
  document.querySelectorAll('#headersBody tr').forEach((tr) => {
    headers.push({
      name: (tr.querySelector('.h-name') as HTMLInputElement).value,
      value: (tr.querySelector('.h-value') as HTMLInputElement).value,
      disabled: !(tr.querySelector('.h-enabled') as HTMLInputElement).checked,
    });
  });
  req.http.headers = headers;

  // Body
  if (currentBodyType !== 'none') {
    if (currentBodyType === 'form-urlencoded' || currentBodyType === 'multipart-form') {
      const data: any[] = [];
      document.querySelectorAll('#bodyFormBody tr').forEach((tr) => {
        data.push({
          name: (tr.querySelector('.f-name') as HTMLInputElement).value,
          value: (tr.querySelector('.f-value') as HTMLInputElement).value,
          disabled: !(tr.querySelector('.f-enabled') as HTMLInputElement).checked,
        });
      });
      req.http.body = { type: currentBodyType, data };
    } else {
      req.http.body = { type: currentLang, data: ($('bodyData') as HTMLTextAreaElement).value };
    }
  } else {
    delete req.http.body;
  }

  // Auth
  const authType = ($('authType') as HTMLSelectElement).value;
  if (authType === 'bearer') {
    req.http.auth = { type: 'bearer', token: $input('authToken')?.value || '' };
  } else if (authType === 'basic') {
    req.http.auth = { type: 'basic', username: $input('authUsername')?.value || '', password: $input('authPassword')?.value || '' };
  } else if (authType === 'apikey') {
    req.http.auth = { type: 'apikey', key: $input('authKey')?.value || '', value: $input('authValue')?.value || '', placement: ($('authPlacement') as HTMLSelectElement)?.value || 'header' };
  } else if (authType === 'inherit') {
    req.http.auth = 'inherit';
  } else {
    delete req.http.auth;
  }

  // Settings — merge onto existing
  req.settings.timeout = parseInt($input('settingTimeout').value) || 30000;
  req.settings.encodeUrl = $input('settingEncodeUrl').checked;
  req.settings.followRedirects = $input('settingFollowRedirects').checked;
  req.settings.maxRedirects = parseInt($input('settingMaxRedirects').value) || 5;

  return req;
}

// ── Send ────────────────────────────────────────
let lastResponse: any = null;

function showLoading(): void {
  $('respLoading').style.display = 'flex';
  $('respEmpty').style.display = 'none';
  $('respBodyWrap').style.display = 'none';
  $('responseBar').style.display = 'none';
  $('respTabs').style.display = 'none';
}

function hideLoading(): void {
  $('respLoading').style.display = 'none';
}

function sendRequest(): void {
  const req = buildRequest();
  $('sendBtn').classList.add('sending');
  ($('sendBtn') as HTMLButtonElement).disabled = true;
  $('sendBtn').textContent = 'Sending...';
  showLoading();
  vscode.postMessage({ type: 'sendRequest', request: req });
}

// ── Save ────────────────────────────────────────
function saveRequest(): void {
  if (updateDocumentTimer) {
    clearTimeout(updateDocumentTimer);
    updateDocumentTimer = null;
  }
  ignoreNextLoad = true;
  const req = buildRequest();
  vscode.postMessage({ type: 'saveDocument', request: req });
}

// ── Load request into UI ────────────────────────
function clearResponse(): void {
  $('responseBar').style.display = 'none';
  $('respTabs').style.display = 'none';
  $('respBodyWrap').style.display = 'none';
  $('respEmpty').style.display = 'block';
  lastResponse = null;
  lastResponseBody = '';
}

function loadRequest(req: any): void {
  currentRequest = req;
  clearResponse();
  const http = req.http || {};
  (methodSelect as HTMLSelectElement).value = (http.method || 'GET').toUpperCase();
  updateMethodColor();
  setUrlText(http.url || '');

  // Params
  $('paramsBody').innerHTML = '';
  (http.params || []).forEach((p: any) => addParam(p.name, p.value, p.type || 'query', p.disabled));

  // Headers
  $('headersBody').innerHTML = '';
  (http.headers || []).forEach((h: any) => addHeader(h.name, h.value, h.disabled));

  // Body
  if (http.body) {
    const body = Array.isArray(http.body)
      ? ((http.body.find((v: any) => v.selected) || http.body[0])?.body)
      : http.body;
    if (body) {
      if (body.type === 'form-urlencoded' || body.type === 'multipart-form') {
        setBodyType(body.type);
        $('bodyFormBody').innerHTML = '';
        (body.data || []).forEach((f: any) => addFormField(f.name, f.value, f.disabled));
      } else {
        setBodyType('raw');
        currentLang = body.type || 'json';
        ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
        if (body.data) {
          ($('bodyData') as HTMLTextAreaElement).value = body.data;
        }
        syncHighlight();
      }
    }
  } else {
    setBodyType('none');
  }

  // Auth
  const auth = http.auth;
  if (auth === 'inherit') {
    ($('authType') as HTMLSelectElement).value = 'inherit';
  } else if (auth && auth.type) {
    ($('authType') as HTMLSelectElement).value = auth.type;
    onAuthTypeChange();
    if (auth.type === 'bearer') {
      setTimeout(() => { const el = $input('authToken'); if (el) el.value = auth.token || ''; }, 0);
    } else if (auth.type === 'basic') {
      setTimeout(() => {
        const u = $input('authUsername'); if (u) u.value = auth.username || '';
        const p = $input('authPassword'); if (p) p.value = auth.password || '';
      }, 0);
    } else if (auth.type === 'apikey') {
      setTimeout(() => {
        const k = $input('authKey'); if (k) k.value = auth.key || '';
        const v = $input('authValue'); if (v) v.value = auth.value || '';
        const pl = $('authPlacement') as HTMLSelectElement; if (pl) pl.value = auth.placement || 'header';
      }, 0);
    }
  } else {
    ($('authType') as HTMLSelectElement).value = 'none';
  }
  onAuthTypeChange();

  // Settings
  const settings = req.settings || {};
  $input('settingTimeout').value = settings.timeout !== undefined && settings.timeout !== 'inherit' ? settings.timeout : '30000';
  $input('settingEncodeUrl').checked = settings.encodeUrl !== undefined && settings.encodeUrl !== 'inherit' ? settings.encodeUrl : true;
  $input('settingFollowRedirects').checked = settings.followRedirects !== undefined && settings.followRedirects !== 'inherit' ? settings.followRedirects : true;
  $input('settingMaxRedirects').value = settings.maxRedirects !== undefined && settings.maxRedirects !== 'inherit' ? settings.maxRedirects : '5';

  updateBadges();
}

// ── Display response ────────────────────────────
let lastResponseBody = '';

function updateRespLineNumbers(text: string): void {
  const gutter = $('respLineNumbers');
  const lineCount = (text.match(/\n/g) || []).length + 1;
  let html = '';
  for (let i = 1; i <= lineCount; i++) {
    html += '<span>' + i + '</span>';
  }
  gutter.innerHTML = html;
}

function showResponse(resp: any): void {
  hideLoading();
  lastResponse = resp;
  $('sendBtn').classList.remove('sending');
  ($('sendBtn') as HTMLButtonElement).disabled = false;
  $('sendBtn').textContent = 'Send';
  $('responseBar').style.display = 'flex';
  $('respTabs').style.display = 'flex';
  $('respEmpty').style.display = 'none';
  $('respBodyWrap').style.display = 'block';

  const badge = $('statusBadge');
  badge.textContent = resp.status + ' ' + resp.statusText;
  const cat = Math.floor(resp.status / 100);
  badge.className = 'status-badge s' + cat + 'xx';

  $('responseMeta').textContent = resp.duration + 'ms \u2022 ' + formatSize(resp.size);

  // Body — detect language from content-type and apply highlighting
  let bodyText = resp.body || '';
  const ct = (resp.headers && resp.headers['content-type']) || '';
  let lang = 'text';
  if (ct.includes('json')) {
    lang = 'json';
    try { bodyText = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* keep raw */ }
  } else if (ct.includes('xml')) {
    lang = 'xml';
  } else if (ct.includes('html')) {
    lang = 'html';
  }

  lastResponseBody = bodyText;
  $('respBodyPre').innerHTML = highlight(bodyText, lang) + '\n';
  updateRespLineNumbers(bodyText);

  // Headers
  const tbody = $('respHeadersBody');
  tbody.innerHTML = '';
  if (resp.headers) {
    Object.entries(resp.headers).forEach(([k, v]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(k) + '</td><td>' + esc(String(v)) + '</td>';
      tbody.appendChild(tr);
    });
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Message handler ─────────────────────────────
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;
  switch (msg.type) {
    case 'requestLoaded':
      if (ignoreNextLoad) {
        ignoreNextLoad = false;
        break;
      }
      loadRequest(msg.request);
      break;
    case 'response':
      showResponse(msg.response);
      break;
    case 'sending':
      $('sendBtn').classList.add('sending');
      ($('sendBtn') as HTMLButtonElement).disabled = true;
      $('sendBtn').textContent = 'Sending...';
      break;
    case 'saved':
      break;
    case 'error':
      hideLoading();
      $('sendBtn').classList.remove('sending');
      ($('sendBtn') as HTMLButtonElement).disabled = false;
      $('sendBtn').textContent = 'Send';
      break;
    case 'languageChanged':
      currentLang = msg.language;
      ($('bodyLangMode') as HTMLSelectElement).value = currentLang;
      syncHighlight();
      break;
    case 'bodyUpdated':
      ($('bodyData') as HTMLTextAreaElement).value = msg.content;
      syncHighlight();
      break;
    case 'examplesUpdated':
      if (currentRequest) currentRequest.examples = msg.examples || [];
      break;
    case 'loadExample': {
      const ex = msg.example;
      if (ex.response) {
        // Convert headers array to object for showResponse
        const headers: Record<string, string> = {};
        if (ex.response.headers) {
          for (const h of ex.response.headers) {
            headers[h.name] = h.value;
          }
        }
        showResponse({
          status: ex.response.status,
          statusText: ex.response.statusText,
          headers,
          body: ex.response.body?.data ?? '',
          duration: 0,
          size: (ex.response.body?.data ?? '').length,
        });
      }
      break;
    }
    case 'variablesResolved':
      resolvedVariables = msg.variables || {};
      syncHighlight();
      syncUrlHighlight();
      break;
  }
});

// ── Wire up buttons & selects ───────────────────
$('sendBtn').addEventListener('click', sendRequest);
$('copyRespBtn').addEventListener('click', () => {
  if (!lastResponseBody) return;
  navigator.clipboard.writeText(lastResponseBody).then(() => {
    const btn = $('copyRespBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});
$('saveExampleBtn').addEventListener('click', () => {
  if (!lastResponse) return;
  const req = buildRequest();
  vscode.postMessage({ type: 'saveExample', request: req, response: lastResponse });
});
$('addParamBtn').addEventListener('click', () => addParam());
$('addHeaderBtn').addEventListener('click', () => addHeader());
$('addFormFieldBtn').addEventListener('click', () => addFormField());
$('authType').addEventListener('change', () => { onAuthTypeChange(); scheduleDocumentUpdate(); });
$('panel-auth').addEventListener('input', scheduleDocumentUpdate);
$('panel-auth').addEventListener('change', scheduleDocumentUpdate);
$('panel-settings').addEventListener('input', scheduleDocumentUpdate);
$('panel-settings').addEventListener('change', scheduleDocumentUpdate);
$('bodyLangMode').addEventListener('change', () => {
  currentLang = ($('bodyLangMode') as HTMLSelectElement).value;
  syncHighlight();
  scheduleDocumentUpdate();
});

// Ctrl+S / Cmd+S to save
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveRequest();
  }
});

// Notify extension we're ready
vscode.postMessage({ type: 'ready' });
