// The debug-mode diagnostic for the reported "my signed-in customer is being
// asked for their name".
//
// ── The report, and why the code was right ───────────────────────────────
//
// Twice now, from two different integrators: a host authenticates a customer,
// hands the widget a real customer token and the publishable key, and the
// customer is still asked to type their name in. That is working as designed
// — `ChatIdentity.isGuest` keys off the PROFILE and cannot key off anything
// else (see `chat_identity.dart`: the token is opaque to this package, and
// every guest has a `userId` too) — and that is exactly the problem. A host
// that never passes `identity` gets `ChatIdentity.guest` by default and no
// hint anywhere that it has just told the widget its customer is anonymous.
//
// So the warning fires at the moment the consequence becomes visible: the
// pre-chat gate going up in front of a GUEST. Not at construction — a
// guest-only deployment is a legitimate deployment, and a line printed on
// every launch is the line nobody reads on the day it matters.
//
// These tests drive the Cubit the way a host does — constructor identity,
// merchant config, a conversation the customer opened — and never call the
// warning directly.

import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/remote_config_fixtures.dart';
import 'fake_widget_chat_client.dart';

Future<void> flush() => Future<void>.delayed(Duration.zero);

const List<PreChatField> _fields = <PreChatField>[
  PreChatField(
    id: 'name',
    label: 'Your name',
    type: PreChatFieldType.text,
    required: true,
  ),
];

/// The merchant asking for details — the config half of the report.
RemoteConfig _asking() =>
    testRemoteConfig(preChatEnabled: true, preChatFields: _fields);

/// A host that has authenticated somebody. The PROFILE is the fact.
/// Kept field-for-field identical to the README's own snippet under "My
/// signed-in customer is still being asked for their name", so the analyzer
/// keeps that snippet honest.
const ChatIdentity _signedIn = ChatIdentity(
  userId: 'cus_1042',
  profile: ChatParticipantProfile(
    name: 'Jordan Rivera',
    email: 'jordan@example.com',
  ),
);

void main() {
  late FakeWidgetChatClient client;
  ChatWidgetCubit? cubit;

  setUp(() => client = FakeWidgetChatClient());
  tearDown(() async {
    await cubit?.close();
    await client.dispose();
  });

  /// Everything the package printed during a test, in order.
  ///
  /// `debugPrint` is a swappable top-level, which is what makes a diagnostic
  /// observable without it being an ERROR: a warning routed through
  /// `FlutterError.reportError` would fail the widget tests of every host
  /// with a guest-only deployment, which is not a thing an SDK may do to its
  /// integrators for a message that is only advice.
  List<String> capturePrints() {
    final List<String> printed = <String>[];
    final DebugPrintCallback previous = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null) printed.add(message);
    };
    addTearDown(() => debugPrint = previous);
    return printed;
  }

  /// The warning's own lines out of everything printed.
  List<String> warnings(List<String> printed) => printed
      .where((String line) => line.contains('identity.profile'))
      .toList(growable: false);

  /// A visitor the host mounted straight into a conversation, which is what
  /// makes `conversationOpened` true and lets the gate arm.
  Future<void> onConversation({
    ChatIdentity identity = ChatIdentity.guest,
    RemoteConfig? config,
  }) async {
    cubit = ChatWidgetCubit(
      client: client,
      initialConfig: config ?? _asking(),
      sessionId: 'sess_1',
      identity: identity,
    );
    client.emitSession(testSession(id: 'sess_1'));
    await flush();
  }

  group('the guest pre-chat diagnostic', () {
    test('warns when the gate is about to ask a GUEST for details', () async {
      final List<String> printed = capturePrints();

      await onConversation();

      expect(cubit!.state.activeSurface, isA<PreChatSurface>(),
          reason: 'the gate is up — this is the moment being warned about');
      expect(warnings(printed), hasLength(1));
    });

    test('says the three things a host has to be told', () async {
      final List<String> printed = capturePrints();

      await onConversation();

      final String message = warnings(printed).single;
      // userId is not the discriminator...
      expect(message, contains('userId'));
      // ...a token proves nothing about identity...
      expect(message, contains('token'));
      // ...and this is the thing to pass instead.
      expect(message, contains('ChatParticipantProfile'));
    });

    test('stays silent for a host that DID pass a profile', () async {
      final List<String> printed = capturePrints();

      await onConversation(identity: _signedIn);

      expect(cubit!.state.isGuest, isFalse);
      expect(warnings(printed), isEmpty);
    });

    // A guest-only deployment is legitimate. It gets one line per widget, not
    // one per tick — noise on every repaint is how a warning gets ignored.
    test('fires at most once, however many ticks follow', () async {
      final List<String> printed = capturePrints();

      await onConversation();
      client.emitSession(testSession(id: 'sess_1'));
      await flush();
      client.emitSession(testSession(id: 'sess_1'));
      await flush();
      client.emitTyping(true);
      await flush();

      expect(cubit!.state.activeSurface, isA<PreChatSurface>());
      expect(warnings(printed), hasLength(1));
    });

    // The trigger is the gate, not the identity: a guest deployment the
    // merchant never configured pre-chat for is never contradicted by
    // anything, so there is nothing to say.
    test('stays silent for a guest the gate never asks', () async {
      final List<String> printed = capturePrints();

      await onConversation(config: testRemoteConfig());

      expect(cubit!.state.isGuest, isTrue);
      expect(cubit!.state.activeSurface, isNull);
      expect(warnings(printed), isEmpty);
    });

    // Nothing identifying goes to a log. The Cubit cannot see the token at
    // all — the client owns it — and the userId it CAN see is the host's own
    // customer key, which has no business being correlated out of a console.
    test('logs nothing that identifies the visitor', () async {
      final List<String> printed = capturePrints();

      await onConversation(identity: const ChatIdentity(userId: 'cus_secret'));

      expect(warnings(printed), hasLength(1));
      expect(printed.join('\n'), isNot(contains('cus_secret')));
    });
  });
}
