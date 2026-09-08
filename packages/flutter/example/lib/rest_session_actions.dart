/// `ChatSessionActions`, implemented over `dhaam_chat_rest`'s `RestClient`.
///
/// ── This is the adapter the seam was designed to receive ─────────────────
///
/// `session_actions.dart` describes this class before it existed: "this is the
/// seam, and `dhaam_chat_rest`'s `RestClient` is the adapter a host writes
/// over it — four methods, each a direct delegation." That is what this is.
/// It is four methods and no logic, which is the point — every rule that could
/// be got wrong (the 404/405 classification, the two-round-trip read-back, the
/// converged reopen id) already lives in the package below.
///
/// ── Why the host writes it and the package does not ──────────────────────
///
/// `dhaam_chat_flutter` now depends on `dhaam_chat_rest` (orchestrator
/// decision D22), so it COULD ship this class. It does not, and the seam's own
/// doc gives the reason: a host that already proxies chat through its own
/// backend has a different transport and still wants these screens. The
/// interface is what makes that host possible; this class is what makes the
/// ordinary host's job four lines.
library;

import 'package:dhaam_chat_rest/dhaam_chat_rest.dart'
    show
        CsatLookupFn,
        CsatStatus,
        RestChatSession,
        RestClient,
        SessionApi,
        csatLookupOver;
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show ChatSessionActions;

class RestSessionActions implements ChatSessionActions {
  /// [csatLookupOver] is built once, in the initializer list, rather than per
  /// call. It closes over [rest] and holds no state, so building it per call
  /// would allocate for nothing — but the real reason to name it here is that
  /// it is the one method of the four with a RULE in it, and having exactly
  /// one instance of that rule per client is the property worth pinning.
  RestSessionActions(RestClient rest, {this.onSessionChanged})
      : _rest = rest,
        _readCsat = csatLookupOver(rest);

  final RestClient _rest;
  final CsatLookupFn _readCsat;

  /// Fired after a close or a reopen has actually applied.
  ///
  /// ── Why the session list is refreshed from HERE ────────────────────────
  ///
  /// Closing a conversation changes a row the picker is already showing, and
  /// nothing tells the picker so: the list is a REST page, not a live
  /// projection, and `session.closed` arrives on the socket for the session
  /// the widget has open rather than as a new page. Without this hook the
  /// customer ends a conversation and watches its row go on reading "With an
  /// agent" until the panel is closed and reopened.
  ///
  /// This is the second of the two asks `SessionListRefresher` was built to
  /// serialise — the panel-open fetch is the first — and firing it here is
  /// what makes the collapsing behaviour its header describes reachable at
  /// all.
  ///
  /// Optional, because the interface it fills does not require it: a host
  /// that renders no picker wires nothing and these methods stay four plain
  /// delegations.
  final void Function()? onSessionChanged;

  /// `GET …/csat`, through `csatLookupOver`.
  ///
  /// Delegated rather than reimplemented so the 404/405 → `CsatRouteMissing`
  /// classification is not re-derived per host. Writing a second 404 check
  /// here is the documented way to break this: an enveloped
  /// `SESSION_NOT_FOUND` — an answer ABOUT this session — would be read as a
  /// missing route and re-offer the survey over a conversation that is already
  /// rated.
  @override
  Future<CsatStatus> readCsat(String sessionId) => _readCsat(sessionId);

  /// `POST …/csat`. One round trip; a rating does not touch session state.
  ///
  /// `submitCsat` answers with the stored `RestCsatSubmission` and the
  /// interface asks for nothing back, which is a widening Dart allows because
  /// every type is a subtype of `void`. Discarding it is right: the card
  /// re-reads through [readCsat] rather than trusting what it just wrote, so a
  /// second writer would only be a second thing to keep in step.
  @override
  Future<void> submitCsat(
    String sessionId, {
    required int rating,
    String? comment,
  }) =>
      _rest.submitCsat(sessionId, rating: rating, comment: comment);

  /// `POST …/close`, then the `GET …/full` read-back.
  ///
  /// The returned session is dropped deliberately, and the seam's doc says why
  /// at length: the terminal status arrives on the SOCKET as
  /// `session.closed`/`session.updated`, and `ChatWidgetState.session` follows
  /// that. Applying the REST answer here as well would make two writers of the
  /// on-screen session out of two different types.
  ///
  /// Nothing catches `RestSessionReadBackException` here on purpose. It means
  /// the close ALREADY APPLIED and only the read failed, and closing is not
  /// idempotent — swallowing it and letting a caller retry re-emits a "chat
  /// closed" SYSTEM message and another Kafka event, in the customer's own
  /// transcript. It belongs to whoever can decide, which is the caller.
  @override
  Future<void> closeSession(String sessionId) async {
    await _rest.closeSession(sessionId);
    // AFTER the await, so a close that threw does not announce a change that
    // did not happen. A `RestSessionReadBackException` is the one case where
    // it did happen and is deliberately still not announced here: it escapes
    // to the caller who has to decide (see this method's doc), and a refresh
    // scheduled on the way past would be this class quietly deciding the
    // close counted.
    onSessionChanged?.call();
  }

  /// `POST …/reopen`, answering with the SETTLED id.
  ///
  /// Which may not be the one asked for. Reopen converges onto an
  /// already-active session and returns that one — the ordinary outcome when
  /// another tab has already reopened this conversation. `_rest.reopenSession`
  /// has already followed the receipt's id through its own read-back, so the
  /// session that comes back is the settled one and its `id` is the answer.
  /// Returning [sessionId] instead would send the customer back into a session
  /// the server did not reopen.
  @override
  Future<String> reopenSession(String sessionId) async {
    final RestChatSession settled = await _rest.reopenSession(sessionId);
    // Same placement and same reason as [closeSession]'s. A reopen may also
    // have converged onto a DIFFERENT session than the one asked for, which
    // is a second row the picker is now wrong about — so the refresh matters
    // here for one more reason than it does there.
    onSessionChanged?.call();
    return settled.id;
  }
}
