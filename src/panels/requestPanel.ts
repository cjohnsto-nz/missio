import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { HttpRequest, RequestDefaults, MissioCollection } from '../models/types';
import { type HttpClient, requestLog, type ResolvedRequest } from '../services/httpClient';
import { exportRequest, findTarget, EXPORT_TARGETS } from '../services/snippetExporter';
import { resolveFileVariantToBuffer } from '../services/fileBodyHelper';
import type { CollectionService } from '../services/collectionService';
import type { EnvironmentService } from '../services/environmentService';
import type { OAuth2Service } from '../services/oauth2Service';
import type { SecretService } from '../services/secretService';
import { readFolderFile } from '../services/yamlParser';
import { detectUnresolvedVars } from '../services/unresolvedVars';
import { migrateRequest } from '../services/migrations';
import { BaseEditorProvider, type EditorContext } from './basePanel';

/**
 * CustomTextEditorProvider for OpenCollection request YAML files.
 * Uses the native TextDocument as the source of truth, giving us:
 * - Native dirty indicator (dot replacing X on tab)
 * - Native "unsaved changes" close warning
 * - Native Ctrl+S save
 * - Undo/redo support
 * - Proper restore on window reload
 */
export class RequestEditorProvider extends BaseEditorProvider {
  public static readonly viewType = 'missio.requestEditor';
  private static _panels = new Map<string, vscode.WebviewPanel>();
  private readonly _httpClient: HttpClient;
  // Pending resolver for the webview-based unresolved-vars prompt
  private _unresolvedVarsResolver: ((result: Map<string, string> | undefined) => void) | null = null;
  // Pending resolver for CLI auth approval prompt
  private _cliApprovalResolver: ((approved: boolean) => void) | null = null;
  // Generation counter for export preview — newer request supersedes older ones
  private _exportSeq = 0;
  // Cache of folder defaults per file path (avoids async disk reads during export)
  private static _folderDefaultsCache = new Map<string, RequestDefaults | undefined>();
  // Cache of collection per file path (avoids missed lookups during refresh cycles)
  private static _collectionCache = new Map<string, MissioCollection>();

  static postMessageToPanel(filePath: string, message: any): boolean {
    const panel = RequestEditorProvider._panels.get(filePath.toLowerCase());
    if (panel) {
      panel.webview.postMessage(message);
      return true;
    }
    return false;
  }

  constructor(
    context: vscode.ExtensionContext,
    httpClient: HttpClient,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
    oauth2Service: OAuth2Service,
    secretService: SecretService,
  ) {
    super(context, collectionService, environmentService, oauth2Service, secretService);
    this._httpClient = httpClient;
  }

  static register(
    context: vscode.ExtensionContext,
    httpClient: HttpClient,
    collectionService: CollectionService,
    environmentService: EnvironmentService,
    oauth2Service: OAuth2Service,
    secretService: SecretService,
  ): vscode.Disposable {
    const provider = new RequestEditorProvider(context, httpClient, collectionService, environmentService, oauth2Service, secretService);
    const registration = vscode.window.registerCustomEditorProvider(
      RequestEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
    return vscode.Disposable.from(registration, provider);
  }

  /**
   * Open a request file in the custom editor.
   */
  static async open(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('vscode.openWith', uri, RequestEditorProvider.viewType);
  }

  // ── BaseEditorProvider implementation ──

  protected _findCollection(filePath: string): MissioCollection | undefined {
    const normalized = filePath.replace(/\\/g, '/');
    return this._collectionService.getCollections().find(c => {
      const root = c.rootDir.replace(/\\/g, '/');
      return normalized.startsWith(root + '/') || normalized === root;
    });
  }

  protected _sendDocumentToWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
    try {
      const request = parseYaml(document.getText()) as HttpRequest;
      migrateRequest(request);
      webview.postMessage({ type: 'requestLoaded', request, filePath: document.uri.fsPath });
    } catch { /* Invalid YAML, don't update webview */ }
  }

  protected _getDocumentDataKey(): string { return 'request'; }
  protected _getScriptFilename(): string { return 'requestPanel.js'; }
  protected _getCssFilenames(): string[] { return ['requestPanel.css']; }

  protected _getHtml(webview: vscode.Webview): string {
    const html = super._getHtml(webview);
    // Inject PDF.js scripts before the closing </body> tag
    const pdfJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'pdf.js'));
    const pdfWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'pdf.worker.js'));
    const nonce = html.match(/nonce="([^"]+)"/)?.[1] ?? '';
    const pdfScripts = `<script nonce="${nonce}" src="${pdfJsUri}"></script>\n<script nonce="${nonce}" src="${pdfWorkerUri}"></script>\n<script nonce="${nonce}">if(typeof pdfjsLib!=='undefined')pdfjsLib.GlobalWorkerOptions.workerSrc='${pdfWorkerUri}';</script>`;
    return html
      .replace('</body>', pdfScripts + '\n</body>')
      .replace(/img-src data:/, 'img-src blob: data:');
  }

  protected _onPanelCreated(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _disposables: vscode.Disposable[],
  ): void {
    const fp = document.uri.fsPath;
    const key = fp.toLowerCase();
    RequestEditorProvider._panels.set(key, webviewPanel);
    // Eagerly cache collection + folder defaults so export can read them synchronously
    const refreshCache = () => {
      const col = this._findCollection(fp);
      if (col) {
        RequestEditorProvider._collectionCache.set(key, col);
        this._getFolderDefaults(fp, col).then(fd => {
          RequestEditorProvider._folderDefaultsCache.set(key, fd);
        }).catch(() => {});
      }
    };
    refreshCache();
    // Re-populate caches when collection/folder config changes on disk
    _disposables.push(this._collectionService.onDidChange(() => refreshCache()));
  }

  protected _onPanelDisposed(document: vscode.TextDocument): void {
    this._resolvePendingPromptsOnClose();
    const key = document.uri.fsPath.toLowerCase();
    RequestEditorProvider._panels.delete(key);
    RequestEditorProvider._folderDefaultsCache.delete(key);
    RequestEditorProvider._collectionCache.delete(key);
  }

  protected async _getFolderDefaults(filePath: string, collection: MissioCollection): Promise<RequestDefaults | undefined> {
    const dir = path.dirname(filePath);
    if (dir.toLowerCase() === collection.rootDir.toLowerCase()) return undefined;
    for (const name of ['folder.yml', 'folder.yaml']) {
      try {
        const folderData = await readFolderFile(path.join(dir, name));
        if (folderData?.request) return folderData.request;
        break;
      } catch { /* No folder.yml */ }
    }
    return undefined;
  }

  protected async _onMessage(
    webview: vscode.Webview,
    msg: any,
    ctx: EditorContext,
  ): Promise<boolean> {
    const filePath = ctx.document.uri.fsPath;
    switch (msg.type) {
      case 'saveDocument': {
        await ctx.applyEdit(msg.request);
        await ctx.document.save();
        webview.postMessage({ type: 'saved' });
        return true;
      }
      case 'sendRequest': {
        const collection = this._findCollection(filePath);
        if (!collection) {
          webview.postMessage({ type: 'error', message: 'Collection not found' });
          return true;
        }
        const folderDefaults = await this._getFolderDefaults(filePath, collection);
        await this._sendRequest(webview, msg.request, collection, folderDefaults);
        return true;
      }
      case 'cancelRequest': {
        this._resolvePendingPromptsOnClose();
        this._httpClient.cancelAll();
        return true;
      }
      case 'editVariable':
        // Handled by addVariable in basePanel — kept for backwards compat
        return true;
      case 'resolveVariables': {
        await this._sendVariables(webview, filePath);
        return true;
      }
      case 'methodChanged':
        return true;
      case 'saveBinaryResponse': {
        await this._saveBinaryResponse(msg.bodyBase64, msg.contentType);
        return true;
      }
      case 'openInBrowser': {
        await this._openInBrowser(msg.bodyBase64, msg.contentType);
        return true;
      }
      case 'chooseFile': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Select Binary File',
        });
        if (uris && uris[0]) {
          const chosen = uris[0].fsPath;
          const ext = path.extname(chosen).toLowerCase().replace(/^\./, '');
          const extToMime: Record<string, string> = {
            // Images
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
            webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
            svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
            // Text
            txt: 'text/plain', html: 'text/html', htm: 'text/html',
            css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
            md: 'text/markdown', csv: 'text/csv',
            // Data/structured
            json: 'application/json', xml: 'application/xml',
            yaml: 'application/yaml', yml: 'application/yaml',
            // Documents
            pdf: 'application/pdf',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            // Archives
            zip: 'application/zip', gz: 'application/gzip',
            tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
            // Media
            mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo',
            mov: 'video/quicktime', mp3: 'audio/mpeg',
            wav: 'audio/wav', ogg: 'audio/ogg',
          };
          const contentType = extToMime[ext] ?? 'application/octet-stream';
          webview.postMessage({ type: 'fileChosen', filePath: chosen, contentType });
        }
        return true;
      }
      case 'refreshOAuthAndRetry': {
        const collection = this._findCollection(filePath);
        if (!collection) {
          webview.postMessage({ type: 'error', message: 'Collection not found' });
          return true;
        }
        const folderDefaults = await this._getFolderDefaults(filePath, collection);
        // Clear the existing OAuth2 token before retrying
        let effectiveAuth;
        if (collection.data.config?.forceAuthInherit) {
          effectiveAuth = collection.data.request?.auth;
        } else {
          effectiveAuth = msg.request?.runtime?.auth;
          if (effectiveAuth === 'inherit') effectiveAuth = folderDefaults?.auth ?? 'inherit';
          if (effectiveAuth === 'inherit') effectiveAuth = collection.data.request?.auth;
        }
        if (effectiveAuth && effectiveAuth !== 'inherit' && (effectiveAuth as any).type === 'oauth2') {
          const auth = effectiveAuth as any;
          if (auth.accessTokenUrl) {
            const variables = await this._environmentService.resolveVariables(collection);
            const url = this._environmentService.interpolate(auth.accessTokenUrl, variables);
            const envName = this._environmentService.getActiveEnvironmentName(collection.id);
            await this._oauth2Service.clearToken(collection.id, envName, url, auth.credentialsId);
          }
        }
        await this._sendRequest(webview, msg.request, collection, folderDefaults);
        return true;
      }
      case 'saveExample': {
        await this._saveExample(webview, msg, ctx);
        return true;
      }
      case 'exportRequest': {
        const seq = msg.seq as number | undefined;
        if (seq !== undefined) this._exportSeq = seq;
        try {
          const cacheKey = filePath.toLowerCase();
          // Use cached collection (falls back to live lookup)
          const collection = RequestEditorProvider._collectionCache.get(cacheKey) ?? this._findCollection(filePath);
          if (!collection) {
            webview.postMessage({ type: 'exportPreview', content: 'Error: Collection not found', format: msg.format ?? '', lang: '', seq });
            return true;
          }
          // Keep cache fresh
          RequestEditorProvider._collectionCache.set(cacheKey, collection);
          // Use cached folder defaults (populated on panel open) to avoid async disk reads.
          // Falls back to async read if cache miss.
          let folderDefaults = RequestEditorProvider._folderDefaultsCache.get(cacheKey);
          if (!RequestEditorProvider._folderDefaultsCache.has(cacheKey)) {
            folderDefaults = await this._getFolderDefaults(filePath, collection);
            RequestEditorProvider._folderDefaultsCache.set(cacheKey, folderDefaults);
            if (seq !== undefined && seq !== this._exportSeq) return true;
          }
          await this._exportRequest(webview, msg.request, collection, folderDefaults, {
            format: msg.format ?? 'shell:curl',
            includeAuth: !!msg.includeAuth,
            includeHeaders: msg.includeHeaders !== false,
            includeBody: msg.includeBody !== false,
            resolveVariables: msg.resolveVariables !== false,
            action: msg.action ?? 'preview',
            seq,
          });
        } catch (e: any) {
          webview.postMessage({ type: 'exportPreview', content: `Error: ${e?.message ?? e}`, format: msg.format ?? '', lang: '', seq });
        }
        return true;
      }
      case 'unresolvedVarsResponse': {
        if (this._unresolvedVarsResolver) {
          if (msg.cancelled) {
            this._unresolvedVarsResolver(undefined);
          } else {
            const map = new Map<string, string>();
            for (const [k, v] of Object.entries(msg.values as Record<string, string>)) {
              map.set(k, v);
            }
            this._unresolvedVarsResolver(map);
          }
          this._unresolvedVarsResolver = null;
        }
        return true;
      }
      case 'cliApprovalResponse': {
        if (this._cliApprovalResolver) {
          this._cliApprovalResolver(!!msg.approved);
          this._cliApprovalResolver = null;
        }
        return true;
      }
    }
    return false;
  }

  // ── Request-specific logic ──


  private _resolvePendingPromptsOnClose(): void {
    if (this._unresolvedVarsResolver) {
      this._unresolvedVarsResolver(undefined);
      this._unresolvedVarsResolver = null;
    }
    if (this._cliApprovalResolver) {
      this._cliApprovalResolver(false);
      this._cliApprovalResolver = null;
    }
  }


  private async _sendRequest(webview: vscode.Webview, requestData: HttpRequest, collection: MissioCollection, folderDefaults?: RequestDefaults): Promise<void> {
    const _rlog = (msg: string) => {
      const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
      requestLog.appendLine(`[${ts}] ${msg}`);
    };

    const _buildErrorResponse = (e: any, durationMs: number) => {
      const errCode = typeof e?.code === 'string' ? e.code : undefined;
      const errName = typeof e?.name === 'string' ? e.name : undefined;
      const errMessage = typeof e?.message === 'string' ? e.message : String(e);

      const _hintForCode = (code: string | undefined): string | undefined => {
        if (!code) return undefined;
        const hints: Record<string, string> = {
          ENOTFOUND: 'DNS lookup failed (host not found). Check the hostname and your network/VPN.',
          ECONNREFUSED: 'Connection refused. The host is reachable but nothing is listening on the target port.',
          ETIMEDOUT: 'Connection timed out. The host may be down, blocked by firewall, or too slow to respond.',
          EAI_AGAIN: 'DNS lookup temporarily failed (EAI_AGAIN). Try again, or check DNS/VPN/network connectivity.',
          ECONNRESET: 'Connection was reset by the peer. This can be caused by proxies, TLS issues, or server-side resets.',
          EHOSTUNREACH: 'Host unreachable. A routing/firewall/VPN issue is preventing reaching the host.',
          ENETUNREACH: 'Network unreachable. Check your network connection, VPN, or routing.',
        };
        return hints[code];
      };

      const statusText = errCode ?? errName ?? 'Error';

      const headers: Record<string, string> = {
        'x-missio-error': 'true',
        'x-missio-error-message': errMessage,
      };
      if (errCode) headers['x-missio-error-code'] = errCode;
      if (errName) headers['x-missio-error-name'] = errName;
      if (typeof e?.syscall === 'string') headers['x-missio-error-syscall'] = e.syscall;
      if (typeof e?.hostname === 'string') headers['x-missio-error-hostname'] = e.hostname;
      if (typeof e?.address === 'string') headers['x-missio-error-address'] = e.address;
      if (typeof e?.port === 'number') headers['x-missio-error-port'] = String(e.port);

      const details = {
        message: errMessage,
        code: errCode,
        name: errName,
        syscall: e?.syscall,
        hostname: e?.hostname,
        address: e?.address,
        port: e?.port,
        stack: typeof e?.stack === 'string' ? e.stack : undefined,
      };

      const body = JSON.stringify({
        error: details,
        hint: _hintForCode(errCode),
      }, null, 2);

      return {
        status: 0,
        statusText,
        headers,
        body,
        duration: durationMs,
        size: Buffer.byteLength(body, 'utf-8'),
      };
    };

    // Detect unresolved variables and prompt via webview modal
    const unresolved = await detectUnresolvedVars(requestData, collection, this._environmentService, folderDefaults);
    let extraVariables: Map<string, string> | undefined = new Map();
    if (unresolved.length > 0) {
      webview.postMessage({ type: 'promptUnresolvedVars', variables: unresolved });
      extraVariables = await new Promise<Map<string, string> | undefined>(resolve => {
        this._unresolvedVarsResolver = resolve;
      });
    }
    if (extraVariables === undefined) {
      webview.postMessage({ type: 'cancelled' });
      return;
    }

    // Determine effective auth for progress reporting
    let effectiveAuth;
    if (collection.data.config?.forceAuthInherit) {
      effectiveAuth = collection.data.request?.auth;
    } else {
      effectiveAuth = requestData.runtime?.auth;
      if (effectiveAuth === 'inherit') effectiveAuth = folderDefaults?.auth ?? 'inherit';
      if (effectiveAuth === 'inherit') effectiveAuth = collection.data.request?.auth;
    }
    const isOAuth2 = effectiveAuth && effectiveAuth !== 'inherit' && (effectiveAuth as any).type === 'oauth2';
    const isCli = effectiveAuth && effectiveAuth !== 'inherit' && (effectiveAuth as any).type === 'cli';

    // CLI approval prompt callback - resets timer after approval
    let _t0 = Date.now();
    const cliApprovalPrompt = async (commandTemplate: string, interpolatedCommand: string): Promise<boolean> => {
      webview.postMessage({ type: 'promptCliApproval', commandTemplate, interpolatedCommand });
      const approved = await new Promise<boolean>(resolve => {
        this._cliApprovalResolver = resolve;
      });
      // Reset timer after approval dialog so dialog time isn't counted
      _t0 = Date.now();
      return approved;
    };

    _rlog(`── _sendRequest start ──`);

    if (isOAuth2) {
      webview.postMessage({ type: 'sending', message: 'Acquiring OAuth2 token…' });
    } else if (isCli) {
      webview.postMessage({ type: 'sending', message: 'CLI auth…' });
    } else {
      webview.postMessage({ type: 'sending' });
    }

    try {
      // httpClient.send handles the full pipeline: variable resolution, auth
      // (including OAuth2 with $secret references), headers, body, and secrets.
      const response = await this._httpClient.send(requestData, collection, folderDefaults, (msg) => {
        webview.postMessage({ type: 'sending', message: msg });
      }, extraVariables.size > 0 ? extraVariables : undefined, undefined, cliApprovalPrompt);

      const disableRendering = vscode.workspace.getConfiguration('missio').get<boolean>('disableResponseRendering', false);
      if (disableRendering) {
        const size = (response as any).size ?? 0;
        (response as any).body = `Response downloaded: ${size} bytes (rendering disabled)`;
        delete (response as any).bodyBase64;
      }

      const totalMs = Date.now() - _t0;
      _rlog(`  httpClient.send done: ${totalMs}ms`);
      const timing = (response as any).timing ?? [];
      webview.postMessage({ type: 'response', response, timing, usedOAuth2: !!isOAuth2 });
    } catch (e: any) {
      if (e.message === 'Request cancelled') {
        webview.postMessage({ type: 'cancelled' });
        return;
      } else {
        const durationMs = Date.now() - _t0;
        webview.postMessage({
          type: 'response',
          response: _buildErrorResponse(e, durationMs),
        });
      }
    }
  }

  private async _exportRequest(
    webview: vscode.Webview,
    requestData: HttpRequest,
    collection: MissioCollection,
    folderDefaults: RequestDefaults | undefined,
    opts: { format: string; includeAuth: boolean; includeHeaders: boolean; includeBody: boolean; resolveVariables: boolean; action: string; seq?: number },
  ): Promise<void> {
    try {
      let resolved: ResolvedRequest;

      // Resolve effective auth for CLI placeholder detection (shared by both branches)
      let effectiveAuth = requestData.runtime?.auth;
      if (!effectiveAuth || effectiveAuth === 'inherit') effectiveAuth = folderDefaults?.auth;
      if (!effectiveAuth || effectiveAuth === 'inherit') effectiveAuth = collection.data.request?.auth;
      if (collection.data.config?.forceAuthInherit) {
        effectiveAuth = collection.data.request?.auth ?? effectiveAuth;
      }
      const isCliAuth = opts.includeAuth && effectiveAuth && effectiveAuth !== 'inherit' && (effectiveAuth as any).type === 'cli';

      if (opts.resolveVariables) {
        // For export, don't prompt for unresolved variables — just leave them as {{template}} syntax.
        resolved = await this._httpClient.buildResolvedRequest(
          requestData, collection, folderDefaults, new Map(),
          undefined, undefined, { includeAuth: isCliAuth ? false : opts.includeAuth, includeBody: opts.includeBody },
        );

        // If a newer export request arrived while we were resolving, bail out
        if (opts.seq !== undefined && opts.seq !== this._exportSeq) return;
      } else {
        // Build without variable resolution — use raw template values
        const details = requestData.http;
        const headers: Record<string, string> = {};
        if (opts.includeHeaders) {
          // Inherit: collection → folder → request (each layer overrides)
          for (const h of (collection.data.request?.headers ?? [])) {
            if (!h.disabled) headers[h.name] = h.value;
          }
          if (folderDefaults?.headers) {
            for (const h of folderDefaults.headers) {
              if (!h.disabled) headers[h.name] = h.value;
            }
          }
          for (const h of (details?.headers ?? [])) {
            if (!h.disabled) headers[h.name] = h.value;
          }
        }
        const bodyDef = Array.isArray(details?.body)
          ? details.body.find(v => v.selected)?.body
          : details?.body;
        let rawBody: string | Buffer | undefined;
        if (bodyDef?.type === 'json' || bodyDef?.type === 'text' || bodyDef?.type === 'xml' || bodyDef?.type === 'sparql') {
          rawBody = bodyDef.data; // RawBody — data is already a string
        } else if (bodyDef?.type === 'form-urlencoded') {
          rawBody = bodyDef.data
            .filter(e => !e.disabled)
            .map(e => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`)
            .join('&');
        } else if (bodyDef?.type === 'file') {
          if (opts.includeBody) {
            const variant = bodyDef.data.find(v => v.selected);
            if (variant?.filePath && !variant.filePath.includes('{{')) {
              rawBody = await resolveFileVariantToBuffer(collection.rootDir, variant.filePath);
              const ct = variant.contentType || 'application/octet-stream';
              const hasContentType = Object.keys(headers).some(h => h.toLowerCase() === 'content-type');
              if (!hasContentType) { headers['Content-Type'] = ct; }
            }
          }
        }
        // multipart-form bodies cannot be serialized without resolving
        resolved = {
          method: (details?.method ?? 'GET').toUpperCase(),
          url: details?.url ?? '',
          headers,
          body: rawBody,
        };
      }

      // Inject CLI auth placeholder (applies to both resolved and unresolved paths)
      if (isCliAuth) {
        const cliAuth = effectiveAuth as import('../models/types').AuthCli;
        const headerName = cliAuth.tokenHeader || 'Authorization';
        const prefix = cliAuth.tokenPrefix !== undefined ? cliAuth.tokenPrefix : 'Bearer';
        resolved.headers[headerName] = prefix ? `${prefix} {{cli_token}}` : '{{cli_token}}';
      }

      if (!opts.includeHeaders) {
        resolved = { ...resolved, headers: {} };
      }

      if (!opts.includeBody) {
        resolved = { ...resolved, body: undefined };
      }

      const output = exportRequest(resolved, opts.format);
      const target = findTarget(opts.format);
      const lang = target?.lang ?? '';
      const ext = target?.ext ?? 'txt';

      if (opts.action === 'copy') {
        await vscode.env.clipboard.writeText(output);
        vscode.window.showInformationMessage('Copied to clipboard');
        webview.postMessage({ type: 'exportComplete', action: 'copy' });
      } else if (opts.action === 'save') {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`request.${ext}`),
          filters: { [ext.toUpperCase()]: [ext], 'All Files': ['*'] },
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(output, 'utf-8'));
          vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
        }
        webview.postMessage({ type: 'exportComplete', action: 'save' });
      } else {
        // Preview — send content back to webview
        webview.postMessage({ type: 'exportPreview', content: output, format: opts.format, lang, seq: opts.seq });
      }
    } catch (e: any) {
      webview.postMessage({ type: 'exportPreview', content: `Error: ${e.message ?? e}`, format: opts.format, lang: '', seq: opts.seq });
    }
  }

  private async _saveExample(webview: vscode.Webview, msg: any, ctx: EditorContext): Promise<void> {
    const exampleName = await vscode.window.showInputBox({
      prompt: 'Name for this example',
      value: `Example ${msg.response.status}`,
    });
    if (!exampleName) return;

    try {
      const current = parseYaml(ctx.document.getText()) as any;
      if (!current.examples) current.examples = [];

      const respHeaders: any[] = [];
      if (msg.response.headers) {
        for (const [k, v] of Object.entries(msg.response.headers)) {
          respHeaders.push({ name: k, value: String(v) });
        }
      }

      const ct = (msg.response.headers?.['content-type'] ?? '') as string;
      let bodyType = 'text';
      if (ct.includes('json')) bodyType = 'json';
      else if (ct.includes('xml')) bodyType = 'xml';
      else if (ct.includes('html')) bodyType = 'html';

      current.examples.push({
        name: exampleName,
        request: { method: msg.request?.http?.method, url: msg.request?.http?.url },
        response: {
          status: msg.response.status,
          statusText: msg.response.statusText,
          headers: respHeaders,
          body: { type: bodyType, data: msg.response.body ?? '' },
        },
      });

      await ctx.applyEdit(current);
      webview.postMessage({ type: 'examplesUpdated', examples: current.examples });
      vscode.window.showInformationMessage(`Saved example "${exampleName}".`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to save example: ${e.message}`);
    }
  }

  private async _openInBrowser(bodyBase64: string, contentType: string): Promise<void> {
    const ext = contentType.includes('pdf') ? 'pdf' : 'bin';
    const fs = await import('fs');
    const os = await import('os');
    const tmpPath = path.join(os.tmpdir(), `missio-preview-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(bodyBase64, 'base64'));
    await vscode.env.openExternal(vscode.Uri.file(tmpPath));
  }

  private async _saveBinaryResponse(bodyBase64: string, contentType: string): Promise<void> {
    const ext = contentType.includes('pdf') ? 'pdf'
      : contentType.includes('png') ? 'png'
      : contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg'
      : contentType.includes('gif') ? 'gif'
      : contentType.includes('svg') ? 'svg'
      : contentType.includes('webp') ? 'webp'
      : 'bin';
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`response.${ext}`),
      filters: { [ext.toUpperCase()]: [ext], 'All Files': ['*'] },
    });
    if (!uri) return;
    const buffer = Buffer.from(bodyBase64, 'base64');
    await vscode.workspace.fs.writeFile(uri, buffer);
    vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
  }

  protected _getBodyHtml(_webview: vscode.Webview): string {
    return `
  <!-- URL Bar -->
  <div class="url-bar">
    <div class="method-picker" id="methodPicker">
      <select class="method-select" id="method">
        <option value="GET">GET</option>
        <option value="POST">POST</option>
        <option value="PUT">PUT</option>
        <option value="PATCH">PATCH</option>
        <option value="DELETE">DELETE</option>
        <option value="HEAD">HEAD</option>
        <option value="OPTIONS">OPTIONS</option>
      </select>
    </div>
    <div class="url-wrap" id="urlWrap"><div class="url-input" id="url" contenteditable="true" spellcheck="false" data-placeholder="{{baseUrl}}/api/endpoint"></div></div>
    <button class="btn btn-toggle" id="varToggleBtn" title="Toggle resolved variables">{{}}</button>
    <button class="btn btn-primary" id="sendBtn">Send</button>
  </div>

  <div class="main-content">
    <!-- Request Section -->
    <div class="request-section" id="requestSection">
      <div class="tabs" id="reqTabs">
        <div class="tab active" data-tab="body">Body</div>
        <div class="tab" data-tab="auth">Auth</div>
        <div class="tab" data-tab="headers">Headers <span class="badge" id="headersBadge">0</span></div>
        <div class="tab" data-tab="params">Params <span class="badge" id="paramsBadge">0</span></div>
        <div class="tab" data-tab="settings">Settings</div>
        <div class="tab" data-tab="export">Export</div>
      </div>
      <div class="tab-content">
        <!-- Params -->
        <div class="tab-panel" id="panel-params">
          <table class="kv-table" id="paramsTable">
            <colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:100px"><col style="width:32px"></colgroup>
            <thead><tr><th></th><th>Name</th><th>Value</th><th>Type</th><th></th></tr></thead>
            <tbody id="paramsBody"></tbody>
          </table>
          <button class="add-row-btn" id="addParamBtn">+ Add Parameter</button>
        </div>
        <!-- Headers -->
        <div class="tab-panel" id="panel-headers">
          <table class="kv-table" id="headersTable">
            <colgroup><col style="width:32px"><col style="width:25%"><col><col style="width:32px"></colgroup>
            <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
            <tbody id="headersBody"></tbody>
          </table>
          <button class="add-row-btn" id="addHeaderBtn">+ Add Header</button>
        </div>
        <!-- Body -->
        <div class="tab-panel active" id="panel-body">
          <div class="body-toolbar">
            <div class="body-type-pills" id="bodyTypePills">
              <button class="pill active" data-body-type="none">None</button>
              <button class="pill" data-body-type="raw">Raw</button>
              <button class="pill" data-body-type="form-urlencoded">Form Encoded</button>
              <button class="pill" data-body-type="multipart-form">Multipart</button>
              <button class="pill" data-body-type="file">Binary</button>
            </div>
            <select class="lang-select" id="bodyLangMode">
              <option value="json">JSON</option>
              <option value="xml">XML</option>
              <option value="html">HTML</option>
              <option value="yaml">YAML</option>
              <option value="text">Text</option>
            </select>
          </div>
          <div id="bodyRawEditor" style="display:none;">
            <div class="code-wrap">
              <div class="line-numbers" id="lineNumbers"></div>
              <pre class="code-highlight" id="bodyHighlight"></pre>
              <textarea class="code-input" id="bodyData" spellcheck="false"></textarea>
            </div>
          </div>
          <div id="bodyFormEditor" style="display:none;">
            <table class="kv-table" id="bodyFormTable">
              <thead><tr><th></th><th>Name</th><th>Value</th><th></th></tr></thead>
              <tbody id="bodyFormBody"></tbody>
            </table>
            <button class="add-row-btn" id="addFormFieldBtn">+ Add Field</button>
          </div>
          <div id="bodyBinaryEditor" style="display:none;">
            <div class="binary-row">
              <input type="text" id="binaryFilePath" class="binary-path-input" placeholder="(no file selected)" />
              <button class="btn btn-secondary" id="chooseBinaryFileBtn">Choose File…</button>
            </div>
            <div class="binary-row binary-type-row">
              <label class="binary-label">Content-Type</label>
              <input type="text" id="binaryContentType" class="binary-type-input" placeholder="application/octet-stream" />
            </div>
          </div>
        </div>
        <!-- Auth -->
        <div class="tab-panel" id="panel-auth">
          <div class="auth-section">
            <div class="form-field"><label>Type</label><select class="auth-select" id="authType">
              <option value="none">No Auth</option>
              <option value="inherit">Inherit</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
              <option value="apikey">API Key</option>
              <option value="oauth2">OAuth 2.0</option>
            </select></div>
            <div id="authFields"></div>
          </div>
        </div>
        <!-- Settings -->
        <div class="tab-panel" id="panel-settings">
          <div class="auth-section">
            <div class="auth-row">
              <label>Timeout (ms)</label>
              <input type="number" id="settingTimeout" value="30000" />
            </div>
            <div class="auth-row">
              <label>Encode URL</label>
              <input type="checkbox" id="settingEncodeUrl" checked />
            </div>
            <div class="auth-row">
              <label>Follow Redirects</label>
              <input type="checkbox" id="settingFollowRedirects" checked />
            </div>
            <div class="auth-row">
              <label>Max Redirects</label>
              <input type="number" id="settingMaxRedirects" value="5" />
            </div>
          </div>
        </div>
        <!-- Export -->
        <div class="tab-panel" id="panel-export">
          <div class="export-toolbar">
            <select class="export-format-select" id="exportFormat">
              ${EXPORT_TARGETS.map(t => `<option value="${t.id}"${t.id === 'shell:curl' ? ' selected' : ''}>${t.label}</option>`).join('\n              ')}
            </select>
            <label class="export-checkbox"><input type="checkbox" id="exportIncludeHeaders" checked /> Headers</label>
            <label class="export-checkbox"><input type="checkbox" id="exportIncludeAuth" /> Auth</label>
            <label class="export-checkbox"><input type="checkbox" id="exportIncludeBody" checked /> Body</label>
            <label class="export-checkbox"><input type="checkbox" id="exportResolveVars" checked /> Resolve Variables</label>
            <div class="export-inline-spinner" id="exportSpinner" style="display:none;"><div class="spinner"></div></div>
            <div class="export-actions">
              <button class="btn btn-primary" id="exportCopyBtn" title="Copy to clipboard">Copy</button>
              <button class="btn btn-secondary" id="exportSaveBtn" title="Save to file">Save</button>
            </div>
          </div>
          <div class="export-preview-wrap">
            <pre class="export-preview" id="exportPreview">Click a format or switch options to preview the export.</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Resizable Divider -->
    <div class="divider" id="divider"></div>

    <!-- Response Section -->
    <div class="response-section" id="responseSection">
      <div class="loading-overlay" id="respLoading" style="display:none;">
        <div class="spinner"></div>
        <span>Sending request…</span>
        <span class="loading-timer" id="loadingTimer">0.0s</span>
      </div>
      <div class="response-bar" id="responseBar" style="display:none;">
        <span class="label">Response</span>
        <span class="status-badge" id="statusBadge"></span>
        <span class="meta" id="responseMeta"></span>
        <span class="example-indicator" id="exampleIndicator"></span>
        <button class="save-example-btn" id="refreshOAuthRetryBtn" style="display:none;" title="Clear OAuth2 token and retry">Refresh OAuth &amp; Retry</button>
        <button class="save-example-btn" id="saveExampleBtn" title="Save as example">Save as Example</button>
      </div>
      <div class="tabs" id="respTabs" style="display:none;">
        <div class="tab active" data-tab="resp-body">Body</div>
        <div class="tab" data-tab="resp-headers">Headers</div>
        <div class="tab" data-tab="resp-preview" id="respPreviewTab" style="display:none;">Preview</div>
      </div>
      <div class="resp-search-bar" id="respSearchBar" style="display:none;">
        <input type="text" id="respSearchInput" class="resp-search-input" placeholder="Find in response…" />
        <span class="resp-search-count" id="respSearchCount"></span>
        <button class="resp-search-nav" id="respSearchPrev" title="Previous match (Shift+Enter)">&#x2191;</button>
        <button class="resp-search-nav" id="respSearchNext" title="Next match (Enter)">&#x2193;</button>
        <button class="resp-search-close" id="respSearchClose" title="Close (Escape)">&times;</button>
      </div>
      <div class="response-body">
        <div class="tab-panel active" id="panel-resp-body">
          <div class="empty-state" id="respEmpty">Send a request to see the response</div>
          <div id="respBinaryOverlay" style="display:none;padding:32px;text-align:center;color:var(--vscode-foreground);font-family:var(--vscode-font-family,system-ui);">
            <div style="font-size:14px;margin-bottom:8px;">Response body contains binary data</div>
            <div style="font-size:12px;opacity:.7;margin-bottom:16px;" id="respBinaryInfo"></div>
            <button class="save-example-btn" id="showRawBtn">Show Raw</button>
          </div>
          <div id="respBodyWrap" class="resp-body-wrap" style="display:none;">
            <button class="copy-btn" id="copyRespBtn" title="Copy to clipboard">Copy</button>
            <div class="code-wrap resp-code-wrap">
              <div class="line-numbers" id="respLineNumbers"></div>
              <pre class="code-highlight" id="respBodyPre" contenteditable="plaintext-only" spellcheck="false"></pre>
            </div>
          </div>
        </div>
        <div class="tab-panel" id="panel-resp-headers">
          <table class="resp-headers-table" id="respHeadersTable"><tbody id="respHeadersBody"></tbody></table>
        </div>
        <div class="tab-panel" id="panel-resp-preview" style="height:100%;overflow:auto;position:relative;">
          <iframe id="respPreviewFrame" sandbox="allow-same-origin" style="border:none;width:100%;height:100%;background:#fff;display:none;"></iframe>
          <div id="previewOverlay" style="display:none;position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;"></div>
          <div id="respPdfContainer" style="display:none;background:var(--vscode-editor-background);padding:16px 0;text-align:center;"></div>
        </div>
      </div>
    </div>
  </div>`;
  }
}
