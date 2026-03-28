import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { HttpClient } from '../src/services/httpClient';
import type { AuthOAuth2, MissioCollection } from '../src/models/types';

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

function makeOAuth2Auth(): AuthOAuth2 {
  return {
    type: 'oauth2',
    flow: 'client_credentials',
    accessTokenUrl: 'https://auth.example.com/token',
    credentials: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      placement: 'basic_auth_header',
    },
  };
}

describe('HttpClient OAuth2 environment scoping', () => {
  it('uses per-request environment override when acquiring OAuth2 token', async () => {
    const envService = {
      interpolate: (v: string) => v,
      getActiveEnvironmentName: () => 'active-env',
    } as any;
    const client = new HttpClient(envService);
    const getToken = vi.fn().mockResolvedValue('token-123');
    client.setOAuth2Service({ getToken } as any);

    const headers: Record<string, string> = {};
    await (client as any)._applyOAuth2(
      makeOAuth2Auth(),
      headers,
      new Map<string, string>(),
      makeCollection(),
      'override-env',
    );

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken.mock.calls[0][2]).toBe('override-env');
    expect(headers.Authorization).toBe('Bearer token-123');
  });

  it('falls back to active environment when no override is provided', async () => {
    const envService = {
      interpolate: (v: string) => v,
      getActiveEnvironmentName: () => 'active-env',
    } as any;
    const client = new HttpClient(envService);
    const getToken = vi.fn().mockResolvedValue('token-456');
    client.setOAuth2Service({ getToken } as any);

    const headers: Record<string, string> = {};
    await (client as any)._applyOAuth2(
      makeOAuth2Auth(),
      headers,
      new Map<string, string>(),
      makeCollection(),
      undefined,
    );

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken.mock.calls[0][2]).toBe('active-env');
    expect(headers.Authorization).toBe('Bearer token-456');
  });
});

describe('HttpClient CLI cache expiry', () => {
  it('expires long-lived tokens 60 seconds early', () => {
    const client = new HttpClient({} as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    const expiresAt = (client as any)._computeCliCacheExpiry(3_600_000);

    expect(expiresAt).toBe(1_000_000 + 3_600_000 - 60_000);
    nowSpy.mockRestore();
  });

  it('uses a proportional early-expiry margin for medium-lived tokens', () => {
    const client = new HttpClient({} as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);

    const expiresAt = (client as any)._computeCliCacheExpiry(300_000);

    expect(expiresAt).toBe(2_000_000 + 300_000 - 30_000);
    nowSpy.mockRestore();
  });

  it('keeps short-lived tokens cacheable by using a smaller safety margin', () => {
    const client = new HttpClient({} as any);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(3_000_000);

    const expiresAt = (client as any)._computeCliCacheExpiry(30_000);

    expect(expiresAt).toBe(3_000_000 + 30_000 - 3_000);
    expect(expiresAt).toBeGreaterThan(3_000_000);
    nowSpy.mockRestore();
  });
});

// ── buildResolvedRequest — binary file body ───────────────────────────────────

/** Minimal env service sufficient for buildResolvedRequest */
function makeEnvService() {
  return {
    resolveVariables: vi.fn().mockResolvedValue(new Map<string, string>()),
    interpolate: (v: string) => v,
  } as any;
}

function makeFileCollection(rootDir: string): MissioCollection {
  return {
    id: 'file-collection',
    filePath: path.join(rootDir, 'opencollection.yml'),
    rootDir,
    data: {
      opencollection: '1.0.0',
      info: { name: 'Test' },
      request: {},
      config: { environments: [] },
    },
  } as MissioCollection;
}

describe('buildResolvedRequest — file body', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a relative file path within the collection root', async () => {
    const rootDir = path.normalize('/tmp/my-collection');
    const fileContent = Buffer.from('hello binary');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(fileContent as any);

    const client = new HttpClient(makeEnvService());
    const result = await client.buildResolvedRequest(
      {
        http: {
          method: 'POST',
          url: 'https://example.com/upload',
          body: {
            type: 'file',
            data: [{ filePath: 'fixtures/sample.txt', contentType: 'text/plain', selected: true }],
          },
        },
      },
      makeFileCollection(rootDir),
    );

    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(result.body).toEqual(fileContent);
    expect(result.headers['Content-Type']).toBe('text/plain');
  });

  it('blocks a relative path that escapes the collection root via ../', async () => {
    const rootDir = path.normalize('/tmp/my-collection');
    const client = new HttpClient(makeEnvService());

    await expect(
      client.buildResolvedRequest(
        {
          http: {
            method: 'POST',
            url: 'https://example.com/upload',
            body: {
              type: 'file',
              data: [{ filePath: '../../etc/passwd', contentType: 'text/plain', selected: true }],
            },
          },
        },
        makeFileCollection(rootDir),
      ),
    ).rejects.toThrow(/escapes the collection root/);
  });

  it('allows an absolute path regardless of collection root', async () => {
    const rootDir = path.normalize('/tmp/my-collection');
    const absolutePath = path.normalize('/home/user/downloads/payload.bin');
    const fileContent = Buffer.from([0x00, 0x01, 0x02]);
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(fileContent as any);

    const client = new HttpClient(makeEnvService());
    const result = await client.buildResolvedRequest(
      {
        http: {
          method: 'POST',
          url: 'https://example.com/upload',
          body: {
            type: 'file',
            data: [{ filePath: absolutePath, contentType: 'application/octet-stream', selected: true }],
          },
        },
      },
      makeFileCollection(rootDir),
    );

    expect(Buffer.isBuffer(result.body)).toBe(true);
  });

  it('does not add Content-Type when a case-variant already exists in headers', async () => {
    const rootDir = path.normalize('/tmp/my-collection');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('data') as any);

    const client = new HttpClient(makeEnvService());
    const result = await client.buildResolvedRequest(
      {
        http: {
          method: 'POST',
          url: 'https://example.com/upload',
          // User has already set a content-type header (lowercase)
          headers: [{ name: 'content-type', value: 'application/pdf' }],
          body: {
            type: 'file',
            data: [{ filePath: 'fixtures/sample.pdf', contentType: 'image/png', selected: true }],
          },
        },
      },
      makeFileCollection(rootDir),
    );

    // The user-supplied 'content-type: application/pdf' must not be overwritten
    // and no duplicate 'Content-Type' header should be added.
    const ctHeaders = Object.keys(result.headers).filter(
      k => k.toLowerCase() === 'content-type',
    );
    expect(ctHeaders).toHaveLength(1);
    expect(result.headers[ctHeaders[0]]).toBe('application/pdf');
  });
});
