// The render half of `message-list.test.ts` — the assertions, not the DOM
// idioms. `retry.test.ts`'s transferable half is here too: what makes the
// fix correct is IDENTITY, that the object handed to `onRetry` is the one
// core gave the row, so a retry keyed on `message.id` can never mint a
// second message or send the placeholder-stripped string.
//
// The rest of `retry.test.ts` exercises `ChatClient.retryMessage`'s own
// refusal branches through a mounted widget; `widget_chat_client.dart` does
// not expose `retry()` yet (T10/T14 widen it), so those assertions belong to
// the node that adds it.

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const String _me = 'cus_1';
const String _agentId = 'agt_9';
final DateTime _at = DateTime.utc(2026, 8, 19, 10);

ChatMessage _msg({
  required String id,
  String content = 'where is my order',
  SenderType senderType = SenderType.customer,
  int? seq,
  MessageDelivery delivery = MessageDelivery.confirmed,
  Map<String, Object?>? metadata,
  AttachmentMetadata? attachment,
}) {
  return ChatMessage(
    id: id,
    sessionId: 's1',
    senderId: senderType == SenderType.customer ? _me : _agentId,
    senderType: senderType,
    type: MessageType.text,
    content: content,
    seq: seq,
    createdAt: _at,
    delivery: delivery,
    metadata: metadata,
    attachment: attachment,
  );
}

class _Recorder {
  final List<ChatMessage> retried = <ChatMessage>[];
  final List<String> quickReplies = <String>[];
  final List<String> opened = <String>[];
  final List<(String, String)> replies = <(String, String)>[];
  final List<ChatMessage> copied = <ChatMessage>[];

  MessageListCallbacks get callbacks => MessageListCallbacks(
        onRetry: retried.add,
        onCopyMessage: (ChatMessage message) async => copied.add(message),
        onReplyToMessage: (ChatMessage message, String senderName) =>
            replies.add((message.id, senderName)),
        onQuickReply: quickReplies.add,
        onOpenLink: opened.add,
      );
}

Future<_Recorder> _pump(
  WidgetTester tester,
  MessageListInputs inputs, {
  MessageListPresenter? presenter,
  /// `false` for anything that renders the typing bubble. Its dots loop
  /// forever by design, so `pumpAndSettle` — which pumps until no frame is
  /// scheduled — never returns.
  bool settle = true,
}) async {
  final _Recorder recorder = _Recorder();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          height: 600,
          child: MessageListView(
            inputs: inputs,
            callbacks: recorder.callbacks,
            presenter: presenter,
          ),
        ),
      ),
    ),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    // Two frames: the first mounts, the second runs the post-frame callback
    // that mount scheduled (the scroll anchor and the announcement).
    await tester.pump();
    await tester.pump();
  }
  return recorder;
}

void main() {
  testWidgets('renders message text as text, never as markup',
      (WidgetTester tester) async {
    // This string is another user's input arriving over a socket.
    const String hostile = '<img src=x onerror=alert(1)>';
    await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[_msg(id: 'a', content: hostile)],
        localParticipantId: _me,
      ),
    );
    expect(find.text(hostile), findsOneWidget);
  });

  testWidgets('links are tappable and carry the matched text verbatim',
      (WidgetTester tester) async {
    final _Recorder recorder = await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[
          _msg(
            id: 'a',
            senderType: SenderType.agent,
            content: 'track it at https://example.com/orders/7 today',
          ),
        ],
        localParticipantId: _me,
      ),
    );

    final RichText rich = tester.widget<RichText>(
      find.descendant(
        of: find.byType(LinkifiedText),
        matching: find.byType(RichText),
      ),
    );
    // The matched substring, verbatim — never the resolved href.
    expect(rich.text.toPlainText(), contains('https://example.com/orders/7'));
    expect(recorder.opened, isEmpty);
  });

  testWidgets('a failure states its reason; a retryable one also offers Retry',
      (WidgetTester tester) async {
    final _Recorder recorder = await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[
          _msg(
            id: 'a',
            delivery: const MessageFailed(
              reason: SendFailureReason.rejected,
              retryable: true,
            ),
          ),
        ],
        localParticipantId: _me,
      ),
    );

    expect(find.text('This message could not be sent.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    // No tick: it would claim something untrue about a message that will
    // never arrive.
    expect(find.text('Sent'), findsNothing);

    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(recorder.retried, hasLength(1));
    expect(recorder.retried.single.id, 'a');
  });

  testWidgets('bug #4: a non-retryable failure states why, with no button',
      (WidgetTester tester) async {
    await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[
          _msg(
            id: 'a',
            delivery: const MessageFailed(
              reason: SendFailureReason.sessionClosed,
              retryable: false,
            ),
          ),
        ],
        localParticipantId: _me,
      ),
    );

    expect(
      find.text('This conversation ended before this message could send.'),
      findsOneWidget,
    );
    // Absent from the tree entirely, not merely styled away: a control the
    // customer can reach and press must be one that can work.
    expect(find.text('Retry'), findsNothing);
  });

  testWidgets('retry is handed the REAL message, placeholder and all',
      (WidgetTester tester) async {
    const String url = 'https://cdn.example.com/receipts/receipt.png';
    final _Recorder recorder = await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[
          _msg(
            id: 'att-1',
            content: url,
            delivery: const MessageFailed(
              reason: SendFailureReason.rejected,
              retryable: true,
            ),
            attachment: const AttachmentMetadata(
              url: url,
              fileName: 'receipt.png',
              mimeType: 'image/png',
              size: 10,
              mediaType: 'image',
            ),
          ),
        ],
        localParticipantId: _me,
      ),
    );

    // Confirms the §12.10 suppression really did fire on this fixture.
    expect(find.text(url), findsNothing);

    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(recorder.retried.single.id, 'att-1');
    expect(recorder.retried.single.content, url);
    expect(recorder.retried.single.attachment, isNotNull);
  });

  testWidgets('the tick carries its word, not just its glyph',
      (WidgetTester tester) async {
    await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[_msg(id: 'a', seq: 5)],
        localParticipantId: _me,
        deliveredWatermarks: const <String, int>{_agentId: 5},
      ),
    );
    expect(find.text('Delivered'), findsOneWidget);
  });

  testWidgets('names the first bubble of a run and every incoming avatar',
      (WidgetTester tester) async {
    await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[
          _msg(id: 'a', senderType: SenderType.agent, content: 'one'),
          _msg(id: 'b', senderType: SenderType.agent, content: 'two'),
          _msg(id: 'c', content: 'mine'),
        ],
        localParticipantId: _me,
      ),
    );

    // One heading for the run of two...
    expect(find.text('Agent'), findsOneWidget);
    // ...but an avatar on each of its rows, and none on the customer's own.
    expect(find.byType(MessageAvatar), findsNWidgets(2));
    expect(find.text('A'), findsNWidgets(2));
  });

  testWidgets('draws the reply quote from the message\'s own metadata',
      (WidgetTester tester) async {
    await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[
          _msg(
            id: 'a',
            senderType: SenderType.agent,
            content: 'on its way',
            metadata: const <String, Object?>{
              'kind': 'reply',
              'replyTo': <String, Object?>{
                'senderName': 'You',
                'excerpt': 'where is my order',
              },
            },
          ),
        ],
        localParticipantId: _me,
      ),
    );
    expect(find.text('where is my order'), findsOneWidget);
    expect(find.text('on its way'), findsOneWidget);
  });

  testWidgets('renders the handoff-filtered chip row under the newest bot row',
      (WidgetTester tester) async {
    final _Recorder recorder = await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[
          _msg(
            id: 'a',
            senderType: SenderType.bot,
            content: 'How can I help?',
            metadata: const <String, Object?>{
              'options': <Object?>['Track my order', 'Talk to a human'],
            },
          ),
        ],
        localParticipantId: _me,
        handoffKeywords: const <String>['human', 'agent'],
      ),
    );

    expect(find.text('Track my order'), findsOneWidget);
    // The removed handoff button must not come back as an LLM-authored chip.
    expect(find.text('Talk to a human'), findsNothing);

    await tester.tap(find.text('Track my order'));
    await tester.pump();
    expect(recorder.quickReplies, <String>['Track my order']);
  });

  testWidgets('says "no messages yet" only once it knows there are none',
      (WidgetTester tester) async {
    const String empty = 'No messages yet. Ask us anything about your order.';
    await _pump(
      tester,
      const MessageListInputs(messages: <ChatMessage>[]),
    );
    expect(find.text(empty), findsNothing);

    await _pump(
      tester,
      const MessageListInputs(messages: <ChatMessage>[], initialLoaded: true),
    );
    expect(find.text(empty), findsOneWidget);
  });

  testWidgets('the typing row names the handler rather than "Agent"',
      (WidgetTester tester) async {
    await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[_msg(id: 'a')],
        localParticipantId: _me,
        isTyping: true,
        session: SessionSnapshot(
          sessionId: 's1',
          status: ChatStatus.open,
          mode: ChatMode.bot,
          participants: const <ParticipantSnapshot>[],
          createdAt: _at,
          handledBy: const HandledBy(
            kind: HandledByKind.bot,
            id: 'bot_1',
            displayName: 'Kai',
          ),
        ),
      ),
      settle: false,
    );
    expect(
      find.byWidgetPredicate(
        (Widget widget) =>
            widget is Semantics && widget.properties.label == 'Kai is typing',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a host with no per-message replay draws no Retry button',
      (WidgetTester tester) async {
    // `WidgetChatClient` does not expose `ChatClient.retry()` yet, and its
    // `retryNow()` is a CONNECTION retry. A button wired to that would be
    // the same lie in a new place, so the reason is stated with no control
    // beside it — exactly as for a non-retryable failure.
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 600,
            child: MessageListView(
              inputs: MessageListInputs(
                messages: <ChatMessage>[
                  _msg(
                    id: 'a',
                    delivery: const MessageFailed(
                      reason: SendFailureReason.rejected,
                      retryable: true,
                    ),
                  ),
                ],
                localParticipantId: _me,
              ),
              callbacks: MessageListCallbacks(
                onCopyMessage: (ChatMessage _) async {},
                onQuickReply: (String _) {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('This message could not be sent.'), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
  });

  testWidgets('a host with nowhere to put a draft offers no Reply item',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 600,
            child: MessageListView(
              inputs: MessageListInputs(
                messages: <ChatMessage>[_msg(id: 'a')],
                localParticipantId: _me,
              ),
              callbacks: MessageListCallbacks(
                onCopyMessage: (ChatMessage _) async {},
                onQuickReply: (String _) {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.more_horiz));
    await tester.pumpAndSettle();
    // Copy always works — the clipboard is this package's to reach.
    expect(find.text('Copy'), findsOneWidget);
    expect(find.text('Reply'), findsNothing);
  });

  testWidgets('every row offers Copy and Reply, and Reply carries the name',
      (WidgetTester tester) async {
    final _Recorder recorder = await _pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[
          _msg(id: 'a', senderType: SenderType.agent, content: 'hello'),
        ],
        localParticipantId: _me,
      ),
    );

    await tester.tap(find.byIcon(Icons.more_horiz));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reply'));
    await tester.pumpAndSettle();

    // The name rides along because only the transcript can resolve it — a
    // ChatMessage carries no display name at all.
    expect(recorder.replies, <(String, String)>[('a', 'Agent')]);
  });
}
