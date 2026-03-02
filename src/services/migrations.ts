/**
 * Extensible data migration system for OpenCollection files.
 *
 * Migrations transform legacy data shapes into the current schema on load.
 * Each migration is idempotent — safe to run multiple times on the same data.
 *
 * To add a new migration:
 *   1. Write a Migration object with a unique id, description, and apply function.
 *   2. Push it onto the appropriate registry (collectionMigrations, requestMigrations, folderMigrations).
 *   3. Migrations run in array order — append new ones at the end.
 */

// ── Migration interface ──────────────────────────────────────────────

export interface Migration {
  /** Unique identifier, e.g. '001-secret-provider-url-to-namespace'. */
  id: string;
  /** Human-readable description of what this migration does. */
  description: string;
  /**
   * Mutate `data` in place. Return true if anything was changed.
   * Must be idempotent — if the data is already in the new shape, return false.
   */
  apply: (data: any) => boolean;
}

// ── Migration registries (append new migrations at the end) ──────────

export const collectionMigrations: Migration[] = [
  {
    id: '001-secret-provider-url-to-namespace',
    description: 'Rename secretProviders[].url to .namespace (extract vault name from full URL)',
    apply(data: any): boolean {
      const providers = data?.config?.secretProviders;
      if (!Array.isArray(providers)) return false;
      let changed = false;
      for (const p of providers) {
        if (p.url !== undefined && p.namespace === undefined) {
          // Extract vault name from URL like "https://my-vault.vault.azure.net"
          // or "https://{{vault-name}}.vault.azure.net"
          const urlMatch = /^https?:\/\/([^./]+(?:\.\{[^}]*\}[^./]*)*)\.vault\.azure\.net\/?$/i.exec(p.url);
          p.namespace = urlMatch ? urlMatch[1] : p.url;
          delete p.url;
          changed = true;
        }
      }
      return changed;
    },
  },
  {
    id: '002-oauth2-flat-to-nested',
    description: 'Migrate flat OAuth2 auth in collection request defaults to nested schema-compliant structure',
    apply(data: any): boolean {
      return migrateOAuth2Shape(data?.request?.auth);
    },
  },
];

/**
 * Migrate a flat OAuth2 auth object to the nested schema-compliant structure.
 * Handles: clientId/clientSecret/credentialsPlacement → credentials,
 *          username/password (password flow) → resourceOwner,
 *          autoFetchToken/autoRefreshToken → settings,
 *          pkce (boolean) → pkce.enabled,
 *          flow 'password' → 'resource_owner_password_credentials'.
 * Returns true if any changes were made.
 */
function migrateOAuth2Shape(auth: any): boolean {
  if (!auth || typeof auth !== 'object' || auth.type !== 'oauth2') return false;
  let changed = false;

  // Flat clientId/clientSecret/credentialsPlacement → credentials
  if (auth.clientId !== undefined || auth.clientSecret !== undefined || auth.credentialsPlacement !== undefined) {
    auth.credentials = auth.credentials || {};
    if (auth.clientId !== undefined) { auth.credentials.clientId = auth.clientId; delete auth.clientId; changed = true; }
    if (auth.clientSecret !== undefined) { auth.credentials.clientSecret = auth.clientSecret; delete auth.clientSecret; changed = true; }
    if (auth.credentialsPlacement !== undefined) { auth.credentials.placement = auth.credentialsPlacement; delete auth.credentialsPlacement; changed = true; }
  }

  // Flat autoFetchToken/autoRefreshToken → settings
  if (auth.autoFetchToken !== undefined || auth.autoRefreshToken !== undefined) {
    auth.settings = auth.settings || {};
    if (auth.autoFetchToken !== undefined) { auth.settings.autoFetchToken = auth.autoFetchToken; delete auth.autoFetchToken; changed = true; }
    if (auth.autoRefreshToken !== undefined) { auth.settings.autoRefreshToken = auth.autoRefreshToken; delete auth.autoRefreshToken; changed = true; }
  }

  // Flat username/password (password flow) → resourceOwner
  if (auth.flow === 'password' || auth.flow === 'resource_owner_password_credentials') {
    if (auth.username !== undefined || auth.password !== undefined) {
      auth.resourceOwner = auth.resourceOwner || {};
      if (auth.username !== undefined) { auth.resourceOwner.username = auth.username; delete auth.username; changed = true; }
      if (auth.password !== undefined) { auth.resourceOwner.password = auth.password; delete auth.password; changed = true; }
    }
  }

  // flow 'password' → 'resource_owner_password_credentials'
  if (auth.flow === 'password') {
    auth.flow = 'resource_owner_password_credentials';
    changed = true;
  }

  // pkce boolean → pkce.enabled
  if (typeof auth.pkce === 'boolean') {
    auth.pkce = { enabled: auth.pkce };
    changed = true;
  }

  return changed;
}

export const requestMigrations: Migration[] = [
  {
    id: '003-strip-runtime-props',
    description: 'Remove underscore-prefixed runtime properties (e.g. _filePath) that were accidentally persisted',
    apply(data: any): boolean {
      if (!data || typeof data !== 'object') return false;
      let changed = false;
      for (const key of Object.keys(data)) {
        if (key.startsWith('_')) {
          delete data[key];
          changed = true;
        }
      }
      return changed;
    },
  },
  {
    id: '001-http-auth-to-runtime-auth',
    description: 'Move auth from http to runtime (per OpenCollection schema, auth belongs on runtime not http)',
    apply(data: any): boolean {
      if (!data?.http || data.http.auth === undefined) return false;
      data.runtime = data.runtime || {};
      if (data.runtime.auth !== undefined) {
        // runtime.auth already set — just clean up http.auth
        delete data.http.auth;
        return true;
      }
      data.runtime.auth = data.http.auth;
      delete data.http.auth;
      return true;
    },
  },
  {
    id: '002-oauth2-flat-to-nested',
    description: 'Migrate flat OAuth2 auth fields to nested schema-compliant structure',
    apply(data: any): boolean {
      return migrateOAuth2Shape(data?.runtime?.auth);
    },
  },
];

export const folderMigrations: Migration[] = [
  {
    id: '001-oauth2-flat-to-nested',
    description: 'Migrate flat OAuth2 auth in folder request defaults to nested schema-compliant structure',
    apply(data: any): boolean {
      return migrateOAuth2Shape(data?.request?.auth);
    },
  },
];

// ── Runner ───────────────────────────────────────────────────────────

export interface MigrationResult {
  /** The (possibly mutated) data object. */
  data: any;
  /** True if any migration changed the data. */
  changed: boolean;
  /** IDs of migrations that were applied. */
  applied: string[];
}

function runMigrations(data: any, migrations: Migration[]): MigrationResult {
  if (!data || typeof data !== 'object') return { data, changed: false, applied: [] };
  const applied: string[] = [];
  for (const m of migrations) {
    if (m.apply(data)) {
      applied.push(m.id);
    }
  }
  return { data, changed: applied.length > 0, applied };
}

export function migrateCollection(data: any): MigrationResult {
  return runMigrations(data, collectionMigrations);
}

export function migrateRequest(data: any): MigrationResult {
  return runMigrations(data, requestMigrations);
}

export function migrateFolder(data: any): MigrationResult {
  return runMigrations(data, folderMigrations);
}
