import * as vscode from 'vscode';
import type { AuthOAuth2, MissioCollection } from '../models/types';
import type { EnvironmentService } from './environmentService';
import type { OAuth2Service } from './oauth2Service';

/**
 * Shared helper for handling OAuth2 token status/fetch messages from webviews.
 * Eliminates duplication across request, folder, and collection panels.
 */
export async function handleOAuth2TokenMessage(
  webview: vscode.Webview,
  msg: { type: string; auth: AuthOAuth2 },
  collection: MissioCollection,
  environmentService: EnvironmentService,
  oauth2Service: OAuth2Service,
): Promise<void> {
  const auth = msg.auth;
  if (!auth?.accessTokenUrl) return;

  try {
    const variables = await environmentService.resolveVariables(collection);
    const accessTokenUrl = environmentService.interpolate(auth.accessTokenUrl, variables);
    const envName = environmentService.getActiveEnvironmentName(collection.id);

    if (msg.type === 'getTokenStatus') {
      const status = await oauth2Service.getTokenStatus(collection.id, envName, accessTokenUrl, auth.credentialsId);
      webview.postMessage({ type: 'oauth2TokenStatus', status });
    } else if (msg.type === 'getToken') {
      const interpolated: AuthOAuth2 = {
        type: 'oauth2',
        flow: auth.flow,
        accessTokenUrl,
        refreshTokenUrl: auth.refreshTokenUrl ? environmentService.interpolate(auth.refreshTokenUrl, variables) : undefined,
        clientId: auth.clientId ? environmentService.interpolate(auth.clientId, variables) : undefined,
        clientSecret: auth.clientSecret ? environmentService.interpolate(auth.clientSecret, variables) : undefined,
        username: auth.username ? environmentService.interpolate(auth.username, variables) : undefined,
        password: auth.password ? environmentService.interpolate(auth.password, variables) : undefined,
        scope: auth.scope ? environmentService.interpolate(auth.scope, variables) : undefined,
        credentialsPlacement: auth.credentialsPlacement,
        credentialsId: auth.credentialsId,
        autoFetchToken: true,
        autoRefreshToken: auth.autoRefreshToken,
      };
      webview.postMessage({ type: 'oauth2Progress', message: 'Acquiring token...' });
      await oauth2Service.getToken(interpolated, collection.id, envName);
      const status = await oauth2Service.getTokenStatus(collection.id, envName, accessTokenUrl, auth.credentialsId);
      webview.postMessage({ type: 'oauth2TokenStatus', status });
      webview.postMessage({ type: 'oauth2Progress', message: '' });
    }
  } catch (e: any) {
    webview.postMessage({ type: 'oauth2Progress', message: `Error: ${e.message}` });
  }
}
