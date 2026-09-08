/// The host half of the session picker: one REST page, mapped, handed to
/// `ChatWidgetCubit.updateSessionSummaries`.
///
/// ── The reported bug this file exists to answer ──────────────────────────
///
/// "The list of past conversations is empty." It was, on every run, because
/// nothing ever called `updateSessionSummaries`. The Cubit cannot populate it
/// itself and says so at length: `WidgetChatClient` is the WebSocket slice,
/// and `dhaam_chat` has no HTTP layer and cannot list sessions at all. The
/// list is the HOST's to fetch — from `dhaam_chat_rest`, which is the package
/// this app already holds a client for.
///
/// So this is the missing half of a seam, not a fix to either side of it.
///
/// ── Why `SessionListRefresher` and not a timer in the panel ──────────────
///
/// Because the cadence has two rules that are easy to get wrong in opposite
/// directions, and the package already owns both:
///
///  * two concurrent fetches are two writers of a page that is replaced
///    WHOLESALE, so an older one landing last puts every row back to the
///    status it had before a conversation closed;
///  * and a plain "already fetching, do nothing" guard DROPS the second ask,
///    so ending a conversation and immediately starting another settles the
///    list on a page fetched before the new conversation existed.
///
/// `session_list_refresher.dart` serialises the first and re-issues the
/// second. Writing a loop here would be re-deriving both, in the app whose
/// job is to demonstrate that they are already solved.
///
/// ── Two facts from the adapter that this file must not soften ────────────
///
/// **An empty page is ordinary success, and IS the guest signal.** A guest
/// gets `200 {sessions: []}` — never a 403, never a 404. `listSessions` does
/// not special-case it, deliberately, because turning it into an exception
/// would make "not identified" indistinguishable from "the lookup failed" at
/// exactly the seam that knows they are different. So [ExampleSessionListView]
/// below has THREE states, not two: an empty page is its own outcome and is
/// never reported as an error.
///
/// **A bad `limit` is a caller bug, not a network error.** `listSessions`
/// throws `RestValidationException` outside 1..20 BEFORE any request — the
/// type is the point, since it states that nothing was sent, nothing was
/// consumed and a retry will fail identically. [exampleSessionListRefresher]
/// therefore validates at CONSTRUCTION, so such a value can never reach the
/// refresher's `onError` and be dressed up as "the server is down".
library;

import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show ChatSessionSummary, ChatWidgetCubit, SessionListRefresher;
// `SessionApi` is an extension on `RestClient`, not a member of it: without it
// in scope `rest.listSessions(...)` does not resolve. Named explicitly rather
// than importing the barrel wholesale so that stays visible — the same reason
// `seams.dart` names `MediaApi`.
import 'package:dhaam_chat_rest/dhaam_chat_rest.dart'
    show
        RestChatSessionSummary,
        RestClient,
        RestValidationException,
        SessionApi,
        kSessionSummaryLimitMax,
        kSessionSummaryLimitMin;

/// How many conversations this example asks for.
///
/// Inside 1..20 — the range `validateSessionSummaryLimit` enforces before any
/// request. A `null` here would be equally valid and would defer to the
/// server's own default of 5; a number is passed instead so the example
/// demonstrates the parameter rather than the absence of it.
const int kExampleSessionLimit = 10;

/// One REST row, as the widget's own summary type.
///
/// Field-for-field, and that is not a coincidence: `RestChatSessionSummary`
/// and `ChatSessionSummary` both reuse `dhaam_chat`'s [ChatStatus]/[ChatMode]/
/// [HandledBy] rather than each minting an enum, so there is no vocabulary to
/// translate here and no place for a mapping to be subtly wrong.
///
/// The two types exist separately anyway, and correctly: one is what a REST
/// route returned and the other is what a host supplies to the widget. A host
/// that proxies chat through its own backend fills the second from something
/// that is not the first, which is the whole reason the widget takes a list
/// rather than a client.
ChatSessionSummary toChatSessionSummary(RestChatSessionSummary row) =>
    ChatSessionSummary(
      id: row.id,
      status: row.status,
      mode: row.mode,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      lastMessageAt: row.lastMessageAt,
      lastMessagePreview: row.lastMessagePreview,
      unreadCount: row.unreadCount,
      handledBy: row.handledBy,
      subject: row.subject,
      topic: row.topic,
    );

/// What the diagnostics panel says about the last fetch.
///
/// Three states, because the adapter distinguishes three. Collapsing `empty`
/// into `error` — the obvious two-state shape — is the exact mistake the
/// route's own documentation warns against: it would report a guest, whose
/// page is a perfectly ordinary success, as a failure.
enum ExampleSessionListView {
  /// No fetch has settled yet.
  pending,

  /// A page arrived with rows on it.
  loaded,

  /// A page arrived with no rows. Ordinary success — and what a guest gets,
  /// since a guest has no conversations of their own to list.
  empty,

  /// The fetch failed. The previous page, if any, is still on screen.
  failed,
}

/// Builds the refresher this app drives.
///
/// [limit] is checked HERE, against the same bounds `listSessions` uses,
/// rather than being left to fail inside the fetch. That is the whole reason
/// this is a function and not a constructor call at the call site: a
/// `RestValidationException` raised inside `SessionListRefresher._drain`
/// reaches `onError`, which is the callback a caller reads as "the network
/// failed" — so a caller bug would arrive wearing a network error's clothes,
/// which is precisely what the typed exception exists to prevent.
///
/// Throws [ArgumentError] for an out-of-range [limit]: a programming error
/// reported at construction, before anything is wired up and long before a
/// customer could be shown anything.
SessionListRefresher exampleSessionListRefresher({
  required RestClient rest,
  required void Function(List<ChatSessionSummary> sessions) onSessions,
  required void Function(Object error, StackTrace stackTrace) onError,
  int limit = kExampleSessionLimit,
}) {
  if (limit < kSessionSummaryLimitMin || limit > kSessionSummaryLimitMax) {
    throw ArgumentError.value(
      limit,
      'limit',
      'must be between $kSessionSummaryLimitMin and $kSessionSummaryLimitMax '
          '— listSessions would raise RestValidationException before sending '
          'anything, and routing that through onError would report a caller '
          'bug as a network failure',
    );
  }

  return SessionListRefresher(
    fetch: () async {
      final List<RestChatSessionSummary> page =
          await rest.listSessions(limit: limit);
      // `map`, not a loop with a try: `listSessions` already omits a row it
      // cannot decode, so every row that reaches here is decodable and this
      // mapping cannot fail.
      return page.map(toChatSessionSummary).toList(growable: false);
    },
    onSessions: onSessions,
    onError: onError,
  );
}

/// How to describe [error] to whoever is integrating.
///
/// A `RestValidationException` reaching here would mean the guard in
/// [exampleSessionListRefresher] was bypassed — so it is named as the caller
/// bug it is rather than shown beside genuine transport failures. The panel
/// this feeds is a developer strip, not customer-facing UI; a customer is
/// shown the previous page and no error at all, which is the refresher's own
/// documented behaviour.
String describeSessionListError(Object error) =>
    error is RestValidationException
        ? 'caller bug, not a network error — nothing was sent: ${error.message}'
        : '$error';

/// The refresher wired to a Cubit — the hop the reported bug was missing.
///
/// ── Why this is a named function and not four lines in `main.dart` ──────
///
/// It was four lines in `main.dart`, and nothing could test them. Every piece
/// around it had coverage — `listSessions` in `dhaam_chat_rest`, this file's
/// serialisation above, `MessagesScreen`'s rendering in the package — and the
/// one line joining them to the screen had none, which is precisely the line
/// that was absent when "no conversations list" was reported.
///
/// A test can drive this with a `MockClient`-backed [RestClient] and assert
/// the Cubit's state actually changed. Deleting the `updateSessionSummaries`
/// call inside it turns that test red; while the same call lived in a State's
/// closure, no test could reach it and cutting the wire stayed green.
///
/// [isStale] lets the caller drop an answer that arrived after teardown —
/// `main.dart` passes its `mounted` check. Default is "always deliver",
/// because a caller with no lifetime of its own should not have to say so.
SessionListRefresher sessionListFor({
  required ChatWidgetCubit cubit,
  required RestClient rest,
  required void Function(Object error, StackTrace stackTrace) onError,
  void Function(List<ChatSessionSummary> sessions)? onLoaded,
  bool Function() isStale = _neverStale,
  int limit = kExampleSessionLimit,
}) {
  return exampleSessionListRefresher(
    rest: rest,
    limit: limit,
    onSessions: (List<ChatSessionSummary> sessions) {
      if (isStale()) return;
      // The write the reported bug was missing. `dhaam_chat` cannot list
      // sessions, so this is the only way the Messages screen is ever given
      // anything to draw.
      cubit.updateSessionSummaries(sessions);
      onLoaded?.call(sessions);
    },
    onError: onError,
  );
}

bool _neverStale() => false;
