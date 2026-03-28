import { HTTPSnippet, type HarRequest } from 'httpsnippet';
import type { ResolvedRequest } from './httpClient';

/** A single export target (target + client combination). */
export interface ExportTarget {
  /** Composite ID: "targetId:clientId" (e.g. "shell:curl") */
  id: string;
  /** Display label (e.g. "cURL") */
  label: string;
  /** File extension without dot (e.g. "sh") */
  ext: string;
  /** highlight.js language identifier */
  lang: string;
}

/**
 * All available export targets, ordered to match the Postman-style dropdown.
 * Derived from httpsnippet's built-in targets.
 */
export const EXPORT_TARGETS: ExportTarget[] = [
  // C
  { id: 'c:libcurl',               label: 'C - libcurl',                ext: 'c',     lang: 'c' },
  // C#
  { id: 'csharp:httpclient',       label: 'C# - HttpClient',           ext: 'cs',    lang: 'csharp' },
  { id: 'csharp:restsharp',        label: 'C# - RestSharp',            ext: 'cs',    lang: 'csharp' },
  // Clojure
  { id: 'clojure:clj_http',        label: 'Clojure - clj-http',        ext: 'clj',   lang: 'clojure' },
  // cURL (top-level, the default)
  { id: 'shell:curl',              label: 'cURL',                       ext: 'sh',    lang: 'bash' },
  // Go
  { id: 'go:native',               label: 'Go - Native',               ext: 'go',    lang: 'go' },
  // HTTP
  { id: 'http:http1.1',            label: 'HTTP',                       ext: 'http',  lang: 'http' },
  // Java
  { id: 'java:asynchttp',          label: 'Java - AsyncHttp',          ext: 'java',  lang: 'java' },
  { id: 'java:nethttp',            label: 'Java - java.net.http',      ext: 'java',  lang: 'java' },
  { id: 'java:okhttp',             label: 'Java - OkHttp',             ext: 'java',  lang: 'java' },
  { id: 'java:unirest',            label: 'Java - Unirest',            ext: 'java',  lang: 'java' },
  // JavaScript
  { id: 'javascript:axios',        label: 'JavaScript - Axios',        ext: 'js',    lang: 'javascript' },
  { id: 'javascript:fetch',        label: 'JavaScript - Fetch',        ext: 'js',    lang: 'javascript' },
  { id: 'javascript:jquery',       label: 'JavaScript - jQuery',       ext: 'js',    lang: 'javascript' },
  { id: 'javascript:xhr',          label: 'JavaScript - XHR',          ext: 'js',    lang: 'javascript' },
  // Kotlin
  { id: 'kotlin:okhttp',           label: 'Kotlin - OkHttp',           ext: 'kt',    lang: 'kotlin' },
  // Node.js
  { id: 'node:axios',              label: 'Node.js - Axios',           ext: 'js',    lang: 'javascript' },
  { id: 'node:fetch',              label: 'Node.js - Fetch',           ext: 'js',    lang: 'javascript' },
  { id: 'node:native',             label: 'Node.js - HTTP',            ext: 'js',    lang: 'javascript' },
  { id: 'node:request',            label: 'Node.js - Request',         ext: 'js',    lang: 'javascript' },
  { id: 'node:unirest',            label: 'Node.js - Unirest',        ext: 'js',    lang: 'javascript' },
  // Objective-C
  { id: 'objc:nsurlsession',       label: 'Objective-C - NSURLSession', ext: 'm',    lang: 'objectivec' },
  // OCaml
  { id: 'ocaml:cohttp',            label: 'OCaml - CoHTTP',            ext: 'ml',    lang: 'ocaml' },
  // PHP
  { id: 'php:curl',                label: 'PHP - cURL',                ext: 'php',   lang: 'php' },
  { id: 'php:guzzle',              label: 'PHP - Guzzle',              ext: 'php',   lang: 'php' },
  { id: 'php:http1',               label: 'PHP - HTTP v1',             ext: 'php',   lang: 'php' },
  { id: 'php:http2',               label: 'PHP - HTTP v2',             ext: 'php',   lang: 'php' },
  // PowerShell
  { id: 'powershell:restmethod',   label: 'PowerShell - RestMethod',   ext: 'ps1',   lang: 'powershell' },
  { id: 'powershell:webrequest',   label: 'PowerShell - WebRequest',   ext: 'ps1',   lang: 'powershell' },
  // Python
  { id: 'python:python3',          label: 'Python - http.client',      ext: 'py',    lang: 'python' },
  { id: 'python:requests',         label: 'Python - Requests',         ext: 'py',    lang: 'python' },
  // R
  { id: 'r:httr',                  label: 'R - httr',                  ext: 'r',     lang: 'r' },
  // Ruby
  { id: 'ruby:native',             label: 'Ruby - Net::HTTP',          ext: 'rb',    lang: 'ruby' },
  // Shell (cURL is listed above as top-level)
  { id: 'shell:httpie',            label: 'Shell - HTTPie',            ext: 'sh',    lang: 'bash' },
  { id: 'shell:wget',              label: 'Shell - Wget',              ext: 'sh',    lang: 'bash' },
  // Swift
  { id: 'swift:nsurlsession',      label: 'Swift - URLSession',        ext: 'swift', lang: 'swift' },
];

/** Look up an export target by composite ID. */
export function findTarget(id: string): ExportTarget | undefined {
  return EXPORT_TARGETS.find(t => t.id === id);
}

// httpsnippet's internal prepare() uses Node's legacy url.parse(), which
// percent-encodes {{ and }} in URLs (e.g. {{baseUrl}} → %7B%7BbaseUrl%7D%7D).
// We swap template vars to safe placeholders before calling prepare() and
// restore them in the final snippet output.
const VAR_RE = /\{\{(.+?)\}\}/g;

function escapeVars(s: string, map: Map<string, string>): string {
  return s.replace(VAR_RE, (_match, name) => {
    const key = `missiovar_${map.size}_`;
    map.set(key, `{{${name}}}`);
    return key;
  });
}

function restoreVars(s: string, map: Map<string, string>): string {
  for (const [placeholder, original] of map) {
    s = s.split(placeholder).join(original);
  }
  return s;
}

/** Convert a ResolvedRequest to a HAR Request object. @internal exported for testing */
export function toHar(req: ResolvedRequest): HarRequest {
  const headers = Object.entries(req.headers).map(([name, value]) => ({ name, value }));

  let queryString: { name: string; value: string }[] = [];
  try {
    const url = new URL(req.url);
    queryString = [...url.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch { /* placeholder-mangled URL — skip query extraction */ }

  const har: HarRequest = {
    method: req.method,
    url: req.url,
    httpVersion: 'HTTP/1.1',
    headers,
    queryString,
    cookies: [],
    headersSize: -1,
    bodySize: -1,
    postData: { mimeType: '' },
  };

  if (req.body !== undefined) {
    const ct = req.headers['Content-Type'] || req.headers['content-type'] || 'application/octet-stream';
    if (Buffer.isBuffer(req.body)) {
      // HAR text must be a string. Encode binary bodies as base64 using the
      // de-facto 'encoding' field convention (used by Chrome DevTools, etc.)
      // so httpsnippet can generate correct code snippets (e.g. --data-binary).
      har.postData = {
        mimeType: ct,
        text: req.body.toString('base64'),
        encoding: 'base64',
      } as any;
      har.bodySize = req.body.length;
    } else {
      har.postData = { mimeType: ct, text: req.body };
      har.bodySize = Buffer.byteLength(req.body);
    }
  }

  return har;
}

/**
 * Export a resolved HTTP request as a code snippet.
 * @param req      The fully-resolved request
 * @param formatId Composite ID: "targetId:clientId" (e.g. "shell:curl")
 */
export function exportRequest(req: ResolvedRequest, formatId: string): string {
  const [targetId, clientId] = formatId.split(':');

  // Escape template vars in the URL only — url.parse() inside httpsnippet's
  // prepare() would percent-encode {{ and }} otherwise.
  const varMap = new Map<string, string>();
  const har = toHar({ ...req, url: escapeVars(req.url, varMap) });

  // Bypass httpsnippet's built-in HAR validation so template variables
  // don't trigger "Validation Failed" errors.
  const snippet = new HTTPSnippet({ method: 'GET', url: 'http://x' } as unknown as HarRequest);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = snippet as any;
  s.requests = [s.prepare(har)];

  const output = snippet.convert(targetId as Parameters<typeof snippet.convert>[0], clientId);
  if (output === false) {
    throw new Error(`Conversion failed for ${formatId}`);
  }
  const raw = Array.isArray(output) ? output[0] : output;
  return varMap.size > 0 ? restoreVars(raw, varMap) : raw;
}
