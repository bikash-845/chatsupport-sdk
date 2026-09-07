// ONE conversation, as an ordinary `ChatState`.
//
// ── The shape this file exists to prove ──────────────────────────────────
//
// `ChatState` is not edited and is not the container: it is the ELEMENT type.
// One conversation projects to one complete, ordinary `ChatState` — all twelve
// fields of §6.4, deeply frozen by the store that owns it — which is what lets
// every shipped binding work per-thread later without gaining a single new
// concept, and what makes `ConversationsState.conversations` a plain
// `Record<sessionId, ChatState>` rather than a new shape nobody has a selector
// for.
//
// The controllers underneath are the SHIPPED ones, unmodified:
// `MessageController` and `PresenceCoordinator` are constructed here exactly as
// `create-chat-client.ts` constructs them, over a `ChatStore` of this
// conversation's own. Plan §4.2 reached the same place through a
// `ConversationStore` interface plus five one-line `Options` widenings; giving
// each conversation a real `ChatStore` reaches it with ZERO edits to any
// existing runtime file, which is a strictly better answer to rule 1 — there is
// no customer-path source line for a regression to hide in, because none was
// touched. The cost is one extra store object per open conversation, which at
// the plan's own default of 20 joined threads is not a cost.
//
// ── What is NOT here, and why ────────────────────────────────────────────
//
// No storage, no selected-session record, no session SWITCHING, no
// `pastSessions`, no `conversationStarted`. Those are the customer surface's
// concerns: a party client does not switch — it opens another conversation. The
// frame dispatch below is `create-chat-client.ts`'s, with every customer-only
// branch (the switch-target guard, the storage forget, the queue abandon) lifted
// out rather than copied, and the two guards that are about CORRECTNESS rather
// than about switching (id-matched `statusChange`, wholesale snapshot apply)
// kept.
//
// `pastSessions` stays `[]` on a party row, permanently and by design: it is the
// customer session-picker's data source, and the party equivalent is the
// conversation index, which is Slice 9. It is present only because `ChatState`
// is a fixed shape this slice does not get to trim.

import { applySessionClosed, sessionSnapshotToChatSession, statusOrModeChanged } from '../client/session.js';
import { frameSeq } from '../connection/index.js';
import { MessageController } from '../messages/index.js';
import type { EnqueueSend, LocalSender, MessageHistorySource } from '../messages/index.js';
import { PresenceCoordinator } from '../presence/index.js';
import type { Clock, IntentSink, ScheduleTimer } from '../presence/index.js';
import type { ServerPushFrame } from '../protocol/index.js';
import { ChatStore } from '../state/index.js';
import type { ChatState, ConnectionState } from '../state/index.js';
import { addressed } from './addressing.js';

/**
 * The uploader `MessageController` requires but this surface does not offer.
 *
 * `sendAttachment` is not on `ConversationClient` in this slice, so nothing can
 * reach it — but a stub that resolved, or one that threw a bare `Error` with no
 * explanation, would both be worse than one that says exactly what is missing
 * if a later slice wires the method before wiring the seam.
 */
const UNSUPPORTED_UPLOADER = {
  upload(): Promise<never> {
    return Promise.reject(
      new Error(
        'attachments are not supported on the conversation surface yet: ' +
          'ConversationClientConfig has no `uploader` seam in this release.',
      ),
    );
  },
};

export interface ConversationRuntimeOptions {
  /** The session id. This IS the conversation's identity on the wire. */
  readonly id: string;

  /** Who this client sends as, and whose watermarks/typing echo are "ours". */
  readonly localSender: LocalSender;

  /** Backward-cursor history reads. The same seam shape `ChatClientConfig.history` uses. */
  readonly history: MessageHistorySource;

  /**
   * Durable queueing. Supplied by the registry, which owns the ONE `SendQueue`
   * this connection has — the queue is already multi-session (entries carry
   * their own `sessionId` and the pump addresses from the entry), so one queue
   * across N conversations is its designed shape, not a compromise.
   */
  readonly enqueue: EnqueueSend;

  /**
   * The CONNECTION-level intent sink — unwrapped. This constructor wraps it
   * with {@link addressed} for this conversation; a caller that pre-addressed
   * it would stamp the id twice and hide which layer owns the decision.
   */
  readonly emitIntent: IntentSink;

  /** The connection state to seed this row with. See {@link setConnectionState}. */
  readonly connectionState: ConnectionState;

  readonly pageSize?: number;
  readonly schedule?: ScheduleTimer;
  readonly now?: Clock;
}

export class ConversationRuntime {
  readonly id: string;

  /** This conversation's own store. Never handed out — the registry projects it. */
  readonly store: ChatStore;

  readonly messages: MessageController;
  readonly presence: PresenceCoordinator;

  /**
   * The last `seq` APPLIED for this session, or `null` before anything has
   * been.
   *
   * This is what goes out as `SessionJoinPayload.resumeFrom` — the per-session
   * mirror of `connection.hello.resumeFrom`, and the reason a multi-session
   * client needs one: a single connection-wide cursor cannot describe N
   * sessions, so the anchors arrive one per join ack instead
   * (`SessionJoinAckData.seq`). Both halves of that contract have been on the
   * wire since day one and were unused by core until now.
   */
  #resumeFrom: number | null = null;

  /** True once `open()` has fully landed: joined, snapshot applied, page one read. */
  opened = false;

  /** Injected, defaulted once — no module in core reaches for a global clock. */
  readonly #now: Clock;

  constructor(options: ConversationRuntimeOptions) {
    this.id = options.id;
    this.#now = options.now ?? Date.now;
    this.store = new ChatStore();
    this.store.setState({ connectionState: options.connectionState });

    this.messages = new MessageController({
      store: this.store,
      enqueue: options.enqueue,
      sender: () => options.localSender,
      history: options.history,
      uploader: UNSUPPORTED_UPLOADER,
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    });

    this.presence = new PresenceCoordinator({
      store: this.store,
      // DECISION (a). Every addressable frame this conversation produces leaves
      // carrying its own `sessionId`, from the first conversation onward. See
      // addressing.ts for why this is not conditioned on capacity.
      emitIntent: addressed(this.id, options.emitIntent),
      // Explicit rather than adopted from the snapshot's lone CUSTOMER
      // participant: that auto-adopt heuristic is right for a customer embed
      // and wrong here, where the local participant is a staff member and the
      // conversation's CUSTOMER is somebody else entirely.
      localParticipantId: options.localSender.senderId,
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      ...(options.now === undefined ? {} : { clock: options.now }),
    });
  }

  /** The complete `ChatState` for this conversation. Deeply frozen by the store. */
  getState(): ChatState {
    return this.store.getState();
  }

  /** Wakes on any change to this conversation. The registry's only hook into it. */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  /** `SessionJoinPayload.resumeFrom` for the next join, or `null` for a fresh one. */
  get resumeFrom(): number | null {
    return this.#resumeFrom;
  }

  /**
   * True once a snapshot for THIS session has landed.
   *
   * The id is checked, not just presence: a `connection.ack` on a keyed client
   * can seed some other session, and a row whose `session` names a different
   * conversation is not a row this one has been described by.
   */
  hasSnapshot(): boolean {
    return this.store.getState().session?.id === this.id;
  }

  /**
   * Adopts `SessionJoinAckData.seq` as this session's resume anchor.
   *
   * Applied AFTER the ack's replay, exactly as `ConnectionController` adopts
   * `connection.ack.d.seq` after its own: adopting first would claim currency
   * at a `seq` past frames that had not been applied yet, and an empty replay
   * against a moved-on anchor is that same bug at its starkest.
   */
  adoptAnchor(seq: number): void {
    if (this.#resumeFrom === null || seq > this.#resumeFrom) this.#resumeFrom = seq;
  }

  /**
   * The one connection-scoped field fanned into every row (plan §4.2).
   *
   * Fanned out on WRITE rather than composed on READ: composing would return a
   * fresh object from every `getState()`, which is exactly the
   * `useSyncExternalStore` "getSnapshot should be cached" loop `state/store.ts`
   * names by URL. `setState` is a no-op when the value is unchanged, so the
   * fan-out costs one reference compare per row per transition.
   */
  setConnectionState(connectionState: ConnectionState): void {
    this.store.setState({ connectionState });
  }

  /** Loads page one of this conversation's history through the injected seam. */
  async loadFirstPage(): Promise<void> {
    // The explicit target is what makes this page ONE rather than "the page
    // before the oldest row we hold": `loadMore` only takes a `before` cursor
    // when it is reading the CURRENT session implicitly. Replayed frames from
    // the join ack may already be in the list, and `prependPage` dedupes by id.
    await this.messages.loadMore(this.id);
  }

  /**
   * Applies one addressed server push.
   *
   * This is `create-chat-client.ts`'s `dispatchFrame`, minus every branch that
   * is about the customer's single-session lifecycle. Ordering is preserved
   * where it is load-bearing: the snapshot is committed BEFORE `statusChange`
   * is emitted, so a handler reading `getState()` sees the state the event
   * describes.
   */
  applyPush(frame: ServerPushFrame): void {
    this.#noteSeq(frame);

    if (frame.t === 'connection.ack' || frame.t === 'session.updated') {
      const snapshot = frame.d.session;
      if (snapshot !== undefined) {
        const previous = this.store.getState().session;
        const next = sessionSnapshotToChatSession(snapshot, previous);
        this.store.setState({ session: next });

        // Same session only: §6.5 defines `statusChange` as "the session you
        // are in changed status", and this runtime is only ever handed frames
        // for its own conversation, so the id check is a guard against a
        // snapshot that replaced the row wholesale rather than refreshed it.
        if (previous !== null && previous.id === next.id && statusOrModeChanged(previous, next)) {
          this.store.emit('statusChange', { status: next.status, mode: next.mode });
        }
      }
    }

    // presence/ owns typing, presence and watermarks — and, for watermark
    // reconciliation, the same two snapshot frames handled above. Both can
    // process one frame because they touch disjoint state.
    if (this.presence.handleFrame(frame)) return;

    switch (frame.t) {
      case 'message.new':
        this.messages.applyIncoming(frame.d);
        return;

      case 'session.closed': {
        const current = this.store.getState().session;
        const isCurrent = current !== null && current.id === frame.d.sessionId;
        this.store.setState({
          session: applySessionClosed(current, frame.d.sessionId, new Date(this.#now()).toISOString()),
        });
        // The registry owns what happens to this conversation's QUEUED sends
        // and to the connection's join bookkeeping; this runtime owns only the
        // row. See `ConversationRegistry#routePush`.
        if (isCurrent) this.store.emit('sessionClosed', { closeReason: frame.d.closeReason });
        return;
      }

      // `agent.joined`, `agent.left` and `ticket.linked` never reach here:
      // `addressOf` classifies them `unaddressable` and the registry drops them
      // before routing. See DECISION (b) in addressing.ts.
      default:
        return;
    }
  }

  /**
   * Drops connection-scoped state when the socket goes.
   *
   * Typing and presence are statements about *right now* over a socket that is
   * gone; watermarks deliberately survive, being durable read state reconciled
   * against the next snapshot (§9.5). The join is gone too, server-side, so the
   * registry re-sends `session.join` on reconnect — carrying {@link resumeFrom},
   * which is why the anchor is NOT reset here.
   */
  resetForDisconnect(): void {
    this.presence.reset();
  }

  /** Releases this conversation's timers. */
  dispose(): void {
    this.presence.reset();
  }

  /**
   * Advances the per-session resume anchor.
   *
   * `frameSeq` is core's own answer to "what position does this frame occupy"
   * and is reused rather than re-derived: only `message.new` carries a `seq`,
   * and reading `connection.ack.d.seq` here would confuse an ANCHOR with a
   * frame's own position.
   */
  #noteSeq(frame: ServerPushFrame): void {
    const seq = frameSeq(frame);
    if (seq === null) return;
    if (this.#resumeFrom === null || seq > this.#resumeFrom) this.#resumeFrom = seq;
  }
}
