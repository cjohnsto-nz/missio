import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HttpClient } from '../src/services/httpClient';
import { OAuth2Service } from '../src/services/oauth2Service';
import { exportRequest } from '../src/services/snippetExporter';
import type { AuthOAuth2, MissioCollection } from '../src/models/types';

function makeCollection(): MissioCollection {
  return {
    id: 'collection-1',
    filePath: path.join(os.tmpdir(), 'opencollection.yml'),
    rootDir: os.tmpdir(),
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

async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected server address');
  return address.port;
}

async function close(server: http.Server | https.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIICzTCCAbWgAwIBAgIIDUFhaZcNjyIwDQYJKoZIhvcNAQELBQAwFDESMBAGA1UE
AxMJbG9jYWxob3N0MB4XDTI2MDYxMzEyMDcyMVoXDTM2MDYxNDEyMDcyMVowFDES
MBAGA1UEAxMJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEA3hKGbDq1amxdUszvajxU4rKotgpsKnnMOrqiATDFKeVXcZjlqfv8y0uZBVWG
gjgL9b+DQo1FMS7HrhgO78eZxATGW/DrAxpPPR1tC1E0tPOs5ATZntJ+XO/JSrbK
edNjYc+1pKAFn4hyTjuLR5+sGRleg4R4RUNPxTEFraY4FQEd99SadbTSx6li6DTC
kbgBTxE3F/JdqDViaPjO2s8TqutrCRYU4CHBrrNi0pZtTTm7v1SZO2HLHmqKM5AN
g4wSXT6yZpoC6isoupay087cKHd/AdTf1nDGYvlKRLj3gMZ5DZQz4VegvBP4qU6l
d79pd+ipYr7mAtEZuyY31vhNDQIDAQABoyMwITAPBgNVHRMBAf8EBTADAQH/MA4G
A1UdDwEB/wQEAwICpDANBgkqhkiG9w0BAQsFAAOCAQEAo/hFkKGTaPqqN9JjH/dA
Zpp5RrMiF2m7IKh8WTFOncbwoImToxKA4KFKJlThLqPw4QSujrggxzc+QM+Tazxl
125tKFKH1ZY0po7KCbYkBEL404JccdD+dDmvU8UEmF+GDMSo1HB2E9y/n46kYRSt
wzR9ksZG2AiWSwgkfzWcO+AKXySY3jpjyHsjD8HEB89XHfAedxOUiZp63DRs4Iu4
R6TwUvQsVJg9JL/U/znMKxqomqVPZ9u2sVM6u+eceaO3A+Tt6A0QxyIwS1QtJ7o5
GmcSuy7+TSf5CvEsn5P8G3J47L6EOzvx16qT7VAEW4oenwNxyg8wvL4B033fYYzT
Bw==
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA3hKGbDq1amxdUszvajxU4rKotgpsKnnMOrqiATDFKeVXcZjl
qfv8y0uZBVWGgjgL9b+DQo1FMS7HrhgO78eZxATGW/DrAxpPPR1tC1E0tPOs5ATZ
ntJ+XO/JSrbKedNjYc+1pKAFn4hyTjuLR5+sGRleg4R4RUNPxTEFraY4FQEd99Sa
dbTSx6li6DTCkbgBTxE3F/JdqDViaPjO2s8TqutrCRYU4CHBrrNi0pZtTTm7v1SZ
O2HLHmqKM5ANg4wSXT6yZpoC6isoupay087cKHd/AdTf1nDGYvlKRLj3gMZ5DZQz
4VegvBP4qU6ld79pd+ipYr7mAtEZuyY31vhNDQIDAQABAoIBAAk1v3lxneCCCgTL
FwrS4bpdKn4SRJYmYv/0iY9/FE4+grflXXEFUGCmC/yapW91H5nbjXgPH9WAWSux
N71eC9SDVi6t+TExwCOKuuEDRypSCNOUF+psVG1KTJDar98Jk0+VK7VeJZ2OLR9t
fMNFrf+Ee9T8g3hr6D0HYXLoN983Dt1sY/rTFfLBt4uVdGfuYbF+W/2id9od+mfn
kDWQID54mNCjWVyiBwIVQr1S2zDzliq6m9gRmjFhLWzhSYTVu+R9xywJesnlFwnI
KjsVP6Jv1kJCINrSZJk4HLfRz/uKuc1IaoCcY0a8vufX2ldW1dbknHc6JN5b6Dj+
+mWwM8kCgYEA6nm0LQwiYJN0ao7pFngT/xoWTXZn+/dxFK4S15wiPL0MLf66I+KD
E9IocUrYClWRPBhWzTjg7xWcejWDvCI7UQOUozwusO/54iEgVbbzsad95i8tFzst
4i89voK7Iz67o/mBmHLKOTfoTJY6C2SemewNDVjBcj3s8/GT2cBW308CgYEA8nVX
3ZGYZrpcT9Hy8vyOkcJxov3M7QgwMUvy8++3B6lpwqtnPmn+B7SVCcaCn6RS3yDL
0upxk5s7Dhps6oQ8J215fZH2o5oiHjSRrT4PFvFLqZREZ+GYd7w8loBjMWAdiwvz
u+x9l3IVqoMXaPw5YG5t2RZdg4uNcN0MreVoluMCgYEAg/9rnQh9udyI5wv4z/td
Vnk7IPSNaV1NPZUZamOtKoBKgQIri9QScnAW8GBv6rFtB2W0R+fDSRTjeDD0Lk8f
EWZwoMxahKU0CUcYyugpnFNsHs9kFPXtyK1LlxpFe3vvakol2MqWaUu97I+Nsag9
WO14E5FppYSTBmlzEFylCyUCgYAPGgP5BwKJE36AckFBpT10ErplPo2vDd2ClIpz
azDpR0IRH//0QUHTVQoba8PjEacfwrkvT+73FKoe/MJf8RCWHBl/GsJT+lu5qeiQ
89aYxTrDOzrvhXurqYvUi/ahsqzkZkAuKlLARhjXYAbrQRqJyRcKeHwmn2CV8Q7D
HhDfpQKBgQDe7lorOWe0HvHNoCzgHN2DWNKAsOPcQm5W8q6CGzPETv1GxlDFxpA7
mMXqBgl4GsZ2R9UDaQ29yGFV9sCg2nTp1AR7nqp4550dSi+pcCEgG0+IMmpDcnp0
y3drEao15oS8HyXU98l8FoYM2pE+6G/JK8YW2fbGGNdYPRuHhlU+0A==
-----END RSA PRIVATE KEY-----
`;

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

describe('HttpClient OC-050 auth and transport behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('places API key auth in the query string and exports the resolved URL', async () => {
    const client = new HttpClient(makeEnvService());
    const resolved = await client.buildResolvedRequest(
      {
        http: { method: 'GET', url: 'https://example.com/users' },
        runtime: { auth: { type: 'apikey', key: 'api_key', value: 'secret', placement: 'query' } },
      },
      makeCollection(),
    );

    expect(new URL(resolved.url).searchParams.get('api_key')).toBe('secret');
    expect(resolved.headers.api_key).toBeUndefined();
    expect(exportRequest(resolved, 'shell:curl')).toContain('api_key=secret');
  });

  it('places OAuth2 tokens in configured query parameters', async () => {
    const client = new HttpClient(makeEnvService());
    const getToken = vi.fn().mockResolvedValue('oauth-token');
    client.setOAuth2Service({ getToken } as any);

    const resolved = await client.buildResolvedRequest(
      {
        http: { method: 'GET', url: 'https://example.com/resource' },
        runtime: {
          auth: {
            ...makeOAuth2Auth(),
            tokenConfig: { placement: { query: 'access_token' } },
          },
        },
      },
      makeCollection(),
    );

    expect(new URL(resolved.url).searchParams.get('access_token')).toBe('oauth-token');
    expect(resolved.headers.Authorization).toBeUndefined();
  });

  it('sends OAuth2 additional token request parameters by header, query, and body placement', async () => {
    let observed: { url: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        observed = {
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'fixture-token', expires_in: 3600 }));
      });
    });
    const port = await listen(server);
    const secrets = new Map<string, string>();
    const service = new OAuth2Service({
      get: async key => secrets.get(key),
      store: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); },
    } as any);

    try {
      const token = await service.getToken(
        {
          type: 'oauth2',
          flow: 'client_credentials',
          accessTokenUrl: `http://127.0.0.1:${port}/token`,
          credentials: { clientId: 'client-id', clientSecret: 'client-secret', placement: 'body' },
          additionalParameters: {
            accessTokenRequest: [
              { name: 'X-Tenant', value: 'tenant-a', placement: 'header' },
              { name: 'audience', value: 'missio-api', placement: 'body' },
              { name: 'trace', value: 'query-trace', placement: 'query' },
            ],
          },
        },
        'collection-1',
        'LOCAL',
      );

      expect(token).toBe('fixture-token');
      expect(observed?.headers['x-tenant']).toBe('tenant-a');
      expect(new URL(observed!.url, `http://127.0.0.1:${port}`).searchParams.get('trace')).toBe('query-trace');
      const body = new URLSearchParams(observed?.body);
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
      expect(body.get('audience')).toBe('missio-api');
    } finally {
      await close(server);
    }
  });

  it('follows redirects up to maxRedirects', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    const port = await listen(server);

    try {
      const client = new HttpClient(makeEnvService());
      const response = await client.send(
        {
          http: { method: 'POST', url: `http://127.0.0.1:${port}/start`, body: { type: 'text', data: 'payload' } },
          settings: { followRedirects: true, maxRedirects: 2 },
        },
        makeCollection(),
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ path: '/final', method: 'GET' });
    } finally {
      await close(server);
    }
  });

  it('fails clearly when redirects exceed maxRedirects', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    });
    const port = await listen(server);

    try {
      const client = new HttpClient(makeEnvService());
      await expect(client.send(
        {
          http: { method: 'GET', url: `http://127.0.0.1:${port}/start` },
          settings: { followRedirects: true, maxRedirects: 1 },
        },
        makeCollection(),
      )).rejects.toThrow(/maxRedirects \(1\)/);
    } finally {
      await close(server);
    }
  });

  it('routes HTTP requests through a configured proxy with basic proxy auth', async () => {
    const proxy = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        url: req.url,
        proxyAuth: req.headers['proxy-authorization'],
      }));
    });
    const proxyPort = await listen(proxy);

    try {
      const client = new HttpClient(makeEnvService());
      const collection = makeCollection();
      collection.data.config = {
        proxy: {
          enabled: true,
          config: {
            protocol: 'http',
            hostname: '127.0.0.1',
            port: proxyPort,
            auth: { username: 'proxy-user', password: 'proxy-pass' },
          },
        },
      } as any;

      const response = await client.send(
        { http: { method: 'GET', url: 'http://upstream.example.test/items?x=1' } },
        collection,
      );
      const body = JSON.parse(response.body);

      expect(body.url).toBe('http://upstream.example.test/items?x=1');
      expect(body.proxyAuth).toBe(`Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`);
    } finally {
      await close(proxy);
    }
  });

  it('honors proxy bypass rules', async () => {
    const target = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ direct: true }));
    });
    const targetPort = await listen(target);

    try {
      const client = new HttpClient(makeEnvService());
      const collection = makeCollection();
      collection.data.config = {
        proxy: {
          enabled: true,
          config: {
            protocol: 'http',
            hostname: '127.0.0.1',
            port: 9,
            bypassProxy: '127.0.0.1',
          },
        },
      } as any;

      const response = await client.send(
        { http: { method: 'GET', url: `http://127.0.0.1:${targetPort}/health` } },
        collection,
      );

      expect(JSON.parse(response.body)).toEqual({ direct: true });
    } finally {
      await close(target);
    }
  });

  it('presents matching collection client certificates for mTLS requests', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: (key: string, defaultValue: unknown) => key === 'rejectUnauthorized' ? false : defaultValue,
    } as any);
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missio-mtls-'));
    fs.writeFileSync(path.join(rootDir, 'client.crt'), TEST_CERT);
    fs.writeFileSync(path.join(rootDir, 'client.key'), TEST_KEY);

    const server = https.createServer(
      { key: TEST_KEY, cert: TEST_CERT, ca: TEST_CERT, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          authorized: req.client.authorized,
          cn: req.socket.getPeerCertificate().subject?.CN,
        }));
      },
    );
    const port = await listen(server);

    try {
      const client = new HttpClient(makeEnvService());
      const collection = makeFileCollection(rootDir);
      collection.data.config = {
        clientCertificates: [
          {
            domain: '127.0.0.1',
            type: 'pem',
            certificateFilePath: 'client.crt',
            privateKeyFilePath: 'client.key',
          },
        ],
      } as any;

      const response = await client.send(
        { http: { method: 'GET', url: `https://127.0.0.1:${port}/secure` } },
        collection,
      );

      expect(JSON.parse(response.body)).toEqual({ authorized: true, cn: 'localhost' });
    } finally {
      await close(server);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('fails mTLS requests when no matching client certificate is configured', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: (key: string, defaultValue: unknown) => key === 'rejectUnauthorized' ? false : defaultValue,
    } as any);
    const server = https.createServer(
      { key: TEST_KEY, cert: TEST_CERT, ca: TEST_CERT, requestCert: true, rejectUnauthorized: true },
      (_req, res) => {
        res.writeHead(200);
        res.end('should not succeed');
      },
    );
    const port = await listen(server);

    try {
      const client = new HttpClient(makeEnvService());
      await expect(client.send(
        { http: { method: 'GET', url: `https://127.0.0.1:${port}/secure` } },
        makeCollection(),
      )).rejects.toThrow();
    } finally {
      await close(server);
    }
  });

  it('fails unsupported schema auth loudly', async () => {
    const client = new HttpClient(makeEnvService());

    await expect(client.buildResolvedRequest(
      {
        http: { method: 'GET', url: 'https://example.com' },
        runtime: { auth: { type: 'digest', username: 'u', password: 'p' } },
      },
      makeCollection(),
    )).rejects.toThrow(/digest.*not supported/);
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
    getActiveEnvironmentName: () => undefined,
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
    const rootDir = path.join(os.tmpdir(), 'missio-test-collection');
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
    const rootDir = path.join(os.tmpdir(), 'missio-test-collection');
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
    const rootDir = path.join(os.tmpdir(), 'missio-test-collection');
    const absolutePath = path.join(os.tmpdir(), 'payload.bin');
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
    const rootDir = path.join(os.tmpdir(), 'missio-test-collection');
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
