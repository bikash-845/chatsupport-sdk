// A headless drive of the SAME code path the panel uses — no DOM, no browser.
//
// `server/smoke.mjs` bundles this for Node, starts the stub next door, and runs
// it. What it proves is bounded and worth stating exactly:
//
//   PROVEN: the SDK wiring. A keyless hello reaches `connected`; `open()`
//           performs join → snapshot → page one and resolves; the history seam
//           in admin-api.ts parses a raw row page; an optimistic echo appears
//           and then clears when the server acks; an inbound `message.new`
//           lands on the right conversation row.
//
//   NOT PROVEN: anything about authentication, roles, tenancy, or your
//           deployment. The stub accepts any non-empty token. If this passes
//           and your real deployment does not, the difference is the backend.
//
// Everything below is the panel's own configuration, minus the DOM.

import {
  ConversationJoinError,
  createConversationClient,
} from '@dhaam-ccrm/core';
import type { ChatState, ConversationsState } from '@dhaam-ccrm/core';

import { createAdminHistorySource } from './admin-api.js';

const wsUrl = process.env['SMOKE_WS_URL'] ?? '';
const apiUrl = process.env['SMOKE_API_URL'] ?? '';
const conversationId = process.env['SMOKE_SESSION_ID'] ?? 'stub_session_1';

if (wsUrl === '' || apiUrl === '') {
  throw new Error('SMOKE_WS_URL and SMOKE_API_URL are required');
}

const steps: string[] = [];
function step(text: string): void {
  steps.push(text);
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${text}`);
}

function fail(text: string): never {
  // eslint-disable-next-line no-console
  console.error(`  ✗ ${text}`);
  process.exitCode = 1;
  throw new Error(text);
}

/** Resolves when `predicate` holds, or rejects after `ms`. */
function waitFor(
  client: { getState(): ConversationsState; subscribe(l: (s: ConversationsState) => void): () => void },
  what: string,
  predicate: (state: ConversationsState) => boolean,
  ms = 8000,
): Promise<void> {
  if (predicate(client.getState())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${ms}ms waiting for ${what}`));
    }, ms);
    const off = client.subscribe((state) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

function row(state: ConversationsState): ChatState | undefined {
  return state.conversations[conversationId];
}

async function main(): Promise<void> {
  const client = createConversationClient({
    wsUrl,
    // No `publishableKey`. Absence is the signal.
    getToken: async () => ({ token: 'smoke-token', expiresInMs: 5 * 60 * 1000 }),
    localSender: { senderId: 'participant_staff_stub', senderType: 'AGENT' },
    history: createAdminHistorySource({ apiUrl, getToken: () => 'smoke-token' }),
    pageSize: 20,
    logger: (level, message) => {
      if (level === 'warn' || level === 'error') console.warn(`    [sdk:${level}] ${message}`);
    },
  });

  await client.connect();
  if (client.getState().connectionState !== 'connected') fail('connect() resolved but state is not connected');
  step(`connected — keyless hello accepted, session-less ack (state: ${client.getState().connectionState})`);

  // The refusal path first, so a green run has exercised both halves.
  try {
    await client.open({ conversationId: 'no-such-session' });
    fail('opening "no-such-session" should have been refused');
  } catch (error) {
    if (!(error instanceof ConversationJoinError)) throw error;
    if (error.reason !== 'refused') fail(`expected reason "refused", got "${error.reason}"`);
    step(`a refused join throws ConversationJoinError { reason: "refused", code: "${error.code}" }`);
    if (row(client.getState()) !== undefined) fail('a refused open left a row behind');
  }

  await client.open({ conversationId });
  const opened = row(client.getState());
  if (opened === undefined) fail('open() resolved but there is no conversation row');
  if (opened.session === null) fail('open() resolved with a null session — a send could not be addressed');
  if (!opened.pagination.initialLoaded) fail('open() resolved before page one landed');
  step(
    `open() resolved: status=${opened.session.status} mode=${opened.session.mode} ` +
      `history=${opened.messages.length} row(s), initialLoaded=${opened.pagination.initialLoaded}`,
  );

  // The raw-row projection is load-bearing: the stub returns integer enums, so
  // a decoded 'CUSTOMER'/'TEXT' here proves projectHistoryRow actually ran.
  const first = opened.messages[0];
  if (first === undefined || first.senderType !== 'CUSTOMER' || first.type !== 'TEXT') {
    fail(`history row did not project: ${JSON.stringify(first)}`);
  }
  step(`raw history rows projected — integer enums decoded (senderType=${first.senderType}, type=${first.type})`);

  const before = row(client.getState())?.messages.length ?? 0;
  const sent = client.sendMessage(conversationId, 'on my way');

  await waitFor(client, 'the optimistic echo', (s) => (row(s)?.messages.length ?? 0) > before);
  const echo = row(client.getState())?.messages[before];
  if (echo?.delivery === undefined) fail('the echo landed without a delivery state');
  step(`optimistic echo rendered immediately with delivery.state="${echo.delivery.state}"`);

  await sent;
  await waitFor(client, 'the server ack to clear delivery', (s) => s.conversations[conversationId]?.messages[before]?.delivery === undefined);
  const confirmed = row(client.getState())?.messages[before];
  step(`server acked — delivery cleared, seq=${confirmed?.seq}`);

  await waitFor(client, 'the inbound message.new', (s) => (row(s)?.messages.length ?? 0) > before + 1);
  const inbound = row(client.getState())?.messages[before + 1];
  step(`inbound message.new landed on this row: ${inbound?.senderType} "${inbound?.content}"`);

  client.disconnect();
  step('disconnect() — user-initiated and terminal');

  console.log(`\n  ${steps.length} steps, all green.\n`);
}

await main();
