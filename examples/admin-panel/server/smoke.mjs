// `node server/smoke.mjs` — start the stub, drive the SDK against it, exit 0/1.
//
// No browser and no admin token. This is the fastest honest answer to "is my
// integration wired correctly?", and it is deliberately separate from the
// question "is my backend configured and is my token good?", which only a run
// against a real chat-service can answer.
//
// src/smoke.ts is bundled for Node rather than run through a TS loader so it
// resolves `@dhaam-ccrm/core` and `@dhaam-ccrm/rest` through their package
// `exports` — the same route the browser bundle takes, and the same route a
// customer takes from npm.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { exampleRoot, bundleFor } from './serve.mjs';
import { startStub, STUB_WARNING } from './stub-chat-service.mjs';

const port = Number(process.env['STUB_PORT'] ?? 4401);

console.log(`\n${STUB_WARNING}\n`);

const server = await startStub(port);
const outDir = await mkdtemp(join(tmpdir(), 'dhaam-admin-smoke-'));
const outfile = join(outDir, 'smoke.mjs');

try {
  await bundleFor({
    entry: join(exampleRoot, 'src/smoke.ts'),
    outfile,
    platform: 'node',
    format: 'esm',
  });

  process.env['SMOKE_WS_URL'] = `ws://127.0.0.1:${port}/chat-services/v2/ws`;
  process.env['SMOKE_API_URL'] = `http://127.0.0.1:${port}`;

  console.log('\n[smoke] driving the SDK…\n');
  await import(pathToFileURL(outfile).href);
  console.log('[smoke] PASS — the SDK path works. This says nothing about your auth.\n');
} catch (error) {
  console.error('\n[smoke] FAIL\n', error);
  process.exitCode = 1;
} finally {
  await rm(outDir, { recursive: true, force: true });
  server.close();
  // The stub holds open sockets the client may not have closed yet.
  setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
}
