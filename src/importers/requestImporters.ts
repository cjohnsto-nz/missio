/**
 * Text-based request importers.
 * Each importer detects and parses a text format (cURL, raw HTTP, etc.)
 * into an OpenCollection HttpRequest object.
 */

import type { HttpRequest } from '../models/types';

export interface RequestTextImporter {
  /** Human-readable format name */
  readonly label: string;
  /** Returns true if the text looks like this format */
  detect(text: string): boolean;
  /** Parse the text into an HttpRequest */
  parse(text: string): HttpRequest;
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
