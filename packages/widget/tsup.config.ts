import { defineConfig } from 'tsup';

import { stripCssCommentsPlugin } from './build/strip-css-comments.mjs';

// The npm-package build only. The script-tag bundle (`dist/widget.js`) is a
// different artifact with different rules — self-contained, IIFE, everything
// inlined — and is produced by scripts/bundle.mjs, which also reports its
// gzipped weight.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  // The stylesheet's CSS comments, removed before esbuild parses the module.
  //
  // This build is NOT minified, and that is not the reason the plugin is here.
  // `src/ui/styles.ts` keeps the sheet in a template literal, so its comments
  // are string DATA — a consumer who bundles this package cannot remove them
  // with their own minifier either, however aggressive it is. Without this
  // registration the fix would cover the script tag and leave every npm
  // consumer downloading ~50 KB of our internal prose. See build/ for why the
  // transform is shared rather than written twice.
  esbuildPlugins: [stripCssCommentsPlugin()],
  // External for the package build so a bundler-using consumer carries one
  // copy of core. Deliberately NOT external for the script-tag bundle.
  external: ['@dhaam-ccrm/core', '@dhaam-ccrm/js', '@dhaam-ccrm/rest'],
});
