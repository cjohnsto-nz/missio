import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PostmanImporter } from '../src/importers/postmanImporter';

// ── Helpers ──────────────────────────────────────────────────────────

const TMP_DIR = path.resolve(__dirname, '.tmp-import-test');

function makePostmanCollection(overrides: any = {}): any {
  return {
    info: {
      name: overrides.name ?? 'Test Collection',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      ...overrides.info,
    },
    item: overrides.item ?? [],
    variable: overrides.variable ?? [],
    ...overrides.root,
  };
}

function writePostmanJson(data: any): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, 'import.json');
  fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
  return file;
}

function rmrf(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  rmrf(TMP_DIR);
});

// ── Tests ────────────────────────────────────────────────────────────

describe('PostmanImporter', () => {
  const importer = new PostmanImporter();

  // ── sanitizePath: preserves case and spaces ──────────────────────

  describe('folder/request naming (sanitizePath)', () => {
    it('preserves case and spaces in folder names', async () => {
      const data = makePostmanCollection({
        item: [
          { name: 'My API Folder', item: [] },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const folderDir = path.join(result.collectionDir, 'My API Folder');
      expect(fs.existsSync(folderDir)).toBe(true);
    });

    it('preserves case and spaces in request file names', async () => {
      const data = makePostmanCollection({
        item: [
          { name: 'Get User By ID', request: { method: 'GET', url: 'https://example.com' } },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const reqFile = path.join(result.collectionDir, 'Get User By ID.yml');
      expect(fs.existsSync(reqFile)).toBe(true);
    });

    it('preserves case and spaces in collection root directory', async () => {
      const data = makePostmanCollection({ name: 'My Cool API' });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      expect(path.basename(result.collectionDir)).toBe('My Cool API');
    });

    it('strips unsafe filesystem characters', async () => {
      const data = makePostmanCollection({
        item: [
          { name: 'Folder: <test> "quotes"', item: [] },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const folderDir = path.join(result.collectionDir, 'Folder test quotes');
      expect(fs.existsSync(folderDir)).toBe(true);
    });
  });

  // ── sanitizePath: directory traversal prevention ─────────────────

  describe('directory traversal prevention', () => {
    it('rejects dot-only folder names', async () => {
      const data = makePostmanCollection({
        item: [
          { name: '.', item: [] },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const folderDir = path.join(result.collectionDir, 'Untitled');
      expect(fs.existsSync(folderDir)).toBe(true);
    });

    it('rejects double-dot folder names', async () => {
      const data = makePostmanCollection({
        item: [
          { name: '..', item: [] },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const folderDir = path.join(result.collectionDir, 'Untitled');
      expect(fs.existsSync(folderDir)).toBe(true);
    });

    it('rejects names that are only dots', async () => {
      const data = makePostmanCollection({
        item: [
          { name: '...', item: [] },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const folderDir = path.join(result.collectionDir, 'Untitled');
      expect(fs.existsSync(folderDir)).toBe(true);
    });

    it('allows names containing dots mixed with other chars', async () => {
      const data = makePostmanCollection({
        item: [
          { name: 'v2.0 API', item: [] },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const folderDir = path.join(result.collectionDir, 'v2.0 API');
      expect(fs.existsSync(folderDir)).toBe(true);
    });
  });

  // ── uniqueName: collision after sanitization ─────────────────────

  describe('name uniqueness after sanitization', () => {
    it('deduplicates folders that sanitize to the same name', async () => {
      const data = makePostmanCollection({
        item: [
          { name: 'Test?', item: [{ name: 'req1', request: { method: 'GET', url: 'https://a.com' } }] },
          { name: 'Test*', item: [{ name: 'req2', request: { method: 'GET', url: 'https://b.com' } }] },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      // Both sanitize to "Test", second should get "Test 2"
      const dir1 = path.join(result.collectionDir, 'Test');
      const dir2 = path.join(result.collectionDir, 'Test 2');
      expect(fs.existsSync(dir1)).toBe(true);
      expect(fs.existsSync(dir2)).toBe(true);
      expect(result.folderCount).toBe(2);
    });

    it('deduplicates requests that sanitize to the same name', async () => {
      const data = makePostmanCollection({
        item: [
          { name: 'Get:Users', request: { method: 'GET', url: 'https://a.com' } },
          { name: 'Get"Users', request: { method: 'GET', url: 'https://b.com' } },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      // Both sanitize to "GetUsers", second should get "GetUsers 2"
      const file1 = path.join(result.collectionDir, 'GetUsers.yml');
      const file2 = path.join(result.collectionDir, 'GetUsers 2.yml');
      expect(fs.existsSync(file1)).toBe(true);
      expect(fs.existsSync(file2)).toBe(true);
      expect(result.requestCount).toBe(2);
    });
  });

  // ── Fallback names ───────────────────────────────────────────────

  describe('fallback names', () => {
    it('uses Untitled Folder for unnamed folders', async () => {
      const data = makePostmanCollection({
        item: [
          { item: [] },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const folderDir = path.join(result.collectionDir, 'Untitled Folder');
      expect(fs.existsSync(folderDir)).toBe(true);
    });

    it('uses Untitled Request for unnamed requests', async () => {
      const data = makePostmanCollection({
        item: [
          { request: { method: 'GET', url: 'https://example.com' } },
        ],
      });
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      const reqFile = path.join(result.collectionDir, 'Untitled Request.yml');
      expect(fs.existsSync(reqFile)).toBe(true);
    });

    it('uses Untitled for empty collection name', async () => {
      const data = makePostmanCollection({ name: '' });
      // Override info.name to empty
      data.info.name = '';
      const source = writePostmanJson(data);
      const result = await importer.import(source, TMP_DIR);
      expect(path.basename(result.collectionDir)).toBe('Imported Collection');
    });
  });
});
