import * as fs from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { OpenCollection, OpenCollectionWorkspace, HttpRequest, Folder } from '../models/types';
import { migrateCollection, migrateRequest, migrateFolder } from './migrations';

/** Files that had migrations applied in-memory but not yet persisted to disk. */
const _pendingMigrations: Map<string, { data: any; applied: string[] }> = new Map();

/** Get all files with pending (un-persisted) migrations. */
export function getPendingMigrations(): Map<string, { data: any; applied: string[] }> {
  return _pendingMigrations;
}

/** Strip underscore-prefixed runtime properties (e.g. _filePath) before writing. */
function stripRuntimeProps(data: any): any {
  if (!data || typeof data !== 'object') return data;
  const clean = Array.isArray(data) ? [...data] : { ...data };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('_')) {
      delete clean[key];
    }
  }
  return clean;
}

/** Write all pending migrations to disk and clear the queue. Returns count of files written. */
export async function persistPendingMigrations(): Promise<number> {
  let count = 0;
  for (const [filePath, { data }] of _pendingMigrations) {
    await writeYamlFile(filePath, stripRuntimeProps(data));
    count++;
  }
  _pendingMigrations.clear();
  return count;
}

/** Clear pending migrations without writing (e.g. user declined). */
export function clearPendingMigrations(): void {
  _pendingMigrations.clear();
}

export async function readYamlFile<T>(filePath: string): Promise<T> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return parseYaml(content) as T;
}

export async function writeYamlFile<T>(filePath: string, data: T): Promise<void> {
  const content = stringifyYaml(data, { lineWidth: 120 });
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

export async function readCollectionFile(filePath: string): Promise<OpenCollection> {
  const data = await readYamlFile<OpenCollection>(filePath);
  const result = migrateCollection(data);
  if (result.changed) {
    _pendingMigrations.set(filePath, { data, applied: result.applied });
  }
  return data;
}

export async function readWorkspaceFile(filePath: string): Promise<OpenCollectionWorkspace> {
  return readYamlFile<OpenCollectionWorkspace>(filePath);
}

export async function readRequestFile(filePath: string): Promise<HttpRequest> {
  const data = await readYamlFile<HttpRequest>(filePath);
  const result = migrateRequest(data);
  if (result.changed) {
    _pendingMigrations.set(filePath, { data, applied: result.applied });
  }
  return data;
}

export async function readFolderFile(filePath: string): Promise<Folder> {
  const data = await readYamlFile<Folder>(filePath);
  const result = migrateFolder(data);
  if (result.changed) {
    _pendingMigrations.set(filePath, { data, applied: result.applied });
  }
  return data;
}

export function isFolderFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower === 'folder.yml' || lower === 'folder.yaml';
}

export function isCollectionFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower === 'collection.yml' || lower === 'collection.yaml';
}

export function isWorkspaceFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower === 'workspace.yml' || lower === 'workspace.yaml';
}

export function isRequestFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (lower.endsWith('.yml') || lower.endsWith('.yaml'))
    && !isCollectionFile(lower)
    && !isWorkspaceFile(lower)
    && !isFolderFile(lower);
}

export { parseYaml, stringifyYaml };
