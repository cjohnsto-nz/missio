import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildAuthData } from '../src/webview/authFields';
import { HttpClient } from '../src/services/httpClient';

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).document;
});

describe('CLI Auth', () => {
  describe('JWT TTL parsing', () => {
    const client = new HttpClient({} as any);
    const parseJwtTtl = (token: string) => (client as any)._parseJwtTtl(token);

    // Helper to create a mock JWT with a given expiry
    function createMockJwt(exp: number): string {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
      const signature = 'mock-signature';
      return `${header}.${payload}.${signature}`;
    }

    it('parses valid JWT with future expiry', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const jwt = createMockJwt(futureExp);
      const ttl = parseJwtTtl(jwt);
      expect(ttl).toBeDefined();
      expect(ttl).toBeGreaterThan(3500 * 1000); // ~1 hour in ms
      expect(ttl).toBeLessThanOrEqual(3600 * 1000);
    });

    it('returns undefined for expired JWT', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const jwt = createMockJwt(pastExp);
      const ttl = parseJwtTtl(jwt);
      expect(ttl).toBeUndefined();
    });

    it('returns undefined for non-JWT token', () => {
      const ttl = parseJwtTtl('not-a-jwt-token');
      expect(ttl).toBeUndefined();
    });

    it('returns undefined for JWT without exp claim', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'user123' })).toString('base64url');
      const jwt = `${header}.${payload}.signature`;
      const ttl = parseJwtTtl(jwt);
      expect(ttl).toBeUndefined();
    });

    it('returns undefined for malformed base64', () => {
      const ttl = parseJwtTtl('header.!!!invalid-base64!!!.signature');
      expect(ttl).toBeUndefined();
    });
  });

  describe('CLI token header setting', () => {
    const client = new HttpClient({} as any);
    const setCliTokenHeader = (headers: Record<string, string>, auth: any, token: string) =>
      (client as any)._setCliTokenHeader(headers, auth, token);
    const normalizeCliToken = (stdout: string, auth: any = {}) =>
      (client as any)._normalizeCliToken(stdout, auth);

    it('sets Authorization header with Bearer prefix by default', () => {
      const headers: Record<string, string> = {};
      setCliTokenHeader(headers, {}, 'my-token');
      expect(headers['Authorization']).toBe('Bearer my-token');
    });

    it('uses custom header name', () => {
      const headers: Record<string, string> = {};
      setCliTokenHeader(headers, { tokenHeader: 'X-Custom-Auth' }, 'my-token');
      expect(headers['X-Custom-Auth']).toBe('Bearer my-token');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('uses custom prefix', () => {
      const headers: Record<string, string> = {};
      setCliTokenHeader(headers, { tokenPrefix: 'Token' }, 'my-token');
      expect(headers['Authorization']).toBe('Token my-token');
    });

    it('uses empty prefix when explicitly set to empty string', () => {
      const headers: Record<string, string> = {};
      setCliTokenHeader(headers, { tokenPrefix: '' }, 'my-token');
      expect(headers['Authorization']).toBe('my-token');
    });

    it('combines custom header and prefix', () => {
      const headers: Record<string, string> = {};
      setCliTokenHeader(headers, { tokenHeader: 'X-API-Key', tokenPrefix: '' }, 'secret-key');
      expect(headers['X-API-Key']).toBe('secret-key');
    });

    it('accepts plain string output', () => {
      expect(normalizeCliToken('  my-token  ')).toBe('my-token');
    });

    it('preserves non-JSON string output exactly after trimming', () => {
      expect(normalizeCliToken('"my-token"')).toBe('"my-token"');
    });

    it('rejects structured JSON output with an actionable error', () => {
      expect(() => normalizeCliToken('{"masterKey":"abc"}', { tokenHeader: 'x-functions-key', tokenPrefix: '' }))
        .toThrow(/single header-safe token value for x-functions-key/i);
    });

    it('rejects line breaks in CLI output', () => {
      expect(() => normalizeCliToken('abc\r\ndef', { tokenHeader: 'x-functions-key', tokenPrefix: '' }))
        .toThrow(/returned line breaks or null bytes/i);
    });
  });

  describe('AuthCli schema', () => {
    it('validates minimal AuthCli object', () => {
      const auth = {
        type: 'cli' as const,
        command: 'az account get-access-token --query accessToken -o tsv',
      };
      expect(auth.type).toBe('cli');
      expect(auth.command).toBeDefined();
    });

    it('validates full AuthCli object with all options', () => {
      const auth = {
        type: 'cli' as const,
        command: 'az account get-access-token --resource {{resource}} --query accessToken -o tsv',
        tokenHeader: 'Authorization',
        tokenPrefix: 'Bearer',
        cache: {
          enabled: true,
          ttlSeconds: 3600,
        },
      };
      expect(auth.type).toBe('cli');
      expect(auth.cache?.enabled).toBe(true);
      expect(auth.cache?.ttlSeconds).toBe(3600);
    });

    it('allows cache to be disabled', () => {
      const auth = {
        type: 'cli' as const,
        command: 'echo test-token',
        cache: {
          enabled: false,
        },
      };
      expect(auth.cache?.enabled).toBe(false);
    });
  });

  describe('buildAuthData CLI cache serialization', () => {
    function mockCliFields(fields: {
      command?: string;
      tokenHeader?: string;
      tokenPrefix?: string;
      cacheEnabled?: boolean;
      ttlValue?: string;
    }): void {
      const elements = new Map<string, any>([
        ['authCliCommand', { _getRawText: () => fields.command ?? 'echo token' }],
        ['authCliTokenHeader', { _getRawText: () => fields.tokenHeader ?? 'Authorization' }],
        ['authCliTokenPrefix', { _getRawText: () => fields.tokenPrefix ?? 'Bearer' }],
        ['authCliCacheEnabled', { checked: fields.cacheEnabled ?? true }],
        ['authCliCacheTtl', { value: fields.ttlValue ?? '' }],
      ]);

      (globalThis as any).document = {
        getElementById: (id: string) => elements.get(id) ?? null,
      };
    }

    it('omits cache when enabled and ttl is empty', () => {
      mockCliFields({ cacheEnabled: true, ttlValue: '' });

      const auth = buildAuthData('cli', 'auth');

      expect(auth).toEqual({
        type: 'cli',
        command: 'echo token',
      });
      expect(auth.cache).toBeUndefined();
    });

    it('writes only ttlSeconds when cache is enabled with a valid ttl', () => {
      mockCliFields({ cacheEnabled: true, ttlValue: '3600' });

      const auth = buildAuthData('cli', 'auth');

      expect(auth.cache).toEqual({ ttlSeconds: 3600 });
      expect(auth.cache.enabled).toBeUndefined();
    });

    it('writes enabled false when cache is disabled without ttl', () => {
      mockCliFields({ cacheEnabled: false, ttlValue: '' });

      const auth = buildAuthData('cli', 'auth');

      expect(auth.cache).toEqual({ enabled: false });
    });

    it('ignores invalid ttl values', () => {
      mockCliFields({ cacheEnabled: true, ttlValue: 'abc' });

      const auth = buildAuthData('cli', 'auth');

      expect(auth.cache).toBeUndefined();
    });
  });
});
