import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve a file body variant's path and read its contents.
 *
 * Security: absolute paths (from the user's own file picker) are allowed
 * freely. Relative paths are collection-authored and are constrained to the
 * collection root to prevent `../../../` traversal attacks in shared or
 * untrusted collections. `realpath()` is used to resolve symlinks so that
 * a symlink pointing outside the root cannot bypass the traversal guard.
 *
 * @param collectionRoot  The root directory of the containing collection.
 * @param filePath        The raw filePath value from the FileBodyVariant.
 * @returns               The file contents as a Buffer.
 */
export async function resolveFileVariantToBuffer(collectionRoot: string, filePath: string): Promise<Buffer> {
  let absPath: string;
  if (path.isAbsolute(filePath)) {
    absPath = filePath;
  } else {
    const root = path.resolve(collectionRoot);
    absPath = path.resolve(root, filePath);
    // Resolve symlinks before the traversal check so that a symlink pointing
    // outside the collection root cannot bypass the guard.
    const realRoot = await fs.promises.realpath(root).catch(() => root);
    const realAbs = await fs.promises.realpath(absPath).catch(() => absPath);
    const rel = path.relative(realRoot, realAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `Security: relative file path "${filePath}" escapes the collection root. ` +
        `Use an absolute path or keep the file inside the collection folder.`
      );
    }
  }
  return fs.promises.readFile(absPath);
}
