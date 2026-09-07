// Bundles the panel and serves it. That is all it does.
//
// ── What is deliberately NOT here ────────────────────────────────────────
//
// `examples/demo/server/index.mjs` has a `POST /api/token` route and holds a
// SECRET key in process memory. That exists because a customer widget's two
// credentials are asymmetric: the publishable key ships to the browser, the
// secret key mints access tokens and may never leave the server.
//
// A keyless staff panel has neither key. The operator already holds a dh-auth
// `id_token` and pastes it into a field, so there is nothing to mint, nothing
// to hold, and no route that could leak anything. This file reads no
// credential, stores none, and forwards none. If you are looking for the
// security story of this example: that paragraph is the whole of it.
//
// Usage:
//   node server/serve.mjs               serve the panel (point it at your own chat-service)
//   node server/serve.mjs --stub        also run the LOCAL STUB backend, and preset the fields
//   node server/serve.mjs --build-only  bundle to public/app.js and exit
//   PANEL_PORT=5174 node server/serve.mjs

import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const exampleRoot = join(here, '..');
export const publicDir = join(exampleRoot, 'public');
const repoRoot = resolve(exampleRoot, '../..');

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
//
// `pnpm install` at the repo root links `@dhaam-ccrm/core` and `esbuild` into
// this package's own node_modules, and that is the path this file prefers —
// resolving the SDK through its package.json `exports` is the same route a
// customer's bundler takes from npm, which is the point of an example.
//
// The fallbacks exist so the example is runnable in a checkout where install
// has not been re-run since this directory appeared. They are announced, never
// silent: a fallback that hides a missing install is how you end up debugging a
// stale bundle.

/** node_modules directories to hand esbuild, best first. */
function nodePaths() {
  const candidates = [
    join(exampleRoot, 'node_modules'),
    join(repoRoot, 'examples/demo/node_modules'),
    join(repoRoot, 'node_modules'),
  ];
  return candidates.filter((path) => existsSync(path));
}

function loadEsbuild() {
  for (const from of [exampleRoot, join(repoRoot, 'examples/demo')]) {
    try {
      const req = createRequire(join(from, 'package.json'));
      const path = req.resolve('esbuild');
      if (from !== exampleRoot) {
        console.warn(
          `[panel] esbuild resolved from ${from} — run \`pnpm install\` at the repo root to link it here.`,
        );
      }
      return import(path);
    } catch {
      // Try the next one.
    }
  }
  throw new Error('esbuild not found. Run `pnpm install` at the repo root.');
}

/** Fails with an instruction instead of an esbuild resolution stack. */
function assertPackagesBuilt() {
  const required = [
    ['@dhaam-ccrm/core', join(repoRoot, 'packages/core/dist/index.js')],
    ['@dhaam-ccrm/rest', join(repoRoot, 'packages/rest/dist/index.js')],
  ];
  const missing = required.filter(([, path]) => !existsSync(path)).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `these packages have no dist/ yet: ${missing.join(', ')}\n` +
        `They are consumed through their package.json "exports" (dist/), exactly as from npm.\n` +
        `Run "pnpm -r build" from the repo root first.`,
    );
  }
}

/**
 * One esbuild invocation, shared by the browser bundle and the headless smoke
 * driver so both resolve the SDK the same way: through each package's
 * package.json `exports`, i.e. through `dist/` — the route a customer's bundler
 * takes from npm.
 */
export async function bundleFor({ entry, outfile, platform = 'browser', format = 'iife', minify = false }) {
  assertPackagesBuilt();
  const esbuild = await loadEsbuild();

  return esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format,
    platform,
    target: platform === 'node' ? 'node18' : 'es2020',
    sourcemap: true,
    minify,
    logLevel: 'info',
    nodePaths: nodePaths(),
  });
}

export function bundle({ minify = false } = {}) {
  return bundleFor({
    entry: join(exampleRoot, 'src/main.ts'),
    outfile: join(publicDir, 'app.js'),
    minify,
  });
}

// ---------------------------------------------------------------------------
// Static serving
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CONFIG_PLACEHOLDER = '/*__PANEL_CONFIG__*/ null';

async function serveIndex(res, panelConfig) {
  const template = await readFile(join(publicDir, 'index.html'), 'utf8');
  if (!template.includes(CONFIG_PLACEHOLDER)) {
    throw new Error('index.html no longer contains the panel-config placeholder');
  }
  // `<` escaped so a config value can never close the script element. Every
  // value here is server-controlled; the escaping is the difference between
  // "safe" and "safe today".
  const json = JSON.stringify(panelConfig).replace(/</g, '\\u003c');
  const html = template.replace(CONFIG_PLACEHOLDER, json);

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES['.html'],
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

async function serveStatic(res, pathname) {
  // normalize() collapses `..` before the prefix check, so `/../server/serve.mjs`
  // cannot escape publicDir.
  const target = resolve(join(publicDir, normalize(pathname)));
  if (!target.startsWith(resolve(publicDir))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const buildOnly = argv.includes('--build-only');
  const withStub = argv.includes('--stub');

  console.log('[panel] bundling…');
  await bundle({ minify: argv.includes('--minify') });
  if (buildOnly) return;

  let panelConfig = {};
  if (withStub) {
    const { startStub, STUB_WARNING } = await import('./stub-chat-service.mjs');
    const stubPort = Number(process.env['STUB_PORT'] ?? 4400);
    await startStub(stubPort);
    panelConfig = {
      wsUrl: `ws://127.0.0.1:${stubPort}/chat-services/v2/ws`,
      apiUrl: `http://127.0.0.1:${stubPort}`,
      stub: STUB_WARNING,
    };
    console.log(`\n[panel] ${STUB_WARNING}\n`);
  }

  const port = Number(process.env['PANEL_PORT'] ?? 5174);
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (req.method !== 'GET') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      serveIndex(res, panelConfig).catch((error) => {
        console.error(error);
        res.writeHead(500).end('Internal error');
      });
      return;
    }
    serveStatic(res, pathname).catch(() => res.writeHead(500).end('Internal error'));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n[panel] http://127.0.0.1:${port}\n`);
    if (!withStub) {
      console.log('  Point the fields at your own chat-service. It needs BOTH:');
      console.log('    WS_V2_ENABLED=true');
      console.log('    WS_V2_STAFF_ENABLED=true');
      console.log('  and a dh-auth id_token whose roleId is 1, 5, 6 or 66.\n');
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
