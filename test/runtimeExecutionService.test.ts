import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/services/httpClient';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import { RuntimeExecutionError, RuntimeExecutionService } from '../src/services/runtimeExecutionService';
import { detectUnresolvedVars } from '../src/services/unresolvedVars';
import type { GraphQLRequest, GrpcRequest, HttpRequest, HttpResponse, MissioCollection, WebSocketRequest } from '../src/models/types';

function interpolate(template: string, variables: Map<string, string>): string {
  return template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, name) => variables.get(name) ?? match);
}

function makeEnvService(baseVariables = new Map<string, string>()) {
  return {
    resolveVariables: async () => new Map(baseVariables),
    interpolate,
    interpolateJson: (template: string, variables: Map<string, string>) => {
      return template.replace(/"(\{\{\s*[\w.$-]+\s*\}\})"/g, (match, placeholder) => {
        const name = placeholder.match(/\{\{\s*([\w.$-]+)\s*\}\}/)?.[1];
        const value = name ? variables.get(name) : undefined;
        if (value === undefined) return match;
        if (/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?)$/.test(value)) return value;
        return JSON.stringify(value);
      }).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, name) => variables.get(name) ?? match);
    },
  } as any;
}

function makeCollection(rootDir = os.tmpdir()): MissioCollection {
  return {
    id: 'runtime-collection',
    filePath: path.join(rootDir, 'opencollection.yml'),
    rootDir,
    data: {
      opencollection: '1.0.0',
      info: { name: 'Runtime Test' },
      request: {},
      config: { environments: [] },
    },
  } as MissioCollection;
}

function makeResponse(body: unknown, status = 200): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
    body: text,
    duration: 5,
    size: Buffer.byteLength(text),
  };
}

describe('RuntimeExecutionService lifecycle', () => {
  it('runs before scripts, after actions, assertions, tests, logs, and variable mutations', async () => {
    const service = new RuntimeExecutionService(async () => new Map([['baseVar', 'base']]));
    const request: HttpRequest = {
      http: {
        method: 'POST',
        url: 'http://127.0.0.1/runtime',
        body: { type: 'json', data: '{"from":"{{capturedToken}}"}' },
      },
      runtime: {
        variables: [{ name: 'requestVar', value: 'request-value' }],
        scripts: [
          {
            type: 'before-request',
            code: [
              'missio.request.setHeader("X-Script", variables.get("requestVar"));',
              'variables.set("capturedToken", "script-token");',
              'console.log("before", variables.get("baseVar"));',
            ].join('\n'),
          },
          {
            type: 'after-response',
            code: 'console.info("after", response.json().token);',
          },
          {
            type: 'tests',
            code: [
              'test("token is visible", () => assert(response.json().token === "abc123"));',
              'pm.test("Postman style status", () => pm.expect(pm.response.code).to.eql(200));',
            ].join('\n'),
          },
        ],
        assertions: [
          { expression: 'res.status', operator: 'equals', value: '200' },
          { expression: 'res.body.ok', operator: 'equals', value: 'true' },
        ],
        actions: [
          {
            type: 'set-variable',
            phase: 'after-response',
            selector: { method: 'jsonq', expression: '$.token' },
            variable: { scope: 'runtime', name: 'responseToken' },
          },
        ],
      },
    };

    const prepared = await service.prepareHttpRequest(request, makeCollection());

    expect(prepared.request.http?.headers?.find(header => header.name === 'X-Script')?.value).toBe('request-value');
    expect(prepared.extraVariables?.get('capturedToken')).toBe('script-token');

    const response = await service.completeHttpRequest(prepared, makeResponse({ ok: true, token: 'abc123' }));

    expect(response.runtime?.success).toBe(true);
    expect(response.runtime?.summary).toEqual({ passed: 5, failed: 0, skipped: 0 });
    expect(response.runtime?.tests.map(test => test.name)).toEqual(['token is visible', 'Postman style status']);
    expect(response.runtime?.assertions.every(assertion => assertion.passed)).toBe(true);
    expect(response.runtime?.actions[0]).toMatchObject({ passed: true, target: 'runtime.responseToken', value: 'abc123' });
    expect(response.runtime?.variableMutations).toEqual([
      { scope: 'runtime', name: 'capturedToken', value: 'script-token', source: 'script' },
      { scope: 'runtime', name: 'responseToken', value: 'abc123', source: 'action' },
    ]);
    expect(response.runtime?.logs.map(log => log.message)).toEqual(['before base', 'after abc123']);
  });

  it('interpolates runtime assertion expression, expected value, and description across runtime protocols', async () => {
    const service = new RuntimeExecutionService(async () => new Map([
      ['fieldName', 'name'],
      ['descriptionOwner', 'Ada'],
    ]));
    const runtime = () => ({
      variables: [{ name: 'assertionField', value: '{{fieldName}}' }],
      scripts: [{
        type: 'after-response' as const,
        code: 'missio.variables.set("expectedName", response.json().name);',
      }],
      assertions: [{
        expression: 'res.body.{{assertionField}}',
        operator: 'equals',
        value: '{{expectedName}}',
        description: 'Owner {{descriptionOwner}}',
      }],
    });
    const cases = [
      {
        request: { http: { method: 'GET', url: 'http://127.0.0.1/runtime' }, runtime: runtime() } as HttpRequest,
        prepare: (request: HttpRequest) => service.prepareHttpRequest(request, makeCollection()),
        complete: (prepared: any, response: HttpResponse) => service.completeHttpRequest(prepared, response),
      },
      {
        request: { websocket: { url: 'ws://127.0.0.1/socket', message: { type: 'text', data: 'ping' } }, runtime: runtime() } as WebSocketRequest,
        prepare: (request: WebSocketRequest) => service.prepareWebSocketRequest(request, makeCollection()),
        complete: (prepared: any, response: HttpResponse) => service.completeWebSocketRequest(prepared, response),
      },
      {
        request: { grpc: { url: '127.0.0.1:50051', method: 'demo.Service/Get', message: '{}' }, runtime: runtime() } as GrpcRequest,
        prepare: (request: GrpcRequest) => service.prepareGrpcRequest(request, makeCollection()),
        complete: (prepared: any, response: HttpResponse) => service.completeGrpcRequest(prepared, response),
      },
    ];

    for (const testCase of cases) {
      const prepared = await testCase.prepare(testCase.request as never);
      const response = await testCase.complete(prepared, makeResponse({ name: 'Ada' }));

      expect(response.runtime?.success).toBe(true);
      expect(response.runtime?.assertions[0]).toMatchObject({
        expression: 'res.body.name',
        expected: 'Ada',
        actual: 'Ada',
        description: 'Owner Ada',
        passed: true,
      });
    }
  });

  it('reports unresolved runtime assertion variables deterministically', async () => {
    const service = new RuntimeExecutionService(async () => new Map());
    const request: HttpRequest = {
      http: { method: 'GET', url: 'http://127.0.0.1/runtime' },
      runtime: {
        assertions: [{
          expression: 'res.body.{{missingField}}',
          operator: 'equals',
          value: '{{missingExpected}}',
          description: 'Needs {{missingDescription}}',
        }],
      },
    };

    const prepared = await service.prepareHttpRequest(request, makeCollection());
    const response = await service.completeHttpRequest(prepared, makeResponse({ name: 'Ada' }));

    expect(response.runtime?.success).toBe(false);
    expect(response.runtime?.assertions[0]).toMatchObject({
      passed: false,
      expression: 'res.body.{{missingField}}',
      expected: '{{missingExpected}}',
      description: 'Needs {{missingDescription}}',
      message: 'Unresolved assertion variables: {{missingField}}, {{missingExpected}}, {{missingDescription}}',
    });
  });

  it('evaluates runtime variable values and interpolates script source before execution', async () => {
    const service = new RuntimeExecutionService(async () => new Map([
      ['owner', 'Ada'],
      ['headerSeed', 'scripted'],
    ]));
    const request: HttpRequest = {
      http: {
        method: 'POST',
        url: 'http://127.0.0.1/runtime',
      },
      runtime: {
        variables: [
          { name: 'requestHeader', value: '{{headerSeed}}' },
          { name: 'runtimeOwner', value: '{{owner}} Runtime' },
          { name: 'combined', value: '{{runtimeOwner}}/{{requestHeader}}' },
          { name: 'unresolved', value: '{{missingToken}}' },
        ],
        scripts: [
          {
            type: 'before-request',
            code: [
              'missio.request.setHeader("X-Combined", "{{combined}}");',
              'missio.request.setHeader("X-Unresolved", "{{unresolved}}");',
              'missio.variables.set("lateHeader", "late-{{requestHeader}}");',
            ].join('\n'),
          },
          {
            type: 'before-request',
            code: 'missio.request.setHeader("X-Late", "{{lateHeader}}");',
          },
        ],
      },
    };

    const prepared = await service.prepareHttpRequest(request, makeCollection());

    expect(prepared.request.http?.headers?.find(header => header.name === 'X-Combined')?.value)
      .toBe('Ada Runtime/scripted');
    expect(prepared.request.http?.headers?.find(header => header.name === 'X-Late')?.value)
      .toBe('late-scripted');
    expect(prepared.request.http?.headers?.find(header => header.name === 'X-Unresolved')?.value)
      .toBe('{{missingToken}}');
    expect(prepared.extraVariables?.get('combined')).toBe('Ada Runtime/scripted');
    expect(prepared.extraVariables?.get('unresolved')).toBe('{{missingToken}}');
    expect(prepared.runtime.variableMutations).toEqual([
      { scope: 'runtime', name: 'lateHeader', value: 'late-scripted', source: 'script' },
    ]);
  });

  it('keeps interpolated script source inside the runtime sandbox', async () => {
    const service = new RuntimeExecutionService(async () => new Map([
      ['unsafeScript', 'require("fs").readFileSync("package.json", "utf8");'],
    ]));
    const request: HttpRequest = {
      http: { method: 'GET', url: 'http://127.0.0.1/runtime' },
      runtime: {
        scripts: [{ type: 'before-request', code: '{{unsafeScript}}' }],
      },
    };

    await expect(service.prepareHttpRequest(request, makeCollection()))
      .rejects.toBeInstanceOf(RuntimeExecutionError);

    try {
      await service.prepareHttpRequest(request, makeCollection());
    } catch (error) {
      expect((error as RuntimeExecutionError).runtime.errors[0].message).toMatch(/require is not defined/);
    }
  });

  it('blocks filesystem and process access from before-request scripts', async () => {
    const service = new RuntimeExecutionService();
    const request: HttpRequest = {
      http: { method: 'GET', url: 'http://127.0.0.1/runtime' },
      runtime: {
        scripts: [{ type: 'before-request', code: 'require("fs").readFileSync("package.json", "utf8");' }],
      },
    };

    await expect(service.prepareHttpRequest(request, makeCollection()))
      .rejects.toBeInstanceOf(RuntimeExecutionError);

    try {
      await service.prepareHttpRequest(request, makeCollection());
    } catch (error) {
      expect((error as RuntimeExecutionError).runtime.errors[0].message).toMatch(/require is not defined/);
    }
  });

  it('records sandbox boundary failures inside test scripts', async () => {
    const service = new RuntimeExecutionService();
    const request: HttpRequest = {
      http: { method: 'GET', url: 'http://127.0.0.1/runtime' },
      runtime: {
        scripts: [{
          type: 'tests',
          code: [
            'test("process is absent", () => assert(typeof process === "undefined"));',
            'test("Function constructor is blocked", () => Function("return process")());',
          ].join('\n'),
        }],
      },
    };

    const prepared = await service.prepareHttpRequest(request, makeCollection());
    const response = await service.completeHttpRequest(prepared, makeResponse({ ok: true }));

    expect(response.runtime?.success).toBe(false);
    expect(response.runtime?.tests).toHaveLength(2);
    expect(response.runtime?.tests[0]).toMatchObject({ name: 'process is absent', passed: true });
    expect(response.runtime?.tests[1].passed).toBe(false);
    expect(response.runtime?.tests[1].message).toMatch(/Code generation from strings disallowed/);
  });

  it('skips disabled runtime scripts without deleting them from authored requests', async () => {
    const service = new RuntimeExecutionService();
    const request: HttpRequest = {
      http: { method: 'GET', url: 'http://127.0.0.1/runtime' },
      runtime: {
        scripts: [
          {
            type: 'before-request',
            disabled: true,
            code: 'missio.request.setHeader("X-Disabled-Script", "ran");',
          },
          {
            type: 'tests',
            disabled: true,
            code: 'test("disabled test", () => assert(false));',
          },
          {
            type: 'tests',
            code: 'test("enabled test", () => assert(response.status === 200));',
          },
        ],
      },
    };

    const prepared = await service.prepareHttpRequest(request, makeCollection());
    expect(prepared.request.runtime?.scripts).toEqual(request.runtime?.scripts);
    expect(prepared.request.http?.headers?.find(header => header.name === 'X-Disabled-Script')).toBeUndefined();

    const response = await service.completeHttpRequest(prepared, makeResponse({ ok: true }));

    expect(response.runtime?.success).toBe(true);
    expect(response.runtime?.tests.map(test => test.name)).toEqual(['enabled test']);
  });

  it('records assertion and action failure diagnostics without hiding the response', async () => {
    const service = new RuntimeExecutionService();
    const request: HttpRequest = {
      http: { method: 'GET', url: 'http://127.0.0.1/runtime' },
      runtime: {
        assertions: [
          { expression: 'res.body.ok', operator: 'equals', value: 'true' },
          { expression: 'res.body.count', operator: 'greater-than', value: '5' },
        ],
        actions: [{
          type: 'set-variable',
          selector: { method: 'jsonq', expression: '$.missing' },
          variable: { scope: 'runtime', name: 'missing' },
        }],
      },
    };

    const prepared = await service.prepareHttpRequest(request, makeCollection());
    const response = await service.completeHttpRequest(prepared, makeResponse({ ok: false, count: 2 }));

    expect(response.status).toBe(200);
    expect(response.runtime?.success).toBe(false);
    expect(response.runtime?.assertions.map(assertion => assertion.passed)).toEqual([false, false]);
    expect(response.runtime?.actions[0]).toMatchObject({ passed: false, message: 'Selector did not resolve: $.missing' });
  });

  it('diagnoses unsupported set-variable action scopes instead of mutating runtime variables', async () => {
    const service = new RuntimeExecutionService();
    const request: HttpRequest = {
      http: { method: 'GET', url: 'http://127.0.0.1/runtime' },
      runtime: {
        actions: [{
          type: 'set-variable',
          selector: { method: 'jsonq', expression: '$.token' },
          variable: { scope: 'environment', name: 'token' },
        }],
      },
    };

    const prepared = await service.prepareHttpRequest(request, makeCollection());
    const response = await service.completeHttpRequest(prepared, makeResponse({ token: 'abc123' }));

    expect(response.runtime?.success).toBe(false);
    expect(response.runtime?.actions[0]).toMatchObject({
      passed: false,
      target: 'environment.token',
      message: 'Unsupported variable scope: environment. Missio currently supports runtime and request set-variable scopes.',
    });
    expect(response.runtime?.variableMutations).toEqual([]);
  });
});

describe('RequestExecutionService runtime integration', () => {
  it('mutates the HTTP request before send and surfaces runtime results after response', async () => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        const payload = {
          scriptedHeader: req.headers['x-runtime-script'],
          body: JSON.parse(text),
          token: 'fixture-token',
        };
        const body = JSON.stringify(payload);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');

    try {
      const envService = makeEnvService();
      const httpClient = new HttpClient(envService);
      const runtime = new RuntimeExecutionService(async () => new Map());
      const executionService = new RequestExecutionService(httpClient, undefined, undefined, runtime);
      const request: HttpRequest = {
        http: {
          method: 'POST',
          url: `http://127.0.0.1:${address.port}/runtime`,
          body: { type: 'json', data: '{"value":"{{runtimeValue}}"}' },
        },
        runtime: {
          scripts: [
            {
              type: 'before-request',
              code: [
                'missio.request.setHeader("X-Runtime-Script", "yes");',
                'missio.variables.set("runtimeValue", "from-script");',
              ].join('\n'),
            },
            {
              type: 'tests',
              code: 'test("server saw script header", () => assert(response.json().scriptedHeader === "yes"));',
            },
          ],
          assertions: [
            { expression: 'res.body.body.value', operator: 'equals', value: 'from-script' },
          ],
          actions: [
            {
              type: 'set-variable',
              selector: { method: 'jsonq', expression: '$.token' },
              variable: { scope: 'runtime', name: 'fixtureToken' },
            },
          ],
        },
      };

      const response = await executionService.send(request, makeCollection());

      expect(JSON.parse(response.body)).toMatchObject({
        scriptedHeader: 'yes',
        body: { value: 'from-script' },
      });
      expect(response.runtime?.success).toBe(true);
      expect(response.runtime?.tests[0]).toMatchObject({ passed: true });
      expect(response.runtime?.variableMutations.map(mutation => mutation.name)).toEqual(['runtimeValue', 'fixtureToken']);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('interpolates runtime assertion fields for GraphQL execution through the HTTP adapter', async () => {
    const httpClient = {
      send: vi.fn().mockResolvedValue(makeResponse({ data: { user: { name: 'Ada' } } })),
      buildResolvedRequest: vi.fn(),
      cancelAll: vi.fn(),
    };
    const runtime = new RuntimeExecutionService(async () => new Map([
      ['gqlField', 'name'],
      ['expectedName', 'Ada'],
    ]));
    const executionService = new RequestExecutionService(httpClient as any, undefined, undefined, runtime);
    const request: GraphQLRequest = {
      info: { name: 'User query', type: 'graphql' },
      graphql: {
        method: 'POST',
        url: 'http://127.0.0.1/graphql',
        body: { query: 'query User { user { name } }', variables: '{}' },
      },
      runtime: {
        assertions: [{
          expression: 'res.body.data.user.{{gqlField}}',
          operator: 'equals',
          value: '{{expectedName}}',
          description: 'GraphQL {{expectedName}}',
        }],
      },
    };

    const response = await executionService.send(request, makeCollection());

    expect(httpClient.send).toHaveBeenCalledOnce();
    expect(response.runtime?.success).toBe(true);
    expect(response.runtime?.assertions[0]).toMatchObject({
      expression: 'res.body.data.user.name',
      expected: 'Ada',
      actual: 'Ada',
      description: 'GraphQL Ada',
      passed: true,
    });
  });
});

describe('runtime variables in unresolved-variable detection', () => {
  it('does not prompt for placeholders supplied by request runtime variables', async () => {
    const request: HttpRequest = {
      http: {
        method: 'POST',
        url: 'https://example.com/{{requestPath}}',
        body: { type: 'json', data: '{"value":"{{requestValue}}"}' },
      },
      runtime: {
        variables: [
          { name: 'requestPath', value: 'runtime' },
          { name: 'requestValue', value: 'ok' },
        ],
      },
    };

    const unresolved = await detectUnresolvedVars(
      request,
      makeCollection(),
      makeEnvService(),
    );

    expect(unresolved).toEqual([]);
  });
});
