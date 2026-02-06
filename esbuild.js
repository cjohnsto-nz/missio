const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
    entryPoints: ['src/webview/requestPanel.ts', 'src/webview/requestPanel.css'],
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
    await Promise.all([extCtx.watch(), webviewCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([extCtx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([extCtx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
