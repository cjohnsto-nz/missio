import type { Auth } from '../models/types';

/**
 * Resolve request/folder/collection auth inheritance.
 * If request auth is "inherit" and folder auth is missing, continue to collection auth.
 */
export function resolveInheritedAuth(
  requestAuth: Auth | undefined,
  folderAuth: Auth | undefined,
  collectionAuth: Auth | undefined,
): Auth | undefined {
  let auth = requestAuth;
  if (auth === 'inherit') auth = folderAuth ?? 'inherit';
  if (auth === 'inherit') auth = collectionAuth;
  return auth;
}

