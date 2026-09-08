/// The narrow slice of `ChatClient` the widget layer actually depends on.
///
/// ── Why this exists instead of depending on ChatClient directly ─────────
///
/// `ChatClient`'s real surface is wider than any one screen needs — presence,
/// `leaveSession`, `dispose`, `stopTyping` — and
/// constructing a real one for a test means driving a full §7/§8 handshake
/// through a fake socket. `dhaam_chat`'s OWN test suite does exactly that
/// (`test/fakes.dart`'s `FakeSocket` + `FakeScheduler`), and that is the
/// right tool for testing the PROTOCOL. It is the wrong tool for testing
/// "does this Cubit correctly merge two `ChatMessage`s that share an id" —
/// that question has nothing to do with envelope encoding or the connect
/// handshake. Narrowing to what this layer actually calls is what lets
/// `ChatWidgetCubit` be tested against a five-line fake instead of a
/// simulated WebSocket.
///
/// This is not a hypothetical seam: [ChatClientAdapter] below is the real
/// implementation (wrapping a live [ChatClient] by delegation) and the test
/// suite's fake is the second — codebase-design's "two adapters means a
/// real one."
library;

import 'package:dhaam_chat/dhaam_chat.dart';

abstract interface class WidgetChatClient {
  ConnectionState get connectionState;
  Stream<ConnectionState> get connectionStates;
  Stream<ChatMessage> get messages;
  Stream<SessionSnapshot> get sessions;
  Stream<TypingEvent> get typing;

  /// Who is currently shown as typing, least recently active first.
  ///
  /// Read INSTEAD OF folding [typing]'s events by hand. Each event carries one
  /// participant's flag, so a consumer that collapses the stream by reading
  /// `event.isTyping` clears the indicator when agent A stops even though
  /// agent B is still typing — the multi-participant bug `TypingController`'s
  /// map exists to prevent, reintroduced by whoever folds it wrong.
  List<String> get typingParticipants;

  /// One event per scheduled reconnect (§6.5).
  ///
  /// The one input no state snapshot carries. `connectionState` cycles
  /// `connecting → reconnecting → connecting` indefinitely, so it says whether
  /// an attempt is in flight but never how many have already failed — and that
  /// missing number is the whole difference between a healthy first connect
  /// and an outage worth putting a banner up for.
  Stream<ReconnectingEvent> get reconnecting;

  /// How many composed messages are held for the connection to come back.
  ///
  /// The number the offline banner names. Counts only sends that will go out
  /// by themselves; a send the server REFUSED is not in here, because
  /// promising its delivery would be a lie.
  int get queuedCount;

  Future<void> connect();

  /// Abandons an armed reconnect backoff and attempts immediately, returning
  /// whether an attempt actually started.
  ///
  /// A no-op outside [ConnectionState.reconnecting] — see
  /// `ChatClient.retryNow`. Safe to call on a cadence, which is exactly what
  /// [ChatWidgetCubit] does with it.
  bool retryNow();

  /// Sends [content] and returns the optimistic local echo immediately —
  /// see `ChatClient.sendMessage` for why there is no `Future` here.
  ///
  /// [metadata] is the STRUCTURED copy of whatever the message says in
  /// prose, and it is not decoration: chat-service reads
  /// `{kind: 'pre_chat', answers}` server-side and folds the answers into a
  /// CUSTOMER-ASSERTED contact on the session (fill-empty only, marked
  /// `source: 'pre_chat'`). Without it the pre-chat answers reach the agent
  /// as text and nothing else — the lines are read, the contact is never
  /// created. The reference sends both halves in one frame
  /// (`widget.ts`'s `sendPreChatDetails`) and so does this.
  ///
  /// Absent, never `{}`: an empty map asserts a structured claim was made
  /// and was empty, which is a different statement from making none.
  ///
  /// [attachment] is the uploaded file this message announces — the url,
  /// name, media type and size `POST /upload` echoed back — and [type] is
  /// what kind of message it therefore is. Both ride on the frame, so a send
  /// held for the connection to come back replays them unchanged.
  ///
  /// ── Why these two arrived together ───────────────────────────────────
  ///
  /// `ChatClient.sendMessage` has accepted both since D26 and this interface
  /// exposed neither, which meant the whole attachment path — the paperclip,
  /// the 25 MiB refusal, the draft bar, `POST /upload`, all of it tested —
  /// ended at a callback holding metadata with nowhere to put it. A customer
  /// could pick a file, watch it upload, and send a message that mentioned
  /// no file at all.
  ///
  /// They arrive as a pair rather than one at a time because §12.10's shape
  /// needs both at once: an attachment message carries the URL as its
  /// `content` AND a [MessageType] derived from the media type. An
  /// `attachment` exposed without a `type` would put an image on the wire
  /// as `TEXT`, which no other client in this system produces — see
  /// `ChatWidgetCubit.sendAttachment`, the one caller that passes them.
  ///
  /// Null omits the attachment key entirely, exactly as [metadata] does, and
  /// [type] defaults to what every existing caller already sends, so no
  /// existing caller changes behaviour.
  ChatMessage sendMessage(
    String content, {
    MessageType type = MessageType.text,
    String? replyToMessageId,
    Map<String, Object?>? metadata,
    AttachmentMetadata? attachment,
  });

  /// Joins an existing session — the Messages/Home "open this past
  /// conversation" path. See `ChatClient.joinSession` on why this does not
  /// move the UI until the server's own snapshot confirms it.
  void joinSession(String sessionId);

  void markRead({String? upToMessageId});

  /// Signals that the local user started typing (§6.3).
  ///
  /// ── Why there is no `stopTyping` beside it ──────────────────────────────
  ///
  /// Not an oversight and not asymmetry for its own sake. `ChatClient` pairs
  /// nothing with `stopTyping`: both methods are unmediated single-frame
  /// sends, with no debounce, no auto-stop timer and no coordinator holding
  /// state that a missing stop would leave unbalanced — unlike the TypeScript
  /// core, where both go through `presenceCoordinator.typing`. And the
  /// reference widget, which is what this layer ports, **never calls
  /// `stopTyping` at all** (`grep -rn stopTyping packages/widget/src` is
  /// empty): the remote indicator clears on the receiver's own timeout, not
  /// on a frame from here.
  ///
  /// So exposing it would add a member with no producer and no consumer —
  /// the same emptiness `TicketLinked` wore before it was surfaced, and the
  /// same emptiness [retry] wore while `MessageDelivery` could not answer for
  /// it. This interface's whole purpose is to be what this layer actually
  /// calls. When a caller for a stop appears, it is one line here and one in
  /// the adapter.
  void startTyping();

  /// One event per `session.closed` push (§12.5).
  ///
  /// The one fact no session snapshot can carry: a snapshot says a session is
  /// CLOSED, and `CloseReason.switched` says it was PARKED rather than ended
  /// — the customer moved to another active conversation, and nobody
  /// resolved this one. Both readings arrive as the same `ChatStatus.closed`,
  /// so a widget with only the snapshot has to guess, and guessing wrong
  /// puts a satisfaction survey and an "This conversation has ended" footer
  /// over a conversation that is merely on hold.
  ///
  /// Not derivable from [sessions] at all: the reason rides on this frame and
  /// on nothing else.
  Stream<SessionClosed> get sessionClosed;

  /// Agent arrival and departure (§7.3).
  ///
  /// ── What this stream can and cannot tell you ────────────────────────────
  ///
  /// `ChatClient` decodes `agent.joined` and `agent.left` through the SAME
  /// [HandledBy] decoder onto the SAME stream, so an event says WHO but not
  /// WHETHER they arrived or left. That is deliberate on its side — one
  /// canonical identity shape, so a header and a toast can never disagree
  /// about a name — but it means this stream alone cannot drive an identity
  /// header: reading an `agent.left` as an arrival would put the departed
  /// agent's name back on the header at the moment they walked away.
  ///
  /// The authority for "who is handling this conversation" is therefore
  /// [SessionSnapshot.status] + [SessionSnapshot.handledBy], read through
  /// `isHandledByCurrent` — which is exactly what the reference does too
  /// (`widget.ts` folds both frames into its session state and the header
  /// renders from that, never from the frames). Use this stream for things
  /// that are about the EVENT rather than the state: a chime, a toast.
  Stream<AgentEvent> get agentEvents;

  /// Every §6.5 protocol error the connection reports, as it reports it.
  ///
  /// ── Why this is on the narrow interface at all ──────────────────────────
  ///
  /// It was not, and the cost was concrete: a developer pointing the SDK at a
  /// misconfigured endpoint saw the client reconnect forever with nothing
  /// naming the cause. `AUTH_INVALID`, `VALIDATION_FAILED` and a refused
  /// protocol version all look identical from outside — a panel that says
  /// "Connecting…" and never stops. The failure is REPORTED by `ChatClient`;
  /// it simply had no route to a widget.
  ///
  /// Not every error here is fatal — the connection may recover on the next
  /// attempt — so this is diagnostic, not a reason to tear the UI down. Pair
  /// it with [suspendReason], which says when the client has actually given up.
  Stream<ErrorPayload> get errors;

  /// Why the client stopped trying, or null while it is still trying.
  ///
  /// The difference between "this is slow" and "this will never work", which
  /// [ConnectionState.suspended] alone cannot express: an exhausted auth
  /// cap and a refused protocol version are both terminal and want opposite
  /// messages in front of a customer.
  SuspendReason? get suspendReason;

  /// Replays ONE failed send under its original envelope id (§9.3, D1).
  ///
  /// Not [retryNow], which is the connection's backoff and says nothing about
  /// any particular message. Wiring a per-message Retry button to that one
  /// would be a control that cannot do what its label says.
  ///
  /// ── Why this returns the outcome instead of a `bool` or nothing ────────
  ///
  /// Because a refusal is an expected result a caller has to be able to tell
  /// apart, and the three reasons are not interchangeable.
  /// [RetryRefusalReason.notRetryable] should never be seen by a host that
  /// gates its button on [MessageFailed.retryable] — the same flag rides on
  /// the message. [RetryRefusalReason.disconnected] cannot be predicted that
  /// way at all: a connection can drop between drawing the button and the
  /// press, and "it failed again" is the wrong thing to say about an attempt
  /// that never left the device.
  ///
  /// A success needs no reporting: the client re-emits the message as
  /// [MessagePending] on [messages], so the transcript's failure line and
  /// Retry button both clear by themselves.
  RetryOutcome retry(String messageId);
}

/// Wraps a real [ChatClient] to satisfy [WidgetChatClient] by delegation.
///
/// A wrapper rather than having `ChatClient` `implements` this directly,
/// because `packages/dart` is not modified by this package — see this
/// package's README on that boundary.
class ChatClientAdapter implements WidgetChatClient {
  ChatClientAdapter(this._client);

  final ChatClient _client;

  @override
  ConnectionState get connectionState => _client.connectionState;

  @override
  Stream<ConnectionState> get connectionStates => _client.connectionStates;

  @override
  Stream<ChatMessage> get messages => _client.messages;

  @override
  Stream<SessionSnapshot> get sessions => _client.sessions;

  @override
  Stream<TypingEvent> get typing => _client.typing;

  @override
  List<String> get typingParticipants => _client.typingParticipants;

  @override
  Stream<ReconnectingEvent> get reconnecting => _client.reconnecting;

  @override
  int get queuedCount => _client.queuedCount;

  @override
  Future<void> connect() => _client.connect();

  @override
  bool retryNow() => _client.retryNow();

  @override
  ChatMessage sendMessage(
    String content, {
    MessageType type = MessageType.text,
    String? replyToMessageId,
    Map<String, Object?>? metadata,
    AttachmentMetadata? attachment,
  }) =>
      _client.sendMessage(
        content,
        type: type,
        replyToMessageId: replyToMessageId,
        metadata: metadata,
        attachment: attachment,
      );

  @override
  void joinSession(String sessionId) => _client.joinSession(sessionId);

  @override
  void markRead({String? upToMessageId}) =>
      _client.markRead(upToMessageId: upToMessageId);

  @override
  void startTyping() => _client.startTyping();

  @override
  Stream<SessionClosed> get sessionClosed => _client.sessionClosed;

  @override
  Stream<AgentEvent> get agentEvents => _client.agentEvents;

  @override
  Stream<ErrorPayload> get errors => _client.errors;

  @override
  SuspendReason? get suspendReason => _client.suspendReason;

  @override
  RetryOutcome retry(String messageId) => _client.retry(messageId);
}
