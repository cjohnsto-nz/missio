import type { ResolvedRequest } from './httpClient';

/** Escape a string for use inside single quotes in a shell command. */
function shellEscape(s: string): string {
  // Replace each ' with '\'' (end quote, escaped literal quote, reopen quote)
  return s.replace(/'/g, "'\\''");
}

/** Convert a fully-resolved request to a cURL command string. */
export function toCurl(req: ResolvedRequest): string {
  const parts: string[] = ['curl'];

  // Method — always explicit for clarity
  parts.push(`-X ${req.method}`);

  // URL
  parts.push(`'${shellEscape(req.url)}'`);

  // Headers (skip Content-Length — curl computes it automatically)
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.toLowerCase() === 'content-length') continue;
    parts.push(`-H '${shellEscape(name)}: ${shellEscape(value)}'`);
  }

  // Body
  if (req.body) {
    parts.push(`--data-raw '${shellEscape(req.body)}'`);
  }

  // Single-line if short enough, otherwise multi-line with backslash continuations
  const oneLine = parts.join(' ');
  if (oneLine.length <= 120) {
    return oneLine;
  }
  return parts.join(' \\\n  ');
}

/** Convert a fully-resolved request to a raw HTTP/1.1 message. */
export function toHttpRaw(req: ResolvedRequest): string {
  const url = new URL(req.url);
  const path = url.pathname + url.search;
  const lines: string[] = [];

  lines.push(`${req.method} ${path} HTTP/1.1`);
  lines.push(`Host: ${url.host}`);

  for (const [name, value] of Object.entries(req.headers)) {
    if (name.toLowerCase() === 'host') continue; // already added
    lines.push(`${name}: ${value}`);
  }

  if (req.body) {
    lines.push(`Content-Length: ${Buffer.byteLength(req.body, 'utf-8')}`);
    lines.push('');
    lines.push(req.body);
  } else {
    lines.push('');
  }

  return lines.join('\r\n');
}
