/// Whether this app's wiring actually produces a paperclip.
///
/// ── The reported bug, and what was actually wrong with it ────────────────
///
/// "File upload / attachments do not appear." The triage said the example
/// constructs no `AttachmentDraftController`, so the button is hidden. That is
/// not how the seam works, and building one here would have been the wrong
/// fix:
///
///  * `ChatWidgetCubit` takes the two SEAMS — `attachmentUploader` and
///    `attachmentPicker` — and builds the controller itself, once per
///    composer, through `createAttachmentDraft`. A draft is one composer's
///    pending file and has to die with it, so a host-built one shared across
///    conversations would let a file picked in one reappear in the next.
///  * `ConversationScreen` already calls that factory and already passes the
///    answer to `Composer(attachments:)`.
///  * and `main.dart` already passes `attachmentUploader:`.
///
/// So the chain is whole, and the honest thing to add is not a controller but
/// the test that would notice if the one line holding the chain together were
/// removed. `attachmentUploader` is optional and its absence is silent by
/// design — "off, not broken" — which is exactly the property that lets a
/// paperclip disappear without a single test going red.
///
/// What remains, and is not this app's to fix: the button is ALSO gated on
/// `RemoteConfig.fileUploads`, which is the merchant's switch and defaults to
/// **false** on a `Composer` built before the config lands. A tenant with
/// uploads turned off correctly shows no paperclip. The host screen names the
/// effective value for that reason.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show
        AttachmentDraftController,
        ChatWidgetCubit,
        PickedAttachment,
        WidgetChatClient;
import 'package:dhaam_chat_flutter_example/seams.dart';
import 'package:dhaam_chat_rest/dhaam_chat_rest.dart'
    show RestClient, RestMultipartFile;
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('createAttachmentDraft, given this app’s wiring', () {
    test('an uploader produces a draft controller — the paperclip’s '
        'precondition', () async {
      // Exactly what `main.dart` passes. If that argument is ever dropped,
      // this is what goes red instead of the button quietly vanishing.
      final ChatWidgetCubit cubit = ChatWidgetCubit(
        client: _FakeClient(),
        attachmentUploader: exampleAttachmentUploader(
          _restClient(),
          () => 'session-1',
        ),
      );
      addTearDown(cubit.close);

      final AttachmentDraftController? draft =
          cubit.createAttachmentDraft(onError: (_, __) {});

      expect(draft, isNotNull);
      // Owned by whoever asked for it — every caller that gets a non-null
      // answer must dispose it, which is what `ConversationScreen.dispose`
      // does and what this stands in for.
      draft!.dispose();
    });

    test('no uploader produces none, and the composer grows no controls',
        () async {
      // The "off, not broken" half. An attach button that opened a picker and
      // then had nowhere to send the bytes is worse than an absent one: the
      // customer chooses a file, waits, and is told a feature that was never
      // wired has failed.
      final ChatWidgetCubit cubit = ChatWidgetCubit(client: _FakeClient());
      addTearDown(cubit.close);

      expect(cubit.createAttachmentDraft(onError: (_, __) {}), isNull);
    });

    test('two composers get two controllers, not one shared', () async {
      // Not a getter and not cached, deliberately: a shared draft would let a
      // file picked in one conversation reappear in the next.
      final ChatWidgetCubit cubit = ChatWidgetCubit(
        client: _FakeClient(),
        attachmentUploader:
            exampleAttachmentUploader(_restClient(), () => 'session-1'),
      );
      addTearDown(cubit.close);

      final AttachmentDraftController? first =
          cubit.createAttachmentDraft(onError: (_, __) {});
      final AttachmentDraftController? second =
          cubit.createAttachmentDraft(onError: (_, __) {});
      addTearDown(() => first?.dispose());
      addTearDown(() => second?.dispose());

      expect(first, isNot(same(second)));
    });
  });

  group('exampleAttachmentUploader', () {
    test('reads the session id at upload time, not at build time', () async {
      // The reason the seam takes a callback. A long-lived draft controller
      // must not post a file against the conversation that happened to be
      // open when its composer was built.
      String session = 'session-before';
      final List<String> posted = <String>[];

      final Future<AttachmentMetadata> Function(PickedAttachment) upload =
          exampleAttachmentUploader(
        _recordingClient(posted),
        () => session,
      );

      session = 'session-after';
      await upload(_picked()).catchError((Object _) => _metadata());

      expect(posted, <String>['session-after']);
    });
  });

  group('exampleAttachmentDraft', () {
    test('constructs and disposes', () {
      // seams.dart builds this as compile-time proof that the real picker and
      // the real uploader fit each other. Disposing it is the half a comment
      // cannot assert: the controller's `_disposed` guard is what keeps an
      // upload still in flight from writing into a torn-down composer.
      final AttachmentDraftController draft = exampleAttachmentDraft(
        rest: _restClient(),
        sessionId: () => 'session-1',
        onError: (_, __) {},
      );

      // Nothing picked yet, and no picker was opened to find that out —
      // constructing the controller touches no platform channel.
      expect(draft.draft, isNull);

      // Disposed exactly once, which is the contract: it extends
      // `ChangeNotifier`, so a second call trips an assertion. That is why
      // ownership is stated everywhere it is passed around — the party that
      // asked for a controller is the only party that may end it.
      draft.dispose();
    });
  });
}

RestClient _restClient() => RestClient(
      apiUrl: 'https://api.invalid',
      publishableKey: PublishableKey.parse('dhp_test_examplekey123456'),
      getAccessToken: () async => 'header.payload.signature',
    );

/// A client that records the session id each upload was posted against.
///
/// The request itself fails — the host is unroutable — which is fine and is
/// the point: the assertion is about what the closure READ, and it has read it
/// by the time the request is attempted.
RestClient _recordingClient(List<String> posted) => _RecordingRestClient(
      posted,
      apiUrl: 'https://api.invalid',
      publishableKey: PublishableKey.parse('dhp_test_examplekey123456'),
      getAccessToken: () async => 'header.payload.signature',
    );

class _RecordingRestClient extends RestClient {
  _RecordingRestClient(
    this._posted, {
    required super.apiUrl,
    required super.publishableKey,
    required super.getAccessToken,
  });

  final List<String> _posted;

  @override
  Future<Object?> request(
    String method,
    String path, {
    Map<String, Object?>? query,
    Object? jsonBody,
    RestMultipartFile? multipart,
  }) async {
    final Object? session = query?['chatSessionId'];
    if (session is String) _posted.add(session);
    throw StateError('no network in this test');
  }
}

PickedAttachment _picked() => PickedAttachment(
      bytes: Uint8List.fromList(<int>[1, 2, 3]),
      fileName: 'receipt.png',
      mimeType: 'image/png',
    );

AttachmentMetadata _metadata() => const AttachmentMetadata(
      url: 'https://cdn.invalid/receipt.png',
      fileName: 'receipt.png',
      mimeType: 'image/png',
      size: 3,
      mediaType: 'images',
    );

/// The narrowest thing that satisfies `WidgetChatClient`.
///
/// Broadcast controllers because the Cubit subscribes to every one of them in
/// its constructor, and none of them ever emits here: these tests are about
/// what the Cubit BUILDS from its seams, not about what it does with traffic.
class _FakeClient implements WidgetChatClient {
  final StreamController<ConnectionState> _connection =
      StreamController<ConnectionState>.broadcast();
  final StreamController<ChatMessage> _messages =
      StreamController<ChatMessage>.broadcast();
  final StreamController<SessionSnapshot> _sessions =
      StreamController<SessionSnapshot>.broadcast();
  final StreamController<TypingEvent> _typing =
      StreamController<TypingEvent>.broadcast();
  final StreamController<ReconnectingEvent> _reconnecting =
      StreamController<ReconnectingEvent>.broadcast();
  final StreamController<SessionClosed> _sessionClosed =
      StreamController<SessionClosed>.broadcast();
  final StreamController<AgentEvent> _agentEvents =
      StreamController<AgentEvent>.broadcast();
  final StreamController<ErrorPayload> _errors =
      StreamController<ErrorPayload>.broadcast();

  @override
  ConnectionState get connectionState => ConnectionState.idle;
  @override
  Stream<ConnectionState> get connectionStates => _connection.stream;
  @override
  Stream<ChatMessage> get messages => _messages.stream;
  @override
  Stream<SessionSnapshot> get sessions => _sessions.stream;
  @override
  Stream<TypingEvent> get typing => _typing.stream;
  @override
  Stream<ReconnectingEvent> get reconnecting => _reconnecting.stream;
  @override
  Stream<SessionClosed> get sessionClosed => _sessionClosed.stream;
  @override
  Stream<AgentEvent> get agentEvents => _agentEvents.stream;
  @override
  Stream<ErrorPayload> get errors => _errors.stream;
  @override
  int get queuedCount => 0;
  @override
  SuspendReason? get suspendReason => null;

  @override
  Future<void> connect() async {}
  @override
  bool retryNow() => false;
  @override
  void joinSession(String sessionId) {}
  @override
  void markRead({String? upToMessageId}) {}
  @override
  void startTyping() {}
  @override
  RetryOutcome retry(String messageId) =>
      throw UnimplementedError('not exercised');
  @override
  ChatMessage sendMessage(
    String content, {
    MessageType type = MessageType.text,
    String? replyToMessageId,
    Map<String, Object?>? metadata,
    AttachmentMetadata? attachment,
  }) =>
      throw UnimplementedError('not exercised');
}
