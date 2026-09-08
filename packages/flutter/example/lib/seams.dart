/// The seams `dhaam_chat_flutter` deliberately leaves injectable, filled in
/// with the real implementations a host is expected to supply.
///
/// ── Why this file is the point of the example ────────────────────────────
///
/// Every one of these is a function type or a one-method interface that the
/// package takes as a parameter rather than constructing for itself, so that
/// its own tests can pass a closure and never touch a platform channel or a
/// network. That property is worth having and it has a cost: nothing in the
/// package's 930 tests ever exercises the REAL implementations together. This
/// file is the first place they meet.
///
/// Each declaration below is CONSTRUCTED, not described. If
/// `filePickerAttachmentPicker` ever stops satisfying `AttachmentPicker`, or
/// `RestClient.uploadAttachment` changes shape, this file stops compiling —
/// which is the whole reason to write the recipe as code rather than as a
/// paragraph in the README.
///
/// ── Everything here is now passed to something ───────────────────────────
///
/// This header used to say that two of these had nowhere to go. Both
/// statements are now out of date, and in different ways.
///
/// [exampleChime] was described as unreachable because "nothing inside the
/// package constructs one". That was wrong when it was written and stayed
/// wrong: `ChatWidget` has always taken an optional `chime`
/// (`chat_widget.dart:71`, `widget.chime ?? Chime()`), so the seam was open
/// the whole time and this app simply did not use it. It does now — which is
/// the entire argument for keeping this panel honest, since a "not wired"
/// row nobody rechecks reads as a missing feature rather than as a missing
/// line in an example.
///
/// The session list was a third case, and a different one again: the seam is
/// `ChatWidgetCubit.updateSessionSummaries`, and nothing called it, so the
/// Messages screen was empty on every run. That fetch does not live in this
/// file because it is not a closure the package takes — it is a page a host
/// goes and gets. It lives in `session_list.dart`, and the panel below it
/// reports on it.
///
/// [exampleAttachmentDraft] was in that list for a real reason and no longer
/// is — not
/// because it is now passed, but because the shape it demonstrated was
/// wrong. `ChatWidgetCubit` takes the two SEAMS (`attachmentUploader`,
/// `attachmentPicker`) and builds the draft controller per composer itself,
/// because a draft is one composer's pending file and must die with it. So
/// `main.dart` passes [exampleAttachmentUploader] directly and the assembled
/// controller below exists only as compile-time proof that the picker and the
/// uploader fit each other.
library;

import 'package:dhaam_chat/dhaam_chat.dart' show TokenProvider;
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show
        AttachmentDraftController,
        AttachmentPicker,
        AttachmentUploader,
        Chime,
        PickedAttachment,
        filePickerAttachmentPicker;
// `MediaApi` is an extension on `RestClient`, not a member of it: without it
// in scope `rest.uploadAttachment(...)` does not resolve. Named explicitly
// rather than importing the barrel wholesale so that stays visible.
import 'package:dhaam_chat_rest/dhaam_chat_rest.dart'
    show GeolocationProbe, MediaApi, RestClient, RestGeoPosition;
import 'package:flutter/foundation.dart';

/// The `getToken` callback both clients take.
///
/// ── This is the shape, and the example is not the example of it ──────────
///
/// A real host's body is `myBackend.mintChatToken()` — an HTTP call to its own
/// server, which holds the secret key. `ChatClient` re-reads this on every
/// connect and every reauth, so returning a fresh token from it is how a
/// refresh is picked up without restarting anything.
///
/// This one closes over a string from `--dart-define` and hands back the same
/// value every time, which means a run outlives its token by exactly as long
/// as the token had left. That is a limitation of the example, not of the SDK,
/// and it is the one place here where copying this file verbatim would be
/// wrong.
TokenProvider exampleTokenProvider(String token) => () async => token;

/// What this build calls itself, for `captureContactInfo`.
///
/// There is no `navigator.userAgent` in a Flutter app, so the host names
/// itself. [defaultTargetPlatform] rather than `dart:io`'s `Platform`: this
/// example builds for web, where `dart:io` is not available at all.
String exampleUserAgent() =>
    'dhaam_chat_flutter_example/1.0.0 (${defaultTargetPlatform.name})';

/// A [GeolocationProbe] that honours the contract by declining.
///
/// ── Why this declines rather than asking for a fix ───────────────────────
///
/// The seam's contract is three rules: resolve `null` and never reject, pass
/// the timeout to the platform API rather than racing a second timer, and
/// never re-prompt a visitor who has already declined. A real host satisfies
/// all three with a location plugin — `geolocator` is the usual choice, and
/// its `getCurrentPosition` takes the timeout directly.
///
/// This example does not add one, for a reason that is specific rather than
/// general: a location plugin obliges the host to declare permission strings
/// on iOS, macOS and Android, and this app's platform files carry exactly the
/// entries the SDK's own plugins documented and no invented ones. Adding four
/// permission declarations to demonstrate a value that has nowhere to go (see
/// [seamReports] on `captureContactInfo`) would be inventing host requirements
/// to exercise a dead path.
///
/// So: `null`, immediately, with the timeout unused and named as unused. The
/// visitor is never prompted, which is the correct behaviour for an app that
/// cannot ask.
Future<RestGeoPosition?> exampleGeolocationProbe(Duration timeout) async =>
    null;

/// Compile-time proof that [exampleGeolocationProbe] satisfies the seam.
///
/// A bare top-level function is not checked against a typedef until something
/// assigns it to one. This is that something.
const GeolocationProbe kExampleGeolocationProbe = exampleGeolocationProbe;

/// The real platform file chooser, as an [AttachmentPicker].
///
/// `filePickerAttachmentPicker` is the package's own one-line wrapper over
/// `FilePicker.pickFiles`; everything that can go wrong (the 25 MiB cap, the
/// bounded byte read, the media-type sniff, what a cancel looks like) lives
/// behind it in ordinary testable Dart. A host passes this tear-off; a test
/// passes a closure.
const AttachmentPicker kExampleAttachmentPicker = filePickerAttachmentPicker;

/// The real uploader: `POST /upload`, through the REST client.
///
/// [sessionId] is a callback rather than a value because the seam's signature
/// is `Future<AttachmentMetadata> Function(PickedAttachment)` — the session is
/// not one of its parameters, and the conversation a file belongs to can
/// change under a long-lived controller. Reading it at upload time is what
/// keeps a file from being posted against the session that was open when the
/// composer was built.
///
/// Note the absence of any `?? 'application/octet-stream'` on `mimeType`. That
/// is deliberate and is `uploadAttachment`'s own rule: an empty type means
/// "the platform said nothing" and gets the fallback inside that method, while
/// a non-empty malformed one still raises. Substituting here would collapse
/// the two cases at the one seam that can still tell them apart.
AttachmentUploader exampleAttachmentUploader(
  RestClient rest,
  String Function() sessionId,
) {
  return (PickedAttachment file) => rest.uploadAttachment(
        sessionId: sessionId(),
        bytes: file.bytes,
        fileName: file.fileName,
        mimeType: file.mimeType,
      );
}

/// The picker and the uploader, assembled into the controller that owns the
/// draft, the 25 MiB refusal and the in-flight flag.
///
/// **The app does not pass THIS** — it passes the two seams to
/// `ChatWidgetCubit`, which builds one of these per composer. See this
/// library's header. It is built anyway because building it is what proves
/// the pieces fit: the controller's constructor is what type-checks the
/// picker and the uploader against each other, so a change to either shape
/// stops this file compiling rather than failing at the first tap.
AttachmentDraftController exampleAttachmentDraft({
  required RestClient rest,
  required String Function() sessionId,
  required void Function(Object error, StackTrace stackTrace) onError,
}) {
  return AttachmentDraftController(
    picker: kExampleAttachmentPicker,
    uploader: exampleAttachmentUploader(rest, sessionId),
    onError: onError,
  );
}

/// The message-arrival chime, with the package's own default player.
///
/// `Chime()` with no factory uses `playSystemChime`, which is
/// `SystemSound.play(SystemSoundType.alert)` — Flutter's own, no audio plugin,
/// no asset, nothing for a host to bundle. That is why this seam needs no
/// dependency where the geolocation one would have needed a plugin and four
/// permission strings.
///
/// **Nothing constructs one of these inside the package**, so like
/// [exampleAttachmentDraft] this is built and not passed. Its `play` still
/// needs `sound` (the merchant's `RemoteConfig.sound`) and `muted` (the header
/// menu's per-visitor state) supplied on every call, and both live inside the
/// widget tree.
Chime exampleChime() => Chime();

/// Whether a seam is actually connected to the widget tree, or only built.
enum SeamWiring {
  /// Passed to the SDK. Exercised by running the app.
  wired,

  /// Constructed and type-checked here, but no public constructor parameter
  /// accepts it and no mounted widget consumes it.
  unreachable,
}

/// One seam, and the truth about it.
class SeamReport {
  const SeamReport({
    required this.name,
    required this.wiring,
    required this.detail,
  });

  final String name;
  final SeamWiring wiring;
  final String detail;
}

/// What this example was able to wire, and what it was not.
///
/// Rendered on the host page rather than buried in the README, because the
/// person this matters to is holding the running app and wondering why the
/// paperclip is missing. A parity gap that only exists in a document is a gap
/// somebody rediscovers.
const List<SeamReport> seamReports = <SeamReport>[
  SeamReport(
    name: 'ChatSessionActions',
    wiring: SeamWiring.wired,
    detail:
        'RestClient close/reopen/CSAT, passed to ChatWidgetCubit(sessionActions:). '
        'Without it there is no rating card, no ended footer and no way to end '
        'a conversation.',
  ),
  SeamReport(
    name: 'GeolocationProbe',
    wiring: SeamWiring.wired,
    detail:
        'Passed to captureContactInfo. Declines rather than prompting — this '
        'app adds no location plugin, so it cannot ask.',
  ),
  SeamReport(
    name: 'AttachmentPicker / AttachmentUploader',
    wiring: SeamWiring.wired,
    detail:
        'file_picker plus RestClient POST /upload, passed to ChatWidgetCubit. '
        'ConversationScreen builds one AttachmentDraftController per composer '
        'from these two seams — a host does NOT build one, because a draft is '
        'one composer’s pending file and dies with it. If the paperclip is '
        'missing with this row green, the gate is RemoteConfig.fileUploads: '
        'see “Uploads enabled” above, which is the merchant’s switch and not '
        'a seam anyone here can fill.',
  ),
  SeamReport(
    name: 'VoiceDevice',
    wiring: SeamWiring.wired,
    detail:
        'The package default, RecordVoiceDevice, on record 6.2.1 — no seam for '
        'this app to fill. The mic records PCM through startStream, wraps it '
        'in a WAVE header and hands it to the same draft a picked file goes '
        'through. Needs the microphone entries in ios/, macos/ and android/, '
        'and Android minSdk 23.',
  ),
  SeamReport(
    name: 'IssueReporter',
    wiring: SeamWiring.wired,
    detail:
        'restIssueReporter over POST /chat/sessions/{id}/report-issue, passed '
        'to ChatWidgetCubit(issueReporter:). Without it the header menu drops '
        'the Report row entirely rather than offering a dead one.',
  ),
  SeamReport(
    name: 'Session list (updateSessionSummaries)',
    wiring: SeamWiring.wired,
    detail:
        'dhaam_chat_rest listSessions, mapped and pushed through '
        'ChatWidgetCubit.updateSessionSummaries by a SessionListRefresher — '
        'see session_list.dart. The Cubit cannot populate this itself: '
        'dhaam_chat has no HTTP layer and cannot list sessions at all, so a '
        'host that renders nothing here has a Messages screen with nothing to '
        'draw. An empty page is ordinary success and is the guest signal.',
  ),
  SeamReport(
    name: 'ChimePlayer',
    wiring: SeamWiring.wired,
    detail: 'Chime() with the package default (SystemSound.alert — no audio '
        'plugin, no asset), passed to ChatWidget(chime:). ChatWidget builds '
        'its own when a host passes none, so arrivals chime either way; what '
        'this seam buys is replacing the sound.',
  ),
];
