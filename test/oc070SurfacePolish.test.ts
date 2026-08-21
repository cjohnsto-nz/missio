import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CollectionTreeProvider } from '../src/providers/collectionTreeProvider';
import { MissioCodeLensProvider } from '../src/providers/codeLensProvider';
import { GetRequestTool } from '../src/copilot/tools/getRequestTool';
import { ListRequestsTool } from '../src/copilot/tools/listRequestsTool';
import { SendRequestTool } from '../src/copilot/tools/sendRequestTool';
import { createRequestTemplate } from '../src/services/requestTemplates';
import { getUnsupportedSnippetDiagnostic } from '../src/services/snippetExporter';
import { detectUnsupportedRequestFormat } from '../src/importers/requestImporters';
import { PostmanImporter } from '../src/importers/postmanImporter';
import { OpenApiImporter } from '../src/importers/openApiImporter';
import type { MissioCollection, OpenCollectionRequest, RequestProtocol } from '../src/models/types';

const tempRoots: string[] = [];

const protocols: RequestProtocol[] = ['http', 'graphql', 'websocket', 'grpc'];

function makeTempDir(prefix = 'missio-oc070-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeCollection(rootDir = makeTempDir()): MissioCollection {
  return {
    id: path.join(rootDir, 'opencollection.yml'),
    filePath: path.join(rootDir, 'opencollection.yml'),
    rootDir,
    data: {
      opencollection: '1.0.0',
      info: { name: 'OC-070 Test' },
      request: {
        headers: [{ name: 'X-Collection-Trace', value: '{{traceId}}' }],
        metadata: [{ name: 'x-collection-token', value: '{{grpcToken}}' }],
      },
      config: { environments: [] },
    },
  };
}

function makeEnvService(vars: Record<string, string>, secretNames: string[] = []) {
  const map = new Map(Object.entries(vars));
  const secrets = new Set(secretNames);
  return {
    resolveVariables: vi.fn().mockResolvedValue(new Map(map)),
    resolveVariablesWithSource: vi.fn().mockResolvedValue(
      new Map([...map].map(([key, value]) => [key, { value, source: secrets.has(key) ? 'secret' : 'environment' }])),
    ),
    interpolate: (template: string, values: Map<string, string>) =>
      template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, name) => values.get(name) ?? match),
    interpolateJson: (template: string, values: Map<string, string>) =>
      template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, name) => values.get(name) ?? match),
    getActiveEnvironmentName: () => undefined,
  } as any;
}

function requestFile(root: string, protocol: RequestProtocol): string {
  return path.join(root, `${protocol}.yml`);
}

function makeProtocolRequest(protocol: RequestProtocol): OpenCollectionRequest {
  const request = createRequestTemplate(protocol, `${protocol} request`) as any;
  request.info.seq = protocols.indexOf(protocol) + 1;
  if (protocol === 'http') {
    request.http.url = '{{baseUrl}}/items?token={{secretToken}}';
    request.http.headers = [{ name: 'Authorization', value: 'Bearer {{secretToken}}' }];
  }
  if (protocol === 'graphql') {
    request.graphql.url = '{{baseUrl}}/graphql';
    request.graphql.headers = [{ name: 'X-Trace', value: '{{traceId}}' }];
  }
  if (protocol === 'websocket') {
    request.websocket.url = '{{wsBaseUrl}}/socket';
    request.websocket.headers = [{ name: 'X-Api-Key', value: '{{secretToken}}' }];
  }
  if (protocol === 'grpc') {
    request.grpc.url = '{{grpcBaseUrl}}';
    request.grpc.metadata = [{ name: 'authorization', value: 'Bearer {{grpcToken}}' }];
    request.grpc.message = '{"name":"{{grpcName}}","token":"{{grpcToken}}"}';
  }
  return request;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('OC-070 baseline protocol UI and command surfaces', () => {
  it('keeps request creation templates visible in tree nodes and CodeLens commands for every protocol', async () => {
    const collection = makeCollection();
    const requests = protocols.map(protocol => {
      const request = makeProtocolRequest(protocol) as any;
      request._filePath = requestFile(collection.rootDir, protocol);
      return request;
    });
    const provider = new CollectionTreeProvider({
      onDidChange: () => ({ dispose: () => {} }),
      getCollections: () => [collection],
      resolveItems: vi.fn().mockResolvedValue(requests),
    } as any);

    const roots = await provider.getChildren();
    const nodes = await provider.getChildren(roots[0] as any);

    expect(nodes.map(node => (node as any).contextValue)).toEqual([
      'httpRequest',
      'graphqlRequest',
      'websocketRequest',
      'grpcRequest',
    ]);
    expect(nodes.map(node => (node as any).command?.command)).toEqual([
      'missio.openRequest',
      'missio.openRequest',
      'missio.openRequest',
      'missio.openRequest',
    ]);
    expect(nodes.map(node => (node as any).command?.arguments?.[0])).toEqual(
      protocols.map(protocol => requestFile(collection.rootDir, protocol)),
    );
    provider.dispose();

    const codeLensProvider = new MissioCodeLensProvider();
    const codeLensTitles = protocols.map(protocol => {
      const filePath = requestFile(collection.rootDir, protocol);
      const text = stringifyYaml(makeProtocolRequest(protocol), { lineWidth: 120 });
      return codeLensProvider.provideCodeLenses({
        uri: { fsPath: filePath },
        getText: () => text,
      } as any).map(lens => lens.command?.title);
    });

    expect(codeLensTitles).toEqual([
      ['Send Request', 'GET {{baseUrl}}/items?token={{secretToken}}'],
      ['Send GraphQL', 'GRAPHQL QUERY {{baseUrl}}/graphql'],
      ['Connect WebSocket', 'WS {{wsBaseUrl}}/socket'],
      ['Send gRPC', 'gRPC package.Service/Method'],
    ]);
    codeLensProvider.dispose();
  });
});

describe('OC-070 Copilot protocol preservation', () => {
  it('returns protocol metadata and redacted schema-native request data from get_request', async () => {
    const request = makeProtocolRequest('websocket') as any;
    request.runtime = { auth: { type: 'bearer', token: 'plain-secret-token' } };
    const tool = new GetRequestTool({
      loadRequestFile: vi.fn().mockResolvedValue(request),
    } as any);

    const parsed = JSON.parse(await tool.call({ input: { requestFilePath: '/tmp/socket.yml' } } as any, {} as any));

    expect(parsed).toMatchObject({
      success: true,
      protocol: 'websocket',
      requestFilePath: '/tmp/socket.yml',
    });
    expect(parsed.request.websocket.url).toBe('{{wsBaseUrl}}/socket');
    expect(parsed.request.http).toBeUndefined();
    expect(parsed.request.runtime.auth.token).toBe('[redacted]');
  });

  it('lists and dry-runs every supported protocol without collapsing them to HTTP', async () => {
    const collection = makeCollection();
    const requestMap = new Map<RequestProtocol, OpenCollectionRequest>(
      protocols.map(protocol => [protocol, makeProtocolRequest(protocol)]),
    );
    const listTool = new ListRequestsTool({
      resolveCollection: () => collection,
      resolveItems: vi.fn().mockResolvedValue([...requestMap.values()]),
    } as any);
    const listed = JSON.parse(await listTool.call({ input: {} } as any, {} as any));

    expect(listed.requests.map((entry: any) => entry.protocol)).toEqual(protocols);

    const envService = makeEnvService({
      baseUrl: 'https://api.example.test',
      wsBaseUrl: 'wss://socket.example.test',
      grpcBaseUrl: '127.0.0.1:50051',
      grpcName: 'Ada',
      traceId: 'trace-1',
      secretToken: 'secret-http-token',
      grpcToken: 'secret-grpc-token',
    }, ['secretToken', 'grpcToken']);
    const sendTool = new SendRequestTool(
      {
        loadRequestFile: async (filePath: string) => requestMap.get(path.basename(filePath, '.yml') as RequestProtocol),
        getCollection: () => collection,
        getCollections: () => [collection],
      } as any,
      envService,
      {} as any,
    );

    const dryRuns = await Promise.all(protocols.map(async protocol => JSON.parse(await sendTool.call(
      { input: { requestFilePath: requestFile(collection.rootDir, protocol), collectionId: collection.id, dryRun: true } } as any,
      {} as any,
    ))));

    expect(dryRuns.map(result => result.protocol)).toEqual(protocols);
    expect(dryRuns[0].url).not.toContain('secret-http-token');
    expect(dryRuns[2].headers['X-Api-Key']).toBe('[redacted]');
    expect(JSON.stringify(dryRuns[3])).not.toContain('secret-grpc-token');
    expect(dryRuns[3].request.metadata.authorization).toBe('Bearer [secret]');
    expect(dryRuns[3].request.message).toEqual({ name: 'Ada', token: '[secret]' });
  });
});

describe('OC-070 explicit unsupported diagnostics', () => {
  it('reports unsupported non-HTTP text imports before silently treating them as HTTP', () => {
    expect(detectUnsupportedRequestFormat('query Health { health { status } }')).toMatchObject({
      code: 'MISSIO_UNSUPPORTED_REQUEST_IMPORT',
      protocol: 'graphql',
    });
    expect(detectUnsupportedRequestFormat('grpcurl localhost:50051 demo.Service/Call')).toMatchObject({
      code: 'MISSIO_UNSUPPORTED_REQUEST_IMPORT',
      protocol: 'grpc',
    });
    expect(detectUnsupportedRequestFormat('wss://example.test/socket')).toMatchObject({
      code: 'MISSIO_UNSUPPORTED_REQUEST_IMPORT',
      protocol: 'websocket',
    });
  });

  it('reports protocol-specific unsupported snippet diagnostics for non-HTTP requests', () => {
    expect(getUnsupportedSnippetDiagnostic(makeProtocolRequest('graphql'))).toMatchObject({
      code: 'MISSIO_UNSUPPORTED_SNIPPET_EXPORT',
      protocol: 'graphql',
      protocolName: 'GraphQL',
    });
    expect(getUnsupportedSnippetDiagnostic(makeProtocolRequest('grpc')).message).toContain('gRPC snippet export');
  });
});

describe('OC-070 import diagnostics and script preservation', () => {
  it('preserves mappable Postman events as runtime scripts and records unsupported mappings', async () => {
    const root = makeTempDir();
    const postmanFile = path.join(root, 'postman.json');
    fs.writeFileSync(postmanFile, JSON.stringify({
      info: {
        name: 'Postman Scripts',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      event: [
        { listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.variables.set("collectionToken", "yes");'] } },
        { listen: 'monitor', script: { type: 'text/javascript', exec: ['console.log("unsupported");'] } },
      ],
      item: [
        {
          name: 'Folder',
          event: [{ listen: 'prerequest', script: { exec: 'pm.variables.set("folderToken", "yes");' } }],
          item: [
            {
              name: 'GET User',
              event: [{ listen: 'test', script: { exec: ['pm.test("ok", function () { pm.expect(pm.response.code).to.equal(200); });'] } }],
              request: { method: 'GET', url: 'https://example.test/users' },
            },
          ],
        },
      ],
    }), 'utf-8');

    const result = await new PostmanImporter().import(postmanFile, root);
    const collection = parseYaml(fs.readFileSync(result.collectionFile, 'utf-8'));
    const folder = parseYaml(fs.readFileSync(path.join(result.collectionDir, 'Folder', 'folder.yml'), 'utf-8'));
    const request = parseYaml(fs.readFileSync(path.join(result.collectionDir, 'Folder', 'GET User.yml'), 'utf-8'));

    expect(collection.request.scripts).toEqual([
      { type: 'before-request', code: 'pm.variables.set("collectionToken", "yes");' },
    ]);
    expect(folder.request.scripts[0]).toMatchObject({ type: 'before-request' });
    expect(request.runtime.scripts[0]).toMatchObject({ type: 'tests' });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'MISSIO_IMPORT_UNSUPPORTED_EVENT',
        source: 'Postman',
        path: 'collection:Postman Scripts',
      }),
    ]);
    expect(collection.extensions.missio.import.diagnostics).toHaveLength(1);
  });

  it('records OpenAPI source metadata and unsupported webhook diagnostics without inventing non-HTTP requests', async () => {
    const root = makeTempDir();
    const specFile = path.join(root, 'openapi.json');
    fs.writeFileSync(specFile, JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Webhook API', version: '1.2.3' },
      paths: {
        '/users': {
          get: {
            summary: 'List Users',
            callbacks: { onData: {} },
            responses: {},
          },
        },
      },
      webhooks: {
        userCreated: {
          post: { requestBody: { content: { 'application/json': { example: { id: 1 } } } }, responses: {} },
        },
      },
    }), 'utf-8');

    const result = await new OpenApiImporter().import(specFile, root);
    const collection = parseYaml(fs.readFileSync(result.collectionFile, 'utf-8'));
    const request = parseYaml(fs.readFileSync(path.join(result.collectionDir, 'List Users.yml'), 'utf-8'));

    expect(request.info.type).toBe('http');
    expect(request.graphql).toBeUndefined();
    expect(result.requestCount).toBe(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'MISSIO_IMPORT_UNSUPPORTED_WEBHOOKS', source: 'OpenAPI' }),
      expect.objectContaining({ code: 'MISSIO_IMPORT_UNSUPPORTED_CALLBACKS', source: 'OpenAPI' }),
    ]);
    expect(collection.extensions.missio.import.source).toMatchObject({
      format: 'OpenAPI',
      version: '3.1.0',
    });
  });
});
