import * as vscode from 'vscode';
import type { HttpRequest, MissioCollection, RequestDefaults } from '../models/types';
import { varPatternGlobal } from '../models/varPattern';
import type { EnvironmentService } from './environmentService';

const BUILTINS = new Set(['$guid', '$timestamp', '$randomInt']);

/**
 * Scan a raw request for {{variable}} references, resolve the known ones,
 * and prompt the user to fill in any that remain unresolved.
 * Returns a Map of user-provided values, or undefined if the user cancelled.
 */
export async function promptForUnresolvedVars(
  requestData: HttpRequest,
  collection: MissioCollection,
  environmentService: EnvironmentService,
  folderDefaults?: RequestDefaults,
): Promise<Map<string, string> | undefined> {
  // Collect all {{var}} names referenced in the raw request
  const varNames = new Set<string>();
  const scan = (s: string | undefined) => {
    if (!s) return;
    const re = varPatternGlobal();
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) varNames.add(m[1].trim());
  };

  const details = requestData.http;
  if (!details) return new Map();

  scan(details.url);
  for (const h of details.headers ?? []) { if (!h.disabled) { scan(h.name); scan(h.value); } }
  for (const p of details.params ?? []) { if (!p.disabled) { scan(p.name); scan(p.value); } }

  // Scan body
  const body = details.body;
  if (body) {
    if (Array.isArray(body)) {
      const selected = (body as any[]).find((v: any) => v.selected) ?? body[0];
      if (selected?.body) scanBody(selected.body, scan);
    } else {
      scanBody(body as any, scan);
    }
  }

  // Scan auth fields
  const auth = details.auth;
  if (auth && auth !== 'inherit' && typeof auth === 'object') {
    for (const val of Object.values(auth)) {
      if (typeof val === 'string') scan(val);
    }
  }

  if (varNames.size === 0) return new Map();

  // Resolve variables to find which are unresolved
  const resolved = await environmentService.resolveVariables(collection, folderDefaults);
  const unresolved = [...varNames].filter(
    name => !BUILTINS.has(name) && !resolved.has(name) && !name.startsWith('$secret.'),
  );

  if (unresolved.length === 0) return new Map();

  // Prompt the user for each unresolved variable
  const extras = new Map<string, string>();
  for (let i = 0; i < unresolved.length; i++) {
    const name = unresolved[i];
    const value = await vscode.window.showInputBox({
      title: `Unresolved Variables (${i + 1}/${unresolved.length})`,
      prompt: `Enter value for {{${name}}}`,
      placeHolder: name,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      // User pressed Escape — cancel the request
      return undefined;
    }
    extras.set(name, value);
  }
  return extras;
}

function scanBody(body: any, scan: (s: string | undefined) => void): void {
  if (!body) return;
  switch (body.type) {
    case 'json': case 'text': case 'xml': case 'sparql':
      scan(body.data);
      break;
    case 'form-urlencoded': case 'multipart-form':
      if (Array.isArray(body.data)) {
        for (const entry of body.data) {
          if (!entry.disabled) {
            scan(entry.name);
            if (typeof entry.value === 'string') scan(entry.value);
            else if (Array.isArray(entry.value)) entry.value.forEach((v: string) => scan(v));
          }
        }
      }
      break;
  }
}
