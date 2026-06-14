import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import { MissioCodeLensProvider } from '../src/providers/codeLensProvider';
import { ListRequestsTool } from '../src/copilot/tools/listRequestsTool';
import { SendRequestTool } from '../src/copilot/tools/sendRequestTool';
import { HttpClient } from '../src/services/httpClient';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import { detectUnresolvedVars } from '../src/services/unresolvedVars';
import { buildGraphQLHttpRequest, describeGraphQLOperation } from '../src/services/graphqlSupport';
import { validateCollection } from '../src/services/validationService';
import type { GraphQLRequest, MissioCollection } from '../src/models/types';

const servers: http.Server[] = [];

function interpolate(template: string, vars: Map<string, string>): string {
  return template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, name) => vars.get(name) ?? match);
}

function interpolateJson(template: string, vars: Map<string, string>): string {
  return interpolate(template, vars);
}

function makeEnvService(vars: Record<string, string>) {
  const map = new Map(Object.entries(vars));
  return {
    resolveVariables: vi.fn().mockResolvedValue(new Map(map)),
    resolveVariablesWithSource: vi.fn().mockResolvedValue(
      new Map([...map].map(([key, value]) => [key, { value, source: 'environment' }])),
    ),
    interpolate,
    interpolateJson,
    getActiveEnvironmentName: () => undefined,
  } as any;
}

function makeCollection(rootDir = process.cwd()): MissioCollection {
  return {
    id: 'graphql-test',
    filePath: path.join(rootDir, 'opencollection.yml'),
    rootDir,
    data: {
      opencollection: '1.0.0',
      info: { name: 'GraphQL Test' },
      request: {},
      config: { environments: [] },
    },
  } as MissioCollection;
}

async function startGraphQLFixture(): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/graphql') {
        res.writeHead(404).end();
        return;
      }

      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const operation = String(payload.query).trim().toLowerCase().startsWith('mutation') ? 'mutation' : 'query';
      const body = JSON.stringify({
        data: operation === 'mutation'
          ? { createDemoNote: { id: 'note-1', title: payload.variables.title, saved: true } }
          : { user: { id: payload.variables.id, name: 'Grace Hopper' } },
        extensions: {
          operation,
          echoedVariables: payload.variables,
          header: req.headers['x-demo-token'] ?? null,
        },
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind to a port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('GraphQL request adapter and execution', () => {
  it('selects GraphQL body variants and adapts them to JSON-over-HTTP', () => {
    const request: GraphQLRequest = {
      info: { name: 'Variants', type: 'graphql' },
      graphql: {
        method: 'POST',
        url: '{{baseUrl}}/graphql',
        body: [
          {
            title: 'Query',
            body: { query: 'query Users { users { id } }', variables: '{}' },
          },
          {
            title: 'Mutation',
            selected: true,
            body: {
              query: 'mutation Save($title: String!) { createDemoNote(title: $title) { id } }',
              variables: '{"title":"Hello"}',
            },
          },
        ],
      },
    };

    const adapted = buildGraphQLHttpRequest(request);
    const body = JSON.parse((adapted.http?.body as any).data);

    expect(describeGraphQLOperation(request)).toBe('MUTATION');
    expect(adapted.http?.method).toBe('POST');
    expect(body).toEqual({
      query: 'mutation Save($title: String!) { createDemoNote(title: $title) { id } }',
      variables: { title: 'Hello' },
    });
  });

  it('executes GraphQL query and mutation requests through RequestExecutionService', async () => {
    const baseUrl = await startGraphQLFixture();
    const envService = makeEnvService({ baseUrl, userId: '2', title: 'From test' });
    const service = new RequestExecutionService(new HttpClient(envService));
    const collection = makeCollection();

    const queryRequest: GraphQLRequest = {
      info: { name: 'User query', type: 'graphql' },
      graphql: {
        method: 'POST',
        url: '{{baseUrl}}/graphql',
        headers: [{ name: 'X-Demo-Token', value: 'abc' }],
        body: {
          query: 'query DemoUser($id: ID!) { user(id: $id) { id name } }',
          variables: '{"id":"{{userId}}"}',
        },
      },
    };
    const mutationRequest: GraphQLRequest = {
      info: { name: 'Create note', type: 'graphql' },
      graphql: {
        url: '{{baseUrl}}/graphql',
        body: {
          query: 'mutation Save($title: String!) { createDemoNote(title: $title) { id title saved } }',
          variables: '{"title":"{{title}}"}',
        },
      },
    };

    const resolved = await service.buildResolvedRequest(queryRequest, collection);
    expect(resolved.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(resolved.body)).variables).toEqual({ id: '2' });

    const queryResponse = await service.send(queryRequest, collection);
    expect(JSON.parse(queryResponse.body)).toMatchObject({
      data: { user: { id: '2', name: 'Grace Hopper' } },
      extensions: { echoedVariables: { id: '2' }, header: 'abc' },
    });

    const mutationResponse = await service.send(mutationRequest, collection);
    expect(JSON.parse(mutationResponse.body)).toMatchObject({
      data: { createDemoNote: { title: 'From test', saved: true } },
      extensions: { operation: 'mutation' },
    });
  });

  it('reports invalid GraphQL variables before sending malformed JSON', async () => {
    const service = new RequestExecutionService(new HttpClient(makeEnvService({})));
    const request: GraphQLRequest = {
      info: { name: 'Bad variables', type: 'graphql' },
      graphql: {
        url: 'http://127.0.0.1/graphql',
        body: { query: 'query Bad { users { id } }', variables: '{ nope' },
      },
    };

    await expect(service.buildResolvedRequest(request, makeCollection())).rejects.toThrow(/GraphQL variables must be valid JSON/);
  });
});

describe('GraphQL editing and tooling routes', () => {
  it('detects unresolved variables in GraphQL URL, headers, params, query, variables, and auth', async () => {
    const request: GraphQLRequest = {
      info: { name: 'Needs vars', type: 'graphql' },
      graphql: {
        method: 'POST',
        url: '{{baseUrl}}/graphql/:tenant',
        params: [
          { name: 'tenant', value: '{{tenantId}}', type: 'path' },
          { name: 'include', value: '{{includeInactive}}', type: 'query' },
        ],
        headers: [{ name: 'X-Trace', value: '{{traceId}}' }],
        body: {
          query: 'query User { user(id: "{{userId}}") { id } }',
          variables: '{"id":"{{userId}}","limit":"{{limit}}"}',
        },
      },
      runtime: { auth: { type: 'bearer', token: '{{token}}' } },
    };

    const unresolved = await detectUnresolvedVars(
      request,
      makeCollection(),
      makeEnvService({ baseUrl: 'http://localhost:3456', userId: '1' }),
    );

    expect(unresolved.sort()).toEqual(['includeInactive', 'limit', 'tenantId', 'token', 'traceId']);
  });

  it('provides GraphQL CodeLens send and operation labels', () => {
    const provider = new MissioCodeLensProvider();
    const lenses = provider.provideCodeLenses({
      uri: { fsPath: 'query.yml' },
      getText: () => `
info: { name: Save, type: graphql }
graphql:
  url: "{{baseUrl}}/graphql"
  body:
    query: "mutation Save { createDemoNote { id } }"
`,
    } as any);

    expect(lenses.map(lens => lens.command?.title)).toEqual([
      'Send GraphQL',
      'GRAPHQL MUTATION {{baseUrl}}/graphql',
    ]);
    provider.dispose();
  });

  it('lists GraphQL requests and template variables from Copilot list_requests', async () => {
    const request: GraphQLRequest = {
      info: { name: 'User query', type: 'graphql' },
      graphql: {
        url: '{{baseUrl}}/graphql',
        body: {
          query: 'query User { user(id: "{{userId}}") { id } }',
          variables: '{"id":"{{userId}}"}',
        },
      },
    };
    const tool = new ListRequestsTool({
      resolveCollection: () => makeCollection(),
      resolveItems: async () => [request],
    } as any);

    const output = await tool.call({ input: {} } as any, {} as any);
    const parsed = JSON.parse(output);

    expect(parsed.requests[0]).toMatchObject({
      name: 'User query',
      protocol: 'graphql',
      method: 'QUERY',
      url: '{{baseUrl}}/graphql',
      templateVariables: {
        baseUrl: ['url'],
        userId: ['body'],
      },
    });
  });

  it('dry-runs and sends GraphQL requests from Copilot send_request', async () => {
    const baseUrl = await startGraphQLFixture();
    const collection = makeCollection();
    const request: GraphQLRequest = {
      info: { name: 'User query', type: 'graphql' },
      graphql: {
        url: '{{baseUrl}}/graphql',
        body: {
          query: 'query DemoUser($id: ID!) { user(id: $id) { id name } }',
          variables: '{"id":"{{userId}}"}',
        },
      },
    };
    const envService = makeEnvService({ baseUrl, userId: '2' });
    const tool = new SendRequestTool(
      {
        loadRequestFile: async () => request,
        getCollection: () => collection,
        getCollections: () => [collection],
      } as any,
      envService,
      new RequestExecutionService(new HttpClient(envService)),
    );

    const dryRun = JSON.parse(await tool.call(
      { input: { requestFilePath: path.join(collection.rootDir, 'query.yml'), collectionId: collection.id, dryRun: true } } as any,
      {} as any,
    ));
    expect(dryRun).toMatchObject({
      success: true,
      dryRun: true,
      method: 'POST',
      url: `${baseUrl}/graphql`,
    });
    expect(JSON.parse(dryRun.body).variables).toEqual({ id: '2' });

    const live = JSON.parse(await tool.call(
      { input: { requestFilePath: path.join(collection.rootDir, 'query.yml'), collectionId: collection.id } } as any,
      {} as any,
    ));
    expect(live).toMatchObject({
      success: true,
      status: 200,
    });
    expect(JSON.parse(live.body).data.user.id).toBe('2');
  });

  it('keeps the demo API collection schema-valid with GraphQL requests', async () => {
    const report = await validateCollection(
      path.resolve('examples', 'demo-api'),
      path.resolve('schema', 'opencollectionschema.json'),
    );

    expect(report.issues).toEqual([]);
  });
});
