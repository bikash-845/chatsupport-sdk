/// The reported "pre-chat form shows for logged-in users" bug, pinned at the
/// one place this app can decide it.
///
/// ── Why these assertions and not a form-rendering one ────────────────────
///
/// Whether the form is DRAWN is `preChatFieldsToAsk`'s answer, and
/// `packages/flutter`'s own suite already pins that: the gate needs `isGuest`,
/// the merchant's toggle, a non-empty published field list, and an
/// unanswered conversation. None of the last three are this app's to decide,
/// and reproducing them here would test the package through a host rather
/// than testing the host.
///
/// What IS this app's to decide is which `ChatIdentity` it hands over, and
/// that was the whole bug — it handed over none, so the parameter's
/// `ChatIdentity.guest` default applied to everybody. So these tests pin the
/// argument, and the widget test below pins that the switch changes it.
library;

import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show ChatIdentity, ChatParticipantProfile;
import 'package:dhaam_chat/dhaam_chat.dart' show PublishableKey;
import 'package:dhaam_chat_flutter_example/example_config.dart';
import 'package:dhaam_chat_flutter_example/example_identity.dart';
import 'package:dhaam_chat_flutter_example/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('exampleIdentity', () {
    test('a guest is a guest', () {
      final ChatIdentity identity = exampleIdentity(ExampleVisitor.guest);

      expect(identity.isGuest, isTrue);
      expect(identity.profile, isNull);
    });

    test('an identified visitor is not a guest', () {
      final ChatIdentity identity = exampleIdentity(ExampleVisitor.identified);

      expect(identity.isGuest, isFalse);
      expect(identity.profile, isNotNull);
    });

    /// The load-bearing one.
    ///
    /// `chat_identity.dart` is explicit that a guest is NOT "a visitor with no
    /// user id" — every visitor has one, so a gate built on it never fires for
    /// anybody. If this example ever demonstrates the difference by withholding
    /// the id from the guest, it teaches exactly that wrong answer, and this
    /// test is what stops that edit landing quietly.
    test('the user id is identical across the switch — only the profile moves',
        () {
      final ChatIdentity guest = exampleIdentity(ExampleVisitor.guest);
      final ChatIdentity known = exampleIdentity(ExampleVisitor.identified);

      expect(guest.userId, kExampleUserId);
      expect(known.userId, kExampleUserId);
      expect(guest.userId, known.userId);

      // …and the answer still differs, which is only possible because the
      // discriminator is the profile.
      expect(guest.isGuest, isNot(known.isGuest));
    });

    test('a guest carries a user id rather than a null one', () {
      // `ChatIdentity.guest` — the package's own constant — deliberately
      // carries none. This example does not reuse it, precisely so the id is
      // present on both sides and cannot be mistaken for the discriminator.
      expect(exampleIdentity(ExampleVisitor.guest).userId, isNotNull);
      expect(ChatIdentity.guest.userId, isNull);
      expect(ChatIdentity.guest.isGuest, isTrue);
    });

    test('an empty profile would still not be a guest', () {
      // Not a path this app offers, asserted because it is the fact the
      // profile-presence rule rests on: a host that knows only that somebody
      // is logged in passes an empty profile and is correctly not a guest.
      const ChatIdentity minimal = ChatIdentity(
        userId: kExampleUserId,
        profile: ChatParticipantProfile(),
      );

      expect(minimal.isGuest, isFalse);
    });
  });

  group('exampleVisitorExplanation', () {
    test('names the profile as the cause on both sides', () {
      // The sentence on screen has to name the thing that actually decided,
      // or the switch demonstrates a behaviour without explaining it.
      for (final ExampleVisitor visitor in ExampleVisitor.values) {
        expect(exampleVisitorExplanation(visitor), contains('profile'));
      }
    });

    test('the two sides say different things', () {
      expect(
        exampleVisitorExplanation(ExampleVisitor.guest),
        isNot(exampleVisitorExplanation(ExampleVisitor.identified)),
      );
    });
  });

  /// The switch, on the running host screen.
  ///
  /// The unit tests above pin what `exampleIdentity` answers; this pins that
  /// the control on screen is wired to it. A green analyze on an app whose
  /// switch changes nothing is exactly the false signal this example exists
  /// to eliminate.
  testWidgets('the host screen switch moves the visitor between the two modes',
      (WidgetTester tester) async {
    await tester.pumpWidget(ExampleApp(config: _readyConfig()));
    await tester.pump();

    // IDENTIFIED is the landing state, deliberately. Whoever runs this
    // supplied a real access token for a real user, so signed-in is what they
    // are testing. Landing on guest made two correct behaviours read as bugs:
    // the pre-chat form appearing (right, for a guest, once the merchant
    // publishes preChatEnabled) and an empty conversation list (also right --
    // `listSessions` answers a guest with `[]`, and that emptiness IS the
    // guest signal).
    expect(find.text('false'), findsOneWidget);
    expect(find.text('absent'), findsNothing);
    expect(find.textContaining(kExampleProfile.email!), findsOneWidget);

    // The toggle still reaches guest — that comparison is the point of the
    // control; it just is not where someone lands by accident.
    // Scrolled into view first: the host screen has grown past one viewport,
    // and `tap` on an off-screen widget does not toggle anything -- it fails
    // by finding nothing changed, which reads as a broken switch rather than
    // a test that never pressed it.
    final Finder switchTile = find.byKey(const Key('host.identifiedSwitch'));
    await tester.ensureVisible(switchTile);
    await tester.pumpAndSettle();
    await tester.tap(switchTile);
    await tester.pump();

    // Targeted by key, because `find.text` cannot see a ListView child that
    // has not been built — after scrolling to the switch, asserting on bare
    // text measures the scroll position rather than the toggle.
    final Finder isGuestFact = find.byKey(const Key('host.isGuestFact'));
    await tester.ensureVisible(isGuestFact);
    await tester.pumpAndSettle();
    expect(find.descendant(of: isGuestFact, matching: find.text('true')),
        findsOneWidget);

    // The id is on screen in BOTH states and is the same string — the fact
    // the section exists to teach.
    expect(find.text(kExampleUserId), findsOneWidget);
  });
}

/// A configuration that passes validation, so the host screen renders.
///
/// The endpoints are unreachable and deliberately so: nothing in this test
/// opens the panel, and the host screen's own fetches (`fetchRemoteConfig`,
/// `captureContactInfo`) are documented never to throw — they resolve to
/// null/nothing and the screen renders on its defaults. That is the same path
/// a person on a plane gets.
ExampleConfigReady _readyConfig() => ExampleConfigReady(
      wsUrl: Uri.parse('wss://chat.invalid'),
      apiUrl: 'https://api.invalid',
      publishableKey: PublishableKey.parse('dhp_test_examplekey123456'),
      accessToken: 'header.payload.signature',
      sessionId: null,
    );
