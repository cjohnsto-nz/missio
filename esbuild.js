const esbuild = require('esbuild');
const fs = require('fs/promises');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function copyPdfJsAssets() {
  const pdfJsBuildDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build');
  const mediaDir = path.join(__dirname, 'media');

  await fs.mkdir(mediaDir, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(pdfJsBuildDir, 'pdf.min.mjs'), path.join(mediaDir, 'pdf.min.mjs')),
    fs.copyFile(path.join(pdfJsBuildDir, 'pdf.worker.min.mjs'), path.join(mediaDir, 'pdf.worker.min.mjs')),
  ]);
}

async function main() {
  // Extension host bundle (Node)
  const extCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    plugins: [],
  });

  // Webview bundles (browser)
  const webviewCtx = await esbuild.context({
    entryPoints: [
      'src/webview/theme.css',
      'src/webview/requestPanel.ts', 'src/webview/requestPanel.css',
      'src/webview/collectionPanel.ts', 'src/webview/collectionPanel.css',
      'src/webview/folderPanel.ts',
      'src/webview/globalsPanel.ts',
    ],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outdir: 'media',
    tsconfig: 'src/webview/tsconfig.json',
    logLevel: 'info',
    plugins: [],
  });

  if (watch) {
    await copyPdfJsAssets();
    await Promise.all([extCtx.watch(), webviewCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([extCtx.rebuild(), webviewCtx.rebuild()]);
    await copyPdfJsAssets();
    await Promise.all([extCtx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
