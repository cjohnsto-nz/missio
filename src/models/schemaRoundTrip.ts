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

export interface RuntimeScriptEditorRow {
  type: string;
  code: string;
  disabled?: boolean;
  originalIndex?: number;
}

export interface RuntimeAssertionEditorRow {
  expression: string;
  operator: string;
  value?: string;
  disabled?: boolean;
  description?: string;
  originalIndex?: number;
}

export interface RuntimeActionEditorRow {
  type: string;
  phase?: string;
  selectorMethod?: string;
  selectorExpression?: string;
  variableScope?: string;
  variableName?: string;
  disabled?: boolean;
  description?: string;
  originalIndex?: number;
}

export interface RuntimeEditorModel {
  scripts?: RuntimeScriptEditorRow[];
  assertions?: RuntimeAssertionEditorRow[];
  actions?: RuntimeActionEditorRow[];
}

export type RequestEditorBodyModel =
  | { kind: 'none'; bodyVariantIndex?: number }
  | { kind: 'raw'; rawType: string; data: string; bodyVariantIndex?: number }
  | { kind: 'graphql'; query: string; variables: string; bodyVariantIndex?: number }
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
  runtime?: RuntimeEditorModel;
  settings?: Record<string, unknown>;
}

export interface RequestDefaultsEditorModel {
  headers?: KeyValueEditorRow[];
  metadata?: KeyValueEditorRow[];
  auth?: unknown;
  variables?: unknown[];
}

export interface ProtoFileEditorRow {
  path: string;
  originalIndex?: number;
}

export interface ProtoImportPathEditorRow extends ProtoFileEditorRow {
  disabled?: boolean;
}

export interface ProtobufEditorModel {
  protoFiles?: ProtoFileEditorRow[];
  importPaths?: ProtoImportPathEditorRow[];
}

export interface CollectionEditorModel {
  info?: Record<string, unknown>;
  request?: RequestDefaultsEditorModel;
  config?: {
    forceAuthInherit?: boolean;
    secretProviders?: unknown[];
    environments?: unknown[];
    protobuf?: ProtobufEditorModel;
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

const WEBSOCKET_MESSAGE_TYPES = new Set(['text', 'json', 'xml', 'binary']);

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

export function isWebSocketVisualEditableRequest(data: unknown): boolean {
  return detectRequestProtocol(data) === 'websocket' && !isScriptDocument(data);
}

export function isVisualEditableRequest(data: unknown): boolean {
  const protocol = detectRequestProtocol(data);
  return (protocol === undefined || protocol === 'http' || protocol === 'graphql' || protocol === 'websocket' || protocol === 'grpc') && !isScriptDocument(data);
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

function getByExplicitOriginalIndex<T>(items: T[] | undefined, row: { originalIndex?: number }): T | undefined {
  if (!items || row.originalIndex === undefined) return undefined;
  return items[row.originalIndex];
}

function mergeHeaders(previous: unknown[] | undefined, rows: KeyValueEditorRow[] | undefined): unknown[] | undefined {
  if (!rows) return undefined;
  if (rows.length === 0) return Array.isArray(previous) ? [] : undefined;
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
  if (!rows) return undefined;
  if (rows.length === 0) return Array.isArray(previous) ? [] : undefined;
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

function selectedWebSocketMessage(message: unknown): { message: unknown; index?: number } {
  if (!Array.isArray(message)) return { message };
  const selectedIndex = message.findIndex(variant => isObject(variant) && variant.selected === true);
  const index = selectedIndex >= 0 ? selectedIndex : 0;
  const variant = message[index];
  return {
    message: isObject(variant) ? variant.message : undefined,
    index,
  };
}

function selectedGrpcMessage(message: unknown): { message: unknown; index?: number } {
  if (!Array.isArray(message)) return { message };
  const selectedIndex = message.findIndex(variant => isObject(variant) && variant.selected === true);
  const index = selectedIndex >= 0 ? selectedIndex : 0;
  const variant = message[index];
  return {
    message: isObject(variant) && typeof variant.message === 'string' ? variant.message : undefined,
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

function descriptionToText(description: unknown): string | undefined {
  if (typeof description === 'string') return description;
  if (isObject(description) && typeof description.content === 'string') return description.content;
  return undefined;
}

function mergeDescription(output: Record<string, unknown>, prior: unknown, description: string | undefined): void {
  const priorDescription = isObject(prior) ? prior.description : undefined;
  if (description === undefined) return;
  if (description) {
    if (description === descriptionToText(priorDescription)) {
      output.description = cloneJson(priorDescription);
    } else if (isObject(priorDescription) && typeof priorDescription.content === 'string') {
      output.description = {
        ...cloneJson(priorDescription),
        content: description,
      };
    } else {
      output.description = description;
    }
  } else if (hasOwn(prior, 'description')) {
    delete output.description;
  }
}

function createRuntimeEditorModel(runtime: unknown): RuntimeEditorModel {
  const source = isObject(runtime) ? runtime : {};
  return {
    scripts: Array.isArray(source.scripts)
      ? source.scripts.map((script, index) => {
          const row = isObject(script) ? script : {};
          return {
            type: typeof row.type === 'string' ? row.type : 'before-request',
            code: typeof row.code === 'string' ? row.code : '',
            disabled: row.disabled === true,
            originalIndex: index,
          };
        })
      : [],
    assertions: Array.isArray(source.assertions)
      ? source.assertions.map((assertion, index) => {
          const row = isObject(assertion) ? assertion : {};
          return {
            expression: typeof row.expression === 'string' ? row.expression : '',
            operator: typeof row.operator === 'string' ? row.operator : 'equals',
            value: typeof row.value === 'string' ? row.value : row.value === undefined ? undefined : displayValue(row.value),
            disabled: row.disabled === true,
            description: descriptionToText(row.description),
            originalIndex: index,
          };
        })
      : [],
    actions: Array.isArray(source.actions)
      ? source.actions.map((action, index) => {
          const row = isObject(action) ? action : {};
          const selector = isObject(row.selector) ? row.selector : {};
          const variable = isObject(row.variable) ? row.variable : {};
          return {
            type: typeof row.type === 'string' ? row.type : 'set-variable',
            phase: typeof row.phase === 'string' ? row.phase : 'after-response',
            selectorMethod: typeof selector.method === 'string' ? selector.method : 'jsonq',
            selectorExpression: typeof selector.expression === 'string' ? selector.expression : '',
            variableScope: typeof variable.scope === 'string' ? variable.scope : 'runtime',
            variableName: typeof variable.name === 'string' ? variable.name : '',
            disabled: row.disabled === true,
            description: descriptionToText(row.description),
            originalIndex: index,
          };
        })
      : [],
  };
}

export function createRequestEditorModelFromRequest(request: unknown): RequestEditorModel {
  const protocol = detectRequestProtocol(request) ?? 'http';
  const source = isObject(request) ? request : {};

  if (protocol === 'graphql') {
    const graphql = isObject(source.graphql) ? source.graphql : {};
    const { body, index: bodyVariantIndex } = selectedBodyVariant(graphql.body);
    const graphQLBody = isObject(body) ? body : {};
    const runtime = isObject(source.runtime) ? source.runtime : {};

    return {
      protocol,
      method: typeof graphql.method === 'string' ? graphql.method : 'POST',
      url: typeof graphql.url === 'string' ? graphql.url : '',
      params: Array.isArray(graphql.params)
        ? graphql.params.map((param, index) => {
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
      headers: Array.isArray(graphql.headers)
        ? graphql.headers.map((header, index) => {
            const row = isObject(header) ? header : {};
            return {
              name: typeof row.name === 'string' ? row.name : '',
              value: typeof row.value === 'string' ? row.value : '',
              disabled: row.disabled === true,
              originalIndex: index,
            };
          })
        : [],
      body: {
        kind: 'graphql',
        query: typeof graphQLBody.query === 'string' ? graphQLBody.query : '',
        variables: typeof graphQLBody.variables === 'string' ? graphQLBody.variables : '',
        bodyVariantIndex,
      },
      auth: runtime.auth,
      runtime: createRuntimeEditorModel(runtime),
      settings: isObject(source.settings) ? cloneJson(source.settings) : {},
    };
  }

  if (protocol === 'websocket') {
    const websocket = isObject(source.websocket) ? source.websocket : {};
    const runtime = isObject(source.runtime) ? source.runtime : {};
    const { message, index: messageVariantIndex } = selectedWebSocketMessage(websocket.message);
    const messageObject = isObject(message) ? message : {};
    const messageType = typeof messageObject.type === 'string' && WEBSOCKET_MESSAGE_TYPES.has(messageObject.type)
      ? messageObject.type
      : 'text';

    return {
      protocol,
      url: typeof websocket.url === 'string' ? websocket.url : '',
      headers: Array.isArray(websocket.headers)
        ? websocket.headers.map((header, index) => {
            const row = isObject(header) ? header : {};
            return {
              name: typeof row.name === 'string' ? row.name : '',
              value: typeof row.value === 'string' ? row.value : '',
              disabled: row.disabled === true,
              originalIndex: index,
            };
          })
        : [],
      body: isObject(message)
        ? {
            kind: 'raw',
            rawType: messageType,
            data: typeof messageObject.data === 'string' ? messageObject.data : '',
            bodyVariantIndex: messageVariantIndex,
          }
        : { kind: 'none', bodyVariantIndex: messageVariantIndex },
      auth: runtime.auth,
      runtime: createRuntimeEditorModel(runtime),
    };
  }

  if (protocol === 'grpc') {
    const grpc = isObject(source.grpc) ? source.grpc : {};
    const runtime = isObject(source.runtime) ? source.runtime : {};
    const { message, index: messageIndex } = selectedGrpcMessage(grpc.message);

    return {
      protocol,
      url: typeof grpc.url === 'string' ? grpc.url : '',
      headers: Array.isArray(grpc.metadata)
        ? grpc.metadata.map((metadata, index) => {
            const row = isObject(metadata) ? metadata : {};
            return {
              name: typeof row.name === 'string' ? row.name : '',
              value: typeof row.value === 'string' ? row.value : '',
              disabled: row.disabled === true,
              originalIndex: index,
            };
          })
        : [],
      body: typeof message === 'string'
        ? { kind: 'raw', rawType: 'json', data: message, bodyVariantIndex: messageIndex }
        : { kind: 'none', bodyVariantIndex: messageIndex },
      auth: runtime.auth,
      runtime: createRuntimeEditorModel(runtime),
    };
  }

  if (!isHttpVisualEditableRequest(request)) {
    return { protocol };
  }

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
    runtime: createRuntimeEditorModel(runtime),
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
  if (model.kind === 'graphql') return undefined;

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

function mergeMetadata(previous: unknown[] | undefined, rows: KeyValueEditorRow[] | undefined): unknown[] | undefined {
  return mergeHeaders(previous, rows);
}

function createKeyValueRows(sourceRows: unknown, disabledDefault = false): KeyValueEditorRow[] {
  return Array.isArray(sourceRows)
    ? sourceRows.map((entry, index) => {
        const row = isObject(entry) ? entry : {};
        return {
          name: typeof row.name === 'string' ? row.name : '',
          value: typeof row.value === 'string' ? row.value : '',
          disabled: row.disabled === true || disabledDefault,
          originalIndex: index,
        };
      })
    : [];
}

function buildGraphQLBodyFromEditor(originalBody: unknown, model: RequestEditorBodyModel): unknown | undefined {
  if (model.kind !== 'graphql') return originalBody;

  const previousSelected = selectedExistingBody(originalBody, model.bodyVariantIndex);
  const nextBody: Record<string, unknown> = isObject(previousSelected) ? cloneJson(previousSelected) : {};

  if (model.query || hasOwn(previousSelected, 'query')) {
    nextBody.query = model.query;
  } else {
    delete nextBody.query;
  }

  if (model.variables || hasOwn(previousSelected, 'variables')) {
    nextBody.variables = model.variables;
  } else {
    delete nextBody.variables;
  }

  if (!Array.isArray(originalBody)) {
    return isEmptyObject(nextBody) ? undefined : nextBody;
  }

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

function buildWebSocketMessageFromEditor(originalMessage: unknown, model: RequestEditorBodyModel): unknown | undefined {
  if (model.kind === 'none') return undefined;
  if (model.kind !== 'raw') return selectedWebSocketMessage(originalMessage).message;

  const { message: previousSelected } = selectedWebSocketMessage(originalMessage);
  const nextMessage: Record<string, unknown> = isObject(previousSelected) ? cloneJson(previousSelected) : {};
  nextMessage.type = WEBSOCKET_MESSAGE_TYPES.has(model.rawType) ? model.rawType : 'text';
  nextMessage.data = model.data;

  if (!Array.isArray(originalMessage)) return nextMessage;

  const variants = cloneJson(originalMessage);
  const index = model.bodyVariantIndex ?? variants.findIndex(variant => isObject(variant) && variant.selected === true);
  const resolvedIndex = index >= 0 ? index : 0;
  const previousVariant = isObject(variants[resolvedIndex]) ? variants[resolvedIndex] as Record<string, unknown> : {};
  variants[resolvedIndex] = {
    ...previousVariant,
    message: nextMessage,
  };
  return variants;
}

function buildGrpcMessageFromEditor(originalMessage: unknown, model: RequestEditorBodyModel): unknown | undefined {
  if (model.kind === 'none') return undefined;
  if (model.kind !== 'raw') return selectedGrpcMessage(originalMessage).message;

  if (!Array.isArray(originalMessage)) {
    return originalMessage === undefined && model.data === '' ? undefined : model.data;
  }

  const messages = cloneJson(originalMessage);
  const index = model.bodyVariantIndex ?? messages.findIndex(variant => isObject(variant) && variant.selected === true);
  const resolvedIndex = index >= 0 ? index : 0;
  const previousEntry = isObject(messages[resolvedIndex]) ? messages[resolvedIndex] as Record<string, unknown> : {};
  messages[resolvedIndex] = {
    ...previousEntry,
    message: model.data,
  };
  return messages;
}

function mergeRuntimeScripts(previous: unknown[] | undefined, rows: RuntimeScriptEditorRow[] | undefined): unknown[] | undefined {
  if (!rows) return undefined;
  if (rows.length === 0) return Array.isArray(previous) ? [] : undefined;
  return rows
    .filter(row => row.type && row.code !== undefined)
    .map((row) => {
      const prior = getByExplicitOriginalIndex(previous, row);
      const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
      output.type = row.type;
      output.code = row.code;
      return withOptionalDisabled(output, prior, row.disabled);
    });
}

function mergeRuntimeAssertions(previous: unknown[] | undefined, rows: RuntimeAssertionEditorRow[] | undefined): unknown[] | undefined {
  if (!rows) return undefined;
  if (rows.length === 0) return Array.isArray(previous) ? [] : undefined;
  const assertions: unknown[] = [];
  for (const row of rows) {
    const prior = getByExplicitOriginalIndex(previous, row);
    if (!row.expression || !row.operator) {
      if (isObject(prior)) assertions.push(cloneJson(prior));
      continue;
    }
    const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
    output.expression = row.expression;
    output.operator = row.operator;
    if (row.value || hasOwn(prior, 'value')) output.value = row.value ?? '';
    else delete output.value;
    mergeDescription(output, prior, row.description);
    assertions.push(withOptionalDisabled(output, prior, row.disabled));
  }
  return assertions;
}

function mergeRuntimeActions(previous: unknown[] | undefined, rows: RuntimeActionEditorRow[] | undefined): unknown[] | undefined {
  if (!rows) return undefined;
  if (rows.length === 0) return Array.isArray(previous) ? [] : undefined;
  const actions: unknown[] = [];
  for (const row of rows) {
    const prior = getByExplicitOriginalIndex(previous, row);
    if (row.type !== 'set-variable' || !row.selectorExpression || !row.variableName) {
      if (isObject(prior)) actions.push(cloneJson(prior));
      continue;
    }
    const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
    output.type = 'set-variable';
    if (row.phase || hasOwn(prior, 'phase')) output.phase = row.phase || 'after-response';
    else delete output.phase;
    output.selector = {
      ...(isObject(output.selector) ? output.selector : {}),
      method: row.selectorMethod || 'jsonq',
      expression: row.selectorExpression,
    };
    output.variable = {
      ...(isObject(output.variable) ? output.variable : {}),
      scope: row.variableScope || 'runtime',
      name: row.variableName,
    };
    mergeDescription(output, prior, row.description);
    actions.push(withOptionalDisabled(output, prior, row.disabled));
  }
  return actions;
}

function mergeRuntime(
  previous: unknown,
  auth: unknown,
  authProvided: boolean,
  runtimeModel: RuntimeEditorModel | undefined,
): Record<string, unknown> | undefined {
  const runtime: Record<string, unknown> = isObject(previous) ? cloneJson(previous) : {};

  if (authProvided) {
    if (auth !== undefined) runtime.auth = cloneJson(auth);
    else delete runtime.auth;
  }

  if (runtimeModel) {
    if (hasOwn(runtimeModel, 'scripts')) {
      const scripts = mergeRuntimeScripts(Array.isArray(runtime.scripts) ? runtime.scripts : undefined, runtimeModel.scripts);
      if (scripts) runtime.scripts = scripts;
      else delete runtime.scripts;
    }
    if (hasOwn(runtimeModel, 'assertions')) {
      const assertions = mergeRuntimeAssertions(Array.isArray(runtime.assertions) ? runtime.assertions : undefined, runtimeModel.assertions);
      if (assertions) runtime.assertions = assertions;
      else delete runtime.assertions;
    }
    if (hasOwn(runtimeModel, 'actions')) {
      const actions = mergeRuntimeActions(Array.isArray(runtime.actions) ? runtime.actions : undefined, runtimeModel.actions);
      if (actions) runtime.actions = actions;
      else delete runtime.actions;
    }
  }

  return isEmptyObject(runtime) ? undefined : runtime;
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
  if (!isVisualEditableRequest(original) || (model.protocol && model.protocol !== 'http' && model.protocol !== 'graphql' && model.protocol !== 'websocket' && model.protocol !== 'grpc')) {
    return cloneJson(original);
  }

  const originalProtocol = detectRequestProtocol(original) ?? 'http';
  const targetProtocol = model.protocol ?? originalProtocol;

  if (targetProtocol === 'graphql') {
    const source = isObject(original) ? original : {};
    const request: Record<string, unknown> = cloneJson(source);
    if (!isObject(request.info)) request.info = { type: 'graphql' };
    else (request.info as Record<string, unknown>).type = 'graphql';
    if (!isObject(request.graphql)) request.graphql = {};
    delete request.http;

    const graphql = request.graphql as Record<string, unknown>;
    if (model.method !== undefined) graphql.method = model.method;
    if (model.url !== undefined) graphql.url = model.url;
    if (model.params !== undefined) {
      const merged = mergeParams(Array.isArray(graphql.params) ? graphql.params : undefined, model.params);
      if (merged) graphql.params = merged;
      else delete graphql.params;
    }
    if (model.headers !== undefined) {
      const merged = mergeHeaders(Array.isArray(graphql.headers) ? graphql.headers : undefined, model.headers);
      if (merged) graphql.headers = merged;
      else delete graphql.headers;
    }
    if (model.body !== undefined) {
      const body = buildGraphQLBodyFromEditor(graphql.body, model.body);
      if (body === undefined) delete graphql.body;
      else graphql.body = body;
    }

    const runtime = mergeRuntime(request.runtime, model.auth, hasOwn(model, 'auth'), model.runtime);
    if (runtime) request.runtime = runtime;
    else delete request.runtime;

    const settings = mergeSettings(request.settings, model.settings);
    if (settings) request.settings = settings;
    else delete request.settings;

    return request;
  }

  if (targetProtocol === 'websocket') {
    const source = isObject(original) ? original : {};
    const request: Record<string, unknown> = cloneJson(source);
    if (!isObject(request.info)) request.info = { type: 'websocket' };
    else (request.info as Record<string, unknown>).type = 'websocket';
    if (!isObject(request.websocket)) request.websocket = {};
    delete request.http;
    delete request.graphql;

    const websocket = request.websocket as Record<string, unknown>;
    if (model.url !== undefined) websocket.url = model.url;
    if (model.headers !== undefined) {
      const merged = mergeHeaders(Array.isArray(websocket.headers) ? websocket.headers : undefined, model.headers);
      if (merged) websocket.headers = merged;
      else delete websocket.headers;
    }
    if (model.body !== undefined) {
      const message = buildWebSocketMessageFromEditor(websocket.message, model.body);
      if (message === undefined) delete websocket.message;
      else websocket.message = message;
    }

    const runtime = mergeRuntime(request.runtime, model.auth, hasOwn(model, 'auth'), model.runtime);
    if (runtime) request.runtime = runtime;
    else delete request.runtime;

    return request;
  }

  if (targetProtocol === 'grpc') {
    const source = isObject(original) ? original : {};
    const request: Record<string, unknown> = cloneJson(source);
    if (!isObject(request.info)) request.info = { type: 'grpc' };
    else (request.info as Record<string, unknown>).type = 'grpc';
    if (!isObject(request.grpc)) request.grpc = {};
    delete request.http;
    delete request.graphql;
    delete request.websocket;

    const grpc = request.grpc as Record<string, unknown>;
    if (model.url !== undefined) grpc.url = model.url;
    if (model.headers !== undefined) {
      const merged = mergeMetadata(Array.isArray(grpc.metadata) ? grpc.metadata : undefined, model.headers);
      if (merged) grpc.metadata = merged;
      else delete grpc.metadata;
    }
    if (model.body !== undefined) {
      const message = buildGrpcMessageFromEditor(grpc.message, model.body);
      if (message === undefined) delete grpc.message;
      else grpc.message = message;
    }

    const runtime = mergeRuntime(request.runtime, model.auth, hasOwn(model, 'auth'), model.runtime);
    if (runtime) request.runtime = runtime;
    else delete request.runtime;

    return request;
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

  const runtime = mergeRuntime(request.runtime, model.auth, hasOwn(model, 'auth'), model.runtime);
  if (runtime) request.runtime = runtime;
  else delete request.runtime;

  const settings = mergeSettings(request.settings, model.settings);
  if (settings) request.settings = settings;
  else delete request.settings;

  return request;
}

export function createRequestDefaultsEditorModel(defaults: unknown): RequestDefaultsEditorModel {
  const source = isObject(defaults) ? defaults : {};
  return {
    headers: createKeyValueRows(source.headers),
    metadata: createKeyValueRows(source.metadata),
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

  if (hasOwn(model, 'metadata')) {
    const metadata = mergeMetadata(Array.isArray(defaults.metadata) ? defaults.metadata : undefined, model.metadata);
    if (metadata) defaults.metadata = metadata;
    else delete defaults.metadata;
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

function createProtobufEditorModel(source: unknown): ProtobufEditorModel {
  const protobuf = isObject(source) ? source : {};
  return {
    protoFiles: Array.isArray(protobuf.protoFiles)
      ? protobuf.protoFiles.map((entry, index) => {
          const row = isObject(entry) ? entry : {};
          return {
            path: typeof row.path === 'string' ? row.path : '',
            originalIndex: index,
          };
        })
      : [],
    importPaths: Array.isArray(protobuf.importPaths)
      ? protobuf.importPaths.map((entry, index) => {
          const row = isObject(entry) ? entry : {};
          return {
            path: typeof row.path === 'string' ? row.path : '',
            disabled: row.disabled === true,
            originalIndex: index,
          };
        })
      : [],
  };
}

function applyProtobufEditorModel(original: unknown, model: ProtobufEditorModel): Record<string, unknown> | undefined {
  const protobuf: Record<string, unknown> = isObject(original) ? cloneJson(original) : {};

  if (hasOwn(model, 'protoFiles')) {
    const previous = Array.isArray(protobuf.protoFiles) ? protobuf.protoFiles : undefined;
    const protoFiles = (model.protoFiles ?? [])
      .filter(row => row.path)
      .map((row, index) => {
        const prior = getByOriginalIndex(previous, row, index);
        const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
        output.type = 'file';
        output.path = row.path;
        return output;
      });
    if (protoFiles.length > 0) protobuf.protoFiles = protoFiles;
    else delete protobuf.protoFiles;
  }

  if (hasOwn(model, 'importPaths')) {
    const previous = Array.isArray(protobuf.importPaths) ? protobuf.importPaths : undefined;
    const importPaths = (model.importPaths ?? [])
      .filter(row => row.path)
      .map((row, index) => {
        const prior = getByOriginalIndex(previous, row, index);
        const output: Record<string, unknown> = isObject(prior) ? cloneJson(prior) : {};
        output.path = row.path;
        return withOptionalDisabled(output, prior, row.disabled);
      });
    if (importPaths.length > 0) protobuf.importPaths = importPaths;
    else delete protobuf.importPaths;
  }

  omitUndefined(protobuf);
  return isEmptyObject(protobuf) ? undefined : protobuf;
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
      protobuf: createProtobufEditorModel(config.protobuf),
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
    if (hasOwn(model.config, 'protobuf')) {
      const protobuf = applyProtobufEditorModel(config.protobuf, model.config.protobuf ?? {});
      if (protobuf) config.protobuf = protobuf;
      else delete config.protobuf;
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
