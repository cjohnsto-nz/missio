/**
 * wget command → OpenCollection HttpRequest importer.
 *
 * Supports common wget flags:
 *   --method=METHOD
 *   --header="Name: Value"
 *   --post-data=DATA / --body-data=DATA
 *   --post-file=FILE (noted but file content not read)
 *   --http-user=USER / --http-password=PASS (basic auth)
 *   --user-agent=AGENT / -U AGENT
 *   --header="Cookie: ..."
 *   --max-redirect=N
 *   --timeout=N / -T N
 *   --no-check-certificate
 *   -O / --output-document (ignored — output file)
 *   -q / --quiet (ignored)
 */

import type {
  HttpRequest, HttpRequestHeader, HttpRequestParam,
  HttpRequestBody,
} from '../models/types';
import type { RequestTextImporter } from './requestImporters';

export class WgetRequestImporter implements RequestTextImporter {
  readonly label = 'wget';

  detect(text: string): boolean {
    const trimmed = text.trim();
    return /^wget\s/i.test(trimmed);
  }

  parse(text: string): HttpRequest {
    const tokens = this._tokenize(text);
    if (tokens.length > 0 && tokens[0].toLowerCase() === 'wget') {
      tokens.shift();
    }

    let method: string | undefined;
    let url: string | undefined;
    const headers: HttpRequestHeader[] = [];
    let bodyData: string | undefined;
    let httpUser: string | undefined;
    let httpPassword: string | undefined;
    let maxRedirects = 5;
    let timeout: number | undefined;

    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];

      // --long=value style
      if (tok.startsWith('--')) {
        const eqIdx = tok.indexOf('=');
        const key = eqIdx > 0 ? tok.substring(0, eqIdx) : tok;
        const val = eqIdx > 0 ? tok.substring(eqIdx + 1) : tokens[++i] ?? '';

        switch (key) {
          case '--method':
            method = val.toUpperCase();
            break;
          case '--header':
            this._parseHeader(val, headers);
            break;
          case '--post-data':
          case '--body-data':
            bodyData = val;
            if (!method) method = 'POST';
            break;
          case '--post-file':
            // Can't read file content, but note it
            if (!method) method = 'POST';
            break;
          case '--http-user':
            httpUser = val;
            break;
          case '--http-password':
          case '--http-passwd':
            httpPassword = val;
            break;
          case '--user-agent':
            headers.push({ name: 'User-Agent', value: val });
            break;
          case '--max-redirect':
            maxRedirects = parseInt(val, 10) || 5;
            break;
          case '--timeout':
            timeout = (parseInt(val, 10) || 30) * 1000;
            break;
          case '--no-check-certificate':
            // Noted
            break;
          case '--output-document':
          case '--quiet':
            // Ignored
            break;
          default:
            // Unknown long option — skip
            break;
        }
      } else if (tok.startsWith('-') && tok.length === 2) {
        // Short flags
        const flag = tok[1];
        switch (flag) {
          case 'U':
            headers.push({ name: 'User-Agent', value: tokens[++i] ?? '' });
            break;
          case 'T':
            timeout = (parseInt(tokens[++i] ?? '', 10) || 30) * 1000;
            break;
          case 'O':
          case 'o':
          case 'q':
            // Output/quiet — skip value if present
            if (flag === 'O' || flag === 'o') i++;
            break;
          default:
            break;
        }
      } else if (!tok.startsWith('-') && !url) {
        url = tok;
      }
      i++;
    }

    if (!url) {
      throw new Error('No URL found in wget command');
    }
    if (!method) method = bodyData !== undefined ? 'POST' : 'GET';

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
    if (bodyData !== undefined) {
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

    // Derive name
    const urlPath = cleanUrl.replace(/^https?:\/\/[^/]+/, '');
    const pathSegments = urlPath.split('/').filter(Boolean);
    const nameParts = [method.toLowerCase()];
    if (pathSegments.length > 0) {
      nameParts.push(...pathSegments.slice(-2));
    }
    const name = nameParts.join('-').replace(/[^a-z0-9-]/g, '');

    // Auth
    let auth: any;
    if (httpUser) {
      auth = {
        type: 'basic' as const,
        username: httpUser,
        password: httpPassword ?? '',
      };
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
        timeout: timeout ?? 30000,
        followRedirects: true,
        maxRedirects,
      },
    };

    return request;
  }

  private _parseHeader(hdr: string, headers: HttpRequestHeader[]): void {
    const colonIdx = hdr.indexOf(':');
    if (colonIdx > 0) {
      headers.push({
        name: hdr.substring(0, colonIdx).trim(),
        value: hdr.substring(colonIdx + 1).trim(),
      });
    }
  }

  private _tokenize(text: string): string[] {
    let normalized = text
      .replace(/\\\r?\n\s*/g, ' ')
      .replace(/\^\r?\n\s*/g, ' ')
      .replace(/`\r?\n\s*/g, ' ')
      .trim();

    const tokens: string[] = [];
    let i = 0;
    while (i < normalized.length) {
      while (i < normalized.length && /\s/.test(normalized[i])) i++;
      if (i >= normalized.length) break;

      // Build a single token, handling quotes that can start mid-token
      // e.g. --post-data='{"key":"val"}' → token is --post-data={"key":"val"}
      let token = '';
      while (i < normalized.length && !/\s/.test(normalized[i])) {
        const ch = normalized[i];
        if (ch === "'" || ch === '"') {
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
          if (i < normalized.length) i++; // skip closing quote
        } else {
          token += ch;
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
