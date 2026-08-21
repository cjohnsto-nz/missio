import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';
import { getItemKind } from '../../models/types';

export interface GetRequestParams {
  requestFilePath: string;
}

export class GetRequestTool extends ToolBase<GetRequestParams> {
  public readonly toolName = 'missio_get_request';

  constructor(private _collectionService: CollectionService) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<GetRequestParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { requestFilePath } = options.input;
    const request = await this._collectionService.loadRequestFile(requestFilePath);
    if (!request) {
      return JSON.stringify({ success: false, message: `Failed to load request: ${requestFilePath}` });
    }
    const protocol = getItemKind(request);
    return JSON.stringify({
      success: true,
      protocol,
      requestFilePath,
      request: redactRequestForTool(request),
    });
  }
}

function redactRequestForTool<T>(request: T): T {
  const cloned = request === undefined ? request : JSON.parse(JSON.stringify(request));
  const requestData = cloned as any;
  redactAuth(requestData?.runtime?.auth);
  redactHeaders(requestData?.http?.headers);
  redactHeaders(requestData?.graphql?.headers);
  redactHeaders(requestData?.websocket?.headers);
  redactHeaders(requestData?.grpc?.metadata);
  redactExamples(requestData?.examples);
  return cloned;
}

function redactAuth(auth: any): void {
  if (!auth || auth === 'inherit' || typeof auth !== 'object') return;

  for (const key of ['password', 'token', 'value', 'clientSecret', 'accessToken', 'refreshToken', 'secretAccessKey', 'sessionToken']) {
    if (typeof auth[key] === 'string' && auth[key] !== '') {
      auth[key] = '[redacted]';
    }
  }

  if (auth.credentials && typeof auth.credentials === 'object') {
    for (const key of ['clientSecret']) {
      if (typeof auth.credentials[key] === 'string' && auth.credentials[key] !== '') {
        auth.credentials[key] = '[redacted]';
      }
    }
  }

  if (auth.resourceOwner && typeof auth.resourceOwner === 'object' && typeof auth.resourceOwner.password === 'string' && auth.resourceOwner.password !== '') {
    auth.resourceOwner.password = '[redacted]';
  }

  if (auth.type === 'cli' && typeof auth.command === 'string' && auth.command !== '') {
    auth.command = '[redacted]';
  }

  for (const entries of Object.values(auth.additionalParameters ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && isSensitiveName((entry as any).name) && typeof (entry as any).value === 'string' && (entry as any).value !== '') {
        (entry as any).value = '[redacted]';
      }
    }
  }
}

function redactExamples(examples: any): void {
  if (!Array.isArray(examples)) return;

  for (const example of examples) {
    redactHeaders(example?.request?.headers);
    redactHeaders(example?.response?.headers);
    redactJsonBody(example?.request?.body);
    redactJsonBody(example?.response?.body);
  }
}

function redactHeaders(headers: any): void {
  if (!Array.isArray(headers)) return;

  for (const header of headers) {
    if (!header || typeof header.name !== 'string' || typeof header.value !== 'string' || header.value === '') continue;
    if (!isSensitiveName(header.name)) continue;

    const lowerName = header.name.trim().toLowerCase();
    const scheme = lowerName === 'authorization' || lowerName === 'proxy-authorization'
      ? header.value.match(/^([A-Za-z]+)\s+/)?.[1]
      : undefined;
    header.value = scheme ? `${scheme} [redacted]` : '[redacted]';
  }
}

function redactJsonBody(body: any): void {
  if (body?.type !== 'json' || typeof body.data !== 'string' || body.data === '') return;

  try {
    const parsed = JSON.parse(body.data);
    redactSensitiveObjectValues(parsed);
    body.data = JSON.stringify(parsed);
  } catch {
    // Preserve non-JSON data even when its declared body type is stale.
  }
}

function redactSensitiveObjectValues(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(redactSensitiveObjectValues);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveName(key) && (typeof nested === 'string' || typeof nested === 'number')) {
      (value as Record<string, unknown>)[key] = '[redacted]';
    } else {
      redactSensitiveObjectValues(nested);
    }
  }
}

function isSensitiveName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase().replace(/[-_\s]/g, '');
  return normalized === 'authorization'
    || normalized === 'proxyauthorization'
    || normalized === 'cookie'
    || normalized === 'setcookie'
    || normalized.includes('apikey')
    || normalized.includes('auth')
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password');
}
