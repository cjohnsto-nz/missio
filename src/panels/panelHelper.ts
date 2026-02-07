import * as vscode from 'vscode';
import type { MissioCollection, RequestDefaults } from '../models/types';
import type { EnvironmentService } from '../services/environmentService';
import type { SecretService } from '../services/secretService';

export interface VariablesMessagePayload {
  type: 'variablesResolved';
  variables: Record<string, string>;
  sources: Record<string, string>;
  secretProviderNames: string[];
  secretNames: Record<string, string[]>;
}

/**
 * Build the variablesResolved message payload for a collection.
 * Shared by all three panel types.
 */
export function buildVariablesPayload(
  varsWithSource: Map<string, { value: string; source: string }>,
  collection: MissioCollection,
  secretService: SecretService,
): VariablesMessagePayload {
  const variables: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [k, v] of varsWithSource) {
    variables[k] = v.value;
    sources[k] = v.source;
  }

  const enabledProviders = (collection.data.config?.secretProviders ?? [])
    .filter((p: any) => !p.disabled);
  const secretProviderNames = enabledProviders.map((p: any) => p.name as string);

  const secretNames: Record<string, string[]> = {};
  for (const p of enabledProviders) {
    const cached = secretService.getCachedSecretNames(p.name);
    if (cached.length > 0) {
      secretNames[p.name] = cached;
    }
  }

  return { type: 'variablesResolved', variables, sources, secretProviderNames, secretNames };
}

/**
 * Send resolved variables to a webview, then prefetch secret names in the background.
 * If new secret names are discovered, calls `resend` to push an updated payload.
 */
export async function sendVariablesAndPrefetch(
  webview: vscode.Webview,
  collection: MissioCollection,
  environmentService: EnvironmentService,
  secretService: SecretService,
  folderDefaults?: RequestDefaults,
  resend?: () => void,
): Promise<void> {
  const varsWithSource = await environmentService.resolveVariablesWithSource(collection, folderDefaults);
  const payload = buildVariablesPayload(varsWithSource, collection, secretService);
  webview.postMessage(payload);

  // Prefetch secret names in background
  const enabledProviders = (collection.data.config?.secretProviders ?? [])
    .filter((p: any) => !p.disabled);
  if (enabledProviders.length === 0) return;

  const variables = await environmentService.resolveVariables(collection, folderDefaults);
  const snapshotBefore = { ...payload.secretNames };

  await secretService.prefetchSecretNames(enabledProviders, variables);

  // Check if we got new names
  let hasNew = false;
  for (const p of enabledProviders) {
    const fresh = secretService.getCachedSecretNames(p.name);
    const before = snapshotBefore[p.name];
    if (fresh.length > 0 && !before) { hasNew = true; break; }
    if (fresh.length !== (before?.length ?? 0)) { hasNew = true; break; }
  }
  if (hasNew && resend) { resend(); }
}
