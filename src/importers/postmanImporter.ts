import * as fs from 'fs';
import * as path from 'path';
import { stringifyYaml } from '../services/yamlParser';
import type { CollectionImporter, ImportResult } from './types';

export class PostmanImporter implements CollectionImporter {
  readonly label = 'Postman';
  readonly description = 'Import a Postman Collection v2.0 or v2.1 JSON file';
  readonly fileExtensions = ['json'];

  private static readonly SUPPORTED_SCHEMAS = [
    'https://schema.getpostman.com/json/collection/v2.0.0/collection.json',
    'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    'https://schema.postman.com/json/collection/v2.0.0/collection.json',
    'https://schema.postman.com/json/collection/v2.1.0/collection.json',
  ];

  async import(sourceFile: string, targetDir: string): Promise<ImportResult> {
    const raw = fs.readFileSync(sourceFile, 'utf-8');
    const postman = JSON.parse(raw);

    if (!this.isSupported(postman)) {
      throw new Error('Unsupported Postman format. Only Collection v2.0 and v2.1 are supported.');
    }

    const collName = postman.info?.name || 'Imported Collection';
    const collDir = path.join(targetDir, this.sanitizePath(collName));
    fs.mkdirSync(collDir, { recursive: true });

    let requestCount = 0;
    let folderCount = 0;

    // Build OpenCollection structure
    const collection: any = {
      opencollection: '1.0.0',
      info: {
        name: collName,
        version: '1.0.0',
      },
    };

    if (postman.info?.description) {
      collection.info.summary = this.extractDescription(postman.info.description);
    }

    // Collection-level variables → request.variables
    if (postman.variable && postman.variable.length > 0) {
      collection.request = collection.request || {};
      collection.request.variables = postman.variable
        .filter((v: any) => v.key != null)
        .map((v: any) => ({
          name: v.key,
          value: v.value ?? '',
        }));
    }

    // Collection-level auth → request.auth
    if (postman.auth) {
      const auth = this.convertAuth(postman.auth);
      if (auth) {
        collection.request = collection.request || {};
        collection.request.auth = auth;
      }
    }

    // Collection-level headers from events/pre-request scripts are not directly mappable,
    // but we preserve collection-level scripts if present
    // (scripts conversion is out of scope for initial import)

    // Environments — Postman doesn't embed environments in the collection export,
    // but we create a placeholder config
    collection.config = { environments: [] };

    // Process items recursively, writing request files to disk
    const counts = await this.processItems(postman.item || [], collDir, collDir);
    requestCount = counts.requests;
    folderCount = counts.folders;

    // Write opencollection.yml
    const collFile = path.join(collDir, 'opencollection.yml');
    const yaml = stringifyYaml(collection, { lineWidth: 120 });
    fs.writeFileSync(collFile, yaml, 'utf-8');

    return {
      collectionDir: collDir,
      collectionFile: collFile,
      requestCount,
      folderCount,
      environmentCount: 0,
    };
  }

  /**
   * Parse a Postman environment JSON file without writing anything.
   * Returns the environment name and parsed variables (with secret flag).
   */
  parseEnvironment(envFile: string): { name: string; variables: { name: string; value: string; isSecret: boolean }[] } {
    const raw = fs.readFileSync(envFile, 'utf-8');
    const postmanEnv = JSON.parse(raw);

    if (!postmanEnv.name || !postmanEnv.values) {
      throw new Error('Invalid Postman environment file. Expected "name" and "values" fields.');
    }

    const variables = postmanEnv.values
      .filter((v: any) => v.key)
      .map((v: any) => ({
        name: v.key as string,
        value: (v.value ?? '') as string,
        isSecret: v.type === 'secret',
      }));

    return { name: postmanEnv.name, variables };
  }

  /**
   * Write parsed environment variables into a collection file.
   * secretMode controls how Postman secrets are stored:
   *   - 'plain': store as normal variables (value in YAML)
   *   - 'secret': store as SecretVariable (secret: true, no value in YAML)
   * Returns secrets that need to be stored in SecretStorage.
   */
  importEnvironment(
    collectionFile: string,
    envName: string,
    variables: { name: string; value: string; isSecret: boolean }[],
    secretMode: 'plain' | 'secret',
  ): { name: string; variableCount: number; secrets: { name: string; value: string }[] } {
    const secrets: { name: string; value: string }[] = [];
    const yamlVars = variables.map(v => {
      if (v.isSecret && secretMode === 'secret') {
        secrets.push({ name: v.name, value: v.value });
        return { name: v.name, secret: true };
      }
      return { name: v.name, value: v.value };
    });

    // Read existing collection, add/replace environment
    const collYaml = fs.readFileSync(collectionFile, 'utf-8');
    const yamlLib = require('yaml');
    const coll = yamlLib.parse(collYaml);

    if (!coll.config) coll.config = {};
    if (!coll.config.environments) coll.config.environments = [];

    const idx = coll.config.environments.findIndex((e: any) => e.name === envName);
    const env: any = { name: envName, variables: yamlVars };
    if (idx >= 0) {
      coll.config.environments[idx] = env;
    } else {
      coll.config.environments.push(env);
    }

    const updatedYaml = stringifyYaml(coll, { lineWidth: 120 });
    fs.writeFileSync(collectionFile, updatedYaml, 'utf-8');

    return { name: envName, variableCount: variables.length, secrets };
  }

  // ── Private helpers ────────────────────────────────────────────

  private isSupported(data: any): boolean {
    const schema = data?.info?.schema;
    return typeof schema === 'string' && PostmanImporter.SUPPORTED_SCHEMAS.includes(schema);
  }

  private async processItems(
    items: any[],
    parentDir: string,
    collDir: string,
  ): Promise<{ requests: number; folders: number }> {
    let requests = 0;
    let folders = 0;
    const nameCounters = new Map<string, number>();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const displayName = item.name || (this.isFolder(item) ? 'Untitled Folder' : 'Untitled Request');

      if (this.isFolder(item)) {
        folders++;
        const folderSafe = this.uniqueName(this.sanitizePath(displayName), nameCounters);
        const folderDir = path.join(parentDir, folderSafe);
        fs.mkdirSync(folderDir, { recursive: true });

        // Write folder.yml if there's folder-level config (auth, headers, variables)
        const folderMeta = this.buildFolderMeta(item, displayName);
        if (folderMeta) {
          const folderFile = path.join(folderDir, 'folder.yml');
          const yaml = stringifyYaml(folderMeta, { lineWidth: 120 });
          fs.writeFileSync(folderFile, yaml, 'utf-8');
        }

        const sub = await this.processItems(item.item || [], folderDir, collDir);
        requests += sub.requests;
        folders += sub.folders;
      } else if (item.request) {
        requests++;
        const reqSafe = this.uniqueName(this.sanitizePath(displayName), nameCounters);
        const reqFile = path.join(parentDir, reqSafe + '.yml');

        const request = this.convertRequest(item, displayName, i + 1);
        const yaml = stringifyYaml(request, { lineWidth: 120 });
        fs.writeFileSync(reqFile, yaml, 'utf-8');
      }
    }

    return { requests, folders };
  }

  private isFolder(item: any): boolean {
    return !item.request && Array.isArray(item.item);
  }

  private buildFolderMeta(item: any, name: string): any | null {
    const meta: any = {
      info: { name, type: 'folder' },
    };

    let hasContent = false;

    // Folder-level auth
    if (item.auth) {
      const auth = this.convertAuth(item.auth);
      if (auth) {
        meta.request = meta.request || {};
        meta.request.auth = auth;
        hasContent = true;
      }
    }

    // Folder-level description
    if (item.description) {
      meta.info.description = this.extractDescription(item.description);
      hasContent = true;
    }

    return hasContent ? meta : null;
  }

  private convertRequest(item: any, name: string, seq: number): any {
    const pm = item.request;
    const method = (pm.method || 'GET').toUpperCase();
    const url = this.constructUrl(pm.url);

    const request: any = {
      info: { name, type: 'http', seq },
      http: {
        method,
        url,
        headers: this.convertHeaders(pm.header),
        params: this.convertParams(pm.url),
      },
      settings: {
        encodeUrl: item.protocolProfileBehavior?.disableUrlEncoding !== true,
        timeout: 0,
        followRedirects: item.protocolProfileBehavior?.followRedirects ?? true,
        maxRedirects: item.protocolProfileBehavior?.maxRedirects ?? 5,
      },
    };

    // Description
    if (pm.description) {
      request.info.description = this.extractDescription(pm.description);
    }

    // Auth → runtime.auth per OpenCollection schema
    if (pm.auth) {
      const auth = this.convertAuth(pm.auth);
      if (auth) {
        request.runtime = { auth };
      }
    } else {
      request.runtime = { auth: 'inherit' };
    }

    // Body
    const body = this.convertBody(pm.body);
    if (body) {
      request.http.body = body;
    }

    // Examples (Postman "responses")
    if (item.response && Array.isArray(item.response) && item.response.length > 0) {
      request.examples = item.response.map((resp: any, idx: number) => this.convertExample(resp, idx));
    }

    return request;
  }

  private convertHeaders(headers: any[] | undefined): any[] {
    if (!headers || !Array.isArray(headers)) return [];
    return headers.map(h => ({
      name: h.key || '',
      value: h.value || '',
      ...(h.disabled ? { disabled: true } : {}),
    }));
  }

  private convertParams(url: any): any[] {
    if (!url || typeof url !== 'object') return [];
    const params: any[] = [];

    // Query params
    if (url.query && Array.isArray(url.query)) {
      for (const q of url.query) {
        if (!q.key) continue;
        params.push({
          name: q.key,
          value: q.value ?? '',
          type: 'query',
          ...(q.disabled ? { disabled: true } : {}),
        });
      }
    }

    // Path variables
    if (url.variable && Array.isArray(url.variable)) {
      for (const v of url.variable) {
        if (!v.key) continue;
        params.push({
          name: v.key,
          value: v.value ?? '',
          type: 'path',
        });
      }
    }

    return params;
  }

  private convertBody(body: any): any | null {
    if (!body || !body.mode) return null;

    switch (body.mode) {
      case 'raw': {
        const lang = this.detectBodyLanguage(body);
        return { type: lang, data: body.raw || '' };
      }
      case 'urlencoded':
        return {
          type: 'form-urlencoded',
          data: (body.urlencoded || []).map((p: any) => ({
            name: p.key || '',
            value: p.value || '',
            ...(p.disabled ? { disabled: true } : {}),
          })),
        };
      case 'formdata':
        return {
          type: 'multipart-form',
          data: (body.formdata || []).map((p: any) => ({
            name: p.key || '',
            value: p.type === 'file' ? (p.src || '') : (p.value || ''),
            ...(p.disabled ? { disabled: true } : {}),
          })),
        };
      case 'graphql': {
        const gql = body.graphql || {};
        return { type: 'graphql', data: JSON.stringify({ query: gql.query || '', variables: gql.variables || '' }, null, 2) };
      }
      default:
        return null;
    }
  }

  private detectBodyLanguage(body: any): string {
    const lang = body?.options?.raw?.language;
    if (lang === 'json') return 'json';
    if (lang === 'xml') return 'xml';
    if (lang === 'html') return 'html';
    if (lang === 'text') return 'text';
    // Fallback: try to detect from content
    const raw = body?.raw || '';
    try { JSON.parse(raw); return 'json'; } catch { /* not json */ }
    if (raw.trimStart().startsWith('<')) return 'xml';
    return 'text';
  }

  private convertAuth(auth: any): any | null {
    if (!auth || !auth.type || auth.type === 'noauth') return null;

    const values = this.flattenAuthValues(auth[auth.type]);

    switch (auth.type) {
      case 'bearer':
        return { type: 'bearer', token: values.token || '' };
      case 'basic':
        return { type: 'basic', username: values.username || '', password: values.password || '' };
      case 'apikey':
        return {
          type: 'apikey',
          key: values.key || '',
          value: values.value || '',
          placement: values.in === 'query' ? 'query' : 'header',
        };
      default:
        // Store unsupported auth types as-is so round-trip doesn't lose data
        return { type: auth.type, ...values };
    }
  }

  private flattenAuthValues(values: any): Record<string, string> {
    if (!values) return {};
    if (Array.isArray(values)) {
      return values.reduce((acc: any, v: any) => {
        if (v.key) acc[v.key] = v.value ?? '';
        return acc;
      }, {});
    }
    if (typeof values === 'object') return values;
    return {};
  }

  private convertExample(resp: any, idx: number): any {
    const name = (resp.name || `Example ${idx + 1}`).replace(/\r?\n/g, ' ').trim();
    const example: any = { name };

    // Response
    example.response = {
      status: resp.code ?? 0,
      statusText: resp.status || '',
      headers: (resp.header || []).map((h: any) => ({
        name: h.key || '',
        value: h.value || '',
      })),
    };

    if (resp.body) {
      const ct = (resp.header || []).find((h: any) => h.key?.toLowerCase() === 'content-type');
      let bodyType = 'text';
      if (ct?.value?.includes('json')) bodyType = 'json';
      else if (ct?.value?.includes('xml')) bodyType = 'xml';
      else if (ct?.value?.includes('html')) bodyType = 'html';
      example.response.body = { type: bodyType, data: resp.body };
    }

    return example;
  }

  private constructUrl(url: any): string {
    if (!url) return '';
    if (typeof url === 'string') return this.convertPostmanVars(url);
    if (url.raw) return this.convertPostmanVars(url.raw.split('#')[0]);

    // Build from parts
    const protocol = url.protocol || 'http';
    const host = Array.isArray(url.host) ? url.host.join('.') : (url.host || '');
    const pathStr = Array.isArray(url.path) ? url.path.join('/') : (url.path || '');
    const port = url.port ? `:${url.port}` : '';
    return this.convertPostmanVars(`${protocol}://${host}${port}${pathStr ? '/' + pathStr : ''}`);
  }

  /** Convert Postman {{var}} syntax — already matches OpenCollection, but strip :path style */
  private convertPostmanVars(str: string): string {
    // Postman uses {{var}} which is the same as OpenCollection — no conversion needed
    // But Postman path variables use :varName in the URL, convert to {{varName}}
    return str.replace(/:([a-zA-Z_]\w*)/g, '{{$1}}');
  }

  /** Preserve case and spaces, only strip characters unsafe for file/directory names. */
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

  private extractDescription(desc: any): string {
    if (!desc) return '';
    if (typeof desc === 'string') return desc;
    if (typeof desc === 'object' && desc.content) return desc.content;
    return '';
  }
}
