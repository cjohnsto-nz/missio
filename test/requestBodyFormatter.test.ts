// @vitest-environment jsdom
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

  it('formats XML with proper indentation', () => {
    const input = '<root><child attr="val"><item>text</item></child></root>';
    const formatted = formatRawBody(input, 'xml', '  ');
    expect(formatted).toBe(
      '<root>\n' +
      '  <child attr="val">\n' +
      '    <item>text</item>\n' +
      '  </child>\n' +
      '</root>'
    );
  });

  it('preserves XML declaration when formatting', () => {
    const input = '<?xml version="1.0"?><root><a>1</a></root>';
    const formatted = formatRawBody(input, 'xml', '  ');
    expect(formatted).toContain('<?xml version="1.0"?>');
    expect(formatted).toContain('<root>');
  });

  it('throws on invalid XML', () => {
    expect(() => formatRawBody('<root><unclosed>', 'xml', '  ')).toThrow();
  });

  it('formats HTML body content', () => {
    const input = '<div><p>Hello</p><span>World</span></div>';
    const formatted = formatRawBody(input, 'html', '  ');
    // DOMParser uppercases HTML tag names (standard DOM behavior)
    expect(formatted).toContain('<DIV>');
    expect(formatted).toContain('  <P>Hello</P>');
    expect(formatted).toContain('  <SPAN>World</SPAN>');
  });

  it('formats full HTML document with doctype', () => {
    const input = '<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hi</p></body></html>';
    const formatted = formatRawBody(input, 'html', '  ');
    expect(formatted).toMatch(/^<!DOCTYPE html>/);
    expect(formatted).toContain('<TITLE>Test</TITLE>');
    expect(formatted).toContain('<P>Hi</P>');
  });

  it('handles HTML void elements without closing tags', () => {
    const input = '<div><br><img src="x.png"><hr></div>';
    const formatted = formatRawBody(input, 'html', '  ');
    expect(formatted).toContain('<BR>');
    expect(formatted).toContain('<IMG src="x.png">');
    expect(formatted).toContain('<HR>');
    // Void elements should not have closing tags
    expect(formatted).not.toContain('</BR>');
    expect(formatted).not.toContain('</IMG>');
  });

  it('reports which raw body types are formattable', () => {
    expect(canFormatRawBody('json')).toBe(true);
    expect(canFormatRawBody('yaml')).toBe(true);
    expect(canFormatRawBody('xml')).toBe(true);
    expect(canFormatRawBody('html')).toBe(true);
    expect(canFormatRawBody('text')).toBe(false);
  });
});