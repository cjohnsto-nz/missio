import * as vscode from 'vscode';
import type { AuthOAuth2, MissioCollection } from '../models/types';
import type { EnvironmentService } from './environmentService';
import type { OAuth2Service } from './oauth2Service';
import type { SecretService } from './secretService';

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
  secretService?: SecretService,
): Promise<void> {
  const auth = msg.auth;
  if (!auth?.accessTokenUrl) return;

  try {
    const variables = await environmentService.resolveVariables(collection);
    let accessTokenUrl = environmentService.interpolate(auth.accessTokenUrl, variables);
    const providers = collection.data.config?.secretProviders ?? [];
    if (secretService && providers.length > 0) {
      accessTokenUrl = await secretService.resolveSecretReferences(accessTokenUrl, providers, variables);
    }
    const envName = environmentService.getActiveEnvironmentName(collection.id);

    if (msg.type === 'getTokenStatus') {
      const status = await oauth2Service.getTokenStatus(collection.id, envName, accessTokenUrl, auth.credentialsId);
      webview.postMessage({ type: 'oauth2TokenStatus', status });
    } else if (msg.type === 'deleteToken') {
      await oauth2Service.clearToken(collection.id, envName, accessTokenUrl, auth.credentialsId);
      const status = await oauth2Service.getTokenStatus(collection.id, envName, accessTokenUrl, auth.credentialsId);
      webview.postMessage({ type: 'oauth2TokenStatus', status });
    } else if (msg.type === 'getToken') {
      // Clear existing token first so we always fetch fresh
      await oauth2Service.clearToken(collection.id, envName, accessTokenUrl, auth.credentialsId);
      const resolve = async (val: string | undefined): Promise<string | undefined> => {
        if (!val) return undefined;
        let result = environmentService.interpolate(val, variables);
        if (secretService && providers.length > 0) {
          result = await secretService.resolveSecretReferences(result, providers, variables);
        }
        return result;
      };
      const creds = auth.credentials;
      const interpolatedCreds = creds ? {
        clientId: await resolve(creds.clientId),
        clientSecret: await resolve(creds.clientSecret),
        placement: creds.placement,
      } : undefined;

      const base: any = {
        type: 'oauth2',
        flow: auth.flow,
        accessTokenUrl,
        refreshTokenUrl: await resolve(auth.refreshTokenUrl),
        scope: await resolve(auth.scope),
        credentials: interpolatedCreds,
        settings: { ...auth.settings, autoFetchToken: true },
        credentialsId: auth.credentialsId,
      };

      // Flow-specific fields
      if (auth.flow === 'resource_owner_password_credentials') {
        const owner = (auth as import('../models/types').AuthOAuth2ResourceOwnerPassword).resourceOwner;
        if (owner) {
          base.resourceOwner = {
            username: await resolve(owner.username),
            password: await resolve(owner.password),
          };
        }
      } else if (auth.flow === 'authorization_code') {
        const ac = auth as import('../models/types').AuthOAuth2AuthorizationCode;
        base.authorizationUrl = await resolve(ac.authorizationUrl);
        base.callbackUrl = ac.callbackUrl;
        base.pkce = ac.pkce;
      }

      const interpolated: AuthOAuth2 = base;
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
