// A dev harness for driving the built widget in a real browser.
//
// Not shipped and not a package entry point — `pnpm dev:harness` only. It
// exists because the one thing a jsdom suite cannot prove about this package
// is the half that matters most on a customer's page: that the shadow root
// really does keep a hostile host stylesheet out, that the top-layer promotion
// beats a `z-index: 2147483647` banner, and that focus, Escape, and the live
// region behave in an engine with real layout.
//
// It reads the publishable key from examples/demo/.env at request time and
// injects it into the page. The SECRET key is never read, never proxied, and
// never reaches this process's response body — the token route below forwards
// to the demo's own `/api/token`, which is the only thing holding it. That is
// the same split the widget enforces in the browser, kept honest here too.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

const PORT = Number(process.env['HARNESS_PORT'] ?? 3012);
const DEMO_ORIGIN = process.env['DEMO_ORIGIN'] ?? 'http://localhost:5173';

function env() {
  try {
    const raw = readFileSync(join(repoRoot, 'examples', 'demo', '.env'), 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) out[match[1]] = match[2];
    }
    return out;
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Same-origin token route, so the widget's `credentials: 'same-origin'`
  // fetch behaves exactly as it would on a real host page.
  if (req.method === 'POST' && pathname === '/api/chat-token') {
    try {
      const config = env();
      let upstream;
      if (config.CHAT_SECRET_KEY && config.CHAT_API_URL) {
        upstream = await fetch(`${config.CHAT_API_URL.replace(/\/+$/, '')}/chat-services/api/v1/tokens`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${config.CHAT_SECRET_KEY}`,
          },
          body: JSON.stringify({ userId: config.DEMO_USER_ID ?? 'demo-user-1' }),
        });
      } else {
        upstream = await fetch(`${DEMO_ORIGIN}/api/token`, { method: 'POST' });
      }
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }

  if (pathname === '/widget.js' || pathname === '/widget.js.map') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(join(packageRoot, 'dist', pathname.slice(1))));
    return;
  }

  const config = env();
  const page = readFileSync(join(packageRoot, 'dev', 'harness.html'), 'utf8')
    .replaceAll('__PUBLISHABLE_KEY__', config.CHAT_PUBLISHABLE_KEY ?? '')
    .replaceAll('__API_URL__', config.CHAT_API_URL ?? '')
    .replaceAll('__WS_URL__', config.CHAT_WS_URL ?? '')
    .replaceAll('__USER_ID__', config.DEMO_USER_ID ?? 'demo-user-1')
    .replaceAll('__MODE__', new URL(req.url ?? '/', `http://x`).searchParams.get('mode') ?? 'auto');

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});

server.listen(PORT, () => {
  console.log(`harness on http://localhost:${PORT}  (proxying tokens to ${DEMO_ORIGIN})`);
});
