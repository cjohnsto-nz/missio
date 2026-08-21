import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import * as vscode from 'vscode';
import {
  applyRequestEditorModel,
  createRequestEditorModelFromRequest,
} from '../src/models/schemaRoundTrip';
import type { MissioCollection, RequestProtocol } from '../src/models/types';
import { registerRequestCommands } from '../src/commands/requestCommands';
import { RequestEditorProvider } from '../src/panels/requestPanel';
import {
  createRequestTemplate,
  REQUEST_PROTOCOL_CHOICES,
  requestProtocolLabel,
  slugifyRequestName,
} from '../src/services/requestTemplates';

const schema = require('../schema/opencollectionschema.json');

const schemaByProtocol: Record<RequestProtocol, string> = {
  http: 'HttpRequest',
  graphql: 'GraphQLRequest',
  websocket: 'WebSocketRequest',
  grpc: 'GrpcRequest',
};

const protocolRoots: RequestProtocol[] = ['http', 'graphql', 'websocket', 'grpc'];

function validateSubschema(protocol: RequestProtocol, data: unknown): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const defName = schemaByProtocol[protocol];
  const validate = ajv.compile({
    $schema: schema.$schema,
    $id: `${schema.$id}#test-${defName}`,
    $ref: `${schema.$id}#/$defs/${defName}`,
    $defs: schema.$defs,
  });
  expect(validate(data), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function makeCollection(rootDir: string): MissioCollection {
  return {
    id: path.join(rootDir, 'opencollection.yml'),
    filePath: path.join(rootDir, 'opencollection.yml'),
    rootDir,
    data: {
      opencollection: '1.0.0',
      info: { name: 'Request Type UX Test' },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request type UX templates', () => {
  it('builds schema-valid starter requests for every supported protocol', () => {
    for (const choice of REQUEST_PROTOCOL_CHOICES) {
      const request = createRequestTemplate(choice.protocol, `${choice.label} Example`);
      const yamlRoundTrip = parseYaml(stringifyYaml(request, { lineWidth: 120 }));

      expect((request as any).info).toMatchObject({
        name: `${choice.label} Example`,
        type: choice.protocol,
      });
      expect(protocolRoots.filter(root => Object.prototype.hasOwnProperty.call(request, root))).toEqual([choice.protocol]);
      expect(yamlRoundTrip).toEqual(request);
      validateSubschema(choice.protocol, request);
    }
  });

  it('round-trips created starters through the visual editor model without stale protocol roots', () => {
    for (const choice of REQUEST_PROTOCOL_CHOICES) {
      const request = createRequestTemplate(choice.protocol, `${choice.label} Round Trip`);
      const model = createRequestEditorModelFromRequest(request);
      const updated = applyRequestEditorModel(request, model);

      expect(updated).toEqual(request);
      expect(protocolRoots.filter(root => Object.prototype.hasOwnProperty.call(updated as object, root))).toEqual([choice.protocol]);
      validateSubschema(choice.protocol, updated);
    }
  });

  it('uses stable labels and filesystem-safe slugs for request creation', () => {
    expect(requestProtocolLabel('grpc')).toBe('gRPC');
    expect(slugifyRequestName('Echo unary / metadata')).toBe('echo-unary-metadata');
    expect(slugifyRequestName('***')).toBe('request');
  });
});

describe('new request command protocol selection', () => {
  it('writes a schema-valid gRPC starter selected from the creation picker', async () => {
    const rootDir = path.join(process.cwd(), 'tmp-request-type-ux');
    const handlers = new Map<string, (...args: any[]) => unknown>();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((name: string, callback: (...args: any[]) => unknown) => {
      handlers.set(name, callback);
      return { dispose: () => {} } as any;
    });
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({
      label: 'gRPC',
      description: 'Unary gRPC request with protobuf configuration',
      protocol: 'grpc',
    } as any);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Echo unary / metadata');
    const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined as any);
    const open = vi.spyOn(RequestEditorProvider, 'open').mockResolvedValue(undefined);

    registerRequestCommands({
      collectionService: {
        getCollections: () => [makeCollection(rootDir)],
        loadRequestFile: vi.fn(),
      },
      environmentService: {},
      httpClient: {},
      requestExecutionService: { cancelAll: vi.fn() },
      responseProvider: {},
      collectionTreeProvider: {},
      extensionContext: {},
    } as any);

    const newRequest = handlers.get('missio.newRequest');
    expect(newRequest).toBeDefined();
    await newRequest?.({ collection: { rootDir } });

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: 'HTTP', protocol: 'http' })]),
      { placeHolder: 'Select request type' },
    );
    expect(writeFile).toHaveBeenCalledOnce();
    const [uri, content] = writeFile.mock.calls[0];
    expect(uri.fsPath).toBe(path.join(rootDir, 'echo-unary-metadata.yml'));
    const request = parseYaml(Buffer.from(content as Uint8Array).toString('utf-8'));
    expect(request.info.type).toBe('grpc');
    expect(request.grpc).toMatchObject({
      url: '{{grpcBaseUrl}}',
      methodType: 'unary',
      protoFilePath: 'proto/service.proto',
    });
    expect(request.http).toBeUndefined();
    validateSubschema('grpc', request);
    expect(open).toHaveBeenCalledWith(path.join(rootDir, 'echo-unary-metadata.yml'));
  });
});

describe('request editor protocol identity guard', () => {
  it('allows same-protocol gRPC payloads but rejects protocol switches', () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const current = createRequestTemplate('grpc', 'Echo unary');

    expect((provider as any)._canApplyRequestEdit(current, createRequestTemplate('grpc', 'Echo unary edited'))).toBe(true);
    expect((provider as any)._canApplyRequestEdit(current, createRequestTemplate('http', 'Echo unary'))).toBe(false);
  });

  it('renders a read-only protocol icon inside the request URL field', () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const html = (provider as any)._getBodyHtml({} as any) as string;

    expect(html).toMatch(/<div class="url-wrap" id="urlWrap">[\s\S]*id="protocolIcon"[\s\S]*id="url"/);
    expect(html).toContain('id="protocolIcon"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Request type loading"');
    expect(html).toContain('protocol-icon-pending');
    expect(html).not.toContain('protocol-chip');
    expect(html).not.toContain('id="protocolChip"');
    expect(html).not.toContain('id="requestTypeSwitcher"');
  });

  it('loads packaged PDF.js assets for response previews', () => {
    const provider = new RequestEditorProvider(
      { extensionUri: { fsPath: process.cwd() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const webview = {
      cspSource: 'vscode-webview://missio-test',
      asWebviewUri: (uri: { fsPath: string }) => `webview-resource://${uri.fsPath.replace(/\\/g, '/')}`,
    };

    const html = (provider as any)._getHtml(webview) as string;

    expect(html).toContain('pdf.min.mjs');
    expect(html).toContain('pdf.worker.min.mjs');
    expect(html).toContain('type="module"');
    expect(html).toContain('window.missioPdfJsReady');
    expect(html).toContain('worker-src vscode-webview://missio-test blob:');
    expect(html).not.toContain('media/pdf.js');
    expect(html).not.toContain('media/pdf.worker.js');
  });

  it('defines request protocol colors in centralized theme surfaces', () => {
    const themeCss = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'theme.css'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const contributedColorIds = new Set((pkg.contributes.colors as Array<{ id: string }>).map(color => color.id));

    for (const id of ['Http', 'Graphql', 'Websocket', 'Grpc']) {
      expect(themeCss).toContain(`--m-protocol-${id.toLowerCase()}`);
      expect(themeCss).toContain(`--vscode-missio-protocol${id}`);
      expect(contributedColorIds.has(`missio.protocol${id}`)).toBe(true);
    }
  });

  it('keeps request body formatting actions right aligned when body type pills are hidden', () => {
    const requestPanelCss = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'requestPanel.css'), 'utf8');

    expect(requestPanelCss).toMatch(/\.body-toolbar\s*\{[^}]*justify-content:\s*flex-start;/);
    expect(requestPanelCss).toMatch(/\.body-toolbar-actions\s*\{[^}]*margin-left:\s*auto;/);
  });
});
