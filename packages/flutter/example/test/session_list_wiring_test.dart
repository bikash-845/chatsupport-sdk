/// The hop nothing covered: a fetched session list reaching the screen.
///
/// The reported bug was "no conversations list maintained", and every piece
/// was already tested in isolation — `listSessions` in `dhaam_chat_rest`, the
/// refresher's serialisation in `session_list_test.dart`, and
/// `MessagesScreen`'s rendering in the package. What nothing asserted was that
/// the refresher's answer is handed to the Cubit at all, and that is exactly
/// where the wire was cut.
///
/// So this drives the real seam: a fetch resolves, and the state a screen
/// reads from must carry it. Deleting the `updateSessionSummaries` call in
/// `main.dart` turns this red and nothing else does.
library;

import 'package:dhaam_chat/dhaam_chat.dart' show ChatMode, ChatStatus;
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show ChatSessionSummary, ChatWidgetCubit, SessionListRefresher;
import 'package:dhaam_chat_flutter_example/session_list.dart';
import 'package:dhaam_chat_rest/dhaam_chat_rest.dart' show RestClient;
import 'package:dhaam_chat/dhaam_chat.dart' show PublishableKey;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'attachment_wiring_test.dart' show makeFakeClient;

ChatSessionSummary _summary(String id) => ChatSessionSummary(
      id: id,
      status: ChatStatus.open,
      mode: ChatMode.bot,
      createdAt: DateTime.utc(2026, 1, 1),
      subject: 'Order $id',
      lastMessagePreview: 'Where is it?',
    );

void main() {
  late ChatWidgetCubit cubit;

  setUp(() => cubit = ChatWidgetCubit(client: makeFakeClient()));
  tearDown(() async => cubit.close());

  test('a fetched list reaches the state a screen reads from', () {
    expect(cubit.state.sessionSummaries, isEmpty);

    // Stands in for `exampleSessionListRefresher`'s `onSessions`, which is the
    // one line under test — the app wires it to `updateSessionSummaries`.
    cubit.updateSessionSummaries(<ChatSessionSummary>[
      _summary('s1'),
      _summary('s2'),
    ]);

    expect(cubit.state.sessionSummaries.map((ChatSessionSummary s) => s.id),
        <String>['s1', 's2']);
  });

  test('an empty answer is a real state, not a no-op', () {
    // The guest case, and the one most easily mistaken for "the fetch failed".
    // `listSessions` answers a guest with `[]` by design, and the screen must
    // show its empty state rather than keep stale rows from a previous user.
    cubit.updateSessionSummaries(<ChatSessionSummary>[_summary('s1')]);
    expect(cubit.state.sessionSummaries, hasLength(1));

    cubit.updateSessionSummaries(const <ChatSessionSummary>[]);
    expect(cubit.state.sessionSummaries, isEmpty,
        reason: 'an empty list must replace, not be ignored');
  });

  test('the example asks for a limit the adapter will accept', () {
    // An out-of-range limit throws BEFORE any request, so it would surface as
    // a caller bug at startup rather than an empty list — worth pinning next
    // to the wiring it would otherwise be blamed on.
    expect(kExampleSessionLimit, inInclusiveRange(1, 20));
  });

  test('a real fetch reaches the state, through the app\'s own wiring',
      () async {
    // The test the reported bug needed and nobody had. It drives
    // `sessionListFor` -- the function `main.dart` actually calls -- over a
    // MockClient, so cutting the `updateSessionSummaries` call inside it turns
    // this red. Asserting on `cubit.updateSessionSummaries` directly does not:
    // that passes happily while the app never calls it, which is exactly how
    // this shipped.
    final RestClient rest = RestClient(
      apiUrl: 'https://chat.example.test',
      publishableKey: PublishableKey.parse('dhp_test_0123456789abcdefghijklmn'),
      getAccessToken: () async => 'tok',
      httpClient: MockClient((http.Request _) async => http.Response(
            '{"success":true,"data":{"sessions":[{"id":"s9",'
            '"status":"OPEN","mode":"BOT","createdAt":"2026-01-01T00:00:00Z",'
            '"unreadCount":0}]}}',
            200,
            headers: <String, String>{'content-type': 'application/json'},
          )),
    );

    final List<List<ChatSessionSummary>> loaded = <List<ChatSessionSummary>>[];
    final SessionListRefresher refresher = sessionListFor(
      cubit: cubit,
      rest: rest,
      onLoaded: loaded.add,
      onError: (Object e, StackTrace s) => fail('unexpected failure: $e'),
    );

    await refresher.refresh();

    expect(cubit.state.sessionSummaries.map((ChatSessionSummary s) => s.id),
        <String>['s9'],
        reason: 'the fetched page must reach the state MessagesScreen reads');
    expect(loaded, hasLength(1),
        reason: 'the host still gets its own notification for diagnostics');
  });
}
