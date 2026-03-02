/**
 * Raw HTTP request → OpenCollection HttpRequest importer.
 *
 * Parses the standard HTTP/1.1 wire format:
 *
 *   METHOD /path HTTP/1.1
 *   Host: example.com
 *   Content-Type: application/json
 *
 *   {"key": "value"}
 *
 * Also accepts simplified forms without HTTP version:
 *   GET https://example.com/path
 *   Header: value
 */

import type {
  HttpRequest, HttpRequestHeader, HttpRequestParam,
  HttpRequestBody,
} from '../models/types';
import type { RequestTextImporter } from './requestImporters';

const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT',
]);

export class HttpRawRequestImporter implements RequestTextImporter {
  readonly label = 'Raw HTTP';

  detect(text: string): boolean {
    const firstLine = text.trim().split(/\r?\n/)[0]?.trim() ?? '';
    // Match: METHOD /path or METHOD https://... with optional HTTP/x.x
    const match = firstLine.match(/^([A-Z]+)\s+\S+/);
    if (!match) return false;
    return HTTP_METHODS.has(match[1]);
  }

  parse(text: string): HttpRequest {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length === 0) {
      throw new Error('Empty HTTP request');
    }

    // Parse request line: METHOD URL [HTTP/x.x]
    const requestLine = lines[0].trim();
    const rlMatch = requestLine.match(/^([A-Z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/);
    if (!rlMatch) {
      throw new Error(`Invalid HTTP request line: ${requestLine}`);
    }

    const method = rlMatch[1];
    let rawUrl = rlMatch[2];

    // Parse headers (lines after request line until empty line)
    const headers: HttpRequestHeader[] = [];
    let bodyStartIdx = lines.length; // default: no body
    let host: string | undefined;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        bodyStartIdx = i + 1;
        break;
      }
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const name = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        if (name.toLowerCase() === 'host') {
          host = value;
        } else {
          headers.push({ name, value });
        }
      }
    }

    // Parse body (everything after the blank line)
    let bodyText: string | undefined;
    if (bodyStartIdx < lines.length) {
      bodyText = lines.slice(bodyStartIdx).join('\n').trimEnd();
      if (bodyText === '') bodyText = undefined;
    }

    // Build full URL
    let fullUrl: string;
    if (/^https?:\/\//i.test(rawUrl)) {
      fullUrl = rawUrl;
    } else {
      // Relative path — combine with Host header
      const scheme = 'https';
      fullUrl = host ? `${scheme}://${host}${rawUrl}` : rawUrl;
    }

    // Parse URL query params
    const params: HttpRequestParam[] = [];
    let cleanUrl = fullUrl;
    const qIdx = fullUrl.indexOf('?');
    if (qIdx >= 0) {
      cleanUrl = fullUrl.substring(0, qIdx);
      const qs = fullUrl.substring(qIdx + 1);
      const searchParams = new URLSearchParams(qs);
      searchParams.forEach((value, name) => {
        params.push({ name, value, type: 'query' });
      });
    }

    // Build body
    let body: HttpRequestBody | undefined;
    if (bodyText !== undefined) {
      const ctHeader = headers.find(h => h.name.toLowerCase() === 'content-type');
      const ct = ctHeader?.value?.toLowerCase() ?? '';
      let bodyType: 'json' | 'xml' | 'text' = 'text';
      if (ct.includes('json') || (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('['))) {
        bodyType = 'json';
      } else if (ct.includes('xml') || bodyText.trim().startsWith('<')) {
        bodyType = 'xml';
      }
      body = { type: bodyType, data: bodyText };
    }

    // Derive name
    const urlPath = cleanUrl.replace(/^https?:\/\/[^/]+/, '');
    const pathSegments = urlPath.split('/').filter(Boolean);
    const nameParts = [method.toLowerCase()];
    if (pathSegments.length > 0) {
      nameParts.push(...pathSegments.slice(-2));
    }
    const name = nameParts.join('-').replace(/[^a-z0-9-]/g, '');

    // Check for Authorization header → basic auth
    let auth: any;
    const authHeader = headers.find(h => h.name.toLowerCase() === 'authorization');
    if (authHeader) {
      const val = authHeader.value;
      if (val.toLowerCase().startsWith('basic ')) {
        try {
          const decoded = Buffer.from(val.substring(6).trim(), 'base64').toString('utf-8');
          const colonIdx = decoded.indexOf(':');
          if (colonIdx > 0) {
            auth = {
              type: 'basic' as const,
              username: decoded.substring(0, colonIdx),
              password: decoded.substring(colonIdx + 1),
            };
            // Remove the Authorization header since we have auth object
            const idx = headers.indexOf(authHeader);
            if (idx >= 0) headers.splice(idx, 1);
          }
        } catch {
          // Leave as header if decode fails
        }
      } else if (val.toLowerCase().startsWith('bearer ')) {
        auth = {
          type: 'bearer' as const,
          token: val.substring(7).trim(),
        };
        const idx = headers.indexOf(authHeader);
        if (idx >= 0) headers.splice(idx, 1);
      }
    }

    const request: HttpRequest = {
      info: { name, type: 'http' },
      http: {
        method,
        url: cleanUrl,
        headers,
        params: params.length > 0 ? params : [],
        ...(body ? { body } : {}),
      },
      ...(auth ? { runtime: { auth } } : {}),
      settings: {
        encodeUrl: true,
        timeout: 30000,
        followRedirects: true,
        maxRedirects: 5,
      },
    };

    return request;
  }
}
