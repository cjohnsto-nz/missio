import { describe, it, expect } from 'vitest';
import { SendRawRequestTool } from '../src/copilot/tools/sendRawRequestTool';

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
