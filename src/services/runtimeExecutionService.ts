import * as vm from 'vm';
import { randomUUID } from 'crypto';
import type {
  Action,
  ActionPhase,
  ActionVariableScope,
  Assertion,
  GrpcMetadata,
  GrpcRequest,
  HttpRequest,
  HttpRequestBody,
  HttpRequestBodyVariant,
  HttpRequestHeader,
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
  WebSocketMessage,
  WebSocketMessageVariant,
  WebSocketRequest,
} from '../models/types';
import { varPatternGlobal } from '../models/varPattern';

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
  request: RuntimeCapableRequest;
  response?: HttpResponse;
  variables: RuntimeVariableScopes;
  result: RuntimeExecutionResult;
}

type RuntimeCapableRequest = HttpRequest | WebSocketRequest | GrpcRequest;
type RuntimeRequestHeader = HttpRequestHeader | GrpcMetadata;
interface RuntimeRequestConfig {
  variables?: Variable[];
  scripts?: Script[];
  assertions?: Assertion[];
  actions?: Action[];
}

export interface RuntimePreparedRequest<TRequest extends RuntimeCapableRequest> {
  request: TRequest;
  extraVariables?: Map<string, string>;
  runtime: RuntimeExecutionResult;
  state: RuntimeState;
}

export type RuntimePreparedHttpRequest = RuntimePreparedRequest<HttpRequest>;

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
    request: RuntimeCapableRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
  ): boolean {
    const runtime = runtimeConfig(request);
    return variablesToMap(runtime?.variables).size > 0
      || lifecycleScripts(collection.data.request?.scripts, folderDefaults?.scripts, runtime?.scripts, 'before-request').length > 0
      || lifecycleScripts(undefined, undefined, runtime?.scripts, 'after-response').length > 0
      || lifecycleScripts(undefined, undefined, runtime?.scripts, 'tests').length > 0
      || (runtime?.assertions ?? []).length > 0
      || (runtime?.actions ?? []).length > 0;
  }

  async buildRequestVariableOverrides(
    request: RuntimeCapableRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
  ): Promise<Map<string, string> | undefined> {
    const baseVariables = this._variableResolver
      ? await this._variableResolver(collection, folderDefaults, environmentName)
      : new Map<string, string>();
    const requestVariables = resolveVariableMapValues(
      variablesToMap(runtimeConfig(request)?.variables),
      baseVariables,
      extraVariables,
    );
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
    return this._prepareRequest(request, collection, folderDefaults, extraVariables, environmentName);
  }

  async prepareWebSocketRequest(
    request: WebSocketRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
  ): Promise<RuntimePreparedRequest<WebSocketRequest>> {
    return this._prepareRequest(request, collection, folderDefaults, extraVariables, environmentName);
  }

  async prepareGrpcRequest(
    request: GrpcRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
  ): Promise<RuntimePreparedRequest<GrpcRequest>> {
    return this._prepareRequest(request, collection, folderDefaults, extraVariables, environmentName);
  }

  async completeHttpRequest(
    prepared: RuntimePreparedHttpRequest,
    response: HttpResponse,
  ): Promise<HttpResponse> {
    return this._completeRequest(prepared, response);
  }

  async completeWebSocketRequest(
    prepared: RuntimePreparedRequest<WebSocketRequest>,
    response: HttpResponse,
  ): Promise<HttpResponse> {
    return this._completeRequest(prepared, response);
  }

  async completeGrpcRequest(
    prepared: RuntimePreparedRequest<GrpcRequest>,
    response: HttpResponse,
  ): Promise<HttpResponse> {
    return this._completeRequest(prepared, response);
  }

  private async _prepareRequest<TRequest extends RuntimeCapableRequest>(
    request: TRequest,
    collection: MissioCollection,
    folderDefaults?: RequestDefaults,
    extraVariables?: Map<string, string>,
    environmentName?: string,
  ): Promise<RuntimePreparedRequest<TRequest>> {
    const clonedRequest = cloneJson(request);
    const runtime = runtimeConfig(clonedRequest);
    const result = createRuntimeResult();
    const baseVariables = this._variableResolver
      ? await this._variableResolver(collection, folderDefaults, environmentName)
      : new Map<string, string>();
    const requestVariables = resolveVariableMapValues(
      variablesToMap(runtime?.variables),
      baseVariables,
      extraVariables,
    );
    const variables: RuntimeVariableScopes = {
      base: new Map(baseVariables),
      request: requestVariables,
      runtime: new Map(extraVariables),
    };
    const state: RuntimeState = { request: clonedRequest, variables, result };

    await this._runScripts(state, lifecycleScripts(collection.data.request?.scripts, folderDefaults?.scripts, runtime?.scripts, 'before-request'), 'before-request', true);
    this._runActions(state, 'before-request');

    return {
      request: clonedRequest,
      extraVariables: this._buildExecutionVariables(variables),
      runtime: result,
      state,
    };
  }

  private async _completeRequest<TRequest extends RuntimeCapableRequest>(
    prepared: RuntimePreparedRequest<TRequest>,
    response: HttpResponse,
  ): Promise<HttpResponse> {
    const runtime = runtimeConfig(prepared.state.request);
    prepared.state.response = response;
    this._runActions(prepared.state, 'after-response');
    await this._runScripts(prepared.state, lifecycleScripts(undefined, undefined, runtime?.scripts, 'after-response'), 'after-response', false);
    this._runAssertions(prepared.state, runtime?.assertions ?? []);
    await this._runScripts(prepared.state, lifecycleScripts(undefined, undefined, runtime?.scripts, 'tests'), 'tests', false);
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
    const templateNames = [...new Set(
      [...script.code.matchAll(varPatternGlobal())].map(match => match[1].trim()),
    )].sort();
    if (templateNames.length > 0) {
      throw new Error(
        `Runtime script source interpolation is not supported (${templateNames.map(name => `{{${name}}}`).join(', ')}). `
        + 'Read variables as data with missio.variables.get("name").',
      );
    }
    const sandbox = this._createSandbox(state, phase);
    const context = vm.createContext(sandbox, {
      name: 'missio-runtime',
      codeGeneration: { strings: false, wasm: false },
    });
    const compiled = new vm.Script(script.code, { filename: `missio-${script.type}.js` });
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
      const visibleVariables = buildVisibleVariables(state.variables);
      const expression = interpolateRuntimeTemplate(assertion.expression, visibleVariables);
      const authoredExpected = assertion.value === undefined ? undefined : String(assertion.value);
      const expected = authoredExpected === undefined
        ? undefined
        : interpolateRuntimeTemplate(authoredExpected, visibleVariables);
      const description = interpolateOptionalTemplate(descriptionToText(assertion.description), visibleVariables);
      if (assertion.disabled) {
        state.result.assertions.push({
          expression,
          operator: assertion.operator,
          expected,
          actual: undefined,
          passed: true,
          skipped: true,
          description,
        });
        continue;
      }

      const unresolved = unresolvedTemplateNames(
        visibleVariables,
        assertion.expression,
        authoredExpected,
      );
      if (unresolved.length > 0) {
        state.result.assertions.push({
          expression,
          operator: assertion.operator,
          expected,
          actual: undefined,
          passed: false,
          description,
          message: unresolvedAssertionMessage(unresolved),
        });
        continue;
      }

      const actual = evaluateExpression(expression, state);
      const comparison = compareValues(actual, expected, assertion.operator);
      state.result.assertions.push({
        expression,
        operator: assertion.operator,
        expected,
        actual,
        passed: comparison.passed,
        description,
        message: comparison.message,
      });
    }
  }

  private _runActions(state: RuntimeState, phase: ActionPhase): void {
    const actions = runtimeConfig(state.request)?.actions ?? [];
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

    if (!isSupportedVariableMutationScope(action.variable.scope)) {
      return {
        type: action.type,
        phase,
        passed: false,
        target: `${action.variable.scope}.${action.variable.name}`,
        message: unsupportedVariableScopeMessage(action.variable.scope),
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
  ].filter(script => !script.disabled && script.type === type);
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function runtimeConfig(request: RuntimeCapableRequest): RuntimeRequestConfig | undefined {
  return (request as { runtime?: RuntimeRequestConfig }).runtime;
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

function resolveVariableMapValues(
  variables: Map<string, string>,
  baseVariables: Map<string, string>,
  extraVariables?: Map<string, string>,
): Map<string, string> {
  const resolved = new Map(variables);
  const maxPasses = Math.max(1, variables.size + 1);
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const visible = new Map(baseVariables);
    mergeInto(visible, resolved);
    if (extraVariables) mergeInto(visible, extraVariables);

    for (const [key, value] of resolved) {
      const next = value.replace(varPatternGlobal(), (match, name) => {
        const ref = String(name).trim();
        const builtin = resolveRuntimeBuiltin(ref);
        if (builtin !== undefined) return builtin;
        if (ref === key) {
          if (extraVariables?.has(ref)) return extraVariables.get(ref)!;
          if (baseVariables.has(ref)) return baseVariables.get(ref)!;
          return match;
        }
        return visible.has(ref) ? visible.get(ref)! : match;
      });
      if (next !== value) {
        resolved.set(key, next);
        changed = true;
      }
    }

    if (!changed) break;
  }
  const cyclicNames = new Set<string>();
  for (const [key, value] of resolved) {
    const re = varPatternGlobal();
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
      const ref = match[1].trim();
      if (variables.has(ref)) {
        cyclicNames.add(key);
        cyclicNames.add(ref);
      }
    }
  }
  if (cyclicNames.size > 0) {
    throw new Error(`Cyclic runtime variable reference: ${[...cyclicNames].sort().join(', ')}`);
  }
  return resolved;
}

function interpolateRuntimeTemplate(template: string, variables: Map<string, string>): string {
  return template.replace(varPatternGlobal(), (match, name) => {
    const key = String(name).trim();
    const builtin = resolveRuntimeBuiltin(key);
    if (builtin !== undefined) return builtin;
    return variables.has(key) ? variables.get(key)! : match;
  });
}

function interpolateOptionalTemplate(template: string | undefined, variables: Map<string, string>): string | undefined {
  return template === undefined ? undefined : interpolateRuntimeTemplate(template, variables);
}

function unresolvedTemplateNames(
  variables: Map<string, string>,
  ...values: Array<string | undefined>
): string[] {
  const names = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const re = varPatternGlobal();
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
      const name = match[1].trim();
      if (!variables.has(name) && !isRuntimeBuiltin(name)) names.add(name);
    }
  }
  return [...names];
}

function isRuntimeBuiltin(name: string): boolean {
  return name === '$guid' || name === '$timestamp' || name === '$randomInt';
}

function unresolvedAssertionMessage(names: string[]): string {
  const label = names.length === 1 ? 'variable' : 'variables';
  return `Unresolved assertion ${label}: ${names.map(name => `{{${name}}}`).join(', ')}`;
}

function resolveRuntimeBuiltin(name: string): string | undefined {
  // Resolve each textual occurrence independently to match Postman dynamic-variable semantics.
  switch (name) {
    case '$guid': return randomUUID();
    case '$timestamp': return String(Math.floor(Date.now() / 1000));
    case '$randomInt': return String(Math.floor(Math.random() * 1001));
    default: return undefined;
  }
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
      else if (scope === 'runtime') state.variables.runtime.delete(String(name));
      else throw new Error(unsupportedVariableScopeMessage(scope));
    },
    toObject: () => Object.fromEntries(buildVisibleVariables(state.variables)),
  });
}

function makeRequestApi(state: RuntimeState): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  Object.defineProperties(api, {
    protocol: {
      enumerable: true,
      get: () => getRuntimeRequestProtocol(state.request),
    },
    method: {
      enumerable: true,
      get: () => getRuntimeRequestMethod(state.request),
      set: (value: unknown) => {
        setRuntimeRequestMethod(state.request, value);
      },
    },
    url: {
      enumerable: true,
      get: () => getRuntimeRequestUrl(state.request),
      set: (value: unknown) => {
        setRuntimeRequestUrl(state.request, value);
      },
    },
    body: {
      enumerable: true,
      get: () => getRuntimeRequestBodyValue(state.request),
      set: (value: unknown) => setRuntimeRequestBodyValue(state.request, value),
    },
    message: {
      enumerable: true,
      get: () => getRuntimeRequestBodyValue(state.request),
      set: (value: unknown) => setRuntimeRequestBodyValue(state.request, value),
    },
  });

  const headerApi = makeHeaderApi(
    () => getRuntimeRequestHeaders(state.request),
    (headers) => setRuntimeRequestHeaders(state.request, headers),
  );
  api.headers = headerApi;
  api.metadata = headerApi;
  api.setHeader = (name: string, value: unknown) => setRuntimeRequestHeader(state.request, name, value);
  api.getHeader = (name: string) => getRuntimeRequestHeader(state.request, name);
  api.setMetadata = (name: string, value: unknown) => setRuntimeRequestHeader(state.request, name, value);
  api.getMetadata = (name: string) => getRuntimeRequestHeader(state.request, name);
  api.setBody = (value: unknown) => setRuntimeRequestBodyValue(state.request, value);
  api.json = () => parseMaybeJson(getRuntimeRequestBodyValue(state.request));
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
  const headersApi = Object.freeze({
    get: (name: string) => getResponseHeader(state.response, name),
    toObject: () => ({ ...(state.response?.headers ?? {}) }),
  });
  api.headers = headersApi;
  api.metadata = headersApi;
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
  getHeaders: () => RuntimeRequestHeader[],
  setHeaders: (headers: RuntimeRequestHeader[]) => void,
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

function setRuntimeRequestHeader(request: RuntimeCapableRequest, name: string, value: unknown): void {
  const headers = [...getRuntimeRequestHeaders(request)];
  const index = headers.findIndex(header => header.name.toLowerCase() === String(name).toLowerCase());
  const next = { name: String(name), value: stringifyVariableValue(value) };
  if (index >= 0) headers[index] = { ...headers[index], ...next };
  else headers.push(next);
  setRuntimeRequestHeaders(request, headers);
}

function getRuntimeRequestHeader(request: RuntimeCapableRequest, name: string): string | undefined {
  return getRuntimeRequestHeaders(request).find(header => !header.disabled && header.name.toLowerCase() === String(name).toLowerCase())?.value;
}

function getResponseHeader(response: HttpResponse | undefined, name: string): string | undefined {
  if (!response) return undefined;
  const found = Object.entries(response.headers).find(([key]) => key.toLowerCase() === String(name).toLowerCase());
  return found?.[1];
}

function isRuntimeWebSocketRequest(request: RuntimeCapableRequest): request is WebSocketRequest {
  return Object.prototype.hasOwnProperty.call(request, 'websocket');
}

function isRuntimeGrpcRequest(request: RuntimeCapableRequest): request is GrpcRequest {
  return Object.prototype.hasOwnProperty.call(request, 'grpc');
}

function getRuntimeRequestProtocol(request: RuntimeCapableRequest): string {
  if (isRuntimeWebSocketRequest(request)) return 'websocket';
  if (isRuntimeGrpcRequest(request)) return 'grpc';
  return 'http';
}

function getRuntimeRequestMethod(request: RuntimeCapableRequest): string | undefined {
  if (isRuntimeWebSocketRequest(request)) return 'WS';
  if (isRuntimeGrpcRequest(request)) return request.grpc?.method;
  return (request as HttpRequest).http?.method;
}

function setRuntimeRequestMethod(request: RuntimeCapableRequest, value: unknown): void {
  if (isRuntimeGrpcRequest(request)) {
    if (!request.grpc) request.grpc = {};
    request.grpc.method = String(value);
    return;
  }
  if (isRuntimeWebSocketRequest(request)) {
    return;
  }
  const httpRequest = request as HttpRequest;
  if (!httpRequest.http) httpRequest.http = {};
  httpRequest.http.method = String(value);
}

function getRuntimeRequestUrl(request: RuntimeCapableRequest): string | undefined {
  if (isRuntimeWebSocketRequest(request)) return request.websocket?.url;
  if (isRuntimeGrpcRequest(request)) return request.grpc?.url;
  return (request as HttpRequest).http?.url;
}

function setRuntimeRequestUrl(request: RuntimeCapableRequest, value: unknown): void {
  if (isRuntimeWebSocketRequest(request)) {
    if (!request.websocket) request.websocket = {};
    request.websocket.url = String(value);
    return;
  }
  if (isRuntimeGrpcRequest(request)) {
    if (!request.grpc) request.grpc = {};
    request.grpc.url = String(value);
    return;
  }
  const httpRequest = request as HttpRequest;
  if (!httpRequest.http) httpRequest.http = {};
  httpRequest.http.url = String(value);
}

function getRuntimeRequestHeaders(request: RuntimeCapableRequest): RuntimeRequestHeader[] {
  if (isRuntimeWebSocketRequest(request)) return request.websocket?.headers ?? [];
  if (isRuntimeGrpcRequest(request)) return request.grpc?.metadata ?? [];
  return (request as HttpRequest).http?.headers ?? [];
}

function setRuntimeRequestHeaders(request: RuntimeCapableRequest, headers: RuntimeRequestHeader[]): void {
  if (isRuntimeWebSocketRequest(request)) {
    if (!request.websocket) request.websocket = {};
    request.websocket.headers = headers as HttpRequestHeader[];
    return;
  }
  if (isRuntimeGrpcRequest(request)) {
    if (!request.grpc) request.grpc = {};
    request.grpc.metadata = headers as GrpcMetadata[];
    return;
  }
  const httpRequest = request as HttpRequest;
  if (!httpRequest.http) httpRequest.http = {};
  httpRequest.http.headers = headers as HttpRequestHeader[];
}

function getRuntimeRequestBodyValue(request: RuntimeCapableRequest): unknown {
  if (isRuntimeWebSocketRequest(request)) {
    const message = selectedWebSocketMessage(request.websocket?.message);
    if (!message) return undefined;
    return message.type === 'json' ? parseMaybeJson(message.data) : message.data;
  }
  if (isRuntimeGrpcRequest(request)) {
    return parseMaybeJson(selectedGrpcMessage(request.grpc?.message) ?? '{}');
  }

  const httpRequest = request as HttpRequest;
  const body = selectedHttpBody(httpRequest.http?.body);
  if (!body) return undefined;
  if (body.type === 'json') return parseMaybeJson(body.data);
  if (body.type === 'text' || body.type === 'xml' || body.type === 'html' || body.type === 'yaml' || body.type === 'sparql') return body.data;
  return cloneJson(body);
}

function setRuntimeRequestBodyValue(request: RuntimeCapableRequest, value: unknown): void {
  if (isRuntimeWebSocketRequest(request)) {
    setWebSocketMessageValue(request, value);
    return;
  }
  if (isRuntimeGrpcRequest(request)) {
    setGrpcMessageValue(request, value);
    return;
  }

  const httpRequest = request as HttpRequest;
  if (!httpRequest.http) httpRequest.http = {};
  const body = selectedHttpBody(httpRequest.http.body);
  const nextType = typeof value === 'object' ? 'json' : body?.type ?? 'text';
  const nextData = typeof value === 'string' ? value : JSON.stringify(value);

  if (!body) {
    httpRequest.http.body = { type: nextType, data: nextData } as HttpRequestBody;
    return;
  }

  body.type = nextType as HttpRequestBody['type'];
  (body as { data?: unknown }).data = nextData;
}

function selectedHttpBody(body: NonNullable<HttpRequest['http']>['body'] | undefined): HttpRequestBody | undefined {
  if (!body) return undefined;
  if (Array.isArray(body)) {
    const variants = body as HttpRequestBodyVariant[];
    return (variants.find(variant => variant.selected) ?? variants[0])?.body;
  }
  return body as HttpRequestBody;
}

function selectedWebSocketMessage(message: NonNullable<WebSocketRequest['websocket']>['message']): WebSocketMessage | undefined {
  if (!message) return undefined;
  if (!Array.isArray(message)) return message;
  const selected = message.find(variant => variant.selected) ?? message[0];
  return selected?.message;
}

function setWebSocketMessageValue(request: WebSocketRequest, value: unknown): void {
  if (!request.websocket) request.websocket = {};
  const existing = selectedWebSocketMessage(request.websocket.message);
  const nextType = typeof value === 'object' && value !== null ? 'json' : existing?.type ?? 'text';
  const nextData = typeof value === 'string' ? value : JSON.stringify(value);
  const nextMessage: WebSocketMessage = { type: nextType, data: nextData };

  if (!request.websocket.message) {
    request.websocket.message = nextMessage;
    return;
  }
  if (Array.isArray(request.websocket.message)) {
    const variants = request.websocket.message as WebSocketMessageVariant[];
    const selected = variants.find(variant => variant.selected) ?? variants[0];
    if (selected) selected.message = nextMessage;
    else request.websocket.message = nextMessage;
    return;
  }
  request.websocket.message = nextMessage;
}

function selectedGrpcMessage(message: NonNullable<GrpcRequest['grpc']>['message']): string | undefined {
  if (!message) return undefined;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    const selected = message.find(variant => isRecord(variant) && variant.selected === true) ?? message[0];
    return isRecord(selected) && typeof selected.message === 'string' ? selected.message : undefined;
  }
  return undefined;
}

function setGrpcMessageValue(request: GrpcRequest, value: unknown): void {
  if (!request.grpc) request.grpc = {};
  const nextMessage = typeof value === 'string' ? value : JSON.stringify(value);
  const current = request.grpc.message as unknown;
  if (Array.isArray(current)) {
    const selected = current.find(variant => isRecord(variant) && variant.selected === true) ?? current[0];
    if (isRecord(selected) && typeof selected.message === 'string') {
      selected.message = nextMessage;
      return;
    }
  }
  request.grpc.message = nextMessage;
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
  const key = String(name);
  return resolveRuntimeBuiltin(key) ?? buildVisibleVariables(state.variables).get(key);
}

function setRuntimeVariable(
  state: RuntimeState,
  scope: ActionVariableScope,
  name: string,
  value: string,
  source: RuntimeVariableMutation['source'],
): void {
  if (scope === 'request') state.variables.request.set(name, value);
  else if (scope === 'runtime') state.variables.runtime.set(name, value);
  else throw new Error(unsupportedVariableScopeMessage(scope));
  state.result.variableMutations.push({ scope, name, value, source });
}

function isSupportedVariableMutationScope(scope: ActionVariableScope): boolean {
  return scope === 'runtime' || scope === 'request';
}

function unsupportedVariableScopeMessage(scope: ActionVariableScope): string {
  return `Unsupported variable scope: ${String(scope)}. Missio currently supports runtime and request set-variable scopes.`;
}

function evaluateJsonSelector(expression: string, state: RuntimeState): unknown {
  const root = state.response
    ? parseMaybeJson(state.response.body)
    : parseMaybeJson(getRuntimeRequestBodyValue(state.request));
  return getPathValue(root, normalizeSelectorExpression(expression));
}

function evaluateExpression(expression: string, state: RuntimeState): unknown {
  const trimmed = expression.trim();
  const responseBody = state.response ? parseMaybeJson(state.response.body) : undefined;
  const requestBody = parseMaybeJson(getRuntimeRequestBodyValue(state.request));
  const requestHeaders = Object.fromEntries(
    getRuntimeRequestHeaders(state.request)
      .filter(h => !h.disabled)
      .map(h => [h.name.toLowerCase(), h.value]),
  );
  const requestMethod = getRuntimeRequestMethod(state.request);
  const requestUrl = getRuntimeRequestUrl(state.request);

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
      protocol: getRuntimeRequestProtocol(state.request),
      method: requestMethod,
      url: requestUrl,
      headers: requestHeaders,
      metadata: requestHeaders,
      body: requestBody,
    },
    request: {
      protocol: getRuntimeRequestProtocol(state.request),
      method: requestMethod,
      url: requestUrl,
      headers: requestHeaders,
      metadata: requestHeaders,
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
