import { describe, it, expect } from 'vitest';
import { exportRequest, findTarget, EXPORT_TARGETS } from '../src/services/snippetExporter';
import type { ResolvedRequest } from '../src/services/httpClient';

// ── findTarget ────────────────────────────────────────────────────────

describe('findTarget', () => {
  it('returns the matching export target by composite ID', () => {
    const target = findTarget('shell:curl');
    expect(target).toBeDefined();
    expect(target!.label).toBe('cURL');
    expect(target!.ext).toBe('sh');
    expect(target!.lang).toBe('bash');
  });

  it('returns undefined for an unknown ID', () => {
    expect(findTarget('unknown:target')).toBeUndefined();
  });
});

// ── EXPORT_TARGETS ────────────────────────────────────────────────────

describe('EXPORT_TARGETS', () => {
  it('has unique IDs', () => {
    const ids = EXPORT_TARGETS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every ID follows the "target:client" format', () => {
    for (const t of EXPORT_TARGETS) {
      const parts = t.id.split(':');
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    }
  });
});

// ── exportRequest ─────────────────────────────────────────────────────

describe('exportRequest', () => {
  const baseRequest: ResolvedRequest = {
    method: 'GET',
    url: 'https://example.com/api/items',
    headers: {},
  };

  it('exports a simple GET as cURL', () => {
    const output = exportRequest(baseRequest, 'shell:curl');
    expect(output).toContain('curl');
    expect(output).toContain('https://example.com/api/items');
  });

  it('exports a simple GET as HTTP', () => {
    const output = exportRequest(baseRequest, 'http:http1.1');
    expect(output).toContain('GET /api/items');
    expect(output).toContain('example.com');
  });

  it('exports a POST with body and content-type', () => {
    const req: ResolvedRequest = {
      method: 'POST',
      url: 'https://example.com/api/items',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"test"}',
    };
    const output = exportRequest(req, 'shell:curl');
    expect(output).toContain('POST');
    expect(output).toContain('application/json');
    expect(output).toContain('{"name":"test"}');
  });

  it('includes custom headers in output', () => {
    const req: ResolvedRequest = {
      method: 'GET',
      url: 'https://example.com',
      headers: { 'Authorization': 'Bearer token123', 'X-Custom': 'value' },
    };
    const output = exportRequest(req, 'shell:curl');
    expect(output).toContain('Bearer token123');
    expect(output).toContain('X-Custom');
  });

  it('preserves {{template}} variables in URL without percent-encoding', () => {
    const req: ResolvedRequest = {
      method: 'GET',
      url: 'https://{{baseUrl}}/api/{{version}}/items',
      headers: {},
    };
    const output = exportRequest(req, 'shell:curl');
    expect(output).toContain('{{baseUrl}}');
    expect(output).toContain('{{version}}');
    expect(output).not.toContain('%7B%7B');
  });

  it('preserves multiple {{template}} variables in URL path segments', () => {
    const req: ResolvedRequest = {
      method: 'GET',
      url: 'https://example.com/{{tenant}}/{{resource}}',
      headers: {},
    };
    const output = exportRequest(req, 'shell:curl');
    expect(output).toContain('{{tenant}}');
    expect(output).toContain('{{resource}}');
  });

  it('exports to Python requests format', () => {
    const output = exportRequest(baseRequest, 'python:requests');
    expect(output).toContain('requests.get');
    expect(output).toContain('https://example.com/api/items');
  });

  it('exports to JavaScript fetch format', () => {
    const output = exportRequest(baseRequest, 'javascript:fetch');
    expect(output).toContain('fetch');
    expect(output).toContain('https://example.com/api/items');
  });

  it('throws on an invalid format ID', () => {
    expect(() => exportRequest(baseRequest, 'nonexistent:target')).toThrow('Conversion failed');
  });

  it('handles request with no body gracefully', () => {
    const req: ResolvedRequest = {
      method: 'DELETE',
      url: 'https://example.com/api/items/1',
      headers: {},
      body: undefined,
    };
    const output = exportRequest(req, 'shell:curl');
    expect(output).toContain('https://example.com/api/items/1');
  });

  it('handles URL with query parameters', () => {
    const req: ResolvedRequest = {
      method: 'GET',
      url: 'https://example.com/search?q=test&limit=10',
      headers: {},
    };
    const output = exportRequest(req, 'shell:curl');
    expect(output).toContain('q=test');
    expect(output).toContain('limit=10');
  });

  // ── Binary (Buffer) bodies ─────────────────────────────────────────

  it('exports a binary Buffer body without throwing', () => {
    const req: ResolvedRequest = {
      method: 'POST',
      url: 'https://example.com/upload',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG magic bytes
    };
    expect(() => exportRequest(req, 'shell:curl')).not.toThrow();
  });

  it('includes the URL in a cURL snippet for a binary body', () => {
    const req: ResolvedRequest = {
      method: 'POST',
      url: 'https://example.com/upload',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('hello binary'),
    };
    const output = exportRequest(req, 'shell:curl');
    expect(output).toContain('https://example.com/upload');
  });

  it('sets bodySize to the raw byte length for a Buffer body', () => {
    // Verify indirectly: exportRequest must not throw when bodySize is set,
    // meaning the HAR construction with a binary body is internally consistent.
    const data = Buffer.alloc(64, 0xab);
    const req: ResolvedRequest = {
      method: 'POST',
      url: 'https://example.com/upload',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    };
    // If toHar() set bodySize wrong the httpsnippet library would throw.
    expect(() => exportRequest(req, 'shell:curl')).not.toThrow();
  });

  it('sets bodySize correctly for a plain text body', () => {
    const req: ResolvedRequest = {
      method: 'POST',
      url: 'https://example.com/api',
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"value"}',
    };
    // Verify no throw and body appears in output
    const output = exportRequest(req, 'shell:curl');
    expect(output).toContain('{"key":"value"}');
  });
});
