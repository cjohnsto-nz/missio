import * as vscode from 'vscode';

/**
 * Opens a webview tab to preview rich response content (HTML, PDF, images).
 * Purely on-demand — only created when the user clicks "Preview".
 */
export class PreviewPanel {
  private static _panel: vscode.WebviewPanel | undefined;

  static show(
    contentType: string,
    body: string,
    bodyBase64: string | undefined,
  ): void {
    const column = vscode.ViewColumn.Beside;

    if (PreviewPanel._panel) {
      PreviewPanel._panel.reveal(column);
    } else {
      PreviewPanel._panel = vscode.window.createWebviewPanel(
        'missio.preview',
        'Response Preview',
        column,
        {
          enableScripts: false,
          localResourceRoots: [],
        },
      );
      PreviewPanel._panel.onDidDispose(() => {
        PreviewPanel._panel = undefined;
      });
    }

    const ct = contentType.toLowerCase();
    let html: string;

    if (ct.includes('text/html') || ct.includes('application/xhtml')) {
      html = PreviewPanel._renderHtml(body);
    } else if (ct.includes('application/pdf')) {
      html = PreviewPanel._renderPdf(bodyBase64);
    } else if (ct.startsWith('image/svg')) {
      // SVG is text-based, use body directly
      html = PreviewPanel._renderImage(`data:${contentType};base64,${bodyBase64 ?? btoa(body)}`);
    } else if (ct.startsWith('image/')) {
      html = PreviewPanel._renderImage(`data:${contentType};base64,${bodyBase64 ?? ''}`);
    } else {
      html = PreviewPanel._renderFallback(body);
    }

    PreviewPanel._panel.title = PreviewPanel._titleForType(ct);
    PreviewPanel._panel.webview.html = html;
  }

  private static _titleForType(ct: string): string {
    if (ct.includes('html')) return 'HTML Preview';
    if (ct.includes('pdf')) return 'PDF Preview';
    if (ct.includes('image/svg')) return 'SVG Preview';
    if (ct.startsWith('image/')) return 'Image Preview';
    return 'Response Preview';
  }

  // ── Renderers ──────────────────────────────────────────────────────

  private static _renderHtml(body: string): string {
    // Render HTML inside a sandboxed iframe to isolate scripts
    const encoded = body
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
  iframe { border: none; width: 100%; height: 100%; }
</style>
</head><body>
<iframe sandbox="allow-same-origin" srcdoc="${encoded}"></iframe>
</body></html>`;
  }

  private static _renderPdf(base64: string | undefined): string {
    if (!base64) {
      return PreviewPanel._renderError('No binary data available for PDF preview.');
    }
    // Embed PDF via data URI in an iframe — enableScripts must be true for PDF.js
    // but we use an <embed> which works without scripts in most cases
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e); }
  embed, object { width: 100%; height: 100%; }
  .fallback { padding: 24px; color: var(--vscode-foreground, #ccc); font-family: var(--vscode-font-family, sans-serif); }
  .fallback a { color: var(--vscode-textLink-foreground, #3794ff); }
</style>
</head><body>
<embed src="data:application/pdf;base64,${base64}" type="application/pdf" />
</body></html>`;
  }

  private static _renderImage(dataUri: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body, html { margin: 0; padding: 0; width: 100%; height: 100%; display: flex;
    align-items: center; justify-content: center;
    background: var(--vscode-editor-background, #1e1e1e); }
  img { max-width: 100%; max-height: 100%; object-fit: contain;
    background: repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 16px 16px; }
</style>
</head><body>
<img src="${dataUri}" />
</body></html>`;
  }

  private static _renderFallback(body: string): string {
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { margin: 0; padding: 16px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e); white-space: pre-wrap; word-break: break-all; }
</style>
</head><body>${escaped}</body></html>`;
  }

  private static _renderError(message: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { margin: 0; padding: 24px; font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-errorForeground, #f44); background: var(--vscode-editor-background, #1e1e1e); }
</style>
</head><body>${message}</body></html>`;
  }
}
