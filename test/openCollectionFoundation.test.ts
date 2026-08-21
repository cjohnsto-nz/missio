import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace, FileType } from 'vscode';
import {
  getItemKind,
  isFolder,
  isGraphQLRequest,
  isGrpcRequest,
  isHttpRequest,
  isProtocolRequest,
  isScriptFile,
  isWebSocketRequest,
  type MissioCollection,
} from '../src/models/types';
import { readRequestFile } from '../src/services/yamlParser';
import { CollectionService } from '../src/services/collectionService';
import { CollectionTreeProvider } from '../src/providers/collectionTreeProvider';
import {
  RequestExecutionService,
  UnsupportedProtocolError,
} from '../src/services/requestExecutionService';
import { validateCollection } from '../src/services/validationService';
import { SendRequestTool } from '../src/copilot/tools/sendRequestTool';
import { applyCollectionYamlEdit } from '../src/panels/basePanel';
import { RequestEditorProvider } from '../src/panels/requestPanel';

const tempRoots: string[] = [];
const originalReadDirectory = workspace.fs.readDirectory;
const originalStat = workspace.fs.stat;
const originalFindFiles = (workspace as any).findFiles;
const originalApplyEdit = workspace.applyEdit;
const originalOnDidSaveTextDocument = workspace.onDidSaveTextDocument;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-oc-foundation-'));
  tempRoots.push(dir);
  return dir;
}

function writeYaml(filePath: string, yaml: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = yaml.replace(/^\n/, '').replace(/\s+$/, '').split(/\r?\n/);
  const indents = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  const content = lines.map(line => line.slice(minIndent)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

function mockWorkspaceReadDirectory(): void {
  workspace.fs.readDirectory = async (uri: { fsPath: string }) => {
    return fs.readdirSync(uri.fsPath, { withFileTypes: true }).map(entry => [
      entry.name,
      entry.isDirectory() ? FileType.Directory : FileType.File,
    ]);
  };
}

function makeCollection(rootDir: string): MissioCollection {
  return {
    id: path.join(rootDir, 'opencollection.yml'),
    filePath: path.join(rootDir, 'opencollection.yml'),
    rootDir,
    data: {
      opencollection: '1.0.0',
      info: { name: 'Foundation Test' },
    },
  };
}

afterEach(() => {
  workspace.fs.readDirectory = originalReadDirectory;
  workspace.fs.stat = originalStat;
  (workspace as any).findFiles = originalFindFiles;
  workspace.applyEdit = originalApplyEdit;
  workspace.onDidSaveTextDocument = originalOnDidSaveTextDocument;
  vi.restoreAllMocks();
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Collection polling fingerprints', () => {
  it('refreshes cached collection data from a saved collection document', () => {
    const root = makeTempDir();
    const service = new CollectionService();
    const collection = makeCollection(root);
    (service as any)._collections.set(collection.id, collection);
    let savedDocumentHandler: ((document: any) => void) | undefined;
    workspace.onDidSaveTextDocument = ((handler: (document: any) => void) => {
      savedDocumentHandler = handler;
      return { dispose: () => {} };
    }) as any;
    (service as any)._setupWatchers();
    const onDidChange = vi.fn();
    service.onDidChange(onDidChange);
    const document = {
      uri: { fsPath: collection.filePath },
      getText: () => 'opencollection: 1.0.0\ninfo:\n  name: Saved Update\n',
    };

    savedDocumentHandler?.(document);
    expect(service.getCollection(collection.id)?.data.info?.name).toBe('Saved Update');
    expect(onDidChange).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('ignores malformed saved collection documents', () => {
    const root = makeTempDir();
    const service = new CollectionService();
    const collection = makeCollection(root);
    (service as any)._collections.set(collection.id, collection);
    const onDidChange = vi.fn();
    service.onDidChange(onDidChange);

    expect(service.refreshCollectionFromDocument({
      uri: { fsPath: collection.filePath },
      getText: () => 'info: [ malformed',
    } as any)).toBe(false);
    expect(service.getCollection(collection.id)?.data.info?.name).toBe('Foundation Test');
    expect(onDidChange).not.toHaveBeenCalled();
    service.dispose();
  });

  it('does not autosave unrelated dirty collection edits', async () => {
    const applyEdit = vi.fn(async () => true);
    workspace.applyEdit = applyEdit as any;
    const save = vi.fn(async () => true);
    const collectionDocument = {
      isDirty: true,
      lineCount: 3,
      save,
    } as any;

    await expect(applyCollectionYamlEdit(
      { fsPath: 'collection.yml' } as any,
      collectionDocument,
      'info:\n  name: Updated\n',
    )).resolves.toBe(true);

    expect(applyEdit).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it('updates cached collection data and notifies listeners immediately', () => {
    const root = makeTempDir();
    const service = new CollectionService();
    const collection = makeCollection(root);
    const updatedData = {
      ...collection.data,
      info: { name: 'Updated Collection' },
    };
    (service as any)._collections.set(collection.id, collection);
    const onDidChange = vi.fn();
    service.onDidChange(onDidChange);

    expect(service.updateCollectionData(collection.filePath, updatedData as any)).toBe(true);
    expect(service.getCollection(collection.id)?.data).toBe(updatedData);
    expect(onDidChange).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('includes pinned collection roots when polling for YAML changes', async () => {
    const root = makeTempDir();
    mockWorkspaceReadDirectory();
    writeYaml(path.join(root, 'opencollection.yml'), `
      opencollection: "1.0.0"
      info: { name: Pinned }
    `);
    const service = new CollectionService();
    const collection = makeCollection(root);
    (service as any)._activePinnedCollections.set(collection.id, collection);

    const findFiles = vi.fn(async () => []);
    (workspace as any).findFiles = findFiles;
    workspace.fs.stat = vi.fn(async (uri: { fsPath: string }) => ({ mtime: fs.statSync(uri.fsPath).mtimeMs })) as any;

    const fingerprint = await (service as any)._computeFingerprintScoped();

    expect(findFiles).not.toHaveBeenCalled();
    expect(fingerprint.replace(/\\/g, '/')).toContain(path.join(root, 'opencollection.yml').replace(/\\/g, '/'));
    service.dispose();
  });
});

describe('OpenCollection foundation type guards and parser routing', () => {
  it('classifies every schema item variant', () => {
    const http = { info: { type: 'http' }, http: { method: 'GET', url: 'https://example.com' } };
    const graphql = { info: { type: 'graphql' }, graphql: { url: 'https://example.com/graphql' } };
    const grpc = { info: { type: 'grpc' }, grpc: { url: 'localhost:50051', method: 'pkg.Service/Get' } };
    const websocket = { info: { type: 'websocket' }, websocket: { url: 'wss://example.com/socket' } };
    const folder = { info: { type: 'folder' }, items: [http] };
    const script = { type: 'script', script: 'export default async () => {};' };

    expect(isHttpRequest(http)).toBe(true);
    expect(isGraphQLRequest(graphql)).toBe(true);
    expect(isGrpcRequest(grpc)).toBe(true);
    expect(isWebSocketRequest(websocket)).toBe(true);
    expect(isFolder(folder)).toBe(true);
    expect(isScriptFile(script)).toBe(true);
    expect(isProtocolRequest(script)).toBe(false);
    expect(getItemKind(graphql)).toBe('graphql');
  });

  it('reads non-HTTP request files without casting them to HTTP', async () => {
    const root = makeTempDir();
    const graphQLPath = path.join(root, 'query.yml');
    writeYaml(graphQLPath, `
      info:
        name: Graph Query
        type: graphql
      graphql:
        method: POST
        url: https://example.com/graphql
        body:
          query: "{ viewer { login } }"
    `);

    const item = await readRequestFile(graphQLPath);

    expect(isGraphQLRequest(item)).toBe(true);
    expect(isHttpRequest(item)).toBe(false);
    expect((item as any).graphql.url).toBe('https://example.com/graphql');
  });
});

describe('OpenCollection unbundled scan and tree routing', () => {
  it('loads mixed protocol, folder, and script items from an unbundled directory', async () => {
    const root = makeTempDir();
    mockWorkspaceReadDirectory();
    writeYaml(path.join(root, 'http.yml'), `
      info: { name: HTTP, type: http, seq: 1 }
      http: { method: GET, url: "https://example.com" }
    `);
    writeYaml(path.join(root, 'graphql.yml'), `
      info: { name: GraphQL, type: graphql, seq: 2 }
      graphql: { method: POST, url: "https://example.com/graphql" }
    `);
    writeYaml(path.join(root, 'grpc.yml'), `
      info: { name: gRPC, type: grpc, seq: 3 }
      grpc: { url: "localhost:50051", method: "demo.Users/GetUser", methodType: unary }
    `);
    writeYaml(path.join(root, 'websocket.yml'), `
      info: { name: Socket, type: websocket, seq: 4 }
      websocket: { url: "wss://example.com/socket" }
    `);
    writeYaml(path.join(root, 'script.yml'), `
      type: script
      script: |
        export default async () => {};
    `);
    writeYaml(path.join(root, 'Folder', 'folder.yml'), `
      info: { name: Nested, type: folder, seq: 5 }
    `);
    writeYaml(path.join(root, 'Folder', 'child.yml'), `
      info: { name: Child, type: http }
      http: { method: POST, url: "https://example.com/child" }
    `);

    const service = new CollectionService();
    (service as any)._migrationPromptShown = true;
    const items = await service.resolveItems(makeCollection(root));
    service.dispose();

    expect(items.map(getItemKind)).toEqual(['http', 'graphql', 'grpc', 'websocket', 'folder', 'script']);
    const folder = items.find(isFolder);
    expect(folder?.info?.name).toBe('Nested');
    expect(folder?.items?.map(getItemKind)).toEqual(['http']);
  });

  it('renders protocol-aware tree nodes instead of HTTP placeholders', async () => {
    const collection = makeCollection(makeTempDir());
    const items = [
      { info: { name: 'HTTP', type: 'http' as const }, http: { method: 'GET', url: 'https://example.com' } },
      { info: { name: 'GraphQL', type: 'graphql' as const }, graphql: { url: 'https://example.com/graphql' } },
      { info: { name: 'Socket', type: 'websocket' as const }, websocket: { url: 'wss://example.com/socket' } },
      { info: { name: 'gRPC', type: 'grpc' as const }, grpc: { url: 'localhost:50051', method: 'demo.Service/Call' } },
      { type: 'script' as const, script: 'export default async () => {};' },
    ];
    const provider = new CollectionTreeProvider({
      onDidChange: () => ({ dispose: () => {} }),
      getCollections: () => [collection],
      resolveItems: vi.fn().mockResolvedValue(items),
    } as any);

    const roots = await provider.getChildren();
    const children = await provider.getChildren(roots[0] as any);

    expect(children.map(node => (node as any).contextValue)).toEqual([
      'httpRequest',
      'graphqlRequest',
      'websocketRequest',
      'grpcRequest',
      'scriptFile',
    ]);
    expect(children.map(node => (node as any).description)).toEqual(['GET', 'POST', 'WS', 'gRPC', 'SCRIPT']);
    provider.dispose();
  });
});

describe('RequestExecutionService protocol dispatch', () => {
  it('delegates HTTP execution to HttpClient unchanged', async () => {
    const response = { status: 200, statusText: 'OK', headers: {}, body: 'ok', duration: 1, size: 2 };
    const httpClient = {
      send: vi.fn().mockResolvedValue(response),
      buildResolvedRequest: vi.fn(),
      cancelAll: vi.fn(),
    };
    const service = new RequestExecutionService(httpClient as any);
    const request = { info: { type: 'http' as const }, http: { method: 'GET', url: 'https://example.com' } };

    await expect(service.send(request, makeCollection(os.tmpdir()))).resolves.toBe(response);
    expect(httpClient.send).toHaveBeenCalledWith(
      request,
      expect.any(Object),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('throws protocol-specific diagnostics for unsupported protocols', async () => {
    const service = new RequestExecutionService({ send: vi.fn(), buildResolvedRequest: vi.fn(), cancelAll: vi.fn() } as any);
    const request = { info: { type: 'grpc' as const }, grpc: { url: 'localhost:50051', method: 'demo.Service/Call' } };

    await expect(service.send(request, makeCollection(os.tmpdir()))).rejects.toMatchObject({
      name: 'UnsupportedProtocolError',
      code: 'MISSIO_UNSUPPORTED_PROTOCOL',
      diagnostic: { protocol: 'grpc', taskId: 'OC-030' },
    } satisfies Partial<UnsupportedProtocolError>);
  });
});

describe('OpenCollection validation routing', () => {
  it('validates protocol request files against their protocol subschema', async () => {
    const root = makeTempDir();
    writeYaml(path.join(root, 'bad-graphql.yml'), `
      info: { name: Bad GraphQL, type: graphql }
      graphql: { url: "https://example.com/graphql" }
      http: { method: GET, url: "https://wrong-schema.example.com" }
    `);

    const report = await validateCollection(root, path.resolve('schema', 'opencollectionschema.json'));

    expect(report.failCount).toBe(1);
    expect(report.issues[0].schemaLabel).toBe('GraphQLRequest');
    expect(report.issues[0].errors.some(error => error.message.includes('additional'))).toBe(true);
  });
});

describe('protocol diagnostics in user-facing execution surfaces', () => {
  it('returns structured unsupported diagnostics from the Copilot send tool for protocols without executors', async () => {
    const collection = makeCollection(os.tmpdir());
    const requestExecutionService = new RequestExecutionService({
      send: vi.fn(),
      buildResolvedRequest: vi.fn(),
      cancelAll: vi.fn(),
    } as any);
    const tool = new SendRequestTool(
      {
        loadRequestFile: async () => ({
          info: { name: 'gRPC Call', type: 'grpc' },
          grpc: { url: 'localhost:50051', method: 'demo.Service/Call' },
        }),
        getCollection: () => collection,
      } as any,
      {} as any,
      requestExecutionService,
    );

    const output = await tool.call(
      { input: { requestFilePath: path.join(os.tmpdir(), 'query.yml'), collectionId: collection.id } } as any,
      {} as any,
    );

    expect(JSON.parse(output)).toMatchObject({
      success: false,
      code: 'MISSIO_UNSUPPORTED_PROTOCOL',
      protocol: 'grpc',
      taskId: 'OC-030',
    });
  });

  it('does not autosave an HTTP-shaped edit over protocol documents without an editor', async () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const applyEdit = vi.fn().mockResolvedValue(true);
    workspace.applyEdit = applyEdit;

    await (provider as any)._applyDocumentEdit(
      {
        uri: { fsPath: path.join(os.tmpdir(), 'query.yml') },
        lineCount: 4,
        getText: () => `
          info: { name: gRPC, type: grpc }
          grpc: { url: "localhost:50051", method: "demo.Service/Call" }
        `,
      },
      {
        request: {
          info: { type: 'http' },
          http: { method: 'GET', url: 'https://example.com' },
        },
      },
    );

    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('allows schema-native GraphQL edits through the request editor', async () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const applyEdit = vi.fn().mockResolvedValue(true);
    workspace.applyEdit = applyEdit;

    await (provider as any)._applyDocumentEdit(
      {
        uri: { fsPath: path.join(os.tmpdir(), 'query.yml') },
        lineCount: 8,
        getText: () => `
          info: { name: GraphQL, type: graphql }
          graphql:
            url: "https://example.com/graphql"
            body:
              query: "query Health { health { status } }"
        `,
      },
      {
        request: {
          info: { name: 'GraphQL', type: 'graphql' },
          graphql: {
            url: 'https://example.com/graphql',
            body: { query: 'query Health { health { status service } }', variables: '{}' },
          },
        },
      },
    );

    expect(applyEdit).toHaveBeenCalledOnce();
  });
});
