/// The public client — PRD §6.
library;

import 'dart:async';

import 'auth/keys.dart';
import 'auth/token.dart';
import 'connection/backoff.dart';
import 'connection/connection.dart';
import 'connection/socket.dart';
import 'logic/agent_presence.dart';
import 'logic/typing.dart';
import 'protocol/enums.dart';
import 'protocol/envelope.dart';
import 'protocol/errors.dart';
import 'protocol/frames.dart';
import 'protocol/ulid.dart';
import 'resume/resume_tracker.dart';

/// A remote participant's typing state (§6.5).
class TypingEvent {
  const TypingEvent({required this.isTyping, this.participantId});

  final bool isTyping;
  final String? participantId;
}

/// Whether a send whose failure carried no server verdict may be retried.
///
/// Mirrors the TypeScript core's `DEFAULT_RETRYABLE_FALLBACK`. It applies only
/// where there is nothing to mirror — a send this client abandoned without
/// ever handing it to a server never produced a wire [ErrorPayload] to read
/// `retryable` off. Defaulting to `true` rather than `false` is deliberate:
/// the flag gates a UI affordance, so guessing `false` silently removes a
/// Retry button that would have worked, while guessing `true` costs one
/// refused round trip that the server answers with a real verdict.
///
/// Applied at the ONE site that has no server to ask
/// ([_abandonUndeliveredSends]) and stored on [MessageFailed.retryable] from
/// there, so nothing downstream reads a nullable verdict and re-resolves it.
/// A second resolution is a second chance to resolve it differently.
const bool kDefaultRetryable = true;

/// How [ChatClient.retry] resolved.
///
/// A result type rather than a thrown error or a bare bool, because refusal is
/// an expected outcome a caller branches on — and because the reasons are not
/// interchangeable: [RetryRefusalReason.notRetryable] means retrying this send
/// will never get anywhere, while the other two mean it did not happen now.
sealed class RetryOutcome {
  const RetryOutcome();
}

/// The original envelope went back onto the wire.
final class RetryRetried extends RetryOutcome {
  const RetryRetried(this.message);

  /// The same message, under the same id, back to
  /// [MessageDelivery.pending]. Also pushed onto [ChatClient.messages].
  final ChatMessage message;
}

/// Nothing was sent.
final class RetryRefused extends RetryOutcome {
  const RetryRefused(this.reason);

  final RetryRefusalReason reason;
}

/// Why [ChatClient.retry] declined.
enum RetryRefusalReason {
  /// No failed send under this id: never sent, already succeeded, still in
  /// flight, or already retried by an earlier call. None of those are
  /// distinguished, because a caller can do nothing different about them.
  notFound,

  /// The server said retrying is futile — its own `retryable` flag, not a
  /// second copy of §7.4's code table maintained here.
  ///
  /// A refusal a well-built host should never actually receive. The same
  /// flag rides on [MessageFailed.retryable] on the message this client
  /// pushed onto [ChatClient.messages], so the affordance can be withheld
  /// BEFORE the customer presses it rather than explained after. This
  /// remains as the backstop for a host that asks anyway, and for the window
  /// between a render and a press.
  notRetryable,

  /// The transport could not take the frame, so there is nowhere for it to go
  /// right now.
  ///
  /// ── A reason the TypeScript core does not have ────────────────────────
  ///
  /// There, a retry is accepted into the durable offline queue (§9.1) and
  /// drains when the socket returns, so "disconnected" is not a refusal. This
  /// package has no such queue — see the class doc's out-of-scope list — and
  /// reporting `retried` for a frame that reached nothing would be a promise
  /// with nothing behind it. The failure record survives the refusal, so the
  /// identical call succeeds once the connection is back. When the durable
  /// queue lands, this value goes away rather than changing meaning.
  ///
  /// Unlike [notRetryable], this one CANNOT be predicted from the message: a
  /// connection can drop between the moment a Retry button is drawn and the
  /// moment it is pressed. A host that surfaces retry outcomes needs a path
  /// for this reason specifically, and "it failed again" is the wrong
  /// sentence for it — nothing was attempted.
  disconnected,
}

/// A send that has been handed to the transport and is awaiting its `ack`.
class _InFlightSend {
  const _InFlightSend(this.frame, this.message);

  /// The frame AS SENT. Kept rather than rebuilt, because a retry must replay
  /// this exact envelope — see [ChatClient.retry].
  final ClientFrame frame;

  /// The optimistic echo, still [MessageDelivery.pending].
  final ChatMessage message;
}

/// A send that failed and that a host may offer a Retry affordance for.
class _FailedSend {
  const _FailedSend(this.frame, this.message);

  /// The frame AS SENT, for [ChatClient.retry] to replay unchanged.
  final ClientFrame frame;

  /// The FAILED echo — the same object pushed onto [ChatClient.messages],
  /// carrying its reason and the server's `retryable` verdict on
  /// [MessageFailed].
  ///
  /// There is no separate `retryable` field beside it, and that is the point:
  /// the verdict a host renders and the verdict [ChatClient.retry] gates on
  /// are then necessarily the same boolean rather than two copies that can
  /// drift. [ChatMessage.retrying] produces the pending echo a retry emits.
  final ChatMessage message;
}

/// The chat client.
///
/// ── Shape ─────────────────────────────────────────────────────────────────
///
/// Streams for things that keep happening, Futures for things that finish.
/// [connect] completes once; [messages] never does. This is deliberately NOT
/// the TypeScript core's `subscribe(state => …)` + `on(event, handler)` pair:
/// that shape exists because JavaScript has no standard observable, and Dart
/// does. A Flutter host wires [messages] into a `StreamBuilder` and is done.
///
/// ── Out of scope for this pass, with the seams left open ──────────────────
///
///  * PERSISTENCE for the offline queue (§9.1). The queue itself is here —
///    [sendMessage] holds a send it cannot hand to the transport, and the
///    client replays the whole outbox in FIFO order on reconnect (§8.4) — but
///    it lives in memory only. A process restart loses it. The seam for the
///    durable half is [_outbox]: it is a plain FIFO list of frames already
///    built, so persisting it is serialising `ClientFrame`s, not reworking
///    the send path.
///  * Delivery ticks (`message.markDelivered`/`message.delivered`). The frames
///    decode; nothing acts on them.
///  * Voice and attachments. [AttachmentMetadata] decodes so an inbound
///    message carrying one parses; there is no upload path.
///  * REST: pagination, session history, `pastSessions`. [gaps] tells a host
///    exactly which `seq` span to refetch, and refetching is its job for now.
class ChatClient {
  ChatClient({
    required Uri wsUrl,
    required PublishableKey publishableKey,
    required TokenProvider getToken,
    ChatSocketFactory? socketFactory,
    Scheduler scheduler = const SystemScheduler(),
    BackoffPolicy backoffPolicy = const BackoffPolicy(),
    UlidGenerator? ulids,
  })  : _scheduler = scheduler,
        _connection = ConnectionController(
          wsUrl: wsUrl,
          publishableKey: publishableKey,
          getToken: getToken,
          socketFactory: socketFactory,
          scheduler: scheduler,
          backoff: Backoff(policy: backoffPolicy),
          resumeTracker: ResumeTracker(),
          ulids: ulids,
        ) {
    _typingController = TypingController(
      scheduler: scheduler,
      onChanged: (String participantId, {required bool isTyping}) => _emit(
        _typing,
        TypingEvent(isTyping: isTyping, participantId: participantId),
      ),
    );
    _subscription = _connection.frames.listen(_onFrame);
    _stateSubscription = _connection.states.listen(_onConnectionState);
  }

  final ConnectionController _connection;
  final Scheduler _scheduler;

  /// Remote typing state, and the auto-clear that keeps it honest.
  ///
  /// `late final` rather than an initialiser because it closes over [_emit],
  /// which is an instance method and so unavailable in the initialiser list.
  late final TypingController _typingController;

  late final StreamSubscription<ServerFrame> _subscription;
  late final StreamSubscription<ConnectionState> _stateSubscription;

  final StreamController<ChatMessage> _messages =
      StreamController<ChatMessage>.broadcast();
  final StreamController<SessionSnapshot> _sessions =
      StreamController<SessionSnapshot>.broadcast();
  final StreamController<TypingEvent> _typing =
      StreamController<TypingEvent>.broadcast();
  final StreamController<SessionClosed> _sessionClosed =
      StreamController<SessionClosed>.broadcast();
  final StreamController<AgentEvent> _agentJoined =
      StreamController<AgentEvent>.broadcast();
  final StreamController<PresenceEntry> _presence =
      StreamController<PresenceEntry>.broadcast();
  final StreamController<MessageDelivered> _messageDelivered =
      StreamController<MessageDelivered>.broadcast();
  final StreamController<TicketLinked> _ticketLinked =
      StreamController<TicketLinked>.broadcast();

  /// Optimistic sends awaiting an `ack`, keyed by envelope id.
  ///
  /// Under D1 that key IS the permanent message id, so this map never has to
  /// translate one id into another — the entire optimistic-id-swap machinery
  /// v1 needed (§12.9) does not exist here.
  final Map<String, _InFlightSend> _pending = <String, _InFlightSend>{};

  /// Sends that will not go out by themselves, keyed by the same permanent
  /// id, each holding the frame as sent so [retry] can replay it rather than
  /// rebuild it.
  ///
  /// Two ways in, and [SendFailureReason] tells them apart on the message
  /// itself: the server refused it ([SendFailureReason.rejected]), or this
  /// client abandoned it when the conversation it was addressed to was
  /// closed under it ([SendFailureReason.sessionClosed]).
  ///
  /// Deliberately not the same thing as [_outbox]. A send the server rejected
  /// will be rejected again, so it must not be replayed on a timer — the
  /// customer would spend their battery collecting the same verdict. These
  /// need [retry], gated on [MessageFailed.retryable].
  final Map<String, _FailedSend> _failed = <String, _FailedSend>{};

  /// Sends waiting for a connection, oldest first — the offline queue (§9.1).
  ///
  /// ── The one invariant, and what it buys ───────────────────────────────
  ///
  /// An entry leaves this list only when it has been written to a live socket.
  /// Not when it is composed, not when the connection drops, not when the
  /// customer navigates. §8.4's "an unacked frame moves into the queue when
  /// the transport drops" therefore needs no move at all for anything still
  /// held here — it never left.
  ///
  /// FIFO by construction rather than by a sort: new sends append to the tail
  /// and the drain reads from the head, so a message composed now cannot
  /// overtake one composed a minute ago in a tunnel. Orphans recovered from
  /// [_pending] go to the FRONT ([_onConnectionState]) because they were
  /// composed before everything already in the list.
  ///
  /// A `List` rather than a `Map` for exactly that reason: order IS the data
  /// structure's job here, and the id lookup [_pending] and [_failed] need is
  /// not something the drain ever performs.
  final List<_InFlightSend> _outbox = <_InFlightSend>[];

  /// The conversation this client is in — the session a message composed now
  /// is addressed to.
  ///
  /// Written by the authoritative snapshot and by nothing else:
  /// `connection.ack` and `session.updated` (§9.4 — overwrite wholesale),
  /// which are the same two frames that push [sessions] and therefore the same
  /// two moments a host repaints. One writer is the point; a second one that
  /// ran earlier is how this field and the screen come to name different
  /// conversations. See [joinSession].
  ///
  /// The one deliberate exception is [leaveSession], which clears it. Leaving
  /// names no incoming session, so there is nothing to be wrong about, and a
  /// send composed after it is unaddressed rather than addressed to a
  /// conversation the host has left.
  String? _sessionId;

  /// The last snapshot published on [sessions], or null before the first one.
  ///
  /// Held for exactly one reason: `agent.joined`/`agent.left` REVISE a session
  /// rather than replacing it, so folding one needs the snapshot it is
  /// revising — see `agent_presence.dart`. Nothing else reads it, and it is
  /// deliberately not exposed: [sessions] is the one way a consumer learns
  /// about a session, so a getter here would be a second answer that a
  /// listener mid-delivery could find disagreeing with the event it is
  /// holding.
  ///
  /// Cleared wherever [_sessionId] is, and for the same reason — an
  /// `agent.left` that arrives after the host left the conversation must not
  /// resurrect a snapshot for it.
  SessionSnapshot? _session;

  // ── Connection ──────────────────────────────────────────────────────────

  /// Current connection state (§8.1).
  ConnectionState get connectionState => _connection.state;

  /// Connection state transitions.
  Stream<ConnectionState> get connectionStates => _connection.states;

  /// Reconnect scheduling, for a "reconnecting…" affordance (§6.5).
  Stream<ReconnectingEvent> get reconnecting => _connection.reconnecting;

  /// Why auto-retry stopped, when suspended.
  SuspendReason? get suspendReason => _connection.suspendReason;

  /// Opens the connection and drives it to connected (§6.2).
  ///
  /// Completes on `connection.ack`. Fails only on an unrecoverable auth or
  /// protocol error — never for a transport failure, which retries forever.
  Future<void> connect() => _connection.connect();

  /// User-initiated close. Terminal (§6.2, §8.1).
  Future<void> disconnect() => _connection.disconnect();

  /// Abandons an armed reconnect backoff and attempts immediately.
  ///
  /// For a host that has learned the reason the last attempts failed is gone —
  /// on a phone, that is a connectivity stream reporting wifi or mobile data
  /// back. Backoff will by then have grown toward its 30-second cap, and
  /// waiting it out on a device that is plainly online again is what "it just
  /// says Connecting…" is.
  ///
  /// Narrow on purpose, and NOT a second [connect]: it completes no future,
  /// leaves the auth escalation counter alone (a network blip is no evidence a
  /// rejected token was fixed), and resets only the transport attempt counter.
  /// It acts ONLY while a backoff is counting down
  /// ([ConnectionState.reconnecting]) and returns `false` — a pure no-op, safe
  /// to call on any cadence — everywhere else, including
  /// [ConnectionState.suspended] and [ConnectionState.closed], which §8.1
  /// makes recoverable only by an explicit [connect].
  bool retryNow() => _connection.retryNow();

  /// How many composed messages are waiting for a connection.
  ///
  /// The number an "offline, your messages are safe" banner names. It counts
  /// only sends that WILL go out by themselves — never a
  /// [MessageDelivery.failed] one, which needs [retry] and its own affordance,
  /// and promising its delivery would be a lie.
  int get queuedCount => _outbox.length;

  /// The queued sends themselves, oldest first, as their optimistic echoes.
  ///
  /// An unmodifiable view: mutating the outbox from outside would break the
  /// ordering the drain depends on.
  List<ChatMessage> get queuedMessages => List<ChatMessage>.unmodifiable(
        _outbox.map((_InFlightSend entry) => entry.message.queued()),
      );

  // ── Inbound ─────────────────────────────────────────────────────────────

  /// Messages, optimistic and server-sent alike.
  ///
  /// A message this client sent appears TWICE with the SAME [ChatMessage.id]:
  /// once immediately as [MessageDelivery.pending], then again as
  /// [MessageDelivery.confirmed] with its `seq`. Because the id is permanent
  /// (D1), a host keys its list on it and the second emission replaces the
  /// first with no reconciliation.
  Stream<ChatMessage> get messages => _messages.stream;

  /// Authoritative session snapshots. Overwrite local state wholesale (§9.4).
  Stream<SessionSnapshot> get sessions => _sessions.stream;

  /// Remote typing state (§6.5).
  Stream<TypingEvent> get typing => _typing.stream;

  /// Session closure, carrying a structured reason (§12.5).
  Stream<SessionClosed> get sessionClosed => _sessionClosed.stream;

  /// Agent arrival and departure.
  Stream<AgentEvent> get agentEvents => _agentJoined.stream;

  /// Presence updates.
  Stream<PresenceEntry> get presence => _presence.stream;

  /// How far another participant has RECEIVED, as a `seq` watermark (§9.5).
  ///
  /// The delivered tick's only source. Read ticks need no stream — they come
  /// off `ParticipantSnapshot.lastReadAt` on the session snapshot, which is
  /// itself the §9.5 read watermark — but nothing on a snapshot carries a
  /// delivery position, so a host that does not listen here can never learn
  /// one and can never draw the tick.
  ///
  /// Emitted raw and NOT accumulated: this client holds no per-participant
  /// watermark map. A host that renders ticks keeps `max` per
  /// [MessageDelivered.participantId] itself, because a replayed or overtaken
  /// frame (D2) can otherwise walk the mark backwards and un-tick a message
  /// the customer already saw delivered.
  Stream<MessageDelivered> get messageDelivered => _messageDelivered.stream;

  /// A CRM ticket was attached to this conversation (§7.3).
  ///
  /// A discrete occurrence rather than current state — and here, also the
  /// only surface it could have had. [SessionSnapshot] carries a `ticketId`
  /// and no url at all, and this client never patches a snapshot: §9.4 makes
  /// the server's copy authoritative and [sessions] re-emits it wholesale.
  /// Without this stream a host learns of a link only at the next
  /// `session.updated`, and learns [TicketLinked.ticketUrl] never.
  Stream<TicketLinked> get ticketLinked => _ticketLinked.stream;

  /// `seq` spans that were never delivered and must be refetched over REST.
  Stream<ResumeGap> get gaps => _connection.gaps;

  /// Protocol and transport errors (§7.4).
  Stream<ErrorPayload> get errors => _connection.errors;

  // ── Outbound ────────────────────────────────────────────────────────────

  /// Sends a message and returns the optimistic local echo immediately.
  ///
  /// ── D1, and why there is no Future here ───────────────────────────────
  ///
  /// The returned [ChatMessage] already carries its PERMANENT id: the ULID
  /// minted here is the id the server stores (D1), so this value is not a
  /// placeholder to be reconciled later. It is also pushed onto [messages],
  /// so a host can either use the return value or listen — whichever suits.
  ///
  /// This does not return a `Future` because there is nothing useful to await:
  /// §6.3 requires that sending never throw for "offline", and the ack only
  /// adds `seq`. Watching [messages] for the confirmed echo is the honest way
  /// to observe delivery, and it works identically for a message that was
  /// queued and one that went straight out.
  ///
  /// ── The frame is ADDRESSED to the session it was composed in ──────────
  ///
  /// `d.sessionId` is stamped here, from the session this client currently
  /// holds a snapshot for, and it travels with the frame for the rest of that
  /// frame's life. The alternative — letting the server file the message under
  /// whatever the connection last joined — is a property of the CONNECTION
  /// rather than of the message, and the two diverge whenever a frame built at
  /// one moment reaches the wire at another. This package has no offline
  /// queue, so that happens in exactly two places, and both are ordinary:
  ///
  ///  * [retry] replays a frame built arbitrarily long ago, after the customer
  ///    may well have moved to another conversation;
  ///  * a reconnect's `connection.ack` carries a session this client never
  ///    asked for, and the sends orphaned by that same drop are precisely the
  ///    ones a host offers a Retry button for.
  ///
  /// Without the address, either one delivers a message the customer typed in
  /// one conversation into another, acked as success.
  ///
  /// The field is optional on the wire: absent means the old behaviour, so an
  /// older server or an older client is unaffected. Present, the server runs
  /// the same ownership check `session.join` runs and refuses outright on
  /// failure rather than falling back.
  /// ── [metadata] — the structured copy of what the prose already says ──
  ///
  /// A free-form map the server reads alongside `content`. `messageSendPayload`
  /// has always accepted it (D4 puts `attachment` at the top level precisely so
  /// that `metadata` stays free for this); it simply had no way through from
  /// here until a caller needed one.
  ///
  /// The caller that needs it is the pre-chat form: chat-service folds
  /// `{kind: 'pre_chat', answers}` into a CUSTOMER-ASSERTED contact on the
  /// session, fill-empty only. Sent as one frame with the prose rather than as
  /// a second message, so the agent's transcript and the server's structured
  /// read can never describe different answers.
  ///
  /// Null omits the key entirely. `{}` is NOT the same thing and is sent as
  /// written — an empty structured claim is still a claim that one was made.
  ///
  /// It rides on the FRAME, so a held send replays it unchanged (see below).
  ChatMessage sendMessage(
    String content, {
    MessageType type = MessageType.text,
    String? replyToMessageId,
    AttachmentMetadata? attachment,
    // Forwarded, not dropped. `messageSendPayload` has always declared this
    // field; this method simply never passed it, so a caller with structured
    // context to attach (the pre-chat answers a conversation is opened with,
    // say) had no way to get it onto the frame and the optimistic echo below
    // described a frame that was never sent. Optional and omitted when null,
    // so no existing caller changes behaviour. (Orchestrator decision D26.)
    Map<String, Object?>? metadata,
  }) {
    // The envelope id IS the permanent message id (D1), so it is minted by
    // the same generator every other frame uses and then read back off the
    // frame — rather than generated here and handed down, which is the shape
    // that lets the two drift apart.
    final ClientFrame frame = _connection.buildFrame(
      'message.send',
      messageSendPayload(
        content: content,
        type: type,
        // The session this message is composed in, stamped ONCE, here — see
        // the method doc. Null only before any snapshot has named a session,
        // and null omits the field rather than sending `''`.
        sessionId: _sessionId,
        replyToMessageId: replyToMessageId,
        attachment: attachment,
        metadata: metadata,
      ),
    );
    final String id = frame.id;

    final ChatMessage optimistic = ChatMessage(
      id: id,
      sessionId: _sessionId ?? '',
      // The server attributes the real sender; v2 is customer-only today and
      // hardcodes CUSTOMER server-side, so this echo says the same thing
      // rather than inventing an id the server will overwrite.
      senderId: '',
      senderType: SenderType.customer,
      type: type,
      content: content,
      seq: null,
      createdAt: _scheduler.now(),
      replyToMessageId: replyToMessageId,
      attachment: attachment,
      // The echo describes the FRAME that went out, metadata included. An
      // echo that silently dropped it would disagree with the confirmed
      // message the server sends back, for no reason a caller could see.
      metadata: metadata,
      delivery: MessageDelivery.pending,
    );

    if (_connection.send(frame)) {
      _pending[id] = _InFlightSend(frame, optimistic);
      _emit(_messages, optimistic);
      return optimistic;
    }

    // No wire to write to. HELD, not failed — this is the case §6.3 means by
    // "sending never throws for offline", and it is the commonest thing that
    // happens to a message on a phone.
    //
    // The frame is kept rather than the content, and that is the whole reason
    // this replays safely: the envelope id is the permanent message id (D1)
    // and the server dedupes on it, so an entry written just before the socket
    // dropped and replayed on the next one is deduped rather than delivered
    // twice. Rebuilding the frame at drain time would mint a fresh ULID and
    // turn exactly that case into two messages.
    _outbox.add(_InFlightSend(frame, optimistic));
    final ChatMessage echo = optimistic.queued();
    _emit(_messages, echo);
    return echo;
  }

  /// Replays a failed send under its ORIGINAL envelope id.
  ///
  /// ── Why this method exists at all ─────────────────────────────────────
  ///
  /// The envelope id IS the permanent message id (D1) and the server dedupes
  /// on it. A host that implements Retry by calling [sendMessage] again mints
  /// a fresh ULID, defeats that dedup, and produces a second, distinct
  /// message — so every press against a failure that has not gone away adds
  /// another dead message to the thread. The only fix that holds is
  /// structural: this replays a frame built once, and there is no path here
  /// that can produce a new id.
  ///
  /// Only a send currently marked [MessageDelivery.failed] is eligible; see
  /// [RetryRefusalReason] for what each refusal means. A retried send is
  /// re-emitted on [messages] as [MessageDelivery.pending] and settles
  /// through the normal ack path.
  ///
  /// This is NOT the durable offline queue §9.1 describes: nothing here
  /// survives a process restart, and a retry needs a live connection to be
  /// accepted.
  RetryOutcome retry(String id) {
    final _FailedSend? failure = _failed[id];
    if (failure == null) {
      return const RetryRefused(RetryRefusalReason.notFound);
    }

    // The verdict is read off the failure this method was handed, which is
    // the same object the host rendered its Retry button from — so a button
    // that was offered is a call that gets through, and one that was withheld
    // is a call that is refused, by construction rather than by two sites
    // agreeing. A delivery that is not [MessageFailed] cannot be in [_failed].
    if (failure.message.delivery case MessageFailed(retryable: false)) {
      // Left in place: the host is still rendering this message as failed and
      // is entitled to ask again and get the same answer.
      return const RetryRefused(RetryRefusalReason.notRetryable);
    }

    // THE original frame. Not a copy, not a rebuild.
    if (!_connection.send(failure.frame)) {
      return const RetryRefused(RetryRefusalReason.disconnected);
    }

    // Claimed only once the frame is actually on the wire, so a refusal never
    // loses the record.
    _failed.remove(id);
    // Back to pending under the SAME id. The failure does not survive
    // alongside the retry — a transcript showing both would be describing one
    // message in two contradictory states.
    final ChatMessage retried = failure.message.retrying();
    _pending[id] = _InFlightSend(failure.frame, retried);
    _emit(_messages, retried);
    return RetryRetried(retried);
  }

  /// Joins a session (§6.2).
  ///
  /// ── The join does not move this client until the server says so ───────
  ///
  /// This sends the frame and nothing else. Which conversation this client is
  /// in is written in exactly one place — the authoritative snapshot on
  /// `connection.ack` and `session.updated` (§9.4, overwrite wholesale) — so a
  /// join takes effect when the server's `session.updated` lands, which is
  /// also the moment [sessions] tells the host to repaint.
  ///
  /// Pointing at [sessionId] optimistically here would open a window in which
  /// this client is committed to the incoming session while [sessions] — the
  /// only thing a host renders off — still names the outgoing one. A message
  /// typed into that screen belongs to the conversation on it, and stamping it
  /// with the incoming session is the cross-conversation delivery that
  /// [sendMessage]'s address exists to prevent. The window is also
  /// unrecoverable when the join is REFUSED: nothing rolls the pointer back,
  /// so every later send names a session this client is not in.
  ///
  /// A join the server never answers therefore leaves sends composing into the
  /// session on screen, which is the conservative half of the trade and the
  /// same commit rule the TypeScript core's session switch was rebuilt around.
  void joinSession(String sessionId) {
    _connection.send(
      _connection.buildFrame(
        'session.join',
        sessionJoinPayload(sessionId: sessionId),
      ),
    );
  }

  /// Records what is known about this visitor, to ride on the next hello.
  ///
  /// The wire end of the contact-info capture. `dhaam_chat_rest`'s
  /// `captureContactInfo` is the collector; this is where its results go.
  /// A host wires the two together with a one-line sink:
  ///
  /// ```dart
  /// captureContactInfo(
  ///   apiUrl: apiUrl,
  ///   userAgent: myUserAgent,
  ///   sink: (RestContactInfo i) => client.setContactInfo(
  ///     ip: i.ip,
  ///     ipWatermark: i.ipWatermark,
  ///     userAgent: i.userAgent,
  ///     geo: i.geo == null ? null : ContactGeo(lat: i.geo!.lat, lng: i.geo!.lng),
  ///   ),
  /// );
  /// ```
  ///
  /// The translation is the host's rather than either package's because
  /// `dhaam_chat` does not depend on `dhaam_chat_rest` and must not: this
  /// package has one dependency and no HTTP. TypeScript keeps the same split
  /// — `contact-info.ts` declares its own narrow `ContactInfoSink` and core
  /// declares `setContactInfo` with its own shape, and the widget joins them.
  ///
  /// ── Do NOT await the capture before [connect] ───────────────────────────
  ///
  /// Fire the capture and connect; never gate one on the other. A slow
  /// ip-watermark fetch, and especially a location permission prompt the
  /// visitor may never answer, must not delay the chat opening. The design
  /// makes that safe rather than lossy:
  ///
  ///  * The user agent is recorded SYNCHRONOUSLY, before `captureContactInfo`
  ///    hits its first `await`, so it is already here when the first hello is
  ///    built.
  ///  * Anything that resolves later misses that hello and rides the next
  ///    one, because this record is re-read on every socket open and is never
  ///    cleared. A capture that never resolves sends nothing, which is the
  ///    right outcome rather than a failure.
  ///
  /// Merging, never replacing — a null argument means "nothing new about this
  /// field". See [ConnectionController.setContactInfo].
  void setContactInfo({
    String? ip,
    String? ipWatermark,
    String? userAgent,
    ContactGeo? geo,
  }) =>
      _connection.setContactInfo(
        ip: ip,
        ipWatermark: ipWatermark,
        userAgent: userAgent,
        geo: geo,
      );

  /// Leaves the current session (§6.2).
  void leaveSession() {
    _connection
        .send(_connection.buildFrame('session.leave', <String, Object?>{}));
    _sessionId = null;
    // Same reason as the id beside it: an `agent.left` arriving after this
    // must not fold onto — and re-publish — a snapshot for the conversation
    // the host just left.
    _session = null;
  }

  /// Abandons the current conversation and opens a brand-new one (§6.2).
  ///
  /// What "Start a new conversation" has to call. [topic] and [subject] are
  /// the New-conversation screen's choice and ride on the handshake that mints
  /// the session — see [ConnectionController.requestNewSession] for why they
  /// cannot be a later frame.
  ///
  /// Completes on the new session's `connection.ack`, so a caller that awaits
  /// this knows [sessions] has already pushed the new snapshot.
  ///
  /// ── Why this is not disconnect() + connect() ──────────────────────────
  ///
  /// Because that reconnects into the SAME conversation, twice over. The
  /// resume anchor survives, so the hello claims a history the server has
  /// closed and gets a non-retryable VALIDATION_FAILED — suspended, not
  /// restarted. And even with the anchor dropped, chat-service resolves a
  /// customer to their one active session, so the reconnect lands right back
  /// where it started: the customer pressed "Start a new conversation" and
  /// kept talking in the old one. [ConnectionController.forgetResumeAnchor]
  /// and [ConnectionController.requestNewSession] are the two halves that fix
  /// those, and both are needed.
  ///
  /// [joinSession] is not this either — it joins a session that already
  /// exists, and the whole point here is that none does yet.
  ///
  /// ── The order is load-bearing ─────────────────────────────────────────
  ///
  /// Every step below has to happen before the socket comes back up, and step
  /// 1 has to happen before the socket goes DOWN. See each.
  Future<void> startNewSession({String? topic, String? subject}) async {
    // 1. The old conversation's undelivered sends, before anything touches the
    //    socket — and before the disconnect specifically, because
    //    [_onConnectionState] moves everything in [_pending] to the front of
    //    [_outbox] the moment the connection drops. Clearing only the outbox
    //    here would hand those orphans to the new session a microtask later,
    //    which is the bug this step exists to prevent.
    _abandonUndeliveredSends();

    // 2. Close the socket BEFORE forgetting the anchor, so no frame still in
    //    flight can advance it again between the reset and the reconnect.
    await _connection.disconnect();

    // 3. The anchor. Without this the next hello carries a resumeFrom from a
    //    history this client no longer holds; see the method doc.
    _connection.forgetResumeAnchor();

    // 3b. And SAY so. Forgetting the anchor only makes the hello LOOK like a
    //     first connection; it does not make the server treat it as one.
    //     `newSession: true` closes the old session (SWITCHED) and mints a
    //     fresh one, which is the whole operation. Latched, so a flaky first
    //     attempt still asks on its retry.
    _connection.requestNewSession(topic: topic, subject: subject);

    // 4. The address a message composed now would carry. Cleared rather than
    //    left pointing at a session the server is closing: a send racing this
    //    method would otherwise be stamped with the outgoing conversation.
    //    Null omits the field, which is the right thing to say while there
    //    genuinely is no session — the next `connection.ack` names the new one
    //    and is, per [joinSession], the only thing that writes this field.
    //
    //    packages/core does more here (a presence coordinator, a switch epoch,
    //    a persisted session selection). This package has none of those, so
    //    there is nothing else to reset — not a step skipped.
    _sessionId = null;
    _session = null;

    // 5. A hello with no resumeFrom and `newSession: true` reads as a request
    //    for a fresh session (WAITING_FOR_AGENT, seq 0). Resolves on
    //    `connection.ack`, so awaiting this means the new session is in state.
    await _connection.connect();
  }

  /// Fails every send that has not reached the server, in composition order.
  ///
  /// FAILED, not dropped: the customer typed these, and a host that renders
  /// [MessageDelivery.failed] can show them as dead with a Retry affordance
  /// rather than have them vanish. They stay in [_failed], so [retry] finds
  /// them.
  ///
  /// ── Why they cannot simply ride along into the new session ────────────
  ///
  /// [sendMessage] stamps `sessionId` onto the frame ONCE, at compose time, so
  /// a held send carries whichever conversation it was typed into. Drained
  /// into a new session it is either addressed to a session the server has
  /// just closed, or — if it was composed before any snapshot named one, when
  /// the field is absent — attributed to the new session outright. That last
  /// one is the case worth spelling out: an unsent question about a resolved
  /// order, silently reappearing as the opening line of a brand-new ticket.
  ///
  /// A retry of one of these is safe for the same reason. The frame replays
  /// under its original envelope id and its original address, so the server
  /// answers a closed session with a real verdict the customer can see; it
  /// cannot quietly land in the new conversation. `retryable` is null — no
  /// server produced a verdict on this one — which resolves through
  /// [kDefaultRetryable] to offering the retry.
  ///
  /// [_pending] before [_outbox], because an in-flight send was composed
  /// before anything still waiting behind it — the same ordering
  /// [_onConnectionState] preserves when it puts orphans at the front.
  void _abandonUndeliveredSends() {
    final List<_InFlightSend> abandoned = <_InFlightSend>[
      ..._pending.values,
      ..._outbox,
    ];
    _pending.clear();
    _outbox.clear();

    for (final _InFlightSend entry in abandoned) {
      // No server saw these, so there is no verdict to carry and
      // [kDefaultRetryable] decides — resolved here, once, and stored.
      // `code` is absent for the same reason: a §7.4 code is a thing a server
      // said, and none did.
      final ChatMessage failed = entry.message.failed(
        reason: SendFailureReason.sessionClosed,
        retryable: kDefaultRetryable,
      );
      _failed[entry.frame.id] = _FailedSend(entry.frame, failed);
      _emit(_messages, failed);
    }
  }

  /// Asks for a human agent (§6.2).
  void requestAgent({String? reason}) {
    _connection.send(
      _connection.buildFrame(
        'session.requestAgent',
        sessionRequestAgentPayload(reason: reason),
      ),
    );
  }

  /// Advances the read watermark (§6.3, §9.5).
  ///
  /// Exactly one write path — there is no parallel REST call to keep in sync
  /// by hand, which is v1's §12.9 mistake.
  void markRead({String? upToMessageId}) {
    _connection.send(
      _connection.buildFrame(
        'message.markRead',
        messageMarkReadPayload(upToMessageId: upToMessageId),
      ),
    );
  }

  /// Signals that the local user started typing (§6.3).
  void startTyping() =>
      _connection.send(_connection.buildFrame('typing.start', typingPayload()));

  /// Signals that the local user stopped typing (§6.3).
  void stopTyping() =>
      _connection.send(_connection.buildFrame('typing.stop', typingPayload()));

  /// Sets presence (§6.5).
  void setPresence(PresenceStatus status) {
    _connection.send(
      _connection.buildFrame(
          'presence.set', presenceSetPayload(status: status)),
    );
  }

  /// Releases every resource.
  Future<void> dispose() async {
    _typingController.dispose();
    await _subscription.cancel();
    await _stateSubscription.cancel();
    await _connection.dispose();
    await _messages.close();
    await _sessions.close();
    await _typing.close();
    await _sessionClosed.close();
    await _agentJoined.close();
    await _presence.close();
    await _messageDelivered.close();
    await _ticketLinked.close();
  }

  // ── Routing ─────────────────────────────────────────────────────────────

  /// The two halves of §8.4, on the one edge that produces both.
  ///
  /// ── Leaving `connected`: unacked sends go back in the queue ───────────
  ///
  /// Nothing will ever settle a send that was awaiting an `ack` on a socket
  /// that is gone — the server does not re-send the reply. Left alone they
  /// stay [MessageDelivery.pending] for the life of the process: a spinner
  /// that never stops, for what is the commonest failure on a phone, where the
  /// frame reached the wire and the tunnel arrived before the reply did.
  ///
  /// They are put at the FRONT of [_outbox] rather than marked failed. Front,
  /// because they were composed before anything already waiting there, and
  /// FIFO is a claim about the order the customer typed in. Replaying one the
  /// server actually persisted is safe, and is why the ORIGINAL frame is what
  /// gets held: the server dedupes on the envelope id (D1, §9.3).
  ///
  /// This is the behaviour change from the first pass, which marked these
  /// [MessageDelivery.failed] and left the customer to press Retry. That was
  /// honest when there was no queue; with one, it is a message the SDK could
  /// have delivered and asked a human to deliver instead.
  ///
  /// ── Reaching `connected`: the queue drains ────────────────────────────
  ///
  /// In list order, onto the socket that has just come up. Written straight
  /// through rather than one-ack-at-a-time: writes on a single WebSocket
  /// arrive in the order they were made, so the order the customer typed in is
  /// preserved by the transport rather than by a second state machine here. An
  /// entry the write refuses stays queued, at the head, for the next
  /// connection — which is the invariant [_outbox] exists to hold.
  void _onConnectionState(ConnectionState state) {
    if (state == ConnectionState.connected) {
      _drainOutbox();
      return;
    }

    // Nobody is typing over a socket that is gone. Left alone the indicator
    // would sit there for the remainder of its timeout, and a reconnect that
    // takes longer than that (backoff reaches 30s) would show live typing
    // attributed to a connection that ended minutes ago.
    _typingController.reset();

    if (_pending.isEmpty) return;

    final List<_InFlightSend> orphans = _pending.values.toList();
    _pending.clear();
    _outbox.insertAll(0, orphans);
    for (final _InFlightSend orphan in orphans) {
      _emit(_messages, orphan.message.queued());
    }
  }

  /// Writes the queue to the live socket, oldest first.
  ///
  /// Each entry is removed only once [ConnectionController.send] has taken it,
  /// so a write that refuses stops the drain with the queue intact and in
  /// order. The alternative — clearing the list first and re-adding the
  /// failures — has a window in which a send the customer made is in neither
  /// place.
  void _drainOutbox() {
    while (_outbox.isNotEmpty) {
      final _InFlightSend entry = _outbox.first;
      if (!_connection.send(entry.frame)) return;
      _outbox.removeAt(0);
      _pending[entry.frame.id] = entry;
      _emit(_messages, entry.message);
    }
  }

  void _onFrame(ServerFrame frame) {
    switch (frame) {
      case AckSuccessFrame(:final String ref, :final Map<String, Object?> data):
        _settlePending(ref, data);
        break;
      case AckFailureFrame(:final String ref, :final ErrorPayload error):
        final _InFlightSend? inFlight = _pending.remove(ref);
        if (inFlight != null) {
          // The server's own verdict AND its §7.4 code ride on the failed
          // echo, so [retry] gates on the server's answer rather than on a
          // second copy of that table — and a host can state the reason it
          // shows the customer without calling [retry] to find it out.
          final ChatMessage failed = inFlight.message.failed(
            reason: SendFailureReason.rejected,
            retryable: error.retryable,
            code: error.code,
          );
          _failed[ref] = _FailedSend(inFlight.frame, failed);
          _emit(_messages, failed);
        }
        break;
      case PushFrame(:final String type, :final Map<String, Object?> d):
        _onPush(type, d);
        break;
      case ErrorFrame():
        // Surfaced on `errors` by the controller; nothing to apply here.
        break;
    }
  }

  void _settlePending(String ref, Map<String, Object?> data) {
    final _InFlightSend? inFlight = _pending.remove(ref);
    if (inFlight == null) return;
    final ChatMessage pending = inFlight.message;
    final Object? seq = data['seq'];
    if (seq is int) {
      _emit(_messages, pending.settled(seq: seq));
    } else if (seq is double && seq.isFinite) {
      _emit(_messages, pending.settled(seq: seq.toInt()));
    }
  }

  void _onPush(String type, Map<String, Object?> d) {
    switch (type) {
      case 'connection.ack':
        final SessionSnapshot session = ConnectionAck.fromJson(d).session;
        _sessionId = session.sessionId;
        _session = session;
        _emit(_sessions, session);
        break;
      case 'session.updated':
        final SessionSnapshot session = SessionSnapshot.fromJson(
          d['session']! as Map<String, Object?>,
          'd.session',
          frameType: type,
        );
        _sessionId = session.sessionId;
        _session = session;
        _emit(_sessions, session);
        break;
      case 'session.closed':
        _emit(_sessionClosed, SessionClosed.fromJson(d));
        break;
      case 'message.new':
        _emit(_messages, ChatMessage.fromJson(d, 'd', frameType: type));
        break;
      // Both frames go through [_typingController] rather than straight onto
      // the stream, because a `typing.stop` that never arrives has to be
      // manufactured from a timer — see `logic/typing.dart`.
      case 'typing.start':
        _typingController.applyStart(d['participantId'] as String?);
        break;
      case 'typing.stop':
        _typingController.applyStop(d['participantId'] as String?);
        break;
      case 'agent.joined':
      case 'agent.left':
        // One decoder for the one canonical identity shape: the same
        // HandledBy that arrives nested on a session snapshot arrives bare
        // here, so a host cannot see two different names for one participant.
        final HandledBy agent = HandledBy.fromJson(d, 'd', frameType: type);

        // THE discriminator, and the last place it exists. `agent.joined` and
        // `agent.left` carry byte-identical payloads; only `type` says which
        // happened, and it is not on the object about to go out on
        // [agentEvents]. So the session fold happens here — see
        // `agent_presence.dart` on why a consumer downstream of that stream
        // cannot do it, and why doing it there would put a departed agent's
        // name back on the header at the moment they walked away.
        final SessionSnapshot? folded = type == 'agent.joined'
            ? applyAgentJoined(_session, agent)
            : applyAgentLeft(_session, agent.id);

        // Session first, then the event — the order
        // `create-chat-client.ts:427` uses. A listener that reacts to the
        // event by reading state should find the state already moved.
        //
        // `identical` rather than a null check: `applyAgentLeft` returns the
        // SAME instance when the departing id is not the one on the header
        // (an agent who handed off and then dropped off), and re-emitting an
        // unchanged snapshot would repaint every session listener for an
        // event that changed nothing.
        if (folded != null && !identical(folded, _session)) {
          _session = folded;
          _emit(_sessions, folded);
        }
        _emit(_agentJoined, agent);
        break;
      case 'presence.update':
        _emit(_presence, PresenceEntry.fromJson(d, 'd', frameType: type));
        break;
      case 'message.delivered':
        _emit(_messageDelivered, MessageDelivered.fromJson(d));
        break;
      case 'ticket.linked':
        _emit(_ticketLinked, TicketLinked.fromJson(d));
        break;
      default:
        // `message.read`, plus any frame type a later protocol version adds.
        // A frame this client does not act on is not an error.
        //
        // `message.read` is not a gap. §9.5 puts the read watermark on
        // `ParticipantSnapshot.lastReadAt`, which rides every session
        // snapshot, so a read tick is already derivable with no stream of its
        // own — which is exactly what delivery had no equivalent of, and why
        // `message.delivered` needed one.
        //
        // `system.pong` does NOT arrive here. ConnectionController answers it
        // and returns without forwarding, so it never enters this router.
        break;
    }
  }

  void _emit<T>(StreamController<T> controller, T value) {
    if (!controller.isClosed) controller.add(value);
  }
}
