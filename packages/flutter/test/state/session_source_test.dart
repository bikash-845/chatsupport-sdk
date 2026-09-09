// The optional session seam, driven the way a HOST drives it: through the
// constructor, with a function that returns a page — never by calling
// `updateSessionSummaries` from the test.
//
// ── Why that distinction is the whole point of this file ─────────────────
//
// A test that calls `cubit.updateSessionSummaries(...)` and asserts the state
// changed passes with the wire CUT: it drives the writer directly and proves
// nothing about whether anything ever reaches it. Every test here instead
// starts at the seam a host supplies, so deleting the
// `onSessions: _onSessionPage` hand-off inside `ChatWidgetCubit` (which is
// what calls `updateSessionSummaries`)
// turns them red.

import 'dart:async';

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_widget_chat_client.dart';

/// Lets a queued stream event and a resolved fetch reach their listeners.
/// Same reasoning as `chat_widget_cubit_test.dart`'s identical helper.
Future<void> flush() => Future<void>.delayed(Duration.zero);

ChatSessionSummary _summary(String id, {int unreadCount = 0}) =>
    ChatSessionSummary(
      id: id,
      status: ChatStatus.open,
      mode: ChatMode.human,
      createdAt: DateTime.utc(2026, 1, 1),
      unreadCount: unreadCount,
    );

HandledBy _agent(String name, {String id = 'a1'}) =>
    HandledBy(kind: HandledByKind.agent, id: id, displayName: name);

List<String> _ids(ChatWidgetCubit cubit) => cubit.state.sessionSummaries
    .map((ChatSessionSummary s) => s.id)
    .toList(growable: false);

void main() {
  late FakeWidgetChatClient fakeClient;

  setUp(() {
    fakeClient = FakeWidgetChatClient();
  });

  tearDown(() async {
    await fakeClient.dispose();
  });

  /// A Cubit wired to [fetch], closed when the test ends.
  ChatWidgetCubit cubitWith(SessionListFetch fetch) {
    final ChatWidgetCubit cubit =
        ChatWidgetCubit(client: fakeClient, sessionSource: fetch);
    addTearDown(cubit.close);
    return cubit;
  }

  /// Swallows and records what this Cubit reports to the host's channel, so a
  /// deliberately failing fetch does not dump a stack trace into the run.
  List<Object> captureReportedErrors() {
    final List<Object> reported = <Object>[];
    final FlutterExceptionHandler? previous = FlutterError.onError;
    FlutterError.onError =
        (FlutterErrorDetails details) => reported.add(details.exception);
    addTearDown(() => FlutterError.onError = previous);
    return reported;
  }

  group('sessionSource', () {
    test('fills the list when the widget opens', () async {
      final ChatWidgetCubit cubit =
          cubitWith(() async => <ChatSessionSummary>[_summary('a')]);

      // What `ChatWidget.initState` calls — the host wires nothing else.
      await cubit.connect();
      await flush();

      expect(_ids(cubit), <String>['a']);
    });

    test('carries unreadCount through to the badge', () async {
      final ChatWidgetCubit cubit = cubitWith(
        () async => <ChatSessionSummary>[
          _summary('a', unreadCount: 2),
          _summary('b', unreadCount: 3),
        ],
      );

      await cubit.connect();
      await flush();

      expect(cubit.state.unreadCount, 5);
    });

    test('refetches when a conversation ends', () async {
      List<ChatSessionSummary> page = <ChatSessionSummary>[_summary('a')];
      final ChatWidgetCubit cubit = cubitWith(() async => page);

      await cubit.connect();
      await flush();
      expect(_ids(cubit), <String>['a']);
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();

      // A status move is a row the list is already showing changing what it
      // says, so the page it is showing is now out of date.
      page = <ChatSessionSummary>[_summary('a'), _summary('b')];
      fakeClient.emitSession(testSession(id: 's1', status: ChatStatus.closed));
      await flush();

      expect(_ids(cubit), <String>['a', 'b']);
    });

    test('refetches when a different conversation arrives', () async {
      List<ChatSessionSummary> page = <ChatSessionSummary>[_summary('a')];
      final ChatWidgetCubit cubit = cubitWith(() async => page);

      await cubit.connect();
      await flush();
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();
      expect(_ids(cubit), <String>['a']);

      page = <ChatSessionSummary>[_summary('a'), _summary('b')];
      fakeClient.emitSession(testSession(id: 's2'));
      await flush();

      expect(_ids(cubit), <String>['a', 'b']);
    });

    test('routine snapshots of the live conversation do not refetch', () async {
      int fetches = 0;
      final ChatWidgetCubit cubit = cubitWith(() async {
        fetches++;
        return <ChatSessionSummary>[_summary('a')];
      });

      await cubit.connect();
      await flush();
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();
      final int settled = fetches;

      // The snapshot stream carries every session update, most of which
      // change nothing a summary row displays. Refetching a whole page for
      // each would be one request per keystroke-adjacent event, so the
      // trigger keys on the three fields a ROW is drawn from — id, status,
      // and the handledBy display name. See `_onSession`.
      //
      // Keying on id and status alone was the earlier, wrong rule: an
      // agent-to-agent handover moves only handledBy, so the list kept
      // naming the previous agent. The sibling test below pins that case.
      fakeClient.emitSession(testSession(id: 's1'));
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();
      await flush();

      expect(fetches, settled);
    });

    test('an empty page is ordinary success, never an error', () async {
      final List<Object> reported = captureReportedErrors();
      final ChatWidgetCubit cubit =
          cubitWith(() async => const <ChatSessionSummary>[]);

      await cubit.connect();
      await flush();

      // A guest gets `200 {sessions: []}` — never a 403. Reporting that as a
      // failure would make "not identified" indistinguishable from "the
      // lookup failed" at the one seam that knows they are different.
      expect(cubit.state.sessionSummaries, isEmpty);
      expect(reported, isEmpty);
    });

    test('a failed fetch leaves the page already on screen alone', () async {
      final List<Object> reported = captureReportedErrors();
      bool fail = false;
      final ChatWidgetCubit cubit = cubitWith(() async {
        if (fail) throw StateError('offline');
        return <ChatSessionSummary>[_summary('a')];
      });

      await cubit.connect();
      await flush();
      expect(_ids(cubit), <String>['a']);

      fail = true;
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();

      // A stale list still describes conversations that exist; an emptied one
      // claims they do not.
      expect(_ids(cubit), <String>['a']);
      expect(reported, hasLength(1));
      expect(reported.single, isA<StateError>());
    });

    test('refetches when the session moves to another agent', () async {
      List<ChatSessionSummary> page = <ChatSessionSummary>[_summary('a')];
      final ChatWidgetCubit cubit = cubitWith(() async => page);

      await cubit.connect();
      await flush();
      fakeClient.emitSession(testSession(id: 's1', handledBy: _agent('Priya')));
      await flush();
      expect(_ids(cubit), <String>['a']);

      // An agent-to-agent handover leaves the ID and the status exactly where
      // they were and moves only `handledBy` — and `handledBy` is a field
      // FOUR row surfaces are built out of, including the Home row's own
      // heading (`home_screen.dart:239`) and the accessible name
      // (`session_row_description.dart:64`). A list that does not refetch here
      // titles the row with the previous agent's name and reads it out.
      page = <ChatSessionSummary>[_summary('a'), _summary('b')];
      fakeClient.emitSession(
          testSession(id: 's1', handledBy: _agent('Sam', id: 'a2')));
      await flush();

      expect(_ids(cubit), <String>['a', 'b']);
    });

    test('a failed refetch is retried, not burned', () async {
      final List<Object> reported = captureReportedErrors();
      bool fail = false;
      List<ChatSessionSummary> page = <ChatSessionSummary>[_summary('a')];
      final ChatWidgetCubit cubit = cubitWith(() async {
        if (fail) throw StateError('offline');
        return page;
      });

      await cubit.connect();
      await flush();
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();
      expect(_ids(cubit), <String>['a']);

      // The conversation ends and the refetch fails on a flaky link.
      fail = true;
      page = <ChatSessionSummary>[_summary('a'), _summary('b')];
      fakeClient.emitSession(testSession(id: 's1', status: ChatStatus.closed));
      await flush();
      expect(_ids(cubit), <String>['a']);
      expect(reported, hasLength(1));

      // Recovery, and the reason a key recorded at ASK time is wrong: the
      // socket reconnects on the client's own backoff and never re-enters
      // `connect()`, so the only thing that comes back is another snapshot —
      // the `connection.ack` replay, carrying the SAME id and status. If that
      // does not refetch, the list reads "With an agent" for a conversation
      // that ended, indefinitely.
      fail = false;
      fakeClient.emitSession(testSession(id: 's1', status: ChatStatus.closed));
      await flush();

      expect(_ids(cubit), <String>['a', 'b']);
      expect(reported, hasLength(1));
    });

    test('a first-open failure recovers instead of staying empty', () async {
      final List<Object> reported = captureReportedErrors();
      bool fail = true;
      final ChatWidgetCubit cubit = cubitWith(() async {
        if (fail) throw StateError('offline');
        return <ChatSessionSummary>[_summary('a')];
      });

      // Both of the two triggers fail on the way in.
      await cubit.connect();
      await flush();
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();
      expect(cubit.state.sessionSummaries, isEmpty);
      expect(reported, hasLength(2));

      // The originally reported bug is a SILENTLY empty list, which is what a
      // customer is left with if two failures can consume every trigger there
      // is. The next snapshot has to try again.
      fail = false;
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();

      expect(_ids(cubit), <String>['a']);
    });

    test('a page that landed before a newer ask does not claim its key',
        () async {
      // The `isRefreshQueued` guard, which had no coverage: the reviewer
      // deleted it and all twelve tests stayed green.
      //
      // The interleaving it exists for: a page is in flight, a NEWER snapshot
      // asks for a refresh, then the in-flight page lands. That page predates
      // the ask, so promoting the newer key for it would mark work as done
      // that was never done -- and if the owed re-issue then failed, the key
      // would already be burned and nothing would retry. That is exactly the
      // bug this task was blocked for, rebuilt one level down.
      // Same capture the sibling failure tests use: the re-issue below fails
      // deliberately, and an uncaptured report dumps a stack into the run.
      captureReportedErrors();
      final List<Completer<List<ChatSessionSummary>>> pages =
          <Completer<List<ChatSessionSummary>>>[];
      final ChatWidgetCubit cubit = ChatWidgetCubit(
        client: fakeClient,
        sessionSource: () {
          final Completer<List<ChatSessionSummary>> c =
              Completer<List<ChatSessionSummary>>();
          pages.add(c);
          return c.future;
        },
      );
      addTearDown(cubit.close);

      await cubit.connect();
      expect(pages, hasLength(1), reason: 'open fetches once');

      // A newer snapshot asks while the first page is still in flight.
      fakeClient.emitSession(testSession(id: 's1', handledBy: _agent('Priya')));
      await flush();

      // Now the OLD page lands -- it cannot know about Priya.
      pages.first.complete(<ChatSessionSummary>[_summary('a')]);
      await flush();

      // The re-issue the queue owed us fires and fails.
      expect(pages, hasLength(2), reason: 'the queued ask was re-issued');
      pages[1].completeError(StateError('flaky link'));
      await flush();

      // The key must NOT have been claimed by the stale page, so an identical
      // later snapshot still retries.
      fakeClient.emitSession(testSession(id: 's1', handledBy: _agent('Priya')));
      await flush();
      expect(pages, hasLength(3),
          reason: 'a stale page claimed the newer key, so nothing retried');
    });

    test('a page landing after close is dropped, not emitted', () async {
      final Completer<List<ChatSessionSummary>> page =
          Completer<List<ChatSessionSummary>>();
      final ChatWidgetCubit cubit =
          ChatWidgetCubit(client: fakeClient, sessionSource: () => page.future);

      await cubit.connect();
      await cubit.close();
      page.complete(<ChatSessionSummary>[_summary('a')]);
      await flush();

      // An in-flight fetch is not cancellable, so the answer is dropped on
      // arrival. Writing it would be an emit on a closed Cubit.
      expect(cubit.state.sessionSummaries, isEmpty);
    });
  });

  group('without a sessionSource', () {
    test('nothing is fetched and the host push still works', () async {
      final ChatWidgetCubit cubit = ChatWidgetCubit(client: fakeClient);
      addTearDown(cubit.close);

      await cubit.connect();
      fakeClient.emitSession(testSession(id: 's1'));
      await flush();
      expect(cubit.state.sessionSummaries, isEmpty);

      // The way every existing host fills this list, unchanged.
      cubit.updateSessionSummaries(<ChatSessionSummary>[_summary('a')]);
      expect(_ids(cubit), <String>['a']);
    });
  });
}
