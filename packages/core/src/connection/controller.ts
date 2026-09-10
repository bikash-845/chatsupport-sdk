// The connection state machine — PRD §8, §10.4-10.6, §7.5.
//
// Transport (T7) moves bytes. This module decides *when*: when to open a
// socket, when to retry, when to refresh credentials, and when to stop. It
// owns `ChatState.connectionState` and nothing else in the state tree except
// `lastError`.
//
//
// Re-entrancy, and the one interface assumption this module is built around
// -------------------------------------------------------------------------
//
// `WebSocketTransport.connect()` closes and supersedes any existing socket,
// and it does so by synthesizing a close *synchronously, from inside the
// call*. `transport.close()` does the same. So both of this module's own
// outbound calls can re-enter `#handleClose` before they return, and
// reconnecting from inside `onClose` — the normal path — puts a second
// `connect()` on the stack inside the first.
//
// This module does not try to detect that with a flag. Instead it leans on a
// property the transport already guarantees: **every close this module caused
// is reported with `cause: 'local'`** (transport/close.ts: "A `local` close is
// reported retryable because it is T8's own doing — T8 knows it asked").
// `#handleClose` returns immediately on `cause: 'local'`, so a superseded or
// self-closed socket can never schedule a retry, emit `disconnected`, or move
// the state machine. The code that asked for the close owns the resulting
// state, and it is already on the stack.
//
// The complementary half is that **no reconnect is ever synchronous**. Every
// retry goes through the injected `schedule()`, even when the computed delay
// is 0, so `onClose` always returns before a new socket exists. That is what
// keeps the "do not assume `onClose` returns before your new socket exists"
// hazard out of reach rather than merely handled.
//
// ⚠️ INTERFACE ASSUMPTION — `WebSocketLike.close()` must not synchronously
// invoke `onclose`.
//
//   `WebSocketLike` (transport/socket.ts) does not enforce this, and nothing
//   in the type system can. Both shipped implementations satisfy it: a real
//   browser/Node `WebSocket` dispatches `close` asynchronously, and
//   `StubWebSocket` records the call without firing anything. But the
//   interface exists precisely so third parties (React Native bridges, test
//   doubles) can implement it, and one that called `onclose` synchronously
//   from `close()` would re-enter `WebSocketTransport.#finish` from inside
//   `#tryClose`.
//
//   This module is written so that it survives a violation rather than
//   depending on the assumption: such a re-entrant close still arrives with
//   `cause: 'local'` (the transport sets `#cause` *before* calling
//   `socket.close()` on every path), so `#handleClose` discards it either
//   way, and `disconnect()` moves to `closed` on its own authority
//   afterwards. The assumption is documented here because this is the layer
//   whose invariants would be the first to visibly break if it stopped
//   holding — see the T8 report, which flags it for whoever owns
//   `WebSocketLike`.
//
//
// What this module deliberately does not do
// -----------------------------------------
//   - Compute backoff delays. backoff/ owns the formula (§8.2); this schedules
//     what it returns.
//   - Validate frames or correlate acks. transport/ owns both.
//   - Apply messages, presence, or the session snapshot to state. Those go
//     down the `onFrame` chain, exactly as `PresenceCoordinator` expects.
//   - Queue or replay unacked sends. That is §9.1's offline queue.
//
// §14: no token value is ever logged, put in an error message, or written to
// the store.

import { scrubCredentials } from '../auth/index.js';
import { AuthBackoffPolicy, TransportBackoffPolicy } from '../backoff/index.js';
import { systemTimers } from '../presence/time.js';
import type { CancelTimer, ScheduleTimer } from '../presence/time.js';
import type { ConnectionAckPayload, ConnectionHelloPayload, ServerFrame } from '../protocol/index.js';
import type { ChatError, ChatStore, ConnectionState } from '../state/index.js';
import type { TransportCloseInfo } from '../transport/index.js';
import { ResumeTracker, frameSeq } from './resume.js';
import type { ResumeGapSpan } from './resume.js';
import { ConnectionStateMachine } from './transitions.js';
import { resolveToken } from './token.js';
import type {
  AuthToken,
  ConnectionControllerOptions,
  ConnectionTransport,
  ResumeGap,
  TokenProvider,
  TransportFactory,
} from './types.js';
import { createWebSocketTransportFactory } from './types.js';

/** Rejected `connect()` promise when `disconnect()` intervened before the connection went live. */
export class ConnectionAbortedError extends Error {
  constructor(message = 'connect() was aborted by disconnect()') {
    super(message);
    this.name = 'ConnectionAbortedError';
  }
}

/** Rejected `connect()` promise when core stopped auto-retrying (§8.1, §10.6). */
export class ConnectionSuspendedError extends Error {
  readonly reason: 'auth' | 'maxAttempts' | 'protocol';
  readonly cause: ChatError;

  constructor(reason: 'auth' | 'maxAttempts' | 'protocol', cause: ChatError) {
    super(`Connection suspended (${reason}): ${cause.message}`);
    this.name = 'ConnectionSuspendedError';
    this.reason = reason;
    this.cause = cause;
  }
}

/** §10.4's default: refresh proactively at 80% of the token's lifetime. */
export const DEFAULT_REFRESH_AT_FRACTION = 0.8;

/** The auth error codes that mean the credential itself is the problem (§8.2, §10.6). */
const AUTH_ERROR_CODES = new Set(['AUTH_INVALID', 'AUTH_EXPIRED']);

/** The `connection.ack` frame, narrowed out of the `ServerFrame` union. */
type ConnectionAckFrame = Extract<ServerFrame, { t: 'connection.ack' }>;

interface PendingConnect {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class ConnectionController {
  readonly #store: ChatStore;
  readonly #machine: ConnectionStateMachine;
  readonly #transport: ConnectionTransport;
  readonly #schedule: ScheduleTimer;
  readonly #transportBackoff: TransportBackoffPolicy;
  readonly #authBackoff: AuthBackoffPolicy;
  readonly #getToken: TokenProvider;
  readonly #url: string;
  /** Absent on a STAFF connection — see `ConnectionControllerOptions.publishableKey`. */
  readonly #publishableKey: string | undefined;
  /**
   * The counterparty this connection's conversation is with, or undefined for
   * the support desk. Readonly and set once — see `ConnectionControllerOptions.target`.
   */
  readonly #target: { readonly role: string; readonly id: string } | undefined;
  readonly #onFrame: ((frame: ServerFrame) => void) | undefined;
  readonly #onResumeGap: ((gap: ResumeGap) => void) | undefined;
  readonly #refreshAtFraction: number;

  /** The `seq` bookkeeping behind `resumeFrom` and gap detection (D2). */
  readonly #resume = new ResumeTracker();

  /**
   * The `resumeFrom` the *current* connection actually asked to resume after.
   *
   * Held separately from the live anchor because a gap report describes the
   * connection that revealed it: by the time a hole surfaces, the anchor has
   * already moved past it, and reporting the moved anchor would name a point
   * nobody ever asked to resume from.
   */
  #connectionResumeFrom: number | null = null;

  /** 0-based reconnect attempt, per §8.2's formula. Reset on every `connection.ack`. */
  #attempt = 0;

  /** See {@link requestNewSession}. Cleared by `connection.ack`, not by sending. */
  #pendingNewSession = false;

  /**
   * The subject/topic {@link requestNewSession} was called with, if any.
   * Same latching rules as `#pendingNewSession` — survives a failed attempt
   * and a transport retry, and is cleared only by `connection.ack`, because a
   * retry that dropped the topic would half-fulfil the customer's request: a
   * fresh session with no subject they never chose to omit.
   */
  #pendingNewSessionSubject: string | undefined;
  #pendingNewSessionTopic: string | undefined;

  /**
   * Contact-info enrichment (IP watermark / device / GPS location) for the
   * console's contact-info panel — see {@link setContactInfo}. Unlike
   * `#pendingNewSession*` above, NOT cleared by `connection.ack`: this is not
   * a one-shot intent that gets fulfilled, it is "what the widget currently
   * knows about this visitor", and it stays correct to keep resending on
   * every reconnect for the life of the connection (the server only actually
   * persists it on the branch that mints a session — see
   * `ConnectionHelloPayload.ip`'s doc, protocol/frames.ts — so resending it on
   * a resume is harmless).
   */
  #contactInfo: {
    ip?: string;
    ipWatermark?: string;
    userAgent?: string;
    geo?: { lat: number; lng: number };
  } = {};

  /**
   * Bumped by every action that invalidates work already in flight — a new
   * attempt, a disconnect, a refresh. Async continuations (`getToken()`
   * resolving, a `connection.reauth` ack arriving) compare the generation they
   * captured and return if it moved, so a token that resolves after the user
   * disconnected cannot open a socket.
   */
  #generation = 0;

  #cancelReconnect: CancelTimer | null = null;
  #cancelRefresh: CancelTimer | null = null;
  #pendingConnect: PendingConnect | null = null;

  /** Lifetime of the token in use, or `null` when the host did not supply one. */
  #tokenExpiresInMs: number | null = null;

  /** Guards against a proactive and a reactive refresh running at the same time. */
  #refreshing = false;

  constructor(options: ConnectionControllerOptions) {
    this.#store = options.store;
    this.#url = options.url;
    this.#publishableKey = options.publishableKey;
    this.#target = options.target;
    this.#pendingNewSessionSubject = options.subject;
    this.#getToken = options.getToken;
    this.#schedule = options.schedule ?? systemTimers;
    this.#transportBackoff = options.transportBackoff ?? new TransportBackoffPolicy();
    this.#authBackoff = options.authBackoff ?? new AuthBackoffPolicy();
    this.#onFrame = options.onFrame;
    this.#onResumeGap = options.onResumeGap;
    this.#refreshAtFraction = validateRefreshFraction(
      options.refreshAtFraction ?? DEFAULT_REFRESH_AT_FRACTION,
    );

    this.#machine = new ConnectionStateMachine(this.#store);

    const createTransport: TransportFactory =
      options.createTransport ?? createWebSocketTransportFactory();

    this.#transport = createTransport({
      onOpen: () => this.#handleOpen(),
      onFrame: (frame) => this.#handleFrame(frame),
      onClose: (info) => this.#handleClose(info),
    });
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** The authoritative connection state (§8.1). Mirrored into `ChatState.connectionState`. */
  get state(): ConnectionState {
    return this.#machine.state;
  }

  /**
   * The transport, for the modules that send frames over it — the offline
   * queue (§9.1) and message/presence sends. Exposed rather than re-wrapped
   * because send *policy* (queueing, FIFO replay, retention) is theirs, not
   * this module's; all this module owns is whether a socket exists at all.
   */
  get transport(): ConnectionTransport {
    return this.#transport;
  }

  /**
   * The last `seq` applied to state (D2), or `null` before anything has been.
   * This is what goes out as `connection.hello.d.resumeFrom`.
   */
  get lastAppliedSeq(): number | null {
    return this.#resume.lastAppliedSeq;
  }

  /** 0-based count of consecutive reconnect attempts since the last successful ack. */
  get attempt(): number {
    return this.#attempt;
  }

  /**
   * Drops the resume anchor so the next `connection.hello` omits `resumeFrom`
   * and the server opens a *new* session rather than resuming the old one.
   *
   * Exposed for the session-replacement transition only (`startNewSession()`),
   * never for a reconnect — see `ResumeTracker`'s own doc for why the two
   * axes must not be confused. This does not touch the socket: the caller
   * sequences the disconnect/connect around it.
   */
  forgetResumeAnchor(): void {
    this.#resume.reset();
    this.#connectionResumeFrom = null;
  }

  /**
   * Ask the SERVER for a brand-new session on the next handshake.
   *
   * The companion to `forgetResumeAnchor`, and the half that was missing.
   * Forgetting the anchor makes the hello *look* like a first connection, but
   * chat-service resolves a customer to their one active session either way —
   * so `startNewSession()` reconnected into the conversation it had just been
   * told to leave. This states the intent explicitly instead of hoping the
   * server infers it (`connection.hello.d.newSession`).
   *
   * Latched, not one-shot-per-socket: the flag survives failed attempts and is
   * cleared only by a `connection.ack`, because the customer's request is not
   * satisfied until a new session actually comes back. A transport retry in
   * between must carry it too, or the retry silently resumes the old session —
   * the exact bug, one layer down.
   *
   * `payload` carries the "New conversation" screen's subject/topic onto the
   * hello that follows (`ConnectionHelloPayload.subject`/`.topic`) — latched
   * the same way and for the same reason: a retry that dropped it would
   * silently downgrade the customer's chosen topic to none.
   */
  requestNewSession(payload?: { readonly topic?: string; readonly subject?: string }): void {
    this.#pendingNewSession = true;
    this.#pendingNewSessionSubject = payload?.subject;
    this.#pendingNewSessionTopic = payload?.topic;
  }

  /**
   * Record whatever the widget has learned about this visitor so far, for the
   * NEXT `connection.hello` this controller builds.
   *
   * Merged, not replaced: the widget calls this incrementally as each piece
   * resolves — `navigator.userAgent` is synchronous and available
   * immediately, the ip-watermark fetch and the GPS fix are both async and
   * arrive later, independently, or not at all. A later call updates only the
   * keys it names; a key never passed here is simply never sent, forever
   * (there is no "clear" — a visitor's device/UA does not change mid-session,
   * and a GPS fix that failed once is not retried by this layer at all, per
   * the product decision behind it — see chatsupport_react's ContextPanel.tsx
   * for the console side of the same "never invent a value" rule).
   *
   * Deliberately SYNCHRONOUS and side-effect-free beyond the assignment: this
   * is core's framework-agnostic half of the contract, so it does no
   * `fetch()` and touches no `navigator` global itself (see this method's
   * counterpart in packages/widget, which does both and calls this once each
   * resolves). Calling this does not itself send anything — a value recorded
   * after the socket already sent its hello simply waits for the next one
   * (a reconnect, or nothing at all if the session never reconnects), which
   * is why the widget is expected to call this as early as possible rather
   * than gate `connect()` on any of it: `connect()` proceeds regardless, and
   * this never becomes a reason to delay it (§ the product decision that GPS
   * in particular must never gate the chat opening).
   */
  setContactInfo(info: {
    readonly ip?: string;
    readonly ipWatermark?: string;
    readonly userAgent?: string;
    readonly geo?: { readonly lat: number; readonly lng: number };
  }): void {
    this.#contactInfo = { ...this.#contactInfo, ...info };
  }

  /**
   * Opens the connection and drives it to `connected` (§6.2).
   *
   * Resolves once `connection.ack` is received; rejects with
   * {@link ConnectionSuspendedError} if core suspends first, or
   * {@link ConnectionAbortedError} if `disconnect()` intervenes. Already
   * connected resolves immediately, and a second call while one is in flight
   * returns the same promise rather than opening a second socket.
   *
   * This is the *only* way out of `suspended` (§8.1) and the only way out of
   * `closed`. It also resets the auth escalation counter: `suspended` means
   * "the host app must fix something", so an explicit reconnect after that fix
   * must start from a clean slate rather than re-suspending on its first
   * hiccup.
   */
  connect(): Promise<void> {
    if (this.#machine.state === 'connected') return Promise.resolve();
    if (this.#pendingConnect !== null) return this.#pendingConnect.promise;

    this.#cancelTimers();
    this.#attempt = 0;
    this.#authBackoff.recordSuccess();

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // A host that fires and forgets `connect()` must not take an
    // `unhandledrejection` when core suspends — the same reasoning transport
    // applies to ack outcomes. Attaching a handler here marks the promise
    // handled without altering what a caller who does await it observes.
    void promise.catch(() => undefined);

    this.#pendingConnect = { promise, resolve, reject };
    void this.#beginAttempt();
    return promise;
  }

  /**
   * User-initiated, terminal (§8.1). No auto-reconnect follows — only an
   * explicit `connect()` can revive this controller.
   */
  disconnect(): void {
    this.#generation += 1;
    this.#cancelTimers();

    // Reported back as `cause: 'local'`, which `#handleClose` discards. The
    // state below is this call's to set.
    this.#transport.close();

    this.#machine.to('closed');
    this.#settlePendingConnect(new ConnectionAbortedError());
  }

  /**
   * Abandons the armed backoff and attempts NOW, from attempt 0.
   *
   * For one caller: something outside core learned that the reason the last
   * attempts failed has gone away — most concretely, the platform reporting
   * the network back (`window.online`, a `Connectivity` stream). Backoff is a
   * guess about when to try again, and a binding holding that fact has better
   * information than the guess. Without this the customer waits out a delay
   * that has already grown to the 30s cap while their phone is plainly online
   * again, which is precisely how "it says Connecting… forever" is reported.
   *
   * ── Why this is not `connect()` ──────────────────────────────────────────
   *
   * `connect()` is the wrong tool for this and every binding that reached for
   * it found out the hard way (see @dhaam-ccrm/widget's `WorkingConnectionState`
   * note). It returns the in-flight promise whenever one is pending — which,
   * on a client that has never reached `connection.ack`, is the whole retry
   * loop — so it opens no socket at all in exactly the case that matters. Where
   * it does run it also resets the AUTH escalation counter, and a network blip
   * is not evidence that a rejected credential has been fixed.
   *
   * So this method takes neither liberty: no promise is created or settled, the
   * auth counter is untouched, and only the TRANSPORT attempt counter (the one
   * the network genuinely invalidated) goes back to 0.
   *
   * Returns whether an attempt was actually started. `false` — a no-op, safe to
   * call on any cadence — covers every other state:
   *   - `connecting`/`authenticating`: an attempt is already in flight, and a
   *     second one would supersede a socket that may be one frame from open.
   *   - `connected`: nothing to retry.
   *   - `suspended`/`closed`: §8.1 makes both recoverable only by an explicit
   *     `connect()`, and a credential fault or a user's `disconnect()` is not
   *     something coming back online has fixed.
   */
  retryNow(): boolean {
    if (this.#machine.state !== 'reconnecting') return false;

    this.#cancelReconnectTimer();
    this.#attempt = 0;
    // `#beginAttempt` bumps the generation, so the timer callback cancelled
    // above could not have raced its way to a second socket even if it had
    // already fired.
    void this.#beginAttempt();
    return true;
  }

  // -------------------------------------------------------------------------
  // Attempt lifecycle
  // -------------------------------------------------------------------------

  /**
   * Fetches a token and opens a socket.
   *
   * The `connecting` transition happens *before* the token fetch rather than
   * after. §8.1 has no "fetching credentials" state and inventing one would
   * break the seven-state contract; from the host app's point of view the
   * client is connecting from the moment it was asked to, so bindings show
   * "connecting…" for the whole operation instead of appearing idle during an
   * arbitrarily slow `getToken()`.
   */
  async #beginAttempt(): Promise<void> {
    const generation = ++this.#generation;
    this.#machine.to('connecting');

    let token: AuthToken;
    try {
      token = await resolveToken(this.#getToken);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#handleAuthFailure(tokenProviderError(error));
      return;
    }

    if (generation !== this.#generation) return;

    this.#tokenExpiresInMs = token.expiresInMs ?? null;
    this.#openSocket(token.token);
  }

  /** Opens the socket for `token`. A factory that throws is a transport failure, not a crash. */
  #openSocket(token: string): void {
    const resumeFrom = this.#resume.lastAppliedSeq;
    this.#connectionResumeFrom = resumeFrom;

    const hello: Omit<ConnectionHelloPayload, 'protocolVersion'> = {
      token,
      // Omitted entirely, not sent as `undefined`, on a staff connection. The
      // server selects its flow on the key's PRESENCE, and under
      // `exactOptionalPropertyTypes` an explicit `undefined` is a different
      // thing from an absent key — the same absence rule `resumeFrom` follows
      // below.
      ...(this.#publishableKey === undefined ? {} : { publishableKey: this.#publishableKey }),
      // The counterparty, on EVERY hello for a targeted conversation —
      // reconnects included, unlike `subject`/`topic` below which are latched
      // for one mint. The pair is part of WHICH conversation the server
      // resumes (its reuse lookup is scoped by it), so omitting it on a
      // reconnect would resume the customer's SUPPORT chat instead of their
      // conversation with the merchant. Same `=== undefined` absence rule as
      // every optional field here, for the `exactOptionalPropertyTypes` reason
      // `publishableKey` gives above.
      ...(this.#target === undefined
        ? {}
        : { targetRole: this.#target.role, targetId: this.#target.id }),
      // D2 §8.3: sent on *any* transition into `authenticating`, reconnect and
      // first connect alike. Omitted entirely on a first connection — under
      // `exactOptionalPropertyTypes` an explicit `undefined` is a different
      // thing from an absent key, and the wire contract (§7.2, D4) wants it
      // absent rather than null.
      ...(resumeFrom === null ? {} : { resumeFrom }),
      // Absent, not `false`, when nobody asked — same absence rule as
      // `resumeFrom` above, and what keeps an older server unaffected.
      ...(this.#pendingNewSession ? { newSession: true as const } : {}),
      // The "New conversation" screen's choice, latched alongside
      // `#pendingNewSession` — see `requestNewSession`. `=== undefined`
      // guards, not `??`, for the same `exactOptionalPropertyTypes` reason
      // `publishableKey`/`resumeFrom` above do: an explicit `undefined` is a
      // different thing from an absent key under this compiler option.
      ...(this.#pendingNewSessionSubject === undefined ? {} : { subject: this.#pendingNewSessionSubject }),
      ...(this.#pendingNewSessionTopic === undefined ? {} : { topic: this.#pendingNewSessionTopic }),
      // Contact-info enrichment — see `setContactInfo`. Whatever is known AT
      // THE MOMENT this hello is built; a value the widget records later
      // simply misses this particular hello (harmless — see that method's
      // doc). Same `=== undefined` guard as every other optional field above,
      // for the same `exactOptionalPropertyTypes` reason.
      ...(this.#contactInfo.ip === undefined ? {} : { ip: this.#contactInfo.ip }),
      ...(this.#contactInfo.ipWatermark === undefined ? {} : { ipWatermark: this.#contactInfo.ipWatermark }),
      ...(this.#contactInfo.userAgent === undefined ? {} : { userAgent: this.#contactInfo.userAgent }),
      ...(this.#contactInfo.geo === undefined ? {} : { geo: this.#contactInfo.geo }),
    };

    try {
      this.#transport.connect({ url: this.#url, hello });
    } catch (error) {
      // The default factory throws when the environment has no `WebSocket`.
      // That is a transport-level failure — retry it, do not let it escape
      // from a timer callback into the host's error handler.
      this.#reportError(transportError(errorMessage(error), true));
      this.#scheduleTransportRetry();
    }
  }

  // -------------------------------------------------------------------------
  // Transport callbacks
  // -------------------------------------------------------------------------

  /** Socket open AND `connection.hello` written — the one `connecting → authenticating` edge. */
  #handleOpen(): void {
    if (this.#machine.state !== 'connecting') return;
    this.#machine.to('authenticating');
  }

  #handleFrame(frame: ServerFrame): void {
    if (frame.t === 'connection.ack') {
      this.#handleConnectionAck(frame);
      return;
    }

    // §10.4's reactive half: the server says this token has expired
    // mid-connection — clock skew, or a shorter life than advertised. Refresh
    // now rather than waiting for the proactive timer that is evidently late.
    // `AUTH_INVALID` deliberately does not land here: a rejected credential is
    // not a stale one, and the server closes behind it, so `#handleClose`
    // escalates it through the auth policy instead.
    if (frame.t === 'error' && frame.d.code === 'AUTH_EXPIRED') {
      this.#deliver(frame);
      this.#beginRefresh();
      return;
    }

    if (this.#deliver(frame)) this.#noteSeq(frame);
  }

  /**
   * Advances the resume anchor for one frame that was actually applied, and
   * surfaces any hole it revealed.
   *
   * Called only after a successful delivery, because the anchor's meaning is
   * "last applied `seq`" (D2) — claiming a frame a downstream handler threw on
   * would put a hole in history *and* record that there wasn't one.
   */
  #noteSeq(frame: ServerFrame): void {
    const seq = frameSeq(frame);
    if (seq === null) return;

    const span = this.#resume.observe(seq);
    if (span !== null) this.#reportResumeGap(span);
  }

  /**
   * The connection ended.
   *
   * A `local` cause is this module's own doing — `disconnect()`, or the
   * supersede that `transport.connect()` performs — and is discarded here so a
   * re-entrant close cannot schedule a retry against a socket that is being
   * replaced. See the file header.
   */
  #handleClose(info: TransportCloseInfo): void {
    if (info.cause === 'local') return;

    this.#cancelRefreshTimer();
    this.#store.emit('disconnected', { reason: info.reason });

    // §7.5: `PROTOCOL_VERSION_UNSUPPORTED` is the one non-retryable cause. No
    // amount of backoff makes this client speak a version it does not
    // implement, so it suspends without ever scheduling a retry.
    if (!info.retryable) {
      this.#suspend('protocol', closeError(info));
      return;
    }

    // A close carrying `AUTH_INVALID`/`AUTH_EXPIRED` means the server rejected
    // the token this attempt fetched moments ago — a freshly-fetched token per
    // §10.6, since one is fetched before every attempt. Backoff cannot fix a
    // broken credential, so this escalates instead of retrying blindly.
    const code = info.protocolError?.code;
    if (code !== undefined && AUTH_ERROR_CODES.has(code)) {
      this.#handleAuthFailure(closeError(info));
      return;
    }

    // Everything else is a transport failure and retries indefinitely (§8.2) —
    // including a `ref`-less `VALIDATION_FAILED`, which the transport records
    // as `protocolError` and deliberately leaves retryable: a rejected frame
    // is not a dead session.
    if (info.backpressure) {
      // Close 1013: the server's outbound buffer overflowed. Reconnecting
      // instantly just refills it, so this attempt is charged an extra step up
      // the exponential curve before the delay is drawn — the retry is drawn
      // from a strictly wider window than a plain drop would have used.
      this.#attempt += 1;
    }
    this.#scheduleTransportRetry();
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  /**
   * The CUSTOMER half of the `connection.ack` contract, enforced here because
   * here is the only place that knows which half applies.
   *
   * `session` and `seq` are optional in the shared validator
   * (protocol/validate.ts) so that a STAFF ack — which resolves no session and
   * therefore holds no anchor — can be admitted at all. But optionality in a
   * validator shared by both flows would, on its own, let a buggy server omit
   * `session` for a CUSTOMER and have it pass silently. That is a worse bug
   * than the one being fixed: instead of a loud rejection at the wire, the
   * customer gets a client that connected successfully and has no
   * conversation, failing later and somewhere else.
   *
   * This controller wrote the `connection.hello` itself, so it alone knows
   * whether a `publishableKey` went out — which is exactly the bit the server
   * switches its own flow on (protocol/frames.ts on
   * `ConnectionHelloPayload.publishableKey`). A key was sent ⇒ this is a
   * customer connection ⇒ the server guarantees both fields ⇒ their absence is
   * a protocol violation and is reported as one.
   *
   * Returns the violation message, or `null` when the ack is well-formed for
   * this connection's flow.
   */
  #customerAckViolation(payload: ConnectionAckPayload): string | null {
    // A staff connection sends no key and promises neither field.
    if (this.#publishableKey === undefined) return null;

    const missing: string[] = [];
    if (payload.session === undefined) missing.push('session');
    if (payload.seq === undefined) missing.push('seq');
    if (missing.length === 0) return null;

    return (
      `connection.ack from a customer connection is missing ${missing.join(' and ')}: ` +
      'a hello carrying a publishableKey always resolves a session, so this ack ' +
      'violates the protocol and cannot be applied'
    );
  }

  #handleConnectionAck(frame: ConnectionAckFrame): void {
    // BEFORE anything else — before the attempt counter resets, before the
    // frame is delivered, and before the machine reaches `connected`. A
    // violating ack must not be applied to the state tree at all, and must not
    // be able to report the connection as healthy on its way past.
    const violation = this.#customerAckViolation(frame.d);
    if (violation !== null) {
      // Suspends rather than retries. A server answering a customer hello with
      // a staff-shaped ack is broken in a way backoff cannot fix, and the
      // alternative — reconnecting forever against it — leaves the widget
      // stuck "connecting" with no conversation and no explanation, which is
      // the silent failure this check exists to prevent. Suspending settles
      // the pending `connect()` promise with the reason, so a caller awaiting
      // it learns immediately instead of hanging.
      this.#suspend('protocol', {
        source: 'protocol',
        code: 'VALIDATION_FAILED',
        message: violation,
        retryable: false,
      });
      return;
    }

    this.#attempt = 0;
    this.#authBackoff.recordSuccess();
    // The server has answered the "start a new conversation" request — with a
    // new session, or (on a deployment that predates the field) with the old
    // one. Either way the request is spent, and carrying it into the NEXT
    // reconnect would close the customer's live conversation behind them.
    this.#pendingNewSession = false;
    this.#pendingNewSessionSubject = undefined;
    this.#pendingNewSessionTopic = undefined;

    const payload = frame.d;

    // The ack goes down the chain first: it carries the authoritative session
    // snapshot, which §9.4 requires be applied wholesale before anything built
    // on top of it. Replay lands on that snapshot, and `connected` is not
    // announced over a state tree that has seen neither.
    this.#deliver(frame);
    this.#applyReplay(payload);

    if (this.#machine.state === 'authenticating') {
      this.#machine.to('connected');
    }

    this.#scheduleProactiveRefresh();
    this.#emitConnected();
    this.#pendingConnect?.resolve();
    this.#pendingConnect = null;
  }

  /**
   * Applies `connection.ack.d.replay` in the order the server sent it, then
   * adopts the ack's `seq` as the new anchor (D2).
   *
   * The array order is honoured rather than sorted. The server's order is the
   * authoritative one, and sorting locally would repair a symptom — replay
   * arriving out of order is itself a gap worth surfacing, and quietly
   * reordering it would hide the only evidence of it.
   */
  #applyReplay(payload: ConnectionAckPayload): void {
    const ackSeq = payload.seq;

    for (const replayed of payload.replay ?? []) {
      // A nested `connection.ack` is not replayable — it is a handshake, not
      // history — and recursing on one would re-run this whole method.
      if (replayed.t === 'connection.ack') continue;

      if (this.#deliver(replayed)) this.#noteSeqDuringReplay(replayed, ackSeq);
    }

    // A STAFF ack carries no `seq` (protocol/frames.ts): an anchor is a
    // property of a session, and staff has resolved none. There is nothing to
    // settle against, so the anchor is left exactly where it was rather than
    // being moved to a fabricated value. Staff anchors arrive per-session on
    // each `session.join` ack instead.
    //
    // Reached only on a staff connection: a CUSTOMER ack missing `seq` is
    // rejected in `#handleConnectionAck` before this runs.
    if (ackSeq === undefined) return;

    // The case walking the array alone cannot see: an ack claiming to be
    // current at a `seq` past everything it actually replayed. An empty
    // `replay` against a moved-on anchor is that same bug at its starkest.
    const tail = this.#resume.settleAck(ackSeq);
    if (tail !== null) this.#reportResumeGap(tail, ackSeq);
  }

  #noteSeqDuringReplay(frame: ServerFrame, ackSeq: number | undefined): void {
    const seq = frameSeq(frame);
    if (seq === null) return;

    const span = this.#resume.observe(seq);
    if (span !== null) this.#reportResumeGap(span, ackSeq);
  }

  /**
   * Surfaces a hole in history twice, because two different audiences need it.
   *
   * `onResumeGap` is core's own signal: D2 says "a `seq` jump means refetch",
   * and the module that owns message history is the one that can do that. The
   * §6.5 `error` event is the app's: its history is incomplete right now, and
   * that is not something core should decide to keep to itself.
   */
  #reportResumeGap(span: ResumeGapSpan, ackSeq?: number): void {
    const gap: ResumeGap = {
      resumeFrom: this.#connectionResumeFrom,
      expectedSeq: span.expectedSeq,
      receivedSeq: span.receivedSeq,
      ackSeq: ackSeq ?? span.receivedSeq,
    };

    this.#onResumeGap?.(gap);
    this.#reportError({
      source: 'transport',
      code: null,
      message:
        `missing frames ${span.expectedSeq}-${span.receivedSeq - 1}: ` +
        'replayed history has a gap and needs refetching',
      retryable: true,
      details: { ...gap },
    });
  }

  /**
   * Emits §6.5's `connected`.
   *
   * The event's payload is `{ session: ChatSession }` — non-null — but
   * `ChatState.session` is populated by whichever module maps the wire
   * `SessionSnapshot` into the binding-facing `ChatSession`, downstream in the
   * `onFrame` chain this method runs after. Until that module is wired in the
   * field is `null`, and this emits nothing rather than fabricating a session
   * or widening a §6.5 payload that bindings are typed against. See the T8
   * report.
   */
  #emitConnected(): void {
    const session = this.#store.getState().session;
    if (session === null) return;
    this.#store.emit('connected', { session });
  }

  // -------------------------------------------------------------------------
  // Token refresh (D3, §10.4-10.5)
  // -------------------------------------------------------------------------

  /**
   * Arms the proactive refresh for the token in use (§10.4).
   *
   * A token with no known lifetime schedules nothing. That is not a silent
   * failure: §6.1 types the public provider as `() => Promise<string>`, so a
   * host that never tells core when the token expires genuinely leaves core
   * with nothing to compute a deadline from, and the reactive `AUTH_EXPIRED`
   * path (§10.4) covers exactly that case. See `AuthToken` in types.ts.
   */
  #scheduleProactiveRefresh(): void {
    this.#cancelRefreshTimer();

    const lifetime = this.#tokenExpiresInMs;
    if (lifetime === null) return;

    this.#cancelRefresh = this.#schedule(() => {
      this.#cancelRefresh = null;
      this.#beginRefresh();
    }, lifetime * this.#refreshAtFraction);
  }

  /** Starts a refresh unless one is already running or the connection is not live. */
  #beginRefresh(): void {
    if (this.#refreshing) return;
    if (this.#machine.state !== 'connected') return;

    this.#refreshing = true;
    void this.#refresh()
      .catch((error: unknown) => {
        // `#refresh` handles every failure it expects; anything reaching here
        // is a bug in core. It must still not surface as an
        // `unhandledrejection` in the host app — a fire-and-forget refresh
        // that crashes the page is worse than the problem it reports.
        this.#reportError(transportError(`token refresh failed: ${errorMessage(error)}`, true));
      })
      .finally(() => {
        this.#refreshing = false;
      });
  }

  /**
   * Re-invokes `getToken()` and installs the result.
   *
   * D3 makes in-place `connection.reauth` the primary path: a token refresh
   * must not tear the connection down, because tokens minted together expire
   * together, and a fleet of clients reconnecting on the same hour boundary is
   * a self-inflicted thundering herd. §10.5's reconnect is the fallback for
   * when the server cannot do it in place.
   *
   * Both paths are indistinguishable from outside: `tokenRefreshed` fires as
   * soon as `getToken()` succeeds — before either path is chosen — because
   * §10.5 fixes the public contract as "`getToken()` is just called again; the
   * app never has to think about which path was taken".
   */
  async #refresh(): Promise<void> {
    const generation = this.#generation;

    let token: AuthToken;
    try {
      token = await resolveToken(this.#getToken);
    } catch (error) {
      if (generation !== this.#generation) return;
      // A refresh that cannot produce a credential is an auth failure like any
      // other (§10.6) — three of them in a row suspend.
      this.#handleAuthFailure(tokenProviderError(error));
      return;
    }

    if (generation !== this.#generation) return;

    this.#tokenExpiresInMs = token.expiresInMs ?? null;
    this.#store.emit('tokenRefreshed', {});

    if (!this.#transport.isOpen) {
      this.#reconnectWith(token.token);
      return;
    }

    const outcome = await this.#transport.send('connection.reauth', { token: token.token }).ack;

    // The socket may have been superseded, closed, or dropped while the reauth
    // was in flight; whatever happened, that path already owns the state.
    if (generation !== this.#generation) return;
    if (this.#machine.state !== 'connected') return;

    switch (outcome.status) {
      case 'acked':
        this.#authBackoff.recordSuccess();
        this.#scheduleProactiveRefresh();
        return;

      case 'disconnected':
        // The close handler is running or has run. It owns what happens next.
        return;

      case 'rejected':
      case 'timeout':
        // §10.5: the server would not (or could not) re-auth in place.
        this.#reconnectWith(token.token);
        return;
    }
  }

  /**
   * The §10.5 fallback: swap credentials by opening a fresh socket.
   *
   * Deliberately NOT a `reconnecting` transition. Nothing failed from the
   * app's point of view — no attempt is counted, no backoff is scheduled, and
   * no `reconnecting` event fires, because surfacing this would be exactly the
   * "public API contract changes based on a backend decision" that §10.5
   * forbids. The state passes `connected → connecting → authenticating →
   * connected`, and resume (D2) carries history across it as it would across
   * any other reconnect.
   */
  #reconnectWith(token: string): void {
    this.#generation += 1;
    this.#cancelTimers();
    this.#machine.to('connecting');
    this.#openSocket(token);
  }

  // -------------------------------------------------------------------------
  // Retry / escalation
  // -------------------------------------------------------------------------

  /** Schedules the next transport-level retry. Never terminates (§8.2). */
  #scheduleTransportRetry(): void {
    const attempt = this.#attempt;
    const delayMs = this.#transportBackoff.nextDelay(attempt);
    this.#attempt += 1;
    this.#scheduleRetry(attempt, delayMs);
  }

  /**
   * Routes one auth-level failure through {@link AuthBackoffPolicy} — a
   * `getToken()` that threw or produced nothing, or a server that rejected the
   * token just fetched.
   */
  #handleAuthFailure(error: ChatError): void {
    const outcome = this.#authBackoff.recordFailure();
    if (outcome.action === 'suspend') {
      this.#suspend('auth', error);
      return;
    }

    this.#reportError(error);
    this.#scheduleRetry(outcome.attempt, outcome.delayMs);
  }

  /**
   * Moves to `reconnecting` and arms the timer.
   *
   * The retry is always scheduled, never run inline — even at `delayMs === 0`,
   * which full jitter produces regularly. That is what guarantees `onClose`
   * returns before the replacement socket exists.
   */
  #scheduleRetry(attempt: number, delayMs: number): void {
    if (this.#machine.state === 'closed' || this.#machine.state === 'suspended') return;

    this.#cancelReconnectTimer();
    this.#machine.to('reconnecting');
    this.#store.emit('reconnecting', { attempt, delayMs });

    this.#cancelReconnect = this.#schedule(() => {
      this.#cancelReconnect = null;

      // The guard for every *automatic* attempt: only a controller still
      // waiting out its backoff may retry. `closed` and `suspended` both stop
      // here, which is what makes them terminal against the clock while
      // leaving `connect()` — which does not come through this path — free to
      // revive either one.
      if (this.#machine.state !== 'reconnecting') return;
      void this.#beginAttempt();
    }, delayMs);
  }

  /** Stops auto-retrying (§8.1). Only an explicit `connect()` leaves this state. */
  #suspend(reason: 'auth' | 'maxAttempts' | 'protocol', error: ChatError): void {
    this.#generation += 1;
    this.#cancelTimers();

    // Before the transition, so `lastError` already carries the structured
    // §7.4 code by the time a `suspended` handler reads state. This is the
    // discriminator §12.6 exists to provide — a host prompting for re-login
    // branches on `code`, never on the message.
    this.#reportError(error);

    this.#machine.to('suspended');
    this.#store.emit('suspended', { reason });
    this.#settlePendingConnect(new ConnectionSuspendedError(reason, error));
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /**
   * Hands one frame to the next handler in the chain.
   *
   * A throwing downstream handler is contained: it must not strand the state
   * machine mid-handshake (which is exactly what an uncaught throw between
   * "ack received" and "transition to connected" would do), and one bad frame
   * must not cost the user their session — the same rule transport applies to
   * malformed input.
   */
  #deliver(frame: ServerFrame): boolean {
    try {
      this.#onFrame?.(frame);
      return true;
    } catch (error) {
      this.#reportError(transportError(`inbound frame handler threw: ${errorMessage(error)}`, true));
      return false;
    }
  }

  /** Records a `ChatError` in state and emits §6.5's `error`. */
  #reportError(error: ChatError): void {
    this.#store.setState({ lastError: error });
    this.#store.emit('error', error);
  }

  #settlePendingConnect(error: Error): void {
    const pending = this.#pendingConnect;
    if (pending === null) return;
    this.#pendingConnect = null;
    pending.reject(error);
  }

  #cancelReconnectTimer(): void {
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
  }

  #cancelRefreshTimer(): void {
    this.#cancelRefresh?.();
    this.#cancelRefresh = null;
  }

  /** Every timer this module owns. */
  #cancelTimers(): void {
    this.#cancelReconnectTimer();
    this.#cancelRefreshTimer();
  }
}

// ---------------------------------------------------------------------------
// ChatError construction
// ---------------------------------------------------------------------------
//
// `ChatError.source` is `'protocol'` exactly when an `error` frame produced it
// and `'transport'` otherwise, and `code` is `null` exactly when no wire frame
// did — state/types.ts defines both that way. Nothing below invents a code
// name outside §7.4.

/**
 * `getToken()` is the host application's code, so `errorMessage(error)` is
 * *their* text — and HTTP clients routinely embed the request (URL, headers)
 * in it. A customer's 401 can therefore hand us a live token, which this then
 * writes to `lastError` and emits as the §6.5 `error` event, i.e. straight
 * into their error tracker. Scrubbed on the way in: §14 allows no credential
 * material in anything core emits, whether core authored the text or not.
 */
function tokenProviderError(error: unknown): ChatError {
  return {
    source: 'transport',
    code: null,
    message: scrubCredentials(`getToken() failed: ${errorMessage(error)}`),
    retryable: true,
  };
}

function transportError(message: string, retryable: boolean): ChatError {
  return { source: 'transport', code: null, message, retryable };
}

/**
 * Projects a close into a `ChatError`.
 *
 * The `protocolError` the transport carried forward is the only discriminator
 * for close code 1008, which the real server uses for five distinct conditions
 * with one reason string — so when it is present it, not the close code, is
 * what this reports.
 */
function closeError(info: TransportCloseInfo): ChatError {
  const protocolError = info.protocolError;
  if (protocolError !== null) {
    return {
      source: 'protocol',
      code: protocolError.code,
      message: protocolError.message,
      retryable: protocolError.retryable,
      ...(protocolError.details === undefined ? {} : { details: protocolError.details }),
    };
  }

  return {
    source: 'transport',
    code: null,
    message: info.reason === '' ? `connection closed (${info.code})` : info.reason,
    retryable: info.retryable,
  };
}

/** §10.4's fraction must land strictly inside the token's life to be a *pre*-expiry refresh. */
function validateRefreshFraction(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    throw new RangeError(
      `refreshAtFraction must be greater than 0 and less than 1, got ${String(fraction)}`,
    );
  }
  return fraction;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
