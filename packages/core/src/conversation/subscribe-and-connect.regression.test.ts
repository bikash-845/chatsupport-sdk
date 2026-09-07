// Regressions for two defects found by driving the slice-1 client, not by
// reading it. Both were invisible to the existing tests because every one of
// them used a SINGLE subscriber and asserted on `getState()` rather than on
// what `connect()` throws.
//
//   BUG 1  `subscribe()` woke only the FIRST listener.
//          `project()` advanced a closure-shared `cached`, so by the time the
//          second subscriber's callback ran, its `before === next` and it was
//          silently skipped. One listener per client is not a degraded
//          `useSyncExternalStore` — it is a broken one, and it breaks the
//          moment a second component mounts against the same client.
//
//   BUG 2  `connect()` rejected with the server's own text.
//          `ConnectionController` builds the message as
//          `Connection suspended (${reason}): ${cause.message}`, and on a
//          keyless connection `cause.message` is "Invalid publishable key" —
//          about a credential that was never sent. `state.lastError` was
//          scrubbed; the thrown error was not. `await client.connect()` inside
//          a try/catch is the primary drive path in the documented API, so the
//          scrubbing was missing from the place hosts actually read.

import { describe, expect, it } from 'vitest';

import { createConversationClient } from './create-conversation-client.js';
import type { ConversationClientConfig, ConversationsState } from './types.js';
import { ConnectionSuspendedError } from '../connection/index.js';
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

/** The server's own refusal text, verbatim — the string that must not escape. */
const SERVER_MESSAGE = 'Invalid publishable key';

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

/** Drives a refusal exactly as the server produces it: error frame, then 1008. */
async function refuse(h: Harness, message = SERVER_MESSAGE): Promise<void> {
  h.sockets.last.open();
  h.sockets.last.emitJson({
    v: 1,
    t: 'error',
    id: ulid(1),
    ts: 0,
    d: { code: 'AUTH_INVALID', message, retryable: false },
  });
  h.sockets.last.emitClose({ code: 1008, reason: 'authentication failed', wasClean: true });
  await tick();
}

/**
 * Drives refusals until the controller gives up, and returns what `connect()`
 * threw.
 *
 * ONE refusal is not enough and that is the point: `AuthBackoffPolicy` retries,
 * and only the third consecutive auth failure suspends
 * (`controller.ts:873` — "three of them in a row suspend"). Each retry opens a
 * NEW socket, so every pass must refuse `sockets.last`, and the manual clock
 * has to be advanced past the backoff or the retry never fires. Advancing
 * generously rather than by the exact policy delays keeps this test from
 * pinning numbers it is not about.
 */
async function connectAndExhaust(
  h: Harness,
  message = SERVER_MESSAGE,
): Promise<{ client: ReturnType<typeof createConversationClient>; error: unknown }> {
  const client = createConversationClient(h.config);
  const settled = client.connect().then(
    () => null,
    (e: unknown) => e,
  );

  let done = false;
  void settled.then(() => {
    done = true;
  });

  await tick();
  for (let attempt = 0; attempt < 6 && !done; attempt += 1) {
    await refuse(h, message);
    if (done) break;
    h.timers.advance(5_000);
    await tick();
  }

  return { client, error: await settled };
}

// ---------------------------------------------------------------------------
// BUG 1
// ---------------------------------------------------------------------------

describe('subscribe() — every subscriber, not just the first', () => {
  it('delivers the same ordered sequence to two independent listeners', async () => {
    const h = harness();
    const client = createConversationClient(h.config);

    const a: string[] = [];
    const b: string[] = [];
    client.subscribe((s: ConversationsState) => a.push(s.connectionState));
    client.subscribe((s: ConversationsState) => b.push(s.connectionState));

    void client.connect().catch(() => undefined);
    await tick();

    // The exact failure: `a` was populated and `b` was empty, because the
    // first callback's project() had already advanced the shared cache.
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('keeps delivering to a surviving listener after another unsubscribes', async () => {
    const h = harness();
    const client = createConversationClient(h.config);

    const kept: string[] = [];
    const dropped: string[] = [];
    client.subscribe((s: ConversationsState) => kept.push(s.connectionState));
    const off = client.subscribe((s: ConversationsState) => dropped.push(s.connectionState));

    void client.connect().catch(() => undefined);
    await tick();
    const droppedAtUnsubscribe = dropped.length;
    off();

    await refuse(h);

    expect(kept.length).toBeGreaterThan(droppedAtUnsubscribe);
    expect(dropped.length).toBe(droppedAtUnsubscribe);
  });

  it('still hands every subscriber the SAME frozen object, so reference equality holds', async () => {
    // The per-subscription `last` must not become a per-subscription
    // PROJECTION: `useSyncExternalStore` requires that two reads with no
    // intervening change return the identical reference, or React re-renders
    // forever.
    const h = harness();
    const client = createConversationClient(h.config);

    const seenByA: ConversationsState[] = [];
    const seenByB: ConversationsState[] = [];
    client.subscribe((s) => seenByA.push(s));
    client.subscribe((s) => seenByB.push(s));

    void client.connect().catch(() => undefined);
    await tick();

    expect(seenByA.length).toBe(seenByB.length);
    for (let i = 0; i < seenByA.length; i += 1) {
      expect(seenByA[i]).toBe(seenByB[i]);
      expect(Object.isFrozen(seenByA[i])).toBe(true);
    }
    // And getState() agrees with the last thing the listeners were handed.
    expect(client.getState()).toBe(seenByA[seenByA.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// BUG 2
// ---------------------------------------------------------------------------

describe("connect() rejection — scrubbed like lastError, because that is where hosts read", () => {
  it("never carries the server's message, in the error or its cause", async () => {
    const { error } = await connectAndExhaust(harness());
    expect(error).toBeInstanceOf(ConnectionSuspendedError);

    const suspended = error as ConnectionSuspendedError;
    // The controller interpolates `cause.message` into `message`, so a leak
    // shows up in BOTH places. Assert both.
    expect(suspended.message).not.toContain(SERVER_MESSAGE);
    expect(suspended.cause.message).not.toContain(SERVER_MESSAGE);
    expect(suspended.message).toContain('WS_V2_STAFF_ENABLED');
  });

  it('passes the structured facts through untouched', async () => {
    const { error } = await connectAndExhaust(harness());
    const suspended = error as ConnectionSuspendedError;

    // `reason` and `code` are what a host branches on. Rewriting prose must not
    // disturb them, or the fix has traded one lie for another.
    expect(suspended.reason).toBe('auth');
    expect(suspended.cause.code).toBe('AUTH_INVALID');
    expect(suspended.cause.retryable).toBe(false);
  });

  it('agrees with getState().lastError — one story, not two', async () => {
    const { client, error } = await connectAndExhaust(harness());
    const suspended = error as ConnectionSuspendedError;

    expect(suspended.cause.message).toBe(client.getState().lastError?.message);
  });

  it("leaves a KEYED client's message alone — it really did send a key", async () => {
    // The scrubbing is not "always rewrite"; it is "rewrite the claim that is
    // false on THIS surface". A client that sent a publishable key gets the
    // server's own text, because there the message is about something that
    // actually happened.
    const { error } = await connectAndExhaust(
      harness({ publishableKey: 'dhp_test_0123456789abcdefghijklmnopqrstuvwxyzABCD' }),
    );
    const suspended = error as ConnectionSuspendedError;

    expect(suspended.cause.message).toBe(SERVER_MESSAGE);
  });
});
