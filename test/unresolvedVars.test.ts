import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { detectUnresolvedVars } from '../src/services/unresolvedVars';
import { highlightVariables } from '../src/webview/varlib';
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

function makeCollection(vars?: { name: string; value: string }[], auth?: any, configOverrides?: any): MissioCollection {
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
      config: { environments: [], ...configOverrides },
    },
  } as any;
}

function makeRequest(overrides: Partial<HttpRequest['http']> & { auth?: any } = {}): HttpRequest {
  const { auth, ...httpOverrides } = overrides;
  return {
    http: {
      method: 'GET',
      url: 'https://example.com',
      ...httpOverrides,
    },
    ...(auth !== undefined ? { runtime: { auth } } : {}),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('unresolvedVars', () => {
  let service: EnvironmentService;

  beforeEach(() => {
    testCollectionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-test-uv-'));
    fs.writeFileSync(path.join(testCollectionRoot, 'collection.yml'), 'opencollection: "1.0.0"\n', 'utf-8');
    service = new EnvironmentService(mockContext(), mockSecretService());
  });

  afterEach(() => {
    if (testCollectionRoot) fs.rmSync(testCollectionRoot, { recursive: true, force: true });
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

  // ── forceAuthInherit ─────────────────────────────────────────────────

  it('forceAuthInherit: uses collection auth, ignoring request auth', async () => {
    const collection = makeCollection(
      [],
      { type: 'bearer', token: '{{collectionToken}}' },
      { forceAuthInherit: true },
    );
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        auth: { type: 'bearer', token: '{{requestToken}}' },
      }),
      collection,
      service,
    );
    expect(result).toEqual(['collectionToken']);
    expect(result).not.toContain('requestToken');
  });

  it('forceAuthInherit: uses collection auth, ignoring folder auth', async () => {
    const collection = makeCollection(
      [],
      { type: 'bearer', token: '{{collectionToken}}' },
      { forceAuthInherit: true },
    );
    const folderDefaults: RequestDefaults = {
      auth: { type: 'bearer', token: '{{folderToken}}' },
    };
    const result = await detectUnresolvedVars(
      makeRequest({ url: 'https://example.com', auth: 'inherit' }),
      collection,
      service,
      folderDefaults,
    );
    expect(result).toEqual(['collectionToken']);
    expect(result).not.toContain('folderToken');
  });

  it('forceAuthInherit: no unresolved vars when collection has no auth', async () => {
    const collection = makeCollection([], undefined, { forceAuthInherit: true });
    const result = await detectUnresolvedVars(
      makeRequest({
        url: 'https://example.com',
        auth: { type: 'bearer', token: '{{requestToken}}' },
      }),
      collection,
      service,
    );
    expect(result).toEqual([]);
  });

  it('masks resolved values when variable source is secret (indirect secret)', () => {
    const html = 'Header: {{headerref}}';
    const out = highlightVariables(html, {
      resolved: { headerref: 'super-secret' },
      sources: { headerref: 'secret' },
      showResolved: true,
      secretKeys: new Set(),
      secretVarNames: new Set(),
    });
    expect(out).not.toContain('super-secret');
    expect(out).toContain('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
  });
});
