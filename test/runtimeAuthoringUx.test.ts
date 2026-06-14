import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  applyRequestEditorModel,
  createRequestEditorModelFromRequest,
  type RequestEditorModel,
} from '../src/models/schemaRoundTrip';
import type { RequestProtocol } from '../src/models/types';
import { RequestEditorProvider } from '../src/panels/requestPanel';

const schema = require('../schema/opencollectionschema.json');

const schemaByProtocol: Record<RequestProtocol, string> = {
  http: 'HttpRequest',
  graphql: 'GraphQLRequest',
  websocket: 'WebSocketRequest',
  grpc: 'GrpcRequest',
};

const protocolRoots: RequestProtocol[] = ['http', 'graphql', 'websocket', 'grpc'];

function validateSubschema(protocol: RequestProtocol, data: unknown): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const defName = schemaByProtocol[protocol];
  const validate = ajv.compile({
    $schema: schema.$schema,
    $id: `${schema.$id}#test-runtime-authoring-${defName}`,
    $ref: `${schema.$id}#/$defs/${defName}`,
    $defs: schema.$defs,
  });
  expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function yamlRoundTrip(data: unknown): unknown {
  return parseYaml(stringifyYaml(data, { lineWidth: 120 }));
}

function runtimeFixture() {
  return {
    variables: [{ name: 'runtimeOwner', value: 'Ada' }],
    scripts: [
      { type: 'before-request', code: 'missio.variables.set("trace", "before");' },
      { type: 'tests', code: 'test("ok", () => assert(response.status < 400));', disabled: true },
    ],
    assertions: [
      {
        expression: 'res.status',
        operator: 'equals',
        value: '200',
        disabled: true,
        description: { content: 'Status remains visible', type: 'text/markdown' },
      },
    ],
    actions: [
      {
        type: 'set-variable',
        phase: 'after-response',
        selector: { method: 'jsonq', expression: '$.token' },
        variable: { scope: 'runtime', name: 'responseToken' },
        disabled: true,
        description: { content: 'Capture token', type: 'text/plain' },
      },
    ],
  };
}

function requestForProtocol(protocol: RequestProtocol): any {
  const runtime = runtimeFixture();
  if (protocol === 'graphql') {
    return {
      info: { name: 'GraphQL runtime', type: 'graphql' },
      graphql: {
        method: 'POST',
        url: '{{baseUrl}}/graphql',
        headers: [{ name: 'X-Trace', value: '{{trace}}' }],
        body: { query: 'query Health { health { status } }', variables: '{"trace":"{{trace}}"}' },
      },
      runtime,
      settings: { timeout: 5000 },
    };
  }
  if (protocol === 'websocket') {
    return {
      info: { name: 'WebSocket runtime', type: 'websocket' },
      websocket: {
        url: '{{wsBaseUrl}}/ws/auth',
        headers: [{ name: 'X-Trace', value: '{{trace}}' }],
        message: { type: 'json', data: '{"user":"Ada"}' },
      },
      runtime,
    };
  }
  if (protocol === 'grpc') {
    return {
      info: { name: 'gRPC runtime', type: 'grpc' },
      grpc: {
        url: '{{grpcBaseUrl}}',
        method: 'missio.demo.DemoService/EchoUnary',
        methodType: 'unary',
        protoFilePath: 'proto/services/missio_demo.proto',
        metadata: [{ name: 'x-trace-id', value: '{{trace}}' }],
        message: '{"name":"Ada","trace":{"requestId":"{{trace}}"}}',
      },
      runtime,
    };
  }
  return {
    info: { name: 'HTTP runtime', type: 'http' },
    http: {
      method: 'POST',
      url: '{{baseUrl}}/runtime/token',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: { type: 'json', data: '{"owner":"{{runtimeOwner}}"}' },
    },
    runtime,
    settings: { timeout: 5000 },
  };
}

describe('OC-110 runtime authoring model', () => {
  it('round-trips runtime scripts, assertions, and actions for every request protocol', () => {
    for (const protocol of protocolRoots) {
      const request = requestForProtocol(protocol);
      const model = createRequestEditorModelFromRequest(request);
      const updated = applyRequestEditorModel(request, model);

      expect(updated).toEqual(request);
      expect(yamlRoundTrip(updated)).toEqual(request);
      expect(protocolRoots.filter(root => Object.prototype.hasOwnProperty.call(updated as object, root))).toEqual([protocol]);
      validateSubschema(protocol, updated);
    }
  });

  it('preserves existing unsupported-but-schema-valid runtime rows on no-op saves', () => {
    const request = requestForProtocol('http');
    request.runtime.scripts.push({
      type: 'hooks',
      code: 'console.log("schema-valid hook");',
      disabled: true,
    });
    request.runtime.actions.push({
      type: 'set-variable',
      phase: 'after-response',
      selector: { method: 'jsonq', expression: '$.environmentToken' },
      variable: { scope: 'environment', name: 'environmentToken' },
    });

    const model = createRequestEditorModelFromRequest(request) as RequestEditorModel;
    const lastScript = model.runtime?.scripts?.[model.runtime.scripts.length - 1];
    const lastAction = model.runtime?.actions?.[model.runtime.actions.length - 1];
    expect(lastScript).toMatchObject({
      type: 'hooks',
      code: 'console.log("schema-valid hook");',
      disabled: true,
    });
    expect(lastAction).toMatchObject({
      type: 'set-variable',
      variableScope: 'environment',
      variableName: 'environmentToken',
    });

    const updated = applyRequestEditorModel(request, model);

    expect(updated).toEqual(request);
    validateSubschema('http', updated);
  });

  it('creates, edits, disables, reorders, and removes managed runtime entries without dropping runtime siblings', () => {
    const request = requestForProtocol('http');
    const model = createRequestEditorModelFromRequest(request) as RequestEditorModel;
    model.runtime = {
      scripts: [
        {
          type: 'tests',
          code: 'test("edited", () => assert(response.status === 201));',
          disabled: true,
          originalIndex: 1,
        },
        {
          type: 'after-response',
          code: 'console.log("new after response");',
        },
      ],
      assertions: [
        {
          expression: 'res.body.ok',
          operator: 'equals',
          value: 'true',
          disabled: false,
          description: 'Status remains visible',
          originalIndex: 0,
        },
      ],
      actions: [],
    };

    const updated = applyRequestEditorModel(request, model) as any;

    expect(updated.runtime.variables).toEqual(request.runtime.variables);
    expect(updated.runtime.auth).toBeUndefined();
    expect(updated.runtime.scripts).toEqual([
      {
        type: 'tests',
        code: 'test("edited", () => assert(response.status === 201));',
        disabled: true,
      },
      {
        type: 'after-response',
        code: 'console.log("new after response");',
      },
    ]);
    expect(updated.runtime.assertions).toEqual([
      {
        expression: 'res.body.ok',
        operator: 'equals',
        value: 'true',
        disabled: false,
        description: { content: 'Status remains visible', type: 'text/markdown' },
      },
    ]);
    expect(updated.runtime.actions).toEqual([]);
    expect(yamlRoundTrip(updated)).toEqual(updated);
    validateSubschema('http', updated);
  });

  it('adds runtime authoring edits to gRPC requests without changing method, metadata, or protocol root', () => {
    const request = requestForProtocol('grpc');
    const model = createRequestEditorModelFromRequest(request) as RequestEditorModel;
    model.runtime = {
      scripts: [{ type: 'before-request', code: 'missio.variables.set("grpcEdited", "yes");' }],
      assertions: [{ expression: 'res.body.name', operator: 'equals', value: 'Ada' }],
      actions: [{
        type: 'set-variable',
        phase: 'after-response',
        selectorMethod: 'jsonq',
        selectorExpression: '$.requestId',
        variableScope: 'runtime',
        variableName: 'grpcRequestId',
      }],
    };

    const updated = applyRequestEditorModel(request, model) as any;

    expect(updated.http).toBeUndefined();
    expect(updated.graphql).toBeUndefined();
    expect(updated.websocket).toBeUndefined();
    expect(updated.grpc.method).toBe(request.grpc.method);
    expect(updated.grpc.metadata).toEqual(request.grpc.metadata);
    expect(updated.runtime.scripts[0].code).toContain('grpcEdited');
    validateSubschema('grpc', updated);
  });
});

describe('OC-110 runtime authoring UI shell', () => {
  it('renders request Runtime authoring controls separately from response Runtime results', () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const html = (provider as any)._getBodyHtml({} as any) as string;

    expect(html).toContain('data-tab="runtime"');
    expect(html).toContain('id="runtimeBadge"');
    expect(html).toContain('id="panel-runtime"');
    expect(html).toContain('id="runtimeScriptsList"');
    expect(html).toContain('id="runtimeAssertionsList"');
    expect(html).toContain('id="runtimeActionsList"');
    expect(html).toContain('id="addRuntimeScriptBtn"');
    expect(html).toContain('id="addRuntimeTestBtn"');
    expect(html).toContain('id="addRuntimeAssertionBtn"');
    expect(html).toContain('id="addRuntimeActionBtn"');
    expect(html).toContain('id="panel-resp-runtime"');
  });

  it('keeps runtime authoring layout classes available in the request panel stylesheet', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'requestPanel.css'), 'utf8');

    expect(css).toContain('.runtime-authoring');
    expect(css).toContain('.runtime-editor-row');
    expect(css).toContain('.runtime-row-toolbar');
    expect(css).toContain('.runtime-icon-btn');
    expect(css).toContain('.runtime-unsupported-note');
    expect(css).toContain('.runtime-list:empty::before');
  });

  it('offers only runtime-executable script phases and supported set-variable scopes for new rows', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'requestPanel.ts'), 'utf8');

    expect(source).toMatch(/const runtimeScriptTypes = \['before-request', 'after-response', 'tests'\];/);
    expect(source).not.toMatch(/const runtimeScriptTypes = \[[^\]]*hooks/);
    expect(source).toMatch(/const runtimeVariableScopes = \['runtime', 'request'\];/);
    expect(source).not.toMatch(/const runtimeVariableScopes = \[[^\]]*(folder|collection|environment)/);
    expect(source).toContain('hooks (not executed)');
    expect(source).toContain('environment (not persisted)');
    expect(source).toContain('data-runtime-unsupported="true"');
  });
});
