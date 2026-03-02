import { describe, it, expect, vi } from 'vitest';
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
