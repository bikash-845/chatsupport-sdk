// @dhaam-ccrm/core — framework-agnostic chat SDK core.
//
// Hard invariant: this package has ZERO framework, UI, and DOM-document
// dependencies. It may reference the `WebSocket` global; it may not reference
// `window` or `document` outside an explicitly isolated platform adapter
// (storage/browser.ts). See docs/spec/chat-sdk-v2-prd.md §4 and §15.
//
// This is the front door (T13): `createChatClient` assembles the ten
// modules under src/ into the single `ChatClient` PRD §6.2-§6.5 describe.
// Everything below is a deliberate decision about what leaves the package —
// see each section for the reasoning; the full account is this task's
// final report.
//
// ── What is NOT exported, and why ──
//
//   connection/  ConnectionController, the state machine, ResumeTracker,
//                token.ts, FakeTransport — the engine `createChatClient`
//                drives. A consumer never constructs one directly; `connect`/
//                `disconnect` (below) are the only surface. The two error
//                classes a rejected `connect()` can throw ARE public — see
//                client/ below.
//   messages/    MessageController and the `EnqueueSend` wiring type — the
//                engine, not the seam. The seam types a consumer implements
//                (`MessageHistorySource`, `AttachmentUploader`, `LocalSender`)
//                ARE public — see client/ below.
//   presence/    PresenceCoordinator, TypingController, PresenceRegistry,
//                WatermarkTracker, the outbound-intent plumbing — all
//                internal engine. A consumer drives presence/typing/read
//                state through `ChatClient`'s methods and observes it
//                through `ChatState`/events, never through this module.
//   queue/       SendQueue and everything around it — internal engine with
//                no consumer-facing surface at all. `SendFailureReason` (the
//                one type from this module a consumer needs, since it is
//                part of `ChatMessage.delivery` and the `sendFailed` event)
//                is re-exported from state/ below, not from here.
//   backoff/     Pure delay computation the connection layer consumes
//                internally. Nothing here is meaningful without the state
//                machine driving it.
//   transport/   WebSocketTransport itself, frame encode/decode, the ack
//                registry, heartbeat — all internal engine. `WebSocketFactory`
//                (needed to *type* `ChatClientConfig.webSocketFactory`) is
//                the one type surfaced. Test doubles (`StubWebSocket`,
//                `StubSocketFactory`) are deliberately NOT exported — a real
//                customer's bundle has no use for a fake socket; they stay
//                available via a subpath import for anyone testing against a
//                locally-checked-out core, same as this package's own tests
//                use them.
//
// ── What IS exported ──
//
//   client/      createChatClient, ChatClient, ChatClientConfig, and every
//                seam a consumer must implement to supply one
//                (MessageHistorySource, AttachmentUploader, SessionActions,
//                SessionSummarySource, LocalSender) or may want to catch
//                (ChatClientConfigError, ConnectionAbortedError,
//                ConnectionSuspendedError) — plus isHandledByCurrent (T10),
//                the one canonical "is handledBy safe to narrate as active"
//                derivation, same spirit as messages/'s deriveTickState.
//   identity/    IdentityProfile and IdentitySync — the two seam types
//                behind `ChatClientConfig.identityProfile`/`.identitySync`.
//                Type-only, because the module has no runtime surface at
//                all: the `POST /identify` call is made by an injected
//                implementation (packages/rest's `createIdentitySync`), so
//                there is nothing here for a consumer to construct. Public
//                for the same reason AttachmentUploader is — a host cannot
//                populate a config field whose type it cannot name.
//   state/       ChatState and everything it is built from (§6.4) — the
//                observable surface — plus the §6.5 event catalog types.
//   protocol/    The domain enums and shapes that appear inside ChatState/
//                ChatMessage/ChatSession and the seam interfaces above
//                (SenderType, MessageType, ChatStatus, ChatMode, CloseReason,
//                ParticipantType, PresenceStatus, AttachmentMetadata,
//                MessageMetadata, PresenceEntry, ErrorCode). NOT the wire
//                frame catalog itself (Frame, ClientFrame, ServerFrame, the
//                frame-type string unions) — those are transport's alphabet,
//                never a consumer's.
//   auth/        parsePublishableKey and friends, for a consumer that wants
//                to validate a key before constructing a client (e.g. in a
//                settings form), plus createTokenProvider/toAuthToken — the
//                documented adapter from a real §10.3 token endpoint's
//                response shape to `getToken`'s contract. NOT redact.ts —
//                pure internal hygiene with no consumer-facing use.
//   storage/     StorageAdapter (T4 flagged this as unexported — it wasn't;
//                fixed here) plus both shipped adapters, so a consumer can
//                configure durable storage without reaching past the barrel.
//   messages/'s  list algebra (compareBySeq/sortMessages/upsertMessage/
//                prependPage) — messages/index.ts's own barrel comment says
//                why: "ordering and dedup are protocol rules (D1, D2) that a
//                binding writing its own optimistic UI has to honour
//                identically."

export { createChatClient } from './client/index.js';
export {
  ChatClientConfigError,
  ConnectionAbortedError,
  ConnectionSuspendedError,
  // `switchSession()` is a composite operation (abandon, reset, join, wait
  // for the snapshot, load page one) and every step of it can fail in a way
  // a picker must be able to report on the row the user clicked. Public so a
  // caller can tell that apart from an ordinary rejection.
  SessionSwitchError,
  // The one canonical `handledBy`-staleness derivation (T10) — every binding
  // gates "connected to <name>" copy on this rather than re-deriving the
  // WAITING_FOR_AGENT-after-reactivation rule ad hoc. Same reasoning as
  // deriveTickState above.
  isHandledByCurrent,
} from './client/index.js';
export type {
  AttachmentUploader,
  AuthToken,
  ChatClient,
  ChatClientConfig,
  CsatStatus,
  CsatSubmission,
  LocalSender,
  MessageHistorySource,
  SendAttachmentOptions,
  SendMessageOptions,
  SessionActions,
  SessionSummarySource,
  TokenProvider,
} from './client/index.js';

// ---------------------------------------------------------------------------
// identity/ — the two ChatClientConfig identity seams. Type-only: this module
// contributes no runtime export, so the hand-typed allowlist in
// test/invariants/public-barrel-surface.test.ts is deliberately unchanged by
// this addition.
// ---------------------------------------------------------------------------

export type { IdentityProfile, IdentitySync } from './identity/index.js';

// ---------------------------------------------------------------------------
// conversation/ — the KEYLESS (staff/party) surface: a merchant, a manager or
// an admin observer, holding a dh-auth id_token and no publishable key.
//
// A separate factory rather than a widened `ChatClientConfig`, deliberately:
// `publishableKey: process.env.PK` evaluating to `undefined` must not silently
// become a keyless staff connection, which is the hole `validate.ts` closed on
// the wire and that widening the customer config would reopen one layer up.
// `createChatClient` and `ChatClientConfig` are untouched by any of this.
//
// Three runtime names on the hand-typed allowlist in
// test/invariants/public-barrel-surface.test.ts: the factory, and the two
// errors `open()` and `sendMessage()` reject with — both of which a caller is
// expected to catch and branch on, so both have to be `instanceof`-checkable.
// ---------------------------------------------------------------------------

export { createConversationClient } from './conversation/index.js';
export { ConversationJoinError, ConversationNotOpenError } from './conversation/index.js';
export type {
  ConversationClient,
  ConversationClientConfig,
  ConversationJoinFailure,
  ConversationLogger,
  ConversationsState,
} from './conversation/index.js';

// ---------------------------------------------------------------------------
// state/ — the observable surface (§6.4) and event catalog (§6.5).
// ---------------------------------------------------------------------------

export { CHAT_EVENT_NAMES, CONNECTION_STATE_VALUES, createInitialChatState } from './state/index.js';
export type {
  ChatError,
  ChatEventHandler,
  ChatEventMap,
  ChatEventName,
  ChatMessage,
  ChatParticipantProfile,
  ChatSession,
  ChatSessionSummary,
  ChatState,
  ChatTicket,
  ConnectionState,
  Unsubscribe,
} from './state/index.js';

// `MessageDelivery` is part of `ChatMessage`'s public shape but is not
// re-exported by state/index.ts itself (unlike `SendFailureReason`, which
// queue/index.ts re-exports from the same source file). A type-only import
// straight from state/types.ts costs nothing at runtime and does not modify
// that module — see the T13 report for why this is flagged as a gap in
// state/index.ts rather than fixed there (out of this task's scope lock).
export type { MessageDelivery } from './state/types.js';

// ---------------------------------------------------------------------------
// messages/ — the seams a consumer implements, and the list algebra a
// binding writing custom optimistic UI needs to match core's own ordering.
// ---------------------------------------------------------------------------

export { compareBySeq, prependPage, sortMessages, upsertMessage } from './messages/index.js';
export { DEFAULT_PAGE_SIZE, NoActiveSessionError } from './messages/index.js';

// The canonical tick derivation. Every binding renders ticks from THIS — a
// binding computing its own is the divergence the conformance suite exists to
// catch, and v1's version conflated presence with delivery. It was exported
// from messages/index.ts but never promoted here, and core's single "." exports
// entry blocks any subpath workaround, so no binding could reach it at all.
export { MESSAGE_TICK_STATES, deriveTickState, deriveTickStateFromState } from './messages/index.js';
export type { MessageTickState } from './messages/index.js';

// ---------------------------------------------------------------------------
// queue/ — SendFailureReason, plus QueuedSend/RetryOutcome (T10). See the
// module header above for why queue/ is otherwise fully internal.
//
// `QueuedSend`/`RetryOutcome` are the one further exception, and for the
// same reason `MESSAGE_TICK_STATES` above already is: `ChatClient.retryMessage`
// (client/) returns `Promise<RetryOutcome>`, whose 'retried' branch embeds a
// `QueuedSend` — so both are now genuinely part of the public return type of
// a public method, not merely of SendQueue's internal one, and core's single
// "." exports entry means a consumer cannot otherwise name either type at
// all to accept `retryMessage`'s result.
// ---------------------------------------------------------------------------

export type { QueuedSend, RetryOutcome, SendFailureReason } from './queue/index.js';

// ---------------------------------------------------------------------------
// protocol/ — domain enums and shapes reachable from ChatState/ChatMessage/
// ChatSession, and from the seam interfaces above. Not the wire frame
// catalog itself.
// ---------------------------------------------------------------------------

export {
  CHAT_MODE_VALUES,
  CHAT_STATUS_VALUES,
  CLOSE_REASON_VALUES,
  ERROR_CODE_VALUES,
  isChatMode,
  isChatStatus,
  isCloseReason,
  isErrorCode,
  isMessageType,
  isParkedCloseReason,
  isParticipantType,
  isPresenceStatus,
  isSenderType,
  MESSAGE_TYPE_VALUES,
  PARKED_CLOSE_REASONS,
  PARTICIPANT_TYPE_VALUES,
  PRESENCE_STATUS_VALUES,
  SENDER_TYPE_VALUES,
} from './protocol/index.js';
export type {
  AttachmentMetadata,
  ChatMode,
  ChatStatus,
  CloseReason,
  ErrorCode,
  HandledBy,
  MessageMetadata,
  MessageType,
  ParticipantType,
  PresenceEntry,
  PresenceStatus,
  SenderType,
} from './protocol/index.js';

// ---------------------------------------------------------------------------
// auth/ — publishable-key hygiene and the token-response adapter. NOT
// redact.ts (internal-only) or anything that could carry sk_ material.
// ---------------------------------------------------------------------------

export {
  createTokenProvider,
  InvalidPublishableKeyError,
  InvalidTokenResponseError,
  isPublishableKey,
  parsePublishableKey,
  publishableKeyEnvironment,
  SecretKeyInClientError,
  toAuthToken,
} from './auth/index.js';
export type {
  AccessTokenResponse,
  OAuthTokenResponse,
  PublishableKey,
  PublishableKeyEnvironment,
  TokenResponse,
} from './auth/index.js';

// ---------------------------------------------------------------------------
// storage/ — StorageAdapter (T4 flagged this as unexported) plus both
// shipped adapters. Each adapter module is free of module-scope side
// effects, so a consumer using only MemoryStorageAdapter does not pull the
// browser adapter's globalThis probing into their bundle (storage/index.ts's
// own header, "sideEffects": false in package.json).
// ---------------------------------------------------------------------------

export { BrowserStorageAdapter, createBrowserStorageAdapter, MemoryStorageAdapter, namespaced } from './storage/index.js';
export { isStorageError, StorageError } from './storage/index.js';
export type { StorageAdapter, StorageErrorCode, WebStorageLike } from './storage/index.js';

// ---------------------------------------------------------------------------
// transport/ — WebSocketFactory only, to type ChatClientConfig.webSocketFactory.
// The transport engine itself, and its test doubles, are not public.
// ---------------------------------------------------------------------------

export type { SocketCloseEvent, SocketMessageEvent, WebSocketFactory, WebSocketLike } from './transport/index.js';
