import * as vm from 'vm';
import type {
  Action,
  ActionPhase,
  ActionVariableScope,
  Assertion,
  HttpRequest,
  HttpRequestBody,
  HttpRequestBodyVariant,
  HttpResponse,
  MissioCollection,
  RequestDefaults,
  RuntimeActionResult,
  RuntimeAssertionResult,
  RuntimeErrorDiagnostic,
  RuntimeExecutionResult,
  RuntimeLogEntry,
  RuntimePhase,
  RuntimeTestResult,
  RuntimeVariableMutation,
  Script,
  ScriptType,
  Variable,
  VariableValue,
  VariableValueVariant,
} from '../models/types';

export type RuntimeVariableResolver = (
  collection: MissioCollection,
  folderDefaults?: RequestDefaults,
  environmentName?: string,
) => Promise<Map<string, string>>;

interface RuntimeVariableScopes {
  base: Map<string, string>;
  request: Map<string, string>;
  runtime: Map<string, string>;
}

interface RuntimeState {
  request: HttpRequest;
  response?: HttpResponse;
  variables: RuntimeVariableScopes;
  result: RuntimeExecutionResult;
}

export interface RuntimePreparedHttpRequest {
  request: HttpRequest;
  extraVariables?: Map<string, string>;
  runtime: RuntimeExecutionResult;
  state: RuntimeState;
}

export class RuntimeExecutionError extends Error {
  constructor(
    message: string,
    public readonly runtime: RuntimeExecutionResult,
    public readonly phase: RuntimePhase,
  ) {
    super(message);
    this.name = 'RuntimeExecutionError';
  }
}

export class RuntimeExecutionService {
  constructor(private readonly _variableResolver?: RuntimeVariableResolver) {}

  hasRuntimeWork(
    request: HttpRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
  ): boolean {
    return variablesToMap(request.runtime?.variables).size > 0
      || lifecycleScripts(collection.data.request?.scripts, folderDefaults?.scripts, request.runtime?.scripts, 'before-request').length > 0
      || lifecycleScripts(undefined, undefined, request.runtime?.scripts, 'after-response').length > 0
      || lifecycleScripts(undefined, undefined, request.runtime?.scripts, 'tests').length > 0
      || (request.runtime?.assertions ?? []).length > 0
      || (request.runtime?.actions ?? []).length > 0;
  }

  async buildRequestVariableOverrides(
    request: HttpRequest,
    extraVariables?: Map<string, string>,
  ): Promise<Map<string, string> | undefined> {
    const requestVariables = variablesToMap(request.runtime?.variables);
    if (requestVariables.size === 0 && (!extraVariables || extraVariables.size === 0)) {
      return undefined;
    }

    const merged = new Map<string, string>();
    mergeInto(merged, requestVariables);
    if (extraVariables) mergeInto(merged, extraVariables);
    return merged;
  }

  async prepareHttpRequest(
    request: HttpRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
  ): Promise<RuntimePreparedHttpRequest> {
    const clonedRequest = cloneJson(request);
    const result = createRuntimeResult();
    const baseVariables = this._variableResolver
      ? await this._variableResolver(collection, folderDefaults, environmentName)
      : new Map<string, string>();
    const variables: RuntimeVariableScopes = {
      base: new Map(baseVariables),
      request: variablesToMap(clonedRequest.runtime?.variables),
      runtime: new Map(extraVariables),
    };
    const state: RuntimeState = { request: clonedRequest, variables, result };

    await this._runScripts(state, lifecycleScripts(collection.data.request?.scripts, folderDefaults?.scripts, clonedRequest.runtime?.scripts, 'before-request'), 'before-request', true);
    this._runActions(state, 'before-request');

    return {
      request: clonedRequest,
      extraVariables: this._buildExecutionVariables(variables),
      runtime: result,
      state,
    };
  }

  async completeHttpRequest(
    prepared: RuntimePreparedHttpRequest,
    response: HttpResponse,
  ): Promise<HttpResponse> {
    prepared.state.response = response;
    this._runActions(prepared.state, 'after-response');
    await this._runScripts(prepared.state, lifecycleScripts(undefined, undefined, prepared.state.request.runtime?.scripts, 'after-response'), 'after-response', false);
    this._runAssertions(prepared.state, prepared.state.request.runtime?.assertions ?? []);
    await this._runScripts(prepared.state, lifecycleScripts(undefined, undefined, prepared.state.request.runtime?.scripts, 'tests'), 'tests', false);
    finalizeRuntimeResult(prepared.runtime);
    return hasRuntimeActivity(prepared.runtime)
      ? { ...response, runtime: prepared.runtime }
      : response;
  }

  private _buildExecutionVariables(variables: RuntimeVariableScopes): Map<string, string> | undefined {
    const merged = new Map<string, string>();
    mergeInto(merged, variables.request);
    mergeInto(merged, variables.runtime);
    return merged.size > 0 ? merged : undefined;
  }

  private async _runScripts(
    state: RuntimeState,
    scripts: Script[],
    phase: RuntimePhase,
    fatal: boolean,
  ): Promise<void> {
    for (const script of scripts) {
      try {
        this._runScript(state, script, phase);
      } catch (error) {
        const diagnostic = errorToDiagnostic(error, phase, script.type);
        state.result.errors.push(diagnostic);
        if (phase === 'tests') {
          state.result.tests.push({
            name: `${script.type} script`,
            passed: false,
            message: diagnostic.message,
          });
        }
        if (fatal) {
          finalizeRuntimeResult(state.result);
          throw new RuntimeExecutionError(diagnostic.message, state.result, phase);
        }
      }
    }
  }

  private _runScript(state: RuntimeState, script: Script, phase: RuntimePhase): void {
    const sandbox = this._createSandbox(state, phase);
    const context = vm.createContext(sandbox, {
      name: 'missio-runtime',
      codeGeneration: { strings: false, wasm: false },
    });
    const compiled = new vm.Script(script.code, {
      filename: `missio-${script.type}.js`,
    });
    compiled.runInContext(context, { timeout: 1000, displayErrors: true });
  }

  private _createSandbox(state: RuntimeState, phase: RuntimePhase): vm.Context {
    const consoleApi = makeConsoleApi(state.result.logs, phase);
    const variablesApi = makeVariablesApi(state);
    const requestApi = makeRequestApi(state);
    const responseApi = makeResponseApi(state);

    const assertApi = (condition: unknown, message?: string) => {
      if (!condition) {
        throw new Error(message || 'Assertion failed');
      }
    };

    const testApi = (name: string, fn: () => void) => {
      const started = Date.now();
      try {
        fn();
        state.result.tests.push({ name: String(name), passed: true, duration: Date.now() - started });
      } catch (error) {
        state.result.tests.push({
          name: String(name),
          passed: false,
          message: errorMessage(error),
          duration: Date.now() - started,
        });
      }
    };

    const pmApi = makePostmanApi(state, requestApi, responseApi, variablesApi, testApi, assertApi);

    const sandbox = Object.create(null) as vm.Context;
    Object.assign(sandbox, {
      console: consoleApi,
      assert: assertApi,
      test: testApi,
      missio: Object.freeze({
        request: requestApi,
        response: responseApi,
        variables: variablesApi,
      }),
      pm: pmApi,
      request: requestApi,
      response: responseApi,
      variables: variablesApi,
    });
    return sandbox;
  }

  private _runAssertions(state: RuntimeState, assertions: Assertion[]): void {
    for (const assertion of assertions) {
      if (assertion.disabled) {
        state.result.assertions.push({
          expression: assertion.expression,
          operator: assertion.operator,
          expected: assertion.value,
          actual: undefined,
          passed: true,
          skipped: true,
          description: descriptionToText(assertion.description),
        });
        continue;
      }

      const actual = evaluateExpression(assertion.expression, state);
      const comparison = compareValues(actual, assertion.value, assertion.operator);
      state.result.assertions.push({
        expression: assertion.expression,
        operator: assertion.operator,
        expected: assertion.value,
        actual,
        passed: comparison.passed,
        description: descriptionToText(assertion.description),
        message: comparison.message,
      });
    }
  }

  private _runActions(state: RuntimeState, phase: ActionPhase): void {
    const actions = state.request.runtime?.actions ?? [];
    for (const action of actions) {
      const actionPhase = action.phase ?? 'after-response';
      if (actionPhase !== phase) continue;
      state.result.actions.push(this._runAction(state, action, actionPhase));
    }
  }

  private _runAction(state: RuntimeState, action: Action, phase: ActionPhase): RuntimeActionResult {
    if (action.disabled) {
      return { type: action.type, phase, passed: true, skipped: true };
    }

    if (action.type !== 'set-variable') {
      return {
        type: action.type,
        phase,
        passed: false,
        message: `Unsupported action type: ${String((action as Action).type)}`,
      };
    }

    if (action.selector.method !== 'jsonq') {
      return {
        type: action.type,
        phase,
        passed: false,
        target: `${action.variable.scope}.${action.variable.name}`,
        message: `Unsupported selector method: ${String(action.selector.method)}`,
      };
    }

    const value = evaluateJsonSelector(action.selector.expression, state);
    if (value === undefined) {
      return {
        type: action.type,
        phase,
        passed: false,
        target: `${action.variable.scope}.${action.variable.name}`,
        message: `Selector did not resolve: ${action.selector.expression}`,
      };
    }

    const stringValue = stringifyVariableValue(value);
    setRuntimeVariable(state, action.variable.scope, action.variable.name, stringValue, 'action');
    return {
      type: action.type,
      phase,
      passed: true,
      target: `${action.variable.scope}.${action.variable.name}`,
      value,
    };
  }
}

function createRuntimeResult(): RuntimeExecutionResult {
  return {
    success: true,
    summary: { passed: 0, failed: 0, skipped: 0 },
    logs: [],
    tests: [],
    assertions: [],
    actions: [],
    variableMutations: [],
    errors: [],
  };
}

function finalizeRuntimeResult(result: RuntimeExecutionResult): void {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const test of result.tests) {
    if (test.passed) passed++;
    else failed++;
  }
  for (const assertion of result.assertions) {
    if (assertion.skipped) skipped++;
    else if (assertion.passed) passed++;
    else failed++;
  }
  for (const action of result.actions) {
    if (action.skipped) skipped++;
    else if (action.passed) passed++;
    else failed++;
  }

  failed += result.errors.length;
  result.success = failed === 0;
  result.summary = { passed, failed, skipped };
}

function hasRuntimeActivity(result: RuntimeExecutionResult): boolean {
  return result.logs.length > 0
    || result.tests.length > 0
    || result.assertions.length > 0
    || result.actions.length > 0
    || result.variableMutations.length > 0
    || result.errors.length > 0;
}

function lifecycleScripts(
  collectionScripts: Script[] | undefined,
  folderScripts: Script[] | undefined,
  requestScripts: Script[] | undefined,
  type: ScriptType,
): Script[] {
  return [
    ...(collectionScripts ?? []),
    ...(folderScripts ?? []),
    ...(requestScripts ?? []),
  ].filter(script => script.type === type);
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function mergeInto(target: Map<string, string>, source: Map<string, string>): void {
  for (const [key, value] of source) {
    target.set(key, value);
  }
}

function variablesToMap(variables: Variable[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const variable of variables ?? []) {
    if (!variable.name || variable.disabled) continue;
    const value = resolveVariableValue(variable.value);
    if (value !== undefined) {
      map.set(variable.name, value);
    }
  }
  return map;
}

function resolveVariableValue(value: Variable['value']): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const variants = value as VariableValueVariant[];
    const selected = variants.find(variant => variant.selected) ?? variants[0];
    return selected ? resolveVariableValue(selected.value as VariableValue) : undefined;
  }
  if (typeof value === 'object' && 'data' in value && typeof value.data === 'string') {
    return value.data;
  }
  return undefined;
}

function makeConsoleApi(logs: RuntimeLogEntry[], phase: RuntimePhase): Console {
  const push = (level: RuntimeLogEntry['level'], args: unknown[]) => {
    logs.push({ phase, level, message: args.map(formatLogValue).join(' ') });
  };
  return {
    log: (...args: unknown[]) => push('log', args),
    info: (...args: unknown[]) => push('info', args),
    warn: (...args: unknown[]) => push('warn', args),
    error: (...args: unknown[]) => push('error', args),
  } as Console;
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function makeVariablesApi(state: RuntimeState): Record<string, unknown> {
  return Object.freeze({
    get: (name: string) => getVariable(state, name),
    set: (name: string, value: unknown, scope: ActionVariableScope = 'runtime') => {
      setRuntimeVariable(state, scope, String(name), stringifyVariableValue(value), 'script');
    },
    unset: (name: string, scope: ActionVariableScope = 'runtime') => {
      if (scope === 'request') state.variables.request.delete(String(name));
      else state.variables.runtime.delete(String(name));
    },
    toObject: () => Object.fromEntries(buildVisibleVariables(state.variables)),
  });
}

function makeRequestApi(state: RuntimeState): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  Object.defineProperties(api, {
    method: {
      enumerable: true,
      get: () => state.request.http?.method,
      set: (value: unknown) => {
        if (!state.request.http) state.request.http = {};
        state.request.http.method = String(value);
      },
    },
    url: {
      enumerable: true,
      get: () => state.request.http?.url,
      set: (value: unknown) => {
        if (!state.request.http) state.request.http = {};
        state.request.http.url = String(value);
      },
    },
    body: {
      enumerable: true,
      get: () => getRequestBodyValue(state.request),
      set: (value: unknown) => setRequestBodyValue(state.request, value),
    },
  });

  api.headers = makeHeaderApi(
    () => state.request.http?.headers ?? [],
    (headers) => {
      if (!state.request.http) state.request.http = {};
      state.request.http.headers = headers;
    },
  );
  api.setHeader = (name: string, value: unknown) => setHeader(state.request, name, value);
  api.getHeader = (name: string) => getHeader(state.request, name);
  api.setBody = (value: unknown) => setRequestBodyValue(state.request, value);
  api.json = () => parseMaybeJson(getRequestBodyValue(state.request));
  return Object.freeze(api);
}

function makeResponseApi(state: RuntimeState): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  Object.defineProperties(api, {
    status: {
      enumerable: true,
      get: () => state.response?.status,
    },
    code: {
      enumerable: true,
      get: () => state.response?.status,
    },
    statusText: {
      enumerable: true,
      get: () => state.response?.statusText,
    },
    body: {
      enumerable: true,
      get: () => state.response?.body,
    },
  });
  api.headers = Object.freeze({
    get: (name: string) => getResponseHeader(state.response, name),
    toObject: () => ({ ...(state.response?.headers ?? {}) }),
  });
  api.text = () => state.response?.body ?? '';
  api.json = () => parseMaybeJson(state.response?.body ?? '');
  return Object.freeze(api);
}

function makePostmanApi(
  state: RuntimeState,
  requestApi: Record<string, unknown>,
  responseApi: Record<string, unknown>,
  variablesApi: Record<string, unknown>,
  testApi: (name: string, fn: () => void) => void,
  assertApi: (condition: unknown, message?: string) => void,
): Record<string, unknown> {
  const expectApi = (actual: unknown) => makeExpectApi(actual, assertApi);
  return Object.freeze({
    request: requestApi,
    response: responseApi,
    variables: variablesApi,
    environment: variablesApi,
    collectionVariables: variablesApi,
    test: testApi,
    expect: expectApi,
    setNextRequest: () => {
      state.result.logs.push({
        phase: 'tests',
        level: 'warn',
        message: 'pm.setNextRequest is not supported by Missio runtime.',
      });
    },
  });
}

function makeExpectApi(actual: unknown, assertApi: (condition: unknown, message?: string) => void): Record<string, unknown> {
  const fail = (expected: unknown, operator: string) =>
    `Expected ${formatLogValue(actual)} to ${operator} ${formatLogValue(expected)}`;
  const equals = (expected: unknown) => assertApi(deepEqualLoose(actual, expected), fail(expected, 'equal'));
  const contains = (expected: unknown) => assertApi(valueContains(actual, expected), fail(expected, 'contain'));
  const above = (expected: unknown) => assertApi(Number(actual) > Number(expected), fail(expected, 'be above'));
  const below = (expected: unknown) => assertApi(Number(actual) < Number(expected), fail(expected, 'be below'));
  const match = (expected: unknown) => assertApi(new RegExp(String(expected)).test(String(actual)), fail(expected, 'match'));
  const to: Record<string, unknown> = {
    equal: equals,
    equals,
    eql: equals,
    contain: contains,
    contains,
    include: contains,
    match,
    have: {
      status: (expected: unknown) => equals(expected),
    },
    be: {
      above,
      below,
      greaterThan: above,
      lessThan: below,
    },
  };
  Object.defineProperties(to.be as Record<string, unknown>, {
    true: { get: () => assertApi(actual === true, `Expected ${formatLogValue(actual)} to be true`) },
    false: { get: () => assertApi(actual === false, `Expected ${formatLogValue(actual)} to be false`) },
    ok: { get: () => assertApi(!!actual, `Expected ${formatLogValue(actual)} to be truthy`) },
  });
  return Object.freeze({ to });
}

function makeHeaderApi(
  getHeaders: () => NonNullable<HttpRequest['http']>['headers'],
  setHeaders: (headers: NonNullable<HttpRequest['http']>['headers']) => void,
): Record<string, unknown> {
  return Object.freeze({
    get: (name: string) => {
      const header = (getHeaders() ?? []).find(h => !h.disabled && h.name.toLowerCase() === String(name).toLowerCase());
      return header?.value;
    },
    set: (name: string, value: unknown) => {
      const headers = [...(getHeaders() ?? [])];
      const index = headers.findIndex(h => h.name.toLowerCase() === String(name).toLowerCase());
      const next = { name: String(name), value: stringifyVariableValue(value) };
      if (index >= 0) headers[index] = { ...headers[index], ...next };
      else headers.push(next);
      setHeaders(headers);
    },
    add: (entry: unknown) => {
      if (isRecord(entry)) {
        const key = typeof entry.key === 'string' ? entry.key : entry.name;
        if (typeof key === 'string') {
          (makeHeaderApi(getHeaders, setHeaders).set as (name: string, value: unknown) => void)(key, entry.value);
        }
      }
    },
    upsert: (entry: unknown) => {
      if (isRecord(entry)) {
        const key = typeof entry.key === 'string' ? entry.key : entry.name;
        if (typeof key === 'string') {
          (makeHeaderApi(getHeaders, setHeaders).set as (name: string, value: unknown) => void)(key, entry.value);
        }
      }
    },
    remove: (name: string) => {
      setHeaders((getHeaders() ?? []).filter(h => h.name.toLowerCase() !== String(name).toLowerCase()));
    },
    toObject: () => Object.fromEntries((getHeaders() ?? []).filter(h => !h.disabled).map(h => [h.name, h.value])),
  });
}

function setHeader(request: HttpRequest, name: string, value: unknown): void {
  if (!request.http) request.http = {};
  const headers = [...(request.http.headers ?? [])];
  const index = headers.findIndex(header => header.name.toLowerCase() === String(name).toLowerCase());
  const next = { name: String(name), value: stringifyVariableValue(value) };
  if (index >= 0) headers[index] = { ...headers[index], ...next };
  else headers.push(next);
  request.http.headers = headers;
}

function getHeader(request: HttpRequest, name: string): string | undefined {
  return request.http?.headers?.find(header => !header.disabled && header.name.toLowerCase() === String(name).toLowerCase())?.value;
}

function getResponseHeader(response: HttpResponse | undefined, name: string): string | undefined {
  if (!response) return undefined;
  const found = Object.entries(response.headers).find(([key]) => key.toLowerCase() === String(name).toLowerCase());
  return found?.[1];
}

function getRequestBodyValue(request: HttpRequest): unknown {
  const body = selectedHttpBody(request.http?.body);
  if (!body) return undefined;
  if (body.type === 'json') return parseMaybeJson(body.data);
  if (body.type === 'text' || body.type === 'xml' || body.type === 'html' || body.type === 'yaml' || body.type === 'sparql') return body.data;
  return cloneJson(body);
}

function setRequestBodyValue(request: HttpRequest, value: unknown): void {
  if (!request.http) request.http = {};
  const body = selectedHttpBody(request.http.body);
  const nextType = typeof value === 'object' ? 'json' : body?.type ?? 'text';
  const nextData = typeof value === 'string' ? value : JSON.stringify(value);

  if (!body) {
    request.http.body = { type: nextType, data: nextData } as HttpRequestBody;
    return;
  }

  body.type = nextType as HttpRequestBody['type'];
  (body as { data?: unknown }).data = nextData;
}

function selectedHttpBody(body: HttpRequest['http'] extends infer _ ? HttpRequest['http'] extends undefined ? never : NonNullable<HttpRequest['http']>['body'] : never): HttpRequestBody | undefined {
  if (!body) return undefined;
  if (Array.isArray(body)) {
    const variants = body as HttpRequestBodyVariant[];
    return (variants.find(variant => variant.selected) ?? variants[0])?.body;
  }
  return body as HttpRequestBody;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildVisibleVariables(variables: RuntimeVariableScopes): Map<string, string> {
  const merged = new Map<string, string>(variables.base);
  mergeInto(merged, variables.request);
  mergeInto(merged, variables.runtime);
  return merged;
}

function getVariable(state: RuntimeState, name: string): string | undefined {
  return buildVisibleVariables(state.variables).get(String(name));
}

function setRuntimeVariable(
  state: RuntimeState,
  scope: ActionVariableScope,
  name: string,
  value: string,
  source: RuntimeVariableMutation['source'],
): void {
  if (scope === 'request') state.variables.request.set(name, value);
  else state.variables.runtime.set(name, value);
  state.result.variableMutations.push({ scope, name, value, source });
}

function evaluateJsonSelector(expression: string, state: RuntimeState): unknown {
  const root = state.response
    ? parseMaybeJson(state.response.body)
    : parseMaybeJson(getRequestBodyValue(state.request));
  return getPathValue(root, normalizeSelectorExpression(expression));
}

function evaluateExpression(expression: string, state: RuntimeState): unknown {
  const trimmed = expression.trim();
  const responseBody = state.response ? parseMaybeJson(state.response.body) : undefined;
  const requestBody = parseMaybeJson(getRequestBodyValue(state.request));

  if (trimmed === 'status' || trimmed === 'statusCode' || trimmed === 'res.status' || trimmed === 'response.status') {
    return state.response?.status;
  }
  if (trimmed === 'body' || trimmed === 'res.body' || trimmed === 'response.body') {
    return responseBody;
  }
  if (trimmed === 'text' || trimmed === 'res.text' || trimmed === 'response.text') {
    return state.response?.body;
  }
  if (trimmed === 'request.body' || trimmed === 'req.body') {
    return requestBody;
  }
  if (trimmed.startsWith('$')) {
    return evaluateJsonSelector(trimmed, state);
  }

  const root = {
    req: {
      method: state.request.http?.method,
      url: state.request.http?.url,
      headers: Object.fromEntries((state.request.http?.headers ?? []).filter(h => !h.disabled).map(h => [h.name.toLowerCase(), h.value])),
      body: requestBody,
    },
    request: {
      method: state.request.http?.method,
      url: state.request.http?.url,
      headers: Object.fromEntries((state.request.http?.headers ?? []).filter(h => !h.disabled).map(h => [h.name.toLowerCase(), h.value])),
      body: requestBody,
    },
    res: {
      status: state.response?.status,
      statusText: state.response?.statusText,
      headers: lowerCaseRecord(state.response?.headers ?? {}),
      body: responseBody,
      text: state.response?.body,
    },
    response: {
      status: state.response?.status,
      statusText: state.response?.statusText,
      headers: lowerCaseRecord(state.response?.headers ?? {}),
      body: responseBody,
      text: state.response?.body,
    },
    variables: Object.fromEntries(buildVisibleVariables(state.variables)),
  };

  if (trimmed.startsWith('json.')) {
    return getPathValue(responseBody, trimmed.slice('json.'.length));
  }
  return getPathValue(root, trimmed);
}

function normalizeSelectorExpression(expression: string): string {
  return expression.trim().replace(/^\$\./, '').replace(/^\$/, '');
}

function lowerCaseRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
}

function getPathValue(root: unknown, expression: string): unknown {
  if (expression === '') return root;
  const tokens = tokenizePath(expression);
  let current = root;
  for (const token of tokens) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(token)) {
      current = current[Number(token)];
    } else if (isRecord(current)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function tokenizePath(expression: string): string[] {
  const tokens: string[] = [];
  const re = /(?:^|\.)([^.[\]]+)|\[(?:(\d+)|["']([^"']+)["'])\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(expression)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function compareValues(actual: unknown, expected: unknown, operator: string): { passed: boolean; message?: string } {
  const op = operator.trim().toLowerCase();
  let passed: boolean;
  switch (op) {
    case 'equals':
    case 'equal':
    case 'eq':
    case '===':
      passed = deepEqualLoose(actual, expected);
      break;
    case 'not-equals':
    case 'notequals':
    case 'not_equal':
    case 'ne':
    case '!==':
      passed = !deepEqualLoose(actual, expected);
      break;
    case 'contains':
    case 'include':
    case 'includes':
      passed = valueContains(actual, expected);
      break;
    case 'exists':
      passed = actual !== undefined && actual !== null;
      break;
    case 'not-exists':
    case 'notexists':
      passed = actual === undefined || actual === null;
      break;
    case 'greater-than':
    case 'greaterthan':
    case 'gt':
    case '>':
      passed = Number(actual) > Number(expected);
      break;
    case 'greater-than-or-equal':
    case 'gte':
    case '>=':
      passed = Number(actual) >= Number(expected);
      break;
    case 'less-than':
    case 'lessthan':
    case 'lt':
    case '<':
      passed = Number(actual) < Number(expected);
      break;
    case 'less-than-or-equal':
    case 'lte':
    case '<=':
      passed = Number(actual) <= Number(expected);
      break;
    case 'matches':
    case 'match':
    case 'regex':
      passed = new RegExp(String(expected ?? '')).test(String(actual ?? ''));
      break;
    default:
      return { passed: false, message: `Unsupported assertion operator: ${operator}` };
  }
  return passed
    ? { passed }
    : { passed, message: `Expected ${formatLogValue(actual)} ${operator} ${formatLogValue(expected)}` };
}

function deepEqualLoose(actual: unknown, expected: unknown): boolean {
  const parsedExpected = parseExpectedValue(expected);
  if (typeof actual === 'number' || typeof actual === 'boolean' || actual === null) {
    return actual === parsedExpected || String(actual) === String(expected);
  }
  if (typeof parsedExpected === 'object') {
    return JSON.stringify(actual) === JSON.stringify(parsedExpected);
  }
  return String(actual) === String(parsedExpected);
}

function parseExpectedValue(expected: unknown): unknown {
  if (typeof expected !== 'string') return expected;
  const trimmed = expected.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return expected;
    }
  }
  return expected;
}

function valueContains(actual: unknown, expected: unknown): boolean {
  const parsedExpected = parseExpectedValue(expected);
  if (typeof actual === 'string') return actual.includes(String(parsedExpected));
  if (Array.isArray(actual)) return actual.some(item => deepEqualLoose(item, parsedExpected));
  if (isRecord(actual)) return Object.values(actual).some(value => deepEqualLoose(value, parsedExpected));
  return false;
}

function stringifyVariableValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value);
}

function errorToDiagnostic(error: unknown, phase: RuntimePhase, scriptType?: ScriptType): RuntimeErrorDiagnostic {
  return {
    phase,
    scriptType,
    message: errorMessage(error),
    stack: error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function descriptionToText(description: Assertion['description']): string | undefined {
  if (!description) return undefined;
  if (typeof description === 'string') return description;
  return description.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
