import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { stringifyYaml } from '../services/yamlParser';
import type { CollectionImporter, ImportResult } from './types';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];

export class OpenApiImporter implements CollectionImporter {
  readonly label = 'OpenAPI';
  readonly description = 'Import an OpenAPI 3.x specification (JSON or YAML)';
  readonly fileExtensions = ['json', 'yml', 'yaml'];
  readonly supportsUrl = true;

  async import(sourceFile: string, targetDir: string): Promise<ImportResult> {
    const raw = fs.readFileSync(sourceFile, 'utf-8');
    let spec: any;
    try {
      spec = parseYaml(raw);
    } catch {
      // Fallback to JSON.parse for edge cases
      spec = JSON.parse(raw);
    }

    if (!this.isSupported(spec)) {
      throw new Error('Unsupported format. Only OpenAPI 3.x specifications are supported.');
    }

    const title = spec.info?.title || 'Imported API';
    const collDir = path.join(targetDir, this.sanitizePath(title));
    fs.mkdirSync(collDir, { recursive: true });

    // Build OpenCollection structure
    const collection: any = {
      opencollection: '1.0.0',
      info: {
        name: title,
        version: spec.info?.version || '1.0.0',
      },
    };

    if (spec.info?.description) {
      collection.info.summary = spec.info.description;
    }

    // Servers → baseUrl variable + server variables
    const { baseUrl, variables: serverVars } = this.buildBaseUrl(spec.servers);
    const collVars = [
      ...(baseUrl ? [{ name: 'baseUrl', value: baseUrl }] : []),
      ...serverVars,
    ];
    if (collVars.length) {
      collection.request = collection.request || {};
      collection.request.variables = collVars;
    }

    // Global security → collection-level auth
    const defaultAuth = this.getDefaultAuth(spec);
    if (defaultAuth) {
      collection.request = collection.request || {};
      collection.request.auth = defaultAuth;
    }

    collection.config = { environments: [] };

    // Process paths into folders and requests
    const counts = this.processPaths(spec, collDir);

    // Write opencollection.yml
    const collFile = path.join(collDir, 'opencollection.yml');
    fs.writeFileSync(collFile, stringifyYaml(collection, { lineWidth: 120 }), 'utf-8');

    return {
      collectionDir: collDir,
      collectionFile: collFile,
      requestCount: counts.requests,
      folderCount: counts.folders,
      environmentCount: 0,
    };
  }

  // ── Validation ──────────────────────────────────────────────────────

  private isSupported(spec: any): boolean {
    if (!spec || typeof spec !== 'object') return false;
    const version = spec.openapi;
    return typeof version === 'string' && version.startsWith('3.');
  }

  // ── $ref resolution ─────────────────────────────────────────────────

  private resolve(obj: any, spec: any): any {
    if (!obj || typeof obj !== 'object') return obj;
    if (typeof obj.$ref === 'string') {
      return this.resolveRef(obj.$ref, spec);
    }
    return obj;
  }

  private resolveRef(ref: string, root: any): any {
    if (!ref.startsWith('#/')) return {};
    const parts = ref.substring(2).split('/');
    let current = root;
    for (const part of parts) {
      const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
      current = current?.[decoded];
      if (current === undefined) return {};
    }
    return current;
  }

  // ── Path processing ─────────────────────────────────────────────────

  private processPaths(spec: any, collDir: string): { requests: number; folders: number } {
    // Collect operations grouped by tag
    const tagGroups = new Map<string, { method: string; path: string; op: any; pathItem: any }[]>();
    const untagged: { method: string; path: string; op: any; pathItem: any }[] = [];

    for (const [pathStr, rawPathItem] of Object.entries(spec.paths || {})) {
      const pathItem = this.resolve(rawPathItem, spec);
      if (!pathItem || typeof pathItem !== 'object') continue;

      for (const method of HTTP_METHODS) {
        const op = pathItem[method];
        if (!op) continue;

        const tags = op.tags && op.tags.length > 0 ? op.tags : null;
        const entry = { method, path: pathStr, op, pathItem };

        if (tags) {
          // Add to first tag's group (primary tag)
          const tag = tags[0];
          if (!tagGroups.has(tag)) tagGroups.set(tag, []);
          tagGroups.get(tag)!.push(entry);
        } else {
          untagged.push(entry);
        }
      }
    }

    let requests = 0;
    let folders = 0;
    let seq = 0;

    // Write untagged requests to collection root
    const rootCounters = new Map<string, number>();
    for (const entry of untagged) {
      seq++;
      const req = this.convertOperation(entry, spec, seq);
      const name = this.uniqueName(this.sanitizePath(req.info.name), rootCounters);
      const reqFile = path.join(collDir, name + '.yml');
      fs.writeFileSync(reqFile, stringifyYaml(req, { lineWidth: 120 }), 'utf-8');
      requests++;
    }

    // Write tagged operations into folders
    const folderCounters = new Map<string, number>();
    for (const [tag, ops] of tagGroups) {
      folders++;
      const folderName = this.uniqueName(this.sanitizePath(tag), folderCounters);
      const folderDir = path.join(collDir, folderName);
      fs.mkdirSync(folderDir, { recursive: true });

      // Write folder.yml if tag has metadata
      const tagInfo = (spec.tags || []).find((t: any) => t.name === tag);
      const folderMeta: any = { info: { name: tag, type: 'folder' } };
      let hasFolderContent = false;
      if (tagInfo?.description) {
        folderMeta.info.description = tagInfo.description;
        hasFolderContent = true;
      }
      if (hasFolderContent) {
        fs.writeFileSync(
          path.join(folderDir, 'folder.yml'),
          stringifyYaml(folderMeta, { lineWidth: 120 }),
          'utf-8',
        );
      }

      const opCounters = new Map<string, number>();
      for (const entry of ops) {
        seq++;
        const req = this.convertOperation(entry, spec, seq);
        const name = this.uniqueName(this.sanitizePath(req.info.name), opCounters);
        const reqFile = path.join(folderDir, name + '.yml');
        fs.writeFileSync(reqFile, stringifyYaml(req, { lineWidth: 120 }), 'utf-8');
        requests++;
      }
    }

    return { requests, folders };
  }

  // ── Operation → Request conversion ──────────────────────────────────

  private convertOperation(
    entry: { method: string; path: string; op: any; pathItem: any },
    spec: any,
    seq: number,
  ): any {
    const { method, path: pathStr, op, pathItem } = entry;
    const name = op.summary || op.operationId || `${method.toUpperCase()} ${pathStr}`;

    // Build URL: {{baseUrl}}/path with {param} → {{param}}
    const url = `{{baseUrl}}${this.convertPathParams(pathStr)}`;

    // Merge path-level + operation-level parameters (operation overrides path)
    const pathParams = (pathItem.parameters || []).map((p: any) => this.resolve(p, spec));
    const opParams = (op.parameters || []).map((p: any) => this.resolve(p, spec));
    const paramMap = new Map<string, any>();
    for (const p of [...pathParams, ...opParams]) {
      if (p.name && p.in) paramMap.set(`${p.in}:${p.name}`, p);
    }
    const allParams = Array.from(paramMap.values());

    const { headers, queryParams, pathParamEntries } = this.convertParameters(allParams);

    const request: any = {
      info: { name, type: 'http', seq },
      http: {
        method: method.toUpperCase(),
        url,
        headers,
        params: [...queryParams, ...pathParamEntries],
      },
      settings: {
        encodeUrl: true,
        timeout: 0,
        followRedirects: true,
        maxRedirects: 5,
      },
    };

    if (op.description) {
      request.info.description = op.description;
    }

    // Auth → runtime.auth per OpenCollection schema
    const opAuth = this.getOperationAuth(op, spec);
    if (opAuth) {
      request.runtime = { auth: opAuth };
    } else {
      request.runtime = { auth: 'inherit' };
    }

    // Request body
    if (op.requestBody) {
      const resolved = this.resolve(op.requestBody, spec);
      const body = this.convertRequestBody(resolved, spec);
      if (body) {
        request.http.body = body;
      }
    }

    // Responses → examples
    const examples = this.convertResponses(op.responses, spec);
    if (examples.length > 0) {
      request.examples = examples;
    }

    return request;
  }

  // ── Parameters ──────────────────────────────────────────────────────

  private convertParameters(params: any[]): {
    headers: any[];
    queryParams: any[];
    pathParamEntries: any[];
  } {
    const headers: any[] = [];
    const queryParams: any[] = [];
    const pathParamEntries: any[] = [];

    for (const p of params) {
      const value = String(p.example ?? p.schema?.default ?? p.schema?.example ?? '');

      switch (p.in) {
        case 'query':
          queryParams.push({
            name: p.name || '',
            value,
            type: 'query' as const,
            ...(p.description ? { description: p.description } : {}),
          });
          break;
        case 'path':
          pathParamEntries.push({
            name: p.name || '',
            value,
            type: 'path' as const,
            ...(p.description ? { description: p.description } : {}),
          });
          break;
        case 'header':
          headers.push({
            name: p.name || '',
            value,
            ...(p.description ? { description: p.description } : {}),
          });
          break;
        // 'cookie' not directly supported — skip
      }
    }

    return { headers, queryParams, pathParamEntries };
  }

  // ── Request Body ────────────────────────────────────────────────────

  private convertRequestBody(reqBody: any, spec: any): any | null {
    if (!reqBody?.content) return null;
    const content = reqBody.content;

    // Prefer JSON
    if (content['application/json']) {
      const media = content['application/json'];
      const example = this.extractExample(media, spec);
      return {
        type: 'json',
        data: example !== undefined ? JSON.stringify(example, null, 2) : '{}',
      };
    }

    // XML
    const xmlKey = content['application/xml'] ? 'application/xml' : content['text/xml'] ? 'text/xml' : null;
    if (xmlKey) {
      const example = this.extractExample(content[xmlKey], spec);
      return { type: 'xml', data: typeof example === 'string' ? example : '' };
    }

    // Form URL-encoded
    if (content['application/x-www-form-urlencoded']) {
      const media = content['application/x-www-form-urlencoded'];
      const schema = this.resolve(media.schema, spec);
      if (schema?.properties) {
        return {
          type: 'form-urlencoded',
          data: Object.entries(schema.properties).map(([key, prop]: [string, any]) => {
            const resolved = this.resolve(prop, spec);
            return { name: key, value: String(resolved.example ?? resolved.default ?? '') };
          }),
        };
      }
      return { type: 'form-urlencoded', data: [] };
    }

    // Multipart
    if (content['multipart/form-data']) {
      const media = content['multipart/form-data'];
      const schema = this.resolve(media.schema, spec);
      if (schema?.properties) {
        return {
          type: 'multipart-form',
          data: Object.entries(schema.properties).map(([key, prop]: [string, any]) => {
            const resolved = this.resolve(prop, spec);
            return { name: key, value: String(resolved.example ?? resolved.default ?? '') };
          }),
        };
      }
      return { type: 'multipart-form', data: [] };
    }

    // Fallback: first content type as text
    const firstKey = Object.keys(content)[0];
    if (firstKey) {
      const example = this.extractExample(content[firstKey], spec);
      return { type: 'text', data: typeof example === 'string' ? example : '' };
    }

    return null;
  }

  // ── Responses → Examples ────────────────────────────────────────────

  private convertResponses(responses: any, spec: any): any[] {
    if (!responses) return [];
    const examples: any[] = [];

    for (const [status, rawResp] of Object.entries(responses)) {
      const resp = this.resolve(rawResp, spec);
      if (!resp || typeof resp !== 'object') continue;

      const statusCode = status === 'default' ? 200 : parseInt(status, 10);
      const example: any = {
        name: `${status} ${resp.description || ''}`.trim(),
        response: {
          status: isNaN(statusCode) ? 0 : statusCode,
          statusText: resp.description || '',
          headers: [] as any[],
        },
      };

      // Response headers
      if (resp.headers) {
        for (const [hName, rawH] of Object.entries(resp.headers)) {
          const h = this.resolve(rawH, spec) as any;
          example.response.headers.push({
            name: hName,
            value: String(h?.example ?? h?.schema?.example ?? ''),
          });
        }
      }

      // Response body
      if (resp.content) {
        const ctKey = Object.keys(resp.content)[0];
        if (ctKey) {
          const media = resp.content[ctKey];
          const bodyExample = this.extractExample(media, spec);
          let bodyType = 'text';
          if (ctKey.includes('json')) bodyType = 'json';
          else if (ctKey.includes('xml')) bodyType = 'xml';
          else if (ctKey.includes('html')) bodyType = 'html';

          if (bodyExample !== undefined) {
            example.response.body = {
              type: bodyType,
              data: typeof bodyExample === 'string' ? bodyExample : JSON.stringify(bodyExample, null, 2),
            };
          }
        }
      }

      examples.push(example);
    }

    return examples;
  }

  // ── Example extraction / generation ─────────────────────────────────

  private extractExample(media: any, spec: any): any {
    if (!media) return undefined;

    // Direct example on media type
    if (media.example !== undefined) return media.example;

    // Named examples — pick first
    if (media.examples) {
      const first = Object.values(media.examples)[0] as any;
      if (first) {
        const resolved = this.resolve(first, spec);
        if (resolved?.value !== undefined) return resolved.value;
      }
    }

    // Generate from schema
    if (media.schema) {
      const schema = this.resolve(media.schema, spec);
      return this.generateExample(schema, spec);
    }

    return undefined;
  }

  private generateExample(schema: any, spec: any, depth = 0): any {
    if (depth > 5 || !schema) return null;
    schema = this.resolve(schema, spec);
    if (!schema || typeof schema !== 'object') return null;

    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;

    // Composition keywords
    if (schema.allOf) {
      const merged: any = {};
      for (const sub of schema.allOf) {
        const resolved = this.resolve(sub, spec);
        const ex = this.generateExample(resolved, spec, depth + 1);
        if (ex && typeof ex === 'object' && !Array.isArray(ex)) Object.assign(merged, ex);
      }
      return Object.keys(merged).length ? merged : null;
    }
    if (schema.oneOf || schema.anyOf) {
      const first = (schema.oneOf || schema.anyOf)[0];
      if (first) return this.generateExample(this.resolve(first, spec), spec, depth + 1);
      return null;
    }

    // Infer type from properties if not specified
    const type = schema.type || (schema.properties ? 'object' : undefined);

    switch (type) {
      case 'string':
        if (schema.enum) return schema.enum[0];
        if (schema.format === 'date') return '2024-01-01';
        if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
        if (schema.format === 'email') return 'user@example.com';
        if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
        if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
        return 'string';
      case 'number':
      case 'integer':
        if (schema.enum) return schema.enum[0];
        return schema.minimum ?? 0;
      case 'boolean':
        return false;
      case 'array': {
        if (schema.items) {
          const item = this.generateExample(this.resolve(schema.items, spec), spec, depth + 1);
          return item !== null ? [item] : [];
        }
        return [];
      }
      case 'object': {
        const obj: any = {};
        for (const [key, prop] of Object.entries(schema.properties || {})) {
          const val = this.generateExample(this.resolve(prop, spec), spec, depth + 1);
          if (val !== null) obj[key] = val;
        }
        return Object.keys(obj).length ? obj : {};
      }
      default:
        return null;
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────

  private getDefaultAuth(spec: any): any | null {
    if (!spec.security?.length) return null;
    return this.resolveSecurityRequirement(spec.security[0], spec);
  }

  private getOperationAuth(op: any, spec: any): any | null {
    if (!op.security) return null;
    if (op.security.length === 0) return null; // explicit empty = no auth
    return this.resolveSecurityRequirement(op.security[0], spec);
  }

  private resolveSecurityRequirement(req: any, spec: any): any | null {
    const schemeName = Object.keys(req || {})[0];
    if (!schemeName) return null;
    const scheme = spec.components?.securitySchemes?.[schemeName];
    if (!scheme) return null;
    return this.convertSecurityScheme(this.resolve(scheme, spec));
  }

  private convertSecurityScheme(scheme: any): any | null {
    if (!scheme) return null;

    switch (scheme.type) {
      case 'http':
        if (scheme.scheme === 'bearer') return { type: 'bearer', token: '' };
        if (scheme.scheme === 'basic') return { type: 'basic', username: '', password: '' };
        return null;

      case 'apiKey':
        return {
          type: 'apikey',
          key: scheme.name || '',
          value: '',
          placement: scheme.in === 'query' ? 'query' : 'header',
        };

      case 'oauth2': {
        const auth: any = { type: 'oauth2' };
        const flows = scheme.flows || {};

        if (flows.clientCredentials) {
          auth.flow = 'client_credentials';
          auth.accessTokenUrl = flows.clientCredentials.tokenUrl || '';
          auth.scope = Object.keys(flows.clientCredentials.scopes || {}).join(' ');
        } else if (flows.authorizationCode) {
          auth.flow = 'authorization_code';
          auth.authorizationUrl = flows.authorizationCode.authorizationUrl || '';
          auth.accessTokenUrl = flows.authorizationCode.tokenUrl || '';
          auth.scope = Object.keys(flows.authorizationCode.scopes || {}).join(' ');
        } else if (flows.password) {
          auth.flow = 'resource_owner_password_credentials';
          auth.accessTokenUrl = flows.password.tokenUrl || '';
          auth.scope = Object.keys(flows.password.scopes || {}).join(' ');
        }

        return auth;
      }

      default:
        return null;
    }
  }

  // ── Server / Base URL ───────────────────────────────────────────────

  private buildBaseUrl(servers: any[]): { baseUrl: string; variables: any[] } {
    if (!servers?.length) {
      return { baseUrl: 'https://api.example.com', variables: [] };
    }

    const server = servers[0];
    let url = server.url || '';
    const vars: any[] = [];

    // Convert server variables {var} → {{var}}
    if (server.variables) {
      for (const [name, varDef] of Object.entries(server.variables)) {
        const v = varDef as any;
        url = url.replace(new RegExp(`\\{${name}\\}`, 'g'), `{{${name}}}`);
        vars.push({
          name,
          value: v.default || v.enum?.[0] || '',
          ...(v.description ? { description: v.description } : {}),
        });
      }
    }

    // Remove trailing slash
    url = url.replace(/\/+$/, '');

    return { baseUrl: url, variables: vars };
  }

  // ── Utility ─────────────────────────────────────────────────────────

  /** Convert OpenAPI path params {param} to {{param}} */
  private convertPathParams(pathStr: string): string {
    return pathStr.replace(/\{([^}]+)\}/g, '{{$1}}');
  }

  /** Preserve case and spaces, strip filesystem-unsafe characters */
  private sanitizePath(name: string): string {
    const sanitized = name.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').trim() || 'Untitled';
    if (sanitized === '.' || sanitized === '..' || sanitized.replace(/\./g, '') === '') {
      return 'Untitled';
    }
    return sanitized;
  }

  private uniqueName(name: string, counters: Map<string, number>): string {
    const key = name.toLowerCase();
    const count = counters.get(key) || 0;
    counters.set(key, count + 1);
    return count === 0 ? name : `${name} ${count + 1}`;
  }
}
