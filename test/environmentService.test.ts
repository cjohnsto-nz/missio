import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EnvironmentService } from '../src/services/environmentService';
import type { MissioCollection } from '../src/models/types';

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
  return {
    resolveSecret: async (name: string) => {
      if (name === 'testSecret') return 'secret-value-123';
      return undefined;
    },
  };
}

function makeCollection(overrides?: Partial<MissioCollection>): MissioCollection {
  return {
    id: 'test-collection',
    filePath: path.join(testCollectionRoot, 'collection.yml'),
    rootDir: testCollectionRoot,
    data: {
      opencollection: '1.0.0',
      info: { name: 'Test Collection' },
      request: {
        variables: [
          { name: 'baseUrl', value: 'https://api.example.com' },
          { name: 'version', value: 'v1' },
          { name: 'fullBase', value: '{{baseUrl}}/{{version}}' },
          { name: 'disabledVar', value: 'should-not-appear', disabled: true },
        ],
        headers: [
          { name: 'X-Collection-Header', value: 'collection-value' },
        ],
        auth: { type: 'bearer', token: 'collection-token' },
      },
      config: {
        environments: [
          {
            name: 'dev',
            variables: [
              { name: 'apiKey', value: 'dev-key-123' },
              { name: 'baseUrl', value: 'https://dev.example.com' },
              { name: 'envOnly', value: 'from-env' },
            ],
          },
          {
            name: 'prod',
            variables: [
              { name: 'apiKey', value: 'prod-key-456' },
              { name: 'baseUrl', value: 'https://prod.example.com' },
            ],
          },
          {
            name: 'staging',
            extends: 'prod',
            variables: [
              { name: 'stagingOnly', value: 'staging-value' },
            ],
          },
          {
            name: 'with-dotenv',
            dotEnvFilePath: '.env',
            variables: [
              { name: 'apiKey', value: 'dotenv-override' },
            ],
          },
        ],
      },
      ...overrides?.data,
    },
    ...overrides,
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('EnvironmentService', () => {
  let service: EnvironmentService;
  let collection: MissioCollection;

  beforeEach(() => {
    testCollectionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-test-collection-'));
    fs.writeFileSync(path.join(testCollectionRoot, 'collection.yml'), 'opencollection: "1.0.0"\ninfo:\n  name: Test Collection\n', 'utf-8');
    fs.writeFileSync(path.join(testCollectionRoot, '.env'), 'DOTENV_VAR=from-dotenv\nQUOTED_VAR="quoted-value"\napiKey=dotenv-api-key\n', 'utf-8');

    service = new EnvironmentService(mockContext(), mockSecretService());
    collection = makeCollection();
  });

  afterEach(() => {
    if (testCollectionRoot) {
      fs.rmSync(testCollectionRoot, { recursive: true, force: true });
    }
  });

  // ── Collection-level variables ──────────────────────────────────

  describe('collection-level variables (no environment)', () => {
    it('resolves collection default variables', async () => {
      const vars = await service.resolveVariables(collection);
      expect(vars.get('baseUrl')).toBe('https://api.example.com');
      expect(vars.get('version')).toBe('v1');
    });

    it('excludes disabled variables', async () => {
      const vars = await service.resolveVariables(collection);
      expect(vars.has('disabledVar')).toBe(false);
    });

    it('resolves recursive variable references', async () => {
      const vars = await service.resolveVariables(collection);
      expect(vars.get('fullBase')).toBe('https://api.example.com/v1');
    });

    it('tracks collection source correctly', async () => {
      const vars = await service.resolveVariablesWithSource(collection);
      expect(vars.get('baseUrl')?.source).toBe('collection');
      expect(vars.get('version')?.source).toBe('collection');
      expect(vars.get('fullBase')?.source).toBe('collection');
    });
  });

  // ── Environment variables ──────────────────────────────────────

  describe('environment variables', () => {
    it('environment variables override collection variables', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariables(collection);
      expect(vars.get('baseUrl')).toBe('https://dev.example.com');
    });

    it('environment adds new variables not in collection', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariables(collection);
      expect(vars.get('apiKey')).toBe('dev-key-123');
      expect(vars.get('envOnly')).toBe('from-env');
    });

    it('collection variables persist when not overridden by environment', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariables(collection);
      expect(vars.get('version')).toBe('v1');
    });

    it('recursive interpolation works with mixed collection+env variables', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariables(collection);
      // fullBase = {{baseUrl}}/{{version}} → https://dev.example.com/v1
      expect(vars.get('fullBase')).toBe('https://dev.example.com/v1');
    });

    it('switching environments changes resolved values', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const devVars = await service.resolveVariables(collection);
      expect(devVars.get('baseUrl')).toBe('https://dev.example.com');
      expect(devVars.get('apiKey')).toBe('dev-key-123');

      await service.setActiveEnvironment('test-collection', 'prod');
      const prodVars = await service.resolveVariables(collection);
      expect(prodVars.get('baseUrl')).toBe('https://prod.example.com');
      expect(prodVars.get('apiKey')).toBe('prod-key-456');
    });

    it('tracks environment source correctly', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariablesWithSource(collection);
      expect(vars.get('baseUrl')?.source).toBe('environment');
      expect(vars.get('apiKey')?.source).toBe('environment');
      expect(vars.get('version')?.source).toBe('collection');
    });
  });

  // ── Environment extends ────────────────────────────────────────

  describe('environment extends (inheritance)', () => {
    it('inherits variables from parent environment', async () => {
      await service.setActiveEnvironment('test-collection', 'staging');
      const vars = await service.resolveVariables(collection);
      // staging extends prod, so should get prod's variables
      expect(vars.get('baseUrl')).toBe('https://prod.example.com');
      expect(vars.get('apiKey')).toBe('prod-key-456');
    });

    it('child environment variables take precedence over parent', async () => {
      await service.setActiveEnvironment('test-collection', 'staging');
      const vars = await service.resolveVariables(collection);
      expect(vars.get('stagingOnly')).toBe('staging-value');
    });

    it('collection variables still present with extends', async () => {
      await service.setActiveEnvironment('test-collection', 'staging');
      const vars = await service.resolveVariables(collection);
      expect(vars.get('version')).toBe('v1');
    });

    it('recursive interpolation works through extends chain', async () => {
      await service.setActiveEnvironment('test-collection', 'staging');
      const vars = await service.resolveVariables(collection);
      // fullBase = {{baseUrl}}/{{version}} → https://prod.example.com/v1
      expect(vars.get('fullBase')).toBe('https://prod.example.com/v1');
    });
  });

  // ── dotenv ─────────────────────────────────────────────────────

  describe('dotenv file loading', () => {
    it('loads variables from .env file', async () => {
      await service.setActiveEnvironment('test-collection', 'with-dotenv');
      const vars = await service.resolveVariables(collection);
      expect(vars.get('DOTENV_VAR')).toBe('from-dotenv');
    });

    it('strips quotes from dotenv values', async () => {
      await service.setActiveEnvironment('test-collection', 'with-dotenv');
      const vars = await service.resolveVariables(collection);
      expect(vars.get('QUOTED_VAR')).toBe('quoted-value');
    });

    it('environment variables override dotenv variables', async () => {
      await service.setActiveEnvironment('test-collection', 'with-dotenv');
      const vars = await service.resolveVariables(collection);
      // apiKey is in both .env (dotenv-api-key) and env vars (dotenv-override)
      // env vars come after dotenv, so they win
      expect(vars.get('apiKey')).toBe('dotenv-override');
    });

    it('tracks dotenv source correctly', async () => {
      await service.setActiveEnvironment('test-collection', 'with-dotenv');
      const vars = await service.resolveVariablesWithSource(collection);
      expect(vars.get('DOTENV_VAR')?.source).toBe('dotenv');
      expect(vars.get('apiKey')?.source).toBe('environment');
    });
  });

  // ── Recursive interpolation ────────────────────────────────────

  describe('recursive interpolation', () => {
    it('resolves single-level references', async () => {
      const vars = await service.resolveVariables(collection);
      expect(vars.get('fullBase')).toBe('https://api.example.com/v1');
    });

    it('resolves multi-level chained references', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        { name: 'host', value: 'example.com' },
        { name: 'scheme', value: 'https' },
        { name: 'origin', value: '{{scheme}}://{{host}}' },
        { name: 'apiBase', value: '{{origin}}/api' },
        { name: 'endpoint', value: '{{apiBase}}/users' },
      ];
      const vars = await service.resolveVariables(coll);
      expect(vars.get('origin')).toBe('https://example.com');
      expect(vars.get('apiBase')).toBe('https://example.com/api');
      expect(vars.get('endpoint')).toBe('https://example.com/api/users');
    });

    it('handles self-referencing variables without infinite loop', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        { name: 'selfRef', value: '{{selfRef}}-loop' },
      ];
      const vars = await service.resolveVariables(coll);
      // Self-reference should remain unresolved
      expect(vars.get('selfRef')).toBe('{{selfRef}}-loop');
    });

    it('handles circular references without infinite loop', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        { name: 'a', value: '{{b}}' },
        { name: 'b', value: '{{a}}' },
      ];
      // Should not throw, should stabilize
      const vars = await service.resolveVariables(coll);
      expect(vars.has('a')).toBe(true);
      expect(vars.has('b')).toBe(true);
    });

    it('leaves unresolved references as-is', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        { name: 'partial', value: '{{known}}/{{unknown}}' },
        { name: 'known', value: 'resolved' },
      ];
      const vars = await service.resolveVariables(coll);
      expect(vars.get('partial')).toBe('resolved/{{unknown}}');
    });

    it('recursive interpolation works with source tracking', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        { name: 'host', value: 'example.com' },
        { name: 'url', value: 'https://{{host}}/api' },
      ];
      const vars = await service.resolveVariablesWithSource(coll);
      expect(vars.get('url')?.value).toBe('https://example.com/api');
      expect(vars.get('url')?.source).toBe('collection');
    });
  });

  // ── interpolate() method ───────────────────────────────────────

  describe('interpolate()', () => {
    it('replaces known variables in a template string', () => {
      const vars = new Map([['host', 'example.com'], ['port', '8080']]);
      expect(service.interpolate('https://{{host}}:{{port}}/api', vars))
        .toBe('https://example.com:8080/api');
    });

    it('leaves unknown variables as-is', () => {
      const vars = new Map([['host', 'example.com']]);
      expect(service.interpolate('{{host}}/{{path}}', vars))
        .toBe('example.com/{{path}}');
    });

    it('handles whitespace inside braces', () => {
      const vars = new Map([['name', 'value']]);
      expect(service.interpolate('{{ name }}', vars)).toBe('value');
      expect(service.interpolate('{{  name  }}', vars)).toBe('value');
    });

    it('returns original string when no variables present', () => {
      const vars = new Map([['x', 'y']]);
      expect(service.interpolate('no variables here', vars)).toBe('no variables here');
    });

    it('handles empty string', () => {
      expect(service.interpolate('', new Map())).toBe('');
    });
  });

  // ── Variable value types ───────────────────────────────────────

  describe('variable value types', () => {
    it('resolves string values', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        { name: 'simple', value: 'hello' },
      ];
      const vars = await service.resolveVariables(coll);
      expect(vars.get('simple')).toBe('hello');
    });

    it('resolves VariableTypedValue (object with type+data)', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        { name: 'typed', value: { type: 'string', data: 'typed-value' } },
      ];
      const vars = await service.resolveVariables(coll);
      expect(vars.get('typed')).toBe('typed-value');
    });

    it('resolves VariableValueVariant[] (picks selected)', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        {
          name: 'variant',
          value: [
            { title: 'Option A', value: 'a-value' },
            { title: 'Option B', value: 'b-value', selected: true },
            { title: 'Option C', value: 'c-value' },
          ],
        },
      ];
      const vars = await service.resolveVariables(coll);
      expect(vars.get('variant')).toBe('b-value');
    });

    it('resolves VariableValueVariant[] (picks first when none selected)', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        {
          name: 'variant',
          value: [
            { title: 'Option A', value: 'a-value' },
            { title: 'Option B', value: 'b-value' },
          ],
        },
      ];
      const vars = await service.resolveVariables(coll);
      expect(vars.get('variant')).toBe('a-value');
    });

    it('handles undefined/null values gracefully', async () => {
      const coll = makeCollection();
      (coll.data as any).request.variables = [
        { name: 'noValue' },
        { name: 'nullValue', value: null },
      ];
      const vars = await service.resolveVariables(coll);
      expect(vars.has('noValue')).toBe(false);
      expect(vars.has('nullValue')).toBe(false);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles collection with no variables', async () => {
      const coll = makeCollection();
      delete (coll.data as any).request;
      const vars = await service.resolveVariables(coll);
      expect(vars.size).toBe(0);
    });

    it('handles collection with no environments', async () => {
      const coll = makeCollection();
      delete (coll.data as any).config;
      await service.setActiveEnvironment('test-collection', 'nonexistent');
      const vars = await service.resolveVariables(coll);
      // Should still have collection vars
      expect(vars.get('baseUrl')).toBe('https://api.example.com');
    });

    it('handles empty environment (no variables)', async () => {
      const coll = makeCollection();
      (coll.data as any).config.environments.push({ name: 'empty' });
      await service.setActiveEnvironment('test-collection', 'empty');
      const vars = await service.resolveVariables(coll);
      expect(vars.get('baseUrl')).toBe('https://api.example.com');
    });

    it('getActiveEnvironmentName returns undefined when not set', () => {
      expect(service.getActiveEnvironmentName('unknown')).toBeUndefined();
    });

    it('getCollectionEnvironments returns empty array when no config', () => {
      const coll = makeCollection();
      delete (coll.data as any).config;
      expect(service.getCollectionEnvironments(coll)).toEqual([]);
    });
  });

  // ── Folder variable inheritance ────────────────────────────────

  describe('folder variable inheritance (collection > folder > environment)', () => {
    const folderDefaults = {
      variables: [
        { name: 'resource', value: 'users' },
        { name: 'resourceUrl', value: '{{baseUrl}}/{{resource}}' },
        { name: 'version', value: 'v2' },  // overrides collection's v1
      ],
    };

    it('folder variables are resolved', async () => {
      const vars = await service.resolveVariables(collection, folderDefaults);
      expect(vars.get('resource')).toBe('users');
    });

    it('folder variables override collection variables', async () => {
      const vars = await service.resolveVariables(collection, folderDefaults);
      // collection has version=v1, folder has version=v2
      expect(vars.get('version')).toBe('v2');
    });

    it('collection variables persist when not overridden by folder', async () => {
      const vars = await service.resolveVariables(collection, folderDefaults);
      expect(vars.get('baseUrl')).toBe('https://api.example.com');
    });

    it('recursive interpolation works with folder + collection variables', async () => {
      const vars = await service.resolveVariables(collection, folderDefaults);
      // resourceUrl = {{baseUrl}}/{{resource}} → https://api.example.com/users
      expect(vars.get('resourceUrl')).toBe('https://api.example.com/users');
    });

    it('fullBase uses folder version override in interpolation', async () => {
      const vars = await service.resolveVariables(collection, folderDefaults);
      // fullBase = {{baseUrl}}/{{version}} → https://api.example.com/v2
      expect(vars.get('fullBase')).toBe('https://api.example.com/v2');
    });

    it('environment variables override folder variables', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariables(collection, folderDefaults);
      // dev env has baseUrl=https://dev.example.com, overrides collection
      expect(vars.get('baseUrl')).toBe('https://dev.example.com');
    });

    it('folder variables persist when not overridden by environment', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariables(collection, folderDefaults);
      // resource is only in folder, not in dev env
      expect(vars.get('resource')).toBe('users');
    });

    it('full chain: collection > folder > environment with interpolation', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariables(collection, folderDefaults);
      // resourceUrl = {{baseUrl}}/{{resource}}
      // baseUrl overridden by env → https://dev.example.com
      // resource from folder → users
      expect(vars.get('resourceUrl')).toBe('https://dev.example.com/users');
    });

    it('tracks folder source correctly', async () => {
      const vars = await service.resolveVariablesWithSource(collection, folderDefaults);
      expect(vars.get('resource')?.source).toBe('folder');
      expect(vars.get('version')?.source).toBe('folder');
      expect(vars.get('baseUrl')?.source).toBe('collection');
    });

    it('environment source overrides folder source', async () => {
      await service.setActiveEnvironment('test-collection', 'dev');
      const vars = await service.resolveVariablesWithSource(collection, folderDefaults);
      expect(vars.get('baseUrl')?.source).toBe('environment');
      expect(vars.get('resource')?.source).toBe('folder');
      expect(vars.get('apiKey')?.source).toBe('environment');
    });

    it('disabled folder variables are excluded', async () => {
      const folderWithDisabled = {
        variables: [
          { name: 'active', value: 'yes' },
          { name: 'inactive', value: 'no', disabled: true },
        ],
      };
      const vars = await service.resolveVariables(collection, folderWithDisabled);
      expect(vars.get('active')).toBe('yes');
      expect(vars.has('inactive')).toBe(false);
    });

    it('no folder defaults behaves same as before', async () => {
      const withFolder = await service.resolveVariables(collection, undefined);
      const without = await service.resolveVariables(collection);
      expect(withFolder).toEqual(without);
    });
  });
});
