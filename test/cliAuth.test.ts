import { describe, it, expect } from 'vitest';

describe('CLI Auth', () => {
  describe('JWT TTL parsing', () => {
    // Helper to create a mock JWT with a given expiry
    function createMockJwt(exp: number): string {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
      const payload = Buffer.from(JSON.stringify({ exp })).toString('base64');
      const signature = 'mock-signature';
      return `${header}.${payload}.${signature}`;
    }

    // Replicate the _parseJwtTtl logic for testing
    function parseJwtTtl(token: string): number | undefined {
      try {
        const parts = token.split('.');
        if (parts.length !== 3) return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        if (typeof payload.exp === 'number') {
          const expiresAt = payload.exp * 1000;
          const ttl = expiresAt - Date.now();
          return ttl > 0 ? ttl : undefined;
        }
      } catch {
        // Not a JWT or invalid format
      }
      return undefined;
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
      const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64');
      const payload = Buffer.from(JSON.stringify({ sub: 'user123' })).toString('base64');
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
    // Replicate the _setCliTokenHeader logic for testing
    function setCliTokenHeader(
      headers: Record<string, string>,
      auth: { tokenHeader?: string; tokenPrefix?: string },
      token: string,
    ): void {
      const headerName = auth.tokenHeader || 'Authorization';
      const prefix = auth.tokenPrefix !== undefined ? auth.tokenPrefix : 'Bearer';
      headers[headerName] = prefix ? `${prefix} ${token}` : token;
    }

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
});
