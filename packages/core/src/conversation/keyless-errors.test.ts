// What a refused keyless connection is allowed to tell the host.
//
// ── Verified against the server, this session ────────────────────────────
//
// `chat-service-node/src/api/websocket/v2/handlers.ts` answers a keyless hello
// it will not admit with `AUTH_INVALID` from THREE unrelated causes, on a
// connection that sent no publishable key at all:
//
//   ~:1113  the staff surface is disabled on this deployment
//           -> errorPayload('AUTH_INVALID', 'Invalid publishable key')
//   ~:1164  the token failed verification
//           -> authErrorPayload(token), which is AUTH_INVALID/'Authentication
//              failed', or AUTH_EXPIRED/'Token has expired' if it merely lapsed
//   ~:1190  the token verified but the role is not staff
//           -> errorPayload('AUTH_INVALID', 'Invalid publishable key')
//
// Two of the three name a credential the client never sent, and all three need
// different fixes: turn a flag on, get a new token, or use a staff account. So
// the rule for this surface is: branch on `code`, and never let the server's
// `message` reach the host.
//
// These tests drive the wire shape the server actually produces — an `error`
// frame followed by close 1008 — through the real `ConnectionController`, not
// through a stubbed error path.

import { describe, expect, it } from 'vitest';

import { createConversationClient } from './create-conversation-client.js';
import type { ConversationClientConfig } from './types.js';
import { ManualTimers } from '../presence/index.js';
import { StubSocketFactory } from '../transport/index.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(n: number): string {
  const suffix = ULID_ALPHABET[n % ULID_ALPHABET.length] ?? '0';
  return `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}${suffix}`;
}

async function tick(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** The server's own refusal payload, verbatim. */
const SERVER_MESSAGE = 'Invalid publishable key';

function errorFrameJson(idNum: number, code: string, message: string): unknown {
  return {
    v: 1,
    t: 'error',
    id: ulid(idNum),
    ts: 0,
    d: { code, message, retryable: false },
  };
}

interface Harness {
  readonly sockets: StubSocketFactory;
  readonly timers: ManualTimers;
  readonly config: ConversationClientConfig;
}

function harness(overrides: Partial<ConversationClientConfig> = {}): Harness {
  const sockets = new StubSocketFactory();
  const timers = new ManualTimers();

  return {
    sockets,
    timers,
    config: {
      wsUrl: 'wss://example.test/chat-services/v2/ws',
      getToken: async () => 'id_token_merchant',
      localSender: { senderId: 'merchant_42', senderType: 'CUSTOMER' },
      // Required at construction on this surface, and unused by these cases:
      // nothing here opens a conversation, so nothing reads a page.
      history: { listMessages: async () => ({ messages: [], hasMore: false }) },
      webSocketFactory: sockets.create,
      schedule: timers.schedule,
      now: timers.clock,
      ...overrides,
    },
  };
}

/** Drives one refusal exactly as the server produces it: error frame, then 1008. */
async function refuse(h: Harness, code = 'AUTH_INVALID', message = SERVER_MESSAGE): Promise<void> {
  h.sockets.last.open();
  h.sockets.last.emitJson(errorFrameJson(1, code, message));
  h.sockets.last.emitClose({ code: 1008, reason: 'authentication failed', wasClean: true });
  await tick();
}

describe('a refused keyless connection', () => {
  it("surfaces code AUTH_INVALID and NEVER the server's message", async () => {
    const h = harness();
    const client = createConversationClient(h.config);

    void client.connect().catch(() => undefined);
    await tick();
    await refuse(h);

    const error = client.getState().lastError;
    expect(error).not.toBeNull();
    expect(error?.code).toBe('AUTH_INVALID');

    // The whole point. The host's error tracker must not receive "Invalid
    // publishable key" for a connection that sent no publishable key —
    // neither as the whole message nor buried inside a longer one.
    expect(error?.message).not.toBe(SERVER_MESSAGE);
    expect(error?.message).not.toContain(SERVER_MESSAGE);

    // And it says something a reader can act on: the three real causes.
    expect(error?.message).toContain('WS_V2_STAFF_ENABLED');
    expect(error?.message).toContain('AUTH_INVALID');
  });

  it('says the same thing for the OTHER message the server sends for the same code', async () => {
    // `authErrorPayload` answers 'Authentication failed' when the token failed
    // verification for a reason other than expiry. Same code, different text,
    // same fix-list — which is the argument for not passing either through.
    const h = harness();
    const client = createConversationClient(h.config);

    void client.connect().catch(() => undefined);
    await tick();
    await refuse(h, 'AUTH_INVALID', 'Authentication failed');

    expect(client.getState().lastError?.code).toBe('AUTH_INVALID');
    expect(client.getState().lastError?.message).not.toBe('Authentication failed');
    expect(client.getState().lastError?.message).toContain('WS_V2_STAFF_ENABLED');
  });

  it('leaves every OTHER code, including AUTH_EXPIRED, exactly as the server sent it', async () => {
    // Only the code with a wrong message is rewritten. An expired token is
    // reported accurately by the server and the host is better served by the
    // server's own words — rewriting everything would be a second, silent
    // place for the truth to drift.
    const h = harness();
    const client = createConversationClient(h.config);

    void client.connect().catch(() => undefined);
    await tick();
    await refuse(h, 'AUTH_EXPIRED', 'Token has expired');

    expect(client.getState().lastError?.code).toBe('AUTH_EXPIRED');
    expect(client.getState().lastError?.message).toBe('Token has expired');
  });

  it('leaves the message alone when a key WAS sent, because then it is true', async () => {
    const h = harness({ publishableKey: 'dhp_test_abc' });
    const client = createConversationClient(h.config);

    void client.connect().catch(() => undefined);
    await tick();
    await refuse(h);

    expect(client.getState().lastError?.code).toBe('AUTH_INVALID');
    expect(client.getState().lastError?.message).toBe(SERVER_MESSAGE);
  });

  it('escalates rather than retrying forever, and connect() rejects when it suspends', async () => {
    const h = harness();
    const client = createConversationClient(h.config);

    const connecting = client.connect();
    // A rejected credential is not something backoff fixes: the controller
    // escalates through the auth policy and suspends after a bounded number of
    // consecutive failures. Drive refusals until it does.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await tick();
      if (client.getState().connectionState === 'suspended') break;
      if (h.sockets.last.closeCalls.length === 0 && h.sockets.last.sent.length === 0) {
        h.timers.advance(60_000);
        await tick();
      }
      await refuse(h);
      h.timers.advance(60_000);
    }
    await tick();

    expect(client.getState().connectionState).toBe('suspended');
    await expect(connecting).rejects.toThrow();

    // Still our message, still the structured code, after the escalation.
    expect(client.getState().lastError?.code).toBe('AUTH_INVALID');
    expect(client.getState().lastError?.message).not.toContain(SERVER_MESSAGE);
  });
});
