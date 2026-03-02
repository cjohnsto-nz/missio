import { describe, it, expect } from 'vitest';
import { SendRawRequestTool } from '../src/copilot/tools/sendRawRequestTool';
import * as http from 'http';
import * as os from 'os';

function makeTool(): SendRawRequestTool {
  const environmentService = {
    interpolate: (template: string, vars: Map<string, string>) =>
      template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, n) => vars.get(n) ?? m),
  } as any;

  return new SendRawRequestTool({} as any, environmentService, {} as any);
}

describe('SendRawRequestTool auth placement', () => {
  it('writes apiKey query auth into URL query string', () => {
    const tool = makeTool();
    const headers: Record<string, string> = {};

    const resultUrl = (tool as any)._applyCollectionAuth(
      { type: 'apikey', key: 'api_key', value: 'secret', placement: 'query' },
      headers,
      new Map<string, string>(),
      'https://example.com/users',
    );

    expect(resultUrl).toContain('api_key=secret');
    expect(headers.api_key).toBeUndefined();
  });

  it('writes apiKey header auth into headers', () => {
    const tool = makeTool();
    const headers: Record<string, string> = {};

    const resultUrl = (tool as any)._applyCollectionAuth(
      { type: 'apikey', key: 'X-API-Key', value: 'secret', placement: 'header' },
      headers,
      new Map<string, string>(),
      'https://example.com/users',
    );

    expect(resultUrl).toBe('https://example.com/users');
    expect(headers['X-API-Key']).toBe('secret');
  });
});

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
      { interpolate: (s: string) => s } as any,
      {} as any,
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
