/**
 * cURL command → OpenCollection HttpRequest importer.
 *
 * Supports common curl flags:
 *   -X / --request METHOD
 *   -H / --header "Name: Value"
 *   -d / --data / --data-raw / --data-binary BODY
 *   --data-urlencode KEY=VALUE
 *   -u / --user USER:PASS  (basic auth)
 *   -A / --user-agent AGENT
 *   -b / --cookie COOKIE
 *   -L / --location  (follow redirects)
 *   -k / --insecure
 *   --compressed  (ignored — just accept-encoding)
 *   --connect-timeout / --max-time
 */

import type {
  HttpRequest, HttpRequestHeader, HttpRequestParam,
  HttpRequestBody, FormUrlEncodedBody,
} from '../models/types';
import type { RequestTextImporter } from './requestImporters';

export class CurlRequestImporter implements RequestTextImporter {
  readonly label = 'cURL';

  detect(text: string): boolean {
    const trimmed = text.trim();
    return /^curl\s/i.test(trimmed);
  }

  parse(text: string): HttpRequest {
    const tokens = this._tokenize(text);
    // Remove leading "curl"
    if (tokens.length > 0 && tokens[0].toLowerCase() === 'curl') {
      tokens.shift();
    }

    let method: string | undefined;
    let url: string | undefined;
    const headers: HttpRequestHeader[] = [];
    let bodyData: string | undefined;
    let isFormEncoded = false;
    const formEntries: { name: string; value: string }[] = [];
    let basicAuth: { username: string; password: string } | undefined;
    let followRedirects = true;
    let timeout: number | undefined;

    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];

      if (tok === '-X' || tok === '--request') {
        method = tokens[++i]?.toUpperCase();
      } else if (tok === '-H' || tok === '--header') {
        const hdr = tokens[++i];
        if (hdr) {
          const colonIdx = hdr.indexOf(':');
          if (colonIdx > 0) {
            headers.push({
              name: hdr.substring(0, colonIdx).trim(),
              value: hdr.substring(colonIdx + 1).trim(),
            });
          }
        }
      } else if (tok === '-d' || tok === '--data' || tok === '--data-raw' || tok === '--data-binary') {
        bodyData = tokens[++i] ?? '';
        if (!method) method = 'POST';
      } else if (tok === '--data-urlencode') {
        isFormEncoded = true;
        const entry = tokens[++i] ?? '';
        const eqIdx = entry.indexOf('=');
        if (eqIdx > 0) {
          formEntries.push({
            name: entry.substring(0, eqIdx),
            value: entry.substring(eqIdx + 1),
          });
        } else {
          formEntries.push({ name: entry, value: '' });
        }
        if (!method) method = 'POST';
      } else if (tok === '-u' || tok === '--user') {
        const cred = tokens[++i] ?? '';
        const colonIdx = cred.indexOf(':');
        if (colonIdx > 0) {
          basicAuth = {
            username: cred.substring(0, colonIdx),
            password: cred.substring(colonIdx + 1),
          };
        } else {
          basicAuth = { username: cred, password: '' };
        }
      } else if (tok === '-A' || tok === '--user-agent') {
        headers.push({ name: 'User-Agent', value: tokens[++i] ?? '' });
      } else if (tok === '-b' || tok === '--cookie') {
        headers.push({ name: 'Cookie', value: tokens[++i] ?? '' });
      } else if (tok === '-L' || tok === '--location') {
        followRedirects = true;
      } else if (tok === '-k' || tok === '--insecure') {
        // Noted but not directly mapped to settings
      } else if (tok === '--compressed') {
        // Accept-Encoding is auto-handled
      } else if (tok === '--connect-timeout' || tok === '--max-time') {
        const val = parseInt(tokens[++i] ?? '', 10);
        if (!isNaN(val)) timeout = val * 1000; // curl uses seconds
      } else if (tok.startsWith('-') && !tok.startsWith('--') && tok.length > 2) {
        // Combined short flags like -sL, -sSL etc.
        for (const ch of tok.substring(1)) {
          if (ch === 'L') followRedirects = true;
          // s, S, etc. are silently ignored
        }
      } else if (!tok.startsWith('-') && !url) {
        // Positional argument = URL
        url = tok;
      }
      i++;
    }

    if (!url) {
      throw new Error('No URL found in cURL command');
    }
    if (!method) method = 'GET';

    // Parse URL query params
    const params: HttpRequestParam[] = [];
    let cleanUrl = url;
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      cleanUrl = url.substring(0, qIdx);
      const qs = url.substring(qIdx + 1);
      const searchParams = new URLSearchParams(qs);
      searchParams.forEach((value, name) => {
        params.push({ name, value, type: 'query' });
      });
    }

    // Build body
    let body: HttpRequestBody | undefined;
    if (isFormEncoded && formEntries.length > 0) {
      body = {
        type: 'form-urlencoded',
        data: formEntries.map(e => ({ name: e.name, value: e.value })),
      } as FormUrlEncodedBody;
    } else if (bodyData !== undefined) {
      // Try to detect body type from Content-Type header
      const ctHeader = headers.find(h => h.name.toLowerCase() === 'content-type');
      const ct = ctHeader?.value?.toLowerCase() ?? '';
      let bodyType: 'json' | 'xml' | 'text' = 'text';
      if (ct.includes('json') || (bodyData.trim().startsWith('{') || bodyData.trim().startsWith('['))) {
        bodyType = 'json';
      } else if (ct.includes('xml') || bodyData.trim().startsWith('<')) {
        bodyType = 'xml';
      }
      body = { type: bodyType, data: bodyData };
    }

    // Derive a name from the URL path
    const urlPath = cleanUrl.replace(/^https?:\/\/[^/]+/, '');
    const pathSegments = urlPath.split('/').filter(Boolean);
    const nameParts = [method.toLowerCase()];
    if (pathSegments.length > 0) {
      nameParts.push(...pathSegments.slice(-2));
    }
    const name = nameParts.join('-').replace(/[^a-z0-9-]/g, '');

    const request: HttpRequest = {
      info: { name, type: 'http' },
      http: {
        method,
        url: cleanUrl,
        headers,
        params: params.length > 0 ? params : [],
        ...(body ? { body } : {}),
      },
      ...(basicAuth ? {
        runtime: {
          auth: {
            type: 'basic' as const,
            username: basicAuth.username,
            password: basicAuth.password,
          },
        },
      } : {}),
      settings: {
        encodeUrl: true,
        timeout: timeout ?? 30000,
        followRedirects,
        maxRedirects: 5,
      },
    };

    return request;
  }

  /**
   * Tokenize a curl command, handling:
   *  - Line continuations (backslash-newline, ^ on Windows)
   *  - Single and double quoted strings
   *  - $'...' ANSI-C quoting
   */
  private _tokenize(text: string): string[] {
    // Normalize line continuations
    let normalized = text
      .replace(/\\\r?\n\s*/g, ' ')   // Unix: backslash + newline
      .replace(/\^\r?\n\s*/g, ' ')    // Windows: caret + newline
      .replace(/`\r?\n\s*/g, ' ')     // PowerShell: backtick + newline
      .trim();

    const tokens: string[] = [];
    let i = 0;
    while (i < normalized.length) {
      // Skip whitespace
      while (i < normalized.length && /\s/.test(normalized[i])) i++;
      if (i >= normalized.length) break;

      let token = '';
      const ch = normalized[i];

      if (ch === "'" || ch === '"') {
        // Quoted string
        const quote = ch;
        i++; // skip opening quote
        while (i < normalized.length && normalized[i] !== quote) {
          if (normalized[i] === '\\' && quote === '"') {
            i++;
            if (i < normalized.length) token += normalized[i];
          } else {
            token += normalized[i];
          }
          i++;
        }
        i++; // skip closing quote
      } else if (normalized[i] === '$' && i + 1 < normalized.length && normalized[i + 1] === "'") {
        // $'...' ANSI-C quoting
        i += 2;
        while (i < normalized.length && normalized[i] !== "'") {
          if (normalized[i] === '\\' && i + 1 < normalized.length) {
            i++;
            switch (normalized[i]) {
              case 'n': token += '\n'; break;
              case 't': token += '\t'; break;
              case 'r': token += '\r'; break;
              case '\\': token += '\\'; break;
              case "'": token += "'"; break;
              default: token += '\\' + normalized[i];
            }
          } else {
            token += normalized[i];
          }
          i++;
        }
        i++; // skip closing '
      } else {
        // Unquoted token
        while (i < normalized.length && !/\s/.test(normalized[i])) {
          token += normalized[i];
          i++;
        }
      }

      if (token.length > 0) {
        tokens.push(token);
      }
    }

    return tokens;
  }
}
