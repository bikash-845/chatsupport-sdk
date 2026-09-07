// The multi-role conversation surface — public types.
//
// ── What this module is, and what it is NOT ──────────────────────────────
//
// `createChatClient` serves ONE surface: a customer, holding ONE session,
// authenticated by a publishable key. The server picks its whole flow on that
// key's PRESENCE (`handlers.ts` branches on `conn.staffSurface`, and its own
// comment is explicit that "the SURFACE decides that and not the role"), and a
// connection that sends no key gets the other flow: N live sessions that
// accumulate rather than evict.
//
// A merchant, a manager and an admin observer all need that second flow. None
// of them has a publishable key — they arrive holding a dh-auth `id_token` the
// host already has.
//
// This is a SEPARATE factory rather than a widened `ChatClientConfig`, and that
// is the single most important decision in the whole design:
//
//   `publishableKey: process.env.PK` evaluating to `undefined` must not
//   silently become a keyless staff connection. `validate.ts` closed exactly
//   that hole on the wire by rejecting `''`; widening the customer config would
//   reopen it one layer up.
//
// The consequence, and the contract this work is held to: `create-chat-client.ts`
// and `ChatClientConfig` receive ZERO edits. Nothing here can change what a
// customer install does, because nothing here is on that path.
//
// ── Scope of THIS slice ──────────────────────────────────────────────────
//
// Keyless boot (slice 1) plus ONE live conversation on it: `open()` sends
// `session.join` carrying `resumeFrom`, applies the `SessionJoinAckData
// { seq, replay }` that comes back, waits for the session snapshot the server
// pushes after it, and reads page one of history through an injected seam.
// `sendMessage()` then sends into that conversation with an optimistic echo,
// and its inbound messages land on its own row.
//
// Still NOT here, and absent rather than stubbed: listing, the directory,
// `focus()`, storage, the unread index, per-conversation handles, and more than
// one live conversation at a time. Every field and method below is one this
// slice actually implements; the rest of the surface arrives with the slice
// that can honestly populate it.

import type { TokenProvider } from '../connection/index.js';
import type { LocalSender, MessageHistorySource, SendMessageOptions } from '../messages/index.js';
import type { Clock, ScheduleTimer } from '../presence/index.js';
import type { ChatError, ChatState, ConnectionState, Unsubscribe } from '../state/index.js';
import type { WebSocketFactory } from '../transport/index.js';

/**
 * The observable state of a conversation client.
 *
 * `ChatState` is deliberately NOT edited and is NOT the container here — it is
 * the ELEMENT type. One conversation projects to one complete, ordinary
 * `ChatState`, which is what lets every shipped binding work per-thread later
 * without gaining a single new concept.
 *
 * ── Why this is three fields and not ten ─────────────────────────────────
 *
 * The design's full shape adds `order`, `index`, `directory`, `listing`,
 * `focusedId` and `listStale`. Every one of them is REST-sourced or
 * runtime-sourced, and this slice has neither REST nor runtimes — they would
 * be permanently `[]`, `{}` and `false`, which is a worse lie than an absent
 * field. They arrive with the slices that fill them. Adding a readable field
 * to a state object consumers only ever read is additive, so this ordering
 * costs nobody a migration.
 */
export interface ConversationsState {
  /**
   * ONE connection, ONE connection state.
   *
   * The party surface holds a single socket carrying N sessions, so unlike the
   * customer surface there is no per-conversation connection to speak of.
   */
  readonly connectionState: ConnectionState;

  /**
   * The per-conversation projections, keyed by session id.
   *
   * Each value is a COMPLETE, ordinary `ChatState` — all twelve fields of §6.4,
   * deeply frozen, with `connectionState` fanned in from the one connection
   * above. `ChatState` is the ELEMENT type here and is not edited anywhere in
   * this work, which is what will let every shipped binding work per-thread
   * without gaining a concept.
   *
   * Two fields are permanently inert on a party row and are called out so
   * nobody builds on them: `pastSessions` is `[]` (it is the customer session
   * picker's data source; the party equivalent is the conversation index, which
   * is a later slice), and `connectionState` is the connection's, mirrored,
   * never a per-conversation fact.
   *
   * Reference-stable: the map is rebuilt only when a row it holds actually
   * changed, so it is safe to read straight from `useSyncExternalStore`.
   */
  readonly conversations: Readonly<Record<string, ChatState>>;

  /**
   * Connection-level errors, with a message this SDK wrote.
   *
   * The server's own text is deliberately not passed through — see
   * `describeConnectionError`. Branch on `code`, never on `message`.
   */
  readonly lastError: ChatError | null;
}

/**
 * A client for the keyless (staff/party) surface.
 *
 * Not a `ChatClient` and not a superset of one: the two answer different
 * questions. A `ChatClient` is a handle on ONE conversation; this is a handle
 * on a CONNECTION that will come to carry many. The per-conversation handle
 * that DOES extend `ChatClient` is a later slice.
 */
export interface ConversationClient {
  /** The current snapshot. Stable by reference until something actually changes. */
  getState(): ConversationsState;

  /**
   * Registers `listener`, called with the full new state on every change.
   *
   * Not called on registration — read the current value with `getState()`.
   * Delivery is microtask-batched by the underlying store, so any number of
   * changes in one synchronous run produce exactly one notification.
   */
  subscribe(listener: (state: ConversationsState) => void): Unsubscribe;

  /**
   * Opens the connection and drives it to `connected`.
   *
   * Resolves once `connection.ack` arrives. Rejects if the client suspends
   * first, or if `disconnect()` intervenes. Already connected resolves
   * immediately; a second call while one is in flight returns the same
   * promise rather than opening a second socket.
   *
   * This is the only way out of `suspended`, which is where a keyless client
   * lands after a bounded number of auth failures — so a host whose id_token
   * lapsed must call it again rather than waiting for a retry that will never
   * come.
   */
  connect(): Promise<void>;

  /** User-initiated and terminal. Only an explicit `connect()` revives it. */
  disconnect(): void;

  /**
   * Abandons the armed backoff and attempts NOW, from attempt 0.
   *
   * For the one caller that has better information than the backoff guess: a
   * binding that just learned the network came back. Returns whether an
   * attempt actually started — `false` in every state but `reconnecting`, so
   * it is safe to call on any cadence.
   */
  retryNow(): boolean;

  /**
   * Brings one conversation up, and resolves when its row is usable.
   *
   * On resolution `getState().conversations[conversationId]` holds a complete
   * `ChatState` carrying the server's session snapshot and page one of its
   * history, and `sendMessage` into it will work. That is a deliberately strong
   * postcondition: a row that reported itself open while `session` was still
   * `null` is one a caller cannot send from, because a send is addressed from
   * `ChatState.session`.
   *
   * Three things happen, in this order, mirroring the order the server performs
   * them in: `session.join` carrying this conversation's own `resumeFrom`; the
   * `SessionJoinAckData { seq, replay }` that comes back, replay applied first
   * and the anchor adopted after; then the `session.updated` snapshot the
   * server pushes after every accepted join, and page one of history.
   *
   * Idempotent — a second call for a conversation already open returns without
   * a second `session.join`, which matters because a staff panel re-enters the
   * same thread on every navigation. Rejects with `ConversationJoinError` if the
   * join is refused, is not acknowledged, has no open socket to go out on, or
   * is acknowledged but never followed by a snapshot.
   *
   * The argument is an OBJECT rather than a bare id so the plan's
   * `{ counterparty }` variant — open-or-create against a person rather than a
   * session — is a later addition rather than a later break.
   *
   * ONE conversation at a time in this release. Opening a second is a later
   * slice, and needs the addressed-frame work this one already put in place.
   */
  open(target: { readonly conversationId: string }): Promise<void>;

  /**
   * Sends into one open conversation.
   *
   * The optimistic echo lands on that conversation's row immediately, carrying
   * `delivery: { state: 'queued' }`, and clears when the server acks. The
   * conversation is named explicitly rather than inferred from a "current"
   * one — this surface has no notion of a focused conversation, and inferring
   * it is how a message ends up in the wrong thread.
   *
   * Rejects with `ConversationNotOpenError` if `conversationId` names a
   * conversation this client has not finished opening.
   */
  sendMessage(
    conversationId: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void>;
}

/**
 * Diagnostics. Never called with credential material.
 *
 * `debug` carries the routing decisions that are otherwise invisible — an
 * inbound frame dropped because the wire carried no `sessionId`, a push for a
 * conversation this client has not opened. `warn` carries the ones that
 * indicate something is wrong upstream.
 */
export type ConversationLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
) => void;

/**
 * Construction config.
 *
 * Deliberately NOT assignable from, or to, `ChatClientConfig`. The two are
 * different surfaces and the compiler should say so.
 */
export interface ConversationClientConfig {
  /** Full WebSocket URL. Required — core has no legitimate default endpoint. */
  readonly wsUrl: string;

  /**
   * Credentials. For a merchant, manager or admin this is a dh-auth `id_token`
   * the host ALREADY holds: no secret key, no mint service, no token endpoint.
   *
   * STRONGLY prefer returning `{ token, expiresInMs }` over a bare string. A
   * bare string disables proactive refresh entirely, and after a bounded number
   * of auth failures the connection SUSPENDS, from which an explicit
   * `connect()` is the only exit. A dashboard whose id_token lapses otherwise
   * goes quietly and permanently dead.
   */
  readonly getToken: TokenProvider;

  /**
   * Who this client is, as the local participant.
   *
   * Nothing in THIS slice reads it — there are no messages, no typing and no
   * watermarks yet. It is required from the first release anyway, and
   * validated at construction, because it is not optional in any later slice
   * and discovering a missing `senderId` at first send rather than at
   * construction is exactly the late failure this SDK rejects elsewhere.
   */
  readonly localSender: LocalSender | (() => LocalSender);

  /**
   * PRESENT  => keyed hello. The server runs its customer flow: one live
   *             session, evict-on-join.
   * ABSENT   => keyless hello. The server runs its staff flow: N live
   *             sessions, accumulate.
   *
   * There is no `mode` flag, and absence is the signal because absence is what
   * the WIRE means. `''` still throws, and a secret key throws
   * `SecretKeyInClientError` — ordered so the security answer wins over the
   * formatting one.
   *
   * Supplying a key here is legal but of no use yet: this slice resolves no
   * session, and the connection controller holds the customer half of the
   * `connection.ack` contract (a hello carrying a key is guaranteed a
   * `session` and a `seq` back) whenever one is sent.
   */
  readonly publishableKey?: string;

  // ── Seams. Same shapes as ChatClientConfig's, for the same reasons. ──────

  /**
   * Reads message history — the SAME seam shape `ChatClientConfig.history` uses,
   * and required for the same reason it is there: core does no HTTP and touches
   * no DOM. There is no `fetch`, no `XMLHttpRequest` and no URL anywhere in this
   * package; the binding owns the client, its auth headers and its retry policy,
   * and this interface owns only what to ask for and what to do with the answer.
   *
   * `GET /chat-services/api/v1/chat/sessions/{sessionId}/messages` is what the
   * shipped `@dhaam-ccrm/rest` adapter calls; a party-scoped route is a later
   * slice's adapter, behind this same interface.
   *
   * Required at CONSTRUCTION, not at first `open()`: a client that discovers its
   * history seam is missing only once a user opens a thread has turned a wiring
   * mistake into a runtime failure in front of that user.
   */
  readonly history: MessageHistorySource;

  /** Messages per history page. Defaults to core's `DEFAULT_PAGE_SIZE` (20). */
  readonly pageSize?: number;

  /** Defaults to the platform `WebSocket`. Injected by tests and by React Native. */
  readonly webSocketFactory?: WebSocketFactory;

  /** Defaults to `systemTimers`. Every timer in the connection goes through it. */
  readonly schedule?: ScheduleTimer;

  /** Defaults to `Date.now`. */
  readonly now?: Clock;

  /** Protocol version to speak. Defaults to the transport's. */
  readonly protocolVersion?: number;

  /** Diagnostics. Never called with credential material. See {@link ConversationLogger}. */
  readonly logger?: ConversationLogger;
}
