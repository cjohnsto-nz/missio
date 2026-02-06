export type { CollectionImporter, ImportResult } from './types';
export { PostmanImporter } from './postmanImporter';

import type { CollectionImporter } from './types';
import { PostmanImporter } from './postmanImporter';

/** Registry of all available importers. Add new formats here. */
export const importers: CollectionImporter[] = [
  new PostmanImporter(),
];
