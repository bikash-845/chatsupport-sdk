// One connection, N conversations. In this slice, N is 1.
//
// ── What this owns that a runtime cannot ─────────────────────────────────
//
//   • the inbound address table — which conversation a push belongs to, and
//     what to do when the wire cannot say (addressing.ts);
//   • the ONE `SendQueue` on this connection. The queue has always been
//     multi-session — entries carry their own `sessionId` (`queue/types.ts`),
//     `#pumps` is a per-session Map, and the pump stamps the address from the
//     ENTRY rather than from the current join (`send-queue.ts:550-573`) — so
//     one queue across N conversations is its designed shape;
//   • the join lifecycle: `session.join` carrying `resumeFrom`, the
//     `SessionJoinAckData { seq, replay }` the ack carries back, and the
//     re-join every conversation needs after a reconnect (a socket drop takes
//     the server-side join with it);
//   • the connection-scoped fan-out: `connectionState` written into every live
//     row, so a row IS a complete `ChatState` rather than one missing a field.
//
// ── The join round trip, in the order the server actually performs it ────
//
// `handleSessionJoin` (chat-service-node handlers.ts:1774) does, in order:
// ownership check -> `registry.addSession` (ACCUMULATE on a staff surface,
// where the customer surface evicts) -> `planResume(d.resumeFrom, seq)` ->
// `ackOk(frameId, { seq, replay? })` -> `pushFrame('session.updated', {session})`.
//
// So the ack is the resume anchor and the missed frames, and the snapshot
// follows as a separate push. `open()` waits for BOTH, because a row that
// reports itself open while `session` is still `null` is a row a caller cannot
// send from — `MessageController` addresses a send from `ChatState.session.id`.
//
// ── Storage ─────────────────────────────────────────────────────────────
//
// The party keyspace is §6, which is Slice 9's work, and this slice deliberately
// ships none of it: `ConversationClientConfig` accepts no `StorageAdapter` and
// nothing here reads or writes one. The queue still needs somewhere to put its
// entries, so it gets the same in-process `MemoryStorageAdapter` that
// `createChatClient` itself falls back to when a host configures no storage.
// The consequence, stated rather than hidden: a queued send survives a socket
// drop and replays on re-join, and does NOT survive a page reload.

import type {
  EnqueueSend,
  LocalSender,
  MessageHistorySource,
  SendMessageOptions,
} from '../messages/index.js';
import type { Clock, IntentSink, ScheduleTimer } from '../presence/index.js';
import { systemTimers } from '../presence/index.js';
import { isParkedCloseReason, isServerPushFrameType, validateFrame } from '../protocol/index.js';
import type { ErrorPayload, ServerFrame, ServerPushFrame, SessionJoinPayload } from '../protocol/index.js';
import type { SessionJoinAckData } from '../protocol/frames.js';
import { SendQueue } from '../queue/index.js';
import type { QueueTransport } from '../queue/index.js';
import { ChatStore } from '../state/index.js';
import { MemoryStorageAdapter } from '../storage/index.js';
import type { ChatError, ChatState, ConnectionState, Unsubscribe } from '../state/index.js';
import type { AckOutcome } from '../transport/index.js';
import type { WebSocketTransport } from '../transport/index.js';
import { addressOf } from './addressing.js';
import { ConversationJoinError, ConversationNotOpenError } from './errors.js';
import { ConversationRuntime } from './runtime.js';
import type { ConversationLogger } from './types.js';

/**
 * How long `open()` waits for the `session.updated` the server pushes after
 * every accepted join.
 *
 * Bounded, and the same 10s `createChatClient` gives the same wait, because the
 * ack cannot stand in for it: `SessionJoinAckData` carries `seq` and `replay`
 * and proves only that the join was accepted. Unbounded, a server that acked
 * and then never pushed would leave `open()` pending forever with nothing to
 * report.
 */
const SNAPSHOT_TIMEOUT_MS = 10_000;

/** Frozen once — the empty projection every client starts from. */
const NO_CONVERSATIONS: Readonly<Record<string, ChatState>> = Object.freeze({});

export interface ConversationRegistryOptions {
  /** The CONNECTION-scoped store. `ConnectionController` writes `connectionState`/`lastError` here. */
  readonly store: ChatStore;

  /**
   * The live transport, read fresh on every use.
   *
   * A getter rather than the object, because `ConnectionController` assigns it
   * from inside its own constructor — so nothing that needs both it and the
   * controller can hold it at construction time.
   */
  readonly transport: () => WebSocketTransport;

  readonly localSender: LocalSender;
  readonly history: MessageHistorySource;
  readonly pageSize?: number;
  readonly schedule?: ScheduleTimer;
  readonly now?: Clock;
  readonly logger?: ConversationLogger;
}

export class ConversationRegistry {
  readonly #options: ConversationRegistryOptions;
  readonly #store: ChatStore;
  readonly #schedule: ScheduleTimer;
  readonly #queue: SendQueue;
  readonly #queueRestored: Promise<unknown>;
  readonly #enqueue: EnqueueSend;
  readonly #emitIntent: IntentSink;

  readonly #runtimes = new Map<string, ConversationRuntime>();
  readonly #joining = new Map<string, Promise<void>>();

  /** Sessions the SERVER has this connection joined to. Cleared when the socket goes. */
  readonly #joined = new Set<string>();

  /**
   * The one session queued sends may drain into.
   *
   * `SendQueueOptions.joinedSession` is defence in depth for the same hazard the
   * wire `sessionId` addresses: never WRITE a frame for a session this
   * connection is not joined to, because the wire field is optional and a server
   * that predates it files an addressed send under the current join anyway. At
   * `maxJoined: 1` this is the single joined session; Slice 6 replaces it with
   * the queue's `joinedSessions` set.
   */
  #joinedId: string | null = null;

  /** Change notification, one hop, batched — see {@link onChange}. */
  readonly #listeners = new Set<{ readonly notify: () => void }>();
  #flushScheduled = false;

  /** The last projected map, and the child states it was built from. */
  #conversations: Readonly<Record<string, ChatState>> = NO_CONVERSATIONS;
  readonly #projected = new Map<string, ChatState>();

  /** The previous connection state, so a TRANSITION to `connected` is detectable. */
  #connectionState: ConnectionState;

  readonly #unsubscribes: Unsubscribe[] = [];

  constructor(options: ConversationRegistryOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#schedule = options.schedule ?? systemTimers;
    this.#connectionState = options.store.getState().connectionState;

    this.#emitIntent = (intent) => {
      options.transport().send(intent.t, intent.d);
    };

    const queueTransport: QueueTransport = {
      get isOpen(): boolean {
        return options.transport().isOpen;
      },
      // NOT `send(t, d)`: a replay must reuse the ORIGINAL ULID (D1, §9.3) so a
      // server that already persisted the frame dedupes rather than storing a
      // second, distinct message. The third argument is what makes that true.
      sendWithId: (id, payload) => options.transport().send('message.send', payload, id).ack,
    };

    this.#queue = new SendQueue({
      // See the module header: no party keyspace in this slice, so the queue
      // gets the same in-process default `createChatClient` falls back to.
      storage: new MemoryStorageAdapter(),
      transport: queueTransport,
      // Routed by the ENTRY's own session, never by whatever is joined now —
      // the same rule the pump follows when it addresses the frame.
      onAck: (entry, seq) => this.#runtimes.get(entry.sessionId)?.messages.onAck(entry, seq),
      onFailed: (failure) => this.#runtimes.get(failure.entry.sessionId)?.messages.onFailed(failure),
      joinedSession: () => this.#joinedId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    this.#queueRestored = this.#queue.restore().catch(() => undefined);

    this.#enqueue = async (sessionId, payload) => {
      // `SendQueue.enqueue` throws until `restore()` has settled, and this
      // registry is built synchronously, so restore is necessarily still in
      // flight for anything a caller does in the same tick.
      await this.#queueRestored;
      return this.#queue.enqueue(sessionId, payload);
    };

    this.#unsubscribes.push(this.#store.subscribe((state) => this.#onConnectionChange(state)));
    this.#unsubscribes.push(
      // `disconnected` fires only for a transport-caused drop — `#handleClose`
      // discards `cause: 'local'` — so an explicit `disconnect()` calls
      // `handleLocalDisconnect` instead.
      this.#store.on('disconnected', () => this.#dropConnectionScopedState()),
    );
  }

  // -----------------------------------------------------------------------
  // Projection
  // -----------------------------------------------------------------------

  /**
   * The per-conversation projections, reference-stable until one changes.
   *
   * Recomputed by comparing each row's CURRENT `getState()` against the one the
   * last projection was built from, rather than by a dirty flag set from a
   * subscription. That difference is load-bearing: a child store applies its
   * change synchronously and defers only the NOTIFICATION, so a flag set from
   * the subscription would still be unset if `getState()` were read during the
   * parent store's own flush — which is exactly when a binding reads it. The
   * compare is O(open conversations) per call over already-computed references.
   */
  conversations(): Readonly<Record<string, ChatState>> {
    let changed = this.#runtimes.size !== this.#projected.size;
    if (!changed) {
      for (const [id, runtime] of this.#runtimes) {
        if (this.#projected.get(id) !== runtime.getState()) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return this.#conversations;

    const next: Record<string, ChatState> = {};
    this.#projected.clear();
    for (const [id, runtime] of this.#runtimes) {
      const state = runtime.getState();
      next[id] = state;
      this.#projected.set(id, state);
    }
    // Frozen at this level only: every value is a `ChatState` its own store has
    // already deep-frozen, so a walk would re-freeze nothing.
    this.#conversations = Object.freeze(next);
    return this.#conversations;
  }

  /**
   * Wakes `notify` whenever anything conversation-scoped changed.
   *
   * Batched to one call per microtask, so N rows touched in one synchronous run
   * produce exactly ONE wake-up. Callers still compare projections themselves —
   * this only says "look again", never what changed.
   */
  onChange(notify: () => void): Unsubscribe {
    const registration = { notify };
    this.#listeners.add(registration);
    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      this.#listeners.delete(registration);
    };
  }

  // -----------------------------------------------------------------------
  // Operations
  // -----------------------------------------------------------------------

  /**
   * Joins one conversation and brings its row up: snapshot, then page one.
   *
   * Idempotent — a second call for a conversation already open returns without
   * a second `session.join`, which matters because a staff panel re-enters the
   * same thread on every navigation. Concurrent calls for the same id share one
   * round trip.
   */
  async open(conversationId: string): Promise<void> {
    if (conversationId === '') {
      throw new ConversationNotOpenError('', 'a conversation id is required');
    }

    const existing = this.#runtimes.get(conversationId);
    if (existing !== undefined && existing.opened) return;

    const runtime = existing ?? this.#createRuntime(conversationId);
    // Registered BEFORE the join goes out: the `session.updated` the server
    // pushes after the ack has to have somewhere to land, and it can arrive in
    // the same socket read as the ack itself.
    if (existing === undefined) this.#runtimes.set(conversationId, runtime);

    try {
      await this.#join(runtime);
      await this.#awaitSnapshot(runtime);
      await runtime.loadFirstPage();
      runtime.opened = true;
    } catch (error) {
      if (existing === undefined) {
        this.#runtimes.delete(conversationId);
        runtime.dispose();
      }
      throw error;
    } finally {
      this.#scheduleFlush();
    }
  }

  /** Sends into one open conversation, with the optimistic echo on that row. */
  async sendMessage(
    conversationId: string,
    content: string,
    options: SendMessageOptions = {},
  ): Promise<void> {
    const runtime = this.#runtimes.get(conversationId);
    if (runtime === undefined || !runtime.opened) {
      throw new ConversationNotOpenError(
        conversationId,
        'call open({ conversationId }) and await it before sending into a conversation',
      );
    }
    await runtime.messages.sendMessage(content, options);
  }

  /** An explicit `client.disconnect()`, which produces no `disconnected` event. */
  handleLocalDisconnect(): void {
    this.#dropConnectionScopedState();
  }

  /** Releases every timer and subscription this registry owns. */
  dispose(): void {
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes.length = 0;
    for (const runtime of this.#runtimes.values()) runtime.dispose();
    this.#runtimes.clear();
    this.#listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Inbound routing
  // -----------------------------------------------------------------------

  /** The `onFrame` chain's terminus for this surface. */
  route(frame: ServerFrame): void {
    if (frame.t === 'error') {
      this.#reportConnectionError(frame.d);
      return;
    }
    // Settled through the pending-ack registry; never actually reaches here.
    if (frame.t === 'ack') return;

    this.#routePush(frame);
  }

  #routePush(frame: ServerPushFrame): void {
    const address = addressOf(frame);

    switch (address.kind) {
      case 'connection':
        // Nothing conversation-scoped in it. A staff `connection.ack` resolves
        // no session; `system.pong` is a liveness answer.
        return;

      case 'unaddressable':
        // DECISION (b), addressing.ts. Logged rather than swallowed: the fact
        // that the wire could not say which conversation this belonged to is
        // exactly what a host debugging a stale header needs to see.
        this.#log('debug', 'dropped an inbound frame whose wire shape carries no sessionId', {
          frame: frame.t,
        });
        return;

      case 'unaddressed':
        // Fails closed, mirroring `resolveJoinedSession`'s own reasoning:
        // picking any open conversation would file one thread's traffic into
        // another's. The live source is the v1 bridge's `message.read`.
        this.#log('warn', 'dropped a routable inbound frame that arrived with no sessionId', {
          frame: frame.t,
        });
        return;

      case 'conversation':
        break;
    }

    const runtime = this.#runtimes.get(address.conversationId);
    if (runtime === undefined) {
      this.#log('debug', 'inbound frame for a conversation this client has not opened', {
        frame: frame.t,
      });
      return;
    }

    runtime.applyPush(frame);

    if (frame.t === 'session.closed' && !isParkedCloseReason(frame.d.closeReason)) {
      // A genuinely-ended session can never accept another frame, so its
      // undelivered sends are dead the moment it closes — and dangerous to
      // leave queued. `SWITCHED` is exempt: §12.5 parks that session rather
      // than ending it, and its queued sends are still live.
      if (this.#joinedId === frame.d.sessionId) this.#joinedId = null;
      this.#joined.delete(frame.d.sessionId);
      void this.#queue.abandonSession(frame.d.sessionId).catch(() => undefined);
    }

    this.#scheduleFlush();
  }

  // -----------------------------------------------------------------------
  // Join
  // -----------------------------------------------------------------------

  #join(runtime: ConversationRuntime): Promise<void> {
    const inFlight = this.#joining.get(runtime.id);
    if (inFlight !== undefined) return inFlight;

    const promise = this.#joinOnce(runtime).finally(() => {
      this.#joining.delete(runtime.id);
    });
    this.#joining.set(runtime.id, promise);
    return promise;
  }

  async #joinOnce(runtime: ConversationRuntime): Promise<void> {
    const resumeFrom = runtime.resumeFrom;
    const payload: SessionJoinPayload = {
      sessionId: runtime.id,
      // Omitted on a first join, which the server plans as `fresh` and replays
      // nothing for. An explicit `undefined` is a different value under
      // `exactOptionalPropertyTypes` and would serialise the same only by
      // accident of the encoder.
      ...(resumeFrom === null ? {} : { resumeFrom }),
    };

    const outcome = await this.#options.transport().send('session.join', payload).ack;
    if (outcome.status !== 'acked') throw joinFailure(runtime.id, outcome);

    this.#joined.add(runtime.id);
    this.#joinedId = runtime.id;

    const data = outcome.frame.d as { readonly ok: true } & Partial<SessionJoinAckData>;

    // Replay FIRST, anchor second — see `ConversationRuntime.adoptAnchor`.
    // Routed rather than applied directly, so a replayed frame is addressed by
    // exactly the same table a live one is.
    for (const raw of data.replay ?? []) {
      const push = this.#parseReplayed(raw);
      if (push !== null) this.#routePush(push);
    }
    if (typeof data.seq === 'number') runtime.adoptAnchor(data.seq);

    // Newly joined: anything queued for it can go now.
    void this.#queue.flush().catch(() => undefined);
  }

  /**
   * Validates one replayed frame.
   *
   * `SessionJoinAckData.replay` is typed `Frame<unknown>[]` and the ack
   * validator deliberately does NOT walk it — extra fields on an `ok: true` ack
   * "belong to AckExtraData and are only fully verifiable once the caller
   * correlates `ref`" (`protocol/validate.ts`). This is that correlation, and
   * it applies the same two checks `validateReplayFrame` applies to
   * `connection.ack.d.replay`.
   */
  #parseReplayed(raw: unknown): ServerPushFrame | null {
    const result = validateFrame(raw);
    if (!result.ok) {
      this.#log('warn', 'dropped a malformed frame from a session.join replay', {
        path: result.path,
      });
      return null;
    }
    if (!isServerPushFrameType(result.frame.t)) {
      this.#log('warn', 'dropped a non-push frame from a session.join replay', {
        frame: result.frame.t,
      });
      return null;
    }
    // A nested handshake is not replayable history.
    if (result.frame.t === 'connection.ack') return null;
    // Narrowed by `isServerPushFrameType` on `t`, which does not narrow the
    // frame itself — the same assertion `validateReplayFrame` relies on.
    return result.frame as ServerPushFrame;
  }

  /** Resolves once a snapshot for THIS conversation has landed, or rejects. */
  #awaitSnapshot(runtime: ConversationRuntime): Promise<void> {
    if (runtime.hasSnapshot()) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let cancelTimer: (() => void) | null = null;
      const off = runtime.subscribe(() => {
        if (!runtime.hasSnapshot()) return;
        off();
        cancelTimer?.();
        resolve();
      });
      cancelTimer = this.#schedule(() => {
        off();
        reject(
          new ConversationJoinError(
            runtime.id,
            'noSnapshot',
            null,
            'the join was acknowledged but no session.updated snapshot followed it',
          ),
        );
      }, SNAPSHOT_TIMEOUT_MS);
    });
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  #onConnectionChange(state: ChatState): void {
    // The one connection-scoped field, fanned into every live row.
    for (const runtime of this.#runtimes.values()) runtime.setConnectionState(state.connectionState);

    const previous = this.#connectionState;
    this.#connectionState = state.connectionState;
    this.#scheduleFlush();

    if (state.connectionState !== 'connected') return;
    if (previous === 'connected') return;

    // A reconnect: the server-side joins went with the old socket, so every
    // open conversation re-joins — each carrying its OWN `resumeFrom`, which is
    // the whole reason the anchor is per-session and survives the drop.
    void this.#rejoinAll();
  }

  async #rejoinAll(): Promise<void> {
    for (const runtime of [...this.#runtimes.values()]) {
      if (this.#joined.has(runtime.id)) continue;
      try {
        await this.#join(runtime);
      } catch (error) {
        // Per-conversation, not connection-level: the connection is fine, this
        // one thread is not. §6.4 makes error state observable rather than
        // thrown, and there is no caller to throw to on a reconnect anyway.
        const chatError: ChatError = {
          source: 'protocol',
          code: error instanceof ConversationJoinError ? error.code : null,
          message: 'failed to re-join this conversation after reconnecting',
          retryable: true,
        };
        runtime.store.setState({ lastError: chatError });
        runtime.store.emit('error', chatError);
      }
    }
    this.#scheduleFlush();
  }

  /**
   * Everything that was true only while the socket was up.
   *
   * The joins are the server's, and they went with the socket; typing and
   * presence are claims about right now. Watermarks and the per-session resume
   * anchors deliberately survive — the anchor is precisely what the re-join
   * carries.
   */
  #dropConnectionScopedState(): void {
    this.#joined.clear();
    this.#joinedId = null;
    for (const runtime of this.#runtimes.values()) runtime.resetForDisconnect();
    this.#scheduleFlush();
  }

  #reportConnectionError(payload: ErrorPayload): void {
    // AUTH_EXPIRED is already being handled by the controller's reactive
    // refresh; surfacing it would flash a transient, auto-recovering condition
    // as a user-facing error.
    if (payload.code === 'AUTH_EXPIRED') return;

    const error: ChatError = {
      source: 'protocol',
      code: payload.code,
      message: payload.message,
      retryable: payload.retryable,
      ...(payload.details === undefined ? {} : { details: payload.details }),
    };
    this.#store.setState({ lastError: error });
    this.#store.emit('error', error);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  #createRuntime(id: string): ConversationRuntime {
    const runtime = new ConversationRuntime({
      id,
      localSender: this.#options.localSender,
      history: this.#options.history,
      enqueue: this.#enqueue,
      emitIntent: this.#emitIntent,
      connectionState: this.#store.getState().connectionState,
      ...(this.#options.pageSize === undefined ? {} : { pageSize: this.#options.pageSize }),
      ...(this.#options.schedule === undefined ? {} : { schedule: this.#options.schedule }),
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
    });
    this.#unsubscribes.push(runtime.subscribe(() => this.#scheduleFlush()));
    return runtime;
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      // Iterate a copy and re-check liveness, so registering or unsubscribing
      // during the pass neither extends it nor shifts the rest out of it —
      // the same discipline `ChatStore#flush` keeps.
      for (const registration of [...this.#listeners]) {
        if (!this.#listeners.has(registration)) continue;
        registration.notify();
      }
    });
  }

  #log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.#options.logger?.(level, message, meta);
  }
}

/** Maps a non-`acked` join outcome onto the one error a caller has to handle. */
function joinFailure(conversationId: string, outcome: AckOutcome): ConversationJoinError {
  switch (outcome.status) {
    case 'rejected':
      return new ConversationJoinError(
        conversationId,
        'refused',
        outcome.error.code,
        'the server refused session.join for this conversation',
      );
    case 'timeout':
      return new ConversationJoinError(
        conversationId,
        'timeout',
        null,
        'session.join was not acknowledged in time',
      );
    default:
      return new ConversationJoinError(
        conversationId,
        'notSent',
        null,
        'session.join was not sent: the connection is not open',
      );
  }
}
