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

interface GlobalVar {
  name: string;
  value?: string;
  disabled?: boolean;
}

let variables: GlobalVar[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleUpdate(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    vscode.postMessage({ type: 'updateVariables', variables });
  }, 300);
}

function render(): void {
  const tbody = $('varsBody');
  tbody.innerHTML = '';
  variables.forEach((_v, i) => addRow(tbody, i));
}

function addRow(tbody: HTMLElement, idx: number): void {
  const v = variables[idx];
  const tr = document.createElement('tr');
  const chk = v.disabled ? '' : 'checked';

  tr.innerHTML =
    `<td><input type="checkbox" ${chk} data-field="disabled" /></td>` +
    `<td><input type="text" value="${esc(v.name || '')}" data-field="name" /></td>` +
    '<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="value" data-field="value"></div></td>' +
    `<td><button class="row-delete">\u00d7</button></td>`;

  // Wire checkbox and name inputs
  tr.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(inp => {
    const field = inp.dataset.field!;
    if (inp.type === 'checkbox') {
      inp.addEventListener('change', () => { variables[idx].disabled = !inp.checked; scheduleUpdate(); });
    } else {
      inp.addEventListener('input', () => {
        (variables[idx] as any)[field] = inp.value;
        scheduleUpdate();
      });
    }
  });

  // Wire contenteditable value
  const valCE = tr.querySelector('.val-ce[data-field="value"]') as HTMLElement;
  if (valCE) {
    enableContentEditableValue(valCE, v.value || '', () => {
      variables[idx].value = (valCE as any)._getRawText ? (valCE as any)._getRawText() : (valCE.textContent || '');
      scheduleUpdate();
    });
  }

  // Delete
  tr.querySelector('.row-delete')?.addEventListener('click', () => {
    variables.splice(idx, 1);
    render();
    scheduleUpdate();
  });

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
