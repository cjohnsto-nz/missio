import Ajv from 'ajv';
import {
  applyRequestEditorModel,
  createRequestEditorModelFromRequest,
  type RequestEditorModel,
} from '../src/models/schemaRoundTrip';

const schema = require('../schema/opencollectionschema.json');

function runtimeFixture() {
  return {
    assertions: [{
      expression: 'res.status',
      operator: 'equals',
      value: '200',
      disabled: true,
      description: { content: 'Status remains visible', type: 'text/markdown' },
    }],
    actions: [{
      type: 'set-variable',
      phase: 'after-response',
      selector: { method: 'jsonq', expression: '$.token' },
      variable: { scope: 'runtime', name: 'responseToken' },
      disabled: true,
      description: { content: 'Capture token', type: 'text/plain' },
    }],
  };
}

function httpRequest(): any {
  return {
    info: { name: 'HTTP runtime', type: 'http' },
    http: { method: 'GET', url: '{{baseUrl}}/runtime/token' },
    runtime: runtimeFixture(),
  };
}

function grpcRequest(): any {
  return {
    info: { name: 'gRPC runtime', type: 'grpc' },
    grpc: {
      url: '{{grpcBaseUrl}}',
      method: 'missio.demo.DemoService/EchoUnary',
      methodType: 'unary',
      protoFilePath: 'proto/services/missio_demo.proto',
    },
    runtime: runtimeFixture(),
  };
}

function validateGrpc(data: unknown): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile({
    $schema: schema.$schema,
    $id: `${schema.$id}#test-runtime-authoring-regression-grpc`,
    $ref: `${schema.$id}#/$defs/GrpcRequest`,
    $defs: schema.$defs,
  });
  expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

describe('runtime authoring round-trip regressions', () => {
  it('does not add an empty message to a message-less gRPC request', () => {
    const request = grpcRequest();
    const model = createRequestEditorModelFromRequest(request) as RequestEditorModel;
    model.body = { kind: 'raw', rawType: 'json', data: '' };

    const updated = applyRequestEditorModel(request, model) as any;

    expect(updated.grpc).not.toHaveProperty('message');
    validateGrpc(updated);
  });

  it('preserves existing runtime rows while a required field is temporarily incomplete', () => {
    const request = httpRequest();
    const model = createRequestEditorModelFromRequest(request) as RequestEditorModel;
    model.runtime!.assertions![0].expression = '';
    model.runtime!.actions![0].variableName = '';

    const updated = applyRequestEditorModel(request, model) as any;

    expect(updated.runtime.assertions).toEqual(request.runtime.assertions);
    expect(updated.runtime.actions).toEqual(request.runtime.actions);
  });

  it('retains structured description metadata when runtime descriptions are edited', () => {
    const request = httpRequest();
    const model = createRequestEditorModelFromRequest(request) as RequestEditorModel;
    model.runtime!.assertions![0].description = 'Updated assertion';
    model.runtime!.actions![0].description = 'Updated action';

    const updated = applyRequestEditorModel(request, model) as any;

    expect(updated.runtime.assertions[0].description).toEqual({
      content: 'Updated assertion',
      type: 'text/markdown',
    });
    expect(updated.runtime.actions[0].description).toEqual({
      content: 'Updated action',
      type: 'text/plain',
    });
  });
});
