import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { detectUnresolvedVars } from '../src/services/unresolvedVars';
import { EnvironmentService } from '../src/services/environmentService';
import type { HttpRequest, MissioCollection, RequestDefaults } from '../src/models/types';

// ── Helpers ──────────────────────────────────────────────────────────

let testCollectionRoot = '';

function mockContext(): any {
  const state: Record<string, any> = {};
  return {
    workspaceState: {
      get: (key: string, defaultValue?: any) => state[key] ?? defaultValue,
      update: async (key: string, value: any) => { state[key] = value; },
    },
    globalState: {
      get: (key: string, defaultValue?: any) => state[key] ?? defaultValue,
      update: async (key: string, value: any) => { state[key] = value; },
    },
  };
}

function mockSecretService(): any {
  return { resolveSecret: async () => undefined };
}

function makeCollection(vars?: { name: string; value: string }[], auth?: any): MissioCollection {
  return {
    id: 'test-collection',
    filePath: path.join(testCollectionRoot, 'collection.yml'),
    rootDir: testCollectionRoot,
    data: {
      opencollection: '1.0.0',
      info: { name: 'Test' },
      request: {
        variables: vars ?? [],
        auth,
      },
      config: { environments: [] },
    },
  } as any;
}

function makeRequest(overrides: Partial<HttpRequest['http']> = {}): HttpRequest {
  return {
    http: {
      method: 'GET',
      url: 'https://example.com',
      ...overrides,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('detectUnresolvedVars', () => {
  let service: EnvironmentService;

  beforeEach(() => {
    testCollectionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-test-uv-'));
    fs.writeFileSync(path.join(testCollectionRoot, 'collection.yml'), 'opencollection: "1.0.0"\n', 'utf-8');
    service = new EnvironmentService(mockContext(), mockSecretService());
  });

  afterEach(() => {
    if (testCollectionRoot) fs.rmSync(testCollectionRoot, { recursive: true, force: true });
  });

  // ── Basic cases ───────────────────────────────────────────────────

  it('returns empty array when no variables are referenced', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com/api' }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  it('returns empty array when all variables are resolved', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://{{host}}/api' }),
      makeCollection([{ name: 'host', value: 'example.com' }]),
      service,
    );
    expect(result).toEqual([]);
  });

  it('detects a directly unresolved variable in the URL', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://{{host}}/api' }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['host']);
  });

  it('detects multiple unresolved variables', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://{{host}}/{{version}}/{{path}}' }),
      makeCollection([{ name: 'host', value: 'example.com' }]),
      service,
    );
    expect(result).toContain('version');
    expect(result).toContain('path');
    expect(result).not.toContain('host');
    expect(result).toHaveLength(2);
  });

  it('returns empty when http details are missing', async () => {
    const result = await detectUnresolvedVars({ }, makeCollection(), service);
    expect(result).toEqual([]);
  });

  // ── Builtins & secrets ────────────────────────────────────────────

  it('skips builtin $guid', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com/{{$guid}}' }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  it('skips builtin $timestamp', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com/{{$timestamp}}' }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  it('skips builtin $randomInt', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com/{{$randomInt}}' }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  it('skips $secret.* references', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com?key={{$secret.vault.apiKey}}' }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  it('detects unresolved vars alongside builtins and secrets', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://{{host}}/{{$guid}}?key={{$secret.v.k}}&v={{missing}}' }),
      makeCollection([{ name: 'host', value: 'example.com' }]),
      service,
    );
    expect(result).toEqual(['missing']);
  });

  // ── Nested / chained variables ────────────────────────────────────

  it('detects unresolved nested variable (1 level)', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: '{{api_url}}/users' }),
      makeCollection([
        { name: 'api_url', value: 'https://{{host}}/api' },
      ]),
      service,
    );
    expect(result).toEqual(['host']);
  });

  it('detects unresolved nested variable (2 levels deep)', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: '{{api_url}}/users' }),
      makeCollection([
        { name: 'api_url', value: '{{base}}/api' },
        { name: 'base', value: 'https://{{host}}' },
      ]),
      service,
    );
    expect(result).toEqual(['host']);
  });

  it('detects multiple unresolved vars across nesting levels', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: '{{api_url}}/{{resource}}' }),
      makeCollection([
        { name: 'api_url', value: 'https://{{host}}/{{version}}' },
      ]),
      service,
    );
    expect(result).toContain('host');
    expect(result).toContain('version');
    expect(result).toContain('resource');
    expect(result).toHaveLength(3);
  });

  it('does not loop on self-referencing variables', async () => {
    // Self-references stay as-is in resolution, should not cause infinite loop
    const result = await detectUnresolvedVars(
      makeRequest({ url: '{{a}}/test' }),
      makeCollection([
        { name: 'a', value: '{{a}}' }, // self-reference
      ]),
      service,
    );
    // 'a' is resolved (has a value, even if it contains itself), no unresolved
    expect(result).toEqual([]);
  });

  it('handles circular references without looping', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({ url: '{{a}}/test' }),
      makeCollection([
        { name: 'a', value: '{{b}}' },
        { name: 'b', value: '{{a}}' },
      ]),
      service,
    );
    // Both are resolved (they have values), just circular — no unresolved
    expect(result).toEqual([]);
  });

  // ── Headers ───────────────────────────────────────────────────────

  it('detects unresolved vars in header names', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        headers: [{ name: '{{headerName}}', value: 'val' }],
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['headerName']);
  });

  it('detects unresolved vars in header values', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        headers: [{ name: 'Authorization', value: 'Bearer {{token}}' }],
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['token']);
  });

  it('skips disabled headers', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        headers: [{ name: 'X-Key', value: '{{secret}}', disabled: true }],
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  // ── Params ────────────────────────────────────────────────────────

  it('detects unresolved vars in param names and values', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        params: [
          { name: '{{paramName}}', value: '{{paramValue}}', type: 'query' },
        ],
      }),
      makeCollection(),
      service,
    );
    expect(result).toContain('paramName');
    expect(result).toContain('paramValue');
  });

  it('skips disabled params', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        params: [
          { name: 'key', value: '{{val}}', type: 'query', disabled: true },
        ],
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  // ── Body ──────────────────────────────────────────────────────────

  it('detects unresolved vars in JSON body', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        body: { type: 'json', data: '{"key": "{{jsonVar}}"}' },
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['jsonVar']);
  });

  it('detects unresolved vars in text body', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        body: { type: 'text', data: 'Hello {{name}}' },
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['name']);
  });

  it('detects unresolved vars in XML body', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        body: { type: 'xml', data: '<root>{{xmlVar}}</root>' },
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['xmlVar']);
  });

  it('detects unresolved vars in form-urlencoded body', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        body: {
          type: 'form-urlencoded',
          data: [
            { name: '{{formKey}}', value: '{{formVal}}' },
          ],
        },
      }),
      makeCollection(),
      service,
    );
    expect(result).toContain('formKey');
    expect(result).toContain('formVal');
  });

  it('detects unresolved vars in multipart-form body', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        body: {
          type: 'multipart-form',
          data: [
            { name: '{{fieldName}}', type: 'text', value: '{{fieldVal}}' },
          ],
        },
      }),
      makeCollection(),
      service,
    );
    expect(result).toContain('fieldName');
    expect(result).toContain('fieldVal');
  });

  it('skips disabled form entries', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        body: {
          type: 'form-urlencoded',
          data: [
            { name: '{{key}}', value: '{{val}}', disabled: true },
          ],
        },
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  it('detects unresolved vars in body variant (selected)', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        body: [
          { title: 'JSON', selected: true, body: { type: 'json', data: '{{payload}}' } },
          { title: 'Text', body: { type: 'text', data: '{{other}}' } },
        ] as any,
      }),
      makeCollection(),
      service,
    );
    // Only the selected variant is scanned
    expect(result).toEqual(['payload']);
  });

  it('falls back to first body variant when none selected', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        body: [
          { title: 'JSON', body: { type: 'json', data: '{{first}}' } },
          { title: 'Text', body: { type: 'text', data: '{{second}}' } },
        ] as any,
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['first']);
  });

  // ── Auth ──────────────────────────────────────────────────────────

  it('detects unresolved vars in basic auth fields', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        auth: { type: 'basic', username: '{{user}}', password: '{{pass}}' },
      }),
      makeCollection(),
      service,
    );
    expect(result).toContain('user');
    expect(result).toContain('pass');
  });

  it('detects unresolved vars in bearer auth', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        auth: { type: 'bearer', token: '{{bearerToken}}' },
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['bearerToken']);
  });

  it('detects unresolved vars in OAuth2 auth fields', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        auth: {
          type: 'oauth2',
          flow: 'client_credentials',
          accessTokenUrl: '{{tokenUrl}}',
          clientId: '{{clientId}}',
          clientSecret: '{{clientSecret}}',
        },
      }),
      makeCollection(),
      service,
    );
    expect(result).toContain('tokenUrl');
    expect(result).toContain('clientId');
    expect(result).toContain('clientSecret');
  });

  it('detects unresolved vars in apikey auth', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        auth: { type: 'apikey', key: '{{keyName}}', value: '{{keyValue}}' },
      }),
      makeCollection(),
      service,
    );
    expect(result).toContain('keyName');
    expect(result).toContain('keyValue');
  });

  it('does not scan auth when set to inherit', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        auth: 'inherit',
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual([]);
  });

  // ── Inherited auth chain ──────────────────────────────────────────

  it('scans folder-level auth when request auth is inherit', async () => {
    const folderDefaults: RequestDefaults = {
      auth: { type: 'bearer', token: '{{folderToken}}' },
    };
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com', auth: 'inherit' }),
      makeCollection(),
      service,
      folderDefaults,
    );
    expect(result).toEqual(['folderToken']);
  });

  it('scans collection-level auth when request and folder auth are inherit', async () => {
    const folderDefaults: RequestDefaults = { auth: 'inherit' };
    const collection = makeCollection([], { type: 'bearer', token: '{{collectionToken}}' });
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com', auth: 'inherit' }),
      collection,
      service,
      folderDefaults,
    );
    expect(result).toEqual(['collectionToken']);
  });

  it('scans collection-level auth when request has no auth and no folder defaults', async () => {
    const collection = makeCollection([], { type: 'basic', username: '{{user}}', password: '{{pass}}' });
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com' }),
      collection,
      service,
    );
    expect(result).toContain('user');
    expect(result).toContain('pass');
  });

  it('does not scan inherited auth when request has its own auth', async () => {
    const folderDefaults: RequestDefaults = {
      auth: { type: 'bearer', token: '{{folderToken}}' },
    };
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        auth: { type: 'bearer', token: '{{requestToken}}' },
      }),
      makeCollection(),
      service,
      folderDefaults,
    );
    expect(result).toEqual(['requestToken']);
    expect(result).not.toContain('folderToken');
  });

  // ── Deduplication ─────────────────────────────────────────────────

  it('deduplicates the same unresolved variable appearing in multiple places', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://{{host}}/api',
        headers: [{ name: 'Host', value: '{{host}}' }],
        params: [{ name: 'h', value: '{{host}}', type: 'query' }],
      }),
      makeCollection(),
      service,
    );
    expect(result).toEqual(['host']);
  });

  // ── Mixed resolved + unresolved ───────────────────────────────────

  it('only returns unresolved vars, not resolved ones', async () => {
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://{{host}}/{{version}}/{{resource}}',
        headers: [{ name: 'Authorization', value: 'Bearer {{token}}' }],
      }),
      makeCollection([
        { name: 'host', value: 'example.com' },
        { name: 'token', value: 'abc123' },
      ]),
      service,
    );
    expect(result).toContain('version');
    expect(result).toContain('resource');
    expect(result).not.toContain('host');
    expect(result).not.toContain('token');
    expect(result).toHaveLength(2);
  });
});
