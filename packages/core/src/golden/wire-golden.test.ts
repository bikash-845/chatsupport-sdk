// GOLDEN LOCK 2 of 2 — the shipped customer path's OUTBOUND WIRE TRAFFIC,
// captured as an exact ordered frame array.
//
// ── Why this file exists ─────────────────────────────────────────────────
//
// Rule 1 of the multi-role work is that a host upgrading notices nothing. Three
// of the four ways it could notice are already guarded: the public API by
// `test/invariants/public-barrel-surface.test.ts`, behaviour by
// `client/create-chat-client.e2e.test.ts`, storage by `golden/storage-golden.test.ts`.
// The fourth — what this client actually PUTS ON THE WIRE — was asserted
// nowhere as a whole. Individual tests check individual frames; none of them
// would notice a frame gaining a field, gaining a sibling, or moving.
//
// The concrete regression this exists to catch is named and specific. The party
// surface needs frames ADDRESSED with a `sessionId`, because a staff connection
// holds N joined sessions and `resolveJoinedSession` (chat-service-node
// handlers.ts:862) throws when an unaddressed frame arrives on a connection
// holding more than one. A runtime that stamps `sessionId` unconditionally —
// the obvious implementation — changes the customer's wire with every existing
// test still green, because `typing.start` today is literally `d: {}`
// (presence/typing.ts:247) and no test says so. Here it is said.
//
// ── How to read a failure ────────────────────────────────────────────────
//
// The diff IS the change to the customer wire contract. Either it was intended
// — in which case it needs a server that accepts it and a note in the
// breaking-change ledger — or a party-surface change leaked across into the
// customer path, which is the thing rule 1 forbids outright.
//
// ── What is normalised, and what deliberately is not ─────────────────────
//
// `id` is a ULID over an injectable-but-random suffix, so it cannot be pinned
// literally. It is replaced by `#0`, `#1`, … in FIRST-APPEARANCE order across
// the whole run rather than being erased — that keeps the property that
// actually matters visible: an offline send replayed after a reconnect must
// reuse its ORIGINAL id (D1/§9.3), which shows up here as the same `#n` on two
// different sockets. Everything else — `v`, `t`, `ts`, and the entire `d`
// payload — is compared verbatim. `ts` is deterministic because every clock in
// the harness is `ManualTimers`.

import { describe, expect, it } from 'vitest';

import { createChatClient } from '../client/index.js';
import type { ChatClient, ChatClientConfig } from '../client/index.js';
import type { MessageHistorySource, MessagePage } from '../messages/index.js';
import { ManualTimers } from '../presence/index.js';
import type { ConnectionAckPayload, MessagePayload, SessionSnapshot } from '../protocol/index.js';
import { MemoryStorageAdapter } from '../storage/index.js';
import { CLOSE_CODE, StubSocketFactory } from '../transport/index.js';

const CUSTOMER_ID = 'participant_customer_1';
const AGENT_ID = 'participant_agent_1';

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

function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session_1',
    status: 'ASSIGNED',
    mode: 'HUMAN',
    participants: [
      { participantId: CUSTOMER_ID, type: 'CUSTOMER' },
      { participantId: AGENT_ID, type: 'AGENT' },
    ],
    createdAt: '2026-09-06T09:00:00.000Z',
    ...overrides,
  };
}

function ackJson(seq: number, idNum: number, session = sessionSnapshot()): unknown {
  const payload: ConnectionAckPayload = { protocolVersion: 1, session, seq };
  return { v: 1, t: 'connection.ack', id: ulid(idNum), ts: 0, d: payload };
}

function genericAckJson(ref: string, idNum: number, extra: Record<string, unknown> = {}): unknown {
  return { v: 1, t: 'ack', id: ulid(idNum), ref, ts: 0, d: { ok: true, ...extra } };
}

function messageNewJson(idNum: number, seq: number): unknown {
  const payload: MessagePayload = {
    id: ulid(idNum),
    sessionId: 'session_1',
    senderId: AGENT_ID,
    senderType: 'AGENT',
    type: 'TEXT',
    content: 'hi from the agent',
    seq,
    createdAt: '2026-09-06T10:00:00.000Z',
  };
  return { v: 1, t: 'message.new', id: ulid(idNum), ts: 0, d: payload };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface RawFrame {
  readonly v: number;
  readonly t: string;
  readonly id: string;
  readonly ts: number;
  readonly d: unknown;
}

/**
 * Every frame every socket in the run sent, in order, with `id` replaced by a
 * stable `#n` token assigned on first appearance across the whole run.
 *
 * Sockets are separated by a `'--- socket N ---'` marker so a frame moving
 * from one connection to another is a visible diff rather than an invisible
 * reordering.
 */
function capture(sockets: StubSocketFactory): string[] {
  const ids = new Map<string, string>();
  const token = (id: string): string => {
    const existing = ids.get(id);
    if (existing !== undefined) return existing;
    const next = `#${ids.size}`;
    ids.set(id, next);
    return next;
  };

  const out: string[] = [];
  sockets.sockets.forEach((socket, index) => {
    out.push(`--- socket ${index} ---`);
    for (const raw of socket.sent) {
      const frame = JSON.parse(raw) as RawFrame;
      out.push(
        JSON.stringify({ v: frame.v, t: frame.t, id: token(frame.id), ts: frame.ts, d: frame.d }),
      );
    }
  });
  return out;
}

interface Harness {
  readonly sockets: StubSocketFactory;
  readonly timers: ManualTimers;
  readonly client: ChatClient;
}

function harness(storage = new MemoryStorageAdapter()): Harness {
  const sockets = new StubSocketFactory();
  const timers = new ManualTimers();

  const config: ChatClientConfig = {
    publishableKey: 'dhp_test_abc',
    getToken: async () => 'tok_golden',
    wsUrl: 'wss://example.test/chat-services/v2/ws',
    storage,
    localSender: { senderId: CUSTOMER_ID, senderType: 'CUSTOMER' },
    history: new FakeHistory(),
    webSocketFactory: sockets.create,
    schedule: timers.schedule,
    now: timers.clock,
  };

  return { sockets, timers, client: createChatClient(config) };
}

// ---------------------------------------------------------------------------

describe('GOLDEN: the shipped customer outbound wire', () => {
  it('emits exactly this ordered frame array for a scripted customer session', async () => {
    const h = harness();

    // ---- connect -> connection.hello ----
    const connecting = h.client.connect();
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(ackJson(0, 1));
    await connecting;
    await tick();

    // ---- presence ----
    h.client.setPresence('ONLINE');
    await tick();

    // ---- typing ----
    h.client.startTyping();
    await tick();

    // ---- send ----
    const sending = h.client.sendMessage('hello agent');
    await tick();
    const sent = h.sockets.last.sentFrames() as RawFrame[];
    const sendFrame = sent.find((frame) => frame.t === 'message.send');
    h.sockets.last.emitJson(genericAckJson(sendFrame?.id as string, 2, { seq: 1 }));
    await sending;
    await tick();

    h.client.stopTyping();
    await tick();

    // ---- inbound message -> automatic delivery watermark ----
    h.sockets.last.emitJson(messageNewJson(3, 2));
    await tick();

    // ---- read watermark ----
    h.client.markRead();
    await tick();

    // ---- request a human ----
    h.client.requestAgent('need help');
    await tick();

    // ---- presence query ----
    h.client.queryPresence([AGENT_ID]);
    await tick();

    // ---- join a different session ----
    h.client.joinSession('session_2');
    await tick();

    // Recorded from HEAD d2adfdc. Four facts in here are load-bearing and are
    // easy to lose by accident, so they are called out rather than left to be
    // rediscovered from a diff:
    //
    //  1. `message.send` IS addressed — `sessionId` is stamped by
    //     `messages/controller.ts:636` as defence in depth against a send
    //     landing in a session this connection is no longer joined to. It is
    //     the ONLY client frame `createChatClient` addresses.
    //  2. `typing.start`, `typing.stop` and `message.markRead` are `d:{}`.
    //     That is the regression this file is here for.
    //  3. `message.markDelivered` does NOT appear. Core never emits it on its
    //     own: `WatermarkTracker.markDelivered` is not on `ChatClient` at all
    //     and a binding has to wire it (`watermarks.ts:337-348`). "Rendered"
    //     is a DOM question core cannot answer.
    //  4. `system.heartbeat` does not appear because the clock never reaches
    //     the heartbeat interval here — a timer advance would add one, so a
    //     future edit that advances time must expect it rather than delete it.
    expect(capture(h.sockets)).toEqual([
      '--- socket 0 ---',
      '{"v":1,"t":"connection.hello","id":"#0","ts":0,"d":{"token":"tok_golden","publishableKey":"dhp_test_abc","protocolVersion":1}}',
      '{"v":1,"t":"presence.set","id":"#1","ts":0,"d":{"status":"ONLINE"}}',
      '{"v":1,"t":"typing.start","id":"#2","ts":0,"d":{}}',
      '{"v":1,"t":"message.send","id":"#3","ts":0,"d":{"content":"hello agent","type":"TEXT","sessionId":"session_1"}}',
      '{"v":1,"t":"typing.stop","id":"#4","ts":0,"d":{}}',
      '{"v":1,"t":"message.markRead","id":"#5","ts":0,"d":{}}',
      '{"v":1,"t":"session.requestAgent","id":"#6","ts":0,"d":{"reason":"need help"}}',
      '{"v":1,"t":"presence.query","id":"#7","ts":0,"d":{"participantIds":["participant_agent_1"]}}',
      '{"v":1,"t":"session.join","id":"#8","ts":0,"d":{"sessionId":"session_2"}}',
    ]);
  });

  it('replays an offline send on the new socket under its ORIGINAL id, and sends nothing else', async () => {
    const h = harness();

    const connecting = h.client.connect();
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(ackJson(0, 1));
    await connecting;
    await tick();

    // Drop the socket, type while offline, reconnect.
    h.sockets.last.emitClose({ code: CLOSE_CODE.ABNORMAL, reason: '', wasClean: false });
    await tick();

    void h.client.sendMessage('typed while offline').catch(() => undefined);
    await tick();

    // The id the optimistic row was created under, before any socket saw it.
    const queuedId = h.client.getState().messages[0]?.id;
    expect(queuedId).toBeDefined();

    h.timers.advance(1000);
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(ackJson(0, 2));
    await tick();

    // D1/§9.3: the replay reuses the ORIGINAL ULID, so a server that already
    // persisted the frame dedupes instead of double-sending. Asserted on the
    // raw id rather than the `#n` token, because the token is only unique
    // within the capture and this identity crosses out of it.
    const replayed = (h.sockets.last.sentFrames() as RawFrame[]).find(
      (frame) => frame.t === 'message.send',
    );
    expect(replayed?.id).toBe(queuedId);

    expect(capture(h.sockets)).toEqual([
      '--- socket 0 ---',
      '{"v":1,"t":"connection.hello","id":"#0","ts":0,"d":{"token":"tok_golden","publishableKey":"dhp_test_abc","protocolVersion":1}}',
      '--- socket 1 ---',
      '{"v":1,"t":"connection.hello","id":"#1","ts":1000,"d":{"token":"tok_golden","publishableKey":"dhp_test_abc","resumeFrom":0,"protocolVersion":1}}',
      '{"v":1,"t":"message.send","id":"#2","ts":1000,"d":{"content":"typed while offline","type":"TEXT","sessionId":"session_1"}}',
    ]);
  });

  it('never puts a sessionId on typing.start, typing.stop or message.markRead', async () => {
    // The single most important assertion in this file, restated on its own so
    // it survives a future edit that legitimately re-records the arrays above.
    // The party surface addresses these three frames; the customer surface
    // must not start doing so.
    const h = harness();

    const connecting = h.client.connect();
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(ackJson(0, 1));
    await connecting;
    await tick();

    h.client.startTyping();
    await tick();
    h.client.stopTyping();
    await tick();

    // `markRead()` writes nothing and sends nothing when the watermark cannot
    // advance, so there has to be something unread for the frame to exist at
    // all — an inbound message, exactly as in a real session.
    h.sockets.last.emitJson(messageNewJson(3, 2));
    await tick();
    h.client.markRead();
    await tick();

    const unaddressed = (h.sockets.last.sentFrames() as RawFrame[]).filter((frame) =>
      ['typing.start', 'typing.stop', 'message.markRead'].includes(frame.t),
    );

    expect(unaddressed.map((frame) => frame.t)).toEqual([
      'typing.start',
      'typing.stop',
      'message.markRead',
    ]);
    for (const frame of unaddressed) {
      expect(frame.d).toEqual({});
    }
  });
});
