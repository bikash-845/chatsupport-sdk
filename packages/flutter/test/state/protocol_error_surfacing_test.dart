/// The connection's own failures have to reach a widget, not just the host.
///
/// This exists because they did not. `ChatClient` reported every §6.5 error
/// and `WidgetChatClient` exposed none of them, so a developer pointing the
/// SDK at a misconfigured endpoint watched it reconnect forever with the
/// cause available nowhere in the Flutter layer — `AUTH_INVALID`, a refused
/// protocol version and a validation failure all rendered as an endless
/// "Connecting…". Reported from a real integration, not imagined.
library;

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_widget_chat_client.dart';

void main() {
  _typingFoldTests();

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

  test('a protocol error reaches the state', () async {
    expect(cubit.state.lastError, isNull);

    client.emitError(const ErrorPayload(
      code: ErrorCode.authInvalid,
      message: 'Authentication failed',
      retryable: false,
    ));
    await Future<void>.delayed(Duration.zero);

    expect(cubit.state.lastError?.code, ErrorCode.authInvalid);
    expect(cubit.state.lastError?.message, 'Authentication failed');
  });

  test('the give-up reason is read on the same tick as the error', () async {
    // The two arrive separately: the cap is reached by the LAST of several
    // failures, and only then does the client suspend. Reading `suspendReason`
    // when the error lands is what keeps them in one state rather than
    // leaving a widget to correlate two events.
    client.suspended = SuspendReason.auth;
    client.emitError(const ErrorPayload(
      code: ErrorCode.authInvalid,
      message: 'Authentication failed',
      retryable: false,
    ));
    await Future<void>.delayed(Duration.zero);

    expect(cubit.state.suspendReason, SuspendReason.auth);
  });

  test('a recoverable error does not claim the client has given up', () async {
    // Not every error is fatal. A widget that tore itself down on the first
    // one would be wrong about the commonest case: a blip that the next
    // attempt recovers from.
    client.emitError(const ErrorPayload(
      code: ErrorCode.rateLimited,
      message: 'Slow down',
      retryable: true,
    ));
    await Future<void>.delayed(Duration.zero);

    expect(cubit.state.lastError?.code, ErrorCode.rateLimited);
    expect(cubit.state.suspendReason, isNull,
        reason: 'still trying — suspendReason is what says otherwise');
  });
}

/// The typing indicator follows WHO is typing, not the last event's flag.
///
/// Found by an adversarial review of the typing port, which called it "the
/// exact bug this module was built to eliminate, recurring one layer up": the
/// protocol client keeps a per-participant map precisely so a stop from one
/// agent cannot clear an indicator another agent is still earning, and the
/// cubit threw that away by reading `event.isTyping` off whichever event
/// arrived last.
void _typingFoldTests() {
  group('typing fold', () {
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

    test('one agent stopping does not clear an indicator another still earns',
        () async {
      // A starts, B starts, A stops. The last event says isTyping:false while
      // B is still mid-sentence.
      client.emitTyping(true, participantId: 'agent-a');
      await Future<void>.delayed(Duration.zero);
      expect(cubit.state.isTyping, isTrue);

      client.emitTyping(true, participantId: 'agent-b');
      await Future<void>.delayed(Duration.zero);

      // A's stop — including the 5s auto-clear manufacturing one — removes A
      // from the map and nothing else.
      client.emitTyping(false, participantId: 'agent-a');
      await Future<void>.delayed(Duration.zero);

      expect(cubit.state.isTyping, isTrue,
          reason: 'B is still typing; reading the last event flag says false');
    });

    test('the indicator clears when the last participant stops', () async {
      client.emitTyping(true, participantId: 'agent-a');
      await Future<void>.delayed(Duration.zero);
      expect(cubit.state.isTyping, isTrue);

      client.emitTyping(false, participantId: 'agent-a');
      await Future<void>.delayed(Duration.zero);

      expect(cubit.state.isTyping, isFalse);
    });
  });
}
