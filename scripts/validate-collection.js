#!/usr/bin/env node

/**
 * Validates an OpenCollection directory against opencollectionschema.json.
 *
 * Usage:
 *   node scripts/validate-collection.js <collection-directory>
 *
 * Example:
 *   node scripts/validate-collection.js examples/demo-api
 *
 * Validates:
 *   - collection.yml  → root OpenCollection schema
 *   - folder.yml      → $defs/Folder schema
 *   - *.yml (requests) → $defs/HttpRequest schema
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { parse: parseYaml } = require('yaml');

// ── Load schema ─────────────────────────────────────────────────────

const SCHEMA_PATH = path.resolve(__dirname, '..', 'schema', 'opencollectionschema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));

// ── Build sub-schemas from $defs ────────────────────────────────────

function buildSubSchema(defName) {
  return {
    $schema: schema.$schema,
    $id: `${schema.$id}#sub-${defName}`,
    $ref: `${schema.$id}#/$defs/${defName}`,
    $defs: schema.$defs,
  };
}

// ── Set up Ajv ──────────────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false });

const validateCollection = ajv.compile(schema);
const validateHttpRequest = ajv.compile(buildSubSchema('HttpRequest'));
const validateFolder = ajv.compile(buildSubSchema('Folder'));

// ── File classification (mirrors yamlParser.ts logic) ───────────────

function isCollectionFile(name) {
  const lower = name.toLowerCase();
  return lower === 'collection.yml' || lower === 'collection.yaml';
}

function isFolderFile(name) {
  const lower = name.toLowerCase();
  return lower === 'folder.yml' || lower === 'folder.yaml';
}

function isWorkspaceFile(name) {
  const lower = name.toLowerCase();
  return lower === 'workspace.yml' || lower === 'workspace.yaml';
}

function isRequestFile(name) {
  const lower = name.toLowerCase();
  return (lower.endsWith('.yml') || lower.endsWith('.yaml'))
    && !isCollectionFile(lower)
    && !isWorkspaceFile(lower)
    && !isFolderFile(lower);
}

// ── Validation ──────────────────────────────────────────────────────

let totalFiles = 0;
let passCount = 0;
let failCount = 0;
const errors = [];

function validateFile(filePath, data, validator, schemaLabel) {
  totalFiles++;
  const relPath = path.relative(process.cwd(), filePath);
  const valid = validator(data);
  if (valid) {
    passCount++;
    console.log(`  ✓ ${relPath}`);
  } else {
    failCount++;
    const errSummary = validator.errors
      .map(e => {
        const loc = e.instancePath || '(root)';
        return `    ${loc}: ${e.message}`;
      })
      .join('\n');
    console.log(`  ✗ ${relPath}`);
    errors.push({ file: relPath, schema: schemaLabel, details: errSummary });
  }
}

function scanDirectory(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`  ✗ Cannot read directory: ${dir} (${err.message})`);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(fullPath);
      continue;
    }

    if (!entry.isFile()) continue;

    const name = entry.name;
    if (!(name.toLowerCase().endsWith('.yml') || name.toLowerCase().endsWith('.yaml'))) continue;

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      console.error(`  ✗ Cannot read file: ${fullPath} (${err.message})`);
      failCount++;
      continue;
    }

    let data;
    try {
      data = parseYaml(content);
    } catch (err) {
      console.error(`  ✗ YAML parse error: ${fullPath} (${err.message})`);
      failCount++;
      continue;
    }

    if (data == null) {
      console.error(`  ✗ Empty YAML file: ${fullPath}`);
      failCount++;
      continue;
    }

    if (isCollectionFile(name)) {
      validateFile(fullPath, data, validateCollection, 'OpenCollection');
    } else if (isFolderFile(name)) {
      validateFile(fullPath, data, validateFolder, 'Folder');
    } else if (isWorkspaceFile(name)) {
      // Workspace files have their own schema shape; skip for now
      console.log(`  - ${path.relative(process.cwd(), fullPath)} (workspace — skipped)`);
    } else if (isRequestFile(name)) {
      validateFile(fullPath, data, validateHttpRequest, 'HttpRequest');
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

const targetDir = process.argv[2];

if (!targetDir) {
  console.error('Usage: node scripts/validate-collection.js <collection-directory>');
  console.error('Example: node scripts/validate-collection.js examples/demo-api');
  process.exit(1);
}

const resolvedDir = path.resolve(targetDir);

if (!fs.existsSync(resolvedDir)) {
  console.error(`Directory not found: ${resolvedDir}`);
  process.exit(1);
}

// Check for collection.yml at root
const hasCollection = ['collection.yml', 'collection.yaml'].some(
  f => fs.existsSync(path.join(resolvedDir, f))
);
if (!hasCollection) {
  console.error(`No collection.yml found in: ${resolvedDir}`);
  console.error('Are you pointing at the right directory?');
  process.exit(1);
}

console.log(`\nValidating: ${resolvedDir}\n`);
scanDirectory(resolvedDir);

// ── Report ──────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Files: ${totalFiles}  |  Pass: ${passCount}  |  Fail: ${failCount}`);

if (errors.length > 0) {
  console.log(`\nErrors:\n`);
  for (const err of errors) {
    console.log(`  ${err.file} (${err.schema}):`);
    console.log(err.details);
    console.log();
  }
  process.exit(1);
} else {
  console.log('\nAll files valid ✓\n');
  process.exit(0);
}
