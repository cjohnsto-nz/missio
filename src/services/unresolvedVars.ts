import * as vscode from 'vscode';
import type { HttpRequest, MissioCollection, RequestDefaults, Auth } from '../models/types';
import { varPatternGlobal } from '../models/varPattern';
import type { EnvironmentService } from './environmentService';

const BUILTINS = new Set(['$guid', '$timestamp', '$randomInt']);

/** True for variable names that are resolved dynamically and should not be prompted. */
function isAutoResolved(name: string): boolean {
  return BUILTINS.has(name) || name.startsWith('$secret.');
}

/** Extract all {{variable}} names from a string. */
function extractVarNames(s: string | undefined, into: Set<string>): void {
  if (!s) return;
  const re = varPatternGlobal();
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) into.add(m[1].trim());
}

/** Recursively scan all string values in an object/array. */
function scanAllStrings(obj: unknown, into: Set<string>): void {
  if (typeof obj === 'string') { extractVarNames(obj, into); return; }
  if (Array.isArray(obj)) { for (const item of obj) scanAllStrings(item, into); return; }
  if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) scanAllStrings(val, into);
  }
}

/**
 * Detect unresolved {{variable}} references in a raw request.
 * Returns the list of variable names that have no value after resolution,
 * excluding builtins and $secret.* references.
 * Handles nested variables (e.g. api_url = "https://{{host}}/{{version}}")
 * and the inherited auth chain (request → folder → collection).
 * If environmentName is provided, variable resolution uses that environment
 * instead of the currently active one.
 */
export async function detectUnresolvedVars(
  requestData: HttpRequest,
  collection: MissioCollection,
  environmentService: EnvironmentService,
  folderDefaults?: RequestDefaults,
  environmentName?: string,
): Promise<string[]> {
  const varNames = new Set<string>();
  const scan = (s: string | undefined) => extractVarNames(s, varNames);

  const details = requestData.http;
  if (!details) return [];

  // URL & query/path params
  scan(details.url);
  for (const h of details.headers ?? []) { if (!h.disabled) { scan(h.name); scan(h.value); } }
  for (const p of details.params ?? []) { if (!p.disabled) { scan(p.name); scan(p.value); } }

  // Body
  const body = details.body;
  if (body) {
    if (Array.isArray(body)) {
      const selected = (body as any[]).find((v: any) => v.selected) ?? body[0];
      if (selected?.body) scanBody(selected.body, scan);
    } else {
      scanBody(body as any, scan);
    }
  }

  // Auth — walk the effective auth chain (request → folder → collection)
  // forceAuthInherit: prefer collection auth; if incomplete, fall back to
  // request/folder/collection chain to match HttpClient behavior.
  let auth: Auth | undefined;
  const collectionAuth = collection.data.request?.auth;
  if (collection.data.config?.forceAuthInherit) {
    if (collectionAuth && collectionAuth !== 'inherit' && isAuthComplete(collectionAuth)) {
      auth = collectionAuth;
    } else {
      auth = requestData.runtime?.auth;
      if (!auth || auth === 'inherit') auth = folderDefaults?.auth;
      if (!auth || auth === 'inherit') auth = collectionAuth;
    }
  } else {
    auth = requestData.runtime?.auth;
    if (!auth || auth === 'inherit') auth = folderDefaults?.auth;
    if (!auth || auth === 'inherit') auth = collectionAuth;
  }
  if (auth && auth !== 'inherit' && typeof auth === 'object') {
    scanAllStrings(auth, varNames);
  }

  if (varNames.size === 0) return [];

  // Resolve variables, then find which referenced names remain unresolved
  const resolved = await environmentService.resolveVariables(collection, folderDefaults, environmentName);

  const unresolved = new Set<string>();

  // Phase 1: directly referenced variables with no value
  for (const name of varNames) {
    if (!isAutoResolved(name) && !resolved.has(name)) {
      unresolved.add(name);
    }
  }

  // Phase 2: recursively walk resolved values to find nested unresolved refs.
  // e.g. api_url = "https://{{host}}/{{version}}" where version has no value.
  const visited = new Set<string>();
  function walkResolved(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    const val = resolved.get(name);
    if (val === undefined) return;
    const nested = new Set<string>();
    extractVarNames(val, nested);
    for (const ref of nested) {
      if (isAutoResolved(ref)) continue;
      if (!resolved.has(ref)) {
        unresolved.add(ref);
      } else {
        walkResolved(ref); // recurse into the resolved value
      }
    }
  }
  for (const name of varNames) {
    if (!isAutoResolved(name)) walkResolved(name);
  }

  return [...unresolved];
}

/**
 * Fallback prompt for environments without a webview (e.g. command palette).
 * Prompts the user sequentially via VS Code input boxes.
 * Returns a Map of user-provided values, or undefined if the user cancelled.
 */
export async function promptForUnresolvedVars(
  requestData: HttpRequest,
  collection: MissioCollection,
  environmentService: EnvironmentService,
  folderDefaults?: RequestDefaults,
): Promise<Map<string, string> | undefined> {
  const unresolved = await detectUnresolvedVars(requestData, collection, environmentService, folderDefaults);
  if (unresolved.length === 0) return new Map();

  const extras = new Map<string, string>();
  for (let i = 0; i < unresolved.length; i++) {
    const name = unresolved[i];
    const value = await vscode.window.showInputBox({
      title: `Unresolved Variables (${i + 1}/${unresolved.length})`,
      prompt: `Enter value for {{${name}}}`,
      placeHolder: name,
      ignoreFocusOut: true,
    });
    if (value === undefined) return undefined;
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

function isAuthComplete(auth: Exclude<Auth, 'inherit'>): boolean {
  switch (auth.type) {
    case 'basic':
      return !!(auth.username || auth.password);
    case 'bearer':
      return !!auth.token;
    case 'apikey':
      return !!auth.key;
    case 'oauth2':
      return true;
    default:
      return true;
  }
}
