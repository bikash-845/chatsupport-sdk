// ONE live conversation on the keyless connection, driven over the real
// transport.
//
// Everything below goes through `StubSocketFactory`, so the assertions are on
// the BYTES this surface writes and on the state a real inbound frame produces
// — not on a hand-driven fake of the layer under test. That matters most for
// the addressing decision: "typing.start carries a sessionId" is a claim about
// the wire, and only the wire can settle it.

import { describe, expect, it, vi } from 'vitest';

import { createConversationClient } from './create-conversation-client.js';
import { addressOf, addressed } from './addressing.js';
import { ConversationJoinError, ConversationNotOpenError } from './errors.js';
import { ConversationRuntime } from './runtime.js';
import type { ConversationClient, ConversationClientConfig } from './types.js';
import type { MessageHistorySource, MessagePage } from '../messages/index.js';
import { ManualTimers } from '../presence/index.js';
import type { OutboundIntent } from '../presence/index.js';
import type {
  ConnectionAckPayload,
  MessagePayload,
  SessionSnapshot,
  ServerPushFrame,
} from '../protocol/index.js';
import { StubSocketFactory } from '../transport/index.js';
import type { StubWebSocket } from '../transport/index.js';
import type { ChatState } from '../state/index.js';

const SESSION = 'session_alpha';
const OTHER_SESSION = 'session_beta';
const STAFF_ID = 'agent_7';
const CUSTOMER_ID = 'participant_customer_1';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(n: number): string {
  const suffix = ULID_ALPHABET[n % ULID_ALPHABET.length] ?? '0';
  return `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}${suffix}`;
}

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** `Array.prototype.at` needs the es2022 lib; this repo targets es2020. */
function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// Wire fixtures
// ---------------------------------------------------------------------------

/** The STAFF handshake answer: no `session`, no `seq`. */
function staffAckJson(idNum = 0): unknown {
  const payload: ConnectionAckPayload = { protocolVersion: 1 };
  return { v: 1, t: 'connection.ack', id: ulid(idNum), ts: 0, d: payload };
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION,
    status: 'ASSIGNED',
    mode: 'HUMAN',
    participants: [
      { participantId: CUSTOMER_ID, type: 'CUSTOMER', displayName: 'Ada' },
      { participantId: STAFF_ID, type: 'AGENT' },
    ],
    createdAt: '2026-09-06T09:00:00.000Z',
    ...overrides,
  };
}

function sessionUpdatedJson(idNum: number, session = snapshot()): unknown {
  return { v: 1, t: 'session.updated', id: ulid(idNum), ts: 0, d: { session } };
}

function ackOkJson(ref: string, idNum: number, extra: Record<string, unknown> = {}): unknown {
  return { v: 1, t: 'ack', id: ulid(idNum), ref, ts: 0, d: { ok: true, ...extra } };
}

function ackErrorJson(ref: string, idNum: number, code = 'SESSION_NOT_FOUND'): unknown {
  return {
    v: 1,
    t: 'ack',
    id: ulid(idNum),
    ref,
    ts: 0,
    d: { ok: false, error: { code, message: 'Chat session not found', retryable: false } },
  };
}

function messageNewPayload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    id: ulid(9),
    sessionId: SESSION,
    senderId: CUSTOMER_ID,
    senderType: 'CUSTOMER',
    type: 'TEXT',
    content: 'is anyone there?',
    seq: 12,
    createdAt: '2026-09-06T10:00:00.000Z',
    ...overrides,
  };
}

function messageNewJson(idNum: number, overrides: Partial<MessagePayload> = {}): unknown {
  return {
    v: 1,
    t: 'message.new',
    id: ulid(idNum),
    ts: 0,
    d: messageNewPayload({ id: ulid(idNum), ...overrides }),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RawFrame {
  readonly t: string;
  readonly id: string;
  readonly d: Record<string, unknown>;
}

function sent(socket: StubWebSocket): RawFrame[] {
  return socket.sentFrames() as RawFrame[];
}

function firstOfType(socket: StubWebSocket, t: string): RawFrame {
  const frame = sent(socket).find((f) => f.t === t);
  if (frame === undefined) throw new Error(`no ${t} frame was written`);
  return frame;
}

class RecordingHistory implements MessageHistorySource {
  readonly queries: { sessionId: string; before?: string; limit: number }[] = [];
  page: MessagePage = { messages: [], hasMore: false };

  async listMessages(query: {
    sessionId: string;
    before?: string;
    limit: number;
  }): Promise<MessagePage> {
    this.queries.push(query);
    return this.page;
  }
}

interface Harness {
  readonly sockets: StubSocketFactory;
  readonly timers: ManualTimers;
  readonly history: RecordingHistory;
  readonly logs: { level: string; message: string }[];
  readonly client: ConversationClient;
}

function harness(overrides: Partial<ConversationClientConfig> = {}): Harness {
  const sockets = new StubSocketFactory();
  const timers = new ManualTimers();
  const history = new RecordingHistory();
  const logs: { level: string; message: string }[] = [];

  const config: ConversationClientConfig = {
    wsUrl: 'wss://example.test/chat-services/v2/ws',
    getToken: async () => 'id_token_admin',
    localSender: { senderId: STAFF_ID, senderType: 'AGENT' },
    history,
    webSocketFactory: sockets.create,
    schedule: timers.schedule,
    now: timers.clock,
    logger: (level, message) => logs.push({ level, message }),
    ...overrides,
  };

  return { sockets, timers, history, logs, client: createConversationClient(config) };
}

/** Boots to `connected` on a session-less staff ack. */
async function connect(h: Harness): Promise<void> {
  const connecting = h.client.connect();
  await tick();
  h.sockets.last.open();
  h.sockets.last.emitJson(staffAckJson(0));
  await connecting;
  await tick();
}

/**
 * Drives one full `open()`: join frame -> ack -> pushed snapshot.
 *
 * The two inbound frames are emitted in the order the server writes them
 * (`handlers.ts:1927-1932`: `ackOk` then `pushFrame('session.updated')`).
 */
async function open(
  h: Harness,
  sessionId = SESSION,
  ackExtra: Record<string, unknown> = { seq: 7 },
): Promise<RawFrame> {
  const opening = h.client.open({ conversationId: sessionId });
  await tick();

  const join = last(sent(h.sockets.last).filter((f) => f.t === 'session.join'));
  if (join === undefined) throw new Error('no session.join frame was written');

  h.sockets.last.emitJson(ackOkJson(join.id, 30, ackExtra));
  h.sockets.last.emitJson(sessionUpdatedJson(31, snapshot({ sessionId })));
  await opening;
  await tick();
  return join;
}

function row(h: Harness, sessionId = SESSION): ChatState {
  const state = h.client.getState().conversations[sessionId];
  if (state === undefined) throw new Error(`no conversation row for ${sessionId}`);
  return state;
}

// ===========================================================================
// open() — the join round trip
// ===========================================================================

describe('open() — session.join, its ack, and the snapshot that follows', () => {
  it('sends session.join addressed to the conversation, with NO resumeFrom on a first join', async () => {
    const h = harness();
    await connect(h);
    const join = await open(h);

    // `resumeFrom` OMITTED, not `undefined`: the server plans an absent cursor
    // as `fresh` and replays nothing, and an explicitly-undefined property is a
    // different value under `exactOptionalPropertyTypes` that only serialises
    // the same by accident of the encoder.
    expect(join.d).toEqual({ sessionId: SESSION });
    expect('resumeFrom' in join.d).toBe(false);
  });

  it('carries the ack seq back as resumeFrom when the connection re-joins', async () => {
    const h = harness();
    await connect(h);
    await open(h, SESSION, { seq: 41 });

    // Drop the socket and let the backoff reconnect. The server-side join went
    // with the old socket, so the conversation has to re-join itself — and the
    // whole point of a PER-SESSION anchor is that it can say where from.
    h.sockets.last.emitClose({ code: 1006, reason: '', wasClean: false });
    await tick();
    h.timers.advance(5_000);
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(staffAckJson(1));
    await tick();

    const rejoin = firstOfType(h.sockets.last, 'session.join');
    expect(rejoin.d).toEqual({ sessionId: SESSION, resumeFrom: 41 });
  });

  it('applies the ack replay BEFORE adopting its seq as the anchor', async () => {
    const h = harness();
    await connect(h);

    // A replayed message with a seq ABOVE the ack's own anchor. Adopting the
    // anchor first and then applying the replay would leave the next re-join
    // asking to resume from a point behind a frame it already holds.
    await open(h, SESSION, {
      seq: 5,
      replay: [messageNewJson(11, { seq: 9, content: 'missed while away' })],
    });

    expect(row(h).messages.map((m) => m.content)).toEqual(['missed while away']);

    h.sockets.last.emitClose({ code: 1006, reason: '', wasClean: false });
    await tick();
    h.timers.advance(5_000);
    await tick();
    h.sockets.last.open();
    h.sockets.last.emitJson(staffAckJson(2));
    await tick();

    expect(firstOfType(h.sockets.last, 'session.join').d).toEqual({
      sessionId: SESSION,
      resumeFrom: 9,
    });
  });

  it('drops a malformed frame from the replay instead of failing the whole join', async () => {
    const h = harness();
    await connect(h);

    await open(h, SESSION, {
      seq: 3,
      replay: [{ v: 1, t: 'message.new', id: 'not-a-ulid', ts: 0, d: {} }],
    });

    expect(row(h).messages).toEqual([]);
    expect(h.logs.some((l) => l.message.includes('malformed frame from a session.join replay'))).toBe(
      true,
    );
  });

  it('is idempotent — a second open() sends no second session.join', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    await h.client.open({ conversationId: SESSION });
    await tick();

    expect(sent(h.sockets.last).filter((f) => f.t === 'session.join')).toHaveLength(1);
  });

  it('rejects with ConversationJoinError, and holds NO row, when the server refuses', async () => {
    const h = harness();
    await connect(h);

    const opening = h.client.open({ conversationId: SESSION });
    const settled = opening.catch((e: unknown) => e);
    await tick();

    h.sockets.last.emitJson(ackErrorJson(firstOfType(h.sockets.last, 'session.join').id, 32));
    const error = await settled;

    expect(error).toBeInstanceOf(ConversationJoinError);
    expect((error as ConversationJoinError).reason).toBe('refused');
    expect((error as ConversationJoinError).code).toBe('SESSION_NOT_FOUND');
    expect((error as ConversationJoinError).conversationId).toBe(SESSION);
    // Fails closed: a conversation that could not be joined leaves nothing
    // half-open for a caller to read as though it were live.
    expect(h.client.getState().conversations).toEqual({});
  });

  it('rejects when the join acks but no snapshot follows', async () => {
    const h = harness();
    await connect(h);

    const settled = h.client.open({ conversationId: SESSION }).catch((e: unknown) => e);
    await tick();
    h.sockets.last.emitJson(ackOkJson(firstOfType(h.sockets.last, 'session.join').id, 33, { seq: 1 }));
    await tick();

    h.timers.advance(10_000);
    const error = await settled;

    expect(error).toBeInstanceOf(ConversationJoinError);
    expect((error as ConversationJoinError).reason).toBe('noSnapshot');
  });
});

// ===========================================================================
// The row itself
// ===========================================================================

describe('conversations[id] — a complete, deeply frozen ChatState', () => {
  it('holds all twelve §6.4 fields, with connectionState fanned in', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    expect(Object.keys(row(h)).sort()).toEqual(
      [
        'connectionState',
        'deliveredWatermarks',
        'lastError',
        'messages',
        'pagination',
        'pastSessions',
        'presence',
        'readWatermarks',
        'session',
        'typing',
        'unreadCount',
        'uploading',
      ].sort(),
    );

    // The ONE connection, mirrored into the row — not a per-conversation fact.
    expect(row(h).connectionState).toBe('connected');
    expect(row(h).session?.id).toBe(SESSION);
    expect(row(h).session?.status).toBe('ASSIGNED');
    // Honest about what a party row cannot have: the customer session picker's
    // data source stays empty here, permanently.
    expect(row(h).pastSessions).toEqual([]);
  });

  it('is frozen all the way down — mutating messages throws', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    const state = h.client.getState();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.conversations)).toBe(true);
    expect(Object.isFrozen(row(h))).toBe(true);
    expect(Object.isFrozen(row(h).messages)).toBe(true);

    expect(() => {
      (row(h).messages as unknown as { push: (m: unknown) => void }).push({});
    }).toThrow(TypeError);
    expect(() => {
      (state.conversations as Record<string, unknown>)['injected'] = {};
    }).toThrow(TypeError);
  });

  it('is reference-stable across reads when nothing changed', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    expect(h.client.getState()).toBe(h.client.getState());
    expect(h.client.getState().conversations).toBe(h.client.getState().conversations);
  });

  it('wakes subscribers ONCE for a burst of changes in one synchronous run', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    const wakes: number[] = [];
    h.client.subscribe(() => wakes.push(1));

    h.sockets.last.emitJson(messageNewJson(12, { seq: 20, content: 'one' }));
    h.sockets.last.emitJson(messageNewJson(13, { seq: 21, content: 'two' }));
    await tick();

    expect(wakes).toHaveLength(1);
    expect(row(h).messages).toHaveLength(2);
  });
});

// ===========================================================================
// History
// ===========================================================================

describe('history — page one through the injected seam, and no HTTP of core own', () => {
  it('reads page one for the conversation, with no `before` cursor', async () => {
    const h = harness();
    await connect(h);
    h.history.page = {
      messages: [
        {
          id: ulid(20),
          sessionId: SESSION,
          senderId: CUSTOMER_ID,
          senderType: 'CUSTOMER',
          type: 'TEXT',
          content: 'older message',
          seq: 3,
          createdAt: '2026-09-06T08:00:00.000Z',
        },
      ],
      hasMore: true,
    };
    await open(h);

    expect(h.history.queries).toEqual([{ sessionId: SESSION, limit: 20 }]);
    expect(row(h).messages.map((m) => m.content)).toEqual(['older message']);
    expect(row(h).pagination).toEqual({ hasMore: true, loadingMore: false, initialLoaded: true });
  });

  it('honours the configured pageSize', async () => {
    const h = harness({ pageSize: 5 });
    await connect(h);
    await open(h);

    expect(h.history.queries[0]?.limit).toBe(5);
  });
});

// ===========================================================================
// Send + inbound
// ===========================================================================

describe('sendMessage — optimistic echo, addressed frame, server confirmation', () => {
  it('renders the echo immediately and addresses the wire frame to the conversation', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    void h.client.sendMessage(SESSION, 'on my way').catch(() => undefined);
    await tick();

    const echo = last(row(h).messages);
    expect(echo?.content).toBe('on my way');
    expect(echo?.senderId).toBe(STAFF_ID);
    expect(echo?.senderType).toBe('AGENT');
    expect(echo?.delivery).toEqual({ state: 'queued' });
    expect(echo?.seq).toBeUndefined();

    const send = firstOfType(h.sockets.last, 'message.send');
    expect(send.d).toEqual({ content: 'on my way', type: 'TEXT', sessionId: SESSION });
    // D1: the envelope id IS the message's permanent id, from the first render.
    expect(send.id).toBe(echo?.id);
  });

  it('clears delivery and records seq when the server acks', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    void h.client.sendMessage(SESSION, 'on my way').catch(() => undefined);
    await tick();

    const send = firstOfType(h.sockets.last, 'message.send');
    h.sockets.last.emitJson(ackOkJson(send.id, 34, { seq: 88 }));
    await tick();

    const confirmed = last(row(h).messages);
    expect(confirmed?.delivery).toBeUndefined();
    expect(confirmed?.seq).toBe(88);
  });

  it('refuses a send into a conversation that is not open', async () => {
    const h = harness();
    await connect(h);

    await expect(h.client.sendMessage(OTHER_SESSION, 'hello?')).rejects.toBeInstanceOf(
      ConversationNotOpenError,
    );
  });
});

describe('inbound message.new', () => {
  it('lands on the addressed conversation', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    h.sockets.last.emitJson(messageNewJson(14, { content: 'a real question' }));
    await tick();

    expect(row(h).messages.map((m) => m.content)).toEqual(['a real question']);

    // `unreadCount` does NOT move here, and that is inherited on purpose rather
    // than missed. `WatermarkTracker.recomputeUnreadCount` documents itself as
    // the seam "whoever applies message.new calls afterwards", and
    // `create-chat-client.ts` never calls it either — the count is recomputed
    // when a watermark commits (a snapshot, a markRead, an inbound
    // message.read). Diverging here would give one field two meanings across
    // the two surfaces; the party unread index is a later slice's work, and it
    // is the thing that will make this move.
    expect(row(h).unreadCount).toBe(0);

    // What DOES move is the read watermark once this client marks it, which is
    // the same mechanism the customer path uses.
    h.sockets.last.emitJson({
      v: 1,
      t: 'message.read',
      id: ulid(21),
      ts: 0,
      d: { participantId: CUSTOMER_ID, sessionId: SESSION, readAt: '2026-09-06T10:05:00.000Z' },
    });
    await tick();
    expect(row(h).readWatermarks[CUSTOMER_ID]).toBe('2026-09-06T10:05:00.000Z');
  });

  it('does not leak into an open conversation when it is addressed elsewhere', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    h.sockets.last.emitJson(
      messageNewJson(15, { sessionId: OTHER_SESSION, content: 'someone else thread' }),
    );
    await tick();

    expect(row(h).messages).toEqual([]);
    expect(h.client.getState().conversations[OTHER_SESSION]).toBeUndefined();
  });
});

// ===========================================================================
// DECISION (a) — outbound addressing
// ===========================================================================

describe('DECISION (a): every addressable frame carries its sessionId', () => {
  it('stamps typing.start, typing.stop, markRead and markDelivered — and nothing else', () => {
    const emitted: OutboundIntent[] = [];
    const sink = addressed(SESSION, (intent) => emitted.push(intent));

    sink({ t: 'typing.start', d: {} });
    sink({ t: 'typing.stop', d: {} });
    sink({ t: 'message.markRead', d: {} });
    sink({ t: 'message.markDelivered', d: { upToSeq: 4 } });
    sink({ t: 'presence.set', d: { status: 'ONLINE' } });
    sink({ t: 'presence.query', d: { participantIds: ['x'] } });

    expect(emitted).toEqual([
      { t: 'typing.start', d: { sessionId: SESSION } },
      { t: 'typing.stop', d: { sessionId: SESSION } },
      { t: 'message.markRead', d: { sessionId: SESSION } },
      { t: 'message.markDelivered', d: { upToSeq: 4, sessionId: SESSION } },
      // `presence.set` is fanned out to every joined session by the server —
      // "I am away" is a fact about the person. `presence.query` has no
      // sessionId field on the wire at all.
      { t: 'presence.set', d: { status: 'ONLINE' } },
      { t: 'presence.query', d: { participantIds: ['x'] } },
    ]);
  });

  it('preserves the payload it is given rather than mutating it', () => {
    const payload = { upToMessageId: 'm_1' };
    const emitted: OutboundIntent[] = [];
    addressed(SESSION, (intent) => emitted.push(intent))({ t: 'message.markRead', d: payload });

    expect(payload).toEqual({ upToMessageId: 'm_1' });
    expect(emitted[0]?.d).toEqual({ upToMessageId: 'm_1', sessionId: SESSION });
  });

  it('is installed on a real runtime, so the wrapper is not decoration', () => {
    const emitted: OutboundIntent[] = [];
    const runtime = new ConversationRuntime({
      id: SESSION,
      localSender: { senderId: STAFF_ID, senderType: 'AGENT' },
      history: new RecordingHistory(),
      enqueue: () => Promise.reject(new Error('not used')),
      emitIntent: (intent) => emitted.push(intent),
      connectionState: 'connected',
      schedule: new ManualTimers().schedule,
    });

    // A snapshot first: watermarks refuse to advance with nothing to read.
    runtime.applyPush({
      v: 1,
      t: 'session.updated',
      id: ulid(1),
      ts: 0,
      d: { session: snapshot() },
    } as ServerPushFrame);
    runtime.applyPush({
      v: 1,
      t: 'message.new',
      id: ulid(2),
      ts: 0,
      d: messageNewPayload({ seq: 4 }),
    } as ServerPushFrame);

    runtime.presence.typing.startTyping();
    runtime.presence.watermarks.markRead();
    runtime.presence.watermarks.markDelivered();

    expect(emitted).toEqual([
      { t: 'typing.start', d: { sessionId: SESSION } },
      { t: 'message.markRead', d: { sessionId: SESSION } },
      { t: 'message.markDelivered', d: { upToSeq: 4, sessionId: SESSION } },
    ]);

    runtime.dispose();
  });
});

// ===========================================================================
// DECISION (b) — unaddressed and unaddressable inbound frames
// ===========================================================================

describe('DECISION (b): frames the wire cannot address write no conversation state', () => {
  it('classifies every server push exactly once', () => {
    const at = (frame: unknown): string => addressOf(frame as ServerPushFrame).kind;

    expect(at({ t: 'message.new', d: { sessionId: SESSION } })).toBe('conversation');
    expect(at({ t: 'session.updated', d: { session: { sessionId: SESSION } } })).toBe('conversation');
    expect(at({ t: 'session.closed', d: { sessionId: SESSION } })).toBe('conversation');
    expect(at({ t: 'typing.start', d: { sessionId: SESSION } })).toBe('conversation');
    expect(at({ t: 'typing.start', d: {} })).toBe('unaddressed');
    expect(at({ t: 'message.read', d: {} })).toBe('unaddressed');
    expect(at({ t: 'agent.joined', d: {} })).toBe('unaddressable');
    expect(at({ t: 'agent.left', d: {} })).toBe('unaddressable');
    expect(at({ t: 'ticket.linked', d: {} })).toBe('unaddressable');
    expect(at({ t: 'connection.ack', d: {} })).toBe('connection');
    expect(at({ t: 'system.pong', d: {} })).toBe('connection');
  });

  it('leaves handledBy untouched on agent.joined, and says so in the log', async () => {
    const h = harness();
    await connect(h);
    await open(h);
    expect(row(h).session?.handledBy).toBeUndefined();

    h.sockets.last.emitJson({
      v: 1,
      t: 'agent.joined',
      id: ulid(16),
      ts: 0,
      d: { kind: 'AGENT', id: 'agent_99', displayName: 'Someone Else' },
    });
    await tick();

    // The authoritative write comes from the ADDRESSED session.updated snapshot,
    // whose `handledBy` carries the same fact. Applying this one blind would
    // write it into whichever conversation happened to be open.
    expect(row(h).session?.handledBy).toBeUndefined();
    expect(row(h).session?.assignedAgent?.participantId).toBe(STAFF_ID);
    expect(
      h.logs.some((l) => l.message.includes('wire shape carries no sessionId')),
    ).toBe(true);
  });

  it('does not attach a ticket from ticket.linked', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    h.sockets.last.emitJson({
      v: 1,
      t: 'ticket.linked',
      id: ulid(17),
      ts: 0,
      d: { ticketId: 'TCK-1', ticketUrl: 'https://crm.example/TCK-1' },
    });
    await tick();

    expect(row(h).session?.ticket).toBeNull();
  });

  it('drops a routable frame that arrived without its address, and warns', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    // What the v1 receipt bridge still sends: a relayed read watermark with no
    // sessionId on it (`bridge-receipts.ts:155`).
    h.sockets.last.emitJson({
      v: 1,
      t: 'typing.start',
      id: ulid(18),
      ts: 0,
      d: { participantId: CUSTOMER_ID },
    });
    await tick();

    expect(row(h).typing).toEqual({ isTyping: false });
    expect(
      h.logs.some(
        (l) => l.level === 'warn' && l.message.includes('arrived with no sessionId'),
      ),
    ).toBe(true);
  });

  it('applies an ADDRESSED typing frame to the conversation it names', async () => {
    const h = harness();
    await connect(h);
    await open(h);

    h.sockets.last.emitJson({
      v: 1,
      t: 'typing.start',
      id: ulid(19),
      ts: 0,
      d: { participantId: CUSTOMER_ID, sessionId: SESSION },
    });
    await tick();

    expect(row(h).typing).toEqual({ isTyping: true, participantId: CUSTOMER_ID });
  });
});

// ===========================================================================
// Rule 1 — the customer surface is not on this code path at all
// ===========================================================================

describe('rule 1: nothing here reaches the customer runtime', () => {
  it('makes no HTTP of its own — history is the only way out', async () => {
    const fetchSpy = vi.fn();
    const globals = globalThis as unknown as { fetch?: unknown };
    const original = globals.fetch;
    globals.fetch = fetchSpy;
    try {
      const h = harness();
      await connect(h);
      await open(h);
      void h.client.sendMessage(SESSION, 'hi').catch(() => undefined);
      await tick();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(h.history.queries).toHaveLength(1);
    } finally {
      if (original === undefined) delete globals.fetch;
      else globals.fetch = original;
    }
  });
});
