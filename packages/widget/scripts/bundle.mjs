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

import { stripCssCommentsPlugin } from '../build/strip-css-comments.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(packageRoot, 'dist', 'widget.js');

mkdirSync(join(packageRoot, 'dist'), { recursive: true });

// Filled in by the plugin as it loads the stylesheet, so the report below can
// say what the strip is worth instead of leaving it as folklore.
let stripStats = null;

const result = await build({
  entryPoints: [join(packageRoot, 'src', 'embed.ts')],
  outfile,
  bundle: true,
  minify: true,
  // `minify` does NOT cover the stylesheet. `src/ui/styles.ts` holds the whole
  // sheet in a template literal, so its `/* … */` blocks are string data;
  // esbuild leaves them alone because deleting characters from a string would
  // change what the program means. This plugin knows they are CSS and removes
  // them before esbuild parses the module. Shared with tsup.config.ts — one
  // transform, two registrations.
  plugins: [
    stripCssCommentsPlugin({
      onStrip: (stats) => {
        stripStats = stats;
      },
    }),
  ],
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

// A build failure, not a review comment. 79 KiB — roughly 4.9 KB of headroom
// over the current baseline of 75,927 B gzip — enough to absorb an estimate
// that is off, not enough to absorb a second feature riding in on top of this
// one unnoticed.
//
// THIS NUMBER MOVED DOWN, from 92,160, and it is the first time it has moved
// in that direction. The reason is that a long-standing cost was RETIRED
// rather than paid: the stylesheet's CSS comments are string data (see the
// plugin above), so no minifier ever removed them and every visitor of every
// host page downloaded 134 blocks of developer prose. Stripping them at build
// time took this artifact from 320,918 B to 264,724 B raw, and from 95,661 B
// to 75,927 B gzip — a 19,734 B saving on the number that is actually
// downloaded. Those are the figures the comparison pass at the bottom of this
// file prints on every build (`19.3 KB gzip (93.4 KB without the strip)`),
// measured the way it measures them: one esbuild pass with the plugin removed
// and nothing else changed. That pass writes no sourcemap, so 35 B of the raw
// difference is an absent `sourceMappingURL` comment rather than prose.
//
// Leaving the ceiling at 92,160 would have left more than 16 KB of silent
// regression room where the old budget only ever allowed 6,263 B. That is not
// a budget, it is a formality, and it would have let the whole saving be
// spent again without anyone being told.
// Increased slightly to accommodate Figma redesign styles and customer/portal screen separation
// Increased again for the Dhaam AI wordmark (DEFAULT_LOGO_IMAGE, ui/dom.ts) — an inline SVG fallback
// shown in place of a tenant logo/avatar that 404s, at 2.3 KB gzip after rounding its path data to
// integer precision (was 9.7 KB at the original Figma export's 4-decimal precision).
const WIDGET_GZIP_BUDGET = 88_064;
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

  // What the CSS-comment strip is worth, measured rather than asserted.
  //
  // The plugin can report the SOURCE bytes it removed for free, and that
  // number is the wrong one to publish on its own: comment prose is repetitive
  // English and gzip eats it, so quoting the raw saving overstates what a
  // visitor actually saves by roughly 3x — the same trap this file's header
  // warns about for the bundle as a whole. So this rebuilds once without the
  // plugin and compares the gzipped results. One extra esbuild pass, measured
  // at ~110ms against the ~14s tsup spends on .d.ts in the same `pnpm build`,
  // to keep a number honest that would otherwise be repeated from memory in a
  // comment and quietly drift away from the artifact.
  if (stripStats !== null) {
    await build({
      entryPoints: [join(packageRoot, 'src', 'embed.ts')],
      outfile: join(scratch, 'unstripped.js'),
      bundle: true,
      minify: true,
      format: 'iife',
      target: ['es2020'],
      platform: 'browser',
      logLevel: 'silent',
    });
    const unstripped = gzipSync(readFileSync(join(scratch, 'unstripped.js')), { level: 9 });
    console.log(
      `  css comments stripped from the stylesheet: ${stripStats.removed} blocks, ` +
        `${fmt(stripStats.bytesRemoved)} of source`,
    );
    console.log(
      `  which is worth: ${fmt(unstripped.length - gzipped.length)} gzip ` +
        `(${fmt(unstripped.length)} without the strip)`,
    );
    // Zero today. A comment with no whitespace on either side is the one shape
    // the transform declines to touch, because removing it would join two CSS
    // tokens — see build/strip-css-comments.mjs. Printed so it never becomes
    // invisible.
    if (stripStats.kept > 0) {
      console.log(`  left in place (no whitespace beside them, unsafe to remove): ${stripStats.kept}`);
    }
    console.log('');
  }
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
