/// The host half of the session picker, tested without a network.
///
/// `SessionListRefresher` takes a `SessionListFetch` — a plain
/// `Future<List<ChatSessionSummary>> Function()` — which is exactly why it can
/// be driven here with a closure. That seam is the package's, and this file is
/// the proof that the example is on the right side of it: everything below
/// asserts what THIS app does with a page, not what the refresher does with
/// one.
library;

import 'package:dhaam_chat/dhaam_chat.dart'
    show ChatMode, ChatStatus, HandledBy, HandledByKind, PublishableKey;
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show ChatSessionSummary, SessionListRefresher;
import 'package:dhaam_chat_flutter_example/session_list.dart';
import 'package:dhaam_chat_rest/dhaam_chat_rest.dart'
    show
        RestChatSessionSummary,
        RestClient,
        RestValidationException,
        kSessionSummaryLimitMax,
        kSessionSummaryLimitMin;
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('toChatSessionSummary', () {
    test('carries every field across', () {
      final DateTime created = DateTime.utc(2026, 9, 1, 10);
      final DateTime lastMessage = DateTime.utc(2026, 9, 1, 11);
      final DateTime closed = DateTime.utc(2026, 9, 1, 12);
      const HandledBy handledBy = HandledBy(
        kind: HandledByKind.agent,
        id: 'agent-1',
        displayName: 'Grace',
      );

      final ChatSessionSummary mapped = toChatSessionSummary(
        RestChatSessionSummary(
          id: 'session-1',
          status: ChatStatus.closed,
          mode: ChatMode.human,
          createdAt: created,
          closedAt: closed,
          lastMessageAt: lastMessage,
          lastMessagePreview: 'Thanks for your help',
          unreadCount: 3,
          subject: 'Order #1234',
          topic: 'billing',
          handledBy: handledBy,
        ),
      );

      expect(mapped.id, 'session-1');
      expect(mapped.status, ChatStatus.closed);
      expect(mapped.mode, ChatMode.human);
      expect(mapped.createdAt, created);
      expect(mapped.closedAt, closed);
      expect(mapped.lastMessageAt, lastMessage);
      expect(mapped.lastMessagePreview, 'Thanks for your help');
      expect(mapped.unreadCount, 3);
      expect(mapped.subject, 'Order #1234');
      expect(mapped.topic, 'billing');
      expect(mapped.handledBy, handledBy);
    });

    test('keeps an open session’s nulls as nulls', () {
      // A row with no closedAt, no message yet and nobody assigned. Inventing
      // anything here — a title from the first message, a placeholder agent —
      // is what `ChatSessionSummary`'s own doc forbids.
      final ChatSessionSummary mapped = toChatSessionSummary(
        RestChatSessionSummary(
          id: 'session-2',
          status: ChatStatus.open,
          mode: ChatMode.bot,
          createdAt: DateTime.utc(2026, 9, 2),
          closedAt: null,
          lastMessageAt: null,
        ),
      );

      expect(mapped.closedAt, isNull);
      expect(mapped.lastMessageAt, isNull);
      expect(mapped.lastMessagePreview, isNull);
      expect(mapped.handledBy, isNull);
      expect(mapped.subject, isNull);
      expect(mapped.topic, isNull);
      expect(mapped.unreadCount, 0);
    });
  });

  group('exampleSessionListRefresher limit', () {
    test('the example’s own limit is inside the adapter’s range', () {
      // The constant and the bound come from the same place, so this cannot
      // drift into a value that would raise before any request.
      expect(kExampleSessionLimit,
          inInclusiveRange(kSessionSummaryLimitMin, kSessionSummaryLimitMax));
    });

    test('an out-of-range limit is refused at construction, not at fetch', () {
      // The point of the guard. `listSessions` would raise
      // `RestValidationException` before sending anything — but inside the
      // refresher that lands on `onError`, the callback a caller reads as
      // "the network failed". Refusing here keeps a caller bug looking like
      // a caller bug.
      //
      // The client is real and never used: constructing one opens no
      // connection, and the guard throws before anything reaches it. That the
      // endpoint is unroutable is the assertion restated — a fetch would have
      // had to happen for it to matter.
      final RestClient rest = _client();
      addTearDown(rest.close);

      for (final int bad in <int>[0, -1, kSessionSummaryLimitMax + 1]) {
        expect(
          () => exampleSessionListRefresher(
            rest: rest,
            onSessions: (_) {},
            onError: (_, __) {},
            limit: bad,
          ),
          throwsA(isA<ArgumentError>()),
          reason: 'limit $bad should never reach a fetch',
        );
      }
    });

    test('an in-range limit builds a refresher that has not fetched', () {
      final RestClient rest = _client();
      addTearDown(rest.close);

      final SessionListRefresher refresher = exampleSessionListRefresher(
        rest: rest,
        onSessions: (_) {},
        onError: (_, __) {},
      );
      addTearDown(refresher.dispose);

      // Constructing is not fetching: the panel builds this before the Cubit
      // exists and asks for the first page afterwards, because `onSessions`
      // writes into that Cubit.
      expect(refresher.isRefreshing, isFalse);
      expect(refresher.isRefreshQueued, isFalse);
    });
  });

  group('describeSessionListError', () {
    test('names a validation failure as a caller bug', () {
      final String described = describeSessionListError(
        const RestValidationException('limit must be between 1 and 20, got 0'),
      );

      expect(described, contains('caller bug'));
      expect(described, contains('nothing was sent'));
    });

    test('passes an ordinary failure through as itself', () {
      final String described =
          describeSessionListError(StateError('connection reset'));

      expect(described, contains('connection reset'));
      expect(described, isNot(contains('caller bug')));
    });
  });

  /// The behaviours the panel depends on, driven through the same seam the
  /// panel drives — a fetch closure and a writer callback.
  group('the refresher, as this app drives it', () {
    test('one refresh produces one page and one write', () async {
      int fetches = 0;
      final List<List<ChatSessionSummary>> writes =
          <List<ChatSessionSummary>>[];

      final SessionListRefresher refresher = SessionListRefresher(
        fetch: () async {
          fetches++;
          return <ChatSessionSummary>[_summary('a')];
        },
        onSessions: writes.add,
      );

      await refresher.refresh();

      expect(fetches, 1);
      expect(writes, hasLength(1));
      expect(writes.single.single.id, 'a');
    });

    test('an empty page is written, not swallowed', () async {
      // The guest path. If this app treated empty as "nothing to do" the
      // Cubit would keep whatever it had, and a customer who signed out would
      // go on seeing somebody else's conversations.
      final List<List<ChatSessionSummary>> writes =
          <List<ChatSessionSummary>>[];

      final SessionListRefresher refresher = SessionListRefresher(
        fetch: () async => const <ChatSessionSummary>[],
        onSessions: writes.add,
      );

      await refresher.refresh();

      expect(writes, hasLength(1));
      expect(writes.single, isEmpty);
    });

    test('a close during a flight is re-issued, not dropped', () async {
      // The cadence `RestSessionActions.onSessionChanged` relies on. Ending a
      // conversation while the panel-open fetch is still out must not settle
      // the list on a page fetched before the close.
      int fetches = 0;
      final List<List<ChatSessionSummary>> writes =
          <List<ChatSessionSummary>>[];
      late SessionListRefresher refresher;

      refresher = SessionListRefresher(
        fetch: () async {
          fetches++;
          if (fetches == 1) {
            // Somebody closes a conversation while this one is in flight.
            unawaitedRefresh(refresher);
          }
          return <ChatSessionSummary>[_summary('page$fetches')];
        },
        onSessions: writes.add,
      );

      await refresher.refresh();

      expect(fetches, 2, reason: 'the ask during the flight is owed a re-issue');
      expect(writes.last.single.id, 'page2',
          reason: 'the newer page must land last');
    });

    test('a failed fetch leaves the previous page alone', () async {
      // Why `_sessionsView` becomes `failed` rather than `empty`: an emptied
      // list claims the conversations do not exist, while a stale one still
      // describes conversations that do.
      int fetches = 0;
      final List<List<ChatSessionSummary>> writes =
          <List<ChatSessionSummary>>[];
      final List<Object> errors = <Object>[];

      final SessionListRefresher refresher = SessionListRefresher(
        fetch: () async {
          fetches++;
          if (fetches == 2) throw StateError('connection reset');
          return <ChatSessionSummary>[_summary('a')];
        },
        onSessions: writes.add,
        onError: (Object error, StackTrace _) => errors.add(error),
      );

      await refresher.refresh();
      await refresher.refresh();

      expect(errors, hasLength(1));
      // One write, from the successful first fetch. The failure wrote nothing.
      expect(writes, hasLength(1));
      expect(writes.single.single.id, 'a');
    });

    test('a disposed refresher writes nothing further', () async {
      // What `_ChatPanelPageState.dispose` buys: a page landing after the
      // Cubit is closed would be an emit on a closed Cubit.
      final List<List<ChatSessionSummary>> writes =
          <List<ChatSessionSummary>>[];

      final SessionListRefresher refresher = SessionListRefresher(
        fetch: () async => <ChatSessionSummary>[_summary('a')],
        onSessions: writes.add,
      );

      refresher.dispose();
      await refresher.refresh();

      expect(writes, isEmpty);
    });
  });
}

/// Asks for a refresh from inside a fetch, ignoring the returned future.
///
/// A named helper rather than an inline `unawaited`, so the test above reads
/// as the event it stands for — somebody closing a conversation — rather than
/// as future plumbing.
void unawaitedRefresh(SessionListRefresher refresher) {
  refresher.refresh();
}

ChatSessionSummary _summary(String id) => ChatSessionSummary(
      id: id,
      status: ChatStatus.open,
      mode: ChatMode.bot,
      createdAt: DateTime.utc(2026, 9, 1),
    );

/// A client that is constructed and never sends anything.
///
/// `RestClient`'s constructor opens no connection, so this costs a couple of
/// field assignments. The endpoint is deliberately unroutable: every test
/// using it asserts that no request is made, and an unroutable host is what
/// turns a broken such assertion into a failure rather than a live call.
RestClient _client() => RestClient(
      apiUrl: 'https://api.invalid',
      publishableKey: PublishableKey.parse('dhp_test_examplekey123456'),
      getAccessToken: () async => 'header.payload.signature',
    );
