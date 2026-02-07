import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { Environment, Variable, SecretVariable, MissioCollection, VariableTypedValue, VariableValueVariant, RequestDefaults, SecretProvider } from '../models/types';
import { varPatternGlobal } from '../models/varPattern';
import type { SecretService } from './secretService';

export class EnvironmentService implements vscode.Disposable {
  private _activeEnvironments: Map<string, string> = new Map(); // collectionId -> envName
  private _globalEnvironment: string | undefined;
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _secretService: SecretService,
  ) {
    // Restore persisted active environments
    const saved = this._context.workspaceState.get<Record<string, string>>('missio.activeEnvironments', {});
    for (const [k, v] of Object.entries(saved)) {
      this._activeEnvironments.set(k, v);
    }
    this._globalEnvironment = this._context.workspaceState.get<string>('missio.globalEnvironment');
  }

  getActiveEnvironmentName(collectionId: string): string | undefined {
    return this._activeEnvironments.get(collectionId);
  }

  getGlobalEnvironmentName(): string | undefined {
    return this._globalEnvironment;
  }

  async setActiveEnvironment(collectionId: string, envName: string): Promise<void> {
    this._activeEnvironments.set(collectionId, envName);
    await this._persist();
    this._onDidChange.fire();
  }

  async setGlobalEnvironment(envName: string | undefined): Promise<void> {
    this._globalEnvironment = envName;
    await this._persist();
    this._onDidChange.fire();
  }

  /**
   * Get the list of environments defined in a collection.
   */
  getCollectionEnvironments(collection: MissioCollection): Environment[] {
    return collection.data.config?.environments ?? [];
  }

  /**
   * Resolve all variables for a collection, merging:
   * 1. Collection-level request defaults
   * 2. Folder-level request defaults (if provided)
   * 3. Active environment variables
   * 4. dotenv file variables (if configured)
   */
  async resolveVariables(collection: MissioCollection, folderDefaults?: RequestDefaults): Promise<Map<string, string>> {
    const vars = new Map<string, string>();

    // 0. Global variables (lowest priority — overridden by everything)
    await this._resolveGlobalVars(vars);

    // 1. Collection request-level default variables
    const defaults = collection.data.request?.variables ?? [];
    for (const v of defaults) {
      const val = this._resolveVariableValue(v.value);
      if (val !== undefined && !v.disabled) {
        vars.set(v.name, val);
      }
    }

    // 2. Folder-level variables (override collection)
    if (folderDefaults?.variables) {
      for (const v of folderDefaults.variables) {
        if (!v.disabled) {
          const val = this._resolveVariableValue(v.value);
          if (val !== undefined) {
            vars.set(v.name, val);
          }
        }
      }
    }

    // 3. Active environment (overrides collection and folder)
    const envName = this._activeEnvironments.get(collection.id);
    if (envName) {
      const env = this.getCollectionEnvironments(collection).find(e => e.name === envName);
      if (env) {
        // Handle `extends` — apply parent env variables first (overrides collection/folder, overridden by child)
        if (env.extends) {
          const parent = this.getCollectionEnvironments(collection).find(e => e.name === env.extends);
          if (parent) {
            for (const v of parent.variables ?? []) {
              if ('secret' in v && (v as SecretVariable).secret) {
                // resolved below via _resolveSecretVars
              } else {
                const variable = v as Variable;
                if (!variable.disabled) {
                  const val = this._resolveVariableValue(variable.value);
                  if (val !== undefined) vars.set(variable.name, val);
                }
              }
            }
            await this._resolveSecretVars(vars, collection, parent.name, parent.variables ?? []);
          }
        }

        // dotenv file
        if (env.dotEnvFilePath) {
          const dotEnvVars = await this._loadDotEnv(collection.rootDir, env.dotEnvFilePath);
          for (const [k, v] of dotEnvVars) {
            vars.set(k, v);
          }
        }

        // Child environment variables (override everything above)
        for (const v of env.variables ?? []) {
          if ('secret' in v && (v as SecretVariable).secret) {
            // resolved below via _resolveSecretVars
          } else {
            const variable = v as Variable;
            if (!variable.disabled) {
              const val = this._resolveVariableValue(variable.value);
              if (val !== undefined) {
                vars.set(variable.name, val);
              }
            }
          }
        }
        await this._resolveSecretVars(vars, collection, envName, env.variables ?? []);
      }
    }

    // Recursive interpolation: resolve {{var}} references within values
    this._interpolateVarValues(vars);

    // Resolve $secret.{vault}.{key} references in all variable values
    const providers = collection.data.config?.secretProviders ?? [];
    if (providers.length > 0) {
      await this._resolveSecretRefs(vars, providers);
    }

    return vars;
  }

  /**
   * Resolve all variables with their source information.
   * Sources: 'collection', 'environment', 'dotenv', 'secret'
   */
  async resolveVariablesWithSource(collection: MissioCollection, folderDefaults?: RequestDefaults): Promise<Map<string, { value: string; source: string }>> {
    const vars = new Map<string, { value: string; source: string }>();

    // 0. Global variables (lowest priority — overridden by everything)
    await this._resolveGlobalVarsWithSource(vars);

    // 1. Collection request-level default variables
    const defaults = collection.data.request?.variables ?? [];
    for (const v of defaults) {
      const val = this._resolveVariableValue(v.value);
      if (val !== undefined && !v.disabled) {
        vars.set(v.name, { value: val, source: 'collection' });
      }
    }

    // 2. Folder-level variables (override collection)
    if (folderDefaults?.variables) {
      for (const v of folderDefaults.variables) {
        if (!v.disabled) {
          const val = this._resolveVariableValue(v.value);
          if (val !== undefined) {
            vars.set(v.name, { value: val, source: 'folder' });
          }
        }
      }
    }

    // 3. Active environment (overrides collection and folder)
    const envName = this._activeEnvironments.get(collection.id);
    if (envName) {
      const env = this.getCollectionEnvironments(collection).find(e => e.name === envName);
      if (env) {
        // Handle `extends` — apply parent env variables first (overrides collection/folder, overridden by child)
        if (env.extends) {
          const parent = this.getCollectionEnvironments(collection).find(e => e.name === env.extends);
          if (parent) {
            for (const v of parent.variables ?? []) {
              if ('secret' in v && (v as SecretVariable).secret) {
                // resolved below via _resolveSecretVarsWithSource
              } else {
                const variable = v as Variable;
                if (!variable.disabled) {
                  const val = this._resolveVariableValue(variable.value);
                  if (val !== undefined) vars.set(variable.name, { value: val, source: 'environment' });
                }
              }
            }
            await this._resolveSecretVarsWithSource(vars, collection, parent.name, parent.variables ?? []);
          }
        }

        // dotenv file
        if (env.dotEnvFilePath) {
          const dotEnvVars = await this._loadDotEnv(collection.rootDir, env.dotEnvFilePath);
          for (const [k, v] of dotEnvVars) {
            vars.set(k, { value: v, source: 'dotenv' });
          }
        }

        // Child environment variables (override everything above)
        for (const v of env.variables ?? []) {
          if ('secret' in v && (v as SecretVariable).secret) {
            // resolved below via _resolveSecretVarsWithSource
          } else {
            const variable = v as Variable;
            if (!variable.disabled) {
              const val = this._resolveVariableValue(variable.value);
              if (val !== undefined) {
                vars.set(variable.name, { value: val, source: 'environment' });
              }
            }
          }
        }
        await this._resolveSecretVarsWithSource(vars, collection, envName, env.variables ?? []);
      }
    }

    // Recursive interpolation: resolve {{var}} references within values
    this._interpolateVarValuesWithSource(vars);

    // Resolve $secret.{vault}.{key} references in all variable values
    const providers = collection.data.config?.secretProviders ?? [];
    if (providers.length > 0) {
      await this._resolveSecretRefsWithSource(vars, providers);
    }

    return vars;
  }

  /**
   * Interpolate `{{variable}}` placeholders in a string.
   */
  interpolate(template: string, variables: Map<string, string>): string {
    return template.replace(varPatternGlobal(), (match, name) => {
      const key = name.trim();
      const builtin = this._resolveBuiltin(key);
      if (builtin !== undefined) return builtin;
      return variables.has(key) ? variables.get(key)! : match;
    });
  }

  /**
   * Interpolate {{var}} placeholders AND resolve $secret.{vault}.{key} references.
   */
  async interpolateWithSecrets(
    template: string,
    variables: Map<string, string>,
    collection: MissioCollection,
  ): Promise<string> {
    let result = this.interpolate(template, variables);
    const providers = collection.data.config?.secretProviders ?? [];
    if (providers.length > 0) {
      result = await this._secretService.resolveSecretReferences(result, providers, variables);
    }
    return result;
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Recursively interpolate {{var}} references within variable values.
   * Runs multiple passes to handle chained references (up to 10 to prevent infinite loops).
   */
  private _interpolateVarValues(vars: Map<string, string>): void {
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const [key, val] of vars) {
        const resolved = val.replace(varPatternGlobal(), (match, name) => {
          const ref = name.trim();
          if (ref === key) return match; // avoid self-reference
          const builtin = this._resolveBuiltin(ref);
          if (builtin !== undefined) return builtin;
          return vars.has(ref) ? vars.get(ref)! : match;
        });
        if (resolved !== val) {
          vars.set(key, resolved);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  private _interpolateVarValuesWithSource(vars: Map<string, { value: string; source: string }>): void {
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const [key, entry] of vars) {
        const resolved = entry.value.replace(varPatternGlobal(), (match, name) => {
          const ref = name.trim();
          if (ref === key) return match; // avoid self-reference
          const builtin = this._resolveBuiltin(ref);
          if (builtin !== undefined) return builtin;
          return vars.has(ref) ? vars.get(ref)!.value : match;
        });
        if (resolved !== entry.value) {
          vars.set(key, { value: resolved, source: entry.source });
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  private _resolveBuiltin(name: string): string | undefined {
    switch (name) {
      case '$guid': return randomUUID();
      case '$timestamp': return String(Math.floor(Date.now() / 1000));
      case '$randomInt': return String(Math.floor(Math.random() * 1001));
      default: return undefined;
    }
  }

  /**
   * Scan all variable values for $secret.{vault}.{key} references and resolve them.
   */
  private async _resolveSecretRefs(vars: Map<string, string>, providers: SecretProvider[]): Promise<void> {
    const pattern = /\$secret\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)/g;
    for (const [key, val] of vars) {
      const matches = [...val.matchAll(pattern)];
      if (matches.length === 0) continue;
      let resolved = val;
      for (const match of matches) {
        const [fullMatch, providerName, secretName] = match;
        try {
          const secret = await this._secretService.resolveSecret(providerName, secretName, providers, vars);
          if (secret !== undefined) {
            resolved = resolved.replace(fullMatch, secret);
          }
        } catch { /* leave unresolved */ }
      }
      if (resolved !== val) {
        vars.set(key, resolved);
      }
    }
  }

  private async _resolveSecretRefsWithSource(vars: Map<string, { value: string; source: string }>, providers: SecretProvider[]): Promise<void> {
    const pattern = /\$secret\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)/g;
    // Build a plain map for the secret service
    const plainVars = new Map<string, string>();
    for (const [k, v] of vars) { plainVars.set(k, v.value); }
    for (const [key, entry] of vars) {
      const matches = [...entry.value.matchAll(pattern)];
      if (matches.length === 0) continue;
      let resolved = entry.value;
      for (const match of matches) {
        const [fullMatch, providerName, secretName] = match;
        try {
          const secret = await this._secretService.resolveSecret(providerName, secretName, providers, plainVars);
          if (secret !== undefined) {
            resolved = resolved.replace(fullMatch, secret);
          }
        } catch { /* leave unresolved */ }
      }
      if (resolved !== entry.value) {
        vars.set(key, { value: resolved, source: 'secret' });
      }
    }
  }

  private _resolveVariableValue(value: Variable['value']): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    if (typeof value === 'string') { return value; }

    // VariableTypedValue
    if (typeof value === 'object' && 'data' in value && 'type' in value) {
      return (value as VariableTypedValue).data;
    }

    // VariableValueVariant[]
    if (Array.isArray(value)) {
      const variants = value as VariableValueVariant[];
      const selected = variants.find(v => v.selected) ?? variants[0];
      if (selected) {
        return this._resolveVariableValue(selected.value);
      }
    }

    return undefined;
  }

  private async _loadDotEnv(rootDir: string, dotEnvPath: string): Promise<Map<string, string>> {
    const vars = new Map<string, string>();
    const fullPath = path.resolve(rootDir, dotEnvPath);
    try {
      const content = await fs.promises.readFile(fullPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim();
          let val = trimmed.substring(eqIdx + 1).trim();
          // Strip surrounding quotes
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars.set(key, val);
        }
      }
    } catch {
      // dotenv not found — ignore
    }
    return vars;
  }

  private async _persist(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this._activeEnvironments) {
      obj[k] = v;
    }
    await this._context.workspaceState.update('missio.activeEnvironments', obj);
    await this._context.workspaceState.update('missio.globalEnvironment', this._globalEnvironment);
  }

  // ── Secure variable storage (UUID-based, VS Code SecretStorage) ──
  //
  // Secure variables store a reference `secure:{uuid}` in the YAML value field.
  // The actual secret is stored in SecretStorage under key `missio:secure:{uuid}`.
  // This makes secrets rename-safe and delete-clean.

  private static readonly _SECURE_PREFIX = 'secure:';

  /** Extract the UUID from a secure reference value like "secure:a1b2c3d4-..." */
  static extractSecureId(value: string | undefined): string | undefined {
    if (value && value.startsWith(EnvironmentService._SECURE_PREFIX)) {
      return value.slice(EnvironmentService._SECURE_PREFIX.length);
    }
    return undefined;
  }

  /** Generate a new secure reference value: "secure:{uuid}" */
  static generateSecureRef(): string {
    return EnvironmentService._SECURE_PREFIX + randomUUID();
  }

  private _secureKey(uuid: string): string {
    return `missio:secure:${uuid}`;
  }

  async storeSecureValue(uuid: string, value: string): Promise<void> {
    await this._context.secrets.store(this._secureKey(uuid), value);
  }

  async getSecureValue(uuid: string): Promise<string | undefined> {
    return this._context.secrets.get(this._secureKey(uuid));
  }

  async deleteSecureValue(uuid: string): Promise<void> {
    await this._context.secrets.delete(this._secureKey(uuid));
  }

  /** Resolve a single secure variable by reading its UUID ref and looking up SecretStorage. */
  private async _resolveSecureVar(sv: SecretVariable): Promise<string | undefined> {
    const uuid = EnvironmentService.extractSecureId(sv.value);
    if (uuid) {
      return this.getSecureValue(uuid);
    }
    return undefined;
  }

  /** Resolve secret-type environment variables. Uses YAML value for hidden; SecretStorage UUID lookup for secure. */
  private async _resolveSecretVars(
    vars: Map<string, string>,
    collection: MissioCollection,
    envName: string,
    envVariables: (Variable | SecretVariable)[],
  ): Promise<void> {
    for (const v of envVariables) {
      if ('secret' in v && (v as SecretVariable).secret && v.name && !v.disabled) {
        const sv = v as SecretVariable;
        if (sv.secure) {
          const val = await this._resolveSecureVar(sv);
          if (val !== undefined) vars.set(sv.name!, val);
        } else if (sv.value !== undefined) {
          vars.set(sv.name!, sv.value);
        }
      }
    }
  }

  /** Resolve secret-type environment variables with source info. */
  private async _resolveSecretVarsWithSource(
    vars: Map<string, { value: string; source: string }>,
    collection: MissioCollection,
    envName: string,
    envVariables: (Variable | SecretVariable)[],
  ): Promise<void> {
    for (const v of envVariables) {
      if ('secret' in v && (v as SecretVariable).secret && v.name && !v.disabled) {
        const sv = v as SecretVariable;
        if (sv.secure) {
          const val = await this._resolveSecureVar(sv);
          if (val !== undefined) vars.set(sv.name!, { value: val, source: 'secret' });
        } else if (sv.value !== undefined) {
          vars.set(sv.name!, { value: sv.value, source: 'secret' });
        }
      }
    }
  }

  // ── Global variables (stored in globalState, not tied to any collection) ──

  private static readonly _GLOBAL_VARS_KEY = 'missio.globalVariables';

  getGlobalVariables(): GlobalVariable[] {
    return this._context.globalState.get<GlobalVariable[]>(EnvironmentService._GLOBAL_VARS_KEY, []);
  }

  async setGlobalVariables(vars: GlobalVariable[]): Promise<void> {
    await this._context.globalState.update(EnvironmentService._GLOBAL_VARS_KEY, vars);
    this._onDidChange.fire();
  }

  /** Resolve global variables into a vars map (lowest priority). */
  private async _resolveGlobalVars(vars: Map<string, string>): Promise<void> {
    for (const v of this.getGlobalVariables()) {
      if (!v.name || v.disabled) continue;
      if (v.secret && v.secure) {
        const uuid = EnvironmentService.extractSecureId(v.value);
        if (uuid) {
          const val = await this.getSecureValue(uuid);
          if (val !== undefined) vars.set(v.name, val);
        }
      } else if (v.value !== undefined) {
        vars.set(v.name, v.value);
      }
    }
  }

  /** Resolve global variables with source info. */
  private async _resolveGlobalVarsWithSource(vars: Map<string, { value: string; source: string }>): Promise<void> {
    for (const v of this.getGlobalVariables()) {
      if (!v.name || v.disabled) continue;
      if (v.secret && v.secure) {
        const uuid = EnvironmentService.extractSecureId(v.value);
        if (uuid) {
          const val = await this.getSecureValue(uuid);
          if (val !== undefined) vars.set(v.name, { value: val, source: 'global' });
        }
      } else if (v.value !== undefined) {
        vars.set(v.name, { value: v.value, source: 'global' });
      }
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** Shape of a global variable stored in globalState. */
export interface GlobalVariable {
  name: string;
  value?: string;
  secret?: boolean;
  secure?: boolean;
  disabled?: boolean;
}
