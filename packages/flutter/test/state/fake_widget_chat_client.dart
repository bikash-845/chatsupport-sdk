// A hand-driven WidgetChatClient — no socket, no handshake, no envelope
// encoding. This is the payoff of narrowing ChatWidgetCubit's dependency to
// WidgetChatClient instead of the concrete ChatClient: testing "does the
// Cubit merge two messages with the same id" does not require simulating
// dhaam_chat's §7/§8 protocol at all. See widget_chat_client.dart's header.

import 'dart:async';

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';

class FakeWidgetChatClient implements WidgetChatClient {
  final StreamController<ConnectionState> _connectionStates =
      StreamController<ConnectionState>.broadcast();
  final StreamController<ChatMessage> _messages =
      StreamController<ChatMessage>.broadcast();
  final StreamController<SessionSnapshot> _sessions =
      StreamController<SessionSnapshot>.broadcast();
  final StreamController<TypingEvent> _typing =
      StreamController<TypingEvent>.broadcast();
  final StreamController<ReconnectingEvent> _reconnecting =
      StreamController<ReconnectingEvent>.broadcast();

  ConnectionState _state = ConnectionState.idle;
  int connectCalls = 0;

  /// Every state `retryNow()` was called in, oldest first — so a test can
  /// assert both that it fired and that it fired where it was meant to.
  final List<ConnectionState> retryNowCalls = <ConnectionState>[];

  /// What `retryNow()` reports. Defaults to the real contract: it acts only
  /// while a backoff is armed, and a fake that always claimed success would
  /// let a caller that fires in the wrong state pass.
  bool retryNowSucceeds = true;

  /// What `queuedCount` reports. Set by a test standing in for an outbox.
  int queued = 0;
  final List<String> joinedSessionIds = <String>[];
  final List<String> sentContent = <String>[];

  /// The `metadata` each send carried, index-aligned with [sentContent] —
  /// null where a send carried none, which is a different fact from `{}`.
  final List<Map<String, Object?>?> sentMetadata = <Map<String, Object?>?>[];

  /// The `replyToMessageId` each send carried, index-aligned with
  /// [sentContent] — null where the send addressed no message.
  final List<String?> sentReplyToMessageId = <String?>[];

  /// The `attachment` each send carried, index-aligned with [sentContent] —
  /// null where the send announced no file.
  final List<AttachmentMetadata?> sentAttachment = <AttachmentMetadata?>[];

  /// The `type` each send carried, index-aligned with [sentContent].
  ///
  /// Worth recording rather than assuming: §12.10's attachment message is
  /// distinguished from a text one by this field and by nothing else on the
  /// frame, so a send that got the type wrong would otherwise look identical
  /// to a correct one in every assertion.
  final List<MessageType> sentType = <MessageType>[];

  /// Every `session.closed` a test pushed, oldest first.
  final StreamController<SessionClosed> _sessionClosed =
      StreamController<SessionClosed>.broadcast();
  final StreamController<AgentEvent> _agentEvents =
      StreamController<AgentEvent>.broadcast();
  final StreamController<ErrorPayload> _errors =
      StreamController<ErrorPayload>.broadcast();

  /// What `suspendReason` reports. Set by a test standing in for a client
  /// that has given up.
  SuspendReason? suspended;
  final List<String?> markReadCalls = <String?>[];

  /// How many outbound typing signals went out.
  int startTypingCalls = 0;

  /// Set to make `startTyping()` throw — the race a connected-state check
  /// cannot close. A keystroke must survive it.
  Object? startTypingThrows;

  @override
  ConnectionState get connectionState => _state;
  @override
  Stream<ConnectionState> get connectionStates => _connectionStates.stream;
  @override
  Stream<ChatMessage> get messages => _messages.stream;
  @override
  Stream<SessionSnapshot> get sessions => _sessions.stream;
  @override
  Stream<TypingEvent> get typing => _typing.stream;

  /// What `typingParticipants` reports. A test drives this directly, because
  /// the fold it stands in for lives in `dhaam_chat`'s TypingController and is
  /// tested there — what matters here is that the cubit READS it rather than
  /// folding the stream itself.
  List<String> typers = <String>[];

  @override
  List<String> get typingParticipants => typers;
  @override
  Stream<ReconnectingEvent> get reconnecting => _reconnecting.stream;
  @override
  int get queuedCount => queued;

  @override
  Future<void> connect() async {
    connectCalls += 1;
  }

  @override
  bool retryNow() {
    retryNowCalls.add(_state);
    if (!retryNowSucceeds || _state != ConnectionState.reconnecting) {
      return false;
    }
    emitConnectionState(ConnectionState.connecting);
    return true;
  }

  @override
  Stream<SessionClosed> get sessionClosed => _sessionClosed.stream;

  @override
  Stream<AgentEvent> get agentEvents => _agentEvents.stream;

  @override
  Stream<ErrorPayload> get errors => _errors.stream;

  @override
  SuspendReason? get suspendReason => suspended;

  @override
  ChatMessage sendMessage(
    String content, {
    MessageType type = MessageType.text,
    String? replyToMessageId,
    Map<String, Object?>? metadata,
    AttachmentMetadata? attachment,
  }) {
    sentContent.add(content);
    sentMetadata.add(metadata);
    sentReplyToMessageId.add(replyToMessageId);
    sentAttachment.add(attachment);
    sentType.add(type);
    final ChatMessage message = ChatMessage(
      id: 'sent-${sentContent.length}',
      sessionId: 's1',
      senderId: '',
      senderType: SenderType.customer,
      type: type,
      content: content,
      seq: null,
      createdAt: DateTime.utc(2026, 1, 1),
      replyToMessageId: replyToMessageId,
      metadata: metadata,
      // On the echo as well as on the record of the call: the real client
      // puts it there (`client.dart`'s optimistic echo describes the frame it
      // actually sent), so a fake that dropped it would let a transcript bug
      // — an attachment bubble that never draws — pass every widget test.
      attachment: attachment,
      delivery: MessageDelivery.pending,
    );
    _messages.add(message);
    return message;
  }

  @override
  void joinSession(String sessionId) => joinedSessionIds.add(sessionId);

  @override
  void markRead({String? upToMessageId}) => markReadCalls.add(upToMessageId);

  /// Every message id `retry()` was asked to replay, oldest first.
  final List<String> retriedIds = <String>[];

  /// What `retry()` reports.
  ///
  /// Defaults to a REFUSAL, matching the real contract for an id with no
  /// failure record — and for the same reason `retryNowSucceeds` defaults to
  /// the real thing rather than to yes: a fake that always claimed success
  /// would let a caller that ignores the outcome pass.
  RetryOutcome retryOutcome = const RetryRefused(RetryRefusalReason.notFound);

  @override
  RetryOutcome retry(String messageId) {
    retriedIds.add(messageId);
    return retryOutcome;
  }

  @override
  void startTyping() {
    if (startTypingThrows != null) throw startTypingThrows!;
    startTypingCalls += 1;
  }

  // ── Test-only inbound simulation ─────────────────────────────────────

  void emitConnectionState(ConnectionState next) {
    _state = next;
    _connectionStates.add(next);
  }

  void emitMessage(ChatMessage message) => _messages.add(message);

  void emitSession(SessionSnapshot session) => _sessions.add(session);

  /// One typing event, with [typers] kept consistent with it.
  ///
  /// The real client cannot emit `isTyping: true` while nobody is in its
  /// per-participant map — the event IS that map changing. A fake that let
  /// the two disagree would model a state the protocol client cannot reach,
  /// and every test written against it would be testing fiction.
  ///
  /// Set [typers] directly before calling this when a test needs the
  /// multi-participant case, where the map is exactly what the single flag
  /// cannot express.
  void emitTyping(bool isTyping, {String participantId = 'agent-1'}) {
    if (isTyping) {
      if (!typers.contains(participantId)) {
        typers = <String>[...typers, participantId];
      }
    } else {
      typers = typers.where((String id) => id != participantId).toList();
    }
    _typing.add(TypingEvent(isTyping: isTyping, participantId: participantId));
  }

  /// One scheduled-retry event, as `ChatClient` emits per backoff arming.
  void emitReconnecting(
          {int attempt = 0,
          Duration delay = const Duration(milliseconds: 500)}) =>
      _reconnecting.add(ReconnectingEvent(attempt: attempt, delay: delay));

  /// One `session.closed` push, as `ChatClient.sessionClosed` emits.
  void emitSessionClosed(String sessionId, CloseReason closeReason) =>
      _sessionClosed.add(
        SessionClosed(sessionId: sessionId, closeReason: closeReason),
      );

  /// One `agent.joined`/`agent.left` frame. Both arrive as a bare [HandledBy]
  /// on the same stream — see `WidgetChatClient.agentEvents` on why that means
  /// this cannot say which of the two it was.
  void emitAgentEvent(AgentEvent event) => _agentEvents.add(event);

  /// One §6.5 protocol error, as `ChatClient.errors` emits.
  void emitError(ErrorPayload error) => _errors.add(error);

  Future<void> dispose() async {
    await _sessionClosed.close();
    await _agentEvents.close();
    await _errors.close();
    await _reconnecting.close();
    await _connectionStates.close();
    await _messages.close();
    await _sessions.close();
    await _typing.close();
  }
}

/// A minimal, otherwise-default ChatMessage for tests that only care about
/// id/content.
ChatMessage testMessage({
  required String id,
  String content = 'hello',
  int? seq,
  MessageDelivery delivery = MessageDelivery.confirmed,
  SenderType senderType = SenderType.agent,
  Map<String, Object?>? metadata,
}) {
  return ChatMessage(
    id: id,
    sessionId: 's1',
    senderId: senderType == SenderType.customer ? '' : 'agent-1',
    senderType: senderType,
    type: MessageType.text,
    content: content,
    seq: seq,
    createdAt: DateTime.utc(2026, 1, 1),
    delivery: delivery,
    metadata: metadata,
  );
}

/// A minimal SessionSnapshot for tests.
///
/// [handledBy] defaults to absent, which is what a snapshot carries when
/// nobody has picked the session up yet — see `HandledBy`'s own header on why
/// that absence is presentation-only.
SessionSnapshot testSession({
  String id = 's1',
  ChatStatus status = ChatStatus.open,
  HandledBy? handledBy,
}) {
  return SessionSnapshot(
    sessionId: id,
    status: status,
    mode: ChatMode.human,
    participants: const <ParticipantSnapshot>[],
    createdAt: DateTime.utc(2026, 1, 1),
    handledBy: handledBy,
  );
}
