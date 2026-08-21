/**
 * Text-based request importers.
 * Each importer detects and parses a text format (cURL, raw HTTP, etc.)
 * into an OpenCollection HttpRequest object.
 */

import type { HttpRequest, RequestProtocol } from '../models/types';

export interface RequestTextImporter {
  /** Human-readable format name */
  readonly label: string;
  /** Returns true if the text looks like this format */
  detect(text: string): boolean;
  /** Parse the text into an HttpRequest */
  parse(text: string): HttpRequest;
}

export interface UnsupportedRequestImportDiagnostic {
  code: 'MISSIO_UNSUPPORTED_REQUEST_IMPORT';
  protocol: Exclude<RequestProtocol, 'http'>;
  protocolName: string;
  message: string;
}

import { CurlRequestImporter } from './curlRequestImporter';
import { WgetRequestImporter } from './wgetRequestImporter';
import { HttpRawRequestImporter } from './httpRawRequestImporter';

/** Registry of all text-based request importers. Add new formats here. */
export const requestImporters: RequestTextImporter[] = [
  new CurlRequestImporter(),
  new WgetRequestImporter(),
  new HttpRawRequestImporter(),  // broadest matcher — must be last
];

/**
 * Auto-detect the format of the given text and return the matching importer,
 * or undefined if no importer matches.
 */
export function detectRequestFormat(text: string): RequestTextImporter | undefined {
  return requestImporters.find(imp => imp.detect(text));
}

export function detectUnsupportedRequestFormat(text: string): UnsupportedRequestImportDiagnostic | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (/^(query|mutation|subscription)\b/i.test(trimmed)) {
    return unsupportedImportDiagnostic('graphql', 'GraphQL');
  }
  if (/^(wss?:\/\/|new\s+WebSocket\s*\()/i.test(trimmed)) {
    return unsupportedImportDiagnostic('websocket', 'WebSocket');
  }
  if (/^(grpcurl\b|grpcs?:\/\/)/i.test(trimmed) || /^[A-Za-z_][\w.]*\/[A-Za-z_]\w*$/.test(trimmed)) {
    return unsupportedImportDiagnostic('grpc', 'gRPC');
  }

  return undefined;
}

function unsupportedImportDiagnostic(
  protocol: Exclude<RequestProtocol, 'http'>,
  protocolName: string,
): UnsupportedRequestImportDiagnostic {
  return {
    code: 'MISSIO_UNSUPPORTED_REQUEST_IMPORT',
    protocol,
    protocolName,
    message: `${protocolName} request text import is not implemented. Use "Missio: New Request" to create a ${protocolName} request, then paste the protocol-specific fields into the request file.`,
  };
}
