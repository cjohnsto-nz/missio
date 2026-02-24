/**
 * Merges opencollectionschema-source.json with missio-extensions.json
 * to produce opencollectionschema.json.
 *
 * Usage: node schema/build-schema.js
 *
 * The source schema is the upstream OpenCollection spec (never edited).
 * Extensions are Missio-specific additions (secret providers, forceAuthInherit, etc.).
 *
 * Patch format:
 *   - target: dot-separated path to the object to patch (e.g. "$defs/CollectionConfig/properties")
 *   - properties: key-value pairs to merge into the target object
 *
 * New $defs are added from the "definitions" section of the extensions file.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.resolve(__dirname, 'opencollectionschema-source.json');
const EXTENSIONS = path.resolve(__dirname, 'missio-extensions.json');
const OUTPUT = path.resolve(__dirname, 'opencollectionschema.json');

function resolveJsonPath(obj, pathStr) {
  const parts = pathStr.split('/');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) {
      throw new Error(`Cannot resolve path "${pathStr}" — segment "${part}" not found`);
    }
    current = current[part];
  }
  return current;
}

function main() {
  const source = JSON.parse(fs.readFileSync(SOURCE, 'utf-8'));
  const extensions = JSON.parse(fs.readFileSync(EXTENSIONS, 'utf-8'));

  // Add new $defs from extensions
  if (extensions.definitions) {
    source.$defs = source.$defs || {};
    for (const [name, def] of Object.entries(extensions.definitions)) {
      if (source.$defs[name]) {
        console.warn(`  Warning: overwriting existing $def "${name}"`);
      }
      source.$defs[name] = def;
      console.log(`  + $defs/${name}`);
    }
  }

  // Apply property patches
  for (const patch of extensions.patches || []) {
    const target = resolveJsonPath(source, patch.target);
    if (!target || typeof target !== 'object') {
      throw new Error(`Patch target "${patch.target}" is not an object`);
    }
    for (const [key, value] of Object.entries(patch.properties)) {
      target[key] = value;
      console.log(`  + ${patch.target}/${key} — ${patch.description}`);
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(source, null, 2) + '\n', 'utf-8');
  console.log(`\nSchema written to ${path.relative(process.cwd(), OUTPUT)}`);
}

main();
