// The keyless `connection.hello`, pinned.
//
// ── The distinction this file exists to hold ─────────────────────────────
//
// The server picks its ENTIRE flow on whether `publishableKey` is PRESENT in
// the hello payload — one live session and evict-on-join if it is, N live
// sessions that accumulate if it is not. Under `exactOptionalPropertyTypes` an
// explicitly-`undefined` property and an absent one are different values, and
// they serialise differently: `JSON.stringify` drops `undefined`, so the two
// happen to agree TODAY — but only by accident of the encoder, and only until
// something in between normalises the payload.
//
// `validate.ts` rejects `''` for the same reason from the other end: a blank
// key must not become a second, quieter route into the staff branch. So this
// test asserts on `Object.keys` of the decoded payload rather than on
// `payload.publishableKey === undefined`, because the second one passes for
// both of the values that must be kept apart.

import { describe, expect, it } from 'vitest';

import { createConversationClient } from './create-conversation-client.js';
import type { ConversationClientConfig } from './types.js';
import { ManualTimers } from '../presence/index.js';
import type { ConnectionAckPayload } from '../protocol/index.js';
import { StubSocketFactory } from '../transport/index.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(n: number): string {
  const suffix = ULID_ALPHABET[n % ULID_ALPHABET.length] ?? '0';
  return `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}${suffix}`;
}

async function tick(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/**
 * The staff `connection.ack`: NO `session`, NO `seq`.
 *
 * A staff connection has resolved no session, so there is no snapshot and no
 * resume anchor to hand back. The shared validator makes both fields optional
 * precisely so this shape is admissible.
 */
function staffAckJson(idNum: number): unknown {
  const payload: ConnectionAckPayload = { protocolVersion: 1 };
  return { v: 1, t: 'connection.ack', id: ulid(idNum), ts: 0, d: payload };
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

interface HelloFrame {
  readonly v: number;
  readonly t: string;
  readonly d: Record<string, unknown>;
}

function helloOn(sockets: StubSocketFactory): HelloFrame {
  const frames = sockets.last.sentFrames() as HelloFrame[];
  const hello = frames.find((frame) => frame.t === 'connection.hello');
  if (hello === undefined) throw new Error('no connection.hello was written');
  return hello;
}

describe('GOLDEN: the keyless connection.hello', () => {
  it('OMITS publishableKey entirely rather than sending undefined', async () => {
    const h = harness();
    const client = createConversationClient(h.config);

    void client.connect().catch(() => undefined);
    await tick();
    // The hello is written when the socket opens, not when connect() is called.
    h.sockets.last.open();

    const hello = helloOn(h.sockets);

    // What this assertion actually proves, stated precisely: the key is not on
    // the wire under ANY spelling — absent, empty string, or a stray literal.
    //
    // It does NOT distinguish "absent" from "present and undefined", and no
    // post-parse assertion can: this runs after `JSON.parse`, and
    // `JSON.stringify` already dropped an `undefined`-valued property before
    // the bytes were sent. The two are indistinguishable by the time we look,
    // which is exactly why the wire is the right place to look — on the wire
    // they ARE the same thing, and that sameness is what the server sees.
    //
    // The hazard this DOES catch is `publishableKey: ''`, which survives
    // `JSON.stringify` and would reach the server as a present-but-blank key.
    // `expect(hello.d.publishableKey).toBeUndefined()` would pass for that.
    expect(Object.keys(hello.d).sort()).toEqual(['protocolVersion', 'token']);
    expect('publishableKey' in hello.d).toBe(false);

    // And on the raw text, so no assumption about how the envelope was built
    // is doing any of the work.
    expect(h.sockets.last.sent[0]).not.toContain('publishableKey');
  });

  it('reaches connected on a session-less connection.ack', async () => {
    const h = harness();
    const client = createConversationClient(h.config);

    expect(client.getState().connectionState).toBe('idle');

    const connecting = client.connect();
    await tick();
    expect(client.getState().connectionState).toBe('connecting');

    h.sockets.last.open();
    expect(client.getState().connectionState).toBe('authenticating');

    // The whole point: an ack with neither `session` nor `seq` is NOT a
    // protocol violation on a connection that sent no key. On a keyed one it
    // is, and the controller suspends — which is the customer-half contract
    // this surface deliberately does not trip.
    h.sockets.last.emitJson(staffAckJson(1));
    await connecting;
    await tick();

    expect(client.getState().connectionState).toBe('connected');
    expect(client.getState().conversations).toEqual({});
    expect(client.getState().lastError).toBeNull();
  });

  it('sends the key when one IS supplied, so the omission above is a choice and not an inability', async () => {
    const h = harness({ publishableKey: 'dhp_test_abc' });
    const client = createConversationClient(h.config);

    void client.connect().catch(() => undefined);
    await tick();
    h.sockets.last.open();

    expect(helloOn(h.sockets).d).toEqual({
      token: 'id_token_merchant',
      publishableKey: 'dhp_test_abc',
      protocolVersion: 1,
    });
  });

  it('refuses an empty publishable key instead of treating it as keyless', () => {
    // The second route into the staff branch that must not exist. `''` is a
    // configuration mistake — an unset env var read as a string — and silently
    // promoting it to "keyless staff connection" is the exact failure the
    // separate factory was chosen to prevent.
    const h = harness({ publishableKey: '' });
    expect(() => createConversationClient(h.config)).toThrow();
  });

  it('refuses a secret key with the credential error, not a format error', () => {
    const h = harness({ publishableKey: 'dhk' + '_live_CANARY-MUST-NOT-APPEAR' });
    expect(() => createConversationClient(h.config)).toThrow(/secret key/i);
  });

  it('requires wsUrl and a non-empty localSender.senderId at construction', () => {
    expect(() => createConversationClient(harness({ wsUrl: '' }).config)).toThrow(/wsUrl/);
    expect(() =>
      createConversationClient(
        harness({ localSender: { senderId: '', senderType: 'CUSTOMER' } }).config,
      ),
    ).toThrow(/senderId/);
  });

  it('disconnect() is terminal and connect() revives it', async () => {
    const h = harness();
    const client = createConversationClient(h.config);

    const connecting = client.connect();
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(staffAckJson(1));
    await connecting;
    await tick();
    expect(client.getState().connectionState).toBe('connected');

    client.disconnect();
    expect(client.getState().connectionState).toBe('closed');

    // `retryNow()` is a no-op in every state but `reconnecting` — `closed` is
    // recoverable only by an explicit `connect()`.
    expect(client.retryNow()).toBe(false);

    const reconnecting = client.connect();
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(staffAckJson(2));
    await reconnecting;
    await tick();
    expect(client.getState().connectionState).toBe('connected');

    // Two sockets, two keyless hellos. The second is what would regress if a
    // key were ever latched onto the controller after the first handshake.
    expect(h.sockets.sockets).toHaveLength(2);
    for (const socket of h.sockets.sockets) {
      expect(socket.sent[0]).not.toContain('publishableKey');
    }
  });

  it('subscribe() delivers the state changes and stops on unsubscribe', async () => {
    const h = harness();
    const client = createConversationClient(h.config);

    const seen: string[] = [];
    const unsubscribe = client.subscribe((state) => seen.push(state.connectionState));

    const connecting = client.connect();
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(staffAckJson(1));
    await connecting;
    await tick();

    expect(seen).toContain('connected');

    // Reference stability: the snapshot a listener was handed is the snapshot
    // `getState()` returns, which is what `useSyncExternalStore` requires.
    const before = client.getState();
    expect(client.getState()).toBe(before);

    unsubscribe();
    const count = seen.length;
    client.disconnect();
    await tick();
    expect(seen).toHaveLength(count);
  });
});
