import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { OpenApiImporter } from '../src/importers/openApiImporter';

// ── Helpers ──────────────────────────────────────────────────────────

const TMP_DIR = path.resolve(__dirname, '.tmp-openapi-test');

function makeSpec(overrides: any = {}): any {
  return {
    openapi: overrides.openapi ?? '3.1.0',
    info: {
      title: overrides.title ?? 'Test API',
      version: overrides.version ?? '1.0.0',
      ...overrides.info,
    },
    paths: overrides.paths ?? {},
    ...(overrides.servers ? { servers: overrides.servers } : {}),
    ...(overrides.tags ? { tags: overrides.tags } : {}),
    ...(overrides.security ? { security: overrides.security } : {}),
    ...(overrides.components ? { components: overrides.components } : {}),
    ...overrides.root,
  };
}

function writeSpecJson(spec: any): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, 'spec.json');
  fs.writeFileSync(file, JSON.stringify(spec), 'utf-8');
  return file;
}

function writeSpecYaml(spec: any): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, 'spec.yaml');
  const { stringify } = require('yaml');
  fs.writeFileSync(file, stringify(spec), 'utf-8');
  return file;
}

function readYaml(filePath: string): any {
  return parseYaml(fs.readFileSync(filePath, 'utf-8'));
}

function rmrf(dir: string) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

afterEach(() => rmrf(TMP_DIR));

// ── Tests ────────────────────────────────────────────────────────────

describe('OpenApiImporter', () => {
  const importer = new OpenApiImporter();

  // ── Basic validation ──────────────────────────────────────────────

  describe('validation', () => {
    it('rejects non-OpenAPI files', async () => {
      const file = writeSpecJson({ swagger: '2.0', info: { title: 'Old' } });
      await expect(importer.import(file, TMP_DIR)).rejects.toThrow('Only OpenAPI 3.x');
    });

    it('accepts OpenAPI 3.0.x', async () => {
      const spec = makeSpec({ openapi: '3.0.3', paths: {} });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(result.requestCount).toBe(0);
    });

    it('accepts OpenAPI 3.1.0', async () => {
      const spec = makeSpec({ openapi: '3.1.0', paths: {} });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(result.requestCount).toBe(0);
    });
  });

  // ── File format support ───────────────────────────────────────────

  describe('file formats', () => {
    it('imports from JSON', async () => {
      const spec = makeSpec({
        paths: { '/test': { get: { summary: 'Test', responses: {} } } },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(result.requestCount).toBe(1);
    });

    it('imports from YAML', async () => {
      const spec = makeSpec({
        paths: { '/test': { get: { summary: 'Test', responses: {} } } },
      });
      const file = writeSpecYaml(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(result.requestCount).toBe(1);
    });
  });

  // ── Collection structure ──────────────────────────────────────────

  describe('collection structure', () => {
    it('creates opencollection.yml with correct info', async () => {
      const spec = makeSpec({ title: 'My Cool API', version: '2.0.0' });
      spec.info.description = 'A test API';
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);

      const coll = readYaml(result.collectionFile);
      expect(coll.opencollection).toBe('1.0.0');
      expect(coll.info.name).toBe('My Cool API');
      expect(coll.info.version).toBe('2.0.0');
      expect(coll.info.summary).toBe('A test API');
    });

    it('creates collection directory from API title', async () => {
      const spec = makeSpec({ title: 'Pet Store API' });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(path.basename(result.collectionDir)).toBe('Pet Store API');
    });

    it('sanitizes unsafe characters in collection name', async () => {
      const spec = makeSpec({ title: 'API: <test> "v2"' });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(path.basename(result.collectionDir)).toBe('API test v2');
    });
  });

  // ── Servers → baseUrl ─────────────────────────────────────────────

  describe('servers', () => {
    it('uses first server as baseUrl variable', async () => {
      const spec = makeSpec({
        servers: [{ url: 'https://api.example.com/v1' }],
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const coll = readYaml(result.collectionFile);
      const baseVar = coll.request.variables.find((v: any) => v.name === 'baseUrl');
      expect(baseVar.value).toBe('https://api.example.com/v1');
    });

    it('converts server variables to {{var}} and adds as collection variables', async () => {
      const spec = makeSpec({
        servers: [{
          url: 'https://{environment}.example.com/{version}',
          variables: {
            environment: { default: 'api', description: 'Server environment' },
            version: { default: 'v1' },
          },
        }],
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const coll = readYaml(result.collectionFile);

      const baseVar = coll.request.variables.find((v: any) => v.name === 'baseUrl');
      expect(baseVar.value).toBe('https://{{environment}}.example.com/{{version}}');

      const envVar = coll.request.variables.find((v: any) => v.name === 'environment');
      expect(envVar.value).toBe('api');
      expect(envVar.description).toBe('Server environment');

      const verVar = coll.request.variables.find((v: any) => v.name === 'version');
      expect(verVar.value).toBe('v1');
    });

    it('uses fallback baseUrl when no servers defined', async () => {
      const spec = makeSpec({});
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const coll = readYaml(result.collectionFile);
      const baseVar = coll.request.variables.find((v: any) => v.name === 'baseUrl');
      expect(baseVar.value).toBe('https://api.example.com');
    });

    it('strips trailing slash from server URL', async () => {
      const spec = makeSpec({
        servers: [{ url: 'https://api.example.com/' }],
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const coll = readYaml(result.collectionFile);
      const baseVar = coll.request.variables.find((v: any) => v.name === 'baseUrl');
      expect(baseVar.value).toBe('https://api.example.com');
    });
  });

  // ── Path/operation → request files ────────────────────────────────

  describe('operations', () => {
    it('creates request files for each operation', async () => {
      const spec = makeSpec({
        paths: {
          '/users': {
            get: { summary: 'List Users', responses: {} },
            post: { summary: 'Create User', responses: {} },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(result.requestCount).toBe(2);
    });

    it('sets correct method, URL, name and seq', async () => {
      const spec = makeSpec({
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/users/{id}': {
            get: { summary: 'Get User', responses: {} },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);

      const reqFile = path.join(result.collectionDir, 'Get User.yml');
      expect(fs.existsSync(reqFile)).toBe(true);
      const req = readYaml(reqFile);
      expect(req.info.name).toBe('Get User');
      expect(req.http.method).toBe('GET');
      expect(req.http.url).toBe('{{baseUrl}}/users/{{id}}');
    });

    it('falls back to operationId when no summary', async () => {
      const spec = makeSpec({
        paths: {
          '/pets': {
            get: { operationId: 'listPets', responses: {} },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const reqFile = path.join(result.collectionDir, 'listPets.yml');
      expect(fs.existsSync(reqFile)).toBe(true);
    });

    it('falls back to METHOD /path when no summary or operationId', async () => {
      const spec = makeSpec({
        paths: {
          '/health': { get: { responses: {} } },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const reqFile = path.join(result.collectionDir, 'GET health.yml');
      expect(fs.existsSync(reqFile)).toBe(true);
    });

    it('sets description from operation description', async () => {
      const spec = makeSpec({
        paths: {
          '/users': {
            get: { summary: 'List Users', description: 'Returns all users', responses: {} },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'List Users.yml'));
      expect(req.info.description).toBe('Returns all users');
    });
  });

  // ── Tags → folders ────────────────────────────────────────────────

  describe('tag-based folders', () => {
    it('groups operations by tag into folders', async () => {
      const spec = makeSpec({
        tags: [{ name: 'Users', description: 'User operations' }],
        paths: {
          '/users': {
            get: { tags: ['Users'], summary: 'List Users', responses: {} },
            post: { tags: ['Users'], summary: 'Create User', responses: {} },
          },
          '/health': {
            get: { summary: 'Health Check', responses: {} },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(result.folderCount).toBe(1);
      expect(result.requestCount).toBe(3);

      // Folder exists with folder.yml
      const folderDir = path.join(result.collectionDir, 'Users');
      expect(fs.existsSync(folderDir)).toBe(true);
      const folderMeta = readYaml(path.join(folderDir, 'folder.yml'));
      expect(folderMeta.info.name).toBe('Users');
      expect(folderMeta.info.description).toBe('User operations');

      // Requests inside folder
      expect(fs.existsSync(path.join(folderDir, 'List Users.yml'))).toBe(true);
      expect(fs.existsSync(path.join(folderDir, 'Create User.yml'))).toBe(true);

      // Untagged request at root
      expect(fs.existsSync(path.join(result.collectionDir, 'Health Check.yml'))).toBe(true);
    });

    it('does not create folder.yml if tag has no description', async () => {
      const spec = makeSpec({
        paths: {
          '/users': {
            get: { tags: ['Users'], summary: 'List', responses: {} },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const folderDir = path.join(result.collectionDir, 'Users');
      expect(fs.existsSync(folderDir)).toBe(true);
      expect(fs.existsSync(path.join(folderDir, 'folder.yml'))).toBe(false);
    });

    it('deduplicates folder names', async () => {
      const spec = makeSpec({
        paths: {
          '/a': { get: { tags: ['Test?'], summary: 'A', responses: {} } },
          '/b': { get: { tags: ['Test*'], summary: 'B', responses: {} } },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      expect(result.folderCount).toBe(2);
      expect(fs.existsSync(path.join(result.collectionDir, 'Test'))).toBe(true);
      expect(fs.existsSync(path.join(result.collectionDir, 'Test 2'))).toBe(true);
    });
  });

  // ── Parameters ────────────────────────────────────────────────────

  describe('parameters', () => {
    it('converts query, path, and header parameters', async () => {
      const spec = makeSpec({
        paths: {
          '/users/{id}': {
            get: {
              summary: 'Get User',
              parameters: [
                { name: 'id', in: 'path', schema: { type: 'integer' }, example: 42 },
                { name: 'include', in: 'query', schema: { type: 'string' }, example: 'profile' },
                { name: 'X-Request-Id', in: 'header', schema: { type: 'string' }, example: 'abc-123' },
              ],
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Get User.yml'));

      expect(req.http.params).toContainEqual(expect.objectContaining({ name: 'id', type: 'path', value: '42' }));
      expect(req.http.params).toContainEqual(expect.objectContaining({ name: 'include', type: 'query', value: 'profile' }));
      expect(req.http.headers).toContainEqual(expect.objectContaining({ name: 'X-Request-Id', value: 'abc-123' }));
    });

    it('merges path-level and operation-level parameters', async () => {
      const spec = makeSpec({
        paths: {
          '/users/{id}': {
            parameters: [
              { name: 'id', in: 'path', schema: { type: 'integer' } },
            ],
            get: {
              summary: 'Get User',
              parameters: [
                { name: 'fields', in: 'query', schema: { type: 'string' } },
              ],
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Get User.yml'));

      expect(req.http.params).toHaveLength(2);
    });

    it('operation parameter overrides path-level with same name+in', async () => {
      const spec = makeSpec({
        paths: {
          '/users/{id}': {
            parameters: [
              { name: 'id', in: 'path', schema: { type: 'integer' }, example: 1 },
            ],
            get: {
              summary: 'Get User',
              parameters: [
                { name: 'id', in: 'path', schema: { type: 'integer' }, example: 99 },
              ],
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Get User.yml'));

      const idParam = req.http.params.find((p: any) => p.name === 'id');
      expect(idParam.value).toBe('99');
    });
  });

  // ── Request body ──────────────────────────────────────────────────

  describe('request body', () => {
    it('converts JSON body with example', async () => {
      const spec = makeSpec({
        paths: {
          '/users': {
            post: {
              summary: 'Create User',
              requestBody: {
                content: {
                  'application/json': {
                    schema: { type: 'object' },
                    example: { name: 'John', email: 'john@example.com' },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Create User.yml'));

      expect(req.http.body.type).toBe('json');
      const parsed = JSON.parse(req.http.body.data);
      expect(parsed.name).toBe('John');
    });

    it('generates JSON body from schema when no example', async () => {
      const spec = makeSpec({
        paths: {
          '/users': {
            post: {
              summary: 'Create User',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        age: { type: 'integer' },
                        active: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Create User.yml'));

      const parsed = JSON.parse(req.http.body.data);
      expect(parsed.name).toBe('string');
      expect(parsed.age).toBe(0);
      expect(parsed.active).toBe(false);
    });

    it('converts form-urlencoded body', async () => {
      const spec = makeSpec({
        paths: {
          '/login': {
            post: {
              summary: 'Login',
              requestBody: {
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: {
                      type: 'object',
                      properties: {
                        username: { type: 'string', example: 'admin' },
                        password: { type: 'string' },
                      },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Login.yml'));

      expect(req.http.body.type).toBe('form-urlencoded');
      expect(req.http.body.data).toContainEqual({ name: 'username', value: 'admin' });
      expect(req.http.body.data).toContainEqual({ name: 'password', value: '' });
    });

    it('converts multipart-form body', async () => {
      const spec = makeSpec({
        paths: {
          '/upload': {
            post: {
              summary: 'Upload',
              requestBody: {
                content: {
                  'multipart/form-data': {
                    schema: {
                      type: 'object',
                      properties: {
                        file: { type: 'string', format: 'binary' },
                        description: { type: 'string', example: 'My file' },
                      },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Upload.yml'));

      expect(req.http.body.type).toBe('multipart-form');
      expect(req.http.body.data).toContainEqual({ name: 'description', value: 'My file' });
    });
  });

  // ── Responses → examples ──────────────────────────────────────────

  describe('responses', () => {
    it('converts responses to examples', async () => {
      const spec = makeSpec({
        paths: {
          '/users': {
            get: {
              summary: 'List Users',
              responses: {
                '200': {
                  description: 'Success',
                  content: {
                    'application/json': {
                      example: [{ id: 1, name: 'Alice' }],
                    },
                  },
                },
                '404': { description: 'Not found' },
              },
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'List Users.yml'));

      expect(req.examples).toHaveLength(2);
      expect(req.examples[0].name).toBe('200 Success');
      expect(req.examples[0].response.status).toBe(200);
      expect(req.examples[0].response.body.type).toBe('json');
      expect(req.examples[1].name).toBe('404 Not found');
    });
  });

  // ── Auth / security schemes ───────────────────────────────────────

  describe('auth', () => {
    it('converts bearer auth from global security', async () => {
      const spec = makeSpec({
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const coll = readYaml(result.collectionFile);
      expect(coll.request.auth).toEqual({ type: 'bearer', token: '' });
    });

    it('converts basic auth', async () => {
      const spec = makeSpec({
        security: [{ basicAuth: [] }],
        components: {
          securitySchemes: {
            basicAuth: { type: 'http', scheme: 'basic' },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const coll = readYaml(result.collectionFile);
      expect(coll.request.auth).toEqual({ type: 'basic', username: '', password: '' });
    });

    it('converts apiKey auth', async () => {
      const spec = makeSpec({
        security: [{ apiKey: [] }],
        components: {
          securitySchemes: {
            apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const coll = readYaml(result.collectionFile);
      expect(coll.request.auth).toEqual({ type: 'apikey', key: 'X-API-Key', value: '', placement: 'header' });
    });

    it('converts OAuth2 client_credentials', async () => {
      const spec = makeSpec({
        security: [{ oauth: [] }],
        components: {
          securitySchemes: {
            oauth: {
              type: 'oauth2',
              flows: {
                clientCredentials: {
                  tokenUrl: 'https://auth.example.com/token',
                  scopes: { 'read:users': 'Read users', 'write:users': 'Write users' },
                },
              },
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const coll = readYaml(result.collectionFile);
      expect(coll.request.auth.type).toBe('oauth2');
      expect(coll.request.auth.flow).toBe('client_credentials');
      expect(coll.request.auth.accessTokenUrl).toBe('https://auth.example.com/token');
      expect(coll.request.auth.scope).toBe('read:users write:users');
    });

    it('sets inherit when operation has no security override', async () => {
      const spec = makeSpec({
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
        paths: {
          '/users': {
            get: { summary: 'List', responses: {} },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'List.yml'));
      expect(req.runtime.auth).toBe('inherit');
    });
  });

  // ── $ref resolution ───────────────────────────────────────────────

  describe('$ref resolution', () => {
    it('resolves parameter $ref', async () => {
      const spec = makeSpec({
        components: {
          parameters: {
            UserId: { name: 'id', in: 'path', schema: { type: 'integer' }, example: 42 },
          },
        },
        paths: {
          '/users/{id}': {
            get: {
              summary: 'Get User',
              parameters: [{ $ref: '#/components/parameters/UserId' }],
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Get User.yml'));
      expect(req.http.params).toContainEqual(expect.objectContaining({ name: 'id', value: '42' }));
    });

    it('resolves requestBody $ref', async () => {
      const spec = makeSpec({
        components: {
          requestBodies: {
            UserBody: {
              content: {
                'application/json': {
                  example: { name: 'Alice' },
                },
              },
            },
          },
        },
        paths: {
          '/users': {
            post: {
              summary: 'Create User',
              requestBody: { $ref: '#/components/requestBodies/UserBody' },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Create User.yml'));
      expect(req.http.body.type).toBe('json');
      const parsed = JSON.parse(req.http.body.data);
      expect(parsed.name).toBe('Alice');
    });

    it('resolves schema $ref for example generation', async () => {
      const spec = makeSpec({
        components: {
          schemas: {
            User: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
              },
            },
          },
        },
        paths: {
          '/users': {
            post: {
              summary: 'Create User',
              requestBody: {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/User' },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Create User.yml'));
      const parsed = JSON.parse(req.http.body.data);
      expect(parsed.name).toBe('string');
      expect(parsed.email).toBe('user@example.com');
    });

    it('resolves response $ref', async () => {
      const spec = makeSpec({
        components: {
          responses: {
            NotFound: { description: 'Resource not found' },
          },
        },
        paths: {
          '/users/{id}': {
            get: {
              summary: 'Get User',
              responses: {
                '200': { description: 'OK' },
                '404': { $ref: '#/components/responses/NotFound' },
              },
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Get User.yml'));
      const notFound = req.examples.find((e: any) => e.response.status === 404);
      expect(notFound).toBeDefined();
      expect(notFound.response.statusText).toBe('Resource not found');
    });
  });

  // ── Example generation from schemas ───────────────────────────────

  describe('example generation', () => {
    it('generates examples for string formats', async () => {
      const spec = makeSpec({
        paths: {
          '/test': {
            post: {
              summary: 'Test',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        date: { type: 'string', format: 'date' },
                        datetime: { type: 'string', format: 'date-time' },
                        email: { type: 'string', format: 'email' },
                        uri: { type: 'string', format: 'uri' },
                        uuid: { type: 'string', format: 'uuid' },
                      },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Test.yml'));
      const body = JSON.parse(req.http.body.data);
      expect(body.date).toBe('2024-01-01');
      expect(body.datetime).toBe('2024-01-01T00:00:00Z');
      expect(body.email).toBe('user@example.com');
      expect(body.uri).toBe('https://example.com');
      expect(body.uuid).toBe('00000000-0000-0000-0000-000000000000');
    });

    it('handles allOf composition', async () => {
      const spec = makeSpec({
        components: {
          schemas: {
            Base: { type: 'object', properties: { id: { type: 'integer' } } },
            Named: { type: 'object', properties: { name: { type: 'string' } } },
          },
        },
        paths: {
          '/test': {
            post: {
              summary: 'Test',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      allOf: [
                        { $ref: '#/components/schemas/Base' },
                        { $ref: '#/components/schemas/Named' },
                      ],
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Test.yml'));
      const body = JSON.parse(req.http.body.data);
      expect(body.id).toBe(0);
      expect(body.name).toBe('string');
    });

    it('handles oneOf by using first option', async () => {
      const spec = makeSpec({
        paths: {
          '/test': {
            post: {
              summary: 'Test',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      oneOf: [
                        { type: 'object', properties: { cat: { type: 'string' } } },
                        { type: 'object', properties: { dog: { type: 'string' } } },
                      ],
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Test.yml'));
      const body = JSON.parse(req.http.body.data);
      expect(body.cat).toBe('string');
      expect(body.dog).toBeUndefined();
    });

    it('uses enum values as examples', async () => {
      const spec = makeSpec({
        paths: {
          '/test': {
            post: {
              summary: 'Test',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        status: { type: 'string', enum: ['active', 'inactive'] },
                        priority: { type: 'integer', enum: [1, 2, 3] },
                      },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Test.yml'));
      const body = JSON.parse(req.http.body.data);
      expect(body.status).toBe('active');
      expect(body.priority).toBe(1);
    });

    it('generates array examples', async () => {
      const spec = makeSpec({
        paths: {
          '/test': {
            post: {
              summary: 'Test',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        tags: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const file = writeSpecJson(spec);
      const result = await importer.import(file, TMP_DIR);
      const req = readYaml(path.join(result.collectionDir, 'Test.yml'));
      const body = JSON.parse(req.http.body.data);
      expect(body.tags).toEqual(['string']);
    });
  });

  // ── Properties & metadata ─────────────────────────────────────────

  describe('importer properties', () => {
    it('has correct label and extensions', () => {
      expect(importer.label).toBe('OpenAPI');
      expect(importer.fileExtensions).toContain('json');
      expect(importer.fileExtensions).toContain('yml');
      expect(importer.fileExtensions).toContain('yaml');
      expect(importer.supportsUrl).toBe(true);
    });
  });
});
