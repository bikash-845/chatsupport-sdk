// createChatClient — PRD §6.1. The front door: every T7-T12 module gets
// constructed and wired together exactly once, here.
//
// ── Construction order, and the two forward-reference patterns it needs ──
//
// Most of this file is straight-line construction. Two spots are not, and
// both are documented inline where they happen:
//
//   1. `messageController` <-> `queue`. `MessageController` takes `enqueue`
//      as a function (messages/types.ts's `EnqueueSend`), not the `SendQueue`
//      itself, because the queue needs the controller's `onAck`/`onFailed`
//      callbacks at *its* construction — so whichever is built first has to
//      reference the other before it exists. Explicit type annotations on
//      both `const` declarations break the TS7022 circular-inference error
//      this would otherwise produce; see queue/send-queue.ts's `SendQueue`
//      doc and messages/types.ts's `EnqueueSend` doc for why neither module
//      restructures around this instead.
//   2. `realTransport` / `messageControllerRef`. `dispatchFrame` and
//      `emitIntent` are both built *before* the objects they call into
//      (`WebSocketTransport`, `MessageController`) exist, because
//      `ConnectionController`'s constructor calls the transport factory
//      synchronously and needs `onFrame` wired in before that happens. Both
//      are plain closures over a `let` assigned later — safe because neither
//      closure is *invoked* until a consumer calls `connect()`/`sendMessage()`
//      /etc., well after this function has finished wiring everything and
//      returned.
//
// Nothing here does HTTP, reads `window`/`document`, or imports a framework.
// The only globals touched are `WebSocket` (lazily, inside the transport,
// only at connect time) and `Date`/`setTimeout` (only as the *default* clock
// and scheduler — every module already accepts an injected override).

import { parsePublishableKey } from '../auth/index.js';
import { fullJitterDelay } from '../backoff/index.js';
import {
  ConnectionController,
  type TransportFactory,
} from '../connection/index.js';
import { recordIdentitySynced, shouldSyncIdentity } from '../identity/index.js';
import type { IdentityProfile, IdentitySync } from '../identity/index.js';
import { MessageController, upsertMessage } from '../messages/index.js';
import type { LocalSender } from '../messages/index.js';
import { PresenceCoordinator, systemClock, systemTimers } from '../presence/index.js';
import type { Clock, ScheduleTimer } from '../presence/index.js';
import { isParkedCloseReason } from '../protocol/index.js';
import type { ChatStatus, ErrorPayload, ServerFrame } from '../protocol/index.js';
import { SendQueue } from '../queue/index.js';
import type { QueuedSend, QueueTransport, RetryOutcome } from '../queue/index.js';
import { ChatStore } from '../state/index.js';
import type { ChatError, ChatMessage, ChatSession, ChatSessionSummary, ChatState } from '../state/index.js';
import { MemoryStorageAdapter, namespaced } from '../storage/index.js';
import { encodeNamespaceSegment } from '../storage/namespace.js';
import { WebSocketTransport } from '../transport/index.js';
import type { TransportLogger } from '../transport/index.js';
import {
  applyAgentJoined,
  applyAgentLeft,
  applySessionClosed,
  applyTicketLinked,
  sessionSnapshotToChatSession,
  statusOrModeChanged,
} from './session.js';
import { ChatClientConfigError, SessionSwitchError } from './types.js';
import type { ChatClient, ChatClientConfig } from './types.js';

/** Resolves `config.localSender` to a plain `() => LocalSender`, whether given as an object or a thunk. */
function normalizeLocalSender(input: LocalSender | (() => LocalSender)): () => LocalSender {
  return typeof input === 'function' ? input : () => input;
}

/** Adapts §6.1's `logger` callback to the transport's single-method `TransportLogger` (§14: `warn` only). */
function adaptLogger(logger: ChatClientConfig['logger']): TransportLogger | undefined {
  if (logger === undefined) return undefined;
  return {
    warn(message, context) {
      logger('warn', message, context);
    },
  };
}

/** An `AttachmentUploader` that fails loudly — the `config.uploader` unset case (see client/types.ts). */
const UNCONFIGURED_UPLOADER = {
  upload(): Promise<never> {
    return Promise.reject(
      new ChatClientConfigError(
        'sendAttachment() requires config.uploader (an AttachmentUploader) to be supplied to createChatClient().',
      ),
    );
  },
};

/**
 * Storage key, under the same namespace as the send queue, holding the id of
 * the session the user actually chose.
 *
 * The SDK needs this because the protocol does not carry it:
 * `ConnectionHelloPayload` has no `sessionId` field (protocol/frames.ts), so
 * on every fresh connection the server re-resolves the customer's session on
 * its own — most recently updated, ACTIVE only. A session picked out of a
 * picker is usually CLOSED or RESOLVED, so it is not a candidate, and the
 * server hands back a different conversation entirely. That is the whole of
 * "reload the app and it does not load the messages of the session we spoke
 * in": nothing was wrong with the transcript, the client was silently put
 * back into another session.
 *
 * Persisting client-side rather than adding `sessionId` to the hello payload
 * is deliberate: it needs no wire change and no backend deploy, and a client
 * that re-joins explicitly is also correct against a server that has not been
 * updated.
 */
const SELECTED_SESSION_KEY = 'selectedSession';

/**
 * How long a switch waits for the `session.updated` push that follows the
 * join ack before giving up.
 *
 * Bounded because the ack cannot stand in for it: `session.join`'s ack is
 * `EmptyAckData` (protocol/frames.ts) and proves only that the server
 * accepted the frame. Unbounded, a server that acked and then never pushed
 * would leave `switchSession()` pending forever and a picker spinning with no
 * way to report anything.
 */
const SESSION_SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * How many times identify is re-sent after the first attempt fails: once, and
 * then this client instance is done with it.
 *
 * Bounded, and deliberately not persistent, because identify is bookkeeping
 * and not the user's work. The dedup gate only starts a TTL window on a
 * SUCCESS (identity/dedup.ts), so a backend outage costs a delayed CRM
 * update, never a lost one — the next client the host builds re-reads the
 * gate, sees no window, and sends again. An unbounded retry would instead
 * keep a failed POST alive for the whole life of a tab, against the one path
 * in this file that nothing is waiting on and nobody would notice looping.
 */
const IDENTIFY_RETRY_LIMIT = 1;

/**
 * Statuses a conversation cannot be continued from.
 *
 * Only ever read to decide what to PERSIST as the session to come back to
 * (see `rememberEstablishedSession`) — never to gate rendering, joining, or
 * sending, all of which stay legal against a finished session. `ON_HOLD` is
 * deliberately absent: it is paused, not over.
 */
const TERMINAL_SESSION_STATUSES: readonly ChatStatus[] = ['CLOSED', 'RESOLVED'];

function toChatError(payload: ErrorPayload): ChatError {
  return {
    source: 'protocol',
    code: payload.code,
    message: payload.message,
    retryable: payload.retryable,
    ...(payload.details === undefined ? {} : { details: payload.details }),
  };
}

export function createChatClient(config: ChatClientConfig): ChatClient {
  // ---------------------------------------------------------------------
  // 1. Validate config. Loud failure at construction beats a token minted
  //    in a browser (§14) or a client that silently never connects.
  // ---------------------------------------------------------------------
  const publishableKey = parsePublishableKey(config.publishableKey);

  const wsUrl = config.wsUrl;
  if (wsUrl === undefined || wsUrl === '') {
    throw new ChatClientConfigError(
      'wsUrl is required: core has no legitimate default WebSocket endpoint to fall back to ' +
        '(PRD §12.7 rejects hardcoded/derived hosts). Pass ChatClientConfig.wsUrl explicitly.',
    );
  }

  const resolveLocalSender = normalizeLocalSender(config.localSender);
  // Resolved once, eagerly, so presence/typing/watermark identity (below) is
  // seeded correctly from construction — not just at send time. See
  // client/types.ts's `localSender` doc for what happens if a thunk needs
  // data that is only available after `connect()`.
  const localSender = resolveLocalSender();

  const storage = config.storage ?? new MemoryStorageAdapter();
  // Namespaced by publishable key so two ChatClient instances sharing one
  // backing store (two embeds on one origin, agent + customer side by side)
  // never collide on the same 'sendQueue' key. Nested rather than
  // interpolated into one string — `namespaced()` rejects a namespace
  // containing ':' (its own delimiter), precisely to stop two different
  // namespace/key pairs from colliding on the same resulting key.
  //
  // ── …and by WHO IS USING IT, which is the half that was missing ──────────
  //
  // The publishable key identifies the TENANT, not the person. One browser
  // routinely holds more than one identity against it: a host page mints a
  // per-browser guest id for a visitor and swaps it for the real user id when
  // they sign in, then rebuilds the client. With only the key in the
  // namespace, everything below is inherited across that swap by whoever
  // comes next, and neither thing survives contact with the server:
  //
  //   • `selectedSession` — the new identity re-joins a session belonging to
  //     the old one. `session.join` is refused (SESSION_NOT_FOUND, correctly)
  //     and `GET /chat/sessions/{id}/messages` answers 404 for the same
  //     reason. Recoverable — the selection is forgotten and the caller's own
  //     session is loaded instead — but only after a failed round trip and an
  //     error the host's tracker sees on every sign-in.
  //   • `sendQueue` — worse, and not recoverable. `message.send` carries no
  //     author; the server attributes it to whoever is connected. A message a
  //     GUEST typed offline, still queued when they sign in, is delivered as
  //     the signed-in user, into that user's session.
  //
  // So the identity joins the namespace. The cost is a one-time orphaning of
  // anything queued under the old two-level key on upgrade; that is strictly
  // better than delivering it as the wrong person.
  //
  // The two levels stop one short of the identity on purpose, and everything
  // that must not cross an identity swap adds the third level below. The
  // identify dedup record (section 7c) is the one thing that legitimately
  // lives at THIS level: it holds a hash and a timestamp, no PII and no
  // content, and the hash folds the user id in, so a record another identity
  // wrote can never match — it can only be overwritten, which costs one
  // redundant idempotent POST. Keeping it here is what bounds this feature to
  // a single stored record per tenant forever, however many people sign in on
  // the device. See identity/dedup.ts's storage-key doc.
  const tenantStorage = namespaced(namespaced(storage, 'chatsdk'), publishableKey);
  const queueStorage = namespaced(
    tenantStorage,
    // Encoded, not passed raw: a participant id is the host's own user
    // identifier and may contain the delimiter (`auth0:1234` is a real
    // format), which `namespaced` rejects outright. See encodeNamespaceSegment.
    encodeNamespaceSegment(localSender.senderId),
  );

  const schedule = config.schedule;
  const now = config.now;
  const transportLogger = adaptLogger(config.logger);

  // ---------------------------------------------------------------------
  // 2. The store. Everything else writes into this one instance.
  // ---------------------------------------------------------------------
  const store = new ChatStore();

  // ---------------------------------------------------------------------
  // 3. Forward-declared refs — see the file header, pattern 2.
  // ---------------------------------------------------------------------
  let realTransport!: WebSocketTransport;
  let messageControllerRef!: MessageController;

  // ---------------------------------------------------------------------
  // 4. Presence/typing/watermarks. Needs `emitIntent`, which needs the
  //    transport — forward-referenced (not invoked until a consumer calls
  //    startTyping()/markRead()/etc., well after construction finishes).
  // ---------------------------------------------------------------------
  const presenceCoordinator = new PresenceCoordinator({
    store,
    emitIntent: (intent) => {
      realTransport.send(intent.t, intent.d);
    },
    // Explicit, not adopted from the session snapshot's lone CUSTOMER
    // participant: that auto-adopt heuristic (watermarks.ts) is correct only
    // for a customer-facing embed. An agent-side embed's local participant is
    // the agent, and `localSender` is the one place that is actually known,
    // so it is used to seed identity for typing self-echo filtering and
    // read-watermark keying too — not just message sender labeling.
    localParticipantId: localSender.senderId,
    ...(schedule === undefined ? {} : { schedule }),
    ...(now === undefined ? {} : { clock: now }),
  });

  // ---------------------------------------------------------------------
  // 5. The inbound frame dispatcher — the onFrame chain every server push
  //    ultimately reaches. Closes three gaps none of T7-T12 owned:
  //      - SessionSnapshot -> ChatSession (T8's flagged gap; this is what
  //        makes `connected` actually fire with a populated session).
  //      - a live 'error' frame that isn't AUTH_EXPIRED (handled internally)
  //        and isn't ref-matched to a pending send never otherwise reaches
  //        `lastError`/the `error` event.
  //      - agent.joined/left, session.closed, ticket.linked all need to
  //        both patch `ChatState.session` and emit their §6.5 event; nothing
  //        else does either.
  // ---------------------------------------------------------------------

  /**
   * The session the SERVER has this connection joined to — `conn.sessionId` on
   * its side, tracked here.
   *
   * Deliberately NOT `ChatState.session?.id`. That is a projection of the last
   * SNAPSHOT the server pushed, and the two diverge in both directions: it
   * still names the outgoing session for the whole of a switch's join round
   * trip, and after a REFUSED `session.join` it names a session this
   * connection is joined to while the one the client asked for was never
   * entered at all.
   *
   * Only two things move it, and both are the server saying so: the
   * `connection.ack` handshake (which resolves and joins a session with no
   * `session.join` frame at all) and an ACKED `session.join`. A refusal, a
   * timeout, or a `disconnected` send moves nothing — which is what makes
   * "flush only into the session we are actually in" true rather than
   * hopeful.
   */
  let joinedSessionId: string | null = null;

  /**
   * The session an in-flight `switchSession` is committed to, or `null` when
   * no switch is running.
   *
   * This is the ONE guard the rebuilt switch keeps, and it sits on the single
   * WRITE path (`dispatchFrame`'s snapshot branch) rather than on every read.
   * That inversion is the whole point of the rebuild: rounds 2-3 layered
   * `pendingSessionId`/`committedSessionId` over every history read because
   * the store could be a lie about which conversation the client was in; now
   * the store is never a lie, and the only thing left to say is *which
   * snapshot is allowed to repaint it while a switch is under way*.
   *
   * It is needed because `connection.hello` carries no session id
   * (protocol/frames.ts): the fresh connection a switch establishes is
   * resolved by the SERVER — most-recently-updated, ACTIVE only — so its
   * `connection.ack` very often names a third conversation, neither the one
   * being left nor the one being opened. Painting that one would flash a
   * conversation the customer never asked for between the two they did.
   *
   * Refusing it is safe precisely because it is refused WHOLESALE: identity
   * and data are never split, so "do not paint" leaves the outgoing session
   * intact and self-consistent rather than half-applied.
   */
  let switchTarget: string | null = null;

  function dispatchFrame(frame: ServerFrame): void {
    if (frame.t === 'error') {
      // AUTH_EXPIRED is already being actively handled by the connection
      // controller's reactive refresh (§10.4) — surfacing it here would
      // flash a transient, auto-recovering condition as a user-facing error,
      // contradicting §10.5's "the app never has to think about which path
      // was taken". Every other code is a genuine, unhandled protocol error
      // with nowhere else to go: a ref-less or unmatched-ref `error` frame
      // reaches `onFrame` without ever passing through
      // ConnectionController's own `#reportError`.
      if (frame.d.code !== 'AUTH_EXPIRED') {
        const chatError = toChatError(frame.d);
        store.setState({ lastError: chatError });
        store.emit('error', chatError);
      }
      return;
    }
    if (frame.t === 'ack') return; // Never actually reaches onFrame (settled via the pending-ack registry) — defensive only.

    // frame: ServerPushFrame from here on.
    if (frame.t === 'connection.ack') {
      // A session-less `connection.ack` is the STAFF handshake
      // (protocol/frames.ts). It cannot arrive here: this client is
      // customer-only — `ChatClientConfig.publishableKey` is required — and
      // `ConnectionController` rejects a session-less ack on a customer
      // connection before it is ever delivered. Handled rather than asserted
      // because the alternative is seeding the whole state tree from
      // `undefined`, and there is nothing this client could usefully do with a
      // handshake that resolved no conversation.
      if (frame.d.session === undefined) return;

      // The handshake IS a join: chat-service resolves the customer's session
      // and sets `conn.sessionId` from it without any `session.join` frame
      // being written, so this is the only place that transition is visible.
      joinedSessionId = frame.d.session.sessionId;
    }

    if (frame.t === 'connection.ack' || frame.t === 'session.updated') {
      // Narrowed above for `connection.ack`; always present on
      // `session.updated`, whose validator still REQUIRES it.
      const snapshot = frame.d.session;
      if (snapshot === undefined) return;

      const previous = store.getState().session;
      const next = sessionSnapshotToChatSession(snapshot, previous);
      // Whether this snapshot REPLACES the conversation on screen, rather than
      // refreshing the one already there.
      const replacing = previous !== null && previous.id !== next.id;

      // While a switch is in flight, only its target may replace what is on
      // screen. See `switchTarget`: the fresh connection a switch opens is
      // resolved by the server, so its `connection.ack` routinely names a
      // third session. Refusing it wholesale keeps the outgoing session whole
      // — identity, transcript, header, composer — for the whole switch,
      // instead of flashing a conversation nobody asked for. A snapshot for
      // the session already on screen is never refused: a status change on it
      // is still news.
      if (replacing && switchTarget !== null && next.id !== switchTarget) return;

      // `connection.ack` seeds itself: the `connected` handler that follows
      // every handshake ends in `restoreSelectionAndSeed`'s own page-one read.
      // See `seedReplacedSession`.
      commitSession(next, frame.t === 'connection.ack');

      // Same session only. §6.5 defines `statusChange` as "the session you are
      // in changed status"; a snapshot for a DIFFERENT session — the one a
      // switch just landed on — is a different chat, not a change, and firing
      // here would tell a customer who just opened a resolved conversation
      // that their chat was "just closed".
      if (previous !== null && previous.id === next.id && statusOrModeChanged(previous, next)) {
        store.emit('statusChange', { status: next.status, mode: next.mode });
      }

      // The other half of the same either/or: a DIFFERENT session, which
      // `statusChange` deliberately refuses above, is news of its own kind.
      //
      // `session.updated` only — never `connection.ack`. A handshake resolving
      // to a different session is just a reconnect landing where the server
      // put us, which happens on ordinary page loads, and emitting there would
      // fire this on nearly every visit. `replacing` already excludes the
      // first-ever snapshot (`previous === null`), and the `switchTarget`
      // guard above has already returned for every snapshot of a switch the
      // customer started themselves.
      //
      // AFTER `commitSession`, so a handler that reads `ChatState` sees the
      // conversation this event is announcing rather than the one it replaced
      // — the ordering `sessionClosed` and `agentJoined` also keep.
      if (frame.t === 'session.updated' && replacing && previous !== null) {
        store.emit('conversationStarted', { session: next, previousSessionId: previous.id });
      }
    }

    // presence/, not this file, owns typing/presence/watermarks and (for
    // watermark reconciliation) the same two snapshot frame types handled
    // above — both can process the same frame since they touch disjoint
    // state.
    if (presenceCoordinator.handleFrame(frame)) return;

    switch (frame.t) {
      case 'message.new':
        messageControllerRef.applyIncoming(frame.d);
        return;
      case 'agent.joined':
        store.setState({ session: applyAgentJoined(store.getState().session, frame.d) });
        store.emit('agentJoined', frame.d);
        return;
      case 'agent.left':
        // frame.d.id (HandledBy) — the v2 wire contract renamed this from
        // `agentId`. See client/session.ts's applyAgentLeft and the T7 report.
        store.setState({ session: applyAgentLeft(store.getState().session, frame.d.id) });
        store.emit('agentLeft', frame.d);
        return;
      case 'session.closed': {
        // Read once, before setState: switchSession's reactivation flow can
        // pair THIS close (for the session just left) with a session.updated
        // for a DIFFERENT, already-current session (the one just switched
        // into) — see ChatClient.switchSession's doc, "The SWITCHED-close
        // pairing". `sessionClosed` (§6.5, state/events.ts) is documented to
        // describe "the session the client is already in", so it must fire
        // only when the closed session actually IS the one still current —
        // otherwise a customer who has already switched away would be told
        // their NEW chat just closed, when it was the abandoned old one,
        // elsewhere, that did. `applySessionClosed` already no-ops the STATE
        // write for a non-matching id (session.ts); this is the same guard
        // applied to the EVENT, which previously had none.
        const current = store.getState().session;
        const isCurrentSession = current !== null && current.id === frame.d.sessionId;

        store.setState({
          session: applySessionClosed(current, frame.d.sessionId, new Date((now ?? Date.now)()).toISOString()),
        });
        if (isCurrentSession) {
          store.emit('sessionClosed', { closeReason: frame.d.closeReason });
        }

        // A genuinely-ended session can never accept another frame, so its
        // undelivered sends are dead the moment it closes — and dangerous to
        // leave queued, since `message.send` carries no `sessionId` and the
        // next session to open would inherit them. Failing them here reports
        // each one through `sendFailed` with an accurate `'sessionClosed'`,
        // rather than leaving the queue to rediscover the same fact one
        // rejected frame at a time.
        //
        // `SWITCHED` is exempt: §12.5 parks that session rather than ending
        // it (`isParkedCloseReason`), and its queued sends are still live.
        //
        // Fire-and-forget with the rejection contained: a storage failure
        // here leaves the entries queued, where the ordinary pump will still
        // surface them as failed — never silently dropped — and an escaping
        // rejection would land on the host app's window.
        if (!isParkedCloseReason(frame.d.closeReason)) {
          void queue.abandonSession(frame.d.sessionId).catch(() => undefined);
          // A genuinely-ended session must not be what the next reload
          // re-joins: the customer would come back to a dead conversation
          // instead of the one the server would have given them. `SWITCHED`
          // is exempt for the same reason its queued sends are — §12.5 parks
          // that session rather than ending it.
          void forgetSelectedSession(frame.d.sessionId);
        }
        return;
      }
      case 'ticket.linked':
        store.setState({ session: applyTicketLinked(store.getState().session, frame.d) });
        store.emit('ticketLinked', frame.d);
        return;
      case 'system.pong':
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------
  // 6. Transport + connection controller. The factory assigns
  //    `realTransport` synchronously, from inside `new ConnectionController`
  //    below, so it is safely readable immediately afterward.
  // ---------------------------------------------------------------------
  const createTransport: TransportFactory = (handlers) => {
    realTransport = new WebSocketTransport({
      ...(config.webSocketFactory === undefined ? {} : { webSocket: config.webSocketFactory }),
      ...(now === undefined ? {} : { now }),
      ...(schedule === undefined ? {} : { schedule }),
      ...(transportLogger === undefined ? {} : { logger: transportLogger }),
      ...(config.protocolVersion === undefined ? {} : { protocolVersion: config.protocolVersion }),
      ...handlers,
    });
    return realTransport;
  };

  const connectionController = new ConnectionController({
    store,
    url: wsUrl,
    publishableKey,
    // Absent, not `undefined` — `exactOptionalPropertyTypes` makes those
    // different, and absence is what selects the support conversation.
    ...(config.target === undefined ? {} : { target: config.target }),
    getToken: config.getToken,
    createTransport,
    onFrame: dispatchFrame,
    // onResumeGap is deliberately left unwired — see the T13 report. The
    // controller already emits the §6.5 `error` event for every gap
    // regardless (connection/controller.ts's `#reportResumeGap`); there is
    // no messages/ seam yet for "refetch history around a hole" to drive
    // automatically.
    ...(schedule === undefined ? {} : { schedule }),
  });

  // realTransport is assigned now — ConnectionController's constructor
  // called `createTransport` synchronously.

  const queueTransport: QueueTransport = {
    get isOpen(): boolean {
      return realTransport.isOpen;
    },
    // The queue's seam, deliberately NOT `WebSocketTransport.send(t, d)`:
    // replay must reuse the original ULID (D1, §9.3) so a server that
    // already persisted the frame dedupes rather than double-sending. The
    // third `replayId` argument is exactly what makes that true.
    sendWithId: (id, payload) => realTransport.send('message.send', payload, id).ack,
  };

  // ---------------------------------------------------------------------
  // 7. MessageController <-> SendQueue. See the file header, pattern 1 —
  //    explicit type annotations on both `const`s are load-bearing, not
  //    decoration: removing either reintroduces TS7022.
  // ---------------------------------------------------------------------
  let queueRestored: Promise<unknown> = Promise.resolve();

  const messageController: MessageController = new MessageController({
    store,
    enqueue: async (sessionId, payload) => {
      // A send attempted before the persisted queue has been read would
      // jump the FIFO order SendQueue.restore()'s own doc requires (§9.2) —
      // `createChatClient` is synchronous (§6.1), so restore is necessarily
      // still in flight for whatever a caller does in the same tick.
      await queueRestored;
      return queue.enqueue(sessionId, payload);
    },
    sender: resolveLocalSender,
    // The SAME counter every switch step re-checks. It is the one thing an
    // id comparison cannot express: a read ISSUED for the session on screen,
    // resolving after a switch has begun but before its target has landed,
    // still matches `ChatState.session?.id` — and would write a transcript
    // into a conversation the customer has already left behind. See
    // `MessageControllerOptions.generation`.
    generation: () => switchEpoch,
    history: config.history,
    uploader: config.uploader ?? UNCONFIGURED_UPLOADER,
    ...(config.pageSize === undefined ? {} : { pageSize: config.pageSize }),
  });
  messageControllerRef = messageController;

  const queue: SendQueue = new SendQueue({
    storage: queueStorage,
    transport: queueTransport,
    onAck: messageController.onAck,
    onFailed: messageController.onFailed,
    // Defence in depth for the same hazard the wire `sessionId` addresses:
    // never write a frame for a session this connection is not joined to. The
    // wire field is optional, so a server that predates it silently files an
    // addressed send under the current join — only not sending guards that.
    joinedSession: () => joinedSessionId,
    ...(now === undefined ? {} : { now }),
    ...(config.queueRetention === undefined ? {} : { retention: config.queueRetention }),
  });

  // §15's acceptance criterion: a message sent while offline "survives a
  // simulated reload via the StorageAdapter". SendQueue.restore() reloads
  // the durable *entries*, but nothing re-applies them as optimistic
  // ChatMessages — messages/controller.ts's own doc says as much:
  // `QueuedSend` "is also the durable record of the optimistic message ...
  // a binding that reloads mid-send rebuilds what the user sees from these
  // entries". On a genuinely fresh process (a real reload, not just a
  // dropped socket) `ChatState.messages` starts empty, so without this a
  // restored entry's eventual ack/failure would find nothing to patch —
  // `MessageController#patch` returns false, the outcome is stashed in
  // `#settledEarly`, and `messageAck`/`sendFailed` never fires, because
  // `#settledEarly` exists for a narrow same-call race, not for surviving a
  // reload. Rehydrating here, before `flush()` can deliver anything, is what
  // makes the later real ack/failure land on an existing message instead.
  function rehydrateQueuedMessages(pending: readonly QueuedSend[]): void {
    if (pending.length === 0) return;

    // Queued sends are always outgoing, so the current localSender is the
    // right identity to rehydrate under — a page reload does not change who
    // the logged-in user is.
    const { senderId, senderType } = resolveLocalSender();

    let messages = store.getState().messages;
    for (const entry of pending) {
      const { payload } = entry;
      const message: ChatMessage = {
        id: entry.id,
        sessionId: entry.sessionId,
        senderId,
        senderType,
        type: payload.type,
        content: payload.content,
        createdAt: new Date(entry.enqueuedAt).toISOString(),
        delivery: { state: 'queued' },
        ...(payload.replyToMessageId === undefined ? {} : { replyToMessageId: payload.replyToMessageId }),
        ...(payload.attachment === undefined ? {} : { attachment: payload.attachment }),
        ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
      };
      messages = upsertMessage(messages, message);
    }
    store.setState({ messages });

    // Emitted after the batch is applied (not per-insert), so a listener
    // that reads `getState()` from inside the handler sees every rehydrated
    // message already in the list, matching how §6.5 describes `message` as
    // "applied to state" before it is announced.
    for (const entry of pending) {
      const rehydrated = messages.find((message) => message.id === entry.id);
      if (rehydrated !== undefined) store.emit('message', rehydrated);
    }
  }

  queueRestored = queue.restore().then(
    (report) => {
      rehydrateQueuedMessages(queue.pending());
      // restore() does not itself flush — if a connection raced ahead of
      // restore and is already live, nothing would otherwise drain what was
      // just recovered from disk until the next `connected`/`enqueue`.
      // Through the funnel, not `queue.flush()` directly: this path is
      // reachable mid-connection, which is precisely when the session the
      // entries would be delivered into is still being decided.
      void flushQueue();
      return report;
    },
    (error: unknown) => {
      // SendQueue.restore()'s contract: a storage read fault propagates and
      // is "emphatically not treated as an empty queue". Surfaced as a
      // ChatError instead of an unhandled rejection, and re-thrown so a
      // `sendMessage()` call awaiting `queueRestored` still sees the
      // failure — a message typed before recovery must not silently render
      // as queued when it is not.
      const chatError: ChatError = {
        source: 'transport',
        code: null,
        message: 'failed to restore the offline send queue from storage',
        retryable: false,
      };
      store.setState({ lastError: chatError });
      store.emit('error', chatError);
      throw error;
    },
  );

  // §8.4's "the queue flushes in FIFO order on reconnect" is wired at the
  // BOTTOM of this file, in the one `connected` subscription that also
  // restores the customer's session — see `flushQueue`. It deliberately does
  // not have a subscription of its own here: `connected` handlers run in
  // registration order, so a flush registered at this point would run BEFORE
  // the session restore and deliver into whichever session the server
  // happened to resolve.

  // presence.ts's `reset()` doc: "Called on disconnect: presence learned
  // over a socket that is now gone is not evidence of anything." Nothing in
  // connection/ calls it — `disconnected` only fires for a transport-caused
  // drop (`#handleClose` discards `cause: 'local'` before emitting it), so
  // an explicit `client.disconnect()` additionally calls `reset()` directly
  // below.
  store.on('disconnected', () => {
    presenceCoordinator.reset();
  });

  /**
   * Reports a `sessionActions` failure that the server nonetheless ACTED on.
   *
   * `reopenSession`/`closeSession` return the full `ChatSession` that replaces
   * `ChatState.session`. An adapter may need more than one round trip to
   * produce it (the REST one does: a mutating POST, then a read of the full
   * session), which opens a window where the change has already been applied
   * but the value describing it never arrived. The promise rejects, so
   * `setState` below never runs — and `ChatState.session` then describes a
   * session that no longer exists in that form, with nothing in the state
   * saying so.
   *
   * Core cannot repair that: it does not know the new status, and for a reopen
   * it does not even know which session the server settled on. What it can do
   * is refuse to let the staleness be silent, which is what this does.
   *
   * The condition is recognized STRUCTURALLY, by a `sessionMutationApplied`
   * flag on the error, because `SessionActions` is a seam core does not
   * implement — see its documentation in ./types.ts. Any adapter can raise it;
   * core imports nothing to check for it.
   *
   * The error is re-thrown by the caller regardless. This only adds the
   * `lastError`/`error` signal, exactly as the queue-restore fault above does.
   */
  function reportIfSessionChangedAnyway(error: unknown): void {
    const applied =
      typeof error === 'object' &&
      error !== null &&
      (error as { sessionMutationApplied?: unknown }).sessionMutationApplied === true;
    if (!applied) return;

    // Fixed text, never the adapter's: its message can carry a signed URL (§14).
    const chatError: ChatError = {
      source: 'transport',
      code: null,
      message: 'the session changed, but the updated session could not be read back',
      retryable: true,
    };
    store.setState({ lastError: chatError });
    store.emit('error', chatError);
  }

  /**
   * Sends `session.join` and reports a REJECTED ack through
   * `lastError`/`error` (§6.4) — the fire-and-forget form, backing the raw
   * `ChatClient.joinSession`.
   *
   * `switchSession` deliberately does NOT go through here any more. It needs
   * to settle on the ack rather than glance at it, and it needs every other
   * non-`acked` outcome too (a `disconnected` send writes nothing at all),
   * so it uses `joinSessionAwaited` below. The two are no longer one
   * operation under two names: `joinSession` is the protocol frame,
   * `switchSession` is the session replacement built on top of it. See
   * `ChatClient.switchSession`'s doc for the full contract.
   *
   * A successful join is not reported here — it is observed the normal way,
   * through the `session.updated`/`connection.ack` snapshot `dispatchFrame`
   * above already applies to `ChatState.session`. Previously (pre-T10)
   * `joinSession` discarded `realTransport.send`'s returned ack outright, so
   * a join the server's ownership check refused (v2/handlers.ts) vanished
   * with no signal at all — this is what closes that gap.
   */
  function joinSessionFrame(sessionId: string): void {
    const { ack } = realTransport.send('session.join', { sessionId });
    void ack.then((outcome) => {
      // Only an ACK is the server saying `conn.sessionId` moved. A refusal, a
      // timeout and a `disconnected` write all leave the connection exactly
      // where it was, so the queue must go on treating the old session as the
      // joined one.
      if (outcome.status === 'acked') {
        joinedSessionId = sessionId;
        return;
      }
      if (outcome.status !== 'rejected') return;
      reportChatError(toChatError(outcome.error));
    });
  }

  /** Writes `error` to `lastError` and emits it — the one §6.4 reporting path. */
  function reportChatError(error: ChatError): ChatError {
    store.setState({ lastError: error });
    store.emit('error', error);
    return error;
  }

  // ---------------------------------------------------------------------
  // 7b. Session replacement — the machinery behind switchSession() and the
  //     reload path. See ChatClient.switchSession's doc for the contract.
  // ---------------------------------------------------------------------

  const scheduleTimer: ScheduleTimer = schedule ?? systemTimers;

  /**
   * Which switch is the current one.
   *
   * Two picker clicks in quick succession start two switches over one socket,
   * and both will eventually get their ack and their page. Without this the
   * loser's page is prepended into the winner's transcript — `prependPage`
   * cannot catch that, it dedupes by id and two sessions never share ids.
   * Every step that writes to state re-checks its own epoch, so a superseded
   * switch stops at the first checkpoint it reaches instead of racing.
   */
  let switchEpoch = 0;

  /**
   * Resolves once the session this connection will actually be in has been
   * decided — i.e. once `restoreSelectionAndSeed` has finished re-joining the
   * customer's remembered session, or established that there is nothing to
   * re-join.
   *
   * A queued send now carries the session it was composed in
   * (`MessageSendPayload.sessionId`), so a flush can no longer MISFILE one.
   * What it can still do is put it on a wire whose join the server has not
   * moved yet: `SendQueueOptions.joinedSession` scopes the drain to
   * `joinedSessionId`, and between `connection.ack` and the re-join that
   * value names the session the server resolved on its own, not the one the
   * customer chose. Gating the drain on the join DECISION is what keeps the
   * two guards from being needed one at a time.
   *
   * Starts resolved: with no connection there is no session to get wrong, and
   * a flush against a closed socket is a no-op anyway.
   */
  let selectionRestored: Promise<void> = Promise.resolve();

  /**
   * How THIS connection's session was settled — resolved once
   * `restoreSelectionAndSeed` has finished, rejected with the
   * `SessionSwitchError` a refused/timed-out re-join produced.
   *
   * The handle `switchToSession` awaits. Armed synchronously by the
   * `connected` handler, which `ConnectionController` emits BEFORE it resolves
   * `connect()` — so a switch that reads this the instant its `connect()`
   * settles gets its own connection's promise, not the previous one's.
   *
   * Starts resolved: with no connection, nothing is pending.
   */
  let sessionSettled: Promise<void> = Promise.resolve();

  /**
   * The ONE place `queue.flush()` is called from. Nothing in this file may
   * call `queue.flush()` directly — the ordering above is the whole point,
   * and a second call site is how it gets reintroduced.
   */
  async function flushQueue(): Promise<void> {
    await selectionRestored;
    await queue.flush();
  }

  /**
   * Every projection of "the session I am in", as a cleared `setState` patch.
   *
   * Returned rather than written, so it can be MERGED into the same `setState`
   * that installs the new session — see the commit in `dispatchFrame`. A split
   * write is exactly the defect this design exists to remove: `ChatStore`
   * notifies per batch, but `getState()` is read synchronously by anything
   * reacting to an event, so two writes leave an instant in which one
   * conversation's id is readable against another's transcript.
   *
   * `pagination.loadingMore` is cleared with the rest, deliberately. A read
   * still in flight for the session being replaced no longer owns anything —
   * and leaving its latch set would make the very next seed a silent no-op.
   * The in-flight read cannot then clobber the seed either: it is superseded
   * by load token, and `MessageController#discard` returns silently for a
   * superseded read without touching `pagination`.
   *
   * `pastSessions` is deliberately preserved: it is a list *about* other
   * sessions, not state *of* this one. So is `session` — this patch is only
   * ever merged with an explicit `session` by its callers.
   */
  function perSessionReset(): Partial<ChatState> {
    return {
      messages: [],
      typing: { isTyping: false },
      unreadCount: 0,
      pagination: { hasMore: false, loadingMore: false, initialLoaded: false },
      uploading: false,
      // Keyed by participantId, not by session, which is exactly why they
      // have to go explicitly: the same agent picking up the other
      // conversation would otherwise arrive with a read watermark earned in
      // this one, marking messages read that they have never seen.
      readWatermarks: {},
      deliveredWatermarks: {},
      presence: {},
      lastError: null,
    };
  }

  /**
   * THE COMMIT: identity and data move in ONE write, or not at all.
   *
   * The invariant the whole session-replacement design rests on.
   * `ChatState.session` is the only place the identity of the current
   * conversation lives, this function is the only thing that changes it, and
   * every per-session projection is cleared in the SAME `setState` that
   * changes it. So there is no instant — not one synchronous read, not one
   * subscriber notification — in which one conversation's id is readable
   * against another's transcript, watermarks, presence or pagination.
   *
   * Everything downstream falls out of that rather than being guarded for:
   *   • a bare `loadMore()` resolves both its target and its `before` cursor
   *     from the store, and the two can no longer disagree;
   *   • a read whose session was replaced is stale by a plain id comparison,
   *     with no second "committed target" to consult;
   *   • `loadingMore` is released here too, so the seed that follows a commit
   *     is never blocked by a read belonging to the session that just left.
   *
   * Three callers, and they are exhaustive: the `connection.ack`/
   * `session.updated` snapshot applier, and the two `sessionActions` results
   * (`reopenSession` can name a different session than the one on screen).
   * `startNewSession` is the fourth writer of `session` and the one exception,
   * because it writes `null` — there genuinely is no session until the server
   * mints one — and it merges the same reset into that write.
   *
   * A snapshot for the session ALREADY on screen is a refresh, not a
   * replacement, and clears nothing.
   *
   * `agent.joined`/`agent.left`/`ticket.linked`/`session.closed` also write
   * `session`, and are deliberately NOT routed through here: each patches the
   * session already in state and none of them can change its id (see
   * client/session.ts, where every one of them no-ops on a mismatched id).
   */
  function commitSession(next: ChatSession, seededByCaller = false): void {
    const previous = store.getState().session;
    const replacing = previous !== null && previous.id !== next.id;
    store.setState(replacing ? { session: next, ...perSessionReset() } : { session: next });
    if (replacing && !seededByCaller) seedReplacedSession(next.id);
  }

  /**
   * Page one for a session that has just REPLACED the one on screen, on every
   * path that has no seed of its own.
   *
   * The commit clears the transcript — that is the whole point of it — so a
   * replacement that nothing then seeds is a permanently blank pane: no rows,
   * no history request, and `pagination.initialLoaded` false, so not even an
   * empty state. That was reachable in two ordinary ways, neither of which
   * goes anywhere near `switchSession`:
   *
   *   - a `session.updated` the server volunteers OUTSIDE the `connected`
   *     handler — exactly what the documented public `joinSession` produces,
   *     since it writes the frame and returns;
   *   - `reopenSession`, which takes an explicit id and may name a session
   *     other than the one on screen.
   *
   * Seeding from the commit itself is what makes "a committed session always
   * has its history read" true by construction rather than per caller.
   *
   * Two callers already own their own seed and say so, rather than being
   * seeded twice:
   *
   *   - a SWITCH, flagged by `switchTarget` being non-null. That is exact
   *     rather than approximate — it is non-null for precisely the span of a
   *     switch — and `joinAndSeed` issues page one by explicit id and AWAITS
   *     it, so the promise a picker holds does not resolve before the
   *     transcript is on screen.
   *   - `connection.ack`, via `commitSession`'s `seededByCaller`. Every
   *     handshake is followed by the `connected` handler, and
   *     `restoreSelectionAndSeed` ends in `if (!initialLoaded) loadMore()` —
   *     which this commit has just re-armed by clearing `initialLoaded`.
   *
   * Neither would double-REQUEST if seeded here as well (`loadMore`'s
   * `loadingMore` latch refuses the second), but both would have their own
   * awaited read turned into an early return against a read they do not own.
   */
  function seedReplacedSession(sessionId: string): void {
    if (switchTarget !== null) return;
    // `loadMore` reports its own failures through `lastError`/`error` (§6.4)
    // and never rejects for a target it was handed explicitly; the catch is
    // for the impossible case only, so a seed can never surface as an
    // unhandled rejection in the host page.
    void messageController.loadMore(sessionId).catch(() => undefined);
  }

  /** Reads the persisted selected-session id. A storage fault reads as "none". */
  async function readSelectedSession(): Promise<string | null> {
    try {
      const value = await queueStorage.get(SELECTED_SESSION_KEY);
      return value === null || value === '' ? null : value;
    } catch {
      // Never fatal: not knowing which session was chosen is exactly the
      // pre-fix behaviour, so falling back to the server's choice is strictly
      // no worse than not having persisted at all.
      return null;
    }
  }

  /** Records the session the user is in, so a reload comes back to it. */
  async function rememberSelectedSession(sessionId: string): Promise<void> {
    try {
      await queueStorage.set(SELECTED_SESSION_KEY, sessionId);
    } catch {
      // A failed write costs the reload behaviour, nothing else. It must not
      // fail a switch that has already succeeded on the wire.
    }
  }

  /**
   * Records the session this connection actually established, for a customer
   * who never picked one — the ordinary path, and the one bug 2's first fix
   * left out.
   *
   * Without this, only an explicit `switchSession`/`startNewSession` ever
   * persisted anything, so "come back to the conversation I was in" worked
   * only after an explicit pick. A customer who simply chats in the session
   * the server handed them had nothing stored, and once that session went
   * CLOSED/RESOLVED the next connection's server-side resolution — most
   * recently updated, ACTIVE only — landed them somewhere else entirely.
   *
   * **A session that is already finished is not recorded.** That is the
   * deliberate resolution of the two hazards pulling against each other here:
   *
   *   - Recording it would override the server's own active-session
   *     resolution on the next connection with a conversation that cannot be
   *     continued — pinning the customer to a dead chat is strictly worse
   *     than the resolution this was meant to improve on, because the server
   *     at least only ever resolves live sessions.
   *   - Not recording it costs nothing: the client is in that session for as
   *     long as this connection lasts, and with nothing stored the next
   *     connection simply falls back to the server's answer, which is the
   *     pre-fix behaviour.
   *
   * An EXPLICIT pick is the opposite case and keeps its own rule: a customer
   * who opens a resolved conversation out of a picker meant it, so
   * `switchToSession` records it whatever its status. The implicit record here
   * only ever says "keep me where I already am".
   *
   * A recording made while the session was live still stands after it closes,
   * until either the `session.closed` push clears it (`dispatchFrame`) or the
   * server refuses the re-join (`restoreSelectionAndSeed`). Both of those are
   * evidence; a status read at connect time is the only evidence available
   * here, and it is used.
   */
  async function rememberEstablishedSession(): Promise<void> {
    const session = store.getState().session;
    if (session === null) return;
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) return;
    await rememberSelectedSession(session.id);
  }

  /**
   * Forgets the persisted selection, optionally only if it still names
   * `sessionId` — so a stale close for a session already switched away from
   * cannot clear the selection the customer just made.
   */
  async function forgetSelectedSession(sessionId?: string): Promise<void> {
    try {
      if (sessionId !== undefined && (await readSelectedSession()) !== sessionId) return;
      await queueStorage.remove(SELECTED_SESSION_KEY);
    } catch {
      // Same reasoning as rememberSelectedSession.
    }
  }

  /**
   * Sends `session.join` and settles on the ack, rather than dropping it.
   *
   * Every non-`acked` outcome is a real failure a caller can act on, and all
   * three were previously silent:
   *
   *   - `rejected` — the server's ownership check refused the session;
   *   - `disconnected` — `WebSocketTransport.send` resolves this WITHOUT
   *     writing anything when the socket is closed (transport/transport.ts),
   *     so the join simply never happened;
   *   - `timeout` — acked by nobody within the transport's own window.
   *
   * All of them are reported through `lastError`/`error` (§6.4) *and* thrown,
   * so a picker awaiting the switch and a subscriber watching state are told
   * the same thing.
   */
  async function joinSessionAwaited(sessionId: string): Promise<void> {
    const { ack } = realTransport.send('session.join', { sessionId });
    const outcome = await ack;
    if (outcome.status === 'acked') {
      // The server has moved `conn.sessionId`. Recorded here and nowhere else
      // on this path, so a refusal cannot be mistaken for a join — see
      // `joinedSessionId`.
      joinedSessionId = sessionId;
      return;
    }

    const error =
      outcome.status === 'rejected'
        ? toChatError(outcome.error)
        : ({
            source: 'transport',
            code: null,
            message:
              outcome.status === 'disconnected'
                ? 'session.join was not sent: the socket is not open'
                : 'session.join was not acknowledged in time',
            retryable: true,
          } satisfies ChatError);

    throw new SessionSwitchError(sessionId, reportChatError(error));
  }

  /**
   * Makes the SOCKET's join and the STORE's session name the same
   * conversation again, after a join that did not take.
   *
   * The divergence is real and it is silent. A switch tears the socket down;
   * the fresh `connection.hello` carries no session id, so the server resolves
   * the customer's most-recently-updated ACTIVE session on its own and the
   * `connection.ack` routinely names a THIRD conversation — which
   * `switchTarget` then (correctly) refuses to paint. If the explicit
   * `session.join` that was supposed to correct that is REFUSED, nothing moves
   * `joinedSessionId` — also correct, and by itself the whole bug: the socket
   * is left joined to the third session while `ChatState` still describes the
   * one being left, and neither side is wrong on its own terms.
   *
   * What that costs the customer is everything. `SendQueueOptions.joinedSession`
   * scopes the drain to `joinedSessionId`, and every entry is stamped with the
   * session it was composed in, so each message they type is durably queued,
   * correctly addressed — and never sent. `connectionState` reads `connected`,
   * the composer clears, the bubble says "queued", and no error is raised
   * anywhere. They are muted with no way to find out.
   *
   * So the disagreement is closed rather than narrowed. One `session.join` for
   * the session actually on screen puts the socket back where the customer is
   * looking, and the queue drains into it; the failed switch is still reported
   * to whoever asked for it, unchanged.
   *
   * If even that is refused, this connection cannot reach any conversation the
   * client is able to show. Rather than leave a session on screen that cannot
   * be sent to, the session is cleared — `sendMessage` then fails loudly with
   * `NoActiveSessionError` instead of queueing into silence, `lastError` says
   * what happened, and a binding has an empty state to render. The next
   * `connection.ack` repaints from whatever the server resolves.
   */
  async function reconcileJoinedSession(): Promise<void> {
    const onScreen = store.getState().session?.id ?? null;
    if (onScreen === joinedSessionId) return;

    if (onScreen !== null) {
      const { ack } = realTransport.send('session.join', { sessionId: onScreen });
      const outcome = await ack;
      if (outcome.status === 'acked') {
        joinedSessionId = onScreen;
        // Whatever the customer typed while the switch was failing is now
        // addressable. Through the funnel, never `queue.flush()` directly.
        void flushQueue();
        return;
      }
    }

    // In one write, for the same reason `commitSession` is: no subscriber may
    // observe a session id against another conversation's transcript.
    store.setState({ session: null, ...perSessionReset() });
    reportChatError({
      source: 'transport',
      code: null,
      message: 'this connection is not joined to a readable session; reconnect to continue',
      retryable: true,
    });
  }

  /**
   * Waits until `predicate()` holds, or the deadline passes.
   *
   * Subscription-based rather than a poll, and re-checked up front, because
   * the state it is waiting on may already have been written by the time this
   * is called — a server that pushes `session.updated` before its own ack is
   * flushed is entirely legal.
   */
  function awaitState(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        cancelTimer();
        unsubscribe?.();
        resolve(value);
      };

      const cancelTimer = scheduleTimer(() => {
        finish(false);
      }, timeoutMs);

      unsubscribe = store.subscribe(() => {
        if (predicate()) finish(true);
      });

      // The predicate may have flipped between the check above and the
      // subscription being registered.
      if (predicate()) finish(true);
    });
  }

  /**
   * Puts THIS connection into `target` and gets its first page on screen.
   *
   * The RE-ESTABLISH half, shared verbatim by the two callers that need it:
   * `switchToSession` (after its teardown has opened a fresh socket) and the
   * reconnect path (`restoreSelectionAndSeed`). Both face the identical
   * problem — `connection.hello` carries no session id (protocol/frames.ts),
   * so the server resolves the customer's most-recently-updated ACTIVE
   * session, and a conversation picked out of a picker is usually CLOSED or
   * RESOLVED and therefore not a candidate. One explicit `session.join` is
   * what corrects that, and it is the ONLY thing that does.
   *
   * Nothing is in flight across this. The socket is new (switch path) or has
   * just handshaked (reconnect path), `flushQueue` is still gated behind
   * `selectionRestored`, and no history read has been issued yet — the seed
   * below is deliberately the first one. That is what makes a single
   * `session.join` sufficient where three rounds of read-side guards were not:
   * there is no concurrent reader to guard.
   */
  async function joinAndSeed(target: string, onJoinDecided: () => void): Promise<void> {
    const epoch = switchEpoch;
    const stale = (): boolean => epoch !== switchEpoch;

    switchTarget = target;
    try {
      // The resume anchor is a position in a PER-SESSION history
      // (connection/resume.ts) and this connection's own `connection.ack` has
      // just re-armed it with the seq of the session the SERVER resolved.
      // `target` numbers its frames independently, so left in place the first
      // live frame after the join reads as a seq jump and is reported to the
      // app as a hole in history — and the next `connection.hello` asks to
      // resume from a seq this session has never reached, which the v2
      // endpoint refuses NON-RETRYABLY, stranding the client in `suspended`.
      connectionController.forgetResumeAnchor();

      // Settled, not glanced at: a refusal, a timeout and a `disconnected`
      // write are all real failures a picker can act on. See
      // `joinSessionAwaited`.
      await joinSessionAwaited(target);

      // The join is DECIDED — acked, `joinedSessionId` moved — and that is the
      // only fact a queued send was ever waiting on. Released here rather than
      // when this function returns because everything below is a history read:
      // `loadMore` never rejects and never times out, so a hung history
      // endpoint would otherwise strand the offline queue for the rest of the
      // process.
      onJoinDecided();
      // Through the funnel, never `queue.flush()` directly.
      void flushQueue();

      if (stale()) return;

      // The ack is `EmptyAckData` — `{ ok: true }` with no payload — so it
      // does NOT mean `ChatState.session` has moved. The snapshot arrives as a
      // separate `session.updated` push the server volunteers after it
      // (v2/handlers.ts acks, loads the snapshot, then pushes), and applying
      // THAT is the commit: identity and transcript together, in one write.
      const arrived = await awaitState(
        () => store.getState().session?.id === target || stale(),
        SESSION_SNAPSHOT_TIMEOUT_MS,
      );
      if (stale()) return;
      if (!arrived) {
        throw new SessionSwitchError(
          target,
          reportChatError({
            source: 'transport',
            code: null,
            message: 'the session was joined but its snapshot never arrived',
            retryable: true,
          }),
        );
      }

      // Explicitly by id, never via `ChatState.session`: page one must be this
      // session's even if another frame moved `session` in between. Reached
      // only AFTER the commit, so it writes into an empty, already-reset
      // transcript that belongs to `target` — never into the outgoing one.
      await messageController.loadMore(target);
    } catch (error) {
      // Every failure that reaches here left the socket somewhere other than
      // where the store says it is: a REFUSED join never moved
      // `joinedSessionId` off the session this connection's handshake
      // resolved, and an ACKED join whose snapshot never arrived moved it to
      // `target` while the screen still shows the session being left. Both are
      // a silent mute — see `reconcileJoinedSession`.
      //
      // Not when superseded: a newer switch owns the socket and is already
      // moving it, and a join written from under it would fight that.
      if (!stale()) await reconcileJoinedSession();
      throw error;
    } finally {
      // Only if this call still owns the slot: a newer switch has already
      // taken it, and clearing it here would let a third session repaint the
      // screen underneath that newer switch.
      if (switchTarget === target) switchTarget = null;
    }
  }

  /**
   * The switch `performSwitch` is running, or `null` when none is.
   *
   * Held so a repeat click for the SAME target can join the switch already
   * under way instead of starting a second one. Set synchronously by
   * `switchToSession`, which is what makes it visible to a double-click
   * landing in the same tick.
   */
  let switchInFlight: Promise<void> | null = null;

  /**
   * `switchSession()` — the picker's entry point, and the two clicks it has to
   * tell apart before {@link performSwitch} does any work.
   *
   * **The same target, again.** A double-click, or an impatient second click
   * on a row already opening. It joins the switch in flight rather than
   * restarting it: `performSwitch` begins by tearing the socket down, so
   * re-entering it would kill the connection the first click had just opened
   * and pay a second handshake to arrive exactly where it was already going.
   * Both callers settle on the same outcome, which is also the honest answer —
   * the second click asked for nothing the first did not.
   *
   * **The session already on screen.** Ordinarily a genuine no-op: no frame,
   * no teardown, no refetch. But NOT while a switch to a different session is
   * in flight, and that exception is the whole of this gate. The screen still
   * shows the outgoing session for the entire switch — by design, that is what
   * makes the commit atomic — so "the session on screen" is precisely the one
   * a customer changing their mind clicks to get BACK to. Read as a no-op, the
   * click did nothing and the switch it was cancelling went on to land,
   * delivering the customer to the conversation their last click asked to stay
   * away from: neither click's destination.
   *
   * Cancelling it in place is not available. By the time the click arrives the
   * teardown has already happened — the old socket is gone and the customer's
   * choice is already persisted — so the only way back to the session on
   * screen is the same full switch every other row gets. It supersedes the
   * in-flight one through `switchEpoch` exactly as a click on a third row
   * would, and the LAST click wins however fast they alternate.
   */
  function switchToSession(sessionId: string): Promise<void> {
    // Already going there. `switchTarget` is set synchronously by
    // `performSwitch`, so this sees a switch started in this very tick.
    if (switchTarget === sessionId && switchInFlight !== null) return switchInFlight;

    // Already there, and nothing is moving us anywhere else.
    if (switchTarget === null && store.getState().session?.id === sessionId) return Promise.resolve();

    const run = performSwitch(sessionId);
    switchInFlight = run;
    // A coalescing caller may attach later; this one handler means a rejected
    // switch is never an `unhandledrejection` in the host page in the window
    // before it does. It does not change what an awaiting caller observes.
    void run.catch(() => undefined);
    return run.finally(() => {
      // Only if this run still owns the slot — a newer switch has its own.
      if (switchInFlight === run) switchInFlight = null;
    });
  }

  /**
   * `switchSession()` — TEARDOWN, then re-establish.
   *
   * Deliberately built on `startNewSession`'s shape rather than transitioning
   * in place, because the in-place version could not be made correct by
   * guarding: it committed the client to the incoming session while
   * `ChatState` still described the outgoing one, and every read issued in
   * that interval had to be taught, separately, that the store was lying.
   *
   * Here there is no such interval. The outgoing session stays whole and
   * self-consistent — identity, transcript, header, composer, queue — for the
   * entire operation, and is replaced by the incoming one in the single write
   * that applies its snapshot (see `dispatchFrame`'s commit). The state
   * machine has exactly two states, before and after, and no observer can see
   * anything else.
   *
   * The teardown itself is `startNewSession`'s, in the same order and for the
   * same reasons, minus `requestNewSession()` (that one asks the server to
   * MINT a session; this one names an existing one) and minus the store write
   * (that one genuinely has no session until the server answers; this one
   * still has the session the customer is looking at).
   *
   * Cost: one extra round trip per switch — a handshake the in-place version
   * did not pay. Accepted deliberately in exchange for correctness by
   * construction.
   */
  async function performSwitch(sessionId: string): Promise<void> {
    const epoch = (switchEpoch += 1);
    const stale = (): boolean => epoch !== switchEpoch;

    // Committed from here: no snapshot for any OTHER session may repaint
    // `ChatState` while this runs (see `switchTarget`). The fresh connection
    // below is resolved by the server, so this is not hypothetical.
    switchTarget = sessionId;

    try {
      // ── 1. The socket, before anything else. Everything the old connection
      //    had in flight — an unanswered `session.join`, a live push for the
      //    outgoing session, a half-drained queue pump — dies with it, which
      //    is precisely what makes the single `session.join` below safe.
      connectionController.disconnect();

      // ── 2. Typing timers and presence are statements about *right now* over
      //    a socket that is gone.
      presenceCoordinator.reset();

      // ── 3. The anchor, so the next `connection.hello` reads as a first
      //    connection instead of asking to resume a history this client is
      //    about to stop reading. `joinAndSeed` drops it a second time, after
      //    the handshake re-arms it — see the note there.
      connectionController.forgetResumeAnchor();

      // ── 4. This connection is joined to nothing until the next
      //    `connection.ack` says otherwise, and the queue must not put a frame
      //    on a wire whose join it cannot name (SendQueueOptions.joinedSession).
      joinedSessionId = null;

      // ── 5. The outgoing session's queued sends are PRESERVED, not
      //    abandoned. This is the one place the rebuild deliberately reverses
      //    the old behaviour, and it is safe now for a reason that was not
      //    true when `abandonSession` was added here: every entry carries the
      //    session it was COMPOSED in, stamped on the wire as
      //    `MessageSendPayload.sessionId` and enforced independently by the
      //    queue's own `joinedSession` scoping, so an entry can no longer be
      //    misdelivered into the conversation being opened. What abandoning
      //    still cost was real: it failed the customer's own unsent words with
      //    `sessionClosed` for a session that had not closed, and
      //    `retryMessage` then refuses them for belonging to a session that is
      //    no longer current — the message becomes unrecoverable by any public
      //    call. Preserved, they wait (never on the wire, never lost), drain
      //    the moment that session is joined again, and are still bounded by
      //    §9.6 retention rather than kept forever.
      //
      //    `startNewSession` keeps `abandonSession` because there the session
      //    really is being ended (SWITCHED) and its sends really are dead.

      // ── 6. Persisted BEFORE the connect, because the `connected` handler is
      //    what performs the join: switching and reloading are then the SAME
      //    code path, not two implementations of one idea that drift. It also
      //    means a tab closed mid-switch comes back to the session the
      //    customer chose rather than to the one they were leaving.
      await rememberSelectedSession(sessionId);
      if (stale()) return;

      try {
        // Resolves on `connection.ack`. The controller emits `connected` —
        // and therefore arms `sessionSettled` below — synchronously BEFORE it
        // resolves this, so the promise read afterwards is this connection's.
        await connectionController.connect();
      } catch (error) {
        // A newer switch (or `startNewSession`, or an explicit
        // `client.disconnect()`) aborted this connect. The winner owns the
        // outcome; this one reports nothing and resolves quietly.
        if (stale()) return;
        throw new SessionSwitchError(
          sessionId,
          reportChatError({
            source: 'transport',
            code: null,
            message: `could not reconnect to open session "${sessionId}"`,
            retryable: true,
          }),
        );
      }
      if (stale()) return;

      // The `connected` handler's own promise for THIS connection: it rejects
      // with the `SessionSwitchError` the join produced, after it has already
      // put the fallback session's transcript on screen.
      try {
        await sessionSettled;
      } catch (error) {
        if (stale()) return;
        throw error;
      }
      if (stale()) return;

      // Belt and braces for the one outcome neither the ack nor the snapshot
      // wait can express: the handler decided there was nothing to join
      // because the store already named this session, and then something else
      // moved it. Cheap, and it means this promise never resolves against a
      // conversation other than the one asked for.
      if (store.getState().session?.id !== sessionId) {
        throw new SessionSwitchError(
          sessionId,
          reportChatError({
            source: 'transport',
            code: null,
            message: `the connection did not end up in session "${sessionId}"`,
            retryable: true,
          }),
        );
      }
    } finally {
      // `joinAndSeed` clears this on the ordinary path; this catches the ones
      // that never reach it (a connect that failed, a store that already
      // named the target). Guarded, so a newer switch keeps its own claim.
      if (switchTarget === sessionId) switchTarget = null;
    }
  }

  /**
   * On every `connected`, put the client back into the session the customer
   * actually chose, then make sure its first page is on screen.
   *
   * Both halves belong here rather than in a binding. Every binding needs
   * them, none of them can do the reset half (`ChatStore` exposes no
   * `setState`), and the widget's version — a once-ever latch on the
   * connection-state transition — could not re-arm for a switch and could not
   * survive a reconnect either.
   */
  async function restoreSelectionAndSeed(sessionDecided: () => void): Promise<void> {
    /** Whether a stored selection is still the one being honoured. */
    let honouringSelection = false;
    /**
     * The re-join failure, if there was one — re-thrown at the very end.
     *
     * Not thrown where it happens: the customer must still be left looking at
     * a real transcript (the fallback seed below), and only then is the
     * failure reported to whoever is awaiting it. `switchSession` awaits this
     * function's promise, so its caller learns that *this particular row* did
     * not open; the reconnect path does not await, and the `connected`
     * handler marks the rejection handled so a failed reload never lands an
     * `unhandledrejection` on the host page.
     */
    let failure: unknown = null;

    /**
     * This run belongs to ONE connection. A switch tears that connection down
     * and opens another, so a run left over from the previous one must not
     * write anything — least of all re-record the session it was resolving as
     * "the session to come back to", which would silently overwrite the choice
     * the switch just persisted and send the reconnect straight back into the
     * conversation the customer asked to leave.
     */
    const epoch = switchEpoch;
    const stale = (): boolean => epoch !== switchEpoch;

    try {
      const selected = await readSelectedSession();
      honouringSelection = selected !== null;

      // Compared against the SOCKET's join, never against `ChatState.session`.
      // The two are not interchangeable here and the difference is a silent
      // mute: `connection.hello` carries no session id, so this connection's
      // `connection.ack` names whatever the server resolved — and while a
      // switch is in flight `switchTarget` deliberately refuses to paint that
      // snapshot, leaving the store still describing the session being left.
      // Asking the store therefore reads "we are already in the session that
      // was chosen" for a connection that is joined to a third one, skips the
      // re-join, and hands back a client whose every send is scoped away by
      // `SendQueueOptions.joinedSession` and queues forever under
      // `connectionState: 'connected'`. `joinedSessionId` is the only value
      // that answers "which session is this socket in", and it is the one that
      // decides whether a join is owed.
      if (selected !== null && selected !== joinedSessionId) {
        try {
          // The gate is handed to the join itself, so it opens on the JOIN
          // DECISION rather than when the whole restore finishes — the
          // page-one read that follows is unbounded.
          await joinAndSeed(selected, sessionDecided);
          return;
        } catch (error) {
          failure = error;
          // Already reported through lastError/error. The session the ack gave
          // us is still there, so fall through and seed THAT rather than
          // leaving the customer with a blank screen.
          //
          // Only a REJECTED join forgets the selection: that is the server
          // saying this session is not available to this customer, and
          // retrying it on every reconnect would be a permanent loop. A
          // transport failure — the socket dropped mid-restore — says nothing
          // about the session, and erasing the customer's choice over a flaky
          // network would turn a momentary blip into a lost conversation.
          //
          // Either way the selection is no longer being honoured, so nothing
          // below may quietly record the fallback session in its place: the
          // customer's choice is REPLACED only by another choice, never by
          // whichever conversation a failed restore happened to leave us in.
          // A refusal has already erased it, so the next ordinary connect
          // records what the server resolves — one connection later, and
          // deliberately.
          if (error instanceof SessionSwitchError && error.cause.source === 'protocol') {
            await forgetSelectedSession(selected);
          }
        }
      }
    } finally {
      // The session is decided: either `joinAndSeed` re-joined the
      // remembered one, or this connection stays in the one the server
      // resolved. Queued sends can be addressed now, and not one moment
      // earlier — see `selectionRestored`. In a `finally` so that no failure
      // path can strand the queue behind a gate that never opens.
      //
      // On the join path this is a BACKSTOP: `joinAndSeed` was handed the
      // same resolver and already called it the moment the join was decided,
      // and resolving a promise twice is a no-op. The paths that reach only
      // here are the ones with no join at all (no stored selection, no session
      // yet, or a storage read that threw).
      //
      // Opening the gate is deliberately NOT the same as flushing into
      // whatever session happens to be current. What actually goes on the wire
      // is decided by `joinedSessionId` (see SendQueueOptions.joinedSession),
      // which a REFUSED join does not move — so a refusal opens the gate and
      // the drain still finds nothing it is allowed to send.
      //
      // Each run resolves the gate IT was handed, never `the current gate`: a
      // reconnect arms a second one while the first restore may still be in
      // flight, and a shared handle would let the older run open the newer
      // run's gate — reintroducing the very ordering this exists to enforce.
      sessionDecided();
    }

    // Superseded by a newer connection: everything below is a write, and the
    // run that owns the current connection is already doing it.
    if (stale()) return;

    // `initialLoaded` — not `messages.length` — is what makes this safe to run
    // on every reconnect: it will not re-request page one under a user who
    // has already scrolled back, and it is not fooled by a list that is
    // non-empty because the offline queue was rehydrated from storage.
    if (!store.getState().pagination.initialLoaded) {
      await messageController.loadMore().catch(() => undefined);
    }

    // Bug 2's other half: with no pick anywhere, the session this connection
    // established is still the one to come back to. See
    // `rememberEstablishedSession` for why a finished session is not.
    //
    // `honouringSelection` stays true even when the re-join FAILED, which is
    // the point: the customer's choice is replaced only by another choice,
    // never by whichever conversation a failed restore happened to leave us
    // in. A refusal has already erased the record; a transport failure keeps
    // it and retries on the next connect.
    if (!honouringSelection && !stale()) await rememberEstablishedSession();

    // Last, so the fallback transcript is on screen before anyone hears about
    // the failure.
    if (failure !== null) throw failure;
  }

  // Ordering inside `connection.ack` is already correct and needs no change:
  // ConnectionController applies the session snapshot and the replay BEFORE
  // moving the machine to `connected` (connection/controller.ts), so
  // `ChatState.session` is populated by the time this runs.
  //
  // This is also the file's ONLY `connected` subscription, which is what
  // makes the restore-before-flush ordering structural rather than a matter
  // of which `store.on('connected')` call happens to appear first: the gate is
  // armed synchronously here, before anything can await it, and `flushQueue`
  // is the only way to reach `queue.flush()`.
  store.on('connected', () => {
    let sessionDecided!: () => void;
    selectionRestored = new Promise<void>((resolve) => {
      sessionDecided = resolve;
    });
    const settled = restoreSelectionAndSeed(sessionDecided);
    // Marked handled here, once, so a reconnect whose re-join was refused
    // never surfaces as an `unhandledrejection` in the host page. Attaching a
    // handler does not change what an awaiting `switchSession` observes.
    void settled.catch(() => undefined);
    sessionSettled = settled;
    void flushQueue();
  });

  // ---------------------------------------------------------------------
  // 7c. Identify — the logged-in user's CRM profile, pushed once through the
  //     injected `identitySync` seam. Core still makes no HTTP call of its
  //     own; this only decides WHEN the host's transport is invoked.
  //
  // On the first `connect()`, and emphatically NOT at construction. Every
  // binding documents `createChatClient` as doing zero I/O
  // (packages/react/src/context.tsx, packages/vue/src/context.ts,
  // packages/js/src/create.ts, and this package's own barrel doc), and react
  // and vue both build the client during render so it survives SSR — each has
  // a live SSR test pinning that. A call fired from the constructor would POST
  // an identify on every server render of <ChatProvider>: once per request,
  // from the server's IP, for a user who may never open the widget. `connect()`
  // is the first moment the host has unambiguously said "this is a real
  // browser session with a real person behind it".
  // ---------------------------------------------------------------------

  const identityProfile = config.identityProfile;
  const identitySync = config.identitySync;
  const clock: Clock = now ?? systemClock;

  /**
   * Whether identify has already been started for this client instance.
   *
   * Flipped SYNCHRONOUSLY in `startIdentifyOnce`, before the async work is
   * even created — that is the whole of the exactly-once guarantee, including
   * for two `connect()` calls that race. JS cannot interleave between the read
   * and the write of this flag, so no second caller can observe it unset once
   * the first has passed. A guard that instead checked an in-flight promise
   * assigned after an `await`, or asked storage, would have a real window
   * between the check and the set, and two concurrent connects would both fall
   * through it.
   */
  let identifyStarted = false;

  /** Resolves after `delayMs` on the injected timer. Never rejects. */
  function afterDelay(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      scheduleTimer(() => {
        resolve();
      }, delayMs);
    });
  }

  /**
   * Sends the profile, retrying at most {@link IDENTIFY_RETRY_LIMIT} times
   * after a full-jitter delay. Resolves `true` only if the transport accepted
   * it — the caller uses that to decide whether to open a fresh dedup window,
   * so a failed send must never be recorded as a success.
   */
  async function sendIdentity(sync: IdentitySync, profile: IdentityProfile): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await sync.sync(profile);
        return true;
      } catch {
        if (attempt >= IDENTIFY_RETRY_LIMIT) {
          // The adapter's error text is deliberately not forwarded, following
          // the same §14 rule `closeSession`'s read-back failure follows: it
          // is host-authored, and the one thing this profile is full of is the
          // user's email and phone number. The host knows which transport it
          // injected and can log inside it.
          config.logger?.(
            'warn',
            'identify: the profile could not be synced after a retry; not trying again on this client',
          );
          return false;
        }
        await afterDelay(fullJitterDelay(attempt));
      }
    }
  }

  /**
   * The whole fire-and-forget path, from dedup gate to recorded success.
   *
   * Never rejects, and that is a hard requirement rather than a courtesy:
   * nothing awaits the returned promise, so a rejection escaping here is an
   * unhandled rejection in the host's page — a crash report for CRM
   * bookkeeping the user never asked about.
   */
  async function runIdentify(sync: IdentitySync, profile: IdentityProfile): Promise<void> {
    const dedup = {
      storage: tenantStorage,
      userId: localSender.senderId,
      profile,
      now: clock,
    };

    try {
      // Neither half of the gate rejects on a storage failure — a rejecting,
      // cleared, or corrupt store all degrade to "send", the harmless
      // direction (identity/dedup.ts). This `catch` is for the one case they
      // deliberately do throw on: a profile that cannot be serialised at all,
      // reachable only from untyped JS. dedup.ts wants that to surface rather
      // than be swallowed, and routing it to `logger` surfaces it without
      // turning a host integration bug into an unhandled rejection.
      if (!(await shouldSyncIdentity(dedup))) return;
      if (await sendIdentity(sync, profile)) await recordIdentitySynced(dedup);
    } catch {
      config.logger?.('warn', 'identify: the supplied identityProfile could not be processed');
    }
  }

  /**
   * Starts identify at most once per client instance, and only when the host
   * supplied BOTH halves.
   *
   * The pair is the switch, not either half — see
   * `ChatClientConfig.identityProfile`. A guest has a `userId` but no profile
   * to send, and a host that configures a profile with no transport is inert
   * rather than a construction error, because the only thing that would break
   * is bookkeeping nobody is waiting on.
   */
  function startIdentifyOnce(): void {
    if (identifyStarted) return;
    if (identityProfile === undefined || identitySync === undefined) return;
    identifyStarted = true;

    void runIdentify(identitySync, identityProfile).catch(() => {
      // `runIdentify` already handles everything it can report. The only way
      // to arrive here is the host's own `logger` throwing, at which point
      // there is nothing left to report it to — and swallowing it is still
      // better than an unhandled rejection the host cannot trace back.
    });
  }

  // ---------------------------------------------------------------------
  // 8. The public surface.
  // ---------------------------------------------------------------------
  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    on: (event, handler) => store.on(event, handler),

    connect: () => {
      // The socket first, identify second: fire-and-forget or not, nothing on
      // the identify path — a slow `storage.get`, the fingerprint hash — gets
      // to sit between the caller and the connection starting.
      const connecting = connectionController.connect();
      startIdentifyOnce();
      return connecting;
    },
    retryNow: () => connectionController.retryNow(),
    disconnect: () => {
      connectionController.disconnect();
      presenceCoordinator.reset();
      // The connection carrying the join is gone; the next `connection.ack`
      // establishes a new one.
      joinedSessionId = null;
    },
    startNewSession: async (payload?: { readonly topic?: string; readonly subject?: string }): Promise<void> => {
      // Order is load-bearing throughout; see each step.
      const closing = store.getState().session?.id;

      // 1. The old session's undelivered sends, before anything reopens a
      //    socket. `message.send` carries no `sessionId` (protocol/frames.ts),
      //    so any entry still queued when the new session opens would be
      //    attributed to *it* — the customer's unsent question about a
      //    resolved order landing in a brand-new ticket. They are failed, not
      //    deleted, so the binding can show them as dead and re-sendable.
      if (closing !== undefined) await queue.abandonSession(closing);

      // 2. Close the socket before forgetting the anchor, so no in-flight
      //    frame can advance it again between the reset and the reconnect.
      connectionController.disconnect();
      presenceCoordinator.reset();

      // 3. The anchor. Without this the next `connection.hello` carries a
      //    `resumeFrom` from a history this client no longer holds, and the
      //    v2 endpoint answers it with a NON-RETRYABLE `VALIDATION_FAILED`
      //    ("resumeFrom is ahead of this session") — stranding the client in
      //    `suspended` instead of the new session it asked for. This is the
      //    single reason `disconnect()` + `connect()` is not already a
      //    working "start over".
      connectionController.forgetResumeAnchor();

      // 3b. And SAY so. Forgetting the anchor only makes the next hello look
      //     like a first connection; it does not make the server treat it as
      //     one. chat-service resolves a customer to their single active
      //     session either way, so without this the reconnect below landed
      //     straight back in the conversation this method exists to leave —
      //     the customer pressed "Start a new conversation" and kept talking
      //     in the old one. `newSession: true` closes that one (SWITCHED) and
      //     mints a fresh one, which is the whole operation.
      //
      //     The caller's subject/topic rides along on the same call — see
      //     `requestNewSession`'s own doc for why it has to be latched here
      //     rather than sent as a later frame.
      connectionController.requestNewSession(payload);

      // 4. Every per-session projection, in one write so no subscriber ever
      //    observes the new session's id against the old one's transcript.
      //    Shared verbatim with `switchSession`; the extra `session: null`
      //    belongs to this path alone, because here there is genuinely no
      //    session until the server mints one.
      store.setState({ session: null, ...perSessionReset() });

      // 5. Any remembered selection must go BEFORE the connect, not after:
      //    the `connected` handler reads it, and a leftover id would send
      //    this client straight back into the conversation it was just told
      //    to abandon. Also bumps the epoch, so an in-flight switch cannot
      //    write its page into the brand-new session.
      switchEpoch += 1;
      // No switch is in flight any more, and this connection is joined to
      // nothing until the next `connection.ack` says otherwise. Clearing the
      // target is what lets the brand-new session's own `connection.ack`
      // repaint the screen — an abandoned switch must not go on refusing it.
      switchTarget = null;
      joinedSessionId = null;
      await forgetSelectedSession();

      // 6. A hello with no `resumeFrom` reads as a first connection, which is
      //    what makes the server mint a new session (WAITING_FOR_AGENT, seq
      //    0) rather than resume the closed one. Resolves on `connection.ack`,
      //    so awaiting this means the new session is in state.
      await connectionController.connect();

      // 7. And now the new session's id is known, so a reload comes back to
      //    the conversation just opened rather than to whichever one the
      //    server would pick on its own.
      const opened = store.getState().session?.id;
      if (opened !== undefined) await rememberSelectedSession(opened);
    },
    joinSession: (sessionId) => {
      joinSessionFrame(sessionId);
    },
    switchSession: (sessionId) => switchToSession(sessionId),
    leaveSession: () => {
      realTransport.send('session.leave', {});
      // Optimistic on purpose: the frame is fire-and-forget, and the cost of
      // being wrong in this direction is a queued send waiting one join
      // longer, versus one delivered into a session already left.
      joinedSessionId = null;
    },
    requestAgent: (reason) => {
      realTransport.send('session.requestAgent', reason === undefined ? {} : { reason });
    },
    // Pure delegation — `ConnectionController.setContactInfo` owns the
    // merge/latch semantics documented on the public method above.
    setContactInfo: (info) => connectionController.setContactInfo(info),
    reopenSession: async (sessionId): Promise<ChatSession> => {
      if (config.sessionActions === undefined) {
        throw new ChatClientConfigError(
          'reopenSession() requires config.sessionActions to be supplied to createChatClient().',
        );
      }
      let session: ChatSession;
      try {
        session = await config.sessionActions.reopenSession(sessionId);
      } catch (error) {
        reportIfSessionChangedAnyway(error);
        throw error;
      }
      // Through the commit, not a bare `setState`: `reopenSession` takes an
      // explicit id and may name a session other than the one on screen, which
      // would otherwise leave the old transcript under the new session.
      commitSession(session);
      return session;
    },
    closeSession: async (): Promise<void> => {
      if (config.sessionActions === undefined) {
        throw new ChatClientConfigError(
          'closeSession() requires config.sessionActions to be supplied to createChatClient().',
        );
      }
      const sessionId = store.getState().session?.id;
      if (sessionId === undefined) {
        throw new ChatClientConfigError('closeSession() requires an active session.');
      }
      let session: ChatSession;
      try {
        session = await config.sessionActions.closeSession(sessionId);
      } catch (error) {
        reportIfSessionChangedAnyway(error);
        throw error;
      }
      commitSession(session);
    },
    submitCsat: async (sessionId, rating, comment) => {
      if (config.sessionActions === undefined) {
        throw new ChatClientConfigError(
          'submitCsat() requires config.sessionActions to be supplied to createChatClient().',
        );
      }
      // No `commitSession`/`reportIfSessionChangedAnyway` here, deliberately:
      // unlike reopen/close, a rating never mutates `ChatState.session`, so
      // there is no read-back that could apply-but-fail independently of the
      // POST itself — see `SessionActions.submitCsat`'s own doc.
      return config.sessionActions.submitCsat(sessionId, rating, comment);
    },
    getCsat: async (sessionId) => {
      if (config.sessionActions === undefined) {
        throw new ChatClientConfigError(
          'getCsat() requires config.sessionActions to be supplied to createChatClient().',
        );
      }
      // Read-only, so nothing here commits to state — see `submitCsat` above,
      // and `SessionActions.getCsat`'s own doc for why the answer belongs to
      // the server rather than to a caller's in-process flag.
      return config.sessionActions.getCsat(sessionId);
    },
    listSessions: async (query): Promise<readonly ChatSessionSummary[]> => {
      if (config.sessionSummarySource === undefined) {
        throw new ChatClientConfigError(
          'listSessions() requires config.sessionSummarySource to be supplied to createChatClient().',
        );
      }
      const sessions = await config.sessionSummarySource.listSessions(query);
      // Wholesale replace (§9.4-style), not a merge — this IS the whole
      // customer's recent-session list as of this call, same as a
      // session.updated snapshot replaces ChatState.session outright.
      store.setState({ pastSessions: [...sessions] });
      return sessions;
    },

    sendMessage: (content, opts) => messageController.sendMessage(content, opts),
    sendAttachment: (file, opts) => {
      // Checked here, explicitly, rather than relying on UNCONFIGURED_UPLOADER
      // alone: MessageController#sendAttachment deliberately does not reject
      // on an upload failure — it reports through `lastError`/the `error`
      // event instead (§6.4), with a fixed, generic message ("attachment
      // upload failed") that never distinguishes "no uploader configured"
      // (a construction-time mistake) from a genuine runtime failure. A
      // config mistake deserves a loud, distinct rejection; a real upload
      // failure keeps the module's own designed behavior unchanged.
      if (config.uploader === undefined) {
        return Promise.reject(
          new ChatClientConfigError(
            'sendAttachment() requires config.uploader (an AttachmentUploader) to be supplied to createChatClient().',
          ),
        );
      }
      return messageController.sendAttachment(file, opts);
    },
    retryMessage: async (id): Promise<RetryOutcome> => {
      // A send attempted before restore has been read would race
      // SendQueue.retry()'s own restored-guard (QueueNotRestoredError) —
      // same reasoning as #send's `await queueRestored` above.
      await queueRestored;

      // The one hazard SendQueue.retry() (T9) cannot see, because it has no
      // notion of "the current session": `message.send` carries no
      // `sessionId` on the wire, so replaying a failed entry's ORIGINAL
      // payload while a DIFFERENT session is now joined would silently
      // attribute it to whatever session IS current — the exact
      // misattribution `abandonSession` already guards against on the
      // reconnect/switch path (see SendFailureReason.sessionClosed's doc:
      // "a retry is NOT futile ... [but] must never be delivered as-is").
      // Checked for every failure reason, not only `sessionClosed`: the
      // wire-level hazard is the same regardless of why the send originally
      // died, and "retry" only ever means "try the same thing again, into
      // the same conversation" — a caller that wants this content in a NEW
      // session should send it fresh, not retry a dead entry into one.
      const failure = queue.failed().find((candidate) => candidate.entry.id === id);
      if (failure !== undefined && failure.entry.sessionId !== store.getState().session?.id) {
        return { status: 'refused', reason: 'not-retryable' };
      }

      const outcome = await queue.retry(id);

      if (outcome.status === 'retried') {
        // Back to `queued` immediately, so the UI drops the dead bubble's
        // Retry affordance the instant the retry is durably re-queued,
        // rather than waiting on the eventual ack/failure to patch it —
        // mirrors rehydrateQueuedMessages' reasoning above. The eventual
        // outcome still arrives the normal way: this `queue` is the same
        // instance wired to messageController.onAck/onFailed, so nothing
        // extra needs wiring here for that half.
        const messages = store.getState().messages;
        const existing = messages.find((message) => message.id === id);
        if (existing !== undefined) {
          store.setState({
            messages: upsertMessage(messages, { ...existing, delivery: { state: 'queued' } }),
          });
        }
      }

      return outcome;
    },
    markRead: () => {
      presenceCoordinator.watermarks.markRead();
    },
    startTyping: () => {
      presenceCoordinator.typing.startTyping();
    },
    stopTyping: () => {
      presenceCoordinator.typing.stopTyping();
    },
    // §6.3 names this `loadOlderMessages`; messages/controller.ts spells it
    // `loadMore` — this is the one place the public name is chosen.
    //
    // Cold start is no longer a binding's job: core seeds page one itself on
    // every `connected` (see `restoreSelectionAndSeed`), guarded by
    // `pagination.initialLoaded` so a reconnect cannot re-request it under a
    // user who has scrolled back. Calling this on mount anyway is harmless —
    // the same guard makes the second call a no-op — but a binding that never
    // calls it now still gets a transcript, which is what react/vue/angular
    // were missing. The seam is still `MessageHistorySource` alone: no "full
    // session" REST fetch was added to `connect()`, so §14's "one network
    // round trip plus token-fetch latency" is unchanged.
    loadOlderMessages: () => messageController.loadMore(),

    setPresence: (status) => {
      presenceCoordinator.presence.setPresence(status);
    },
    queryPresence: (participantIds) => {
      presenceCoordinator.presence.queryPresence(participantIds);
    },
  };
}
