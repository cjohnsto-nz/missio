import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { Environment, Variable, SecretVariable, MissioCollection, VariableValue, VariableTypedValue, VariableValueVariant } from '../models/types';
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
   * 2. Active environment variables
   * 3. dotenv file variables (if configured)
   */
  async resolveVariables(collection: MissioCollection): Promise<Map<string, string>> {
    const vars = new Map<string, string>();

    // 1. Collection request-level default variables
    const defaults = collection.data.request?.variables ?? [];
    for (const v of defaults) {
      const val = this._resolveVariableValue(v.value);
      if (val !== undefined && !v.disabled) {
        vars.set(v.name, val);
      }
    }

    // 2. Active environment
    const envName = this._activeEnvironments.get(collection.id);
    if (envName) {
      const env = this.getCollectionEnvironments(collection).find(e => e.name === envName);
      if (env) {
        // dotenv file
        if (env.dotEnvFilePath) {
          const dotEnvVars = await this._loadDotEnv(collection.rootDir, env.dotEnvFilePath);
          for (const [k, v] of dotEnvVars) {
            vars.set(k, v);
          }
        }

        // Environment variables
        for (const v of env.variables ?? []) {
          if ('secret' in v && (v as SecretVariable).secret) {
            // Secret variable — resolve via secret provider
            const sv = v as SecretVariable;
            if (!sv.disabled && sv.name) {
              try {
                const secret = await this._secretService.resolveSecret(sv.name);
                if (secret !== undefined) {
                  vars.set(sv.name, secret);
                }
              } catch {
                // Secret unavailable — leave unresolved
              }
            }
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

        // Handle `extends` — inherit from another environment
        if (env.extends) {
          const parent = this.getCollectionEnvironments(collection).find(e => e.name === env.extends);
          if (parent) {
            for (const v of parent.variables ?? []) {
              if (!('secret' in v)) {
                const variable = v as Variable;
                if (!variable.disabled && !vars.has(variable.name)) {
                  const val = this._resolveVariableValue(variable.value);
                  if (val !== undefined) {
                    vars.set(variable.name, val);
                  }
                }
              }
            }
          }
        }
      }
    }

    // Recursive interpolation: resolve {{var}} references within values
    this._interpolateVarValues(vars);

    return vars;
  }

  /**
   * Resolve all variables with their source information.
   * Sources: 'collection', 'environment', 'dotenv', 'secret'
   */
  async resolveVariablesWithSource(collection: MissioCollection): Promise<Map<string, { value: string; source: string }>> {
    const vars = new Map<string, { value: string; source: string }>();

    // 1. Collection request-level default variables
    const defaults = collection.data.request?.variables ?? [];
    for (const v of defaults) {
      const val = this._resolveVariableValue(v.value);
      if (val !== undefined && !v.disabled) {
        vars.set(v.name, { value: val, source: 'collection' });
      }
    }

    // 2. Active environment
    const envName = this._activeEnvironments.get(collection.id);
    if (envName) {
      const env = this.getCollectionEnvironments(collection).find(e => e.name === envName);
      if (env) {
        // dotenv file
        if (env.dotEnvFilePath) {
          const dotEnvVars = await this._loadDotEnv(collection.rootDir, env.dotEnvFilePath);
          for (const [k, v] of dotEnvVars) {
            vars.set(k, { value: v, source: 'dotenv' });
          }
        }

        // Environment variables
        for (const v of env.variables ?? []) {
          if ('secret' in v && (v as SecretVariable).secret) {
            const sv = v as SecretVariable;
            if (!sv.disabled && sv.name) {
              try {
                const secret = await this._secretService.resolveSecret(sv.name);
                if (secret !== undefined) {
                  vars.set(sv.name, { value: secret, source: 'secret' });
                }
              } catch { /* Secret unavailable */ }
            }
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

        // Handle `extends`
        if (env.extends) {
          const parent = this.getCollectionEnvironments(collection).find(e => e.name === env.extends);
          if (parent) {
            for (const v of parent.variables ?? []) {
              if (!('secret' in v)) {
                const variable = v as Variable;
                if (!variable.disabled && !vars.has(variable.name)) {
                  const val = this._resolveVariableValue(variable.value);
                  if (val !== undefined) {
                    vars.set(variable.name, { value: val, source: 'environment' });
                  }
                }
              }
            }
          }
        }
      }
    }

    // Recursive interpolation: resolve {{var}} references within values
    this._interpolateVarValuesWithSource(vars);

    return vars;
  }

  /**
   * Interpolate `{{variable}}` placeholders in a string.
   */
  interpolate(template: string, variables: Map<string, string>): string {
    return template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (match, name) => {
      const key = name.trim();
      return variables.has(key) ? variables.get(key)! : match;
    });
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Recursively interpolate {{var}} references within variable values.
   * Runs multiple passes to handle chained references (up to 10 to prevent infinite loops).
   */
  private _interpolateVarValues(vars: Map<string, string>): void {
    const varPattern = /\{\{(\s*[\w.]+\s*)\}\}/g;
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const [key, val] of vars) {
        const resolved = val.replace(varPattern, (match, name) => {
          const ref = name.trim();
          if (ref === key) return match; // avoid self-reference
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
    const varPattern = /\{\{(\s*[\w.]+\s*)\}\}/g;
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const [key, entry] of vars) {
        const resolved = entry.value.replace(varPattern, (match, name) => {
          const ref = name.trim();
          if (ref === key) return match; // avoid self-reference
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

  dispose(): void {
    this._onDidChange.dispose();
  }
}
