// The typing bubble, against `styles.ts`'s `.dh-typing` / `.dh-typing-dot`.
//
// The bug this file pins: the row rendered a static `Text('…')`. It was
// present, it was even in a bubble, and it still did not read as a typing
// indicator — three characters that never move say "this UI is stuck", not
// "someone is composing". Motion is the signal, so motion is what is
// asserted here, not the presence of a widget.

import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _pump(
  WidgetTester tester, {
  bool disableAnimations = false,
  String? avatarLetter,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: disableAnimations),
        child: Scaffold(
          body: Center(
            child: TypingIndicator(
              label: 'Kai is typing',
              avatarLetter: avatarLetter,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

/// Every dot's painted offset and opacity this frame, left to right.
///
/// Read off the widget tree rather than off a golden image: what the port
/// has to get right is that the three dots are at DIFFERENT points of one
/// cycle and that the cycle advances, and both of those are visible here
/// without pinning a pixel.
List<(Offset, double)> _dots(WidgetTester tester) {
  final Iterable<Opacity> opacities = tester.widgetList<Opacity>(
    find.descendant(
      of: find.byType(TypingDots),
      matching: find.byType(Opacity),
    ),
  );
  final Iterable<Transform> transforms = tester.widgetList<Transform>(
    find.descendant(
      of: find.byType(TypingDots),
      matching: find.byType(Transform),
    ),
  );
  return <(Offset, double)>[
    for (int i = 0; i < opacities.length; i += 1)
      (
        Offset(
          transforms.elementAt(i).transform.getTranslation().x,
          transforms.elementAt(i).transform.getTranslation().y,
        ),
        opacities.elementAt(i).opacity,
      ),
  ];
}

void main() {
  testWidgets('draws three dots, not an ellipsis', (WidgetTester tester) async {
    await _pump(tester);

    expect(_dots(tester), hasLength(3));
    // The thing that was there before, and the reason it read as stuck.
    expect(find.text('…'), findsNothing);
  });

  testWidgets('the dots actually move', (WidgetTester tester) async {
    await _pump(tester);

    final List<(Offset, double)> first = _dots(tester);
    // A third of `dh-bounce`'s 1.2s period — far enough into the cycle that
    // the lead dot has left its rest position.
    await tester.pump(const Duration(milliseconds: 400));
    final List<(Offset, double)> later = _dots(tester);

    expect(later, isNot(first));

    // Mutation guard: a "moving" indicator whose dots all move together is
    // a blinking block, not a bounce. `styles.ts` staggers them by 0.15s and
    // 0.3s, so at any instant mid-cycle they must disagree.
    await tester.pump(const Duration(milliseconds: 100));
    final List<(Offset, double)> mid = _dots(tester);
    expect(
      mid.map<double>(((Offset, double) dot) => dot.$1.dy).toSet(),
      hasLength(greaterThan(1)),
      reason: 'the three dots must be at different points of the cycle',
    );

    // Every dot stays inside `dh-bounce`'s range: 0 down to -3px.
    for (final (Offset offset, double opacity) in mid) {
      expect(offset.dy, inInclusiveRange(-3, 0));
      expect(opacity, inInclusiveRange(0.5, 1));
    }
  });

  testWidgets('reduced motion holds the dots still, and keeps the bubble',
      (WidgetTester tester) async {
    // `styles.ts`: `@media (prefers-reduced-motion: reduce) { .dh-typing-dot
    // { animation: none; } }` — the dots stop, the bubble stays. A customer
    // who asked for less motion still needs to know somebody is replying.
    await _pump(tester, disableAnimations: true);

    final List<(Offset, double)> first = _dots(tester);
    await tester.pump(const Duration(milliseconds: 600));
    expect(_dots(tester), first);

    // At rest, not frozen mid-bounce: one dot lifted 3px above its
    // neighbours reads as a rendering glitch.
    for (final (Offset offset, double opacity) in first) {
      expect(offset.dy, 0);
      expect(opacity, 0.5);
    }

    expect(find.byType(TypingIndicator), findsOneWidget);
  });

  testWidgets('wears the handler\'s disc, at the incoming row\'s size',
      (WidgetTester tester) async {
    await _pump(tester, avatarLetter: 'K');

    // The SAME disc a real incoming bubble draws — not a lookalike sized by
    // eye. A typing bubble that starts 30px left of every bubble above it
    // reads as a footer, whichever dots are inside it.
    expect(
      find.descendant(
        of: find.byType(TypingIndicator),
        matching: find.byType(MessageAvatar),
      ),
      findsOneWidget,
    );
    expect(find.text('K'), findsOneWidget);
  });

  testWidgets('draws no disc when nobody has a resolved name',
      (WidgetTester tester) async {
    // `MessageRow.avatarLetter`'s own rule, so the two rows can never
    // disagree about whether a nameless handler gets a disc.
    await _pump(tester);
    expect(find.byType(MessageAvatar), findsNothing);
  });

  testWidgets('names the handler through semantics, and never announces it',
      (WidgetTester tester) async {
    await _pump(tester);

    final Semantics semantics = tester.widget<Semantics>(
      find.descendant(
        of: find.byType(TypingIndicator),
        matching: find.byType(Semantics),
      ),
    );
    expect(semantics.properties.label, 'Kai is typing');
    // A typing indicator that announces itself interrupts the message the
    // customer is actually reading, and it can flap several times a second.
    expect(semantics.properties.liveRegion, isFalse);
  });
}
