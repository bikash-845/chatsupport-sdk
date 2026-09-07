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
