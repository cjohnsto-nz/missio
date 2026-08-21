import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stringify as stringifyYaml } from 'yaml';
import { formatReport, validateCollection } from '../src/services/validationService';

const schemaPath = path.resolve(__dirname, '..', 'schema', 'opencollectionschema.json');

function writeYaml(root: string, relativePath: string, data: unknown): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(data, { lineWidth: 120 }), 'utf-8');
}

describe('validationService', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-validation-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('validates collection, workspace, folder, script, and protocol request files', async () => {
    writeYaml(rootDir, 'opencollection.yml', {
      opencollection: '1.0.0',
      info: { name: 'Validation Fixtures' },
    });
    writeYaml(rootDir, 'workspace.yml', {
      workspace: '1.0.0',
      info: { name: 'Workspace', links: [{ name: 'docs', url: 'https://example.com/docs' }] },
      collections: [{ name: 'API', path: '.' }],
    });
    writeYaml(rootDir, 'folder.yml', {
      info: { name: 'Users', type: 'folder' },
      request: {
        metadata: [{ name: 'x-trace-id', value: '{{traceId}}' }],
        scripts: [{ type: 'before-request', code: 'console.log("folder");' }],
        settings: { http: { timeout: 5000 } },
      },
    });
    writeYaml(rootDir, 'get-users.yml', {
      info: { name: 'Get users', type: 'http' },
      http: { method: 'GET', url: 'https://api.example.com/users' },
    });
    writeYaml(rootDir, 'graphql-users.yml', {
      info: { name: 'GraphQL users', type: 'graphql' },
      graphql: {
        method: 'POST',
        url: 'https://api.example.com/graphql',
        body: { query: 'query Users { users { id } }', variables: '{"limit":10}' },
      },
    });
    writeYaml(rootDir, 'socket.yml', {
      info: { name: 'Socket ping', type: 'websocket' },
      websocket: { url: 'wss://api.example.com/socket', message: { type: 'text', data: 'ping' } },
    });
    writeYaml(rootDir, 'grpc-user.yml', {
      info: { name: 'Get user', type: 'grpc' },
      grpc: {
        url: 'grpc://api.example.com',
        method: 'users.UserService/GetUser',
        methodType: 'unary',
        message: '{"id":"42"}',
      },
    });
    writeYaml(rootDir, 'shared-script.yml', {
      type: 'script',
      script: 'export default async function () {}',
    });

    const report = await validateCollection(rootDir, schemaPath);

    expect(report.totalFiles).toBe(8);
    expect(report.passCount).toBe(8);
    expect(report.failCount).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it('uses protocol-aware request schemas in diagnostics', async () => {
    writeYaml(rootDir, 'opencollection.yml', {
      opencollection: '1.0.0',
      info: { name: 'Invalid Protocol Fixtures' },
    });
    writeYaml(rootDir, 'bad-websocket.yml', {
      info: { name: 'Bad socket', type: 'websocket' },
      websocket: { url: 42, message: { type: 'text', data: 'ping' } },
    });
    writeYaml(rootDir, 'bad-graphql.yml', {
      info: { name: 'Bad GraphQL', type: 'graphql' },
      graphql: { url: 'https://api.example.com/graphql', body: { query: 7 } },
    });

    const report = await validateCollection(rootDir, schemaPath);

    expect(report.failCount).toBe(2);
    expect(report.issues.map(issue => issue.schemaLabel).sort()).toEqual([
      'GraphQLRequest',
      'WebSocketRequest',
    ]);
    expect(report.issues.some(issue => issue.schemaLabel === 'HttpRequest')).toBe(false);
    expect(formatReport(report)).toContain('bad-websocket.yml` (WebSocketRequest)');
    expect(formatReport(report)).toContain('bad-graphql.yml` (GraphQLRequest)');
  });

  it('includes workspace validation failures in collection reports', async () => {
    writeYaml(rootDir, 'opencollection.yml', {
      opencollection: '1.0.0',
      info: { name: 'Workspace Failure Fixtures' },
    });
    writeYaml(rootDir, 'workspace.yml', {
      workspace: '1.0.0',
      collections: [{ name: 'Missing path' }],
    });

    const report = await validateCollection(rootDir, schemaPath);
    const workspaceIssue = report.issues.find(issue => issue.file === 'workspace.yml');

    expect(report.totalFiles).toBe(2);
    expect(report.failCount).toBe(1);
    expect(workspaceIssue?.schemaLabel).toBe('OpenCollectionWorkspace');
    expect(workspaceIssue?.errors.some(error => error.message.includes("must have required property 'path'"))).toBe(true);
  });
});
