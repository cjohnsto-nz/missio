import { describe, it, expect } from 'vitest';
import { SendRequestTool } from '../src/copilot/tools/sendRequestTool';
import type { HttpRequest, MissioCollection } from '../src/models/types';
import * as os from 'os';

function interpolate(template: string, vars: Map<string, string>): string {
  return template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, name) => vars.get(name) ?? m);
}

function makeCollection(): MissioCollection {
  return {
    id: 'collection-1',
    filePath: '/tmp/opencollection.yml',
    rootDir: '/tmp',
    data: {
      opencollection: '1.0.0',
      info: { name: 'Test' },
      request: {},
      config: { environments: [] },
    },
  } as MissioCollection;
}

describe('SendRequestTool dryRun redaction', () => {
  it('redacts sensitive auth and secret-derived values in dryRun output', async () => {
    const environmentService = {
      resolveVariablesWithSource: async () => new Map<string, { value: string; source: string }>([
        ['token', { value: 'super-secret-token', source: 'secret' }],
      ]),
      interpolate: (template: string, vars: Map<string, string>) => interpolate(template, vars),
      interpolateJson: (template: string, vars: Map<string, string>) => interpolate(template, vars),
    } as any;

    const tool = new SendRequestTool({} as any, environmentService, {} as any);

    const request: HttpRequest = {
      http: {
        method: 'POST',
        url: 'https://example.com/items?token={{token}}',
        headers: [{ name: 'X-Api-Key', value: '{{token}}' }],
        body: { type: 'json', data: '{"token":"{{token}}"}' },
      },
      runtime: {
        auth: { type: 'bearer', token: '{{token}}' },
      },
    };

    const output = await (tool as any)._dryRun(
      request,
      makeCollection(),
      undefined,
      undefined,
      undefined,
      [],
      [],
    );

    expect(output).not.toContain('super-secret-token');

    const parsed = JSON.parse(output);
    expect(parsed.headers.Authorization).toBe('Bearer [redacted]');
    expect(parsed.headers['X-Api-Key']).toBe('[redacted]');
    expect(parsed.url).toContain('token=%5Bredacted%5D');
    expect(parsed.body).toContain('[secret]');
  });
});

describe('SendRequestTool auth selection and path matching', () => {
  it('falls back to request auth when forceAuthInherit is enabled but collection auth is incomplete', () => {
    const collection = makeCollection();
    collection.data.request = { auth: { type: 'bearer', token: '' } } as any;
    collection.data.config = { environments: [], forceAuthInherit: true } as any;

    const request: HttpRequest = {
      http: { method: 'GET', url: 'https://example.com' },
      runtime: { auth: { type: 'bearer', token: '{{requestToken}}' } },
    };

    const tool = new SendRequestTool({} as any, {} as any, {} as any);
    const auth = (tool as any)._selectEffectiveAuth(request, collection, undefined);

    expect(auth).toEqual({ type: 'bearer', token: '{{requestToken}}' });
  });

  it('matches collection root for absolute paths with mixed separators', () => {
    const collection = { rootDir: '/tmp/my-collection' } as MissioCollection;
    const tool = new SendRequestTool(
      { getCollections: () => [collection] } as any,
      {} as any,
      {} as any,
    );

    const found = (tool as any)._findCollection('/tmp/my-collection\\Users\\get.yml');
    expect(found).toBe(collection);
  });
});

describe('SendRequestTool responseOutputPath behavior', () => {
  it('does not set savedTo when writing responseOutputPath fails and returns a warning', async () => {
    const collection = makeCollection();
    const tool = new SendRequestTool(
      {
        loadRequestFile: async () => ({ http: { method: 'GET', url: 'https://example.com' } }),
        getCollection: () => collection,
        getCollections: () => [collection],
      } as any,
      {
        resolveVariables: async () => new Map<string, string>(),
      } as any,
      {
        send: async () => ({
          status: 200,
          statusText: 'OK',
          headers: {},
          body: 'ok',
          duration: 1,
          size: 2,
        }),
      } as any,
    );

    const output = await tool.call(
      {
        input: {
          requestFilePath: '/tmp/request.yml',
          collectionId: 'collection-1',
          // Point at an existing directory so writeFileSync deterministically fails.
          responseOutputPath: os.tmpdir(),
        },
      } as any,
      {} as any,
    );

    const parsed = JSON.parse(output);
    expect(parsed.savedTo).toBeUndefined();
    expect(parsed.warnings?.[0]).toContain('Failed to write responseOutputPath');
  });
});
