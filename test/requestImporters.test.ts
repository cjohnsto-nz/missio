import { describe, it, expect } from 'vitest';
import { CurlRequestImporter } from '../src/importers/curlRequestImporter';
import { WgetRequestImporter } from '../src/importers/wgetRequestImporter';
import { HttpRawRequestImporter } from '../src/importers/httpRawRequestImporter';
import { detectRequestFormat } from '../src/importers/requestImporters';

// ═══════════════════════════════════════════════════════════════════════
// Auto-detection
// ═══════════════════════════════════════════════════════════════════════

describe('detectRequestFormat', () => {
  it('detects curl', () => {
    expect(detectRequestFormat('curl https://example.com')?.label).toBe('cURL');
  });

  it('detects curl case-insensitive', () => {
    expect(detectRequestFormat('CURL https://example.com')?.label).toBe('cURL');
  });

  it('detects wget', () => {
    expect(detectRequestFormat('wget https://example.com')?.label).toBe('wget');
  });

  it('detects raw HTTP GET', () => {
    expect(detectRequestFormat('GET /api/users HTTP/1.1')?.label).toBe('Raw HTTP');
  });

  it('detects raw HTTP POST', () => {
    expect(detectRequestFormat('POST https://example.com/api')?.label).toBe('Raw HTTP');
  });

  it('returns undefined for unknown format', () => {
    expect(detectRequestFormat('hello world')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(detectRequestFormat('')).toBeUndefined();
  });

  it('prefers curl over raw HTTP for curl commands', () => {
    // "curl" starts with a valid HTTP method? No — "curl" is not an HTTP method.
    // This just confirms curl is detected first.
    expect(detectRequestFormat('curl -X GET https://example.com')?.label).toBe('cURL');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// cURL Importer
// ═══════════════════════════════════════════════════════════════════════

describe('CurlRequestImporter', () => {
  const importer = new CurlRequestImporter();

  // ── Detection ──

  describe('detect', () => {
    it('detects curl command', () => {
      expect(importer.detect('curl https://example.com')).toBe(true);
    });

    it('rejects non-curl', () => {
      expect(importer.detect('wget https://example.com')).toBe(false);
    });

    it('rejects empty', () => {
      expect(importer.detect('')).toBe(false);
    });
  });

  // ── Basic parsing ──

  describe('basic parsing', () => {
    it('parses simple GET', () => {
      const req = importer.parse('curl https://api.example.com/users');
      expect(req.http?.method).toBe('GET');
      expect(req.http?.url).toBe('https://api.example.com/users');
    });

    it('parses explicit method', () => {
      const req = importer.parse('curl -X DELETE https://api.example.com/users/1');
      expect(req.http?.method).toBe('DELETE');
    });

    it('parses --request long form', () => {
      const req = importer.parse('curl --request PUT https://api.example.com/users/1');
      expect(req.http?.method).toBe('PUT');
    });

    it('defaults to POST when -d is used', () => {
      const req = importer.parse('curl -d "data" https://api.example.com/users');
      expect(req.http?.method).toBe('POST');
    });

    it('explicit method overrides -d default', () => {
      const req = importer.parse('curl -X PATCH -d "data" https://api.example.com/users/1');
      expect(req.http?.method).toBe('PATCH');
    });

    it('throws on missing URL', () => {
      expect(() => importer.parse('curl -X GET')).toThrow('No URL found');
    });
  });

  // ── Headers ──

  describe('headers', () => {
    it('parses single header', () => {
      const req = importer.parse('curl -H "Content-Type: application/json" https://example.com');
      expect(req.http?.headers).toEqual([
        { name: 'Content-Type', value: 'application/json' },
      ]);
    });

    it('parses multiple headers', () => {
      const req = importer.parse(
        'curl -H "Accept: text/html" -H "X-Custom: foo" https://example.com'
      );
      expect(req.http?.headers).toHaveLength(2);
      expect(req.http?.headers?.[0]).toEqual({ name: 'Accept', value: 'text/html' });
      expect(req.http?.headers?.[1]).toEqual({ name: 'X-Custom', value: 'foo' });
    });

    it('parses --header long form', () => {
      const req = importer.parse('curl --header "Authorization: Bearer tok123" https://example.com');
      expect(req.http?.headers?.[0]).toEqual({ name: 'Authorization', value: 'Bearer tok123' });
    });

    it('parses user-agent flag', () => {
      const req = importer.parse('curl -A "MyAgent/1.0" https://example.com');
      expect(req.http?.headers).toContainEqual({ name: 'User-Agent', value: 'MyAgent/1.0' });
    });

    it('parses cookie flag', () => {
      const req = importer.parse('curl -b "session=abc123" https://example.com');
      expect(req.http?.headers).toContainEqual({ name: 'Cookie', value: 'session=abc123' });
    });
  });

  // ── Body ──

  describe('body', () => {
    it('parses -d body', () => {
      const req = importer.parse('curl -d \'{"key":"val"}\' https://example.com');
      expect(req.http?.body).toEqual({ type: 'json', data: '{"key":"val"}' });
    });

    it('parses --data-raw body', () => {
      const req = importer.parse('curl --data-raw "hello" https://example.com');
      expect(req.http?.body).toEqual({ type: 'text', data: 'hello' });
    });

    it('detects JSON body type from content', () => {
      const req = importer.parse('curl -d \'[1,2,3]\' https://example.com');
      expect((req.http?.body as any)?.type).toBe('json');
    });

    it('detects XML body type from Content-Type header', () => {
      const req = importer.parse(
        'curl -H "Content-Type: application/xml" -d "<root/>" https://example.com'
      );
      expect((req.http?.body as any)?.type).toBe('xml');
    });

    it('detects XML body type from content', () => {
      const req = importer.parse('curl -d "<root><item/></root>" https://example.com');
      expect((req.http?.body as any)?.type).toBe('xml');
    });

    it('falls back to text body type', () => {
      const req = importer.parse('curl -d "plain text data" https://example.com');
      expect((req.http?.body as any)?.type).toBe('text');
    });

    it('parses --data-urlencode as form-urlencoded', () => {
      const req = importer.parse(
        'curl --data-urlencode "name=John" --data-urlencode "age=30" https://example.com'
      );
      expect(req.http?.body).toEqual({
        type: 'form-urlencoded',
        data: [
          { name: 'name', value: 'John' },
          { name: 'age', value: '30' },
        ],
      });
    });
  });

  // ── Auth ──

  describe('auth', () => {
    it('parses basic auth with -u', () => {
      const req = importer.parse('curl -u admin:secret https://example.com');
      expect(req.runtime?.auth).toEqual({
        type: 'basic',
        username: 'admin',
        password: 'secret',
      });
    });

    it('parses basic auth without password', () => {
      const req = importer.parse('curl -u admin https://example.com');
      expect(req.runtime?.auth).toEqual({
        type: 'basic',
        username: 'admin',
        password: '',
      });
    });

    it('parses --user long form', () => {
      const req = importer.parse('curl --user user:pass https://example.com');
      expect(req.runtime?.auth).toEqual({
        type: 'basic',
        username: 'user',
        password: 'pass',
      });
    });
  });

  // ── Query params ──

  describe('query params', () => {
    it('extracts query params from URL', () => {
      const req = importer.parse('curl "https://example.com/api?page=1&limit=10"');
      expect(req.http?.url).toBe('https://example.com/api');
      expect(req.http?.params).toContainEqual({ name: 'page', value: '1', type: 'query' });
      expect(req.http?.params).toContainEqual({ name: 'limit', value: '10', type: 'query' });
    });

    it('handles URL without query params', () => {
      const req = importer.parse('curl https://example.com/api');
      expect(req.http?.params).toEqual([]);
    });
  });

  // ── Settings ──

  describe('settings', () => {
    it('parses --connect-timeout', () => {
      const req = importer.parse('curl --connect-timeout 10 https://example.com');
      expect(req.settings?.timeout).toBe(10000);
    });

    it('parses --max-time', () => {
      const req = importer.parse('curl --max-time 60 https://example.com');
      expect(req.settings?.timeout).toBe(60000);
    });

    it('defaults timeout to 30000', () => {
      const req = importer.parse('curl https://example.com');
      expect(req.settings?.timeout).toBe(30000);
    });

    it('sets followRedirects true by default', () => {
      const req = importer.parse('curl https://example.com');
      expect(req.settings?.followRedirects).toBe(true);
    });
  });

  // ── Quoting & line continuations ──

  describe('quoting and line continuations', () => {
    it('handles double-quoted URL', () => {
      const req = importer.parse('curl "https://example.com/path"');
      expect(req.http?.url).toBe('https://example.com/path');
    });

    it('handles single-quoted URL', () => {
      const req = importer.parse("curl 'https://example.com/path'");
      expect(req.http?.url).toBe('https://example.com/path');
    });

    it('handles bash line continuation (backslash-newline)', () => {
      const req = importer.parse(
        'curl \\\n  -X POST \\\n  -H "Content-Type: application/json" \\\n  https://example.com'
      );
      expect(req.http?.method).toBe('POST');
      expect(req.http?.url).toBe('https://example.com');
    });

    it('handles Windows CMD line continuation (caret-newline)', () => {
      const req = importer.parse(
        'curl ^\r\n  -X POST ^\r\n  -H "Content-Type: application/json" ^\r\n  https://example.com'
      );
      expect(req.http?.method).toBe('POST');
      expect(req.http?.url).toBe('https://example.com');
    });

    it('handles PowerShell line continuation (backtick-newline)', () => {
      const req = importer.parse(
        'curl `\n  -X POST `\n  -H "Content-Type: application/json" `\n  https://example.com'
      );
      expect(req.http?.method).toBe('POST');
      expect(req.http?.url).toBe('https://example.com');
    });

    it('handles combined short flags like -sSL', () => {
      const req = importer.parse('curl -sSL https://example.com');
      expect(req.http?.method).toBe('GET');
      expect(req.settings?.followRedirects).toBe(true);
    });
  });

  // ── Name derivation ──

  describe('name derivation', () => {
    it('derives name from method and path', () => {
      const req = importer.parse('curl https://api.example.com/v1/users');
      expect(req.info?.name).toBe('get-v1-users');
    });

    it('derives name for POST', () => {
      const req = importer.parse('curl -X POST https://api.example.com/users');
      expect(req.info?.name).toBe('post-users');
    });
  });

  // ── Real-world examples ──

  describe('real-world examples', () => {
    it('parses Chrome DevTools copy-as-curl (bash)', () => {
      const curl = `curl 'https://api.github.com/repos/octocat/Hello-World' \\
  -H 'accept: application/vnd.github.v3+json' \\
  -H 'user-agent: Mozilla/5.0' \\
  --compressed`;
      const req = importer.parse(curl);
      expect(req.http?.method).toBe('GET');
      expect(req.http?.url).toBe('https://api.github.com/repos/octocat/Hello-World');
      expect(req.http?.headers).toHaveLength(2);
    });

    it('parses Chrome DevTools copy-as-curl (cmd)', () => {
      const curl = `curl "https://api.github.com/repos/octocat/Hello-World" ^
  -H "accept: application/vnd.github.v3+json" ^
  -H "user-agent: Mozilla/5.0" ^
  --compressed`;
      const req = importer.parse(curl);
      expect(req.http?.method).toBe('GET');
      expect(req.http?.url).toBe('https://api.github.com/repos/octocat/Hello-World');
      expect(req.http?.headers).toHaveLength(2);
    });

    it('parses POST with JSON body', () => {
      const curl = `curl -X POST https://api.example.com/users \\
  -H 'Content-Type: application/json' \\
  -d '{"name": "John", "email": "john@example.com"}'`;
      const req = importer.parse(curl);
      expect(req.http?.method).toBe('POST');
      expect((req.http?.body as any)?.type).toBe('json');
      expect((req.http?.body as any)?.data).toBe('{"name": "John", "email": "john@example.com"}');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// wget Importer
// ═══════════════════════════════════════════════════════════════════════

describe('WgetRequestImporter', () => {
  const importer = new WgetRequestImporter();

  // ── Detection ──

  describe('detect', () => {
    it('detects wget command', () => {
      expect(importer.detect('wget https://example.com')).toBe(true);
    });

    it('rejects non-wget', () => {
      expect(importer.detect('curl https://example.com')).toBe(false);
    });

    it('rejects empty', () => {
      expect(importer.detect('')).toBe(false);
    });
  });

  // ── Basic parsing ──

  describe('basic parsing', () => {
    it('parses simple GET', () => {
      const req = importer.parse('wget https://api.example.com/users');
      expect(req.http?.method).toBe('GET');
      expect(req.http?.url).toBe('https://api.example.com/users');
    });

    it('parses --method', () => {
      const req = importer.parse('wget --method=PUT https://api.example.com/users/1');
      expect(req.http?.method).toBe('PUT');
    });

    it('parses --method with space separator', () => {
      const req = importer.parse('wget --method DELETE https://api.example.com/users/1');
      expect(req.http?.method).toBe('DELETE');
    });

    it('defaults to POST when --post-data is used', () => {
      const req = importer.parse('wget --post-data="data" https://example.com');
      expect(req.http?.method).toBe('POST');
    });

    it('throws on missing URL', () => {
      expect(() => importer.parse('wget --method=GET')).toThrow('No URL found');
    });
  });

  // ── Headers ──

  describe('headers', () => {
    it('parses --header with = separator', () => {
      const req = importer.parse('wget --header="Content-Type: application/json" https://example.com');
      expect(req.http?.headers).toEqual([
        { name: 'Content-Type', value: 'application/json' },
      ]);
    });

    it('parses multiple headers', () => {
      const req = importer.parse(
        'wget --header="Accept: text/html" --header="X-Custom: foo" https://example.com'
      );
      expect(req.http?.headers).toHaveLength(2);
    });

    it('parses user-agent with --user-agent=', () => {
      const req = importer.parse('wget --user-agent="MyBot/1.0" https://example.com');
      expect(req.http?.headers).toContainEqual({ name: 'User-Agent', value: 'MyBot/1.0' });
    });

    it('parses user-agent with -U', () => {
      const req = importer.parse('wget -U "MyBot/1.0" https://example.com');
      expect(req.http?.headers).toContainEqual({ name: 'User-Agent', value: 'MyBot/1.0' });
    });
  });

  // ── Body ──

  describe('body', () => {
    it('parses --post-data', () => {
      const req = importer.parse('wget --post-data=\'{"key":"val"}\' https://example.com');
      expect(req.http?.body).toEqual({ type: 'json', data: '{"key":"val"}' });
    });

    it('parses --body-data', () => {
      const req = importer.parse('wget --method=PUT --body-data="update" https://example.com');
      expect(req.http?.body).toEqual({ type: 'text', data: 'update' });
      expect(req.http?.method).toBe('PUT');
    });

    it('detects XML body from Content-Type', () => {
      const req = importer.parse(
        'wget --header="Content-Type: application/xml" --post-data="<root/>" https://example.com'
      );
      expect((req.http?.body as any)?.type).toBe('xml');
    });

    it('detects JSON body from content', () => {
      const req = importer.parse('wget --post-data=\'[1,2]\' https://example.com');
      expect((req.http?.body as any)?.type).toBe('json');
    });
  });

  // ── Auth ──

  describe('auth', () => {
    it('parses --http-user and --http-password', () => {
      const req = importer.parse(
        'wget --http-user=admin --http-password=secret https://example.com'
      );
      expect(req.runtime?.auth).toEqual({
        type: 'basic',
        username: 'admin',
        password: 'secret',
      });
    });

    it('parses --http-user without password', () => {
      const req = importer.parse('wget --http-user=admin https://example.com');
      expect(req.runtime?.auth).toEqual({
        type: 'basic',
        username: 'admin',
        password: '',
      });
    });
  });

  // ── Query params ──

  describe('query params', () => {
    it('extracts query params from URL', () => {
      const req = importer.parse('wget "https://example.com/api?page=1&limit=10"');
      expect(req.http?.url).toBe('https://example.com/api');
      expect(req.http?.params).toContainEqual({ name: 'page', value: '1', type: 'query' });
      expect(req.http?.params).toContainEqual({ name: 'limit', value: '10', type: 'query' });
    });
  });

  // ── Settings ──

  describe('settings', () => {
    it('parses --timeout', () => {
      const req = importer.parse('wget --timeout=15 https://example.com');
      expect(req.settings?.timeout).toBe(15000);
    });

    it('parses -T short form', () => {
      const req = importer.parse('wget -T 20 https://example.com');
      expect(req.settings?.timeout).toBe(20000);
    });

    it('parses --max-redirect', () => {
      const req = importer.parse('wget --max-redirect=3 https://example.com');
      expect(req.settings?.maxRedirects).toBe(3);
    });

    it('defaults timeout to 30000', () => {
      const req = importer.parse('wget https://example.com');
      expect(req.settings?.timeout).toBe(30000);
    });
  });

  // ── Name derivation ──

  describe('name derivation', () => {
    it('derives name from method and path', () => {
      const req = importer.parse('wget https://api.example.com/v1/users');
      expect(req.info?.name).toBe('get-v1-users');
    });
  });

  // ── Line continuations ──

  describe('line continuations', () => {
    it('handles bash line continuation', () => {
      const cmd = `wget \\\n  --header="Accept: application/json" \\\n  https://example.com`;
      const req = importer.parse(cmd);
      expect(req.http?.url).toBe('https://example.com');
      expect(req.http?.headers).toHaveLength(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Raw HTTP Importer
// ═══════════════════════════════════════════════════════════════════════

describe('HttpRawRequestImporter', () => {
  const importer = new HttpRawRequestImporter();

  // ── Detection ──

  describe('detect', () => {
    it('detects GET request', () => {
      expect(importer.detect('GET /api/users HTTP/1.1')).toBe(true);
    });

    it('detects POST request', () => {
      expect(importer.detect('POST https://example.com/api')).toBe(true);
    });

    it('detects DELETE request', () => {
      expect(importer.detect('DELETE /api/users/1 HTTP/1.1')).toBe(true);
    });

    it('detects all standard methods', () => {
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        expect(importer.detect(`${m} /path HTTP/1.1`)).toBe(true);
      }
    });

    it('rejects curl', () => {
      expect(importer.detect('curl https://example.com')).toBe(false);
    });

    it('rejects wget', () => {
      expect(importer.detect('wget https://example.com')).toBe(false);
    });

    it('rejects random text', () => {
      expect(importer.detect('hello world')).toBe(false);
    });

    it('rejects empty', () => {
      expect(importer.detect('')).toBe(false);
    });
  });

  // ── Basic parsing ──

  describe('basic parsing', () => {
    it('parses GET with full URL', () => {
      const req = importer.parse('GET https://api.example.com/users HTTP/1.1');
      expect(req.http?.method).toBe('GET');
      expect(req.http?.url).toBe('https://api.example.com/users');
    });

    it('parses GET without HTTP version', () => {
      const req = importer.parse('GET https://api.example.com/users');
      expect(req.http?.method).toBe('GET');
      expect(req.http?.url).toBe('https://api.example.com/users');
    });

    it('parses relative path with Host header', () => {
      const req = importer.parse(
        'GET /api/users HTTP/1.1\nHost: api.example.com'
      );
      expect(req.http?.method).toBe('GET');
      expect(req.http?.url).toBe('https://api.example.com/api/users');
    });

    it('throws on empty input', () => {
      expect(() => importer.parse('')).toThrow();
    });

    it('throws on invalid request line', () => {
      expect(() => importer.parse('INVALID')).toThrow('Invalid HTTP request line');
    });
  });

  // ── Headers ──

  describe('headers', () => {
    it('parses headers', () => {
      const req = importer.parse(
        'GET /api HTTP/1.1\nHost: example.com\nAccept: application/json\nX-Custom: foo'
      );
      expect(req.http?.headers).toEqual([
        { name: 'Accept', value: 'application/json' },
        { name: 'X-Custom', value: 'foo' },
      ]);
    });

    it('Host header is consumed into URL, not kept as header', () => {
      const req = importer.parse('GET /api HTTP/1.1\nHost: example.com');
      expect(req.http?.headers?.find(h => h.name === 'Host')).toBeUndefined();
      expect(req.http?.url).toBe('https://example.com/api');
    });
  });

  // ── Body ──

  describe('body', () => {
    it('parses body after blank line', () => {
      const req = importer.parse(
        'POST /api/users HTTP/1.1\nHost: example.com\nContent-Type: application/json\n\n{"name": "John"}'
      );
      expect(req.http?.method).toBe('POST');
      expect(req.http?.body).toEqual({ type: 'json', data: '{"name": "John"}' });
    });

    it('parses multi-line body', () => {
      const req = importer.parse(
        'POST /api HTTP/1.1\nHost: example.com\nContent-Type: application/json\n\n{\n  "name": "John",\n  "age": 30\n}'
      );
      expect((req.http?.body as any)?.data).toBe('{\n  "name": "John",\n  "age": 30\n}');
    });

    it('detects XML body', () => {
      const req = importer.parse(
        'POST /api HTTP/1.1\nHost: example.com\nContent-Type: application/xml\n\n<root><item/></root>'
      );
      expect((req.http?.body as any)?.type).toBe('xml');
    });

    it('no body when no blank line separator', () => {
      const req = importer.parse(
        'GET /api HTTP/1.1\nHost: example.com\nAccept: text/html'
      );
      expect(req.http?.body).toBeUndefined();
    });

    it('no body when blank line but nothing after', () => {
      const req = importer.parse(
        'GET /api HTTP/1.1\nHost: example.com\n\n'
      );
      expect(req.http?.body).toBeUndefined();
    });
  });

  // ── Auth ──

  describe('auth', () => {
    it('parses Basic auth from Authorization header', () => {
      const encoded = Buffer.from('admin:secret').toString('base64');
      const req = importer.parse(
        `GET /api HTTP/1.1\nHost: example.com\nAuthorization: Basic ${encoded}`
      );
      expect(req.runtime?.auth).toEqual({
        type: 'basic',
        username: 'admin',
        password: 'secret',
      });
      // Authorization header should be removed
      expect(req.http?.headers?.find(h => h.name === 'Authorization')).toBeUndefined();
    });

    it('parses Bearer auth from Authorization header', () => {
      const req = importer.parse(
        'GET /api HTTP/1.1\nHost: example.com\nAuthorization: Bearer mytoken123'
      );
      expect(req.runtime?.auth).toEqual({
        type: 'bearer',
        token: 'mytoken123',
      });
      expect(req.http?.headers?.find(h => h.name === 'Authorization')).toBeUndefined();
    });

    it('keeps unknown auth scheme as header', () => {
      const req = importer.parse(
        'GET /api HTTP/1.1\nHost: example.com\nAuthorization: Digest realm="test"'
      );
      expect(req.runtime?.auth).toBeUndefined();
      expect(req.http?.headers?.find(h => h.name === 'Authorization')).toBeDefined();
    });
  });

  // ── Query params ──

  describe('query params', () => {
    it('extracts query params from full URL', () => {
      const req = importer.parse('GET https://example.com/api?page=1&limit=10 HTTP/1.1');
      expect(req.http?.url).toBe('https://example.com/api');
      expect(req.http?.params).toContainEqual({ name: 'page', value: '1', type: 'query' });
      expect(req.http?.params).toContainEqual({ name: 'limit', value: '10', type: 'query' });
    });

    it('extracts query params from relative URL', () => {
      const req = importer.parse('GET /api?q=search HTTP/1.1\nHost: example.com');
      expect(req.http?.url).toBe('https://example.com/api');
      expect(req.http?.params).toContainEqual({ name: 'q', value: 'search', type: 'query' });
    });
  });

  // ── Name derivation ──

  describe('name derivation', () => {
    it('derives name from method and path', () => {
      const req = importer.parse('GET https://api.example.com/v1/users HTTP/1.1');
      expect(req.info?.name).toBe('get-v1-users');
    });

    it('derives name for POST', () => {
      const req = importer.parse('POST https://api.example.com/users HTTP/1.1');
      expect(req.info?.name).toBe('post-users');
    });
  });

  // ── Real-world examples ──

  describe('real-world examples', () => {
    it('parses full HTTP request with body', () => {
      const raw = `POST /api/v1/users HTTP/1.1
Host: api.example.com
Content-Type: application/json
Accept: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9

{
  "name": "Jane Doe",
  "email": "jane@example.com"
}`;
      const req = importer.parse(raw);
      expect(req.http?.method).toBe('POST');
      expect(req.http?.url).toBe('https://api.example.com/api/v1/users');
      expect(req.http?.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' });
      expect(req.http?.headers).toContainEqual({ name: 'Accept', value: 'application/json' });
      expect(req.runtime?.auth).toEqual({ type: 'bearer', token: 'eyJhbGciOiJIUzI1NiJ9' });
      expect((req.http?.body as any)?.type).toBe('json');
    });

    it('parses simple GET from REST client format', () => {
      const raw = `GET https://jsonplaceholder.typicode.com/posts/1`;
      const req = importer.parse(raw);
      expect(req.http?.method).toBe('GET');
      expect(req.http?.url).toBe('https://jsonplaceholder.typicode.com/posts/1');
    });
  });
});
