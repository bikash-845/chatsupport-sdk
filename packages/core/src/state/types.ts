// Binding-facing state shapes — PRD §6.4 (`ChatState`), §8.1 (connection
// states), §9.5 (read watermarks).
//
// These are the types every framework binding (React, Vue, Angular, vanilla)
// reads. protocol/domain.ts deliberately keeps the *wire* shapes separate and
// names this module as their consumer: "the richer, binding-facing
// ChatState/ChatSession/ChatMessage types from PRD §6.4, which a later task
// (observable store, §T3) derives from these wire shapes."
//
// Nothing here redefines a protocol enum or wire shape — `ChatStatus`,
// `ChatMode`, `SenderType`, `MessageType`, `MessageMetadata`, and `ErrorCode`
// are all imported from protocol/.

import type {
  AttachmentMetadata,
  ChatMode,
  ChatStatus,
  ErrorCode,
  HandledBy,
  MessageMetadata,
  MessageType,
  PresenceEntry,
  SenderType,
} from '../protocol/index.js';

/**
 * Cancels a `subscribe` or `on` registration (§6.4).
 *
 * Calling it more than once is a safe no-op — it never cancels an unrelated
 * registration, even one made afterwards with the same function.
 */
export type Unsubscribe = () => void;

/**
 * The seven connection states of §8.1, in lifecycle order.
 *
 * No runtime guard is exported deliberately: unlike the protocol enums, a
 * `ConnectionState` is never parsed off the wire — it is computed by the
 * connection state machine (T8) — so there is no untrusted input to guard.
 */
export const CONNECTION_STATE_VALUES = [
  'idle',
  'connecting',
  'authenticating',
  'connected',
  'reconnecting',
  'suspended',
  'closed',
] as const;

export type ConnectionState = (typeof CONNECTION_STATE_VALUES)[number];

/**
 * A protocol- or transport-level error (§6.5's `error` event, §6.4's
 * `lastError`).
 *
 * Judgment call: §7.4's `ErrorCode` enum only covers errors the server can
 * express in an `error` frame, but §6.5 requires this same type to carry
 * "any protocol- **or transport**-level error" — and a socket that fails to
 * open never produced a frame, so it has no wire code. Rather than invent
 * client-side code names that would collide with whatever T7/T8 later need,
 * `source` makes the origin explicit and `code` is `null` exactly when no
 * wire frame produced it. This adds zero new code names to §7.4.
 */
export interface ChatError {
  /** `'protocol'` when this came from an `error` frame; `'transport'` otherwise. */
  source: 'protocol' | 'transport';

  /** The canonical §7.4 code, or `null` for a transport failure with no frame. */
  code: ErrorCode | null;

  /** Human-readable. Never branch on this — branch on `code` (§12.6). */
  message: string;

  retryable: boolean;

  details?: Record<string, unknown>;
}

/**
 * A message as bindings see it — the state-layer projection of the wire
 * `MessagePayload` (protocol/frames.ts), which is what actually streams in
 * over the socket.
 *
 * `seq` is optional here but required on the wire, and that difference is the
 * whole point: §6.5's `message` event fires for optimistic sends too
 * ("optimistic or server-confirmed"), and an optimistic message has no
 * server-assigned ordering key yet. **Absent `seq` means "not yet
 * server-confirmed"** — so no separate `pending`/`status` field is invented
 * here. `id` is stable from creation under D1 (client ULID, never swapped).
 */
/**
 * Why a queued send will never be retried again.
 *
 * Canonically defined here rather than in `queue/` so `state` stays free of a
 * transitive dependency on transport and storage; `queue` imports it.
 */
export type SendFailureReason =
  /** The server refused it. A retry would be refused identically (§7.4). */
  | 'rejected'
  /**
   * The session it was queued against ended before it reached the wire
   * (§12.5's terminal `CloseReason`s — `RESOLVED`, `MANUAL`).
   *
   * Distinct from `'rejected'` precisely because a retry is NOT futile: this
   * send was refused by *us*, locally, and the same content sent into a new
   * session would go through. It must never be delivered as-is, though —
   * `message.send` carries no `sessionId` (protocol/frames.ts), so the server
   * attributes a flushed frame to whichever session the socket currently
   * holds, and a queued send that outlived its session would silently land in
   * the next one.
   */
  | 'sessionClosed'
  /** It outlived the queue's configured max age (§9.6). */
  | 'expired'
  /** Pruned to bring the queue under its configured max entries (§9.6). */
  | 'evicted'
  /** The durable write did not land and is not recoverable — `write_failed` (§9.1). */
  | 'storage';

/**
 * Local delivery state of an outgoing message.
 *
 * **Absent means server-confirmed.** This exists because an absent `seq` does
 * not: `seq` is missing both for a message still in flight and for one that
 * will never arrive, so overloading it makes a dead message indistinguishable
 * from a live one. A binding needs that difference to decide between a
 * spinner and a retry affordance.
 *
 * Modeled as a union so a `reason` cannot exist without `failed`, and
 * `failed` cannot exist without a `reason`.
 */
export type MessageDelivery =
  | { readonly state: 'queued' }
  | {
      readonly state: 'failed';
      readonly reason: SendFailureReason;

      /**
       * The server's §7.4 code, present only when this failure came from a
       * rejected `message.send` (`reason === 'rejected'`) — `ErrorPayload.code`
       * (protocol/envelope.ts), copied through unchanged. Every other
       * `SendFailureReason` is the SDK's own local determination (queue
       * retention, a session abandoned before its send reached the wire), which
       * never produced a wire `ErrorPayload` to read a code from, so this stays
       * absent for those.
       */
      readonly code?: ErrorCode;

      /**
       * Whether retrying this exact send is worth attempting.
       *
       * Mirrors the server's `ErrorPayload.retryable` one-for-one when the
       * queue had it to report — the server already computes this once per
       * code (§7.4), so the SDK never re-derives it from a second,
       * hand-maintained copy of that table. When there is nothing to mirror
       * (an older server that predates this field, or a `reason` with no wire
       * `ErrorPayload` behind it at all), this falls back to
       * `DEFAULT_RETRYABLE_FALLBACK` in messages/controller.ts — `true` — so
       * see that constant's doc comment for the justification. This field is
       * always present, even in the fallback case, precisely so a binding
       * never has to ask "was retryable reported, or defaulted?" — it only
       * ever has one boolean to branch on.
       */
      readonly retryable: boolean;
    };

export interface ChatMessage {
  id: string;
  sessionId: string;
  senderId: string;
  senderType: SenderType;
  type: MessageType;
  content: string;
  replyToMessageId?: string;

  /** Top-level, never under `metadata` — one canonical location (D4). */
  attachment?: AttachmentMetadata;

  metadata?: MessageMetadata;

  /** Server-assigned ordering key (D2). Absent until the server confirms. */
  seq?: number;

  /**
   * Local delivery state. Absent means the server confirmed this message.
   * See {@link MessageDelivery} for why an absent `seq` cannot carry this.
   */
  delivery?: MessageDelivery;

  /** ISO-8601. One canonical name per concept (§12.2). */
  createdAt: string;
}

/** Enriched participant profile — the `Profile` schema in T2's OpenAPI. */
export interface ChatParticipantProfile {
  /**
   * Correlation key. Without this a `presence.update` frame — which is keyed
   * by `participantId` — has no profile to bind to, and `readWatermarks`
   * (also participant-keyed) cannot be resolved to a person either.
   */
  participantId: string;

  displayName: string;

  /**
   * Null on the browser path, by design — do not build a feature on it.
   *
   * The WebSocket mapping has never populated this (client/session.ts), and
   * `@dhaam-ccrm/rest` deliberately writes null even though the REST session
   * read returns a real address: nothing in the SDK renders it, and the widget
   * runs inside third-party pages where session-replay tools serialize
   * application state wholesale. The field stays in the type because the
   * `Profile` schema defines it and a first-party (non-browser) adapter may
   * legitimately supply it.
   */
  email: string | null;

  avatarUrl: string | null;
}

/** A linked CRM/support ticket — the `Ticket` schema in T2's OpenAPI. */
export interface ChatTicket {
  id: string;
  url: string | null;
}

/**
 * The active session. Field-for-field the `ChatSession` schema in
 * openapi/chat-api.yaml (T2), which named its schema after this exact §6.4
 * state field — participants are deliberately absent because §6.4 already
 * surfaces their watermarks as the separate `readWatermarks` map.
 */
export interface ChatSession {
  id: string;
  status: ChatStatus;
  mode: ChatMode;

  /** ISO-8601. */
  createdAt: string;

  /** ISO-8601, or `null` while the session is still open. */
  closedAt: string | null;

  assignedAgent: ChatParticipantProfile | null;
  customer: ChatParticipantProfile | null;
  ticket: ChatTicket | null;

  /**
   * Who the customer is currently talking to — the binding-facing mirror of
   * the wire `SessionSnapshot.handledBy` (protocol/domain.ts), kept in sync
   * from `session.updated`/`connection.ack` snapshots and from
   * `agent.joined`/`agent.left` (client/session.ts). Read this to render a
   * session header ("chatting with Ada" / "chatting with the bot"); it is
   * strictly presentation, never a status signal.
   *
   * **Absence does NOT mean "nobody is handling this chat."** `status`/
   * `mode` are the only fields that carry that signal — this field is absent
   * exactly when the wire had nothing presentable to say (queued with no
   * assignee yet, or a display name that has not resolved), and a binding
   * MUST fall back to its own configured title in that case, never to "this
   * chat is unhandled."
   *
   * `assignedAgent` above is deliberately narrower: it is populated only for
   * an AGENT (never a BOT) and only from the session snapshot's participant
   * list, so it stays a stable "who is the human of record" fact.
   * `handledBy` is the broader field — it also reflects a BOT actively
   * handling (e.g. resuming right after an agent leaves), which
   * `assignedAgent` structurally cannot express. Do not treat one as a
   * duplicate of the other.
   *
   * **Known staleness after a reactivation (T6, backend):** a session
   * reactivated server-side from `CLOSED`/`RESOLVED` by a new customer
   * message (behind `FEATURE_SESSION_REACTIVATE_ON_CUSTOMER_MESSAGE`) keeps
   * its previous `assignedAgentId` — so immediately after reactivation
   * `handledBy` can still name the agent who closed it, while `status` has
   * already gone back to `WAITING_FOR_AGENT` (queued, nobody actively
   * engaged). This SDK deliberately does NOT clear or second-guess
   * `handledBy` for this — the wire value is wholesale-authoritative (§9.4)
   * and core never invents a fresher answer than the server sent. A binding
   * that renders "connected to <name>"-style copy MUST gate it on
   * `isHandledByCurrent` (client/session.ts) rather than on this field's
   * mere presence — see that function's doc for the exact rule.
   */
  handledBy?: HandledBy;
}

/**
 * Lightweight session projection for history lists (§6.4's `pastSessions`).
 * Field-for-field T2's `ChatSessionSummary` schema, hydrated by
 * `GET /sessions`.
 */
export interface ChatSessionSummary {
  id: string;
  status: ChatStatus;
  mode: ChatMode;

  /** ISO-8601. */
  createdAt: string;

  /** ISO-8601, or `null` while still open. */
  closedAt: string | null;

  /** ISO-8601 of the most recent message, or `null` if the session has none. */
  lastMessageAt: string | null;

  lastMessagePreview?: string;

  unreadCount: number;

  /**
   * Who is/was handling this past session — the same {@link HandledBy} shape
   * as {@link ChatSession.handledBy}, populated one-for-one from the REST
   * `ChatSessionSummaryWire.handledBy` (openapi's `listSessions` operation).
   *
   * ── Why this exists on the summary at all ──
   *
   * The REST row (`@dhaam-ccrm/rest`'s `RestChatSessionSummary`) is a
   * structural superset of this type — it always carried an extra
   * `handledBy` core had no field for, smuggled through only via a type
   * assertion at the seam boundary (`createSessionSummarySource`). That is
   * genuinely useful information for a session picker (which agent/bot
   * handled *this* past conversation), not noise to drop, so it is promoted
   * to a real, typed field here rather than left riding through untyped.
   *
   * Absent — never `null` — when nobody had picked the session up yet at
   * the time it was summarized (still on the bot with no name resolved, or
   * escalated and unassigned). Same absence rule as
   * {@link ChatSession.handledBy}: this is presentation-only, never a
   * status signal — read `status`/`mode` for that.
   */
  handledBy?: HandledBy;

  /**
   * The conversation's subject/topic, chosen on the widget's "New
   * conversation" screen when this session was created — `subject` free
   * text, `topic` one of the merchant's own configured chips. Field-for-field
   * the REST projection's same names (`RestChatSessionSummary.subject`/
   * `.topic`, `@dhaam-ccrm/rest`), unlike {@link handledBy} above, which REST
   * carries as an addition core has no field for — these two are ordinary
   * mirrored fields.
   *
   * Absent — never `''` — when no topic was chosen, which includes every
   * session that predates this field. Not defaulted anywhere: a picker
   * renders whatever placeholder it already uses for an untitled
   * conversation when both are absent.
   */
  subject?: string;
  topic?: string;
  customerName?: string;
  customerEmail?: string;
  merchantName?: string;
  merchantEmail?: string;
  storeName?: string;
  storeEmail?: string;
  targetRole?: string;
  targetId?: string;
  targetName?: string;
  targetEmail?: string;
  adminName?: string;
  adminEmail?: string;
}

/**
 * The observable state surface — exactly the twelve fields of §6.4, in the
 * order that section lists them.
 *
 * Every value reachable from a `ChatState` handed out by the store is deeply
 * frozen (see freeze.ts), so this type is read-only in practice even though
 * it is not spelled `Readonly<...>`: the runtime, not just the compiler,
 * refuses external mutation.
 */
export interface ChatState {
  connectionState: ConnectionState;
  session: ChatSession | null;
  messages: ChatMessage[];
  typing: { isTyping: boolean; participantId?: string };
  unreadCount: number;
  /**
   * Backward-pagination state (§6.3, §12.10).
   *
   * `initialLoaded` is what separates "there is nothing older" from "nothing
   * has been asked for yet". `hasMore` starts `false`, so on its own it
   * cannot tell those apart — and the guard that used to stand in for it
   * ("the list is empty, so this must be a cold start") is wrong the moment
   * the list is non-empty for a reason other than a completed history load:
   * a send queue rehydrated from storage after a reload, or a live
   * `message.new` that arrived before page one did. Both of those made
   * `loadMore()` return silently and the transcript never appear.
   *
   * It is per-session and is cleared whenever the session is replaced, which
   * is also what makes a re-seed on switch possible at all. A FAILED load
   * deliberately leaves it unchanged, so a retry is always possible.
   */
  pagination: { hasMore: boolean; loadingMore: boolean; initialLoaded: boolean };
  uploading: boolean;
  pastSessions: ChatSessionSummary[];

  /** participantId → ISO-8601 watermark (§9.5, generalized from v1's single `agentReadAt`). */
  readWatermarks: Record<string, string>;

  /**
   * participantId → highest `seq` that participant has received (§9.5's
   * watermark model, D2's ordering key).
   *
   * Keyed on `seq`, not a timestamp, and that is the whole difference from
   * `readWatermarks`: a delivery watermark is compared against
   * `ChatMessage.seq` to decide whether a message is delivered, so it must be
   * the same total order the messages themselves are in (D2). A participant
   * absent from this map has delivered nothing we know of — which is not the
   * same as having delivered nothing.
   *
   * Never derived from presence. v1 rendered a double-grey tick when "the
   * other party is connected", which is a statement about a socket, not about
   * a message; the two diverge the moment a client is connected but has not
   * caught up. See {@link ../messages/ticks.js} for the one derivation every
   * binding must use.
   */
  deliveredWatermarks: Record<string, number>;

  /**
   * participantId → live presence. The one canonical location for presence
   * (D4): it deliberately replaces an `isOnline` flag on
   * {@link ChatParticipantProfile}, so there is never a second place to read
   * the same fact from — the mistake v1 made with attachments (§12.2).
   *
   * A participant absent from this map has unknown presence, which is not the
   * same as being offline.
   */
  presence: Record<string, PresenceEntry>;

  lastError: ChatError | null;
}

/**
 * The state a store starts in: `idle` (§8.1 — "no connection attempted yet")
 * with every collection empty and no error.
 *
 * A factory, not a shared constant, because the store freezes whatever it is
 * given — handing every store the same object would make two stores share
 * one frozen graph.
 */
export function createInitialChatState(): ChatState {
  return {
    connectionState: 'idle',
    session: null,
    messages: [],
    typing: { isTyping: false },
    unreadCount: 0,
    pagination: { hasMore: false, loadingMore: false, initialLoaded: false },
    uploading: false,
    pastSessions: [],
    readWatermarks: {},
    deliveredWatermarks: {},
    presence: {},
    lastError: null,
  };
}
