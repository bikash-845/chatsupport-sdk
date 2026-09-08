/// Reproduces `packages/widget/test/identity-header-mount.test.ts` — the
/// conversation app bar actually USING T14's header components rather than
/// re-deriving identity itself.
///
/// The case that had no end-to-end counterpart before this node is
/// "updates when an agent joins mid-conversation". Its other half — the
/// `agent.joined`/`agent.left` frames reaching the `sessions` stream at all —
/// is `packages/dart`'s `test/logic/agent_presence_test.dart`; the two meet at
/// that stream, which is what this suite drives.
library;

// This suite needs the protocol types (SessionSnapshot, HandledBy,
// ChatStatus) AND material. The only collision between the two barrels is
// `ConnectionState`, which nothing here uses, so it is hidden rather than
// resolved either way.
import 'package:dhaam_chat/dhaam_chat.dart' hide ConnectionState;
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'state/fake_widget_chat_client.dart';
import 'support/remote_config_fixtures.dart';

const String _title = 'Acme Support';

SessionSnapshot _session({
  ChatStatus status = ChatStatus.open,
  HandledBy? handledBy,
}) =>
    SessionSnapshot(
      sessionId: 's1',
      status: status,
      mode: ChatMode.human,
      participants: const <ParticipantSnapshot>[],
      createdAt: DateTime.utc(2026, 1, 1),
      handledBy: handledBy,
    );

const HandledBy _ada =
    HandledBy(kind: HandledByKind.agent, id: 'agt_1', displayName: 'Ada');

/// The app bar only exists on a drill-down, so every case here opens a
/// conversation first — that is what `canGoBack` gates.
Future<void> _openConversation(
  WidgetTester tester,
  ChatWidgetCubit cubit,
) async {
  cubit.startNewConversation();
  await tester.pump();
}

/// Lets a queued session event actually reach [ChatWidgetCubit] before the
/// next pump captures a frame — the same helper, and the same reasoning, as
/// `chat_widget_test.dart`'s own.
///
/// `StreamController.add` (the default, non-`sync` controller
/// [FakeWidgetChatClient] uses) schedules delivery on a MICROTASK, so the
/// event has to be drained before an assertion can see its effect.
/// `tester.runAsync` steps out to the real clock for that; the `pump()` after
/// it turns the resulting Cubit state into a frame.
Future<void> flush(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  await tester.pump();
}

/// The text inside the app bar's own [IdentityHeader], which is the widget
/// under test rather than any text that happens to be on screen.
String _titleText(WidgetTester tester) {
  final Finder finder = find.descendant(
    of: find.byType(IdentityHeader),
    matching: find.byType(Text),
  );
  return tester.widget<Text>(finder.first).data!;
}

void main() {
  late FakeWidgetChatClient client;
  late ChatWidgetCubit cubit;

  setUp(() {
    client = FakeWidgetChatClient();
    cubit = ChatWidgetCubit(
      client: client,
      // `sound: true` is load-bearing for the mute case below, not decoration.
      // `RemoteConfig.sound` DEFAULTS to false, and the ⋯ menu now drops the
      // mute row entirely on a tenant that published no chime — `Chime`
      // refuses on `!sound` before it ever reads `muted`, so the row was the
      // one unbacked item in a menu whose rule is that there are none. This
      // fixture is therefore a merchant who did enable it, which is the only
      // tenant for whom "the mute row is wired to the Cubit" is a question.
      // The absence half is pinned in `header_menu_mount_test.dart`.
      initialConfig: testRemoteConfig(title: _title, sound: true),
    );
  });

  tearDown(() async {
    await cubit.close();
    await client.dispose();
  });

  Future<void> pumpWidget(WidgetTester tester) =>
      tester.pumpWidget(MaterialApp(home: ChatWidget(cubit: cubit)));

  group('the app bar mounts the header components', () {
    testWidgets('mounts exactly one IdentityHeader',
        (WidgetTester tester) async {
      await pumpWidget(tester);
      await _openConversation(tester, cubit);

      expect(find.byType(IdentityHeader), findsOneWidget);
    });

    testWidgets('mounts the avatar and the menu beside it',
        (WidgetTester tester) async {
      await pumpWidget(tester);
      await _openConversation(tester, cubit);

      expect(find.byType(HeaderAvatar), findsOneWidget);
      expect(find.byType(HeaderMenu), findsOneWidget);
    });
  });

  group('identity follows the session', () {
    testWidgets('shows the MERCHANT\'S configured title, not "Conversation"',
        (WidgetTester tester) async {
      // The second half of the defect this node closes: the old app bar fell
      // back to the literal string 'Conversation' and never read
      // `config.title` at all.
      await pumpWidget(tester);
      cubit.openConversation('s1');
      await tester.pump();

      expect(_titleText(tester), equals(_title));
    });

    testWidgets('names the agent once one is handling the chat',
        (WidgetTester tester) async {
      await pumpWidget(tester);
      cubit.openConversation('s1');
      client.emitSession(_session(handledBy: _ada));
      await flush(tester);

      expect(_titleText(tester), equals('Ada'));
    });

    testWidgets('updates when an agent joins mid-conversation',
        (WidgetTester tester) async {
      // The case with no end-to-end counterpart until now.
      //
      // `OPEN` rather than `WAITING_FOR_AGENT`, for the reason the reference
      // states: the agent-presence fold writes `handledBy` and deliberately
      // does NOT touch `status`, and `isHandledByCurrent` refuses to narrate
      // a handler while the session still says it is waiting. What is under
      // test here is the subscription, not the gate.
      await pumpWidget(tester);
      cubit.openConversation('s1');
      client.emitSession(_session());
      await flush(tester);
      expect(_titleText(tester), equals(_title));

      // What `applyAgentJoined` produces, arriving on the same stream a real
      // `agent.joined` frame now reaches (see packages/dart's own suite).
      client.emitSession(_session(handledBy: _ada));
      await flush(tester);

      expect(_titleText(tester), equals('Ada'));
    });

    testWidgets('falls back again when the agent leaves',
        (WidgetTester tester) async {
      await pumpWidget(tester);
      cubit.openConversation('s1');
      client.emitSession(_session(handledBy: _ada));
      await flush(tester);
      expect(_titleText(tester), equals('Ada'));

      // What `applyAgentLeft` produces: handledBy cleared, status untouched.
      client.emitSession(_session());
      await flush(tester);

      expect(_titleText(tester), equals(_title));
    });

    testWidgets(
        'does not narrate a stale agent on a session that went back to waiting',
        (WidgetTester tester) async {
      // THE regression this node exists to close, and the one the mutation
      // check targets. A session reactivated from CLOSED/RESOLVED keeps its
      // previous agent server-side, so `handledBy` still names Ada while
      // `status` is back to WAITING_FOR_AGENT — and she is not on the chat.
      //
      // The app bar this replaced read `handledBy?.displayName` with no gate
      // and would print "Ada" here.
      await pumpWidget(tester);
      cubit.openConversation('s1');
      client.emitSession(
        _session(status: ChatStatus.waitingForAgent, handledBy: _ada),
      );
      await flush(tester);

      expect(_titleText(tester), equals(_title));
    });

    testWidgets('names a bot the same way it names a human',
        (WidgetTester tester) async {
      await pumpWidget(tester);
      cubit.openConversation('s1');
      client.emitSession(
        _session(
          handledBy: const HandledBy(
            kind: HandledByKind.bot,
            id: 'bot_1',
            displayName: 'Acme Assistant',
          ),
        ),
      );
      await flush(tester);

      expect(_titleText(tester), equals('Acme Assistant'));
    });

    testWidgets('a new-conversation compose outranks both',
        (WidgetTester tester) async {
      await pumpWidget(tester);
      await _openConversation(tester, cubit);

      expect(_titleText(tester), equals('New conversation'));
    });
  });

  group('the header menu is wired to the Cubit', () {
    testWidgets('the mute row flips the label through setMuted',
        (WidgetTester tester) async {
      await pumpWidget(tester);
      await _openConversation(tester, cubit);

      await tester.tap(find.byTooltip('Conversation options'));
      await tester.pumpAndSettle();
      expect(find.text('Mute notifications'), findsOneWidget);

      await tester.tap(find.text('Mute notifications'));
      await tester.pumpAndSettle();
      expect(cubit.state.muted, isTrue);

      await tester.tap(find.byTooltip('Conversation options'));
      await tester.pumpAndSettle();
      expect(find.text('Unmute notifications'), findsOneWidget);
    });

    testWidgets('offers no End conversation row without a live session',
        (WidgetTester tester) async {
      // `canEndConversation` is false with no ChatSessionActions wired, so
      // the row is HIDDEN rather than shown-and-dead.
      await pumpWidget(tester);
      await _openConversation(tester, cubit);

      await tester.tap(find.byTooltip('Conversation options'));
      await tester.pumpAndSettle();

      expect(find.text('End conversation'), findsNothing);
    });

    testWidgets('never offers Report an issue, which has no host yet',
        (WidgetTester tester) async {
      // `report_issue_form.dart` is built but unreachable — no surface, no
      // Cubit method, no reporter. The menu HIDES an unbacked row rather
      // than showing one that does nothing.
      await pumpWidget(tester);
      await _openConversation(tester, cubit);

      await tester.tap(find.byTooltip('Conversation options'));
      await tester.pumpAndSettle();

      expect(find.text('Report an issue'), findsNothing);
    });
  });
}
