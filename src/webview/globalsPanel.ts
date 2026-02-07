import { escHtml } from './varlib';
import {
  enableContentEditableValue,
  initVarFields,
  setPostMessage,
  handleVariablesResolved,
} from './varFields';

declare function acquireVsCodeApi(): { postMessage(msg: any): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();

const $ = (id: string) => document.getElementById(id)!;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SECURE_PREFIX = 'secure:';
function generateSecureRef(): string {
  // crypto.randomUUID may not be available in all webview contexts
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, hex).join('');
  return SECURE_PREFIX + s(8) + '-' + s(4) + '-4' + s(3) + '-' + s(4) + '-' + s(12);
}
function extractSecureId(value: string | undefined): string | undefined {
  if (value && value.startsWith(SECURE_PREFIX)) return value.slice(SECURE_PREFIX.length);
  return undefined;
}

interface GlobalVar {
  name: string;
  value?: string;
  secret?: boolean;
  secure?: boolean;
  disabled?: boolean;
}

let variables: GlobalVar[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const _secureValueCache: Record<string, string> = {};

function scheduleUpdate(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Strip secure values before sending — they go via storeSecureValue
    const toSend = variables.map(v => {
      if (v.secret && v.secure) {
        const { value, ...rest } = v;
        return rest;
      }
      return v;
    });
    vscode.postMessage({ type: 'updateVariables', variables: toSend });
  }, 300);
}

function render(): void {
  const tbody = $('varsBody');
  tbody.innerHTML = '';
  variables.forEach((_v, i) => addRow(tbody, i));
  updateHiddenWarning();
}

function updateHiddenWarning(): void {
  const warn = document.getElementById('hiddenWarning');
  if (!warn) return;
  const hasHidden = variables.some(v => v.secret === true && !v.secure);
  warn.style.display = hasHidden ? 'block' : 'none';
}

function addRow(tbody: HTMLElement, idx: number): void {
  const v = variables[idx];
  const tr = document.createElement('tr');
  const isSecret = v.secret === true;
  const isSecure = isSecret && v.secure === true;
  const chk = v.disabled ? '' : 'checked';
  const val = isSecret ? (isSecure ? '' : (v.value || '')) : (v.value || '');

  tr.innerHTML =
    `<td><input type="checkbox" ${chk} data-field="disabled" /></td>` +
    `<td><input type="text" value="${esc(v.name || '')}" data-field="name" /></td>` +
    `${isSecret
      ? '<td><div class="secret-value-wrap"><input type="password" value="' + (isSecure ? '' : esc(val)) + '"' + (isSecure ? ' placeholder="\u2022\u2022\u2022\u2022\u2022\u2022"' : '') + ' data-field="value" /><button class="secret-toggle" title="Show/hide">&#9673;</button></div></td>'
      : '<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="value" data-field="value"></div></td>'
    }` +
    `<td><select class="type-select select-borderless" data-field="type"><option value="var"${!isSecret ? ' selected' : ''}>var</option><option value="hidden"${isSecret && !isSecure ? ' selected' : ''}>hidden</option><option value="secure"${isSecure ? ' selected' : ''}>secure</option></select></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;

  // Wire checkbox and name inputs
  tr.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(inp => {
    const field = inp.dataset.field!;
    if (inp.type === 'checkbox') {
      inp.addEventListener('change', () => { variables[idx].disabled = !inp.checked; scheduleUpdate(); });
    } else if (isSecure && field === 'value') {
      // Secure mode: send to extension host for SecretStorage via UUID
      let debounce: ReturnType<typeof setTimeout> | null = null;
      inp.addEventListener('input', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const secureId = extractSecureId(variables[idx].value);
          if (secureId) {
            vscode.postMessage({ type: 'storeSecureValue', secureId, value: inp.value });
          }
        }, 500);
      });
    } else {
      inp.addEventListener('input', () => {
        (variables[idx] as any)[field] = inp.value;
        scheduleUpdate();
      });
    }
  });

  // Wire contenteditable value for non-secret vars
  if (!isSecret) {
    const valCE = tr.querySelector('.val-ce[data-field="value"]') as HTMLElement;
    if (valCE) {
      enableContentEditableValue(valCE, val, () => {
        variables[idx].value = (valCE as any)._getRawText ? (valCE as any)._getRawText() : (valCE.textContent || '');
        scheduleUpdate();
      });
    }
  }

  // Type dropdown
  const typeSelect = tr.querySelector<HTMLSelectElement>('.type-select');
  typeSelect?.addEventListener('change', () => {
    const newType = typeSelect.value;
    const wasSecure = variables[idx].secure === true;
    // Capture current plain text value from the DOM before re-render
    let currentPlainValue = '';
    if (!wasSecure) {
      const valCE = tr.querySelector('.val-ce[data-field="value"]') as any;
      const valInp = tr.querySelector<HTMLInputElement>('input[data-field="value"]');
      currentPlainValue = valCE?._getRawText ? valCE._getRawText() : (valInp?.value ?? variables[idx].value ?? '');
    }

    if (newType === 'hidden') {
      // If coming from secure, restore cached plain value
      if (wasSecure) {
        const oldId = extractSecureId(variables[idx].value);
        variables[idx].value = (oldId && _secureValueCache[oldId]) || '';
      }
      variables[idx].secret = true;
      delete variables[idx].secure;
    } else if (newType === 'secure') {
      variables[idx].secret = true;
      variables[idx].secure = true;
      // Generate UUID ref and store the current value in SecretStorage
      if (!extractSecureId(variables[idx].value)) {
        const ref = generateSecureRef();
        const secureId = extractSecureId(ref)!;
        variables[idx].value = ref;
        if (currentPlainValue) {
          _secureValueCache[secureId] = currentPlainValue;
          vscode.postMessage({ type: 'storeSecureValue', secureId, value: currentPlainValue });
        }
      }
    } else {
      // Switching to var — restore cached plain value if coming from secure
      if (wasSecure) {
        const oldId = extractSecureId(variables[idx].value);
        variables[idx].value = (oldId && _secureValueCache[oldId]) || '';
      } else {
        variables[idx].value = currentPlainValue;
      }
      delete variables[idx].secret;
      delete variables[idx].secure;
    }
    render();
    scheduleUpdate();
  });

  // Secret toggle
  const toggleBtn = tr.querySelector('.secret-toggle');
  toggleBtn?.addEventListener('click', () => {
    const inp = tr.querySelector<HTMLInputElement>('input[data-field="value"]');
    if (inp) {
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }
  });

  // Delete
  tr.querySelector('.row-delete')?.addEventListener('click', () => {
    // Clean up SecretStorage if deleting a secure var
    const oldId = extractSecureId(variables[idx].value);
    if (oldId) {
      vscode.postMessage({ type: 'deleteSecureValue', secureId: oldId });
    }
    variables.splice(idx, 1);
    render();
    scheduleUpdate();
  });

  // For secure vars, check stored status
  const secureId = extractSecureId(v.value);
  if (isSecure && secureId) {
    vscode.postMessage({ type: 'getSecureStatus', secureId });
  }

  tbody.appendChild(tr);
}

// Handle messages from extension host
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    variables = msg.variables || [];
    render();
  }
  if (msg.type === 'variablesResolved') {
    handleVariablesResolved(msg);
  }
  if (msg.type === 'secureValueStored' || msg.type === 'secureStatus') {
    // Update placeholder on matching secure input by UUID
    const rows = $('varsBody').children;
    for (let i = 0; i < rows.length; i++) {
      if (i < variables.length && extractSecureId(variables[i].value) === msg.secureId) {
        const valInp = rows[i].querySelector<HTMLInputElement>('input[data-field="value"]');
        if (valInp && valInp.type === 'password') {
          const hasValue = msg.type === 'secureValueStored' || msg.hasValue;
          valInp.placeholder = hasValue ? '\u2022\u2022\u2022\u2022\u2022\u2022 (stored)' : 'Enter secret value';
        }
      }
    }
  }
});

// ── Init ─────────────────────────────────────
initVarFields();
setPostMessage((msg: any) => vscode.postMessage(msg));

$('addVarBtn').addEventListener('click', () => {
  variables.push({ name: '', value: '' });
  render();
  scheduleUpdate();
});

// Signal ready
vscode.postMessage({ type: 'ready' });
