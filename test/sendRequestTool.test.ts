import { describe, it, expect } from 'vitest';
import { SendRequestTool } from '../src/copilot/tools/sendRequestTool';
import type { HttpRequest, MissioCollection } from '../src/models/types';

function interpolate(template: string, vars: Map<string, string>): string {
  return template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, name) => vars.get(name) ?? m);
}

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

describe('SendRequestTool dryRun redaction', () => {
  it('redacts sensitive auth and secret-derived values in dryRun output', async () => {
    const environmentService = {
      resolveVariablesWithSource: async () => new Map<string, { value: string; source: string }>([
        ['token', { value: 'super-secret-token', source: 'secret' }],
      ]),
      interpolate: (template: string, vars: Map<string, string>) => interpolate(template, vars),
      interpolateJson: (template: string, vars: Map<string, string>) => interpolate(template, vars),
    } as any;

    const tool = new SendRequestTool({} as any, environmentService, {} as any);

    const request: HttpRequest = {
      http: {
        method: 'POST',
        url: 'https://example.com/items?token={{token}}',
        headers: [{ name: 'X-Api-Key', value: '{{token}}' }],
        body: { type: 'json', data: '{"token":"{{token}}"}' },
      },
      runtime: {
        auth: { type: 'bearer', token: '{{token}}' },
      },
    };

    const output = await (tool as any)._dryRun(
      request,
      makeCollection(),
      undefined,
      undefined,
      undefined,
      [],
      [],
    );

    expect(output).not.toContain('super-secret-token');

    const parsed = JSON.parse(output);
    expect(parsed.headers.Authorization).toBe('Bearer [redacted]');
    expect(parsed.headers['X-Api-Key']).toBe('[redacted]');
    expect(parsed.url).toContain('token=%5Bredacted%5D');
    expect(parsed.body).toContain('[secret]');
  });
});
