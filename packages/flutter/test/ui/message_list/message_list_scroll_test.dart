// The scroll anchor, and the two ways a Flutter port can get it wrong that
// the DOM original could not.
//
// `message-list.ts` runs `render()` only when state changed, so "was the
// user at the bottom" could be captured unconditionally. A Flutter widget
// rebuilds for reasons that have nothing to do with the transcript — a theme
// change, a keyboard opening, a parent rebuilding — and following the newest
// message down on one of those would yank a customer who had scrolled up to
// re-read something.

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final DateTime _at = DateTime.utc(2026, 8, 19, 10);

ChatMessage _msg(int index) {
  return ChatMessage(
    id: 'm$index',
    sessionId: 's1',
    senderId: 'agt_9',
    senderType: SenderType.agent,
    type: MessageType.text,
    content: 'message number $index',
    seq: index,
    createdAt: _at,
  );
}

MessageListCallbacks _callbacks() {
  return MessageListCallbacks(
    onRetry: (ChatMessage _) {},
    onCopyMessage: (ChatMessage _) async {},
    onReplyToMessage: (ChatMessage _, String __) {},
    onQuickReply: (String _) {},
  );
}

/// A rebuild that changes the theme but NOT the inputs — the thing a DOM
/// `render()` never had to survive.
class _Harness extends StatefulWidget {
  const _Harness({required this.inputs});

  final MessageListInputs inputs;

  @override
  State<_Harness> createState() => _HarnessState();
}

class _HarnessState extends State<_Harness> {
  Color _seed = Colors.blue;
  late MessageListInputs _inputs = widget.inputs;

  void repaint() => setState(() => _seed = Colors.green);

  void supply(MessageListInputs inputs) => setState(() => _inputs = inputs);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData(colorSchemeSeed: _seed),
      home: Scaffold(
        body: SizedBox(
          height: 300,
          child: MessageListView(inputs: _inputs, callbacks: _callbacks()),
        ),
      ),
    );
  }
}

void main() {
  Future<_HarnessState> pump(
    WidgetTester tester,
    MessageListInputs inputs,
  ) async {
    await tester.pumpWidget(_Harness(inputs: inputs));
    if (inputs.isTyping) {
      // The typing dots loop by design, so `pumpAndSettle` — which pumps
      // until no frame is scheduled — never returns on a frame that draws
      // them. Two pumps: mount, then the post-frame callback mount queued.
      await tester.pump();
      await tester.pump();
    } else {
      await tester.pumpAndSettle();
    }
    return tester.state<_HarnessState>(find.byType(_Harness));
  }

  testWidgets('opens at the newest end', (WidgetTester tester) async {
    await pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
      ),
    );
    final ScrollableState scrollable =
        tester.state<ScrollableState>(find.byType(Scrollable));
    expect(
      isNearBottom(
        pixels: scrollable.position.pixels,
        maxScrollExtent: scrollable.position.maxScrollExtent,
      ),
      isTrue,
    );
  });

  testWidgets('a rebuild that brought no new messages does not scroll',
      (WidgetTester tester) async {
    final _HarnessState harness = await pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
      ),
    );

    // The customer scrolls up to re-read something.
    await tester.drag(find.byType(ListView), const Offset(0, 600));
    await tester.pumpAndSettle();
    final ScrollableState afterDrag =
        tester.state<ScrollableState>(find.byType(Scrollable));
    final double readingAt = afterDrag.position.pixels;
    expect(
      isNearBottom(
        pixels: readingAt,
        maxScrollExtent: afterDrag.position.maxScrollExtent,
      ),
      isFalse,
    );

    harness.repaint();
    await tester.pumpAndSettle();

    expect(
      tester.state<ScrollableState>(find.byType(Scrollable)).position.pixels,
      readingAt,
    );
  });

  testWidgets('a new message does not drag a customer who scrolled up',
      (WidgetTester tester) async {
    final _HarnessState harness = await pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
      ),
    );

    await tester.drag(find.byType(ListView), const Offset(0, 600));
    await tester.pumpAndSettle();
    final double readingAt =
        tester.state<ScrollableState>(find.byType(Scrollable)).position.pixels;

    harness.supply(
      MessageListInputs(
        messages: <ChatMessage>[for (int i = 0; i < 41; i += 1) _msg(i)],
      ),
    );
    await tester.pumpAndSettle();

    expect(
      tester.state<ScrollableState>(find.byType(Scrollable)).position.pixels,
      readingAt,
    );
  });

  testWidgets('a new message DOES follow a customer who was at the bottom',
      (WidgetTester tester) async {
    final _HarnessState harness = await pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
      ),
    );

    harness.supply(
      MessageListInputs(
        messages: <ChatMessage>[for (int i = 0; i < 41; i += 1) _msg(i)],
      ),
    );
    await tester.pumpAndSettle();

    final ScrollableState scrollable =
        tester.state<ScrollableState>(find.byType(Scrollable));
    expect(
      isNearBottom(
        pixels: scrollable.position.pixels,
        maxScrollExtent: scrollable.position.maxScrollExtent,
      ),
      isTrue,
    );
    expect(find.text('message number 40'), findsOneWidget);
  });

  group('the typing bubble', () {
    // It sits INSIDE the scrollable, after the last message. Outside it, the
    // row grew the Column rather than the list, so `maxScrollExtent` never
    // moved — which is what made these two assertions unwritable before.

    testWidgets('appears as the last item of the transcript',
        (WidgetTester tester) async {
      final _HarnessState harness = await pump(
        tester,
        MessageListInputs(
          messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
        ),
      );
      harness.supply(
        MessageListInputs(
          messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
          isTyping: true,
        ),
      );
      // Not `pumpAndSettle`: the dots loop by design and no frame is ever
      // the last one.
      await tester.pump();
      await tester.pump();

      // INSIDE the scrollable, not beside it. A band bolted under the list
      // also grows `maxScrollExtent` — it shrinks the viewport — so extent
      // alone cannot tell the two apart; containment can.
      expect(
        find.descendant(
          of: find.byType(Scrollable),
          matching: find.byType(TypingIndicator),
        ),
        findsOneWidget,
      );

      // And after the last message, not before it: `message-list.ts` keeps
      // the bubble last so it reads as the next message being written.
      final double lastMessageBottom =
          tester.getRect(find.text('message number 39')).bottom;
      expect(
        tester.getRect(find.byType(TypingIndicator)).top,
        greaterThanOrEqualTo(lastMessageBottom),
      );
    });

    testWidgets('does not drag a customer who had scrolled up',
        (WidgetTester tester) async {
      final _HarnessState harness = await pump(
        tester,
        MessageListInputs(
          messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
        ),
      );

      // The customer scrolls up to re-read something.
      await tester.drag(find.byType(ListView), const Offset(0, 600));
      await tester.pumpAndSettle();
      final ScrollableState afterDrag =
          tester.state<ScrollableState>(find.byType(Scrollable));
      final double readingAt = afterDrag.position.pixels;
      final double extentBefore = afterDrag.position.maxScrollExtent;
      expect(
        isNearBottom(
          pixels: readingAt,
          maxScrollExtent: extentBefore,
        ),
        isFalse,
      );

      // An agent starts typing. Nothing about that is worth yanking a
      // customer mid-sentence for.
      harness.supply(
        MessageListInputs(
          messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
          isTyping: true,
        ),
      );
      await tester.pump();
      await tester.pump();

      final ScrollableState after =
          tester.state<ScrollableState>(find.byType(Scrollable));
      // The assertion the bug report is about: not one pixel of movement.
      expect(after.position.pixels, readingAt);
      // And not built at all, because it is below a viewport the customer
      // scrolled away from — which a footer band bolted under the list
      // could never be.
      expect(find.byType(TypingIndicator), findsNothing);

      // It IS in the transcript, though: scrolling back to the end reaches
      // it. `extentBefore` is only used to prove the customer really had
      // somewhere to scroll back to.
      expect(extentBefore, greaterThan(readingAt));
      after.position.jumpTo(after.position.maxScrollExtent);
      await tester.pump();
      expect(find.byType(TypingIndicator), findsOneWidget);
    });

    testWidgets('DOES follow a customer who was at the bottom',
        (WidgetTester tester) async {
      final _HarnessState harness = await pump(
        tester,
        MessageListInputs(
          messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
        ),
      );

      harness.supply(
        MessageListInputs(
          messages: <ChatMessage>[for (int i = 0; i < 40; i += 1) _msg(i)],
          isTyping: true,
        ),
      );
      await tester.pump();
      await tester.pump();

      final ScrollableState scrollable =
          tester.state<ScrollableState>(find.byType(Scrollable));
      expect(
        isNearBottom(
          pixels: scrollable.position.pixels,
          maxScrollExtent: scrollable.position.maxScrollExtent,
        ),
        isTrue,
      );
    });

    testWidgets('keeps its dots running across an arriving message',
        (WidgetTester tester) async {
      // Its index moves on every arrival. Without an answer from
      // `findChildIndexCallback` the sliver rebuilds it from scratch and the
      // bounce restarts — a visible stutter exactly when the transcript is
      // busiest.
      final _HarnessState harness = await pump(
        tester,
        MessageListInputs(
          messages: <ChatMessage>[_msg(0)],
          isTyping: true,
        ),
      );
      final State<TypingDots> dots =
          tester.state<State<TypingDots>>(find.byType(TypingDots));

      harness.supply(
        MessageListInputs(
          messages: <ChatMessage>[_msg(0), _msg(1)],
          isTyping: true,
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(
        tester.state<State<TypingDots>>(find.byType(TypingDots)),
        same(dots),
      );
    });
  });

  testWidgets('an open action menu does not ride an insertion to another row',
      (WidgetTester tester) async {
    // A ListView recycles elements by INDEX. Without a key on the message id
    // the menu a customer opened on one message would reappear over a
    // different one the moment something landed above it.
    final _HarnessState harness = await pump(
      tester,
      MessageListInputs(
        messages: <ChatMessage>[_msg(1)],
      ),
    );

    await tester.tap(find.byIcon(Icons.more_horiz));
    await tester.pumpAndSettle();
    expect(find.text('Copy'), findsOneWidget);

    // A message arrives BEFORE the one whose menu is open, shifting indices.
    harness.supply(
      MessageListInputs(messages: <ChatMessage>[_msg(0), _msg(1)]),
    );
    await tester.pumpAndSettle();

    // Still exactly one open menu, and it is still the one the customer
    // opened — not a second one inherited by the recycled index.
    expect(find.text('Copy'), findsOneWidget);
    expect(find.byIcon(Icons.more_horiz), findsNWidgets(2));
  });
}
