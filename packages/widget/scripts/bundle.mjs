// Builds `dist/widget.js` — the self-contained script-tag artifact — and
// reports what a customer's page actually pays for it.
//
// This is a DIFFERENT build from tsup's, with opposite rules, which is why it
// is a separate script rather than a second tsup entry:
//
//   tsup's output is for bundler users. Core, js, and rest stay EXTERNAL, so
//   an app that already imports core carries one copy of it.
//
//   This output is for a `<script src>`. There is no bundler on the other end
//   to resolve an import, so everything is INLINED, and the format is IIFE
//   rather than ESM — a plain `<script>` tag cannot evaluate an ESM bundle,
//   and requiring `type="module"` would drop every browser that still needs
//   the nomodule path and complicate the one-line install the whole package
//   exists to offer.
//
// The gzipped number is the one that matters: every CDN serving this will
// compress it, so the raw byte count overstates the cost by roughly 3x. Both
// are printed so the ratio is visible.

import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(packageRoot, 'dist', 'widget.js');

mkdirSync(join(packageRoot, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [join(packageRoot, 'src', 'embed.ts')],
  outfile,
  bundle: true,
  minify: true,
  format: 'iife',
  // ES2020 rather than esnext: `??=`, optional chaining and private fields all
  // exist there, and it is the floor at which the WebSocket/MediaRecorder
  // stack this depends on is present anyway. Going lower would pull in
  // regenerator for no reachable browser.
  target: ['es2020'],
  platform: 'browser',
  // Sourcemap is separate rather than inline: inlining it would roughly treble
  // the file a customer's page downloads to serve a debugging need that only
  // arises when someone is already looking.
  sourcemap: 'linked',
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

const bytes = readFileSync(outfile);
const gzipped = gzipSync(bytes, { level: 9 });

console.log('');
console.log(`  dist/widget.js   ${fmt(bytes.length)} raw   ${fmt(gzipped.length)} gzip`);
console.log('');

// A build failure, not a review comment. 90 KiB — roughly 4.9 KB of headroom
// over the pre-chooser baseline (85,897 B gzip, measured 2026-09-06) —
// enough to absorb an estimate that is off, not enough to absorb a second
// feature riding in on top of this one unnoticed.
const WIDGET_GZIP_BUDGET = 92_160;
if (gzipped.length > WIDGET_GZIP_BUDGET) {
  console.error(
    `  ERROR: dist/widget.js is ${fmt(gzipped.length)} gzip, over the ${fmt(WIDGET_GZIP_BUDGET)} budget.`,
  );
  console.error('  Either trim the addition or raise WIDGET_GZIP_BUDGET with a reason, not silently.');
  console.log('');
  process.exitCode = 1;
}

// What dominates, by origin. A single "the bundle is N KB" number is not
// actionable; "core is two thirds of it" tells you where to look.
// The `.js` output specifically — `outputs` also holds the sourcemap entry,
// which has no `inputs` and would silently yield an empty table.
const jsOutput = Object.entries(result.metafile.outputs).find(([file]) => file.endsWith('.js'));
const inputs = jsOutput?.[1]?.inputs ?? {};
const groups = new Map();
for (const [file, meta] of Object.entries(inputs)) {
  groups.set(originOf(file), (groups.get(originOf(file)) ?? 0) + meta.bytesInOutput);
}
const total = [...groups.values()].reduce((sum, value) => sum + value, 0) || 1;
console.log('  composition (pre-minification source bytes reaching the bundle):');
for (const [origin, size] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
  const share = Math.round((size / total) * 100);
  console.log(`    ${String(share).padStart(3)}%  ${fmt(size).padStart(9)}  ${origin}`);
}
console.log('');

// Measure the three presentations' shared cost against a stripped build, so
// the report can say what the UI itself costs versus what the SDK under it
// does. Built into a scratch dir and thrown away.
const scratch = join(packageRoot, '.size-tmp');
try {
  mkdirSync(scratch, { recursive: true });
  const entry = join(scratch, 'core-only.ts');
  writeFileSync(entry, "export { createChatClient } from '@dhaam-ccrm/core';\n");
  const bare = await build({
    entryPoints: [entry],
    outfile: join(scratch, 'core-only.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    logLevel: 'silent',
  });
  void bare;
  const coreBytes = readFileSync(join(scratch, 'core-only.js'));
  const coreGzip = gzipSync(coreBytes, { level: 9 });
  console.log(`  of which @dhaam-ccrm/core alone: ${fmt(coreBytes.length)} raw   ${fmt(coreGzip.length)} gzip`);
  console.log(`  the widget's own UI adds:        ${fmt(bytes.length - coreBytes.length)} raw   ${fmt(gzipped.length - coreGzip.length)} gzip`);
  console.log('');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function fmt(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

/** Groups a bundled input path by the package it came from. */
function originOf(file) {
  // Workspace siblings resolve through their built `dist/`, so they arrive as
  // `../core/dist/index.js` rather than as a `packages/` path.
  const sibling = /^\.\.\/([^/]+)\//.exec(file);
  if (sibling !== null) return `@dhaam-ccrm/${sibling[1]}`;
  if (file.includes('node_modules')) return 'node_modules';
  if (file.startsWith('src/ui/')) return 'widget UI (src/ui)';
  return 'widget wiring (src)';
}
