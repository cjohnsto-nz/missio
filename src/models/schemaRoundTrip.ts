export type RequestProtocol = 'http' | 'graphql' | 'grpc' | 'websocket';

export type DocumentKind =
  | 'collection'
  | 'folder'
  | 'workspace'
  | 'script'
  | RequestProtocol
  | 'unknown';

export interface KeyValueEditorRow {
  name: string;
  value: string;
  disabled?: boolean;
  type?: string;
  originalIndex?: number;
}

export interface FormFieldEditorRow extends KeyValueEditorRow {
  partType?: string;
}

export type RequestEditorBodyModel =
  | { kind: 'none'; bodyVariantIndex?: number }
  | { kind: 'raw'; rawType: string; data: string; bodyVariantIndex?: number }
  | { kind: 'form-urlencoded' | 'multipart-form'; fields: FormFieldEditorRow[]; bodyVariantIndex?: number }
  | { kind: 'file'; filePath: string; contentType: string; bodyVariantIndex?: number; fileVariantIndex?: number };

export interface RequestEditorModel {
  protocol?: RequestProtocol;
  method?: string;
  url?: string;
  params?: KeyValueEditorRow[];
  headers?: KeyValueEditorRow[];
  body?: RequestEditorBodyModel;
  auth?: unknown;
  settings?: Record<string, unknown>;
}

export interface RequestDefaultsEditorModel {
  headers?: KeyValueEditorRow[];
  auth?: unknown;
  variables?: unknown[];
}

export interface CollectionEditorModel {
  info?: Record<string, unknown>;
  request?: RequestDefaultsEditorModel;
  config?: {
    forceAuthInherit?: boolean;
    secretProviders?: unknown[];
    environments?: unknown[];
  };
}

export interface FolderEditorModel {
  info?: Record<string, unknown>;
  request?: RequestDefaultsEditorModel;
}

const REQUEST_PROTOCOLS: RequestProtocol[] = ['http', 'graphql', 'grpc', 'websocket'];

const REQUEST_SETTINGS_DEFAULTS: Record<string, unknown> = {
  timeout: 30000,
  encodeUrl: true,
  followRedirects: true,
  maxRedirects: 5,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj: unknown, key: string): boolean {
  return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

export function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function isEmptyObject(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length === 0;
}

export function detectRequestProtocol(data: unknown): RequestProtocol | undefined {
  if (!isObject(data)) return undefined;

  for (const protocol of REQUEST_PROTOCOLS) {
    if (isObject(data[protocol])) return protocol;
  }

  const info = data.info;
  const infoType = isObject(info) && typeof info.type === 'string'
    ? info.type.toLowerCase()
    : undefined;

  return REQUEST_PROTOCOLS.find(protocol => protocol === infoType);
}

export function isScriptDocument(data: unknown): boolean {
  if (!isObject(data)) return false;
  return data.type === 'script' || (!detectRequestProtocol(data) && typeof data.script === 'string');
}

export function detectDocumentKind(fileName: string, data: unknown): DocumentKind {
  const lower = fileName.toLowerCase();
  if (lower === 'opencollection.yml' || lower === 'opencollection.yaml' ||
      lower === 'collection.yml' || lower === 'collection.yaml') {
    return 'collection';
  }
  if (lower === 'folder.yml' || lower === 'folder.yaml') return 'folder';
  if (lower === 'workspace.yml' || lower === 'workspace.yaml') return 'workspace';
  if (isScriptDocument(data)) return 'script';
  return detectRequestProtocol(data) ?? 'http';
}

export function isHttpVisualEditableRequest(data: unknown): boolean {
  const protocol = detectRequestProtocol(data);
  if (protocol && protocol !== 'http') return false;
  return !isScriptDocument(data);
}

function withOptionalDisabled<T extends Record<string, unknown>>(
  output: T,
  previous: unknown,
  disabled: boolean | undefined,
): T {
  if (disabled || hasOwn(previous, 'disabled')) {
    (output as Record<string, unknown>).disabled = !!disabled;
  } else {
    delete (output as Record<string, unknown>).disabled;
  }
  return output;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

function getByOriginalIndex<T>(items: T[] | undefined, row: { originalIndex?: number }, fallbackIndex: number): T | undefined {
  if (!items) return undefined;
  const index = row.originalIndex ?? fallbackIndex;
  return items[index];
}

function mergeHeaders(previous: unknown[] | undefined, rows: KeyValueEditorRow[] | undefined): unknown[] | undefined {
  if (!rows || rows.length === 0) return undefined;
  return rows
    .filter(row => row.name)
    .map((row, index) => {
      const prior = getByOriginalIndex(previous, row, index);
      const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
      output.name = row.name;
      output.value = row.value;
      return withOptionalDisabled(output, prior, row.disabled);
    });
}

function mergeParams(previous: unknown[] | undefined, rows: KeyValueEditorRow[] | undefined): unknown[] | undefined {
  if (!rows || rows.length === 0) return undefined;
  return rows
    .filter(row => row.name)
    .map((row, index) => {
      const prior = getByOriginalIndex(previous, row, index);
      const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
      output.name = row.name;
      output.value = row.value;
      output.type = row.type ?? (isObject(prior) && typeof prior.type === 'string' ? prior.type : 'query');
      return withOptionalDisabled(output, prior, row.disabled);
    });
}

function mergeVariables(previous: unknown[] | undefined, variables: unknown[] | undefined): unknown[] | undefined {
  if (!variables || variables.length === 0) return undefined;

  return variables
    .filter(variable => isObject(variable) && typeof variable.name === 'string' && variable.name.length > 0)
    .map((variable, index) => {
      const prior = previous?.[index];
      const source = variable as Record<string, unknown>;
      const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
      output.name = source.name;

      if (hasOwn(source, 'value') && source.value !== '') {
        output.value = cloneJson(source.value);
      } else {
        delete output.value;
      }

      if (source.secret) output.secret = true;
      else delete output.secret;
      if (source.secure) output.secure = true;
      else delete output.secure;

      return withOptionalDisabled(output, prior, !!source.disabled);
    });
}

function selectedBodyVariant(body: unknown): { body: unknown; index?: number } {
  if (!Array.isArray(body)) return { body };
  const selectedIndex = body.findIndex(variant => isObject(variant) && variant.selected === true);
  const index = selectedIndex >= 0 ? selectedIndex : 0;
  const variant = body[index];
  return {
    body: isObject(variant) ? variant.body : undefined,
    index,
  };
}

function selectedFileVariant(body: unknown): { variant: unknown; index?: number } {
  if (!isObject(body) || !Array.isArray(body.data)) return { variant: undefined };
  const selectedIndex = body.data.findIndex(variant => isObject(variant) && variant.selected === true);
  const index = selectedIndex >= 0 ? selectedIndex : 0;
  return {
    variant: body.data[index],
    index,
  };
}

function formRowsFromBody(body: Record<string, unknown>): FormFieldEditorRow[] {
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows.map((entry, index) => {
    const part = isObject(entry) ? entry : {};
    return {
      name: typeof part.name === 'string' ? part.name : '',
      value: displayValue(part.value),
      disabled: part.disabled === true,
      partType: typeof part.type === 'string' ? part.type : undefined,
      originalIndex: index,
    };
  });
}

export function createRequestEditorModelFromRequest(request: unknown): RequestEditorModel {
  const protocol = detectRequestProtocol(request) ?? 'http';
  if (!isHttpVisualEditableRequest(request)) {
    return { protocol };
  }

  const source = isObject(request) ? request : {};
  const http = isObject(source.http) ? source.http : {};
  const { body, index: bodyVariantIndex } = selectedBodyVariant(http.body);
  let bodyModel: RequestEditorBodyModel = { kind: 'none', bodyVariantIndex };

  if (isObject(body) && typeof body.type === 'string') {
    if (body.type === 'form-urlencoded' || body.type === 'multipart-form') {
      bodyModel = {
        kind: body.type,
        fields: formRowsFromBody(body),
        bodyVariantIndex,
      };
    } else if (body.type === 'file') {
      const { variant, index: fileVariantIndex } = selectedFileVariant(body);
      const fileVariant = isObject(variant) ? variant : {};
      bodyModel = {
        kind: 'file',
        filePath: typeof fileVariant.filePath === 'string' ? fileVariant.filePath : '',
        contentType: typeof fileVariant.contentType === 'string' ? fileVariant.contentType : '',
        bodyVariantIndex,
        fileVariantIndex,
      };
    } else {
      bodyModel = {
        kind: 'raw',
        rawType: body.type,
        data: typeof body.data === 'string' ? body.data : '',
        bodyVariantIndex,
      };
    }
  }

  const runtime = isObject(source.runtime) ? source.runtime : {};

  return {
    protocol,
    method: typeof http.method === 'string' ? http.method : 'GET',
    url: typeof http.url === 'string' ? http.url : '',
    params: Array.isArray(http.params)
      ? http.params.map((param, index) => {
          const row = isObject(param) ? param : {};
          return {
            name: typeof row.name === 'string' ? row.name : '',
            value: typeof row.value === 'string' ? row.value : '',
            type: typeof row.type === 'string' ? row.type : 'query',
            disabled: row.disabled === true,
            originalIndex: index,
          };
        })
      : [],
    headers: Array.isArray(http.headers)
      ? http.headers.map((header, index) => {
          const row = isObject(header) ? header : {};
          return {
            name: typeof row.name === 'string' ? row.name : '',
            value: typeof row.value === 'string' ? row.value : '',
            disabled: row.disabled === true,
            originalIndex: index,
          };
        })
      : [],
    body: bodyModel,
    auth: runtime.auth,
    settings: isObject(source.settings) ? cloneJson(source.settings) : {},
  };
}

function selectedExistingBody(originalBody: unknown, bodyVariantIndex?: number): unknown {
  if (!Array.isArray(originalBody)) return originalBody;
  const index = bodyVariantIndex ?? originalBody.findIndex(variant => isObject(variant) && variant.selected === true);
  const resolvedIndex = index >= 0 ? index : 0;
  const variant = originalBody[resolvedIndex];
  return isObject(variant) ? variant.body : undefined;
}

function mergeFormBodyData(
  previous: unknown,
  fields: FormFieldEditorRow[],
  bodyType: 'form-urlencoded' | 'multipart-form',
): unknown[] {
  const previousData = isObject(previous) && Array.isArray(previous.data) ? previous.data : undefined;
  return fields
    .filter(field => field.name)
    .map((field, index) => {
      const prior = getByOriginalIndex(previousData, field, index);
      const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
      output.name = field.name;

      if (bodyType === 'multipart-form') {
        output.type = field.partType ?? (isObject(prior) && typeof prior.type === 'string' ? prior.type : 'text');
        const priorValue = isObject(prior) ? prior.value : undefined;
        if (field.value === displayValue(priorValue)) {
          output.value = cloneJson(priorValue);
        } else if (output.type === 'file' && Array.isArray(priorValue)) {
          output.value = field.value ? field.value.split(',').map(part => part.trim()).filter(Boolean) : [];
        } else {
          output.value = field.value;
        }
      } else {
        output.value = field.value;
      }

      return withOptionalDisabled(output, prior, field.disabled);
    });
}

function buildBodyFromEditor(originalBody: unknown, model: RequestEditorBodyModel): unknown | undefined {
  if (model.kind === 'none') return undefined;

  const previousSelected = selectedExistingBody(originalBody, model.bodyVariantIndex);
  let nextBody: Record<string, unknown>;

  if (model.kind === 'raw') {
    nextBody = isObject(previousSelected) ? cloneJson(previousSelected) : {};
    nextBody.type = model.rawType;
    nextBody.data = model.data;
  } else if (model.kind === 'form-urlencoded' || model.kind === 'multipart-form') {
    nextBody = isObject(previousSelected) ? cloneJson(previousSelected) : {};
    nextBody.type = model.kind;
    nextBody.data = mergeFormBodyData(previousSelected, model.fields, model.kind);
  } else if (model.kind === 'file') {
    nextBody = isObject(previousSelected) ? cloneJson(previousSelected) : {};
    nextBody.type = 'file';
    const previousData = Array.isArray(nextBody.data) ? nextBody.data : [];
    const fileIndex = model.fileVariantIndex ?? previousData.findIndex(variant => isObject(variant) && variant.selected === true);
    const resolvedIndex = fileIndex >= 0 ? fileIndex : 0;
    const nextData = previousData.length > 0 ? cloneJson(previousData) : [];
    const previousVariant = isObject(nextData[resolvedIndex]) ? nextData[resolvedIndex] as Record<string, unknown> : {};
    const variant = {
      ...previousVariant,
      filePath: model.filePath,
      contentType: model.contentType || 'application/octet-stream',
      selected: true,
    };
    if (nextData.length === 0) nextData.push(variant);
    else nextData[resolvedIndex] = variant;
    nextBody.data = nextData;
  } else {
    return undefined;
  }

  if (!Array.isArray(originalBody)) return nextBody;

  const variants = cloneJson(originalBody);
  const index = model.bodyVariantIndex ?? variants.findIndex(variant => isObject(variant) && variant.selected === true);
  const resolvedIndex = index >= 0 ? index : 0;
  const previousVariant = isObject(variants[resolvedIndex]) ? variants[resolvedIndex] as Record<string, unknown> : {};
  variants[resolvedIndex] = {
    ...previousVariant,
    body: nextBody,
  };
  return variants;
}

function mergeSettings(previous: unknown, settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!settings) return isObject(previous) ? cloneJson(previous) : undefined;
  const output: Record<string, unknown> = isObject(previous) ? cloneJson(previous) : {};

  for (const [key, value] of Object.entries(settings)) {
    const isDefault = REQUEST_SETTINGS_DEFAULTS[key] === value;
    if (!hasOwn(previous, key) && isDefault) {
      delete output[key];
    } else {
      output[key] = value;
    }
  }

  return isEmptyObject(output) ? undefined : output;
}

export function applyRequestEditorModel(original: unknown, model: RequestEditorModel): unknown {
  if (!isHttpVisualEditableRequest(original) || (model.protocol && model.protocol !== 'http')) {
    return cloneJson(original);
  }

  const source = isObject(original) ? original : {};
  const request: Record<string, unknown> = cloneJson(source);
  if (!isObject(request.info)) request.info = { type: 'http' };
  if (!isObject(request.http)) request.http = {};

  const http = request.http as Record<string, unknown>;
  if (model.method !== undefined) http.method = model.method;
  if (model.url !== undefined) http.url = model.url;
  if (model.params !== undefined) {
    const merged = mergeParams(Array.isArray(http.params) ? http.params : undefined, model.params);
    if (merged) http.params = merged;
    else delete http.params;
  }
  if (model.headers !== undefined) {
    const merged = mergeHeaders(Array.isArray(http.headers) ? http.headers : undefined, model.headers);
    if (merged) http.headers = merged;
    else delete http.headers;
  }
  if (model.body !== undefined) {
    const body = buildBodyFromEditor(http.body, model.body);
    if (body === undefined) delete http.body;
    else http.body = body;
  }

  if (model.auth !== undefined || isObject(request.runtime)) {
    const runtime: Record<string, unknown> = isObject(request.runtime) ? cloneJson(request.runtime) : {};
    if (model.auth !== undefined) runtime.auth = cloneJson(model.auth);
    else delete runtime.auth;
    if (isEmptyObject(runtime)) delete request.runtime;
    else request.runtime = runtime;
  }

  const settings = mergeSettings(request.settings, model.settings);
  if (settings) request.settings = settings;
  else delete request.settings;

  return request;
}

export function createRequestDefaultsEditorModel(defaults: unknown): RequestDefaultsEditorModel {
  const source = isObject(defaults) ? defaults : {};
  return {
    headers: Array.isArray(source.headers)
      ? source.headers.map((header, index) => {
          const row = isObject(header) ? header : {};
          return {
            name: typeof row.name === 'string' ? row.name : '',
            value: typeof row.value === 'string' ? row.value : '',
            disabled: row.disabled === true,
            originalIndex: index,
          };
        })
      : [],
    auth: source.auth,
    variables: Array.isArray(source.variables) ? cloneJson(source.variables) : [],
  };
}

export function applyRequestDefaultsEditorModel(
  original: unknown,
  model: RequestDefaultsEditorModel,
): Record<string, unknown> | undefined {
  const defaults: Record<string, unknown> = isObject(original) ? cloneJson(original) : {};

  if (hasOwn(model, 'headers')) {
    const headers = mergeHeaders(Array.isArray(defaults.headers) ? defaults.headers : undefined, model.headers);
    if (headers) defaults.headers = headers;
    else delete defaults.headers;
  }

  if (hasOwn(model, 'auth')) {
    if (model.auth !== undefined) defaults.auth = cloneJson(model.auth);
    else delete defaults.auth;
  }

  if (hasOwn(model, 'variables')) {
    const variables = mergeVariables(Array.isArray(defaults.variables) ? defaults.variables : undefined, model.variables);
    if (variables) defaults.variables = variables;
    else delete defaults.variables;
  }

  omitUndefined(defaults);
  return isEmptyObject(defaults) ? undefined : defaults;
}

export function createCollectionEditorModelFromCollection(collection: unknown): CollectionEditorModel {
  const source = isObject(collection) ? collection : {};
  const config = isObject(source.config) ? source.config : {};
  return {
    info: isObject(source.info) ? cloneJson(source.info) : {},
    request: createRequestDefaultsEditorModel(source.request),
    config: {
      forceAuthInherit: config.forceAuthInherit === true,
      secretProviders: Array.isArray(config.secretProviders) ? cloneJson(config.secretProviders) : [],
      environments: Array.isArray(config.environments) ? cloneJson(config.environments) : [],
    },
  };
}

export function applyCollectionEditorModel(original: unknown, model: CollectionEditorModel): unknown {
  const source = isObject(original) ? original : {};
  const collection: Record<string, unknown> = cloneJson(source);

  if (model.info) {
    collection.info = omitUndefined({ ...(isObject(collection.info) ? collection.info : {}), ...cloneJson(model.info) });
    if (isEmptyObject(collection.info)) delete collection.info;
  }

  if (model.request) {
    const requestDefaults = applyRequestDefaultsEditorModel(collection.request, model.request);
    if (requestDefaults) collection.request = requestDefaults;
    else delete collection.request;
  }

  if (model.config) {
    const config: Record<string, unknown> = isObject(collection.config) ? cloneJson(collection.config) : {};
    if (hasOwn(model.config, 'forceAuthInherit')) {
      if (model.config.forceAuthInherit) config.forceAuthInherit = true;
      else delete config.forceAuthInherit;
    }
    if (hasOwn(model.config, 'secretProviders')) {
      if (model.config.secretProviders && model.config.secretProviders.length > 0) {
        config.secretProviders = cloneJson(model.config.secretProviders);
      } else {
        delete config.secretProviders;
      }
    }
    if (hasOwn(model.config, 'environments')) {
      if (model.config.environments && model.config.environments.length > 0) {
        config.environments = cloneJson(model.config.environments);
      } else {
        delete config.environments;
      }
    }
    if (isEmptyObject(config)) delete collection.config;
    else collection.config = config;
  }

  return collection;
}

export function createFolderEditorModelFromFolder(folder: unknown): FolderEditorModel {
  const source = isObject(folder) ? folder : {};
  return {
    info: isObject(source.info) ? cloneJson(source.info) : {},
    request: createRequestDefaultsEditorModel(source.request),
  };
}

export function applyFolderEditorModel(original: unknown, model: FolderEditorModel): unknown {
  const source = isObject(original) ? original : {};
  const folder: Record<string, unknown> = cloneJson(source);

  if (model.info) {
    folder.info = omitUndefined({ ...(isObject(folder.info) ? folder.info : {}), ...cloneJson(model.info) });
    if (isEmptyObject(folder.info)) delete folder.info;
  }

  if (model.request) {
    const requestDefaults = applyRequestDefaultsEditorModel(folder.request, model.request);
    if (requestDefaults) folder.request = requestDefaults;
    else delete folder.request;
  }

  return folder;
}
