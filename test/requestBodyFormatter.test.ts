import { describe, expect, it } from 'vitest';
import { canFormatRawBody, formatRawBody } from '../src/webview/requestBodyFormatter';

describe('requestBodyFormatter', () => {
  it('formats JSON using the configured indentation', () => {
    expect(formatRawBody('{"b":1,"a":{"c":true}}', 'json', '  ')).toBe(`{
  "b": 1,
  "a": {
    "c": true
  }
}`);
  });

  it('formats YAML using the existing yaml library', () => {
    expect(formatRawBody('foo: bar\nbaz:\n- 1\n-  2', 'yaml', '  ')).toBe(`foo: bar
baz:
  - 1
  - 2`);
  });

  it('reports which raw body types are formattable', () => {
    expect(canFormatRawBody('json')).toBe(true);
    expect(canFormatRawBody('yaml')).toBe(true);
    expect(canFormatRawBody('text')).toBe(false);
  });
});