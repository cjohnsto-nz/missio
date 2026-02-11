export type { CollectionImporter, ImportResult } from './types';
export { PostmanImporter } from './postmanImporter';
export type { RequestTextImporter } from './requestImporters';
export { requestImporters, detectRequestFormat } from './requestImporters';
export { CurlRequestImporter } from './curlRequestImporter';
export { WgetRequestImporter } from './wgetRequestImporter';
export { HttpRawRequestImporter } from './httpRawRequestImporter';

import type { CollectionImporter } from './types';
import { PostmanImporter } from './postmanImporter';

/** Registry of all available importers. Add new formats here. */
export const importers: CollectionImporter[] = [
  new PostmanImporter(),
];
