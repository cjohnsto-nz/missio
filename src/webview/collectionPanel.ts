import { renderAuthFields, buildAuthData, loadAuthData, type AuthFieldsConfig } from './authFields';
import { initOAuth2TokenStatusController } from './oauth2TokenStatus';
import {
  setSecretNamesForProvider,
  getSecretNamesForProvider,
} from './autocomplete';
import {
  highlightVariables, enableVarOverlay, enableContentEditableValue,
  restoreCursor, syncAllVarOverlays, handleVariablesResolved, initVarFields,
  registerFlushOnSave, setPostMessage,
  getResolvedVariables, getVariableSources, getShowResolvedVars, setShowResolvedVars,
} from './varFields';
import { handleSecretValueResolved, handleSetSecretValueResult as handleSetSecretValueResultTooltip } from './varTooltip';

declare function acquireVsCodeApi(): { postMessage(message: any): void; getState(): any; setState(state: any): void };
const vscode = acquireVsCodeApi();

let collectionData: any = null;
let collectionRoot = '';
let ignoreNextLoad = false;
let isLoading = false;
let activeEnvironmentIndex = -1;
let saveTimer: any = null;

// Track which providers have write access (set after testConnection)
const providerWriteAccessByName = new Map<string, boolean>();

// ── Helpers ──────────────────────────────────
function getElementByIdOrThrow(elementId: string) { return document.getElementById(elementId)!; }
function escapeHtml(value: string): string {
  if (!value) return '';
  const htmlEscapeContainer = document.createElement('div');
  htmlEscapeContainer.textContent = value;
  return htmlEscapeContainer.innerHTML;
}

// Variable state and field infrastructure imported from varFields.ts

// ── Debounced auto-save ──────────────────────
function scheduleUpdate() {
  if (isLoading) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!collectionData) return;
    buildAndSend();
  }, 400);
}


function buildAndSend() {
  const collectionPayload = JSON.parse(JSON.stringify(collectionData));

  // Overview
  collectionPayload.info = collectionPayload.info || {};
  collectionPayload.info.name = (getElementByIdOrThrow('infoName') as HTMLInputElement).value || undefined;
  collectionPayload.info.version = (getElementByIdOrThrow('infoVersion') as HTMLInputElement).value || undefined;
  const summary = (getElementByIdOrThrow('infoSummary') as HTMLTextAreaElement).value;
  if (summary) collectionPayload.info.summary = summary;
  else delete collectionPayload.info.summary;

  // Default headers
  const requestHeaders: any[] = [];
  document.querySelectorAll('#defaultHeadersBody tr').forEach(headerRow => {
    const headerNameInput = headerRow.querySelector<HTMLInputElement>('input[type="text"]');
    const headerValueElement = headerRow.querySelector('.val-ce') as any;
    const headerEnabledCheckbox = headerRow.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (headerNameInput?.value) {
      const headerEntry: any = { name: headerNameInput.value, value: headerValueElement?._getRawText ? headerValueElement._getRawText() : (headerValueElement?.textContent || '') };
      if (headerEnabledCheckbox && !headerEnabledCheckbox.checked) headerEntry.disabled = true;
      requestHeaders.push(headerEntry);
    }
  });
  if (!collectionPayload.request) collectionPayload.request = {};
  collectionPayload.request.headers = requestHeaders.length > 0 ? requestHeaders : undefined;

  // Default auth
  const authType = (getElementByIdOrThrow('defaultAuthType') as HTMLSelectElement).value;
  const authData = buildAuthData(authType, 'dAuth');
  if (authData !== undefined) {
    collectionPayload.request.auth = authData;
  } else {
    delete collectionPayload.request.auth;
  }

  // Default variables — read from defaultVariables array (includes secret/secure/value)
  const requestVariables: any[] = defaultVariables
    .filter((variableEntry: any) => variableEntry.name)
    .map((variableEntry: any) => {
      const normalizedVariable: any = { name: variableEntry.name };
      if (variableEntry.value !== undefined && variableEntry.value !== '') normalizedVariable.value = variableEntry.value;
      if (variableEntry.secret) normalizedVariable.secret = true;
      if (variableEntry.secure) normalizedVariable.secure = true;
      if (variableEntry.disabled) normalizedVariable.disabled = true;
      return normalizedVariable;
    });
  collectionPayload.request = collectionPayload.request || {};
  collectionPayload.request.variables = requestVariables.length > 0 ? requestVariables : undefined;

  // Clean empty request
  if (collectionPayload.request && Object.keys(collectionPayload.request).every((requestKey: string) => collectionPayload.request[requestKey] === undefined)) {
    delete collectionPayload.request;
  }

  // Force Auth Inherit
  if (!collectionPayload.config) collectionPayload.config = {};
  const forceAuthInherit = (getElementByIdOrThrow('forceAuthInherit') as HTMLInputElement).checked;
  collectionPayload.config.forceAuthInherit = forceAuthInherit || undefined;

  // Secret providers
  const secretProviders = buildSecretProviders();
  collectionPayload.config.secretProviders = secretProviders.length > 0 ? secretProviders : undefined;

  ignoreNextLoad = true;
  vscode.postMessage({ type: 'updateDocument', collection: collectionPayload });
}

// ── Tab Switching ────────────────────────────
function initTabs(tabsContainerId: string) {
  const container = getElementByIdOrThrow(tabsContainerId);
  if (!container) return;
  container.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = (tab as HTMLElement).dataset.tab!;
      // Deactivate siblings
      container.querySelectorAll('.tab').forEach(tabElement => tabElement.classList.remove('active'));
      tab.classList.add('active');
      // Show matching panel
      const parent = container.parentElement!;
      parent.querySelectorAll(':scope > .tab-content > .tab-panel').forEach(panelElement => panelElement.classList.remove('active'));
      const panel = parent.querySelector(`#panel-${tabName}`);
      if (panel) panel.classList.add('active');
    });
  });
}

// ── Default Headers ──────────────────────────
function renderDefaultHeaders(headers: any[]) {
  const defaultHeadersTableBody = getElementByIdOrThrow('defaultHeadersBody');
  defaultHeadersTableBody.innerHTML = '';
  (headers || []).forEach((header: any) => addHeaderRow(header.name, header.value, header.disabled));
}

function addHeaderRow(name?: string, value?: string, disabled?: boolean) {
  const defaultHeadersTableBody = getElementByIdOrThrow('defaultHeadersBody');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML =
    `<td><input type="checkbox" ${disabled ? '' : 'checked'} /></td>` +
    `<td><input type="text" value="${escapeHtml(name || '')}" placeholder="Header name" /></td>` +
    `<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="Header value"></div></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;
  headerRow.querySelector('.row-delete')!.addEventListener('click', () => { headerRow.remove(); scheduleUpdate(); });
  headerRow.querySelector<HTMLInputElement>('input[type="text"]')!.addEventListener('input', scheduleUpdate);
  headerRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.addEventListener('change', scheduleUpdate);
  enableContentEditableValue(headerRow.querySelector('.val-ce') as HTMLElement, value || '', scheduleUpdate);
  defaultHeadersTableBody.appendChild(headerRow);
}

// ── Default Variables (plain vars only per schema) ────────────────────────
let defaultVariables: any[] = [];

function renderDefaultVars(variables: any[]) {
  defaultVariables = variables || [];
  const defaultVariablesTableBody = getElementByIdOrThrow('defaultVarsBody');
  defaultVariablesTableBody.innerHTML = '';
  defaultVariables.forEach((_variable: any, variableIndex: number) => addDefaultVarRow(variableIndex));
}

function addDefaultVarRow(variableIndex: number) {
  const defaultVariablesTableBody = getElementByIdOrThrow('defaultVarsBody');
  const variableEntry = defaultVariables[variableIndex];
  const variableRow = document.createElement('tr');
  const variableEnabledCheckboxValue = variableEntry.disabled ? '' : 'checked';
  const initialVariableValue = typeof variableEntry.value === 'string' ? variableEntry.value : (variableEntry.value && variableEntry.value.data ? variableEntry.value.data : '');

  variableRow.innerHTML =
    `<td><input type="checkbox" ${variableEnabledCheckboxValue} data-field="disabled" /></td>` +
    `<td><input type="text" value="${escapeHtml(variableEntry.name || '')}" placeholder="Variable name" data-field="name" /></td>` +
    '<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="Variable value" data-field="value"></div></td>' +
    `<td><button class="row-delete">\u00d7</button></td>`;

  // Wire inputs
  variableRow.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(inputField => {
    const dataField = inputField.dataset.field!;
    if (inputField.type === 'checkbox') {
      inputField.addEventListener('change', () => { defaultVariables[variableIndex].disabled = !inputField.checked; scheduleUpdate(); });
    } else {
      inputField.addEventListener('input', () => { defaultVariables[variableIndex][dataField] = inputField.value; scheduleUpdate(); });
    }
  });

  // Wire contenteditable value
  const variableValueEditable = variableRow.querySelector('.val-ce[data-field="value"]') as HTMLElement;
  if (variableValueEditable) {
    enableContentEditableValue(variableValueEditable, initialVariableValue, () => {
      defaultVariables[variableIndex].value = (variableValueEditable as any)._getRawText ? (variableValueEditable as any)._getRawText() : (variableValueEditable.textContent || '');
      scheduleUpdate();
    });
  }

  // Delete
  variableRow.querySelector('.row-delete')!.addEventListener('click', () => {
    defaultVariables.splice(variableIndex, 1);
    renderDefaultVars(defaultVariables);
    scheduleUpdate();
  });

  defaultVariablesTableBody.appendChild(variableRow);
}

// ── Default Auth ─────────────────────────────
const collectionAuthConfig: AuthFieldsConfig = {
  prefix: 'dAuth',
  get fieldsContainer() { return getElementByIdOrThrow('defaultAuthFields'); },
  onChange: () => scheduleUpdate(),
  showInherit: false,
  wrapInputs: true,
  showTokenStatus: true,
  onFieldsRendered: (elements) => elements.forEach(fieldElement => enableContentEditableValue(fieldElement, '', scheduleUpdate)),
  authTypeSelectId: 'defaultAuthType',
  postMessage: (message) => vscode.postMessage(message),
};

const tokenStatusCtrl = initOAuth2TokenStatusController({
  prefix: 'dAuth',
  buildAuth: () => buildAuthData((getElementByIdOrThrow('defaultAuthType') as HTMLSelectElement).value, 'dAuth'),
  postMessage: (message) => vscode.postMessage(message),
  esc: escapeHtml,
});

function onDefaultAuthChange() {
  const type = (getElementByIdOrThrow('defaultAuthType') as HTMLSelectElement).value;
  renderAuthFields(type, collectionAuthConfig);
  if (type === 'oauth2') {
    tokenStatusCtrl.requestStatus();
  }
}

// ── Swatch Colors (ThemeColor tokens → display hex for webview) ──
const SWATCH_COLORS: { token: string; hex: string }[] = [
  { token: 'charts.red',        hex: 'var(--vscode-charts-red, #f14c4c)' },
  { token: 'charts.orange',     hex: 'var(--vscode-charts-orange, #d18616)' },
  { token: 'charts.yellow',     hex: 'var(--vscode-charts-yellow, #cca700)' },
  { token: 'charts.green',      hex: 'var(--vscode-charts-green, #89d185)' },
  { token: 'charts.blue',       hex: 'var(--vscode-charts-blue, #3794ff)' },
  { token: 'charts.purple',     hex: 'var(--vscode-charts-purple, #b180d7)' },
  { token: 'charts.foreground', hex: 'var(--vscode-charts-foreground, #cccccc)' },
  { token: 'terminal.ansiRed',       hex: 'var(--vscode-terminal-ansiRed, #cd3131)' },
  { token: 'terminal.ansiGreen',     hex: 'var(--vscode-terminal-ansiGreen, #0dbc79)' },
  { token: 'terminal.ansiYellow',    hex: 'var(--vscode-terminal-ansiYellow, #e5e510)' },
  { token: 'terminal.ansiBlue',      hex: 'var(--vscode-terminal-ansiBlue, #2472c8)' },
  { token: 'terminal.ansiMagenta',   hex: 'var(--vscode-terminal-ansiMagenta, #bc3fbc)' },
  { token: 'terminal.ansiCyan',      hex: 'var(--vscode-terminal-ansiCyan, #11a8cd)' },
  { token: 'terminal.ansiWhite',     hex: 'var(--vscode-terminal-ansiWhite, #e5e5e5)' },
];

// ── Environments ─────────────────────────────
function renderEnvSelector() {
  const environmentSelect = getElementByIdOrThrow('envSelector') as HTMLSelectElement;
  environmentSelect.innerHTML = '';
  const environments = collectionData?.config?.environments || [];
  if (environments.length === 0) {
    const emptyOption = document.createElement('option');
    emptyOption.value = '-1';
    emptyOption.textContent = 'No environments';
    environmentSelect.appendChild(emptyOption);
    environmentSelect.disabled = true;
  } else {
    environmentSelect.disabled = false;
    environments.forEach((environment: any, environmentIndex: number) => {
      const optionElement = document.createElement('option');
      optionElement.value = String(environmentIndex);
      optionElement.textContent = environment.name || 'Unnamed';
      environmentSelect.appendChild(optionElement);
    });
    environmentSelect.value = String(activeEnvironmentIndex);
  }
}

function selectEnv(environmentIndex: number) {
  activeEnvironmentIndex = environmentIndex;
  renderEnvSelector();
  renderEnvDetail();
}

function hasActiveEnvironment(): boolean {
  const environments = collectionData?.config?.environments || [];
  return activeEnvironmentIndex >= 0 && activeEnvironmentIndex < environments.length;
}

function buildUniqueEnvironmentName(baseName: string): string {
  const environments = collectionData?.config?.environments || [];
  const existingEnvironmentNames = new Set(
    environments
      .map((environment: any) => (typeof environment?.name === 'string' ? environment.name : ''))
      .filter((name: string) => !!name),
  );
  if (!existingEnvironmentNames.has(baseName)) return baseName;

  let suffix = 2;
  while (existingEnvironmentNames.has(`${baseName}-${suffix}`)) suffix++;
  return `${baseName}-${suffix}`;
}

function removeEnv() {
  const environments = collectionData?.config?.environments || [];
  if (activeEnvironmentIndex < 0 || activeEnvironmentIndex >= environments.length) return;
  environments.splice(activeEnvironmentIndex, 1);
  if (activeEnvironmentIndex >= environments.length) activeEnvironmentIndex = environments.length - 1;
  renderEnvSelector();
  renderEnvDetail();
  scheduleUpdate();
}

function addEnv(mode: 'blank' | 'clone' = 'blank') {
  if (!collectionData.config) collectionData.config = {};
  if (!collectionData.config.environments) collectionData.config.environments = [];

  let newEnvironment: any;
  if (mode === 'clone' && hasActiveEnvironment()) {
    const sourceEnvironment = collectionData.config.environments[activeEnvironmentIndex];
    newEnvironment = JSON.parse(JSON.stringify(sourceEnvironment || {}));
    const sourceEnvironmentName = typeof sourceEnvironment?.name === 'string' && sourceEnvironment.name.trim()
      ? sourceEnvironment.name.trim()
      : 'environment';
    newEnvironment.name = buildUniqueEnvironmentName(`${sourceEnvironmentName}-copy`);
  } else {
    newEnvironment = { name: buildUniqueEnvironmentName('new-environment'), variables: [] };
  }

  collectionData.config.environments.push(newEnvironment);
  activeEnvironmentIndex = collectionData.config.environments.length - 1;
  renderEnvSelector();
  renderEnvDetail();
  scheduleUpdate();
}

function closeAddEnvMenu() {
  const existing = document.querySelector('.env-add-menu');
  if (existing) existing.remove();
}

function openAddEnvMenu(anchor: HTMLElement) {
  closeAddEnvMenu();
  const menu = document.createElement('div');
  menu.className = 'env-add-menu';

  const addOption = (label: string, mode: 'blank' | 'clone') => {
    const menuButton = document.createElement('button');
    menuButton.className = 'env-add-menu-item';
    menuButton.textContent = label;
    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closeAddEnvMenu();
      addEnv(mode);
    });
    menu.appendChild(menuButton);
  };

  addOption('Blank', 'blank');
  if (hasActiveEnvironment()) addOption('Clone', 'clone');

  const anchorRect = anchor.getBoundingClientRect();
  menu.style.top = anchorRect.bottom + 4 + 'px';
  menu.style.left = anchorRect.right + 'px';
  menu.style.transform = 'translateX(-100%)';
  menu.style.transformOrigin = 'top right';
  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', function handler() {
      closeAddEnvMenu();
      document.removeEventListener('click', handler);
    });
  }, 0);
}

function closeSwatchPopover() {
  const existing = document.querySelector('.swatch-popover');
  if (existing) existing.remove();
}

function openSwatchPopover(anchor: HTMLElement, environment: any) {
  closeSwatchPopover();
  const swatchPopover = document.createElement('div');
  swatchPopover.className = 'swatch-popover';
  SWATCH_COLORS.forEach((swatchColor) => {
    const swatchButton = document.createElement('button');
    swatchButton.className = 'color-swatch' + (swatchColor.token === environment.color ? ' active' : '');
    swatchButton.style.background = swatchColor.hex;
    swatchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      environment.color = swatchColor.token;
      closeSwatchPopover();
      renderEnvSelector();
      renderEnvDetail();
      scheduleUpdate();
    });
    swatchPopover.appendChild(swatchButton);
  });
  // Position below the anchor
  const anchorRect = anchor.getBoundingClientRect();
  swatchPopover.style.top = anchorRect.bottom + 4 + 'px';
  swatchPopover.style.left = anchorRect.left + 'px';
  document.body.appendChild(swatchPopover);
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler() {
      closeSwatchPopover();
      document.removeEventListener('click', handler);
    });
  }, 0);
}


function renderEnvDetail() {
  const environmentDetailContainer = getElementByIdOrThrow('envDetail');
  const environments = collectionData?.config?.environments || [];
  if (activeEnvironmentIndex < 0 || activeEnvironmentIndex >= environments.length) {
    environmentDetailContainer.innerHTML = '<div class="env-detail-empty">Add an environment to get started</div>';
    return;
  }

  const activeEnvironment = environments[activeEnvironmentIndex];
  const colorToken = activeEnvironment.color || '';
  const selectedColor = SWATCH_COLORS.find((swatchColor) => swatchColor.token === colorToken);
  const displayColor = selectedColor ? selectedColor.hex : 'var(--vscode-charts-foreground, #888)';

  environmentDetailContainer.innerHTML =
    // Meta row
    '<div class="env-meta">' +
      '<button class="color-dot-btn" id="envColorBtn" style="background:' + displayColor + '" title="Pick color"></button>' +
      '<div class="form-field name"><label>Name</label><input type="text" id="envName" value="' + escapeHtml(activeEnvironment.name) + '" /></div>' +
      '<div class="form-field extends"><label>Extends</label><input type="text" id="envExtends" value="' + escapeHtml(activeEnvironment.extends || '') + '" placeholder="parent env name" /></div>' +
    '</div>' +
    // Env tabs
    '<div class="tabs" id="envTabs">' +
      '<div class="tab active" data-tab="env-vars">Variables <span class="badge" id="envVarsBadge">' + (activeEnvironment.variables ? activeEnvironment.variables.length : 0) + '</span></div>' +
      '<div class="tab" data-tab="env-settings">Settings</div>' +
    '</div>' +
    '<div class="tab-content">' +
      '<div class="tab-panel active" id="panel-env-vars">' +
        '<table class="kv-table"><colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:100px"><col style="width:32px"></colgroup><thead><tr><th></th><th>Name</th><th>Value</th><th>Type</th><th></th></tr></thead>' +
        '<tbody id="envVarsBody"></tbody></table>' +
        '<button class="add-row-btn" id="addEnvVarBtn">+ Add Variable</button>' +
      '</div>' +
      '<div class="tab-panel" id="panel-env-settings">' +
        '<div class="auth-section">' +
          '<div class="auth-row"><label>dotenv File</label><input type="text" id="envDotenv" value="' + escapeHtml(activeEnvironment.dotEnvFilePath || '') + '" placeholder=".env.local" /></div>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Wire meta fields
  getElementByIdOrThrow('envName').addEventListener('input', () => {
    activeEnvironment.name = (getElementByIdOrThrow('envName') as HTMLInputElement).value;
    renderEnvSelector();
    scheduleUpdate();
  });
  getElementByIdOrThrow('envColorBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openSwatchPopover(getElementByIdOrThrow('envColorBtn'), activeEnvironment);
  });
  getElementByIdOrThrow('envExtends').addEventListener('input', () => {
    const extendsValue = (getElementByIdOrThrow('envExtends') as HTMLInputElement).value;
    if (extendsValue) activeEnvironment.extends = extendsValue; else delete activeEnvironment.extends;
    scheduleUpdate();
  });
  getElementByIdOrThrow('envDotenv')?.addEventListener('input', () => {
    const dotenvPathValue = (getElementByIdOrThrow('envDotenv') as HTMLInputElement).value;
    if (dotenvPathValue) activeEnvironment.dotEnvFilePath = dotenvPathValue; else delete activeEnvironment.dotEnvFilePath;
    scheduleUpdate();
  });

  // Render variables
  const environmentVariablesTableBody = getElementByIdOrThrow('envVarsBody');
  (activeEnvironment.variables || []).forEach((_variable: any, variableIndex: number) => {
    addEnvVarRow(environmentVariablesTableBody, activeEnvironment, variableIndex);
  });

  // Wire add button
  getElementByIdOrThrow('addEnvVarBtn').addEventListener('click', () => {
    if (!activeEnvironment.variables) activeEnvironment.variables = [];
    activeEnvironment.variables.push({ name: '', value: '' });
    renderEnvDetail();
    scheduleUpdate();
  });

  // Init env tabs
  initTabs('envTabs');
}

function addEnvVarRow(tableBody: HTMLElement, environment: any, variableIndex: number) {
  const environmentVariable = environment.variables[variableIndex];
  const variableRow = document.createElement('tr');
  const isSecretVariable = environmentVariable.secret === true;
  const variableEnabledCheckboxValue = environmentVariable.disabled ? '' : 'checked';

  const eyeSvg = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3'/></svg>";
  const valueCellHtml = isSecretVariable
    ? '<td class="val-cell"><div class="secret-val-row"><input type="password" class="secret-val-input" data-field="value" placeholder="secret value" /><button class="secret-reveal-btn" title="Show/hide value">' + eyeSvg + '</button></div></td>'
    : '<td class="val-cell"><div class="val-ce" contenteditable="true" data-placeholder="value" data-field="value"></div></td>';

  variableRow.innerHTML =
    `<td><input type="checkbox" ${variableEnabledCheckboxValue} data-field="disabled" /></td>` +
    `<td><input type="text" value="${escapeHtml(environmentVariable.name || '')}" data-field="name" /></td>` +
    valueCellHtml +
    `<td><select class="type-select select-borderless" data-field="type"><option value="var"${!isSecretVariable ? ' selected' : ''}>var</option><option value="secret"${isSecretVariable ? ' selected' : ''}>secret</option></select></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;

  // Wire checkbox
  const disabledCheckbox = variableRow.querySelector<HTMLInputElement>('input[data-field="disabled"]');
  disabledCheckbox?.addEventListener('change', () => { environment.variables[variableIndex].disabled = !disabledCheckbox.checked; scheduleUpdate(); });

  // Wire name input with rename support for secrets
  const variableNameInput = variableRow.querySelector<HTMLInputElement>('input[data-field="name"]');
  if (variableNameInput) {
    let previousVariableName = environmentVariable.name || '';
    variableNameInput.addEventListener('input', () => {
      const nextVariableName = variableNameInput.value;
      if (environment.variables[variableIndex].secret && previousVariableName && nextVariableName && previousVariableName !== nextVariableName) {
        vscode.postMessage({ type: 'renameSecretValue', collectionRoot, envName: environment.name, oldName: previousVariableName, newName: nextVariableName });
      }
      environment.variables[variableIndex].name = nextVariableName;
      previousVariableName = nextVariableName;
      scheduleUpdate();
    });
  }

  // Wire value field
  if (isSecretVariable) {
    // Password input for secret vars
    const secretValueInput = variableRow.querySelector<HTMLInputElement>('.secret-val-input');
    const secretRevealButton = variableRow.querySelector('.secret-reveal-btn') as HTMLElement;
    if (secretValueInput) {
      // Fetch stored value from SecretStorage to populate
      if (environmentVariable.name) {
        vscode.postMessage({ type: 'peekSecretValue', collectionRoot, envName: environment.name, varName: environmentVariable.name });
      }
      secretValueInput.addEventListener('input', () => {
        if (environment.variables[variableIndex].name) {
          vscode.postMessage({ type: 'storeSecretValue', collectionRoot, envName: environment.name, varName: environment.variables[variableIndex].name, value: secretValueInput.value });
        }
        scheduleUpdate();
      });
    }
    if (secretRevealButton && secretValueInput) {
      secretRevealButton.addEventListener('click', (event) => {
        event.stopPropagation();
        secretValueInput.type = secretValueInput.type === 'password' ? 'text' : 'password';
      });
    }
  } else {
    // Contenteditable for normal vars
    const valueContentEditable = variableRow.querySelector('.val-ce[data-field="value"]') as HTMLElement;
    if (valueContentEditable) {
      const initialVariableValue = typeof environmentVariable.value === 'string' ? environmentVariable.value : (environmentVariable.value && environmentVariable.value.data ? environmentVariable.value.data : '');
      enableContentEditableValue(valueContentEditable, initialVariableValue, () => {
        environment.variables[variableIndex].value = (valueContentEditable as any)._getRawText ? (valueContentEditable as any)._getRawText() : (valueContentEditable.textContent || '');
        scheduleUpdate();
      });
    }
  }

  // Type dropdown
  const variableTypeSelect = variableRow.querySelector<HTMLSelectElement>('.type-select');
  variableTypeSelect?.addEventListener('change', () => {
    const selectedVariableType = variableTypeSelect.value;
    const wasSecretVariable = environment.variables[variableIndex].secret === true;
    const variableName = environment.variables[variableIndex].name || '';

    if (selectedVariableType === 'secret' && !wasSecretVariable) {
      // Switching to secret: move current value to SecretStorage, remove from YAML
      const valueContentEditable = variableRow.querySelector('.val-ce[data-field="value"]') as any;
      const currentValue = valueContentEditable?._getRawText ? valueContentEditable._getRawText() : (environment.variables[variableIndex].value ?? '');
      environment.variables[variableIndex].secret = true;
      delete environment.variables[variableIndex].value;
      if (variableName && currentValue) {
        vscode.postMessage({ type: 'storeSecretValue', collectionRoot, envName: environment.name, varName: variableName, value: currentValue });
      }
    } else if (selectedVariableType === 'var' && wasSecretVariable) {
      // Switching to var: value will be empty (secret is in SecretStorage, can't retrieve synchronously)
      delete environment.variables[variableIndex].secret;
      environment.variables[variableIndex].value = '';
      if (variableName) {
        vscode.postMessage({ type: 'deleteSecretValue', collectionRoot, envName: environment.name, varName: variableName });
      }
    }
    renderEnvDetail();
    scheduleUpdate();
  });

  // Delete
  variableRow.querySelector('.row-delete')?.addEventListener('click', () => {
    if (isSecretVariable && environmentVariable.name) {
      vscode.postMessage({ type: 'deleteSecretValue', collectionRoot, envName: environment.name, varName: environmentVariable.name });
    }
    environment.variables.splice(variableIndex, 1);
    renderEnvDetail();
    scheduleUpdate();
  });

  tableBody.appendChild(variableRow);
}

// ── Load Collection ──────────────────────────
function loadCollection(data: any) {
  isLoading = true;
  collectionData = JSON.parse(JSON.stringify(data));

  // Header
  getElementByIdOrThrow('collectionName').textContent = data.info?.name || 'Collection';

  // Overview
  (getElementByIdOrThrow('infoName') as HTMLInputElement).value = data.info?.name || '';
  (getElementByIdOrThrow('infoVersion') as HTMLInputElement).value = data.info?.version || '';
  (getElementByIdOrThrow('infoSummary') as HTMLTextAreaElement).value = data.info?.summary || '';

  // Default headers
  renderDefaultHeaders(data.request?.headers || []);

  // Default variables
  renderDefaultVars(data.request?.variables || []);

  // Default auth
  const auth = data.request?.auth;
  if (auth && typeof auth === 'object' && auth.type) {
    (getElementByIdOrThrow('defaultAuthType') as HTMLSelectElement).value = auth.type;
  } else {
    (getElementByIdOrThrow('defaultAuthType') as HTMLSelectElement).value = 'none';
  }
  onDefaultAuthChange();
  if (auth && typeof auth === 'object' && auth.type) {
    setTimeout(() => { loadAuthData(auth, 'dAuth'); }, 0);
  }

  // Force Auth Inherit
  (getElementByIdOrThrow('forceAuthInherit') as HTMLInputElement).checked = !!data.config?.forceAuthInherit;

  // Badges
  getElementByIdOrThrow('headersBadge').textContent = String((data.request?.headers || []).length);
  getElementByIdOrThrow('variablesBadge').textContent = String((data.request?.variables || []).length);

  // Secret providers
  renderSecretProviders(data.config?.secretProviders || []);

  // Environments
  const environments = collectionData?.config?.environments || [];
  getElementByIdOrThrow('envBadge').textContent = String(environments.length);
  if (activeEnvironmentIndex < 0 && environments.length > 0) activeEnvironmentIndex = 0;
  if (activeEnvironmentIndex >= environments.length) activeEnvironmentIndex = environments.length - 1;
  renderEnvSelector();
  renderEnvDetail();
  // Allow scheduleUpdate after all sync + async field population is done
  setTimeout(() => { isLoading = false; }, 50);
}

// ── Message Handler ──────────────────────────
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'collectionLoaded') {
    if (ignoreNextLoad) {
      ignoreNextLoad = false;
      return;
    }
    if (message.collectionRoot) collectionRoot = message.collectionRoot;
    loadCollection(message.collection);
  }
  if (handleVariablesResolved(message)) {
    tokenStatusCtrl.requestStatus();
  }
  if (message.type === 'oauth2TokenStatus') {
    tokenStatusCtrl.handleStatus(message.status);
  }
  if (message.type === 'oauth2Progress') {
    tokenStatusCtrl.handleProgress(message.message);
  }
  if (message.type === 'testSecretProviderResult') {
    // Restore the test button on the target row
    const providerRows = getElementByIdOrThrow('secretProvidersBody').children;
    const targetRow = providerRows[message.providerIdx] as HTMLElement | undefined;
    if (targetRow) {
      const testButton = targetRow.querySelector('.btn-test-vault') as HTMLButtonElement;
      if (testButton) { testButton.disabled = false; testButton.textContent = 'Test'; }
      // Populate role cell
      const roleCell = targetRow.querySelector('.sp-role-cell') as HTMLElement;
      if (roleCell && message.success) {
        const roleName = message.role || '';
        const shortRole = roleName.replace('Key Vault ', '');
        if (message.canWrite) {
          roleCell.innerHTML = '<span class="sp-access-badge writable">' + escapeHtml(shortRole) + '</span>';
        } else if (roleName) {
          roleCell.innerHTML = '<span class="sp-access-badge read-only">' + escapeHtml(shortRole) + '</span>';
        } else {
          roleCell.innerHTML = '<span class="sp-access-badge read-only">No role</span>';
        }
      }
    }
    // Store secret names for autocomplete
    if (message.success && message.providerName && message.secretNames) {
      setSecretNamesForProvider(message.providerName, message.secretNames);
    }
    // Track write access
    if (message.success && message.providerName) {
      providerWriteAccessByName.set(message.providerName, !!message.canWrite);
    }
    // Show result
    const testResultContainer = getElementByIdOrThrow('secretTestResult');
    if (message.success) {
      testResultContainer.innerHTML = `<span style="color:var(--badge-success);">\u2713 Connected \u2014 ${message.secretCount} secret${message.secretCount === 1 ? '' : 's'} found</span>`;
    } else {
      testResultContainer.innerHTML = `<span style="color:var(--badge-error);">\u2717 ${escapeHtml(message.error || 'Connection failed')}</span>`;
    }
    // Update create secret form visibility
    updateCreateSecretForm();
    setTimeout(() => { testResultContainer.innerHTML = ''; }, 15000);
  }
  if (message.type === 'secretNamesResult') {
    if (message.providerName && message.secretNames) {
      setSecretNamesForProvider(message.providerName, message.secretNames);
    }
  }
  if (message.type === 'secretValuePeek') {
    // Populate the password input for a secret env var with its stored value
    const environments = collectionData?.config?.environments || [];
    const activeEnvironment = environments[activeEnvironmentIndex];
    if (activeEnvironment?.variables && message.envName === activeEnvironment.name) {
      const variableRows = getElementByIdOrThrow('envVarsBody')?.children;
      if (variableRows) {
        for (let variableIndex = 0; variableIndex < variableRows.length && variableIndex < activeEnvironment.variables.length; variableIndex++) {
          if (activeEnvironment.variables[variableIndex].name === message.varName && activeEnvironment.variables[variableIndex].secret) {
            const secretInput = (variableRows[variableIndex] as HTMLElement).querySelector<HTMLInputElement>('.secret-val-input');
            if (secretInput) secretInput.value = message.value || '';
            break;
          }
        }
      }
    }
  }
  if (message.type === 'secretValueResolved') {
    handleSecretValueResolved(message);
  }
  if (message.type === 'createSecretInVaultResult') {
    const createSecretResultContainer = getElementByIdOrThrow('createSecretResult');
    const createSecretButton = getElementByIdOrThrow('createSecretBtn') as HTMLButtonElement;
    if (createSecretButton) { createSecretButton.disabled = false; createSecretButton.textContent = 'Create'; }
    if (message.success) {
      if (createSecretResultContainer) createSecretResultContainer.innerHTML = `<span style="color:var(--badge-success);">✓ Secret "${escapeHtml(message.secretName)}" saved to ${escapeHtml(message.providerName)}</span>`;
      // Clear form inputs
      const secretNameInput = getElementByIdOrThrow('createSecretName') as HTMLInputElement;
      const secretValueInput = getElementByIdOrThrow('createSecretValue') as HTMLInputElement;
      if (secretNameInput) secretNameInput.value = '';
      if (secretValueInput) secretValueInput.value = '';
      // Update autocomplete
      if (message.providerName && message.secretNames) {
        setSecretNamesForProvider(message.providerName, message.secretNames);
      }
    } else {
      if (createSecretResultContainer) createSecretResultContainer.innerHTML = `<span style="color:var(--badge-error);">✗ ${escapeHtml(message.error || 'Failed to create secret')}</span>`;
    }
    if (createSecretResultContainer) setTimeout(() => { createSecretResultContainer.innerHTML = ''; }, 10000);
  }
  if (message.type === 'setSecretValueResult') {
    handleSetSecretValueResultTooltip(message);
    handleSetSecretValueResult(message);
  }
  if (message.type === 'switchTab') {
    const targetTab = message.tab;
    const tabsContainer = getElementByIdOrThrow('mainTabs');
    const targetTabElement = tabsContainer.querySelector(`.tab[data-tab="${targetTab}"]`) as HTMLElement | null;
    if (targetTabElement) targetTabElement.click();
    // If an environment name was specified, select it
    if (message.envName && collectionData?.config?.environments) {
      const environments = collectionData.config.environments;
      const environmentIndex = environments.findIndex((environment: any) => environment.name === message.envName);
      if (environmentIndex >= 0) {
        selectEnv(environmentIndex);
      }
    }
  }
});

// ── Secret Providers ─────────────────────────
function renderSecretProviders(providers: any[]) {
  const secretProvidersTableBody = getElementByIdOrThrow('secretProvidersBody');
  secretProvidersTableBody.innerHTML = '';
  (providers || []).forEach((provider: any) => addSecretProviderRow(provider.name, provider.type, provider.namespace, provider.subscription, provider.disabled));
  getElementByIdOrThrow('secretsBadge').textContent = String((providers || []).length);
}

function addSecretProviderRow(name?: string, providerType?: string, namespace?: string, subscription?: string, disabled?: boolean) {
  const secretProvidersTableBody = getElementByIdOrThrow('secretProvidersBody');
  const providerRow = document.createElement('tr');
  const selectedProviderType = providerType || 'azure-keyvault';
  providerRow.innerHTML =
    `<td><input type="text" value="${escapeHtml(name || '')}" placeholder="my-vault" class="sp-name" /></td>` +
    `<td><select class="type-select select-borderless sp-type"><option value="azure-keyvault"${selectedProviderType === 'azure-keyvault' ? ' selected' : ''}>Azure Key Vault</option></select></td>` +
    `<td class="val-cell"><div class="val-ce sp-ns" contenteditable="true" data-placeholder="{{vault-name}}"></div></td>` +
    `<td class="val-cell"><div class="val-ce sp-sub" contenteditable="true" data-placeholder="subscription name or ID (optional)"></div></td>` +
    `<td class="sp-role-cell"></td>` +
    `<td><button class="btn-test-vault" title="Test connection">Test</button></td>` +
    `<td><button class="row-delete">\u00d7</button></td>`;
  providerRow.querySelector('.row-delete')!.addEventListener('click', () => { providerRow.remove(); getElementByIdOrThrow('secretsBadge').textContent = String(secretProvidersTableBody.children.length); scheduleUpdate(); });
  providerRow.querySelector<HTMLInputElement>('.sp-name')!.addEventListener('input', scheduleUpdate);
  providerRow.querySelector<HTMLSelectElement>('.sp-type')!.addEventListener('change', scheduleUpdate);
  enableContentEditableValue(providerRow.querySelector('.sp-ns') as HTMLElement, namespace || '', scheduleUpdate);
  enableContentEditableValue(providerRow.querySelector('.sp-sub') as HTMLElement, subscription || '', scheduleUpdate);
  const testConnectionButton = providerRow.querySelector('.btn-test-vault') as HTMLButtonElement;
  testConnectionButton.addEventListener('click', () => {
    const providerName = (providerRow.querySelector('.sp-name') as HTMLInputElement).value;
    const selectedProviderType = (providerRow.querySelector('.sp-type') as HTMLSelectElement).value;
    const namespaceContentEditable = providerRow.querySelector('.sp-ns') as any;
    const providerNamespace = namespaceContentEditable._getRawText ? namespaceContentEditable._getRawText() : (namespaceContentEditable.textContent || '');
    const subscriptionContentEditable = providerRow.querySelector('.sp-sub') as any;
    const providerSubscription = subscriptionContentEditable?._getRawText ? subscriptionContentEditable._getRawText() : (subscriptionContentEditable?.textContent || '');
    // Show spinner
    testConnectionButton.disabled = true;
    testConnectionButton.innerHTML = '<span class="spinner"></span>';
    // Clear any previous result
    const existingResult = providerRow.querySelector('.sp-test-result');
    if (existingResult) existingResult.remove();
    vscode.postMessage({ type: 'testSecretProvider', providerIdx: Array.from(secretProvidersTableBody.children).indexOf(providerRow), provider: { name: providerName, type: selectedProviderType, namespace: providerNamespace, subscription: providerSubscription || undefined } });
  });
  secretProvidersTableBody.appendChild(providerRow);
}

function buildSecretProviders(): any[] {
  const secretProviders: any[] = [];
  document.querySelectorAll('#secretProvidersBody tr').forEach((providerRow) => {
    const providerNameInput = providerRow.querySelector<HTMLInputElement>('.sp-name');
    const providerTypeSelect = providerRow.querySelector<HTMLSelectElement>('.sp-type');
    const providerNamespaceEditable = providerRow.querySelector('.sp-ns') as any;
    if (providerNameInput?.value) {
      const providerSubscriptionEditable = providerRow.querySelector('.sp-sub') as any;
      const providerSubscription = providerSubscriptionEditable?._getRawText ? providerSubscriptionEditable._getRawText() : (providerSubscriptionEditable?.textContent || '');
      const providerEntry: any = {
        name: providerNameInput.value,
        type: providerTypeSelect?.value || 'azure-keyvault',
        namespace: providerNamespaceEditable?._getRawText ? providerNamespaceEditable._getRawText() : (providerNamespaceEditable?.textContent || ''),
      };
      if (providerSubscription) providerEntry.subscription = providerSubscription;
      secretProviders.push(providerEntry);
    }
  });
  return secretProviders;
}

// ── Create Secret Form ───────────────────────
function getWritableProviders(): string[] {
  const writableProviderNames: string[] = [];
  for (const [providerName, canWrite] of providerWriteAccessByName) {
    if (canWrite) writableProviderNames.push(providerName);
  }
  return writableProviderNames;
}

function updateCreateSecretForm() {
  const createSecretFormContainer = getElementByIdOrThrow('createSecretFormContainer');
  if (!createSecretFormContainer) return;
  const writableProviderNames = getWritableProviders();
  if (writableProviderNames.length === 0) {
    createSecretFormContainer.innerHTML = '';
    return;
  }
  createSecretFormContainer.innerHTML =
    '<div class="create-secret-form">' +
      '<div class="form-title">Create / Update Secret</div>' +
      '<div class="form-row">' +
        '<div class="form-field">' +
          '<label>Provider</label>' +
          '<select id="createSecretProvider">' +
            writableProviderNames.map((providerName) => '<option value="' + escapeHtml(providerName) + '">' + escapeHtml(providerName) + '</option>').join('') +
          '</select>' +
        '</div>' +
        '<div class="form-field" style="position:relative;">' +
          '<label>Secret Name</label>' +
          '<input type="text" id="createSecretName" placeholder="my-secret-key" autocomplete="off" />' +
          '<div id="createSecretNameDropdown" class="secret-name-dropdown"></div>' +
        '</div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-field">' +
          '<label>Value</label>' +
          '<input type="password" id="createSecretValue" placeholder="secret value" />' +
        '</div>' +
        '<button class="create-secret-btn" id="createSecretBtn" style="width:80px;flex-shrink:0;">Create</button>' +
      '</div>' +
      '<div id="createSecretResult" class="create-secret-result"></div>' +
    '</div>';

  // Wire create button
  const createSecretButton = getElementByIdOrThrow('createSecretBtn') as HTMLButtonElement;
  createSecretButton.addEventListener('click', () => {
    const providerName = (getElementByIdOrThrow('createSecretProvider') as HTMLSelectElement).value;
    const secretName = (getElementByIdOrThrow('createSecretName') as HTMLInputElement).value.trim();
    const secretValue = (getElementByIdOrThrow('createSecretValue') as HTMLInputElement).value;
    if (!providerName || !secretName) {
      const createSecretResultContainer = getElementByIdOrThrow('createSecretResult');
      if (createSecretResultContainer) createSecretResultContainer.innerHTML = '<span style="color:var(--badge-error);">Provider and secret name are required.</span>';
      return;
    }
    createSecretButton.disabled = true;
    createSecretButton.innerHTML = '<span class="spinner"></span>';
    vscode.postMessage({ type: 'createSecretInVault', providerName, secretName, value: secretValue });
  });

  // Wire reveal toggle on value input
  const secretValueInput = getElementByIdOrThrow('createSecretValue') as HTMLInputElement;
  secretValueInput?.addEventListener('dblclick', () => {
    secretValueInput.type = secretValueInput.type === 'password' ? 'text' : 'password';
  });

  // Custom autocomplete dropdown for secret name
  const providerSelect = getElementByIdOrThrow('createSecretProvider') as HTMLSelectElement;
  const secretNameInput = getElementByIdOrThrow('createSecretName') as HTMLInputElement;
  const secretNameDropdown = getElementByIdOrThrow('createSecretNameDropdown') as HTMLElement;

  function showSecretNameDropdown() {
    if (!secretNameDropdown || !secretNameInput) return;
    const providerSecretNames = getSecretNamesForProvider(providerSelect.value);
    const searchFilter = secretNameInput.value.toLowerCase();
    const filteredSecretNames = searchFilter ? providerSecretNames.filter((secretName) => secretName.toLowerCase().includes(searchFilter)) : providerSecretNames;
    if (filteredSecretNames.length === 0) { secretNameDropdown.style.display = 'none'; return; }
    secretNameDropdown.innerHTML = filteredSecretNames.map((secretName) =>
      '<div class="secret-name-option">' + escapeHtml(secretName) + '</div>'
    ).join('');
    secretNameDropdown.style.display = 'block';
    secretNameDropdown.querySelectorAll('.secret-name-option').forEach(secretOption => {
      secretOption.addEventListener('mousedown', (mouseEvent) => {
        mouseEvent.preventDefault();
        secretNameInput.value = (secretOption as HTMLElement).textContent || '';
        secretNameDropdown.style.display = 'none';
      });
    });
  }

  secretNameInput?.addEventListener('focus', showSecretNameDropdown);
  secretNameInput?.addEventListener('input', showSecretNameDropdown);
  secretNameInput?.addEventListener('blur', () => { if (secretNameDropdown) secretNameDropdown.style.display = 'none'; });
  providerSelect?.addEventListener('change', () => { if (secretNameDropdown) secretNameDropdown.style.display = 'none'; });
}

function handleSetSecretValueResult(secretResultMessage: { secretRef: string; success: boolean; error?: string }) {
  // This is called from the tooltip's setSecretValue flow
  // The tooltip itself is in varTooltip.ts — we just need to forward the result
  // The tooltip listens for this via the message handler
  if (!secretResultMessage.success && secretResultMessage.error) {
    // Show a toast-style error in the test result area as a fallback
    const resultDiv = getElementByIdOrThrow('secretTestResult');
    if (resultDiv) {
      resultDiv.innerHTML = '<span style="color:var(--badge-error);">\u2717 ' + escapeHtml(secretResultMessage.error) + '</span>';
      setTimeout(() => { resultDiv.innerHTML = ''; }, 10000);
    }
  }
}

// ── Init ─────────────────────────────────────
initVarFields();
setPostMessage((message: any) => vscode.postMessage(message));
registerFlushOnSave(() => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!isLoading && collectionData) buildAndSend();
});
initTabs('mainTabs');

getElementByIdOrThrow('addDefaultHeaderBtn').addEventListener('click', () => { addHeaderRow(); scheduleUpdate(); });
getElementByIdOrThrow('addDefaultVarBtn').addEventListener('click', () => { defaultVariables.push({ name: '', value: '' }); renderDefaultVars(defaultVariables); scheduleUpdate(); });
getElementByIdOrThrow('defaultAuthType').addEventListener('change', onDefaultAuthChange);
getElementByIdOrThrow('varToggleBtn').addEventListener('click', () => {
  setShowResolvedVars(!getShowResolvedVars());
  getElementByIdOrThrow('varToggleBtn').classList.toggle('active', getShowResolvedVars());
  syncAllVarOverlays();
});
getElementByIdOrThrow('addSecretProviderBtn').addEventListener('click', () => { addSecretProviderRow(); getElementByIdOrThrow('secretsBadge').textContent = String(getElementByIdOrThrow('secretProvidersBody').children.length); scheduleUpdate(); });
getElementByIdOrThrow('addEnvBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  if (hasActiveEnvironment()) {
    openAddEnvMenu(getElementByIdOrThrow('addEnvBtn'));
  } else {
    addEnv('blank');
  }
});
getElementByIdOrThrow('importEnvBtn').addEventListener('click', () => {
  vscode.postMessage({ type: 'importEnvironment' });
});
getElementByIdOrThrow('removeEnvBtn').addEventListener('click', removeEnv);
getElementByIdOrThrow('envSelector').addEventListener('change', () => {
  const selectedEnvironmentIndex = parseInt((getElementByIdOrThrow('envSelector') as HTMLSelectElement).value, 10);
  if (selectedEnvironmentIndex >= 0) selectEnv(selectedEnvironmentIndex);
});

// Wire overview fields
['infoName', 'infoVersion'].forEach(fieldId => {
  getElementByIdOrThrow(fieldId).addEventListener('input', scheduleUpdate);
});
getElementByIdOrThrow('infoSummary').addEventListener('input', scheduleUpdate);
getElementByIdOrThrow('forceAuthInherit').addEventListener('change', scheduleUpdate);

vscode.postMessage({ type: 'ready' });
