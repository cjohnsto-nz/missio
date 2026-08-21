/**
 * Common interface for collection importers.
 * Each importer converts a source format into OpenCollection YAML files on disk.
 */

export interface ImportResult {
  collectionDir: string;
  collectionFile: string;
  requestCount: number;
  folderCount: number;
  environmentCount: number;
  diagnostics?: ImportDiagnostic[];
}

export interface ImportDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  source: string;
  message: string;
  path?: string;
  protocol?: string;
}

export interface CollectionImporter {
  /** Human-readable name shown in the format picker */
  readonly label: string;
  /** Short description shown in the format picker */
  readonly description: string;
  /** File extensions accepted by this importer (without dot) */
  readonly fileExtensions: string[];
  /** Whether this importer supports importing from a URL */
  readonly supportsUrl?: boolean;

  /**
   * Import a collection from the given source file into the target directory.
   * Creates collection.yml + request .yml files on disk.
   */
  import(sourceFile: string, targetDir: string): Promise<ImportResult>;
}
