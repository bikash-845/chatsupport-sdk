// Which conversation a frame belongs to — in BOTH directions.
//
// This file is the whole of the two addressing decisions Slice 4 had to make.
// It is deliberately one module and deliberately pure: no store, no socket, no
// runtime. Everything below is a total function over a frame or an intent, so
// the policy is assertable by direct call rather than only observable as a
// side effect three layers down.
//
// =============================================================================
// DECISION (a) — OUTBOUND: every addressable frame carries its `sessionId`,
//                from the FIRST conversation, not from the second.
// =============================================================================
//
// The server resolves an unaddressed frame with `resolveJoinedSession(conn)`
// (chat-service-node `handlers.ts:862`), which THROWS the moment a connection
// holds more than one session:
//
//   "This connection has joined more than one session — name one with
//    sessionId on this frame"
//
// It is reached from `resolveAddressedSession` (:2072) for any frame lacking
// `sessionId`, which is `message.markRead` (:2363), `typing.start`/`typing.stop`
// (:2413), `session.requestAgent` (:1977), `presence.query` (:2505) and
// `message.markDelivered` (delivery.ts:343-360).
//
// Core emits all of those UNADDRESSED today — `presence/typing.ts:247,260` send
// `d: {}`, `presence/watermarks.ts:327,380` likewise — because a CUSTOMER holds
// exactly one session, so "the joined session" and "the session this frame is
// about" were always the same fact and the wire never had to carry it. A staff
// connection accumulates sessions, and there those two facts come apart.
//
// ── Why the wrapper is installed unconditionally, and not at capacity > 1 ──
//
// The tempting shape is "stamp only once a second conversation is open". It is
// the wrong shape, for three reasons:
//
//   1. It makes the wire change under the host at the moment a second thread
//      opens — the single least testable moment in the lifecycle, and the one
//      no unit test would be pointed at.
//   2. The frames it protects (`markRead`, `typing`) are exactly the ones a
//      staff panel fires constantly, so the failure would surface as an
//      intermittent server-side throw in production rather than as a red test.
//   3. The reason plan §4.4 gave for conditioning it — keeping the CUSTOMER
//      wire byte-identical — does not apply here. The customer runtime is a
//      different file (`client/create-chat-client.ts`), it builds its own
//      unwrapped `IntentSink`, and this module is not on its import graph at
//      all. `golden/wire-golden.test.ts` is therefore locked STRUCTURALLY, by
//      the two paths not sharing a sink, rather than CONDITIONALLY, by a
//      capacity check that could be got wrong.
//
// So: one wire shape, always, on the party surface; zero bytes changed on the
// customer surface. Slice 6 lifts `maxJoined` and has nothing to retrofit.
//
// ── The two intents that are deliberately NOT addressed ──────────────────
//
//   `presence.set`   — `handlers.ts:2478-2490` fans it out to EVERY joined
//                      session, because "I am away" is a fact about the PERSON,
//                      not about one conversation. Addressing it would narrow a
//                      broadcast the server means to make.
//   `presence.query` — has NO `sessionId` field on the wire at all
//                      (`PresenceQueryPayload`, protocol/frames.ts) and calls
//                      `resolveJoinedSession` directly (:2505). It is therefore
//                      unaddressable rather than merely unaddressed, and at
//                      N >= 2 with no explicit `participantIds` the server will
//                      refuse it. Nothing in this slice emits it; Slice 6 owes
//                      it an explicit refusal, and §9 owes the backend the ask.
//
// =============================================================================
// DECISION (b) — INBOUND: `agent.joined`, `agent.left` and `ticket.linked`
//                write NO conversation state.
// =============================================================================
//
// `AgentEventPayload` (protocol/frames.ts:407) and `TicketLinkedPayload` (:485)
// carry no `sessionId` — not "optionally", not "the server forgot": the shapes
// have no field for one. On the customer path that is harmless, because there
// is one conversation and it is the answer by construction, which is why
// `create-chat-client.ts:427-437,486-489` writes `ChatState.session` from them
// with no id check at all.
//
// In a per-conversation runtime that same code would write the WRONG thread.
// Three options were on the table:
//
//   APPLY to the single open conversation — correct today, silently wrong at
//     N = 2, and wrong in the worst way: it mislabels who is handling a
//     conversation and attaches one thread's ticket to another. It also makes
//     Slice 6 a BEHAVIOUR change rather than a capacity change, which is
//     precisely the retrofit this slice was told to avoid.
//   SURFACE as a client-level event with `conversationId: null` — the right
//     long-term shape (plan §4.3) and what `ConversationClient.on()` will do.
//     It needs the whole event surface, which is Slice 5/6, not this one.
//   IGNORE for state, and say so — what is implemented here.
//
// The information is not actually lost. `SessionSnapshot.handledBy` carries the
// same fact as `agent.joined`/`agent.left` and arrives ADDRESSED on the
// `session.updated` the server pushes after every accepted join
// (`handlers.ts:1930`), and `SessionSnapshot.ticketId` carries the linked
// ticket's id. The bounded, stated degradation is that a row's `handledBy` can
// be stale between an `agent.joined` and the next snapshot, and that
// `ticket.linked`'s `ticketUrl` — the ONE fact no snapshot carries — is not
// applied at all until §9's backend ask lands a `sessionId` on those frames.
// A dropped frame is logged rather than swallowed, so it is visible.
//
// ── And the general rule the table below encodes ─────────────────────────
//
// A ROUTABLE frame that arrives without its address is DROPPED, not broadcast.
// This mirrors `resolveJoinedSession`'s own reasoning (`handlers.ts:855-861`):
// picking any member would file one conversation's traffic into another's. The
// live case is the v1 bridge, which omits `sessionId` on the `message.read` it
// relays (`bridge-receipts.ts:155`, unlike its own sibling at :383-388) — one
// backend line, and a hard prerequisite for Slice 6.

import type { IntentSink, OutboundIntent } from '../presence/index.js';
import type { ClientToServerFrameType, ServerPushFrame } from '../protocol/index.js';

/**
 * The client frames that carry a `sessionId` on the wire AND are resolved
 * server-side through `resolveJoinedSession` when it is absent.
 *
 * `satisfies` ties the list to the protocol's own catalog, so a name that is
 * not a real client frame fails to compile here rather than producing a frame
 * the server will reject.
 */
export const ADDRESSABLE_INTENT_TYPES = [
  'typing.start',
  'typing.stop',
  'message.markRead',
  'message.markDelivered',
] as const satisfies readonly ClientToServerFrameType[];

const ADDRESSABLE: ReadonlySet<string> = new Set<string>(ADDRESSABLE_INTENT_TYPES);

/**
 * Wraps an `IntentSink` so every addressable intent leaves carrying
 * `sessionId`.
 *
 * The payload is rebuilt rather than mutated — `presence/` hands out object
 * literals it does not retain, but a sink that mutated its input would be a
 * trap for the first caller that does retain one. Anything not in
 * {@link ADDRESSABLE_INTENT_TYPES} passes through byte-for-byte; see the module
 * header for why `presence.set` and `presence.query` are in that group on
 * purpose.
 */
export function addressed(sessionId: string, sink: IntentSink): IntentSink {
  return (intent: OutboundIntent): void => {
    if (!ADDRESSABLE.has(intent.t)) {
      sink(intent);
      return;
    }
    sink({ ...intent, d: { ...intent.d, sessionId } } as OutboundIntent);
  };
}

/**
 * Where an inbound server push belongs.
 *
 * A closed union rather than `string | null` so every caller has to answer for
 * all four cases, and so the three genuinely different kinds of "no
 * conversation id" cannot collapse into one another.
 */
export type InboundAddress =
  /** Routable, and the address was on the frame. */
  | { readonly kind: 'conversation'; readonly conversationId: string }
  /** A fact about the CONNECTION, not about any one conversation. */
  | { readonly kind: 'connection' }
  /** The wire shape has no `sessionId` field at all — see DECISION (b). */
  | { readonly kind: 'unaddressable' }
  /** Routable, but this instance arrived without its address. Drop it. */
  | { readonly kind: 'unaddressed' };

const CONNECTION_LEVEL: InboundAddress = { kind: 'connection' };
const UNADDRESSABLE: InboundAddress = { kind: 'unaddressable' };
const UNADDRESSED: InboundAddress = { kind: 'unaddressed' };

/** Routable, addressed. */
function to(conversationId: string): InboundAddress {
  return { kind: 'conversation', conversationId };
}

/** `sessionId` is optional on these payloads; absent means unroutable here. */
function optional(sessionId: string | undefined): InboundAddress {
  return sessionId === undefined ? UNADDRESSED : to(sessionId);
}

/**
 * The inbound address table (plan §4.3), as one total function.
 *
 * Verified field by field against `protocol/frames.ts` and against the server
 * handlers that populate them; the module header records which of them the
 * server actually fills today and which one it still misses.
 */
export function addressOf(frame: ServerPushFrame): InboundAddress {
  switch (frame.t) {
    // A STAFF handshake resolves no session, so this is connection-level. A
    // KEYED conversation client — legal, though of no use on this surface —
    // gets one, and it is routed rather than dropped.
    case 'connection.ack':
      return frame.d.session === undefined ? CONNECTION_LEVEL : to(frame.d.session.sessionId);

    // Required by the validator on both.
    case 'session.updated':
      return to(frame.d.session.sessionId);
    case 'session.closed':
      return to(frame.d.sessionId);

    // Required on the payload — a message with no session has nowhere to go.
    case 'message.new':
      return to(frame.d.sessionId);

    // Optional on the wire, populated by the v2 server on every relay.
    // `message.read` is the one the v1 bridge still omits.
    case 'typing.start':
    case 'typing.stop':
    case 'message.read':
    case 'message.delivered':
    case 'presence.update':
      return optional(frame.d.sessionId);

    // No `sessionId` field EXISTS on these payloads. See DECISION (b).
    case 'agent.joined':
    case 'agent.left':
    case 'ticket.linked':
      return UNADDRESSABLE;

    case 'system.pong':
      return CONNECTION_LEVEL;

    default:
      return CONNECTION_LEVEL;
  }
}
