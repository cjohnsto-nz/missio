import { describe, it, expect } from 'vitest';
import { migrateCollection, migrateRequest, migrateFolder } from '../src/services/migrations';

describe('migrations', () => {

  describe('migrateCollection', () => {

    describe('001-secret-provider-url-to-namespace', () => {

      it('converts full URL to namespace', () => {
        const data = {
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
        const data = {
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
        const data = {
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
        const data = {
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
    it('returns unchanged for empty data (no request migrations yet)', () => {
      expect(migrateRequest({}).changed).toBe(false);
    });
  });

  describe('migrateFolder', () => {
    it('returns unchanged for empty data (no folder migrations yet)', () => {
      expect(migrateFolder({}).changed).toBe(false);
    });
  });
});
