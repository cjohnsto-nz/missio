import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, MissioCollection } from '../src/models/types';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import { RuntimeExecutionService } from '../src/services/runtimeExecutionService';

function makeCollection(): MissioCollection {
  return {
    id: 'runtime-variable-security',
    filePath: 'C:/runtime-variable-security/opencollection.yml',
    rootDir: 'C:/runtime-variable-security',
    data: {
      opencollection: '1.0.0',
      info: { name: 'Runtime variable security' },
      request: {},
      config: { environments: [] },
    },
  } as MissioCollection;
}

function makeResponse(): HttpResponse {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{}',
    duration: 1,
    size: 2,
  };
}

describe('runtime script variable security', () => {
  it('resolves same-name request variables from their base scope', async () => {
    const runtime = new RuntimeExecutionService(async () => new Map([['owner', 'base']]));
    const request: HttpRequest = {
      http: { method: 'GET', url: 'https://example.com/{{owner}}' },
      runtime: { variables: [{ name: 'owner', value: '{{owner}}-request' }] },
    };

    const variables = await runtime.buildRequestVariableOverrides(request, makeCollection());

    expect(variables?.get('owner')).toBe('base-request');
  });

  it('resolves acyclic request-variable chains deeper than ten references', async () => {
    const runtime = new RuntimeExecutionService();
    const request: HttpRequest = {
      http: { method: 'GET', url: 'https://example.com/{{value0}}' },
      runtime: {
        variables: Array.from({ length: 12 }, (_, index) => ({
          name: `value${index}`,
          value: index === 11 ? 'resolved' : `{{value${index + 1}}}`,
        })),
      },
    };

    const variables = await runtime.buildRequestVariableOverrides(request, makeCollection());

    expect(variables?.get('value0')).toBe('resolved');
  });

  it('reports cyclic request-variable references instead of leaving partial values', async () => {
    const runtime = new RuntimeExecutionService();
    const request: HttpRequest = {
      http: { method: 'GET', url: 'https://example.com' },
      runtime: {
        variables: [
          { name: 'first', value: '{{second}}' },
          { name: 'second', value: '{{first}}' },
        ],
      },
    };

    await expect(runtime.buildRequestVariableOverrides(request, makeCollection()))
      .rejects.toThrow('Cyclic runtime variable reference: first, second');
  });

  it('uses the same base-aware request-variable scope for dry-run and send', async () => {
    let dryRunVariables: Map<string, string> | undefined;
    let sendVariables: Map<string, string> | undefined;
    const httpClient = {
      buildResolvedRequest: async (
        _request: HttpRequest,
        _collection: MissioCollection,
        _folderDefaults: unknown,
        variables?: Map<string, string>,
      ) => {
        dryRunVariables = variables;
        return { method: 'GET', url: 'https://example.com', headers: {} };
      },
      send: async (
        _request: HttpRequest,
        _collection: MissioCollection,
        _folderDefaults: unknown,
        _onProgress: unknown,
        variables?: Map<string, string>,
      ) => {
        sendVariables = variables;
        return makeResponse();
      },
    } as any;
    const runtime = new RuntimeExecutionService(async () => new Map([['owner', 'base']]));
    const execution = new RequestExecutionService(httpClient, undefined, undefined, runtime);
    const request: HttpRequest = {
      http: { method: 'GET', url: 'https://example.com/{{owner}}' },
      runtime: { variables: [{ name: 'owner', value: '{{owner}}-request' }] },
    };

    await execution.buildResolvedRequest(request, makeCollection());
    await execution.send(request, makeCollection());

    expect(dryRunVariables?.get('owner')).toBe('base-request');
    expect(sendVariables?.get('owner')).toBe('base-request');
  });
});
