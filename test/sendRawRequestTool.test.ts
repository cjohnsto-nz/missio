import { describe, it, expect } from 'vitest';
import { SendRawRequestTool } from '../src/copilot/tools/sendRawRequestTool';
import { HttpClient } from '../src/services/httpClient';
import { RequestExecutionService } from '../src/services/requestExecutionService';
import * as http from 'http';
import * as os from 'os';

describe('SendRawRequestTool responseOutputPath behavior', () => {
  it('does not set savedTo when writing responseOutputPath fails and returns a warning', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('raw-response');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Unexpected test server address');

    const tool = new SendRawRequestTool(
      { resolveCollection: () => undefined } as any,
      new RequestExecutionService(new HttpClient(makeEnvironmentService())),
    );

    try {
      const output = await tool.call(
        {
          input: {
            method: 'GET',
            url: `http://127.0.0.1:${addr.port}/items`,
            // Point at an existing directory so writeFileSync deterministically fails.
            responseOutputPath: os.tmpdir(),
          },
        } as any,
        {} as any,
      );

      const parsed = JSON.parse(output);
      expect(parsed.savedTo).toBeUndefined();
      expect(parsed.warnings?.[0]).toContain('Failed to write responseOutputPath');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function makeCollection(auth?: unknown) {
  return {
    id: 'collection.yml',
    filePath: 'C:/collections/collection.yml',
    rootDir: 'C:/collections',
    data: {
      request: auth ? { auth } : {},
      config: {},
    },
  } as any;
}

function makeEnvironmentService(values: Record<string, string> = {}) {
  return {
    resolveVariables: async () => new Map(Object.entries(values)),
    interpolate: (template: string, vars: Map<string, string>) =>
      template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, n) => vars.get(n) ?? m),
    interpolateJson: (template: string, vars: Map<string, string>) => template.replace(
      /"\{\{\s*([\w.$-]+)\s*\}\}"/g,
      (match, name) => {
        const value = vars.get(name);
        if (value === undefined) return match;
        if (value === 'true' || value === 'false' || value === 'null' || /^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return value;
        return JSON.stringify(value);
      },
    ).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, n) => vars.get(n) ?? m),
  } as any;
}

async function listenForRawRequest(handler: (req: http.IncomingMessage, body: string) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      handler(req, Buffer.concat(chunks).toString('utf-8'));
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected test server address');
  return { server, url: `http://127.0.0.1:${address.port}/raw` };
}

describe('SendRawRequestTool request resolution', () => {
  it('recursively interpolates object body variables while preserving JSON types', async () => {
    let receivedBody: unknown;
    const fixture = await listenForRawRequest((_req, body) => {
      receivedBody = JSON.parse(body);
    });
    const collection = makeCollection();
    const tool = new SendRawRequestTool(
      { resolveCollection: () => collection } as any,
      new RequestExecutionService(new HttpClient(makeEnvironmentService({ collectionValue: 'collection', count: '1' }))),
    );

    try {
      await tool.call({
        input: {
          method: 'POST',
          url: fixture.url,
          body: {
            label: '{{collectionValue}}',
            count: '{{count}}',
            nested: [{ enabled: '{{enabled}}' }],
          },
          variables: { count: 42, enabled: true },
        },
      } as any, {} as any);

      expect(receivedBody).toEqual({
        label: 'collection',
        count: 42,
        nested: [{ enabled: true }],
      });
    } finally {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });

  it('requires collectionId when more than one collection is loaded', async () => {
    const fixture = await listenForRawRequest(() => {
      throw new Error('The ambiguous request should not reach the server');
    });
    const tool = new SendRawRequestTool(
      {
        resolveCollection: () => undefined,
        getCollections: () => [makeCollection(), makeCollection()],
      } as any,
      new RequestExecutionService(new HttpClient(makeEnvironmentService())),
    );

    try {
      const output = JSON.parse(await tool.call({
        input: { method: 'GET', url: fixture.url },
      } as any, {} as any));

      expect(output.success).toBe(false);
      expect(output.message).toContain('collectionId');
    } finally {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });

  it('returns an explicit diagnostic for unsupported collection auth', async () => {
    let requestCount = 0;
    const fixture = await listenForRawRequest(() => {
      requestCount++;
    });
    const tool = new SendRawRequestTool(
      { resolveCollection: () => makeCollection({ type: 'digest', username: 'user', password: 'pass' }) } as any,
      new RequestExecutionService(new HttpClient(makeEnvironmentService())),
    );

    try {
      const output = JSON.parse(await tool.call({
        input: { method: 'GET', url: fixture.url },
      } as any, {} as any));

      expect(output.success).toBe(false);
      expect(output.message).toContain('not supported');
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });

  it('applies explicit raw auth through the request resolution path', async () => {
    let authorization: string | undefined;
    const fixture = await listenForRawRequest((req) => {
      authorization = req.headers.authorization;
    });
    const tool = new SendRawRequestTool(
      { resolveCollection: () => makeCollection() } as any,
      new RequestExecutionService(new HttpClient(makeEnvironmentService())),
    );

    try {
      await tool.call({
        input: {
          method: 'GET',
          url: fixture.url,
          auth: { type: 'bearer', token: 'raw-token' },
        },
      } as any, {} as any);

      expect(authorization).toBe('Bearer raw-token');
    } finally {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });
});
