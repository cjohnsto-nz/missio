import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  applyCollectionEditorModel,
  applyFolderEditorModel,
  applyRequestEditorModel,
  cloneJson,
  createCollectionEditorModelFromCollection,
  createFolderEditorModelFromFolder,
  createRequestEditorModelFromRequest,
  type RequestEditorModel,
} from '../src/models/schemaRoundTrip';

const schemaPath = path.resolve(__dirname, '..', 'schema', 'opencollectionschema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

function validateSubschema(defName: string, data: unknown): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile({
    $schema: schema.$schema,
    $id: `${schema.$id}#test-${defName}`,
    $ref: `${schema.$id}#/$defs/${defName}`,
    $defs: schema.$defs,
  });
  expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function validateCollection(data: unknown): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function yamlRoundTrip<T>(data: T): unknown {
  return parseYaml(stringifyYaml(data, { lineWidth: 120 }));
}

describe('schema-safe editor round trips', () => {
  it('preserves HTTP body variants, multipart file parts, typed variables, and sibling fields', () => {
    const request = {
      info: { name: 'Upload avatar', type: 'http' },
      http: {
        method: 'POST',
        url: 'https://api.example.com/users/{{id}}/avatar',
        params: [
          { name: 'id', value: '{{id}}', type: 'path', description: 'User id' },
        ],
        headers: [
          { name: 'Accept', value: 'application/json', description: 'Response type' },
        ],
        body: [
          {
            title: 'JSON',
            body: { type: 'json', data: '{"name":"Ada"}' },
          },
          {
            title: 'Multipart',
            selected: true,
            body: {
              type: 'multipart-form',
              data: [
                {
                  name: 'avatar',
                  type: 'file',
                  value: ['fixtures/avatar.png', 'fixtures/avatar-2x.png'],
                  description: 'Upload files',
                },
                { name: 'caption', type: 'text', value: 'Hello' },
              ],
            },
          },
        ],
      },
      runtime: {
        variables: [
          { name: 'id', value: { type: 'number', data: '42' } },
          {
            name: 'region',
            value: [
              { title: 'NZ', selected: true, value: 'nz' },
              { title: 'US', value: 'us' },
            ],
          },
        ],
        scripts: [{ type: 'before-request', code: 'console.log("keep");' }],
      },
      settings: { timeout: 12000, encodeUrl: true },
      examples: [
        { name: 'Accepted', response: { status: 202, statusText: 'Accepted' } },
      ],
      docs: 'Keep docs.',
    };

    const model = createRequestEditorModelFromRequest(request);
    const updated = applyRequestEditorModel(request, model);

    expect(updated).toEqual(request);
    expect(yamlRoundTrip(updated)).toEqual(request);
    validateSubschema('HttpRequest', updated);
  });

  it('does not add HTTP settings when a no-op UI save only sees defaults', () => {
    const request = {
      info: { name: 'List users', type: 'http' },
      http: { method: 'GET', url: 'https://api.example.com/users' },
    };
    const model = createRequestEditorModelFromRequest(request) as RequestEditorModel;
    model.settings = {
      timeout: 30000,
      encodeUrl: true,
      followRedirects: true,
      maxRedirects: 5,
    };

    const updated = applyRequestEditorModel(request, model);

    expect(updated).toEqual(request);
    expect((updated as any).settings).toBeUndefined();
    validateSubschema('HttpRequest', updated);
  });

  it('edits GraphQL requests schema-natively while preserving body variants', () => {
    const request = {
      info: { name: 'GraphQL users', type: 'graphql' },
      graphql: {
        method: 'POST',
        url: 'https://api.example.com/graphql',
        headers: [{ name: 'X-Trace', value: '{{traceId}}', description: 'keep' }],
        body: [
          {
            title: 'Users',
            selected: true,
            body: { query: 'query Users { users { id } }', variables: '{"limit":10}' },
          },
          {
            title: 'Create',
            body: {
              query: 'mutation Create($name: String!) { createUser(name: $name) { id } }',
              variables: '{"name":"Ada"}',
            },
          },
        ],
      },
      runtime: { scripts: [{ type: 'tests', code: 'assert(true);' }] },
      settings: { timeout: 9000 },
    };

    const model = createRequestEditorModelFromRequest(request);
    model.body = {
      kind: 'graphql',
      query: 'query Users { users { id name } }',
      variables: '{"limit":20}',
      bodyVariantIndex: 0,
    };

    const updated = applyRequestEditorModel(request, model) as any;

    expect(updated.http).toBeUndefined();
    expect(updated.graphql.body[0].body).toEqual({
      query: 'query Users { users { id name } }',
      variables: '{"limit":20}',
    });
    expect(updated.graphql.body[1]).toEqual(request.graphql.body[1]);
    expect(yamlRoundTrip(updated)).toEqual(updated);
    validateSubschema('GraphQLRequest', updated);
  });

  it('leaves WebSocket and gRPC request files untouched and without http keys', () => {
    const fixtures = [
      {
        defName: 'WebSocketRequest',
        data: {
          info: { name: 'Socket ping', type: 'websocket' },
          websocket: {
            url: 'wss://api.example.com/socket',
            headers: [{ name: 'X-Client', value: 'missio' }],
            message: { type: 'text', data: 'ping' },
          },
          runtime: { auth: 'inherit' },
        },
      },
      {
        defName: 'GrpcRequest',
        data: {
          info: { name: 'Get user', type: 'grpc' },
          grpc: {
            url: 'grpc://api.example.com',
            method: 'users.UserService/GetUser',
            methodType: 'unary',
            metadata: [{ name: 'x-request-id', value: '{{requestId}}' }],
            message: '{"id": "42"}',
          },
        },
      },
    ];

    for (const fixture of fixtures) {
      const model = createRequestEditorModelFromRequest(fixture.data);
      const updated = applyRequestEditorModel(fixture.data, model);

      expect(updated).toEqual(fixture.data);
      expect((updated as any).http).toBeUndefined();
      expect(yamlRoundTrip(updated)).toEqual(fixture.data);
      validateSubschema(fixture.defName, updated);
    }
  });

  it('preserves collection, environment, and folder defaults on no-op editor saves', () => {
    const collection = {
      opencollection: '1.0.0',
      info: { name: 'Schema Fixtures', version: '1.0.0' },
      config: {
        environments: [
          {
            name: 'dev',
            variables: [
              { name: 'port', value: { type: 'number', data: '443' } },
              {
                name: 'region',
                value: [
                  { title: 'NZ', selected: true, value: 'nz' },
                  { title: 'US', value: 'us' },
                ],
              },
              { secret: true, name: 'token', description: 'Stored in SecretStorage' },
            ],
          },
        ],
      },
      request: {
        headers: [{ name: 'Accept', value: 'application/json' }],
        metadata: [{ name: 'x-trace-id', value: '{{traceId}}' }],
        auth: { type: 'bearer', token: '{{token}}' },
        variables: [
          { name: 'traceId', value: { type: 'string', data: 'abc' } },
          {
            name: 'baseUrl',
            value: [
              { title: 'dev', selected: true, value: 'https://dev.example.com' },
              { title: 'prod', value: 'https://api.example.com' },
            ],
          },
        ],
        scripts: [{ type: 'before-request', code: 'console.log("collection");' }],
        settings: {
          http: { timeout: 5000 },
          graphql: { timeout: 7000 },
        },
      },
    };
    const folder = {
      info: { name: 'Users', type: 'folder' },
      request: {
        headers: [{ name: 'X-Folder', value: 'users' }],
        metadata: [{ name: 'x-folder-trace', value: '{{traceId}}' }],
        variables: [
          { name: 'pageSize', value: { type: 'number', data: '50' } },
        ],
        scripts: [{ type: 'after-response', code: 'console.log("folder");' }],
        settings: { http: { followRedirects: true } },
      },
      docs: 'Folder documentation.',
    };

    const updatedCollection = applyCollectionEditorModel(
      collection,
      createCollectionEditorModelFromCollection(collection),
    );
    const updatedFolder = applyFolderEditorModel(
      folder,
      createFolderEditorModelFromFolder(folder),
    );

    expect(updatedCollection).toEqual(collection);
    expect(updatedFolder).toEqual(folder);
    expect(yamlRoundTrip(updatedCollection)).toEqual(collection);
    expect(yamlRoundTrip(updatedFolder)).toEqual(folder);
    validateCollection(updatedCollection);
    validateSubschema('Folder', updatedFolder);
  });

  it('does not mutate source objects while applying no-op models', () => {
    const request = {
      info: { name: 'Original', type: 'http' },
      http: { method: 'GET', url: 'https://example.com' },
    };
    const before = cloneJson(request);

    applyRequestEditorModel(request, createRequestEditorModelFromRequest(request));

    expect(request).toEqual(before);
  });
});
