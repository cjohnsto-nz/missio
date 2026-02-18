import * as fs from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { OpenCollection, OpenCollectionWorkspace, HttpRequest, Folder } from '../models/types';
import { migrateCollection, migrateRequest, migrateFolder } from './migrations';

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
  migrateCollection(data);
  return data;
}

export async function readWorkspaceFile(filePath: string): Promise<OpenCollectionWorkspace> {
  return readYamlFile<OpenCollectionWorkspace>(filePath);
}

export async function readRequestFile(filePath: string): Promise<HttpRequest> {
  const data = await readYamlFile<HttpRequest>(filePath);
  migrateRequest(data);
  return data;
}

export async function readFolderFile(filePath: string): Promise<Folder> {
  const data = await readYamlFile<Folder>(filePath);
  migrateFolder(data);
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
