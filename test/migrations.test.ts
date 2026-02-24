import { describe, it, expect } from 'vitest';
import { migrateCollection, migrateRequest, migrateFolder } from '../src/services/migrations';

type MigrationTestData = {
  config: {
    secretProviders: Array<{
      name: string;
      type: string;
      url?: string;
      namespace?: string;
      disabled?: boolean;
      subscription?: string;
    }>;
  };
};

describe('migrations', () => {

  describe('migrateCollection', () => {

    describe('001-secret-provider-url-to-namespace', () => {

      it('converts full URL to namespace', () => {
        const data: MigrationTestData = {
          config: {
            secretProviders: [
              { name: 'my-vault', type: 'azure-keyvault', url: 'https://my-vault.vault.azure.net' },
            ],
          },
        };
        const result = migrateCollection(data);
        expect(result.changed).toBe(true);
        expect(result.applied).toContain('001-secret-provider-url-to-namespace');
        expect(data.config.secretProviders[0].namespace).toBe('my-vault');
        expect(data.config.secretProviders[0].url).toBeUndefined();
      });

      it('converts URL with trailing slash', () => {
        const data: MigrationTestData = {
          config: {
            secretProviders: [
              { name: 'v', type: 'azure-keyvault', url: 'https://kv-toner-dev.vault.azure.net/' },
            ],
          },
        };
        migrateCollection(data);
        expect(data.config.secretProviders[0].namespace).toBe('kv-toner-dev');
        expect(data.config.secretProviders[0].url).toBeUndefined();
      });

      it('converts URL with variable references', () => {
        const data: MigrationTestData = {
          config: {
            secretProviders: [
              { name: 'v', type: 'azure-keyvault', url: 'https://{{vault-name}}.vault.azure.net' },
            ],
          },
        };
        migrateCollection(data);
        expect(data.config.secretProviders[0].namespace).toBe('{{vault-name}}');
      });

      it('falls back to raw url value if not a standard vault URL', () => {
        const data: MigrationTestData = {
          config: {
            secretProviders: [
              { name: 'v', type: 'azure-keyvault', url: 'some-custom-value' },
            ],
          },
        };
        migrateCollection(data);
        expect(data.config.secretProviders[0].namespace).toBe('some-custom-value');
        expect(data.config.secretProviders[0].url).toBeUndefined();
      });

      it('is idempotent — skips if namespace already exists', () => {
        const data = {
          config: {
            secretProviders: [
              { name: 'v', type: 'azure-keyvault', namespace: 'my-vault' },
            ],
          },
        };
        const result = migrateCollection(data);
        expect(result.changed).toBe(false);
        expect(data.config.secretProviders[0].namespace).toBe('my-vault');
      });

      it('does not touch providers that already have namespace even if url exists', () => {
        const data = {
          config: {
            secretProviders: [
              { name: 'v', type: 'azure-keyvault', namespace: 'correct', url: 'https://old.vault.azure.net' },
            ],
          },
        };
        const result = migrateCollection(data);
        expect(result.changed).toBe(false);
        expect(data.config.secretProviders[0].namespace).toBe('correct');
      });

      it('handles multiple providers, only migrates those with url', () => {
        const data = {
          config: {
            secretProviders: [
              { name: 'a', type: 'azure-keyvault', url: 'https://vault-a.vault.azure.net' },
              { name: 'b', type: 'azure-keyvault', namespace: 'vault-b' },
              { name: 'c', type: 'azure-keyvault', url: 'https://vault-c.vault.azure.net' },
            ],
          },
        };
        const result = migrateCollection(data);
        expect(result.changed).toBe(true);
        expect(data.config.secretProviders[0].namespace).toBe('vault-a');
        expect(data.config.secretProviders[1].namespace).toBe('vault-b');
        expect(data.config.secretProviders[2].namespace).toBe('vault-c');
      });

      it('preserves other provider fields', () => {
        const data = {
          config: {
            secretProviders: [
              { name: 'v', type: 'azure-keyvault', url: 'https://kv.vault.azure.net', disabled: true, subscription: 'sub-1' },
            ],
          },
        };
        migrateCollection(data);
        expect(data.config.secretProviders[0]).toEqual({
          name: 'v',
          type: 'azure-keyvault',
          namespace: 'kv',
          disabled: true,
          subscription: 'sub-1',
        });
      });
    });

    it('returns unchanged for empty data', () => {
      expect(migrateCollection({}).changed).toBe(false);
      expect(migrateCollection(null).changed).toBe(false);
      expect(migrateCollection(undefined).changed).toBe(false);
    });

    it('returns unchanged when no secretProviders', () => {
      const data = { config: {} };
      expect(migrateCollection(data).changed).toBe(false);
    });
  });

  describe('migrateRequest', () => {

    describe('001-http-auth-to-runtime-auth', () => {

      it('moves http.auth to runtime.auth', () => {
        const data = { http: { method: 'GET', url: 'https://example.com', auth: { type: 'bearer', token: 'tok' } } };
        const result = migrateRequest(data);
        expect(result.changed).toBe(true);
        expect(result.applied).toContain('001-http-auth-to-runtime-auth');
        expect(data.http.auth).toBeUndefined();
        expect((data as any).runtime.auth).toEqual({ type: 'bearer', token: 'tok' });
      });

      it('moves inherit string value', () => {
        const data = { http: { method: 'GET', url: 'https://example.com', auth: 'inherit' } };
        migrateRequest(data);
        expect(data.http.auth).toBeUndefined();
        expect((data as any).runtime.auth).toBe('inherit');
      });

      it('is idempotent — no-op if http.auth is already absent', () => {
        const data = { http: { method: 'GET', url: 'https://example.com' }, runtime: { auth: { type: 'bearer', token: 'tok' } } };
        const result = migrateRequest(data);
        expect(result.changed).toBe(false);
        expect((data as any).runtime.auth).toEqual({ type: 'bearer', token: 'tok' });
      });

      it('prefers existing runtime.auth when both exist (cleans up http.auth)', () => {
        const data = {
          http: { method: 'GET', url: 'https://example.com', auth: { type: 'basic', username: 'old' } },
          runtime: { auth: { type: 'bearer', token: 'correct' } },
        };
        const result = migrateRequest(data);
        expect(result.changed).toBe(true);
        expect(data.http.auth).toBeUndefined();
        expect((data as any).runtime.auth).toEqual({ type: 'bearer', token: 'correct' });
      });

      it('creates runtime object if it does not exist', () => {
        const data = { http: { method: 'GET', url: 'https://example.com', auth: { type: 'apikey', key: 'X-Key', value: '123' } } };
        migrateRequest(data);
        expect((data as any).runtime).toBeDefined();
        expect((data as any).runtime.auth).toEqual({ type: 'apikey', key: 'X-Key', value: '123' });
      });

      it('preserves other runtime fields', () => {
        const data = {
          http: { method: 'GET', url: 'https://example.com', auth: 'inherit' },
          runtime: { variables: [{ name: 'foo', value: 'bar' }] },
        };
        migrateRequest(data);
        expect((data as any).runtime.variables).toEqual([{ name: 'foo', value: 'bar' }]);
        expect((data as any).runtime.auth).toBe('inherit');
      });

      it('preserves other http fields', () => {
        const data = {
          http: { method: 'POST', url: 'https://example.com', auth: 'inherit', headers: [{ name: 'X-Test', value: '1' }] },
        };
        migrateRequest(data);
        expect(data.http.method).toBe('POST');
        expect(data.http.headers).toEqual([{ name: 'X-Test', value: '1' }]);
        expect(data.http.auth).toBeUndefined();
      });
    });

    it('returns unchanged for empty data', () => {
      expect(migrateRequest({}).changed).toBe(false);
      expect(migrateRequest(null).changed).toBe(false);
      expect(migrateRequest(undefined).changed).toBe(false);
    });

    it('returns unchanged when no http object', () => {
      expect(migrateRequest({ info: { name: 'test' } }).changed).toBe(false);
    });

    describe('002-oauth2-flat-to-nested', () => {

      it('migrates flat client_credentials OAuth2 to nested structure', () => {
        const data = {
          http: { method: 'GET', url: 'https://example.com' },
          runtime: {
            auth: {
              type: 'oauth2',
              flow: 'client_credentials',
              accessTokenUrl: 'https://auth.example.com/token',
              clientId: 'my-client',
              clientSecret: 'my-secret',
              credentialsPlacement: 'basic_auth_header',
              autoFetchToken: true,
              autoRefreshToken: false,
              scope: 'read write',
            },
          },
        };
        const result = migrateRequest(data);
        expect(result.changed).toBe(true);
        expect(result.applied).toContain('002-oauth2-flat-to-nested');
        const auth = (data as any).runtime.auth;
        expect(auth.clientId).toBeUndefined();
        expect(auth.clientSecret).toBeUndefined();
        expect(auth.credentialsPlacement).toBeUndefined();
        expect(auth.autoFetchToken).toBeUndefined();
        expect(auth.autoRefreshToken).toBeUndefined();
        expect(auth.credentials).toEqual({ clientId: 'my-client', clientSecret: 'my-secret', placement: 'basic_auth_header' });
        expect(auth.settings).toEqual({ autoFetchToken: true, autoRefreshToken: false });
        expect(auth.scope).toBe('read write');
        expect(auth.accessTokenUrl).toBe('https://auth.example.com/token');
      });

      it('migrates flat password flow to nested with resourceOwner and flow rename', () => {
        const data = {
          runtime: {
            auth: {
              type: 'oauth2',
              flow: 'password',
              accessTokenUrl: 'https://auth.example.com/token',
              clientId: 'cid',
              username: 'user',
              password: 'pass',
            },
          },
        };
        const result = migrateRequest(data);
        expect(result.changed).toBe(true);
        const auth = (data as any).runtime.auth;
        expect(auth.flow).toBe('resource_owner_password_credentials');
        expect(auth.username).toBeUndefined();
        expect(auth.password).toBeUndefined();
        expect(auth.resourceOwner).toEqual({ username: 'user', password: 'pass' });
        expect(auth.credentials).toEqual({ clientId: 'cid' });
      });

      it('migrates boolean pkce to object', () => {
        const data = {
          runtime: {
            auth: {
              type: 'oauth2',
              flow: 'authorization_code',
              accessTokenUrl: 'https://auth.example.com/token',
              pkce: true,
            },
          },
        };
        migrateRequest(data);
        expect((data as any).runtime.auth.pkce).toEqual({ enabled: true });
      });

      it('is idempotent — no-op if already nested', () => {
        const data = {
          runtime: {
            auth: {
              type: 'oauth2',
              flow: 'client_credentials',
              accessTokenUrl: 'https://auth.example.com/token',
              credentials: { clientId: 'cid', placement: 'body' },
              settings: { autoFetchToken: true },
            },
          },
        };
        const result = migrateRequest(data);
        expect(result.applied).not.toContain('002-oauth2-flat-to-nested');
      });

      it('no-op for non-oauth2 auth', () => {
        const data = { runtime: { auth: { type: 'bearer', token: 'tok' } } };
        const result = migrateRequest(data);
        expect(result.applied).not.toContain('002-oauth2-flat-to-nested');
      });
    });
  });

  describe('migrateCollection — 002-oauth2-flat-to-nested', () => {

    it('migrates flat OAuth2 in collection request.auth', () => {
      const data = {
        request: {
          auth: {
            type: 'oauth2',
            flow: 'client_credentials',
            clientId: 'cid',
            clientSecret: 'secret',
            credentialsPlacement: 'body',
            autoFetchToken: true,
          },
        },
        config: {},
      };
      const result = migrateCollection(data);
      expect(result.changed).toBe(true);
      expect(result.applied).toContain('002-oauth2-flat-to-nested');
      expect((data.request.auth as any).credentials).toEqual({ clientId: 'cid', clientSecret: 'secret', placement: 'body' });
      expect((data.request.auth as any).settings).toEqual({ autoFetchToken: true });
      expect((data.request.auth as any).clientId).toBeUndefined();
    });

    it('no-op when collection has no auth', () => {
      const data = { request: {}, config: {} };
      const result = migrateCollection(data);
      expect(result.applied).not.toContain('002-oauth2-flat-to-nested');
    });
  });

  describe('migrateFolder — 001-oauth2-flat-to-nested', () => {

    it('migrates flat OAuth2 in folder request.auth', () => {
      const data = {
        request: {
          auth: {
            type: 'oauth2',
            flow: 'password',
            clientId: 'cid',
            username: 'user',
            password: 'pass',
          },
        },
      };
      const result = migrateFolder(data);
      expect(result.changed).toBe(true);
      const auth = data.request.auth as any;
      expect(auth.flow).toBe('resource_owner_password_credentials');
      expect(auth.resourceOwner).toEqual({ username: 'user', password: 'pass' });
      expect(auth.credentials).toEqual({ clientId: 'cid' });
    });

    it('no-op for empty folder data', () => {
      expect(migrateFolder({}).changed).toBe(false);
    });
  });
});
