/// The ⋯ menu, mounted — and the whole End → rating chain behind it.
///
/// `test/ui/header/header_menu_test.dart` drives [HeaderMenu] with literal
/// props and proves every row's own rule. It passed while both of the bugs
/// this file exists for were live in a real app, because neither bug is in
/// the widget: they are in what the mount hands it, and in whether the mount
/// happens at all. So every case here goes through [ChatWidget] and a real
/// [ChatWidgetCubit], and touches the menu the way a customer does.
///
/// Two things are pinned:
///
///  1. **The header follows the conversation, not the back history.** It was
///     gated on `state.canGoBack`, which is empty for a host that opens the
///     panel directly on a conversation — so the bar, and with it the ⋯ menu,
///     never mounted and "End conversation" was unreachable however live the
///     conversation was.
///  2. **The mute row is offered only when the merchant published a chime.**
///     `RemoteConfig.sound` defaults to false and this tenant sends
///     `behaviour: {}`, so muting and unmuting changed nothing that could be
///     heard — the one row in this menu that was offered without being
///     backed.
library;

import 'package:dhaam_chat/dhaam_chat.dart' hide ConnectionState;
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'state/fake_widget_chat_client.dart';
import 'support/remote_config_fixtures.dart';
import 'ui/csat/fake_session_actions.dart';

/// Drains the fake client's queued microtasks and the CSAT lookup's own round
/// trip, then builds a frame. Same helper and same reasoning as
/// `chat_widget_test.dart`'s own.
Future<void> flush(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  await tester.pump();
}

void main() {
  late FakeWidgetChatClient client;
  late FakeSessionActions actions;

  setUp(() {
    client = FakeWidgetChatClient();
    actions = FakeSessionActions();
  });

  tearDown(() async {
    await client.dispose();
  });

  /// Mounts the whole panel over a Cubit built the way a host builds one.
  ///
  /// [sessionId] and [initialScreen] are passed straight through, because
  /// they are exactly the two public ways a host opens the panel ON a
  /// conversation — and exactly the case the old `canGoBack` gate dropped.
  Future<ChatWidgetCubit> pump(
    WidgetTester tester, {
    bool sound = false,
    bool wireSessionActions = true,
    String? sessionId,
    ScreenName? initialScreen,
  }) async {
    final ChatWidgetCubit cubit = ChatWidgetCubit(
      client: client,
      initialConfig: testRemoteConfig(sound: sound),
      sessionActions: wireSessionActions ? actions : null,
      sessionId: sessionId,
      initialScreen: initialScreen,
    );
    addTearDown(cubit.close);
    await tester.pumpWidget(MaterialApp(home: ChatWidget(cubit: cubit)));
    return cubit;
  }

  /// The ⋯ toggle inside the panel's own header, and nowhere else — scoped so
  /// an unrelated `more_horiz` elsewhere on screen cannot satisfy it.
  final Finder menuToggle = find.descendant(
    of: find.byType(AppBar),
    matching: find.byIcon(Icons.more_horiz),
  );

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(menuToggle);
    await tester.pumpAndSettle();
  }

  /// Every row label currently offered, in order.
  List<String> labels(WidgetTester tester) => tester
      .widgetList<PopupMenuItem<HeaderMenuAction>>(
        find.byType(PopupMenuItem<HeaderMenuAction>),
      )
      .map(
        (PopupMenuItem<HeaderMenuAction> item) =>
            (((item.child! as Row).children.last as Expanded).child as Text)
                .data!,
      )
      .toList();

  /// A live, assigned session with one message in its transcript.
  Future<void> liveConversation(WidgetTester tester) async {
    client.emitSession(testSession(status: ChatStatus.assigned));
    client.emitMessage(testMessage(id: 'm1'));
    await flush(tester);
    await flush(tester);
  }

  group('the header follows the conversation, not the back history', () {
    testWidgets('a host that opens ON a conversation still gets the ⋯ menu',
        (WidgetTester tester) async {
      // The reported bug, at its root. `ChatWidgetCubit(sessionId: …)` starts
      // `ChatScreens` AT the conversation, so nothing was ever pushed and
      // `canGoBack` is false from the first frame. Under the old gate that
      // meant no header at all — and the customer had no ⋯ to press, on a
      // conversation the Cubit itself says is endable.
      final ChatWidgetCubit cubit = await pump(tester, sessionId: 's1');
      await liveConversation(tester);

      // Asserted first: every "the row is there" expectation below is also
      // satisfied by a fixture that never became endable, so the precondition
      // has to be proven before they mean anything.
      expect(cubit.state.canGoBack, isFalse,
          reason: 'nothing was pushed — this is the case that regressed');
      expect(cubit.canEndConversation, isTrue);

      expect(find.byType(AppBar), findsOneWidget);
      await openMenu(tester);
      expect(labels(tester), contains('End conversation'));
    });

    testWidgets('so does a host that names the conversation screen',
        (WidgetTester tester) async {
      final ChatWidgetCubit cubit =
          await pump(tester, initialScreen: ScreenName.conversation);
      await liveConversation(tester);
      expect(cubit.state.canGoBack, isFalse);

      await openMenu(tester);
      expect(labels(tester), contains('End conversation'));
    });

    testWidgets('with no back arrow, because there is nowhere to go back to',
        (WidgetTester tester) async {
      // The half of the old gate that was right, kept: the arrow is about the
      // back history even though the header is not. A `BackButton` here would
      // pop the HOST's route out from under the panel.
      await pump(tester, sessionId: 's1');
      await liveConversation(tester);

      expect(find.byType(AppBar), findsOneWidget);
      expect(find.byType(BackButton), findsNothing);
      // And nothing the framework deduced in its place.
      expect(tester.widget<AppBar>(find.byType(AppBar)).leading, isNull);
      expect(
        tester.widget<AppBar>(find.byType(AppBar)).automaticallyImplyLeading,
        isFalse,
      );
    });

    testWidgets('a drilled-in customer still gets the arrow',
        (WidgetTester tester) async {
      final ChatWidgetCubit cubit = await pump(tester);
      await tester.tap(find.text('Send us a message'));
      await tester.pump();

      expect(cubit.state.canGoBack, isTrue);
      expect(find.byType(BackButton), findsOneWidget);
    });

    testWidgets('Home and Messages still carry no header at all',
        (WidgetTester tester) async {
      // The new gate must not reach the two tab screens: Home has its own
      // HeroHeader, and a second generic bar above it is redundant, not
      // helpful.
      final ChatWidgetCubit cubit = await pump(tester);
      expect(find.byType(AppBar), findsNothing);

      cubit.switchTab(ScreenName.messages);
      await flush(tester);
      expect(find.byType(AppBar), findsNothing);
    });

    testWidgets('and they still do not once the customer has drilled in first',
        (WidgetTester tester) async {
      // The other half of the bug, and the one the "surely canGoBack implies
      // conversation" reading misses. `ChatScreens.swap` — what `switchTab`
      // calls — changes the screen WITHOUT clearing the stack, and
      // `chat_screens_test.dart` pins that on purpose. So a customer who
      // drills into a conversation and then taps a tab is on Messages with
      // `canGoBack` still true, and the old gate painted the whole
      // conversation header, back arrow and all, over their message list.
      final ChatWidgetCubit cubit = await pump(tester, sessionId: 's1');
      await liveConversation(tester);
      cubit.switchTab(ScreenName.home);
      await flush(tester);
      cubit.openConversation('s1');
      await flush(tester);
      expect(find.byType(AppBar), findsOneWidget);

      cubit.switchTab(ScreenName.messages);
      await flush(tester);

      // The precondition, stated rather than assumed: this case only means
      // something while the stale back history is actually there.
      expect(cubit.state.canGoBack, isTrue);
      expect(cubit.state.screen, ScreenName.messages);
      expect(find.byType(AppBar), findsNothing);
      expect(find.byType(MessagesScreen), findsOneWidget);
    });
  });

  group('End conversation is offered exactly when it is backed', () {
    testWidgets('absent while the customer is still composing a new one',
        (WidgetTester tester) async {
      // No session yet, so there is genuinely nothing to end. The row being
      // absent HERE is the rule working, not the bug.
      final ChatWidgetCubit cubit = await pump(tester);
      await tester.tap(find.text('Send us a message'));
      await tester.pump();
      expect(cubit.state.session, isNull);

      await openMenu(tester);
      expect(labels(tester), isNot(contains('End conversation')));
    });

    testWidgets('appears the moment the session lands', (tester) async {
      final ChatWidgetCubit cubit = await pump(tester);
      await tester.tap(find.text('Send us a message'));
      await tester.pump();
      await liveConversation(tester);
      expect(cubit.state.session, isNotNull);

      await openMenu(tester);
      expect(labels(tester), contains('End conversation'));
    });

    testWidgets('stays absent when the host wired no ChatSessionActions',
        (WidgetTester tester) async {
      // Off, not broken: with no REST slice there is nothing to close the
      // conversation WITH, so the row would be a promise the panel cannot
      // keep.
      final ChatWidgetCubit cubit =
          await pump(tester, sessionId: 's1', wireSessionActions: false);
      await liveConversation(tester);
      expect(cubit.state.session, isNotNull,
          reason: 'the session must land, or this passes vacuously');

      await openMenu(tester);
      expect(labels(tester), isNot(contains('End conversation')));
    });

    testWidgets('drops away once the conversation is already over',
        (WidgetTester tester) async {
      final ChatWidgetCubit cubit = await pump(tester, sessionId: 's1');
      await liveConversation(tester);
      client.emitSession(testSession(status: ChatStatus.resolved));
      for (int i = 0; i < 4; i += 1) {
        await flush(tester);
      }
      expect(cubit.state.session?.status, ChatStatus.resolved);

      await openMenu(tester);
      expect(labels(tester), isNot(contains('End conversation')));
    });
  });

  // The whole point of the report: End is the door to the rating card, and
  // the two had never been driven end to end from one mount. Each piece was
  // covered alone and the chain between them was not.
  testWidgets(
      'pressing End, confirming, and landing on the rating card — one run',
      (WidgetTester tester) async {
    final ChatWidgetCubit cubit = await pump(tester, sessionId: 's1');
    await liveConversation(tester);
    // The transcript is load-bearing further down — `dueCsatCard` returns
    // null for an empty one, so a fixture that lost its message would fail
    // this test at the card with no hint as to why.
    expect(cubit.state.messages, isNotEmpty);

    await openMenu(tester);
    await tester.tap(find.text('End conversation'));
    await tester.pumpAndSettle();

    // The question, in the surface slot, over the transcript.
    expect(find.text('End this conversation?'), findsWidgets);

    await tester.tap(find.widgetWithText(FilledButton, 'End conversation'));
    for (int i = 0; i < 4; i += 1) {
      await flush(tester);
    }
    // The close actually went out over the seam.
    expect(actions.closed, <String>['s1']);

    // chat-service is what makes it terminal; the socket carries it back.
    client.emitSession(testSession(status: ChatStatus.resolved));
    for (int i = 0; i < 4; i += 1) {
      await flush(tester);
    }

    expect(find.text('How was your support experience?'), findsOneWidget);
    expect(find.byKey(csatOptionKey(5)), findsOneWidget);

    // And the rating reaches the server.
    await tester.tap(find.byKey(csatOptionKey(5)));
    await tester.pump();
    await tester.tap(find.text('Submit feedback'));
    for (int i = 0; i < 4; i += 1) {
      await flush(tester);
    }
    expect(actions.submitted, hasLength(1));
    expect(actions.submitted.single[1], 5);
  });

  group('mute is offered only when there is a chime to silence', () {
    testWidgets('absent on a tenant that published no sound',
        (WidgetTester tester) async {
      // The live tenant returns `behaviour: {}`, so `RemoteConfig.sound` is
      // false and `Chime` refuses on that alone — muting and unmuting could
      // not change anything a customer could hear. This is the same rule the
      // End and Report rows already follow.
      await pump(tester, sound: false, sessionId: 's1');
      await liveConversation(tester);

      await openMenu(tester);
      expect(labels(tester), isNot(contains('Mute notifications')));
      expect(labels(tester), isNot(contains('Unmute notifications')));
    });

    testWidgets('present, and it toggles, once the merchant enables sound',
        (WidgetTester tester) async {
      final ChatWidgetCubit cubit =
          await pump(tester, sound: true, sessionId: 's1');
      await liveConversation(tester);

      await openMenu(tester);
      expect(labels(tester), contains('Mute notifications'));

      await tester.tap(find.text('Mute notifications'));
      await tester.pumpAndSettle();
      expect(cubit.state.muted, isTrue);

      // The label states the ACTION, so re-opening shows the other one.
      await openMenu(tester);
      expect(labels(tester), contains('Unmute notifications'));

      await tester.tap(find.text('Unmute notifications'));
      await tester.pumpAndSettle();
      expect(cubit.state.muted, isFalse);
    });

    testWidgets('a config that arrives later turns the row on',
        (WidgetTester tester) async {
      // `initialConfig` is the host's placeholder; the real one lands through
      // `applyRemoteConfig`. The row has to follow it, or a merchant who does
      // publish a chime never gets the control.
      final ChatWidgetCubit cubit =
          await pump(tester, sound: false, sessionId: 's1');
      await liveConversation(tester);
      await openMenu(tester);
      expect(labels(tester), isNot(contains('Mute notifications')));
      await tester.tapAt(const Offset(20, 400));
      await tester.pumpAndSettle();

      cubit.applyRemoteConfig(testRemoteConfig(sound: true));
      await flush(tester);

      await openMenu(tester);
      expect(labels(tester), contains('Mute notifications'));
    });
  });
}
