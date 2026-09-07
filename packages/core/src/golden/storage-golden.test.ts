// GOLDEN LOCK 1 of 2 — the shipped customer path's STORAGE KEYSPACE, pinned as
// literal strings.
//
// ── Why this file exists ─────────────────────────────────────────────────
//
// The multi-role/party work adds a second front door (`createConversationClient`)
// that computes its own storage root from host-supplied config. The binding
// requirement on that work is that the SHIPPED customer path is completely
// unaffected: same public API, same behaviour, same storage keys, same wire
// traffic. Two of those four are already covered by the existing suite
// (behaviour by `create-chat-client.e2e.test.ts`, API shape by
// `test/invariants/public-barrel-surface.test.ts`). The keyspace and the wire
// were not — and they are the two that move SILENTLY. A client that re-keys
// its send queue still passes every behavioural test in this repo, because
// every one of them constructs a fresh store; the loss shows up only on a real
// user's next reload, as a message they believe they sent and that is gone.
//
// So this file writes the keys out as literal strings. Not derived from
// `namespaced()`, not rebuilt from `encodeNamespaceSegment`, not compared
// against a constant imported from the code under test — spelled out, the way
// `storage/namespace.test.ts:31` spells out `'_'`. A test that recomputes the
// key from the same source that produced it passes no matter what that source
// does, which is the whole failure mode here.
//
// The cross-language half of the same lock is already in the tree and is
// deliberately left alone: `packages/flutter/test/storage/chat_storage_test.dart`
// and `consent_gate_test.dart` hard-code these same prefixes from the other
// side of the port. Between them and this file, a keyspace move has to be made
// twice, in two languages, by two people, to go unnoticed.
//
// ── What a failure here means ────────────────────────────────────────────
//
// NOT "update the expected strings". Every one of these keys is live in some
// host's browser right now. If this test fails, a running install's send queue
// and remembered session have been orphaned, and the change that did it needs
// a migration or needs reverting.

import { describe, expect, it } from 'vitest';

import { createChatClient } from '../client/index.js';
import type { ChatClientConfig } from '../client/index.js';
import type { MessageHistorySource, MessagePage } from '../messages/index.js';
import { ManualTimers } from '../presence/index.js';
import type { ConnectionAckPayload, SessionSnapshot } from '../protocol/index.js';
import { MemoryStorageAdapter } from '../storage/index.js';
import type { StorageAdapter } from '../storage/index.js';
import { StubSocketFactory } from '../transport/index.js';

// ---------------------------------------------------------------------------
// The literals. Typed out once, referenced everywhere below.
// ---------------------------------------------------------------------------

/** A publishable key whose parsed brand is byte-identical to the input. */
const PUBLISHABLE_KEY = 'dhp_test_abc';

/** A sender id that needs no percent-encoding, so the key is readable at a glance. */
const SENDER_ID = 'u_1';

const SEND_QUEUE_KEY = 'chatsdk:dhp_test_abc:u_1:sendQueue';
const SELECTED_SESSION_KEY = 'chatsdk:dhp_test_abc:u_1:selectedSession';

// ---------------------------------------------------------------------------
// A StorageAdapter that records the literal key of every operation.
//
// `MemoryStorageAdapter` is the real backing store — this only wraps it, so
// the client under test gets genuine read-back semantics and the recorder
// cannot change what the code does.
// ---------------------------------------------------------------------------

class RecordingStorageAdapter implements StorageAdapter {
  readonly gets: string[] = [];
  readonly sets: string[] = [];
  readonly removes: string[] = [];

  readonly #backing: MemoryStorageAdapter;

  constructor(backing = new MemoryStorageAdapter()) {
    this.#backing = backing;
  }

  /** Every distinct key this adapter was asked about, sorted. */
  get touched(): string[] {
    return [...new Set([...this.gets, ...this.sets, ...this.removes])].sort();
  }

  get(key: string): Promise<string | null> {
    this.gets.push(key);
    return this.#backing.get(key);
  }

  set(key: string, value: string): Promise<void> {
    this.sets.push(key);
    return this.#backing.set(key, value);
  }

  remove(key: string): Promise<void> {
    this.removes.push(key);
    return this.#backing.remove(key);
  }
}

// ---------------------------------------------------------------------------
// Harness — the SAME shape a host writes, with NO opt-in of any kind.
// ---------------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(n: number): string {
  const suffix = ULID_ALPHABET[n % ULID_ALPHABET.length] ?? '0';
  return `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}${suffix}`;
}

async function tick(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

class FakeHistory implements MessageHistorySource {
  async listMessages(): Promise<MessagePage> {
    return { messages: [], hasMore: false };
  }
}

function sessionSnapshot(): SessionSnapshot {
  return {
    sessionId: 'session_golden',
    status: 'ASSIGNED',
    mode: 'HUMAN',
    participants: [{ participantId: SENDER_ID, type: 'CUSTOMER' }],
    createdAt: '2026-09-06T09:00:00.000Z',
  };
}

function ackJson(idNum: number): unknown {
  const payload: ConnectionAckPayload = { protocolVersion: 1, session: sessionSnapshot(), seq: 0 };
  return { v: 1, t: 'connection.ack', id: ulid(idNum), ts: 0, d: payload };
}

interface Harness {
  readonly sockets: StubSocketFactory;
  readonly timers: ManualTimers;
  readonly config: ChatClientConfig;
}

/**
 * The minimum a real host passes. No namespace override, no scope, no identity
 * sync — nothing that could be read as "this install asked for a different
 * keyspace". `storage` is the recorder, which is the one seam every existing
 * test in this repo also uses and which cannot change what key is computed.
 */
function harness(storage: StorageAdapter, senderId = SENDER_ID): Harness {
  const sockets = new StubSocketFactory();
  const timers = new ManualTimers();

  return {
    sockets,
    timers,
    config: {
      publishableKey: PUBLISHABLE_KEY,
      getToken: async () => 'tok_golden',
      wsUrl: 'wss://example.test/chat-services/v2/ws',
      storage,
      localSender: { senderId, senderType: 'CUSTOMER' },
      history: new FakeHistory(),
      webSocketFactory: sockets.create,
      schedule: timers.schedule,
      now: timers.clock,
    },
  };
}

/** Connects, acks with a LIVE session, then queues one message offline. */
async function driveOrdinaryCustomerSession(h: Harness, storage: RecordingStorageAdapter): Promise<void> {
  const client = createChatClient(h.config);

  const connecting = client.connect();
  await tick();
  h.sockets.last.open();
  h.sockets.last.emitJson(ackJson(1));
  await connecting;
  await tick();

  // A send that is acked immediately is written and cleared again too fast to
  // be a stable observation, so the queue write is provoked the way a real
  // user provokes it: by being disconnected when they press send.
  client.disconnect();
  await tick();
  void client.sendMessage('golden').catch(() => undefined);
  await tick();

  expect(storage.sets.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------

describe('GOLDEN: the shipped customer storage keyspace', () => {
  it('writes exactly chatsdk:dhp_test_abc:u_1:sendQueue and chatsdk:dhp_test_abc:u_1:selectedSession', async () => {
    const storage = new RecordingStorageAdapter();
    const h = harness(storage);

    await driveOrdinaryCustomerSession(h, storage);

    // The two writes, as literal strings, and NOTHING else was written.
    expect([...new Set(storage.sets)].sort()).toEqual([
      'chatsdk:dhp_test_abc:u_1:selectedSession',
      'chatsdk:dhp_test_abc:u_1:sendQueue',
    ]);

    // And nothing else was so much as READ. A key that is read today is a key
    // some future version may write; the whole namespace is pinned, not just
    // the write side.
    expect(storage.touched).toEqual([
      'chatsdk:dhp_test_abc:u_1:selectedSession',
      'chatsdk:dhp_test_abc:u_1:sendQueue',
    ]);
  });

  it('names the two keys with no interpolation, so a moved namespace cannot pass', async () => {
    const storage = new RecordingStorageAdapter();
    const h = harness(storage);

    await driveOrdinaryCustomerSession(h, storage);

    expect(storage.sets).toContain(SEND_QUEUE_KEY);
    expect(storage.sets).toContain(SELECTED_SESSION_KEY);

    // Restated positionally: four segments, colon-delimited, in this order.
    // Spelled out so a change that keeps the same PIECES but reorders or drops
    // one (`chatsdk:u_1:dhp_test_abc:sendQueue`, `chatsdk:dhp_test_abc:sendQueue`)
    // is a failure and not a pass.
    expect(SEND_QUEUE_KEY.split(':')).toEqual(['chatsdk', 'dhp_test_abc', 'u_1', 'sendQueue']);
    expect(SELECTED_SESSION_KEY.split(':')).toEqual(['chatsdk', 'dhp_test_abc', 'u_1', 'selectedSession']);
  });

  it('persists the queue at the pinned key with a value an old build can still decode', async () => {
    const backing = new MemoryStorageAdapter();
    const storage = new RecordingStorageAdapter(backing);
    const h = harness(storage);

    await driveOrdinaryCustomerSession(h, storage);

    // Read straight out of the UNWRAPPED backing store by the literal key. If
    // the namespace moved, this is null.
    const raw = await backing.get(SEND_QUEUE_KEY);
    expect(raw).not.toBeNull();

    // QUEUE_SCHEMA_VERSION is 1 (queue/codec.ts) and must stay 1: a blob
    // written by the shipped build has to decode under the next one.
    expect(JSON.parse(raw as string)).toMatchObject({ v: 1 });

    expect(await backing.get(SELECTED_SESSION_KEY)).toBe('session_golden');
  });

  // The two-identities-one-store pattern of storage/namespace.test.ts:37-53,
  // raised from `namespaced()` to the front door: the isolation that test
  // proves about the helper is only worth anything if `createChatClient` is
  // still composing the helper the same way.
  it('two identities against one backing store cannot read or overwrite each other', async () => {
    const backing = new MemoryStorageAdapter();

    const guestStorage = new RecordingStorageAdapter(backing);
    const guest = harness(guestStorage, 'guest_1');
    await driveOrdinaryCustomerSession(guest, guestStorage);

    const userStorage = new RecordingStorageAdapter(backing);
    const user = harness(userStorage, '12961');
    await driveOrdinaryCustomerSession(user, userStorage);

    // Distinct keys, both live, neither overwritten by the other.
    const guestQueue = await backing.get('chatsdk:dhp_test_abc:guest_1:sendQueue');
    const userQueue = await backing.get('chatsdk:dhp_test_abc:12961:sendQueue');
    expect(guestQueue).not.toBeNull();
    expect(userQueue).not.toBeNull();

    // Neither client ever named the other's key.
    expect(guestStorage.touched.every((key) => key.startsWith('chatsdk:dhp_test_abc:guest_1:'))).toBe(true);
    expect(userStorage.touched.every((key) => key.startsWith('chatsdk:dhp_test_abc:12961:'))).toBe(true);
  });

  it('percent-encodes a delimiter-bearing sender id into the third segment, unchanged', async () => {
    // `auth0:1234` is a real identifier format and `namespaced()` rejects a raw
    // colon. The encoding it goes through is part of the live keyspace, so it
    // is pinned as a literal too.
    const backing = new MemoryStorageAdapter();
    const storage = new RecordingStorageAdapter(backing);
    const h = harness(storage, 'auth0:1234');

    await driveOrdinaryCustomerSession(h, storage);

    expect(storage.sets).toContain('chatsdk:dhp_test_abc:auth0%3A1234:sendQueue');
    expect(await backing.get('chatsdk:dhp_test_abc:auth0%3A1234:sendQueue')).not.toBeNull();
  });
});
