import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';

import '../state/fake_widget_chat_client.dart';

/// Lets a queued stream event actually reach its listener before the next
/// pump captures a frame.
///
/// `StreamController.add` (the default, non-sync controller
/// [FakeWidgetChatClient] uses) schedules delivery on a MICROTASK rather than
/// delivering synchronously, so the event has to be drained before an
/// assertion can see its effect.
///
/// ── Why this is `tester.pump()` and not `Future.delayed(Duration.zero)` ──
///
/// The sibling `chat_widget_cubit_test.dart` uses `Future.delayed` and is
/// right to: it is a plain `test()`, running on the real clock. Copying it
/// into `testWidgets` DEADLOCKS. Widget tests run inside a `FakeAsync` zone
/// whose clock only advances when the harness is told to advance it, so a
/// timer awaited directly — even a zero-duration one — is a timer nothing
/// will ever fire, and the test hangs until the runner kills it.
///
/// `tester.pump()` is the right tool and needs no delay at all: it drains the
/// microtask queue before it builds the frame, which is precisely the race
/// this helper exists to close.
Future<void> flush(WidgetTester tester) async {
  // `runAsync` steps OUT of the fake clock and onto the real one for the
  // duration of the callback, which is what lets the controller's queued
  // microtask actually be delivered. The `pump()` after it is what turns the
  // resulting Cubit state into a frame — one without the other leaves either
  // an undelivered event or an unrendered state.
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  await tester.pump();
}

Widget _wrap(ChatWidgetCubit cubit) {
  return BlocProvider<ChatWidgetCubit>.value(
    value: cubit,
    child: const MaterialApp(home: Scaffold(body: ConversationScreen())),
  );
}

void main() {
  late FakeWidgetChatClient client;
  late ChatWidgetCubit cubit;

  setUp(() {
    client = FakeWidgetChatClient();
    cubit = ChatWidgetCubit(client: client);
  });

  tearDown(() async {
    await cubit.close();
    await client.dispose();
  });

  testWidgets(
      'passes the local participant id through, so an own message gets a tick',
      (tester) async {
    // Guards the WIRING, not the derivation. `deriveTickState` is covered by
    // tick_state_test.dart with the id handed to it directly; this asserts the
    // one line in ConversationScreen that actually gets it there.
    //
    // Worth its own test because the failure is silent: `deriveTickState`
    // returns null for EVERY message when `localParticipantId` is null, so
    // dropping the wiring does not throw, does not warn, and does not fail any
    // module test -- it just renders no ticks at all, which is exactly the
    // state this SDK was in before the field existed.
    final FakeWidgetChatClient tickClient = FakeWidgetChatClient();
    final ChatWidgetCubit tickCubit = ChatWidgetCubit(
      client: tickClient,
      identity: const ChatIdentity(userId: 'visitor-1'),
    );
    addTearDown(() async {
      await tickCubit.close();
      await tickClient.dispose();
    });

    tickCubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(tickCubit));
    tickClient.emitMessage(
      ChatMessage(
        id: '01J0000000000000000000000A',
        sessionId: 's1',
        senderId: 'visitor-1',
        senderType: SenderType.customer,
        type: MessageType.text,
        content: 'hello',
        createdAt: DateTime.utc(2026, 1, 1),
        seq: 1,
        delivery: MessageDelivery.confirmed,
      ),
    );
    await flush(tester);

    expect(find.text('hello'), findsOneWidget);
    expect(
      find.text('Sent'),
      findsOneWidget,
      reason: 'an own confirmed message with no other participant caught up '
          'is Sent; finding nothing means localParticipantId never arrived',
    );
  });

  testWidgets('shows NewConversationView while composingNew is true',
      (tester) async {
    cubit.startNewConversation();
    await tester.pumpWidget(_wrap(cubit));
    expect(find.byType(NewConversationView), findsOneWidget);
    expect(find.text('Start'), findsOneWidget);
  });

  testWidgets(
      'shows the empty-transcript prompt for an existing, message-less conversation',
      (tester) async {
    const String empty = 'No messages yet. Ask us anything about your order.';
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));
    // Nothing yet: before the ack lands, an empty list means "nobody has
    // asked", and telling a customer with a year of history that their
    // conversation is empty is a lie they would re-read on every switch.
    expect(find.text(empty), findsNothing);

    client.emitSession(testSession(id: 'past-session-1'));
    await flush(tester);
    expect(find.text(empty), findsOneWidget);
    expect(find.byType(NewConversationView), findsNothing);
  });

  testWidgets('renders a bubble per message', (tester) async {
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    client.emitMessage(testMessage(id: 'm1', content: 'Hi, how can I help?'));
    client.emitMessage(testMessage(
        id: 'm2',
        content: 'My order never arrived',
        senderType: SenderType.customer));
    await flush(tester);
    await tester.pump();

    expect(find.text('Hi, how can I help?'), findsOneWidget);
    expect(find.text('My order never arrived'), findsOneWidget);
  });

  testWidgets(
      'an outgoing (customer) message shows a delivery tick; an incoming one does not',
      (tester) async {
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    client.emitMessage(
      testMessage(
          id: 'm1',
          content: 'from the agent',
          senderType: SenderType.agent,
          delivery: MessageDelivery.confirmed),
    );
    client.emitMessage(
      testMessage(
          id: 'm2',
          content: 'from me',
          senderType: SenderType.customer,
          delivery: MessageDelivery.pending),
    );
    await flush(tester);
    await tester.pump();

    // No tick on either row — and note WHY, because the reason narrowed once
    // `ChatWidgetState.localParticipantId` landed. It is no longer "the state
    // cannot carry one"; it is that THIS cubit was built with the default
    // `ChatIdentity.guest`, which names no `userId`, so there is still no
    // answer to "which of these participants are we".
    //
    // `deriveTickState` returns null for every message in that case, which is
    // core's conservative answer rather than a gap. Guessing instead — from
    // `senderType == CUSTOMER`, say — is the heuristic ticks.ts explicitly
    // refuses, because it would make an agent-side embed draw ticks on the
    // customer's own messages. The sibling test above supplies a userId and
    // asserts the tick DOES appear, so the two pin both halves.
    for (final String word in <String>[
      'Sending',
      'Sent',
      'Delivered',
      'Read'
    ]) {
      expect(find.text(word), findsNothing);
    }
  });

  testWidgets('a failed send states its reason end to end', (tester) async {
    // The fake refuses by default, and `onRetry` reports a refusal through
    // `FlutterError.reportError` — which a widget test counts as a failure.
    // That is the wiring working: a refusal is not allowed to be silent.
    client.retryOutcome =
        RetryRetried(testMessage(id: 'm1', senderType: SenderType.customer));
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    client.emitMessage(
      testMessage(
        id: 'm1',
        senderType: SenderType.customer,
        delivery: const MessageFailed(
            reason: SendFailureReason.rejected, retryable: true),
      ),
    );
    await flush(tester);
    await tester.pump();

    // Was `findsNothing`. The reason now rides on the message itself, so the
    // sentence reaches the transcript with nothing in between to populate.
    expect(find.text('This message could not be sent.'), findsOneWidget);
    // And the button, on the real screen: `onRetry` reaches
    // `ChatWidgetCubit.retryMessage`, which replays the ORIGINAL envelope.
    expect(find.text('Retry'), findsOneWidget);

    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(client.retriedIds, <String>['m1']);
  });

  testWidgets('a non-retryable failure gets its reason and no button',
      (tester) async {
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    client.emitMessage(
      testMessage(
        id: 'm1',
        senderType: SenderType.customer,
        delivery: const MessageFailed(
            reason: SendFailureReason.sessionClosed, retryable: false),
      ),
    );
    await flush(tester);
    await tester.pump();

    expect(find.text('This conversation ended before this message could send.'),
        findsOneWidget);
    // Absent from the tree, not merely styled away: retrying a send the
    // server already refused is refused identically every time.
    expect(find.text('Retry'), findsNothing);
  });

  testWidgets(
      'quick replies show under the newest incoming message and send on tap',
      (tester) async {
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    client.emitMessage(
      testMessage(
        id: 'm1',
        content: 'Want to track your order?',
        metadata: {
          'options': <Object?>['Track my order', 'Talk to a human']
        },
      ),
    );
    await flush(tester);
    await tester.pump();

    expect(find.text('Track my order'), findsOneWidget);
    await tester.tap(find.text('Track my order'));
    await tester.pump();

    expect(client.sentContent, <String>['Track my order']);
  });

  // Proves the WIRING, not just the guard: a chip that called
  // `cubit.sendMessage` directly would send here, because the client has no
  // idea a draft exists. Only a chip routed through the composer's own
  // submit can see it — which is the same reason a chip cannot get past the
  // consent gate that lives on the composer's `enabled`.
  testWidgets(
      'a quick reply goes through the composer, so it will not '
      'overwrite a draft the customer is typing', (tester) async {
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    client.emitMessage(
      testMessage(
        id: 'm1',
        content: 'Want to track your order?',
        metadata: {
          'options': <Object?>['Track my order']
        },
      ),
    );
    await flush(tester);
    await tester.pump();

    await tester.enterText(
        find.byKey(const Key('composer.message')), 'my order was ');
    await tester.pump();

    await tester.tap(find.text('Track my order'));
    await tester.pump();

    expect(client.sentContent, isEmpty);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('composer.message')))
          .controller!
          .text,
      'my order was ',
    );
  });

  testWidgets(
      'quick replies disappear once the customer sends their own message',
      (tester) async {
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    client.emitMessage(
      testMessage(id: 'm1', metadata: {
        'options': <Object?>['Yes']
      }),
    );
    await flush(tester);
    await tester.pump();
    expect(find.text('Yes'), findsOneWidget);

    client.emitMessage(
        testMessage(id: 'm2', senderType: SenderType.customer, content: 'ok'));
    await flush(tester);
    await tester.pump();

    expect(find.text('Yes'), findsNothing);
  });

  testWidgets('the typing indicator shows only while isTyping', (tester) async {
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    // By TYPE, not by the text it used to hold: the row is three animated
    // dots now, and a `find.text('…')` would go quietly green again the day
    // somebody put a static ellipsis back.
    expect(find.byType(TypingIndicator), findsNothing);
    client.emitTyping(true);
    await flush(tester);
    await tester.pump();
    expect(find.byType(TypingIndicator), findsOneWidget);

    client.emitTyping(false);
    await flush(tester);
    await tester.pump();
    expect(find.byType(TypingIndicator), findsNothing);
  });

  testWidgets('the composer is present and sends through the Cubit',
      (tester) async {
    cubit.openConversation('past-session-1');
    await tester.pumpWidget(_wrap(cubit));

    expect(find.byType(Composer), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'a follow-up');
    await tester.pump();
    await tester.tap(find.widgetWithIcon(IconButton, Icons.send));
    await tester.pump();

    expect(client.sentContent, <String>['a follow-up']);
  });
}
