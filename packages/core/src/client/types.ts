// The public client contract — PRD §6.1-§6.5, assembled here because no
// single T7-T12 module owns the whole surface. See create-chat-client.ts for
// the wiring and the T13 report (delivered as this task's final response) for
// every judgment call this file embodies.
//
// ── Where this file's shape diverges from §6.1's literal text, and why ──
//
// §6.1's `ChatClientConfig` lists six fields: `publishableKey`, `getToken`,
// `apiUrl?`, `wsUrl?`, `storage?`, `logger?`, `protocolVersion?`. Building the
// client surfaced seams none of those six can satisfy:
//
//   - `localSender` (required). `ChatSession` carries both a `customer` and
//     an `assignedAgent` (state/types.ts), and nothing in §6.1's config lets
//     core tell which one this process is. Guessing CUSTOMER would mislabel
//     every message an agent-side embed sends (see messages/types.ts's
//     `LocalSender` doc). Required, not optional — a silently-wrong sender
//     label is worse than a construction-time type error.
//   - `history` (required). `MessageController` needs a `MessageHistorySource`
//     (messages/types.ts) and core does no HTTP itself (§4: network
//     *implementations* are explicitly NOT core's to own — only the
//     interface is). Pagination is core enough to nearly every integration
//     that an unconfigured default would just move the failure to the first
//     `loadOlderMessages()` call instead of to construction.
//   - `uploader` (optional). Same reasoning, but `sendAttachment()` is not
//     every integration's concern, so this is optional — omitting it costs
//     nothing until `sendAttachment()` is actually called, at which point it
//     rejects loudly. That check runs at the `ChatClient` boundary rather
//     than only inside the uploader stub passed to `MessageController`:
//     `MessageController#sendAttachment` never rejects on an upload failure
//     at all (it reports through `lastError`/the `error` event, §6.4), so a
//     stub alone would make "no uploader configured" indistinguishable from
//     a real runtime upload failure.
//   - `sessionActions` (optional). `reopenSession`/`closeSession` (§6.2) have
//     no WebSocket frame type in §7.3's catalog at all — confirmed by
//     openapi/chat-api.yaml's `/sessions/{id}/reopen` and `/sessions/{id}/close`
//     paths, both REST-only "same as v1". No T7-T12 module defines a seam for
//     them, so this file adds one, following the exact shape of `history`/
//     `uploader`: an interface core does not implement, only calls.
//   - `sessionSummarySource` (optional, T10). Backs `listSessions()` — the
//     session-picker's data source. Same shape of seam as `sessionActions`:
//     `GET /chat/sessions/customer` is REST-only, core does no HTTP, so this
//     is an interface core calls, never implements.
//   - `webSocketFactory`, `schedule`, `now` (all optional, advanced). Needed
//     to construct a deterministic, network-free end-to-end test through the
//     public API — and, not incidentally, to run on a React Native JS engine
//     whose `WebSocket` global (§11) may need a non-default factory. Every
//     T7-T12 module already injects its clock/scheduler/socket rather than
//     reading a global; these three fields are the only way `createChatClient`
//     can pass a caller's override down through construction.
//   - `pageSize`, `queueRetention` (optional). Direct pass-throughs to
//     documented override points `messages/types.ts` (`DEFAULT_PAGE_SIZE`)
//     and `queue/types.ts` (`SendQueueRetention`, "Open Question 9 ... ship
//     with a documented default rather than blocking on it") already declare
//     as intentionally tunable, not architectural.
//
// `apiUrl` is kept for §6.1 conformance even though core never reads it: with
// every REST seam injected (`history`, `uploader`, `sessionActions`), core
// itself makes zero HTTP calls, so there is nothing here for `apiUrl` to
// parameterize. It is accepted so a consumer can keep one config object and
// hand `apiUrl` to their own adapter construction; see the T13 report for the
// full "inject vs. default" reasoning, which cites openapi/chat-api.yaml's
// `servers` block (`{apiUrl}/chat-services/api/v1` — corrected mid-build from
// `{apiUrl}/v1`) as a concrete reason not to bake a REST base path into core.

import { ConnectionAbortedError, ConnectionSuspendedError } from '../connection/index.js';
import type { AuthToken, TokenProvider } from '../connection/index.js';
import type { IdentityProfile, IdentitySync } from '../identity/index.js';
import type {
  AttachmentUploader,
  LocalSender,
  MessageHistorySource,
  SendAttachmentOptions,
  SendMessageOptions,
} from '../messages/index.js';
import type { PresenceStatus } from '../protocol/index.js';
import type { RetryOutcome, SendQueueRetention } from '../queue/index.js';
import type {
  ChatError,
  ChatEventHandler,
  ChatEventMap,
  ChatEventName,
  ChatSession,
  ChatSessionSummary,
  ChatState,
  Unsubscribe,
} from '../state/index.js';
import type { StorageAdapter } from '../storage/index.js';
import type { Clock, ScheduleTimer } from '../presence/index.js';
import type { WebSocketFactory } from '../transport/index.js';

export { ConnectionAbortedError, ConnectionSuspendedError };
export type { AuthToken, TokenProvider };
export type { LocalSender, AttachmentUploader, MessageHistorySource, SendAttachmentOptions, SendMessageOptions };

/**
 * Backs `client.reopenSession()`/`client.closeSession()` (§6.2).
 *
 * Both are REST-only (`POST /chat-services/api/v1/chat/sessions/{id}/reopen`
 * and `/close`) — "There is no WebSocket frame type for this action in the T1
 * catalog" per the spec's own description of each route. The unprefixed
 * `/sessions/{id}/…` paths this comment used to name are served by nothing;
 * corrected in the spec and in `@dhaam-ccrm/rest`, and noted here only so the
 * comment stops pointing at dead routes.
 * Core does no HTTP (§4), so — exactly like `MessageHistorySource` and
 * `AttachmentUploader` — this is an interface core calls, never implements.
 *
 * Both methods return the REST `ChatSession` shape (openapi `ChatSession`
 * schema), which is field-for-field state/types.ts's `ChatSession` and,
 * unlike the WebSocket `SessionSnapshot` (protocol/domain.ts), carries full
 * `Profile` objects (`displayName`/`email`/`avatarUrl`) — so a configured
 * `sessionActions` also happens to be the one path that gives
 * `ChatState.session` fully-accurate participant profiles, rather than the
 * best-effort placeholders `session.ts`'s WS-only mapping produces.
 *
 * ── Reporting a change the server applied but could not confirm ──
 *
 * An implementation may need more than one round trip to produce the full
 * `ChatSession` (the REST adapter does: a mutating POST, then a read of the
 * full session). If the mutation lands and the follow-up fails, rejecting
 * plainly tells core the action did not happen, when in fact it did — and
 * `ChatState.session` is then quietly wrong.
 *
 * An implementation in that position should reject with an error carrying
 * `sessionMutationApplied: true`. Core checks for that property structurally,
 * imports nothing to do so, and responds by surfacing a `ChatError` through
 * `lastError` and the `error` event before re-throwing, so the staleness is at
 * least visible. Anything without the flag is passed through untouched.
 *
 * An implementation that retries such a failure must retry only the read, never
 * the mutation: `closeSession` is not idempotent on this service.
 */
export interface SessionActions {
  reopenSession(sessionId: string): Promise<ChatSession>;
  closeSession(sessionId: string): Promise<ChatSession>;

  /**
   * `POST /chat/sessions/{id}/csat` — record the customer's rating for their
   * own conversation.
   *
   * Deliberately NOT under the "reporting a change the server applied but
   * could not confirm" contract above: unlike `reopenSession`/`closeSession`,
   * this does not mutate `ChatState.session` — a rating is not a session
   * status — so there is no second round trip to fail independently of the
   * first, and no `sessionMutationApplied` case for an implementation to
   * signal. One request either recorded the rating and returned it, or it
   * did not; a rejection here is never ambiguous the way a read-back failure
   * is.
   *
   * `comment` omitted (not `undefined` explicitly passed) means no comment,
   * mirroring `SendMessageOptions`'s own optional-field convention.
   */
  submitCsat(sessionId: string, rating: number, comment?: string): Promise<CsatSubmission>;

  /**
   * `GET /chat/sessions/{id}/csat` — has this conversation already been rated,
   * and with what?
   *
   * The read half of `submitCsat`, and the reason it exists is that the POST
   * is an UPSERT server-side: without a way to ask, a binding's only memory of
   * "already rated" is its own in-process flag, which a page reload, a second
   * tab or another device destroys — so the survey re-arms over a rated
   * session and the next submit silently overwrites the score the customer
   * already gave. That is a server fact, so it is answered by the server.
   *
   * Same non-mutating contract as `submitCsat`: this never touches
   * `ChatState.session`, so it is outside the "reporting a change the server
   * applied but could not confirm" rule above.
   */
  getCsat(sessionId: string): Promise<CsatStatus>;
}

/**
 * Whether a session carries a rating — {@link SessionActions.getCsat}'s and
 * {@link ChatClient.getCsat}'s result.
 *
 * A discriminated pair rather than `CsatSubmission | null`: the route answers
 * an unrated session with a successful `{rated: false}` rather than a 404, so
 * "not rated yet" is an ANSWER, not an absence, and a caller must be able to
 * tell it apart from a lookup that failed (which rejects).
 */
export type CsatStatus =
  | { readonly rated: false }
  | {
      readonly rated: true;
      /** 1-5. */
      readonly rating: number;
      /** `null` when the customer left none. */
      readonly comment: string | null;
      /** ISO-8601. Absent only if the service omitted it. */
      readonly submittedAt?: string;
    };

/**
 * The stored result of a customer's post-conversation rating —
 * `SessionActions.submitCsat`'s return value and `ChatClient.submitCsat`'s.
 *
 * Not part of `ChatSession`: a rating describes the conversation but is not a
 * property of its lifecycle state the way `status`/`mode` are, and CSAT is
 * this client's only consumer of `chat_csat` — nothing else in `ChatState`
 * needs it merged into the session object.
 */
export interface CsatSubmission {
  readonly sessionId: string;
  /** 1-5. */
  readonly rating: number;
  /** `null` when the customer left no comment — never `undefined`, since this came back from a server response, not from an optional argument. */
  readonly comment: string | null;
  /** ISO-8601. */
  readonly submittedAt: string;
}

/**
 * Backs `client.listSessions()` (T10) — the customer's own recent sessions,
 * for the SDK's session-picker.
 *
 * REST-only, same reasoning as `SessionActions`: `GET
 * /chat/sessions/customer` (openapi's `listSessions` operation) has no
 * WebSocket frame counterpart, core does no HTTP (§4), so this is an
 * interface core calls, never implements.
 * `@dhaam-ccrm/rest`'s `createSessionSummarySource<ChatSessionSummary>(client)`
 * satisfies this structurally — same pattern as `history`/`uploader`/
 * `sessionActions`, so a divergence between the two packages fails to
 * typecheck at the consumer's `createChatClient(...)` call, not here.
 *
 * **A guest gets `200` with `[]`, never a 403/404** (see the `listSessions`
 * operation's own description) — `client.listSessions()` passes that
 * straight through as a normal, successful empty result. Do not treat
 * emptiness as absence of configuration or as a reason to retry; the picker
 * uses an empty array to decide not to render at all.
 */
export interface SessionSummarySource {
  listSessions(query?: { readonly limit?: number }): Promise<readonly ChatSessionSummary[]>;
}

/** Thrown when a `ChatClient` operation needs configuration that was not supplied. */
export class ChatClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatClientConfigError';
  }
}

/**
 * Thrown by {@link ChatClient.switchSession} when the switch did not complete.
 *
 * `switchSession` is a composite operation — tear the connection down,
 * re-establish it, join the chosen session, wait for its snapshot, load page
 * one — and every one of those steps can fail for a reason the caller can act
 * on: the server refused the join (not your session), the snapshot never
 * arrived, or the reconnect was aborted out from under it. Before this existed
 * they all failed the same way: silently, with the picker row highlighted and
 * the transcript unchanged.
 *
 * A connection that is merely DOWN is not one of them. The switch opens its
 * own connection, so a dead socket is something it recovers from rather than
 * something it reports; the promise stays pending until the connection comes
 * up or is explicitly abandoned.
 *
 * `cause` carries the same {@link ChatError} that was written to
 * `ChatState.lastError` and emitted as `error`, so a caller may handle this
 * either way — by catching, or by watching state — without the two
 * disagreeing.
 */
export class SessionSwitchError extends Error {
  /** The session that could not be switched to. */
  readonly sessionId: string;

  /** The failure, in the same shape `ChatState.lastError` reports it. */
  readonly cause: ChatError;

  constructor(sessionId: string, cause: ChatError) {
    super(`could not switch to session "${sessionId}": ${cause.message}`);
    this.name = 'SessionSwitchError';
    this.sessionId = sessionId;
    this.cause = cause;
  }
}

/**
 * §6.1, extended with the seams construction revealed — see this file's
 * header for exactly which fields are additive and why.
 */
export interface ChatClientConfig {
  /** `dhp_live_…` / `dhp_test_…`. Validated at construction (§10.1, §10.2, §14) — a secret key throws loudly rather than reaching the wire. */
  readonly publishableKey: string;

  /**
   * WHO this client talks to, when it is not the support desk — the
   * (role, id) pair, e.g. `{ role: 'merchant', id: '42' }`.
   *
   * Omit it and this client is the support conversation it has always been;
   * every existing integration is unaffected.
   *
   * Set once, at `createChatClient()`. It is part of WHICH conversation this
   * client holds, not a filter on it — a host that needs to talk to two
   * merchants creates two clients.
   *
   * The ROLE names the counterparty, never the caller: the caller's own role
   * rides the server-minted token and cannot be influenced from here. The
   * server validates it against a closed set, and refuses a caller who is not
   * permitted to OPEN a conversation with that counterparty (a merchant may
   * reply in one, never start one).
   */
  readonly target?: { readonly role: string; readonly id: string };

  /** Initial conversation subject / store name, if any. */
  readonly subject?: string;

  /**
   * §6.1 types this `() => Promise<string>`. Widened here to `TokenProvider`
   * (connection/types.ts) — `Promise<string | AuthToken> | string | AuthToken`
   * — which is a strict superset: every `() => Promise<string>` already
   * satisfies it, so nothing conforming to the literal PRD signature breaks.
   * The extra room lets a host report `expiresInMs` so §10.4's proactive
   * refresh actually has something to schedule against, instead of always
   * falling back to the reactive `AUTH_EXPIRED` path. `auth/token-source.js`'s
   * `createTokenProvider` is the intended way to produce one of these from a
   * real token endpoint's response. A bare `string` config value is still a
   * type error either way — the one thing §6.1 forbids stays forbidden.
   */
  readonly getToken: TokenProvider;

  /**
   * REST base. Accepted for §6.1 conformance; core makes no HTTP calls of its
   * own (every REST seam below is injected), so nothing here reads it. Kept
   * so a consumer can build their `history`/`uploader`/`sessionActions`
   * adapters from the same config object instead of duplicating a URL.
   */
  readonly apiUrl?: string;

  /**
   * WebSocket base. §6.1 types this optional, but core has no legitimate
   * default to fall back to — §12.7 is an explicit rejection of hardcoded or
   * derived hosts ("no port-swap heuristics ... no single fixed multi-tenant
   * SaaS domain to hardcode", echoed in openapi/chat-api.yaml's `servers`
   * block). Omitting it is therefore a loud `ChatClientConfigError` at
   * `createChatClient()`, not a silent no-op or a guessed URL.
   */
  readonly wsUrl?: string;

  /** Durable KV (§9.1). Defaults to `new MemoryStorageAdapter()` — survives a network blip, not a reload. */
  readonly storage?: StorageAdapter;

  /** §14: never receives credential or message content. Routed to the transport's malformed-frame / anomaly warnings. */
  readonly logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;

  /** Overrides the highest protocol version this client advertises (§7.5). Defaults to the transport's own default. */
  readonly protocolVersion?: number;

  /**
   * Who this client sends as (§6.3's `sendMessage`, and, so that typing
   * self-echo filtering and read watermarks key the right participant,
   * presence too — see create-chat-client.ts's `resolveLocalSender`).
   *
   * Required: `ChatSession` carries both a `customer` and an `assignedAgent`,
   * and nothing else in this config tells core which one the local process
   * is. A thunk is accepted for the case identity is not known until after
   * the host's own auth completes; `createChatClient` calls it once, eagerly,
   * at construction, to seed presence/typing/watermark identity as well as
   * message labeling. See the T13 report for what happens if the thunk needs
   * data that is only available after `connect()`.
   *
   * ── Staff (agent / merchant) clients ───────────────────────────────────
   * `LocalSender.senderType` is a full `SenderType` (protocol/enums.ts), so `'AGENT'` is
   * already expressible here and an agent or merchant app needs no new field
   * to say who it is. What this value is NOT is a claim the server honours:
   * the server derives the recorded `senderType` from the connection's
   * verified token claims alone, and there is no role field on any
   * client→server frame for it to read instead. Configuring `'AGENT'` while
   * holding a customer token therefore does not make this client an agent —
   * it only mislabels the local optimistic echo, which the server corrects
   * via `senderType` on the `message.send` ack (`MessageSendAckData` in
   * protocol/frames.ts).
   *
   * So: set this to match the token the host will hand to `getToken`. It is a
   * rendering hint for the local echo, never an authorization input.
   */
  readonly localSender: LocalSender | (() => LocalSender);

  /** Backward-cursor history reads (§6.3, §12.10). Required — see this file's header. */
  readonly history: MessageHistorySource;

  /** Step one of the upload-then-announce flow (§6.3, §12.10). Optional — `sendAttachment()` throws {@link ChatClientConfigError} if omitted and called. */
  readonly uploader?: AttachmentUploader;

  /** Backs `reopenSession`/`closeSession` (§6.2). Optional — each throws {@link ChatClientConfigError} if omitted and called. */
  readonly sessionActions?: SessionActions;

  /** Backs `listSessions()` (T10). Optional — throws {@link ChatClientConfigError} if omitted and called. */
  readonly sessionSummarySource?: SessionSummarySource;

  /**
   * The logged-in user's CRM profile, synced through `identitySync`. The pair
   * — not either half — is the switch: a guest has no profile to send, and a
   * host that supplies one but no transport should be inert rather than a
   * construction error, so core does nothing unless both are set.
   */
  readonly identityProfile?: IdentityProfile;

  /**
   * Transport for the above. Core does no HTTP of its own, same as
   * `history`/`uploader` (`packages/rest`'s `createIdentitySync` implements
   * this one). Unlike those, omitting it never throws from anywhere: the sync
   * is fire-and-forget CRM bookkeeping and no user-visible path waits on it.
   */
  readonly identitySync?: IdentitySync;

  /** Advanced: overrides the platform `WebSocket` global (§11 — React Native, tests). Defaults to the ambient global, probed lazily at connect time. */
  readonly webSocketFactory?: WebSocketFactory;

  /** Advanced: overrides every timer this client schedules (reconnect backoff, heartbeat, ack timeout, typing auto-clear). Defaults to real timers. */
  readonly schedule?: ScheduleTimer;

  /** Advanced: overrides the clock used for envelope timestamps and retention age checks. Defaults to `Date.now`. */
  readonly now?: Clock;

  /** Page size for `loadOlderMessages()` (§6.3, §12.10). Defaults to `DEFAULT_PAGE_SIZE` (20, v1's proven value). */
  readonly pageSize?: number;

  /** §9.6 bounds for the offline send queue. Both have documented defaults; see `queue/types.ts`. */
  readonly queueRetention?: SendQueueRetention;
}

/**
 * The full public surface — §6.2 (session ops), §6.3 (message ops), §6.4
 * (observable state), §6.5 (events, via `on`).
 */
export interface ChatClient {
  // ---- §6.4 observable state surface ----
  getState(): ChatState;
  subscribe(listener: (state: ChatState) => void): Unsubscribe;
  on<E extends ChatEventName>(event: E, handler: ChatEventHandler<E>): Unsubscribe;

  // ---- §6.2 session / channel operations ----
  /** Opens the connection and drives it to `connected` (§8). Rejects with {@link ConnectionSuspendedError} or {@link ConnectionAbortedError}. */
  connect(): Promise<void>;
  /** User-initiated, terminal (§8.1). No auto-reconnect follows. */
  disconnect(): void;
  /**
   * Abandons the armed reconnect backoff and attempts immediately.
   *
   * For a binding that has learned the reason the last attempts failed is
   * gone — the platform reporting the network back is the only real case.
   * Backoff has by then usually grown to its 30s cap, and waiting it out on a
   * device that is plainly online again is what "it just says Connecting…" is.
   *
   * Deliberately narrow, and NOT a second `connect()`: it creates and settles
   * no promise, leaves the auth escalation counter alone (a network blip is no
   * evidence a rejected token was fixed), and resets only the transport
   * attempt counter. It acts ONLY while core is waiting out a backoff
   * (`connectionState === 'reconnecting'`) and returns `false` — a pure no-op,
   * safe to call on any cadence — in every other state, including `suspended`
   * and `closed`, which §8.1 makes recoverable only by an explicit `connect()`.
   *
   * @returns whether an attempt was actually started.
   */
  retryNow(): boolean;
  /**
   * Sends the raw `session.join` frame and nothing else.
   *
   * Fire-and-forget, like `leaveSession`/`requestAgent`: a successful join is
   * observed through the `session.updated` snapshot that follows
   * (`ChatState.session` becomes `sessionId`), not through this call's own
   * return. A REJECTED join (the server's ownership check — v2/handlers.ts —
   * refusing a session that does not belong to this customer) is surfaced
   * through `ChatState.lastError`/the `error` event, same as every other
   * protocol-level failure (§6.4) — it does not throw here and does not
   * silently vanish either.
   *
   * **This is the protocol primitive, not "switch to this conversation".** It
   * writes one frame and returns. It fetches no history for the session it
   * names, does not drop the resume anchor (a position in a *per-session*
   * history — carrying it across is what strands a client in `suspended`), and
   * does not wait for, or report on, the outcome.
   *
   * What it does NOT leave behind is a torn view: when the server's
   * `session.updated` for the joined session arrives, `ChatState.session` and
   * every per-session projection are replaced in one write, so the transcript
   * on screen always belongs to the session named above it. That is a property
   * of how snapshots are applied, not of this method — it holds for a
   * reconnect the server resolves elsewhere too. The result is an EMPTY
   * transcript for the newly-joined session until somebody asks for its
   * history, which is the honest rendering of "you joined a conversation and
   * did not load it".
   *
   * Use {@link ChatClient.switchSession} to actually change conversations.
   * This method remains for callers that genuinely want the bare frame — an
   * agent-side console attaching to a session it is already displaying
   * separately, or a test asserting on the wire.
   */
  joinSession(sessionId: string): void;
  /**
   * Switches the client to a different session — the session-picker's action.
   *
   * The composite operation, and the counterpart to {@link
   * ChatClient.startNewSession}: where that one leaves the current session for
   * a brand-new one, this one leaves it for an EXISTING one — and, like that
   * one, it does so by TEARING DOWN and re-establishing rather than by
   * transitioning in place. In order:
   *
   *   1. the connection is dropped, along with everything it had in flight;
   *   2. typing timers and presence — both descriptions of a conversation no
   *      longer on screen — are cleared;
   *   3. the resume anchor is dropped: it is a position in a *per-session*
   *      history (§12.5), and carrying it across makes the next
   *      `connection.hello` ask to resume from a `seq` the new session has
   *      never reached, which the v2 endpoint refuses NON-RETRYABLY and which
   *      strands the client in `suspended`;
   *   4. the chosen session is recorded durably, and a fresh connection is
   *      opened;
   *   5. `session.join` is sent on it and its ack awaited — one join, with
   *      nothing else in flight to race it. It is needed because
   *      `connection.hello` carries no session id, so the server resolves the
   *      customer's most-recently-updated ACTIVE session on its own, which for
   *      a picked CLOSED/RESOLVED conversation is a different one;
   *   6. and page one of the new session's history is loaded.
   *
   * **The session on screen does not change until step 6's snapshot lands, and
   * when it does, it changes completely.** `ChatState.session` and every
   * per-session projection — `messages`, `pagination`, `typing`,
   * `unreadCount`, `readWatermarks`, `deliveredWatermarks`, `presence`,
   * `lastError` — move in ONE `setState`. For the whole of the operation the
   * outgoing conversation stays intact and self-consistent: the header keeps
   * naming it, the transcript keeps showing it, `sendMessage` keeps composing
   * into it. There is no interval in which one conversation's identity is
   * readable against another's data, in either direction. `pastSessions` is
   * deliberately kept across the change: it is a list *about* other sessions,
   * not state *of* this one.
   *
   * **Queued sends for the outgoing session are PRESERVED, not failed.** Each
   * one carries the session it was composed in
   * (`MessageSendPayload.sessionId`) and the queue refuses to pump any session
   * but the joined one, so an entry cannot be misdelivered into the
   * conversation being opened. It waits instead, goes out the moment its own
   * session is joined again, and is still bounded by §9.6 retention. (Contrast
   * `startNewSession`, which fails them: there the session really is ending.)
   *
   * **Resolves only once that first page is in `ChatState.messages`**, so a
   * caller can show a spinner for exactly the duration of the switch and know
   * the transcript is on screen when it settles. Awaiting the `session.join`
   * ack alone would not be enough: that ack is `EmptyAckData` (`{ ok: true }`,
   * protocol/frames.ts) and carries no snapshot — the session itself arrives
   * as a separate `session.updated` push the server volunteers afterwards.
   *
   * **Costs one extra round trip** — the handshake on the new connection —
   * versus an in-place join. That is the price of the guarantee above, paid
   * deliberately.
   *
   * **Rejects with {@link SessionSwitchError}** if the server refused the
   * join, the snapshot never arrived, or the reconnect it needs was aborted
   * (by `disconnect()`, `startNewSession()`, or a newer switch that is not
   * this one). The same failure is also written to `ChatState.lastError` and
   * emitted as `error`, so either style of handling works — but the promise is
   * the one that tells a picker that *this particular row* did not open. Do
   * not call it and drop the promise on the floor.
   *
   * **A failed switch changes nothing.** Nothing was torn down in state to
   * begin with, so there is no rollback and no recovery fetch: the customer is
   * still looking at the conversation they never left, with its transcript
   * intact and its `lastError` naming what went wrong.
   *
   * **Two rapid switches**: the later one wins outright. It aborts the
   * earlier one's reconnect, so that one resolves quietly rather than
   * reporting a failure nobody asked about, and no page it fetched can reach
   * the winner's transcript.
   *
   * Switching to the session already on screen is a no-op that resolves
   * immediately: no teardown, no frame, no refetch.
   *
   * The chosen session is remembered through `ChatClientConfig.storage`, so a
   * page reload re-joins it rather than falling back to whatever session the
   * server picks for a `connection.hello` — which carries no session id at
   * all, leaving the server to re-resolve the customer's most recently
   * updated ACTIVE session. That is very often not the one being read, since
   * a session picked out of a picker is usually CLOSED or RESOLVED. Supply a
   * durable adapter (`createBrowserStorageAdapter()`) for that to survive a
   * real reload; the default `MemoryStorageAdapter` does not.
   *
   * `v2/handlers.ts` already ownership-checks `session.join` and already
   * accepts a TERMINAL session (`CLOSED`/`RESOLVED`) — switching to a past,
   * closed conversation is exactly that path, not a special case this SDK
   * adds. Joining a terminal session does not, by itself, reopen it and does
   * not optimistically flip `status` locally — this client never guesses at
   * a status the server has not confirmed (§9.4). Reopening only happens if
   * the customer then sends a message into it: node T1 (backend) reactivates
   * a terminal session to `WAITING_FOR_AGENT` on the next CUSTOMER message,
   * behind `FEATURE_SESSION_REACTIVATE_ON_CUSTOMER_MESSAGE` (default OFF),
   * and this client only ever learns that happened from the resulting
   * `session.updated` — never assumes it.
   *
   * A `statusChange` event is NOT emitted for the new session's status, even
   * when it differs from the old one's: §6.5 defines that event as "the
   * session you are in changed status", and a different session having a
   * different status is a different chat, not a change.
   *
   * ── The SWITCHED-close pairing ──
   *
   * That same reactivation may ALSO close the customer's other still-active
   * session with `closeReason: 'SWITCHED'` server-side (one customer, one
   * live conversation). This client can therefore observe one `session.closed`
   * (for the session just left) and one `session.updated`/reactivation (for
   * the session just switched into) in either order. Both are handled so
   * that pair can never corrupt the session just switched into: `SWITCHED`
   * is a parked close (§12.5) so the old session's queued sends are left
   * alone rather than failed, and the `sessionClosed` event and `closedAt`
   * stamp only ever apply to whichever session `frame.d.sessionId` actually
   * names, never to whatever happens to be `ChatState.session` at the moment
   * the frame arrives. A customer who has already switched will not be told
   * their NEW chat just closed because their OLD one, elsewhere, did.
   */
  switchSession(sessionId: string): Promise<void>;
  leaveSession(): void;

  /**
   * Abandons the current session and opens a brand-new one (§12.5).
   *
   * The recovery path out of a terminal `session.closed` — the reason a
   * closed conversation is not a dead end. An agent resolving a chat leaves
   * the client holding a session it may no longer send into, and there is no
   * other way back: `disconnect()` + `connect()` re-sends the old session's
   * `resumeFrom`, which the server refuses non-retryably ("resumeFrom is
   * ahead of this session"), landing the client in `suspended`.
   *
   * Resolves once `connection.ack` for the NEW session has been applied, so
   * `getState().session` is the new one by the time it settles. On resolution:
   *
   *   - `session.id` is new and `messages` is empty — a new conversation must
   *     not read as a continuation of the old transcript;
   *   - watermarks, presence, typing and unread are cleared, none of which
   *     mean anything across a session boundary;
   *   - any send still queued for the old session has been failed with
   *     `'sessionClosed'` rather than delivered into this one (see
   *     {@link SendFailureReason}) — `message.send` has no `sessionId` on the
   *     wire, so an entry that outlived its session would land here.
   *
   * `pastSessions` is left alone; it describes other sessions, not this one.
   *
   * Rejects with whatever `connect()` rejects with ({@link
   * ConnectionSuspendedError}, {@link ConnectionAbortedError}). The old
   * session is already abandoned if it does — this is not atomic, and a
   * caller that retries should call it again rather than assume the old
   * session is still there.
   *
   * `payload` is the widget's "New conversation" screen: `subject` free
   * text, `topic` one of the merchant's own configured chips. Both optional
   * and independent of each other; omitting the argument entirely, or
   * passing `{}`, behaves exactly as before this parameter existed — no
   * topic is sent, and the new session gets none. Carried onto the
   * `connection.hello` that reopens the socket
   * (`ConnectionHelloPayload.subject`/`.topic`, protocol/frames.ts), so it
   * survives a transport retry the same way the "start a new session"
   * intent itself does.
   */
  startNewSession(payload?: { readonly topic?: string; readonly subject?: string }): Promise<void>;
  requestAgent(reason?: string): void;
  /**
   * Record contact-info enrichment for the console's contact-info panel — the
   * IP-watermark pair, the raw user agent, and/or a GPS fix — for the NEXT
   * `connection.hello` this client sends (`ConnectionHelloPayload.ip`/
   * `.ipWatermark`/`.userAgent`/`.geo`, protocol/frames.ts).
   *
   * Merged, not replaced, and callable more than once: the embedding widget
   * is expected to call this incrementally as each piece resolves —
   * `navigator.userAgent` synchronously at session start, the ip-watermark
   * fetch and the Geolocation permission prompt later and independently, each
   * on its own schedule. A key omitted from a given call is left exactly as
   * it was; there is no way to un-set one once recorded.
   *
   * Deliberately synchronous and inert beyond recording the values: this does
   * NOT fetch anything, does not touch `navigator`, and does not itself send
   * a frame or gate `connect()` — core stays framework/environment-agnostic
   * (no HTTP calls, no browser globals; see client/types.ts's header on
   * `apiUrl`). The widget owns gathering these values and is expected to call
   * `connect()` immediately regardless of whether any of them are ready yet:
   * a value recorded after the hello already went out simply waits for the
   * next one (typically a reconnect), which is an accepted trade-off — GPS in
   * particular must never gate the chat opening, and an IP-watermark fetch
   * that is merely slow should not either.
   */
  setContactInfo(info: {
    readonly ip?: string;
    readonly ipWatermark?: string;
    readonly userAgent?: string;
    readonly geo?: { readonly lat: number; readonly lng: number };
  }): void;
  /** REST-only (§6.2, §12.5). Throws {@link ChatClientConfigError} if `config.sessionActions` was not supplied. */
  reopenSession(sessionId: string): Promise<ChatSession>;
  /** REST-only (§6.2). Throws {@link ChatClientConfigError} if `config.sessionActions` was not supplied. */
  closeSession(): Promise<void>;
  /**
   * Records the customer's rating for `sessionId` — the post-conversation
   * CSAT survey's `onSubmit`.
   *
   * REST-only, and — unlike `reopenSession`/`closeSession` — never touches
   * `ChatState.session`: a rating is not part of the session's lifecycle
   * state, so there is nothing here for a subscriber watching `session` to
   * react to. A binding that wants to know a rating was given tracks that
   * itself (the widget's own `ratedSessionId`, keyed off this call
   * resolving), the same way `SessionActions.submitCsat`'s own doc explains
   * why this is not under the "session mutation applied" reporting contract.
   *
   * Throws {@link ChatClientConfigError} if `config.sessionActions` was not
   * supplied. Otherwise rejects with whatever the adapter rejects with — the
   * survey's own submit button (`ui/csat.ts`) needs a direct signal to show
   * its own retry state, not a side channel.
   */
  submitCsat(sessionId: string, rating: number, comment?: string): Promise<CsatSubmission>;
  /**
   * Whether `sessionId` has already been rated — the survey's own gate.
   *
   * REST-only, and non-mutating in exactly the way `submitCsat` is: it writes
   * nothing to `ChatState`, because a rating is not part of a session's
   * lifecycle state and a binding that wants it holds it itself.
   *
   * Throws {@link ChatClientConfigError} if `config.sessionActions` was not
   * supplied. Otherwise rejects with whatever the adapter rejects with — a
   * caller must be able to tell "this session is unrated" (a resolved
   * `{rated: false}`) from "I could not find out", because those two answers
   * lead to opposite decisions about showing a survey that would overwrite an
   * existing score.
   */
  getCsat(sessionId: string): Promise<CsatStatus>;
  /**
   * The session-picker's data source (T10) — the customer's own recent
   * sessions, most recent first.
   *
   * Also writes the result to `ChatState.pastSessions` wholesale (§9.4-style
   * replace, not a merge), so a caller does not need a second `getState()`
   * round trip to render the picker — the returned array and
   * `getState().pastSessions` are the same data.
   *
   * REST-only. Throws {@link ChatClientConfigError} if
   * `config.sessionSummarySource` was not supplied. Otherwise rejects with
   * whatever the adapter rejects with — this does not swallow a failure into
   * `lastError` the way `loadOlderMessages` does, because a picker calling
   * this once on open needs a direct signal to show its own "couldn't load"
   * state, not a side-channel it would have to separately subscribe to.
   *
   * **An empty result (including for an unidentified/guest caller) is a
   * normal, successful resolution — `[]` — never an error and never
   * distinguished from "no sessions yet".** Do not add a check for this;
   * see {@link SessionSummarySource}'s doc for why the wire itself makes no
   * such distinction.
   */
  listSessions(query?: { readonly limit?: number }): Promise<readonly ChatSessionSummary[]>;

  // ---- §6.3 message operations ----
  sendMessage(content: string, opts?: SendMessageOptions): Promise<void>;
  /**
   * Rejects synchronously with {@link ChatClientConfigError} if `config.uploader`
   * was not supplied — checked explicitly at the `ChatClient` boundary,
   * because `MessageController#sendAttachment` (messages/) does not reject
   * on an upload failure at all: it reports through `ChatState.lastError`/
   * the `error` event instead, with a fixed generic message, so a genuine
   * runtime upload failure and a missing `config.uploader` would otherwise
   * be indistinguishable. A configured uploader's own failures still follow
   * that same lastError/`error` path unchanged, per §6.4.
   */
  sendAttachment(file: Blob, opts?: SendAttachmentOptions): Promise<void>;
  /**
   * Retries a permanently-failed send (T10, wrapping T9's `SendQueue.retry`
   * verbatim) — the id is the message's own permanent id (D1), the SAME one
   * `ChatMessage.id`/`sendFailed.id` already carry, so a Retry button on an
   * already-rendered failed bubble needs no new id to track.
   *
   * Replays the ORIGINAL envelope under its original id (the server dedupes
   * on it, §9.3) rather than minting a new message — so retrying never
   * produces a second, independently-failing copy of what the user
   * experiences as one message.
   *
   * Resolves to a {@link RetryOutcome} the caller can branch on directly,
   * never a bare boolean or a thrown error for the ordinary refusal case:
   *
   *   - `{status: 'retried', entry}` — durably re-queued and draining;
   *     `getState().messages` is updated synchronously before this resolves,
   *     so the message reads `delivery: {state: 'queued'}` again immediately
   *     (its eventual ack/failure arrives the normal way, through the
   *     `message`/`messageAck`/`sendFailed` events).
   *   - `{status: 'refused', reason: 'not-found'}` — nothing eligible under
   *     this id (already retried, already succeeded, or never failed).
   *   - `{status: 'refused', reason: 'not-retryable'}` — retrying is not
   *     worth attempting. This is also what a caller gets for an id whose
   *     failed send belonged to a session that is no longer the one
   *     currently joined (T10): `message.send` carries no `sessionId` on the
   *     wire, so replaying that id now would silently attribute it to
   *     whatever session IS current — exactly the misattribution
   *     `startNewSession`/`switchSession` already guard against on the
   *     reconnect path (see `SendFailureReason.sessionClosed`'s doc). A
   *     caller does not need to special-case this — it is folded into the
   *     ordinary `'not-retryable'` refusal, so "don't show a Retry button"
   *     is decided the same way regardless of why.
   *
   * Check `ChatMessage.delivery`'s `failed.retryable`/`failed.code` (state/
   * types.ts) BEFORE ever calling this, to decide whether to render the
   * Retry affordance in the first place — this method is what runs when the
   * user presses it, not what decides whether to show it.
   */
  retryMessage(id: string): Promise<RetryOutcome>;
  markRead(): void;
  startTyping(): void;
  stopTyping(): void;
  /** §6.3 names this `loadOlderMessages`; `MessageController` (messages/) implements it as `loadMore` — this is the public name. */
  loadOlderMessages(): Promise<void>;

  // ---- presence operations (§7.3's `presence.set`/`presence.query`; not named as ChatClient methods anywhere in §6.3's table, added for parity with the "presence/typing/read operations" every binding needs — see the T13 report) ----
  setPresence(status: PresenceStatus): void;
  queryPresence(participantIds?: readonly string[]): void;
}
