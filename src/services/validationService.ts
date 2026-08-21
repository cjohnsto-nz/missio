import * as fs from 'fs';
import * as path from 'path';
import Ajv, { type ErrorObject } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { isGraphQLRequest, isGrpcRequest, isScriptFile, isWebSocketRequest } from '../models/types';

// ── File classification (mirrors yamlParser.ts logic) ───────────────

function isCollectionFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'opencollection.yml' || lower === 'opencollection.yaml'
    || lower === 'collection.yml' || lower === 'collection.yaml';
}

function isFolderFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'folder.yml' || lower === 'folder.yaml';
}

function isWorkspaceFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'workspace.yml' || lower === 'workspace.yaml';
}

function isRequestFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.endsWith('.yml') || lower.endsWith('.yaml'))
    && !isCollectionFile(lower)
    && !isWorkspaceFile(lower)
    && !isFolderFile(lower);
}

// ── Types ───────────────────────────────────────────────────────────

export interface ValidationError {
  path: string;
  message: string;
  hint?: string;
}

export interface ValidationIssue {
  file: string;
  schemaLabel: string;
  errors: ValidationError[];
}

export interface ValidationReport {
  collectionName: string;
  rootDir: string;
  totalFiles: number;
  passCount: number;
  failCount: number;
  issues: ValidationIssue[];
}

interface Validators {
  collection: any;
  httpRequest: any;
  graphQLRequest: any;
  grpcRequest: any;
  webSocketRequest: any;
  folder: any;
  workspace: any;
  scriptFile: any;
}

interface ValidationRoute {
  validator: any;
  schemaLabel: string;
}

// ── Validator ───────────────────────────────────────────────────────

function buildSubSchema(schema: any, defName: string): any {
  return {
    $schema: schema.$schema,
    $id: `${schema.$id}#sub-${defName}`,
    $ref: `${schema.$id}#/$defs/${defName}`,
    $defs: schema.$defs,
  };
}

function buildWorkspaceSchema(): any {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://schema.opencollection.com/json/draft-07/opencollection-workspace/v1.0.0',
    type: 'object',
    properties: {
      workspace: { type: 'string' },
      info: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          version: { type: 'string' },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                url: { type: 'string' },
              },
              required: ['name', 'url'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      collections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['name', 'path'],
          additionalProperties: false,
        },
      },
    },
    required: ['collections'],
    additionalProperties: false,
  };
}

function formatErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors) return [];
  return errors.map(e => {
    const result: ValidationError = {
      path: e.instancePath || '(root)',
      message: e.message || 'unknown error',
    };
    const hint = generateHint(e);
    if (hint) result.hint = hint;
    return result;
  });
}

function generateHint(e: ErrorObject): string | undefined {
  switch (e.keyword) {
    case 'required':
      return `Add the missing property "${e.params.missingProperty}" at this level.`;
    case 'type':
      return `Expected type "${e.params.type}". Check the value is not quoted/unquoted incorrectly in YAML.`;
    case 'enum':
      return `Must be one of: ${(e.params.allowedValues as string[]).join(', ')}`;
    case 'additionalProperties':
      return `Remove or rename the unknown property "${e.params.additionalProperty}". Check spelling against the OpenCollection schema.`;
    case 'pattern':
      return `Value must match pattern: ${e.params.pattern}`;
    case 'oneOf':
      return 'Value must match exactly one of the allowed schemas. Check the structure against the OpenCollection spec.';
    case 'anyOf':
      return 'Value must match at least one of the allowed schemas.';
    case 'minItems':
      return `Array must have at least ${e.params.limit} item(s).`;
    case 'maxItems':
      return `Array must have at most ${e.params.limit} item(s).`;
    case 'minLength':
      return `String must be at least ${e.params.limit} character(s) long.`;
    default:
      return undefined;
  }
}

/**
 * Validate an entire OpenCollection directory against the bundled JSON schema.
 */
export async function validateCollection(
  rootDir: string,
  schemaPath: string,
): Promise<ValidationReport> {
  const schemaContent = await fs.promises.readFile(schemaPath, 'utf-8');
  const schema = JSON.parse(schemaContent);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validators: Validators = {
    collection: ajv.compile(schema),
    httpRequest: ajv.compile(buildSubSchema(schema, 'HttpRequest')),
    graphQLRequest: ajv.compile(buildSubSchema(schema, 'GraphQLRequest')),
    grpcRequest: ajv.compile(buildSubSchema(schema, 'GrpcRequest')),
    webSocketRequest: ajv.compile(buildSubSchema(schema, 'WebSocketRequest')),
    folder: ajv.compile(buildSubSchema(schema, 'Folder')),
    workspace: ajv.compile(buildWorkspaceSchema()),
    scriptFile: ajv.compile(buildSubSchema(schema, 'ScriptFile')),
  };

  const report: ValidationReport = {
    collectionName: path.basename(rootDir),
    rootDir,
    totalFiles: 0,
    passCount: 0,
    failCount: 0,
    issues: [],
  };

  await scanDirectory(rootDir, rootDir, report, validators);
  return report;
}

async function scanDirectory(
  dir: string,
  rootDir: string,
  report: ValidationReport,
  validators: Validators,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await scanDirectory(fullPath, rootDir, report, validators);
      continue;
    }

    if (!entry.isFile()) continue;
    const name = entry.name;
    const lower = name.toLowerCase();
    if (!lower.endsWith('.yml') && !lower.endsWith('.yaml')) continue;

    let content: string;
    try {
      content = await fs.promises.readFile(fullPath, 'utf-8');
    } catch {
      report.failCount++;
      report.totalFiles++;
      report.issues.push({
        file: path.relative(rootDir, fullPath),
        schemaLabel: 'File',
        errors: [{ path: '(root)', message: 'Cannot read file' }],
      });
      continue;
    }

    let data: any;
    try {
      data = parseYaml(content);
    } catch (e: any) {
      report.failCount++;
      report.totalFiles++;
      report.issues.push({
        file: path.relative(rootDir, fullPath),
        schemaLabel: 'YAML',
        errors: [{ path: '(root)', message: `YAML parse error: ${e.message}` }],
      });
      continue;
    }

    if (data == null) {
      report.failCount++;
      report.totalFiles++;
      report.issues.push({
        file: path.relative(rootDir, fullPath),
        schemaLabel: 'YAML',
        errors: [{ path: '(root)', message: 'Empty YAML file' }],
      });
      continue;
    }

    if (isCollectionFile(name)) {
      validateFile(fullPath, rootDir, data, validators.collection, 'OpenCollection', report);
    } else if (isFolderFile(name)) {
      validateFile(fullPath, rootDir, data, validators.folder, 'Folder', report);
    } else if (isWorkspaceFile(name)) {
      validateFile(fullPath, rootDir, data, validators.workspace, 'OpenCollectionWorkspace', report);
    } else if (isRequestFile(name)) {
      const route = getRequestValidationRoute(data, validators);
      validateFile(fullPath, rootDir, data, route.validator, route.schemaLabel, report);
    }
  }
}

function getRequestValidationRoute(data: any, validators: Validators): ValidationRoute {
  const infoType = data?.info?.type;
  if (isGraphQLRequest(data) || infoType === 'graphql') {
    return { validator: validators.graphQLRequest, schemaLabel: 'GraphQLRequest' };
  }
  if (isGrpcRequest(data) || infoType === 'grpc') {
    return { validator: validators.grpcRequest, schemaLabel: 'GrpcRequest' };
  }
  if (isWebSocketRequest(data) || infoType === 'websocket') {
    return { validator: validators.webSocketRequest, schemaLabel: 'WebSocketRequest' };
  }
  if (isScriptFile(data) || data?.type === 'script') {
    return { validator: validators.scriptFile, schemaLabel: 'ScriptFile' };
  }
  return { validator: validators.httpRequest, schemaLabel: 'HttpRequest' };
}

function validateFile(
  filePath: string,
  rootDir: string,
  data: any,
  validator: any,
  schemaLabel: string,
  report: ValidationReport,
): void {
  report.totalFiles++;
  const valid = validator(data);
  if (valid) {
    report.passCount++;
  } else {
    report.failCount++;
    report.issues.push({
      file: path.relative(rootDir, filePath),
      schemaLabel,
      errors: formatErrors(validator.errors),
    });
  }
}

// ── Report formatting ───────────────────────────────────────────────

export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];

  lines.push(`# Validation Report: ${report.collectionName}`);
  lines.push('');
  lines.push(`**Directory:** \`${report.rootDir}\``);
  lines.push(`**Files:** ${report.totalFiles}  |  **Pass:** ${report.passCount}  |  **Fail:** ${report.failCount}`);
  lines.push('');

  if (report.issues.length === 0) {
    lines.push('All files valid ✓');
  } else {
    lines.push(`## Issues (${report.issues.length})`);
    lines.push('');
    for (const issue of report.issues) {
      lines.push(`### \`${issue.file}\` (${issue.schemaLabel})`);
      lines.push('');
      for (const err of issue.errors) {
        lines.push(`- **${err.path}**: ${err.message}`);
        if (err.hint) lines.push(`  - *Fix:* ${err.hint}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
