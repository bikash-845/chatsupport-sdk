/// Wires a [WidgetChatClient], a [RemoteConfig] and a [ChatScreens] together
/// into one Cubit — the state container every screen in this package reads
/// from and dispatches into.
///
/// ── Why Cubit, not Bloc ──────────────────────────────────────────────────
///
/// Both `dh-customer-app-flutter` and `dh-merchant-app-flutter` standardise
/// on `flutter_bloc` (`^9.1.1` in both) — checked before choosing anything
/// here, per this package's brief. Within that one package, this class is a
/// [Cubit] rather than a [Bloc] for the same reason
/// `dh-customer-app-flutter`'s own `ConnectivityCubit`
/// (`lib/core/network/connectivity_cubit.dart`) is one: the job is mirroring
/// an external source's stream into widget-renderable state via direct
/// method calls, not routing a taxonomy of discrete user-typed events
/// through transformers. `flutter_bloc` is the one pattern; Cubit vs Bloc is
/// a style choice inside it, not a second pattern introduced alongside it.
library;

import 'dart:async';

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../config/remote_config.dart';
// For `shouldCollectOffline`, the one function that weighs `isOpenNow`
// against `offlineMode` — see `surfaceInputs`.
import '../config/remote_config_client.dart';
import '../nav/chat_screens.dart';
import '../session/chat_session_summary.dart';
import '../surfaces/product_surface_slot.dart';
import '../ui/attachments/attachments.dart';
import '../ui/voice/voice.dart';
import '../ui/composer_affordances/reply_target.dart';
import '../ui/consent/consent.dart';
import '../ui/offline_form/offline_form.dart';
import '../ui/csat/session_actions.dart';
// For `IssueReporter` — the seam the "Report an issue" form submits through,
// and `RestIssueReport`, which that file re-exports. Same shape as the CSAT
// import above: a function type declared where its widget lives, consumed
// here, so this class still constructs no network client of its own.
import '../ui/header/transcript_email.dart';
import '../forms/forms.dart' show FormErrorReporter;
import '../ui/pre_chat/pre_chat.dart';
import 'chat_widget_state.dart';
import 'widget_chat_client.dart';

/// The longest a recoverable outage is allowed to look stuck.
///
/// `dhaam_chat`'s full-jitter backoff (§8.2) is right about servers and wrong
/// about phones. Its whole job is to protect a recovering server from every
/// client it dropped reconnecting in lockstep, and it does that by growing the
/// delay to a 30-second cap. But the commonest outage a chat widget actually
/// sees is not a server restart — it is one handset losing signal for ninety
/// seconds. That handset is not part of a thundering herd, and making it wait
/// out a 30-second delay after its signal is back is how "it just says
/// Connecting…" gets reported.
///
/// Three seconds is the ceiling this puts on that wait. It does not replace
/// backoff: the client's early attempts are all faster than this (500ms, 1s,
/// 2s), so for the first several failures this timer never wins. It only bites
/// once the curve has climbed past it, which is exactly the regime where one
/// device's retry rate is nobody's problem.
///
/// The same number as `DEFAULT_RECONNECT_INTERVAL_MS` in `@dhaam-ccrm/browser`.
const Duration kReconnectInterval = Duration(seconds: 3);

class ChatWidgetCubit extends Cubit<ChatWidgetState> {
  /// [sessionId] names a conversation the HOST wants this widget to open on.
  ///
  /// It decides two things at once, and they are the same fact: which screen
  /// the panel starts on, and whether the customer is looking at a
  /// conversation from the first frame — see
  /// [ChatWidgetState.conversationOpened]. A host that names one has put a
  /// conversation in front of the customer; one that does not has not, and
  /// the pre-chat gate must not fire at mount for it.
  ///
  /// [initialScreen] still overrides the screen half for a host that wants
  /// to land on Messages, and is what the existing callers pass.
  ChatWidgetCubit({
    required WidgetChatClient client,
    RemoteConfig initialConfig = defaultRemoteConfig,
    ScreenName? initialScreen,
    String? sessionId,
    ChatIdentity identity = ChatIdentity.guest,
    Scheduler scheduler = const SystemScheduler(),
    Duration reconnectInterval = kReconnectInterval,
    ChatSessionActions? sessionActions,
    ConsentGate? consent,
    IssueReporter? issueReporter,
    AttachmentUploader? attachmentUploader,
    AttachmentPicker attachmentPicker = filePickerAttachmentPicker,
    VoiceDeviceFactory createVoiceDevice = RecordVoiceDevice.new,
  })  : _client = client,
        _createVoiceDevice = createVoiceDevice,
        _consent = consent ?? ConsentGate.unremembered(),
        _sessionActions = sessionActions,
        _issueReporter = issueReporter,
        _attachmentUploader = attachmentUploader,
        _attachmentPicker = attachmentPicker,
        _screens = ChatScreens(
          initial: initialScreen ??
              (sessionId == null ? ScreenName.home : ScreenName.conversation),
        ),
        _scheduler = scheduler,
        _reconnectInterval = reconnectInterval,
        super(
          ChatWidgetState.initial(
            config: initialConfig,
            screen: initialScreen ??
                (sessionId == null ? ScreenName.home : ScreenName.conversation),
            identity: identity,
            // The port of `initialScreenName === 'conversation'`. Landing on
            // the conversation screen IS the customer being put in front of
            // a conversation, however the host spelled it.
            conversationOpened:
                (initialScreen ?? ScreenName.home) == ScreenName.conversation ||
                    sessionId != null,
          ),
        ) {
    _connectionSub = _client.connectionStates.listen(_onConnectionState);
    _messagesSub = _client.messages.listen(_onMessage);
    _sessionsSub = _client.sessions.listen(_onSession);
    _typingSub = _client.typing.listen(_onTyping);
    _errorsSub = _client.errors.listen(_onProtocolError);
    _reconnectingSub = _client.reconnecting.listen(_onReconnecting);
    _sessionClosedSub = _client.sessionClosed.listen(_onSessionClosed);
    final ChatSessionActions? actions = sessionActions;
    if (actions != null) {
      final CsatMachine machine = CsatMachine(
        lookup: actions.readCsat,
        // A route-missing verdict is deliberately NOT reported — an older
        // service is not a fault, and the machine already withholds it. What
        // reaches here is a genuine lookup failure, and it goes where every
        // other error in this package goes: the host's channel, never the
        // customer's screen.
        onError: (Object error, StackTrace stackTrace) =>
            FlutterError.reportError(
          FlutterErrorDetails(exception: error, stack: stackTrace),
        ),
      );
      _csat = machine;
      // The answer landing is a state change like any other: whatever was
      // decided while the lookup was `CsatLoading` has to be decided again.
      _csatSub = machine.changes.listen(_onCsatVerdict);
    }
    // Read ONCE, here, and applied when it lands — see
    // [ChatWidgetState.consentAgreed] on why the gate is closed until then.
    // Fire-and-forget because there is nothing for a caller to await: the
    // answer arrives as a state change like any other, and a Cubit whose
    // construction awaited I/O would be untestable by construction (the same
    // reason [connect] is not called from here either).
    unawaited(_restoreConsent());
  }

  final WidgetChatClient _client;
  final ChatScreens _screens;

  /// The REST slice the end-of-conversation surfaces need, or null when the
  /// host wired none up — in which case there is no rating card, no ended
  /// footer and no way to end a conversation from here. Off, not broken; a
  /// card whose submit silently discarded the answer would be worse.
  final ChatSessionActions? _sessionActions;

  /// The raw `POST /chat/sessions/{id}/report-issue` route, or null when the
  /// host wired none up — in which case the ⋯ menu does not offer the row at
  /// all. Off, not broken, exactly as [_sessionActions] is: `header_menu.dart`
  /// states the rule ("an unbacked item is absent from `headerMenuEntries`
  /// entirely"), because a disabled row still reads as a feature the customer
  /// is somehow not allowed to use.
  ///
  /// ── Why the host closes the session id over, rather than this passing it ──
  ///
  /// [IssueReporter] takes only the report; the session comes from the
  /// [SessionIdSource] the host handed [restIssueReporter], and that source is
  /// a FUNCTION precisely so it is read at the moment of the action rather
  /// than captured when the widget was built. A host therefore wires it
  /// against this Cubit's own state and no second memory of "which session"
  /// exists:
  ///
  /// ```dart
  /// late final ChatWidgetCubit cubit;
  /// cubit = ChatWidgetCubit(
  ///   client: client,
  ///   issueReporter: restIssueReporter(
  ///     client: restClient,
  ///     sessionId: () => cubit.state.session?.sessionId ?? cubit.endedSessionId,
  ///   ),
  /// );
  /// ```
  ///
  /// The `late` is safe because the closure is not invoked during
  /// construction — only when a report is actually filed.
  final IssueReporter? _issueReporter;

  /// `POST /upload`, or null when the host wired none up — in which case the
  /// composer grows no paperclip at all.
  ///
  /// Off, not broken, exactly as [_issueReporter] and [_sessionActions] are.
  /// An attach button that opened a picker and then had nowhere to send the
  /// bytes would let a customer choose a file, watch a spinner and get a
  /// failure sentence for a feature that was never wired — worse than an
  /// absent control, which at least tells the truth immediately.
  ///
  /// ── Why the host closes the session id over ──────────────────────────
  ///
  /// [AttachmentUploader] takes only the file; the session comes from the
  /// closure the host built it with, read at upload time rather than
  /// captured when the composer was built. Same rule and same reason as
  /// [_issueReporter]'s [SessionIdSource] — a long-lived draft controller
  /// must not post a file against the conversation that happened to be open
  /// when its widget was created.
  ///
  /// ```dart
  /// late final ChatWidgetCubit cubit;
  /// cubit = ChatWidgetCubit(
  ///   client: client,
  ///   attachmentUploader: (PickedAttachment file) => restClient.uploadAttachment(
  ///     sessionId: cubit.state.session?.sessionId ?? '',
  ///     bytes: file.bytes,
  ///     fileName: file.fileName,
  ///     mimeType: file.mimeType,
  ///   ),
  /// );
  /// ```
  final AttachmentUploader? _attachmentUploader;

  /// Where a file comes from. Defaults to the real platform chooser.
  ///
  /// Unlike [_attachmentUploader] this has a default, and the asymmetry is
  /// the point: a picker is something this package CAN supply (it carries
  /// `file_picker`, and `filePickerAttachmentPicker` is its own one-line
  /// wrapper), while an uploader needs an endpoint and credentials only the
  /// host has. So the seam stays open — a widget test passes a closure and
  /// touches no `MethodChannel` — without obliging every host to supply
  /// something the package already has.
  final AttachmentPicker _attachmentPicker;

  /// Builds the microphone. Defaults to the real one, on `record`.
  ///
  /// Defaulted for the same reason [_attachmentPicker] is: capture is
  /// something this package CAN supply, and once the plugin is a dependency
  /// its native code is linked into every host's build whether or not the
  /// button is ever shown — so making hosts wire a factory would buy them
  /// nothing they have not already paid for.
  ///
  /// A factory rather than a device, so nothing opens an audio device until
  /// the first press. Overridden in tests with a fake, which is how the
  /// whole voice module is exercised without a microphone.
  final VoiceDeviceFactory _createVoiceDevice;

  /// The server-truth memory of who has rated what. Null alongside
  /// [_sessionActions], since it has nothing to ask.
  CsatMachine? _csat;

  /// The remembered answer to the merchant's consent notice.
  ///
  /// Never null: a host that wired no durable store gets
  /// [ConsentGate.unremembered], which honours the click for this widget's
  /// lifetime and asks again next mount. That is the reference's own
  /// documented behaviour for a browser with site data blocked, not a
  /// degraded mode — so there is no "consent is off" case to branch on here.
  final ConsentGate _consent;

  /// [_csat]'s verdicts, mirrored for [ChatWidgetState.csatBySession]. The
  /// `emit` override below is the only writer of the state half.
  final Map<String, CsatLookup> _csatBySession = <String, CsatLookup>{};

  /// The session this client watched get PARKED — closed with
  /// `CloseReason.switched` because the customer moved to another active
  /// conversation (§12.5).
  ///
  /// ── Why a parked session needs recording rather than ignoring ───────
  ///
  /// `session.status` still moves to CLOSED on the server for a SWITCHED
  /// close, so by status alone a parked session is indistinguishable from a
  /// resolved one — and would be offered a satisfaction survey, and an
  /// "This conversation has ended" footer, for a conversation nobody ended
  /// and that telling the customer is over would be a lie about.
  ///
  /// Compared by EXACT id ([endedSessionId]), so the guard cannot leak onto a
  /// different session's genuine resolution. Cleared by a snapshot naming a
  /// different, real session — see [_onSession].
  String? _parkedSessionId;

  /// The claim on the slot held by the "End this conversation?" question.
  SurfaceTicket? _confirmEndTicket;

  /// The claim on the slot held by the "Report an issue" form.
  ///
  /// Not cleared by [_syncScreen] the way [_composingTicket] is, and that is
  /// the same choice [_confirmEndTicket] makes: a ticket carries the
  /// GENERATION it was issued for, so one left behind by a customer who
  /// walked off to Home no longer holds the slot and cannot close whatever
  /// took it. Clearing it would be tidier and would change nothing.
  SurfaceTicket? _reportTicket;

  /// The ONE slot a product surface can occupy.
  ///
  /// ── This wiring lands once ─────────────────────────────────────────
  ///
  /// The CSAT card, the session picker, the header menu's report form and
  /// the consent/offline surfaces all stand in this same slot. They append
  /// their own methods below and their own facts to [surfaceInputs]; none of
  /// them creates a second slot, re-runs the sync on its own cadence, or
  /// mirrors the occupant into state by hand. A second slot is two surfaces
  /// live at once, which is the state `ProductSurfaceSlot` exists to make
  /// unreachable.
  final ProductSurfaceSlot _surfaces = ProductSurfaceSlot();

  /// The slot, for a screen that needs to cancel or release a surface it
  /// opened. Read-only access to the occupant is
  /// [ChatWidgetState.activeSurface], which is what widgets should build
  /// from — this is for the mutators.
  ProductSurfaceSlot get surfaces => _surfaces;

  /// The claim on the slot held by the new-conversation form, or null when it
  /// is not up.
  ///
  /// Held rather than re-derived because a ticket carries the GENERATION it
  /// was issued for: a form the customer opened, walked away from and opened
  /// again must not be closed by the first one's stale callback. See
  /// [SurfaceTicket].
  SurfaceTicket? _composingTicket;

  /// `dhaam_chat`'s own timer seam, reused rather than reinvented: the whole
  /// reconnect cadence below is then drivable from a test with a
  /// `FakeScheduler` and no real clock, exactly as that package's own
  /// connection tests are.
  final Scheduler _scheduler;
  final Duration _reconnectInterval;

  /// The armed cadence tick, or null when there is nothing to cap.
  Cancellable? _reconnectTimer;

  /// Keyed by id so the optimistic-echo-then-confirmed pair `ChatClient`
  /// emits for one send (see its class doc) collapses to one entry rather
  /// than appearing twice. A `Map` preserves insertion order even when an
  /// existing key's value is replaced, which is what keeps the transcript in
  /// arrival order without a separate sort — see [ChatWidgetState.messages].
  ///
  /// What this does NOT do: reorder around gaps or resumed history.
  /// `dhaam_chat` surfaces those as `client.gaps` for a host to refetch over
  /// REST (see its README) — out of scope here for the same reason the
  /// config fetch is the only REST this package adds.
  final Map<String, ChatMessage> _byId = <String, ChatMessage>{};

  late final StreamSubscription<ConnectionState> _connectionSub;
  late final StreamSubscription<ChatMessage> _messagesSub;
  late final StreamSubscription<SessionSnapshot> _sessionsSub;
  late final StreamSubscription<TypingEvent> _typingSub;
  late final StreamSubscription<ErrorPayload> _errorsSub;
  late final StreamSubscription<ReconnectingEvent> _reconnectingSub;
  late final StreamSubscription<SessionClosed> _sessionClosedSub;
  StreamSubscription<String>? _csatSub;

  /// For a screen that needs to call something this Cubit does not wrap
  /// (none does yet) — kept `WidgetChatClient`-typed, not `ChatClient`, so a
  /// caller cannot widen back to the surface this class was built to avoid
  /// depending on.
  WidgetChatClient get client => _client;

  // ── Surfaces ──────────────────────────────────────────────────────────

  /// Stamps the live slot onto every state this Cubit emits.
  ///
  /// ── Why an override rather than a call at each site ────────────────
  ///
  /// [ChatWidgetState.activeSurface] is a MIRROR of `_surfaces.active`, and a
  /// mirror that can drift is exactly the bug collapsing `composingNew` into
  /// the slot was meant to end. Doing it here means there is no emit that can
  /// forget, and no later node can add one: the invariant holds by
  /// construction rather than by everybody remembering.
  ///
  /// `emit` is `@protected` on `BlocBase` and this is a subclass, which is
  /// what makes overriding it legitimate (checked against bloc 9.2.1's own
  /// source, not assumed). Deduplication still works: `super.emit` compares
  /// the TRANSFORMED value against the current state, so a tick that changes
  /// neither the state nor the slot still emits nothing.
  @override
  void emit(ChatWidgetState state) {
    super.emit(
      state.copyWith(
        activeSurface: _surfaces.active,
        clearActiveSurface: _surfaces.active == null,
        // The same discipline, for the same reason: a mirror that can drift
        // is the bug both of these exist to end. `super.emit` still compares
        // the transformed value, and Equatable compares this map by content,
        // so an unchanged verdict emits nothing.
        csatBySession: Map<String, CsatLookup>.unmodifiable(_csatBySession),
      ),
    );
  }

  /// The facts [ProductSurfaceSlot.sync] judges, gathered from their owners.
  ///
  /// Every one is derived where it lives and handed in — never re-derived
  /// here. `isGuest` in particular comes from [ChatWidgetState.isGuest],
  /// which forwards to the single derivation on [ChatIdentity]; asking
  /// "profile == null" again here would be the second answer that put the
  /// form on one path and not the other.
  ///
  /// **Later nodes widen this, they do not replace it.** Both of the fields
  /// this started life without have since been filled in by the node that
  /// owned the fact behind them — `csatCard` by the CSAT machine's, and
  /// `shouldCollectOffline` by the out-of-hours module's — each adding its
  /// own line here rather than a second resolver of its own.
  ///
  /// Called on TICKS, never at construction: `_syncSurfaces` runs off the
  /// stream listeners and off [applyRemoteConfig], matching the reference's
  /// own `syncProductSurfaces`, which is likewise driven by the store
  /// subscription and the config-applied path and not by init. So a config
  /// handed to the constructor raises no surface until something syncs —
  /// which is correct, because `initialConfig` is the host's pre-fetch
  /// placeholder and the real one arrives through [applyRemoteConfig].
  SurfaceSyncInputs surfaceInputs() => SurfaceSyncInputs(
        isGuest: state.isGuest,
        preChatEnabled: state.config.preChatEnabled,
        // Separate from the toggle on purpose: they are two independent
        // console controls, and gating on the toggle alone raised an empty
        // form.
        hasPreChatFields: state.config.preChatFields.isNotEmpty,
        preChatAnswered: state.preChatAnswered,
        conversationOpened: state.conversationOpened,
        hasSession: state.session != null,
        hasMessages: state.messages.isNotEmpty,
        // A DECISION, not the inputs to one — see the field's own doc. It is
        // reached through [dueCsatCard] so that this and the ended footer ask
        // one question of one answerer, which is what stops the two of them
        // both deciding they are on.
        csatCard: dueCsatCard(),
        // Until this line the out-of-hours branch could not fire at all:
        // `resolveProductSurface` has read this input since the slot landed,
        // and nothing supplied it — so a merchant on COLLECT_MESSAGE got the
        // ordinary composer outside business hours and their customers'
        // messages went into a conversation nobody was reading.
        //
        // A DECISION, like `csatCard` above, and one made by exactly one
        // function: `shouldCollectOffline` weighs `isOpenNow` against
        // `offlineMode`, and it is the same function `headerAvatarFor` already
        // asks. Passing the two raw fields here instead would be a second
        // place that could come to a different answer about whether the team
        // is open.
        shouldCollectOffline: shouldCollectOffline(state.config),
      );

  /// Re-derives what belongs in the slot and repaints.
  ///
  /// Called from every tick that changes a fact [surfaceInputs] reads —
  /// session, messages, config — and after anything that changes
  /// `conversationOpened` or `preChatAnswered`. Cheap and idempotent: the
  /// slot only reports a change when the answer actually differs, so a sync
  /// that finds nothing new rebuilds nothing.
  void _syncSurfaces() {
    _surfaces.sync(surfaceInputs());
    // Unconditional: the override above is what carries the slot into state,
    // and `super.emit`'s own equality check is what suppresses a no-op.
    emit(state);
  }

  // ── Boot ──────────────────────────────────────────────────────────────

  /// Opens the connection. Not called from the constructor: a Cubit doing
  /// network I/O as a side effect of being constructed is untestable by
  /// construction, and the root widget (which owns this Cubit's lifetime)
  /// is the natural, single place to call this once, from `initState`.
  Future<void> connect() => _client.connect();

  // ── Connectivity ──────────────────────────────────────────────────────

  /// Tells this Cubit what the DEVICE says about the network.
  ///
  /// ── Why the host supplies this rather than this package reading it ────
  ///
  /// Knowing whether a handset has a route means a platform channel —
  /// `connectivity_plus`, in practice — and both sibling apps
  /// (dh-customer-app-flutter, dh-merchant-app-flutter) already depend on it
  /// and already run a `ConnectivityCubit` over it. A library sitting between
  /// those apps and `dhaam_chat` taking the same plugin again would add a
  /// second listener to the same platform stream, a second dependency to
  /// resolve, and a second answer to a question the app has already answered.
  /// So this is a setter, and the host pipes its existing stream into it:
  ///
  /// ```dart
  /// _connectivitySub = connectivity.onConnectivityChanged.listen(
  ///   (List<ConnectivityResult> r) =>
  ///       cubit.setOnline(!r.contains(ConnectivityResult.none)),
  /// );
  /// ```
  ///
  /// Calling it is optional. Left alone the widget behaves as it did before
  /// this existed — the banner still appears on a real outage, off the failed
  /// attempt count, just a few seconds later than a host that wires this up.
  ///
  /// The transition to `true` is not merely recorded: it is the single most
  /// valuable reconnect signal there is, because it means the reason the last
  /// attempts failed is provably gone. It retries immediately rather than
  /// waiting out a backoff computed while the network was still down.
  void setOnline(bool online) {
    if (online == state.online) return;
    emit(state.copyWith(online: online));
    if (online) _client.retryNow();
  }

  /// Abandons an armed reconnect backoff and attempts now.
  ///
  /// Wired to [setOnline] and to the cadence already; this is for an explicit
  /// "Try again" control. A no-op unless the client is waiting out a backoff —
  /// in particular it will NOT revive a suspended or closed client, which §8.1
  /// makes recoverable only by [connect]. That is what [UnavailableView]'s own
  /// Try Again button is for.
  bool retryNow() => _client.retryNow();

  // ── Config ────────────────────────────────────────────────────────────

  void applyRemoteConfig(RemoteConfig config) {
    emit(state.copyWith(config: config));
    // A publish can turn the merchant's pre-chat questions on, or add the
    // first one to an empty list — both change what belongs in the slot.
    _syncSurfaces();
  }

  /// Supplies the Messages/Home screens' session list. See
  /// [ChatSessionSummary]'s header on why this Cubit cannot populate this
  /// itself — `dhaam_chat` cannot list sessions, so a host that has its own
  /// backend calls this with what it fetched there.
  void updateSessionSummaries(List<ChatSessionSummary> summaries) {
    final int unread = summaries.fold(
        0, (int sum, ChatSessionSummary s) => sum + s.unreadCount);
    emit(state.copyWith(sessionSummaries: summaries, unreadCount: unread));
  }

  // ── Navigation ────────────────────────────────────────────────────────

  /// Tab switch — Home or Messages. Not a drill-down: see [ChatScreens.swap].
  void switchTab(ScreenName tab) {
    assert(tab == ScreenName.home || tab == ScreenName.messages,
        'not a tab: $tab');
    _screens.swap(tab);
    _syncScreen();
  }

  /// The Home CTA, or the Messages screen's "New conversation" button.
  ///
  /// Takes the surface slot rather than setting a flag — see
  /// [ChatWidgetState.composingNew]. The screen it is pressed FROM is
  /// recorded with the claim, so [cancelNewConversation] can put the customer
  /// back where they were: finishing a detour on the conversation screen
  /// strands them on an empty transcript having pressed Cancel.
  ///
  /// Deliberately does NOT set [ChatWidgetState.conversationOpened]. A form
  /// opened from Home is a detour, not a conversation — and counting it would
  /// arm the pre-chat gate behind the very form that is already asking those
  /// questions.
  ///
  /// Clears any topic left selected from a PREVIOUS compose that never sent,
  /// so returning here does not silently carry a stale chip forward.
  void startNewConversation() {
    _composingTicket =
        _surfaces.open(const ComposingNewSurface(), from: _screens.current);
    _screens.go(ScreenName.conversation);
    emit(
      state.copyWith(
        screen: _screens.current,
        canGoBack: _screens.canGoBack,
        clearSelectedTopic: true,
      ),
    );
  }

  /// Backs out of the new-conversation form, returning the customer to the
  /// screen they opened it from.
  ///
  /// Home → Home, Messages → Messages. Not a plain release: that is right for
  /// a surface whose task COMPLETED, where the conversation is what the
  /// customer just started, and wrong for one they abandoned. Opened from the
  /// conversation itself, [ProductSurfaceSlot.cancel] answers
  /// [SurfaceReleased] instead and the conversation comes back — including
  /// its pre-chat gate, which the re-sync raises.
  void cancelNewConversation() {
    final SurfaceTicket? ticket = _composingTicket;
    if (ticket == null) return;
    _composingTicket = null;
    final SurfaceCancelOutcome outcome =
        _surfaces.cancel(ticket, surfaceInputs());
    if (outcome case SurfaceReturnedToOrigin(:final ScreenName origin)) {
      // Back if we can — this surface's own open pushed that origin — and
      // swap otherwise, covering a stack emptied underneath us.
      if (!_screens.back()) _screens.swap(origin);
    }
    _syncScreen();
  }

  /// Opens a past conversation from a Home/Messages row.
  ///
  /// One of the places the widget deliberately PUTS a conversation on screen,
  /// so it sets [ChatWidgetState.conversationOpened] — this is what arms the
  /// pre-chat gate in front of an empty one. `selectSession` (the session
  /// picker's own entry point, landing later) is the same funnel and must set
  /// it the same way.
  ///
  /// Discards a user-initiated surface on the way in: asking for a DIFFERENT
  /// conversation is one of the two moments that mean "I am done with this",
  /// and no state tick will ever clear one of those. Without it the new
  /// conversation is drawn UNDER a stale form.
  ///
  /// Clears [ChatWidgetState.selectedTopic] — a topic chip belongs to a
  /// prospective NEW conversation and has nothing to do with re-opening one.
  void openConversation(String sessionId) {
    _client.joinSession(sessionId);
    _surfaces.discardUserSurface();
    _composingTicket = null;
    _screens.go(ScreenName.conversation);
    emit(
      state.copyWith(
        screen: _screens.current,
        canGoBack: _screens.canGoBack,
        conversationOpened: true,
        clearSelectedTopic: true,
      ),
    );
    _syncSurfaces();
  }

  /// A Common Questions tap: straight into a conversation carrying that one
  /// question, with no pre-chat form in front of it.
  ///
  /// ── Why the questions are skipped, and why that is not a hole ──────
  ///
  /// This is a customer asking one specific thing, not filling in a form. So
  /// the gate is suppressed for the exchange — via
  /// [ProductSurfaceSlot.beginOpeningLine], because the ack lands with an
  /// empty transcript and that is precisely the window the gate would flash
  /// in — and [ChatWidgetState.preChatAnswered] is deliberately left alone:
  /// they were never asked, so the next form still asks.
  ///
  /// Sends the question's PROMPT, never its label: the label is the chip's
  /// wording and the prompt is what the customer means by pressing it.
  void startCommonQuestion(CommonQuestion question) {
    _surfaces.discardUserSurface();
    _composingTicket = null;
    final OpeningLineLatch latch = _surfaces.beginOpeningLine();
    try {
      _screens.go(ScreenName.conversation);
      emit(
        state.copyWith(
          screen: _screens.current,
          canGoBack: _screens.canGoBack,
          conversationOpened: true,
          clearSelectedTopic: true,
        ),
      );
      _syncSurfaces();
      _client.sendMessage(question.prompt);
    } finally {
      latch.release();
    }
  }

  /// Picks (or, tapped a second time, un-picks) a New Conversation topic
  /// chip — a single-select toggle, matching the `aria-pressed` chip the
  /// console-facing pieces of this feature already use.
  void selectTopic(ConversationTopic topic) {
    final bool alreadySelected = state.selectedTopic == topic;
    emit(
      alreadySelected
          ? state.copyWith(clearSelectedTopic: true)
          : state.copyWith(selectedTopic: topic),
    );
  }

  /// Answers `false` when there is nowhere to go — see [ChatScreens.back]
  /// for what a caller (typically the root widget's system-back handling)
  /// does with that.
  bool back() {
    final bool moved = _screens.back();
    if (moved) _syncScreen();
    return moved;
  }

  /// The single choke point every navigation goes through.
  ///
  /// ── Where `ChatScreens.onChange` would have been ───────────────────
  ///
  /// The reference hangs [ProductSurfaceSlot.discardUserSurface] off
  /// `screens.onChange`. [ChatScreens] deliberately has no such callback (see
  /// its header: this package's Cubit emits after every call instead), so
  /// this method IS that hook — every `go`, `swap` and `back` in this class
  /// ends here, which is what makes it one place rather than four.
  ///
  /// Leaving the conversation screen means the customer walked away from
  /// whatever surface they had opened. Non-preemption means no state tick
  /// will ever clear it for them — the slot is theirs until they hand it
  /// back — so this is where the hand-back is recognised. Without it the next
  /// conversation they open is drawn UNDER a stale form, and a second Start
  /// on that form mints a conversation nobody asked for.
  ///
  /// The AUTOMATIC surfaces are deliberately left alone: they are re-derived
  /// on the next sync, and a pre-chat gate parked behind Home is exactly what
  /// must still be there when the customer returns to that empty
  /// conversation.
  void _syncScreen() {
    if (_screens.current != ScreenName.conversation) {
      _surfaces.discardUserSurface();
      _composingTicket = null;
    }
    emit(
      state.copyWith(
        screen: _screens.current,
        canGoBack: _screens.canGoBack,
      ),
    );
  }

  // ── Outbound ──────────────────────────────────────────────────────────

  /// Addresses the next send to [target], or clears it with `null`.
  ///
  /// One method for both directions, mirroring `composer.ts`'s
  /// `setReplyTo(target | null)` — the customer pressing Reply and the
  /// customer dismissing the chip are the same fact being set to two
  /// different values, and a separate `cancelReply()` would be a second
  /// place able to write it.
  ///
  /// The target is built by the caller from the message AND the sender name
  /// the transcript resolved (see [ReplyTarget.from]); this only stores it.
  /// Nothing here re-derives anything, and nothing else in this class writes
  /// [ChatWidgetState.replyingTo] except the send that consumes it.
  void replyTo(ReplyTarget? target) {
    emit(
      state.copyWith(
        replyingTo: target,
        clearReplyingTo: target == null,
      ),
    );
  }

  /// Sends [content]. The optimistic echo arrives through [_onMessage] like
  /// any other — see `ChatClient.sendMessage` on why there is no `Future`
  /// here to await instead.
  ///
  /// Clears [ChatWidgetState.selectedTopic] alongside `composingNew`: a
  /// chosen topic's job was to accompany THIS compose, and once it has sent,
  /// carrying the selection forward would pre-select a chip for whatever the
  /// customer composes next.
  ///
  /// ── A reply's two halves, and why they cannot disagree ───────────────
  ///
  /// When [ChatWidgetState.replyingTo] is set, BOTH halves of a reply travel:
  /// `replyToMessageId` is the protocol-native field the send frame has
  /// always had, and `metadata` is the RENDERABLE half the reader draws its
  /// quote from. The second is not decoration — the quoted message may not be
  /// in the reader's loaded page at all, and an id alone would leave them a
  /// reply to something they cannot see.
  ///
  /// Both are read off the ONE [ReplyTarget], which is what makes it
  /// impossible for the id and the quote to name different messages. The
  /// explicit [replyToMessageId] parameter is the raw wire field for a host
  /// driving a reply itself, with no excerpt to quote and so no metadata; it
  /// is consulted only when the customer has no reply of their own on screen,
  /// so the two can never be combined into a mismatched pair.
  ///
  /// ── Cleared BEFORE the send, never after ─────────────────────────────
  ///
  /// A send that takes a moment must not leave the chip on screen looking as
  /// though it still applies to whatever the customer types next, and the
  /// next message must not silently be a reply too. Clearing here rather than
  /// at the call site is what makes that true of EVERY send — a typed one, a
  /// suggestion chip, a quick reply — instead of the ones somebody remembered
  /// to clear.
  void sendMessage(String content, {String? replyToMessageId}) {
    final ReplyTarget? addressedTo = state.replyingTo;
    if (addressedTo != null) {
      emit(state.copyWith(clearReplyingTo: true));
    }

    _client.sendMessage(
      content,
      replyToMessageId: addressedTo?.messageId ?? replyToMessageId,
      metadata: addressedTo?.metadata,
    );
    final SurfaceTicket? ticket = _composingTicket;
    if (ticket != null) {
      // The form's task COMPLETED, so the slot goes back through `release`
      // (which re-runs the sync) rather than `cancel`. The customer stays on
      // the conversation they just started, which is what they asked for.
      _composingTicket = null;
      _surfaces.release(ticket, surfaceInputs());
      emit(state.copyWith(clearSelectedTopic: true));
    }
  }

  /// A draft controller for one composer, or null when no host uploader was
  /// wired — in which case the composer grows no attach controls at all.
  ///
  /// ── Built here, owned by the caller ──────────────────────────────────
  ///
  /// The two seams live on this Cubit because it is the only thing the host
  /// hands to [ChatWidget]; the DRAFT does not, because a draft is one
  /// composer's pending file and dies with it. So this assembles the pieces
  /// and the caller owns the lifetime — every caller that gets a non-null
  /// answer must `dispose()` it.
  ///
  /// Not a getter and not cached: two composers would each want their own,
  /// and a shared one would let a file picked in a conversation reappear in
  /// the next.
  AttachmentDraftController? createAttachmentDraft({
    required FormErrorReporter onError,
  }) {
    final AttachmentUploader? uploader = _attachmentUploader;
    if (uploader == null) return null;
    return AttachmentDraftController(
      picker: _attachmentPicker,
      uploader: uploader,
      onError: onError,
    );
  }

  /// Voice capture for one composer.
  ///
  /// Always non-null — the seam it wraps is defaulted, and a mic that cannot
  /// record raises [VoiceErrorCode.unsupported] through the taxonomy rather
  /// than by being absent. Whether the button is DRAWN is `Composer`'s call,
  /// and it draws none without a draft controller: a note reaches the wire
  /// by becoming an attachment, so a microphone beside no uploader would
  /// record into nothing.
  ///
  /// Owned by the caller, like [createAttachmentDraft]'s answer — and
  /// disposing it is what hands the microphone back if the screen is torn
  /// down mid-recording.
  VoiceCaptureController createVoiceCapture() =>
      VoiceCaptureController(createDevice: _createVoiceDevice);

  /// Announces an already-uploaded [file] as its own message (§12.10).
  ///
  /// Called by the composer, which did the upload inside its own submit and
  /// therefore holds the only copy of the metadata `POST /upload` returned.
  ///
  /// ── Its own message, not a caption's passenger ───────────────────────
  ///
  /// A file and words typed alongside it are TWO messages, exactly as
  /// `composer.ts` sends them — `onSendAttachment(file)`, then
  /// `onSend(text)`. §12.10 is explicit that the URL travels AS the content,
  /// and `visibleContent` is this port's already-shipped other half of that
  /// contract: it suppresses the placeholder by comparing `content` against
  /// `attachment.url`. Folding the two into one send would put a caption in
  /// that field, mark an image as [MessageType.text], and produce a shape no
  /// other client in this system emits. See `attachment_message.dart`.
  ///
  /// ── No reply target is consumed here ─────────────────────────────────
  ///
  /// [sendMessage] clears [ChatWidgetState.replyingTo] because it is the
  /// send the customer composed. This one runs FIRST in the same submit, and
  /// consuming the target here would leave the words that follow — the
  /// actual reply — addressed to nobody. The file rides along with the reply
  /// rather than becoming it.
  void sendAttachment(AttachmentMetadata file) {
    _client.sendMessage(
      attachmentMessageContent(file),
      type: attachmentMessageType(file.mediaType),
      attachment: file,
    );
  }

  /// Replays the failed send [messageId], returning what actually happened.
  ///
  /// Nothing is emitted here on success and nothing needs to be: the client
  /// re-emits the message as [MessagePending] on its own stream, so
  /// [_onMessage] repaints the transcript with the failure line and the Retry
  /// button both gone. Writing a second copy of that transition into state
  /// would be a fact this Cubit maintains beside the one the client already
  /// publishes, and the two would drift the first time a retry raced an ack.
  ///
  /// The outcome is RETURNED rather than swallowed because a refusal must not
  /// read as a success. Nothing visible changes on one — the message stays
  /// failed, which is true — so the only way a caller can say anything about
  /// it is to be told. See `WidgetChatClient.retry` on why the reasons are
  /// not interchangeable, and in particular why
  /// [RetryRefusalReason.disconnected] cannot be predicted from the message
  /// the way [RetryRefusalReason.notRetryable] can.
  RetryOutcome retryMessage(String messageId) => _client.retry(messageId);

  // ── Pre-chat ──────────────────────────────────────────────────────────

  /// The STRUCTURED half of a pre-chat send — `{kind, answers}`, exactly the
  /// shape `widget.ts`'s `sendPreChatDetails` puts on the wire.
  ///
  /// It rides on the SAME frame as the prose lines rather than going as a
  /// second message, and that is the whole design: chat-service folds this
  /// into a customer-asserted contact on the session (fill-empty only,
  /// `source: 'pre_chat'`), while the agent reads the lines. One frame means
  /// the two can never describe different answers.
  ///
  /// The full [answers] map, not just the answered subset — the prose is
  /// already the human-readable filter, and the structured copy is the raw
  /// record. Built at both call sites through here so the `kind` string is
  /// written once: a typo in it is not a compile error, it is a contact that
  /// silently never gets created.
  static Map<String, Object?> _preChatMetadata(Map<String, String> answers) =>
      <String, Object?>{'kind': 'pre_chat', 'answers': answers};

  /// The customer answered the standalone gate.
  ///
  /// Relays the answers as the opening MESSAGE — they are content, not
  /// identity: a name typed into a form is a claim about this conversation,
  /// not a verified fact about a person, and nothing here upserts a contact.
  /// An empty [answers] sends nothing at all but still counts as answered,
  /// which is the "asked and declined" case.
  ///
  /// Marks [ChatWidgetState.preChatAnswered] AFTER the send, so a customer
  /// whose message failed and who answers again still carries their details.
  Future<void> submitPreChat(Map<String, String> answers) async {
    final String? details = preChatDetailsMessage(
      fields: preChatFieldsToAsk(
        config: state.config,
        isGuest: state.isGuest,
        alreadyAnswered: state.preChatAnswered,
      ),
      answers: answers,
    );
    if (details != null) {
      _client.sendMessage(details, metadata: _preChatMetadata(answers));
    }
    emit(state.copyWith(preChatAnswered: true, preChatAnswers: answers));
    _syncSurfaces();
  }

  // ── Out of hours ──────────────────────────────────────────────────────

  /// The STRUCTURED half of an offline send — `{kind, name, contact}`,
  /// exactly the shape `widget.ts`'s own offline `onSubmit` puts on the wire.
  ///
  /// Rides on the SAME frame as the prose, for the reason
  /// [_preChatMetadata] gives: one frame means the two halves can never
  /// describe different people. Written once here so the `kind` string is not
  /// retyped — a typo in it is not a compile error, it is a message that
  /// silently never gets classified.
  static Map<String, Object?> _offlineMetadata(OfflineMessage message) =>
      <String, Object?>{
        'kind': 'offline_message',
        'name': message.name,
        'contact': message.contact,
      };

  /// The customer left a message while the team was closed.
  ///
  /// ── Named in the body, not just in the metadata ─────────────────────
  ///
  /// The prose carries the name and contact too, because this message is read
  /// by a human tomorrow morning in a thread with no live participant — the
  /// structured copy is what chat-service classifies on, and the body is what
  /// the agent actually sees. Character-for-character the reference's own
  /// sentence, so a merchant whose customers meet this SDK on the web and in
  /// an app receives one shape of message rather than two.
  ///
  /// ── Returns a Future that cannot reject, and that is not a mistake ──
  ///
  /// `sendMessage` returns the optimistic local echo synchronously and queues
  /// the frame (§8.4), so there is nothing here to fail. The signature stays
  /// a `Future` because [OfflineFormView] is built on
  /// [FormSubmitController.submitOnce] like every other form in this package,
  /// and because the seam is what lets a host — or a later REST-backed
  /// send — supply one that CAN fail and get the re-enable and the failure
  /// sentence for free.
  Future<void> submitOfflineMessage(OfflineMessage message) async {
    _client.sendMessage(
      'Offline message from ${message.name} (${message.contact}):'
      '\n\n${message.message}',
      metadata: _offlineMetadata(message),
    );
  }

  /// The customer declined the standalone gate.
  ///
  /// Counts as answered — the gate does not come back. Offered only when the
  /// merchant made nothing required; see [PreChatGate].
  void skipPreChat() {
    emit(state.copyWith(preChatAnswered: true));
    _syncSurfaces();
  }

  /// Starts a conversation from the new-conversation form.
  ///
  /// [topic] is the chip's LABEL, never its id — the id is a console key and
  /// the label is what a human reads. [answers] is null when no fields were
  /// shown and a (possibly empty) map when they were; only the second counts
  /// as having been asked, which is why [ChatWidgetState.preChatAnswered] is
  /// set on exactly that condition.
  ///
  /// The details go out ahead of the opening line so an agent reads them
  /// first, and the latch holds the pre-chat gate down across the whole
  /// exchange: the first send lands with an empty transcript, which is
  /// precisely the window the gate would otherwise flash in.
  void startConversationFrom({
    required String message,
    String? topic,
    Map<String, String>? answers,
  }) {
    final OpeningLineLatch latch = _surfaces.beginOpeningLine();
    try {
      if (answers != null) {
        final String? details = preChatDetailsMessage(
          fields: preChatFieldsToAsk(
            config: state.config,
            isGuest: state.isGuest,
            alreadyAnswered: state.preChatAnswered,
          ),
          answers: answers,
        );
        if (details != null) {
          _client.sendMessage(details, metadata: _preChatMetadata(answers));
        }
      }
      _client.sendMessage(message);
      emit(
        state.copyWith(
          // Absent stays absent: a customer who was never asked must still be
          // asked by the next form.
          preChatAnswered: answers != null ? true : null,
          preChatAnswers: answers,
          startedTopicLabel: topic,
        ),
      );
      final SurfaceTicket? ticket = _composingTicket;
      if (ticket != null) {
        _composingTicket = null;
        _surfaces.release(ticket, surfaceInputs());
      }
      emit(state.copyWith(clearSelectedTopic: true));
    } finally {
      latch.release();
    }
  }

  void markRead({String? upToMessageId}) =>
      _client.markRead(upToMessageId: upToMessageId);

  /// Tells the other participants the customer is typing (§6.3).
  ///
  /// Wire this to `Composer.onTyping`. Without it the agent's typing
  /// indicator never lights at all — for typed characters as much as for an
  /// emoji insertion, which is why the composer fires all three effects per
  /// insertion rather than two.
  ///
  /// ── Why the try/catch, when `send` is documented not to throw ────────
  ///
  /// `ConnectionController.send` drops silently when the socket is not
  /// connected, so the ordinary offline case is already safe. The guard is
  /// for the race the state check cannot close — a socket that goes away
  /// between the `connected` read and the write — and it is here for the
  /// reason the reference gives at its own call site: a typing INTENT that
  /// fails must never block the keystroke that triggered it. This runs on
  /// every character; an exception escaping into `onChanged` would take the
  /// composer down with it.
  ///
  /// There is no `stopTyping` counterpart. See [WidgetChatClient.startTyping].
  void startTyping() {
    try {
      _client.startTyping();
    } catch (error, stackTrace) {
      FlutterError.reportError(
        FlutterErrorDetails(exception: error, stack: stackTrace),
      );
    }
  }

  // ── End of conversation: the rating card, the footer, the confirm ─────

  /// The on-screen session that has genuinely ENDED, or null.
  ///
  /// ── ONE definition for the three readers that need it ───────────────
  ///
  /// The rating card, the ended footer, and [dueCsatCard] between them. The
  /// reference wrote this out twice and kept the two "in lockstep" by comment
  /// alone, which is a promise a codebase cannot keep — and the two halves
  /// disagreeing is exactly how a survey and a footer both appear, or neither
  /// does.
  ///
  /// `sessionId == _parkedSessionId` is the non-obvious half: a session this
  /// client watched get SWITCHED-closed reads CLOSED by status but was PARKED
  /// rather than ended. See [_parkedSessionId].
  String? get endedSessionId {
    final SessionSnapshot? session = state.session;
    if (session == null) return null;
    if (session.status != ChatStatus.closed &&
        session.status != ChatStatus.resolved) {
      return null;
    }
    return session.sessionId == _parkedSessionId ? null : session.sessionId;
  }

  /// The rating card this conversation is owed, or null for none.
  ///
  /// Read by [surfaceInputs] (which raises it) and by [endedFooterDue] (which
  /// needs to know the footer is outranked), so the two can never answer the
  /// question differently.
  ///
  /// An empty transcript has nothing to rate — the same precedence note the
  /// pre-chat gate states from the other side. The rest of the answer is
  /// `CsatMachine`'s: `unrated` and `unsupported` ASK, `rated` shows the
  /// rating locked, and `loading`/`unknown` show nothing at all, for opposite
  /// reasons. None of that is re-derived here.
  CsatSurface? dueCsatCard() {
    final CsatMachine? machine = _csat;
    final String? sessionId = endedSessionId;
    if (machine == null || sessionId == null || state.messages.isEmpty) {
      return null;
    }
    // Asks the server AT MOST ONCE per session: the first call starts the
    // request and answers `loading`, every later one is answered from the
    // cache. So repainting fifty times costs one lookup.
    final CsatLookup lookup = machine.lookupFor(sessionId);
    _csatBySession[sessionId] = lookup;
    final CsatCard? card = machine.cardFor(sessionId);
    if (card == null) return null;
    return CsatSurface(sessionId: sessionId, alreadyRated: !card.isAsk);
  }

  /// Whether the ended-conversation footer should stand in for the composer.
  ///
  /// A terminal, unparked session with nothing already standing in for the
  /// conversation. The reference spells this `showingLog && ended && !csatDue`
  /// — and `!csatDue` is subsumed here, because a rating that is due IS the
  /// slot's occupant, and a user-initiated surface that outranks it occupies
  /// the slot too. One condition, one answer, no third place for the footer
  /// and the card to disagree.
  bool get endedFooterDue =>
      endedSessionId != null && state.activeSurface == null;

  /// Records the customer's rating for [sessionId].
  ///
  /// ── Re-asked immediately before writing ─────────────────────────────
  ///
  /// The cached `unrated` that put this card on screen may be minutes old and
  /// nothing on the wire invalidates it — there is no CSAT frame and no
  /// event. A second tab, or the same customer's phone, can rate the
  /// conversation while the card sits there, and `POST …/csat` is an UPSERT:
  /// submitting then does not fail, it replaces the score they already gave.
  /// One request on the button press narrows that window from "however long
  /// this card has been open" to the width of one round trip.
  ///
  /// A re-check that FAILS lets the submit through — the opposite of the
  /// unknown-lookup rule, and deliberately: a definite `unrated` is already on
  /// file (it is WHY this card is an ask) and the customer has just chosen a
  /// score. See `CsatMachine.confirmedUnrated`.
  ///
  /// Rethrows, so the card's own `submitOnce` shows the failure line and
  /// hands the raw error to the host.
  Future<void> rateSession(
    String sessionId, {
    required int rating,
    String? comment,
  }) async {
    final CsatMachine? machine = _csat;
    final ChatSessionActions? actions = _sessionActions;
    if (machine == null || actions == null) return;

    // Somebody rated it already. Nothing is written, and the machine's own
    // `changes` event repaints this card as the locked read-out of the rating
    // that actually stands — the honest end state for a press that
    // deliberately wrote nothing.
    if (!await machine.confirmedUnrated(sessionId)) return;

    await actions.submitCsat(sessionId, rating: rating, comment: comment);
    // AFTER the write lands, never before: this is the memory every later
    // repaint reads, and writing it optimistically would lock a card over a
    // rating the server refused.
    machine.recordSubmitted(sessionId, rating: rating, comment: comment);
  }

  /// Raises the "End this conversation?" question over the transcript.
  ///
  /// Keyed by the session it is asking ABOUT: the menu stays reachable while
  /// this is up, so a customer whose session changed underneath the question
  /// can ask again meaning the NEW one. Without the key, by-kind idempotence
  /// would answer the second ask with the question built for the old session
  /// and the destructive button would close nothing at all.
  ///
  /// A no-op with no session, and with no [ChatSessionActions] to close it
  /// with — a question whose only answer cannot be carried out is worse than
  /// no question.
  void openEndConversation() {
    final String? sessionId = state.session?.sessionId;
    if (sessionId == null || _sessionActions == null) return;
    _confirmEndTicket = _surfaces.open(
      ConfirmEndSurface(sessionId: sessionId),
      from: _screens.current,
    );
    _screens.go(ScreenName.conversation);
    emit(
      state.copyWith(
        screen: _screens.current,
        canGoBack: _screens.canGoBack,
      ),
    );
  }

  /// The customer confirmed. Closes [sessionId] and hands the slot back.
  ///
  /// The terminal status arrives on the SOCKET (`session.closed` /
  /// `session.updated`), not from here — see [ChatSessionActions.closeSession]
  /// on why this applies nothing itself. Releasing re-runs the sync, so the
  /// rating card that became due behind this question is raised straight
  /// away rather than waiting for an unrelated tick.
  ///
  /// Rethrows so the confirm's own `submitOnce` shows the failure line, keeps
  /// the question up, and re-enables both buttons.
  Future<void> confirmEndConversation(String sessionId) async {
    final ChatSessionActions? actions = _sessionActions;
    if (actions == null) return;
    await actions.closeSession(sessionId);
    final SurfaceTicket? ticket = _confirmEndTicket;
    if (ticket != null) {
      _confirmEndTicket = null;
      _surfaces.release(ticket, surfaceInputs());
    }
    _syncSurfaces();
  }

  /// The customer changed their mind.
  void cancelEndConversation() {
    final SurfaceTicket? ticket = _confirmEndTicket;
    if (ticket == null) return;
    _confirmEndTicket = null;
    final SurfaceCancelOutcome outcome =
        _surfaces.cancel(ticket, surfaceInputs());
    if (outcome case SurfaceReturnedToOrigin(:final ScreenName origin)) {
      if (!_screens.back()) _screens.swap(origin);
    }
    _syncScreen();
  }

  /// Whether an issue report can actually be filed.
  ///
  /// False when the host wired up no [IssueReporter]. The ⋯ menu drops the
  /// row on this rather than offering one that quietly does nothing — the
  /// same shape [canReopen] and [canEndConversation] have, and the rule
  /// `header_menu.dart` states for itself: an unbacked item is absent from
  /// `headerMenuEntries` entirely.
  bool get canReportIssue => _issueReporter != null;

  /// Raises the "Report an issue" form in place of the conversation.
  ///
  /// ── Unkeyed, unlike [ConfirmEndSurface] ──────────────────────────────
  ///
  /// The end-conversation question is ABOUT one session and carries its id,
  /// because asking again after a switch must mean the NEW one. This form is
  /// not about a session at all: it files against whichever conversation is
  /// current at the moment Send is pressed — the reference reads
  /// `store.getState().session?.id ?? closedSessionId` right there in
  /// `fileIssueReport` (widget.ts:3707), and [restIssueReporter]'s
  /// [SessionIdSource] is the port of exactly that late read. So there is no
  /// id for this value to carry, and by-kind idempotence is the whole of what
  /// identity means here: pressing the row twice must not rebuild the form
  /// over what the customer has already typed into it.
  ///
  /// ── Deliberately NOT guarded on there being a session ────────────────
  ///
  /// The reference offers this from Home, with no conversation open, and
  /// raises 'No conversation to report against' from the SUBMIT — which
  /// `FormSubmitController` renders as the form's own failure line while
  /// keeping every word the customer typed. Refusing to OPEN would convert
  /// that recoverable, explained failure into a menu row that appears to do
  /// nothing at all.
  void openReportIssue() {
    if (_issueReporter == null) return;
    _reportTicket = _surfaces.open(
      const ReportSurface(),
      from: _screens.current,
    );
    _screens.go(ScreenName.conversation);
    emit(
      state.copyWith(
        screen: _screens.current,
        canGoBack: _screens.canGoBack,
      ),
    );
  }

  /// Files the report.
  ///
  /// Rethrows, so the form's own `submitOnce` shows its failure line, keeps
  /// what the customer typed and re-enables the button — the contract
  /// [IssueReporter] is declared around.
  ///
  /// Hands the slot back to NOBODY on success, deliberately. A filed report
  /// is answered by the form's own confirmation, which replaces it inside
  /// this same surface and carries the Done that releases it — see
  /// [cancelReportIssue]. Releasing here would tear the confirmation down
  /// before it was read.
  ///
  /// Throws rather than returning quietly when no [IssueReporter] is wired,
  /// which is the one place this diverges from [confirmEndConversation]'s
  /// silent return — and it diverges because the consequence does. A silent
  /// success here would advance the form to "Report sent" for a report that
  /// was never sent, which is the exact failure `transcript_email.dart` names
  /// when it explains why [IssueReporter] rejects instead of reporting.
  /// Unreachable in practice: the surface cannot be opened without one.
  Future<void> fileIssueReport(RestIssueReport report) async {
    final IssueReporter? reporter = _issueReporter;
    if (reporter == null) {
      throw StateError('No issue reporter is wired up');
    }
    await reporter(report);
  }

  /// The customer backed out of the form, or pressed Done on the confirmation
  /// that replaced it.
  ///
  /// One method for both, because the job is the same one — hand the slot
  /// back and return to the screen this was opened from — which is why
  /// [ReportIssueForm] has a single `onCancel` rather than two callbacks.
  ///
  /// Opened from Home or Messages, [ProductSurfaceSlot.cancel] answers
  /// [SurfaceReturnedToOrigin] and the customer lands back there rather than
  /// on a conversation screen they never navigated to. Opened mid-chat it
  /// answers [SurfaceReleased] and the conversation comes back, along with
  /// anything the re-sync finds has fallen due behind it.
  void cancelReportIssue() {
    final SurfaceTicket? ticket = _reportTicket;
    if (ticket == null) return;
    _reportTicket = null;
    final SurfaceCancelOutcome outcome =
        _surfaces.cancel(ticket, surfaceInputs());
    if (outcome case SurfaceReturnedToOrigin(:final ScreenName origin)) {
      if (!_screens.back()) _screens.swap(origin);
    }
    _syncScreen();
  }

  /// Whether a reopen can actually be carried out.
  ///
  /// False when the host wired up no [ChatSessionActions]. The ended footer
  /// hides its Reopen button on this rather than offering one that quietly
  /// does nothing — see [EndedFooter.onReopen].
  bool get canReopen => _sessionActions != null;

  /// Reopens the ended conversation — the footer's primary action.
  ///
  /// Calls the real `POST …/reopen`, never a client-side re-enable, and then
  /// FOLLOWS THE ID IT ANSWERS WITH. Reopen may converge onto a different,
  /// already-active session (another tab got there first); joining the
  /// requested id instead would put the customer back in a session the server
  /// did not reopen. A converged id is an ordinary outcome, not an error.
  ///
  /// The join is what refreshes the on-screen session: this package does not
  /// write `state.session` from a REST result — see
  /// [ChatSessionActions.closeSession].
  ///
  /// Rethrows so the footer shows its own failure line.
  Future<void> reopenEndedSession() async {
    final ChatSessionActions? actions = _sessionActions;
    final String? sessionId = endedSessionId;
    if (actions == null || sessionId == null) return;
    final String settled = await actions.reopenSession(sessionId);
    _client.joinSession(settled);
  }

  /// The session picker's entry point — "take me back to that conversation".
  ///
  /// ── A forwarder, deliberately, and not a second implementation ──────
  ///
  /// [openConversation]'s own doc already promised this: the picker is the
  /// same funnel as a Home or Messages row and must set
  /// [ChatWidgetState.conversationOpened] the same way. The reference makes
  /// the same call — `widget.ts` wires BOTH `onOpenConversation` sites
  /// (`:1767` and `:1789`) into one `selectSession`, which is the only
  /// implementation there is.
  ///
  /// So this exists to give the picker the name the reference uses, not to
  /// give it behaviour of its own. It must stay a one-line delegation, for
  /// the reason [ChatWidgetState.isGuest] states about its own: the moment
  /// it grows a condition there are two answers to "what happens when a
  /// customer picks a conversation", and the two surfaces that ask start
  /// diverging.
  ///
  /// ── No busy guard, and nothing to await ─────────────────────────────
  ///
  /// The reference documents why it takes no busy guard: a customer clicking
  /// two rows quickly should land on the second, and guarding would ignore
  /// their second click. Here there is not even a promise to guard — Dart's
  /// `joinSession` writes a frame and returns, so there is no rejection to
  /// leak onto a host's error tracker either.
  void selectSession(String sessionId) => openConversation(sessionId);

  /// Silences or restores the local chime for this visitor.
  ///
  /// Takes the NEW state rather than flipping the old one, matching
  /// `HeaderMenu.onMuteChange`, which already knows what it is asking for.
  /// A toggle that computed the flip HERE as well would be a second copy of
  /// the same fact, and the two can disagree the moment a menu is rebuilt
  /// from a state that changed underneath it.
  ///
  /// Nothing is persisted — see [ChatWidgetState.muted] for where that
  /// belongs and why it is not here.
  void setMuted(bool muted) {
    if (state.muted == muted) return;
    emit(state.copyWith(muted: muted));
  }

  /// Whether there is a live conversation for the header menu to offer to end.
  ///
  /// The precondition for `HeaderMenu`'s one destructive row. Three facts,
  /// and each removes a way the row could be a lie:
  ///
  ///  * a session exists at all — [openEndConversation] no-ops without one,
  ///    and a row that does nothing is the thing that module's header
  ///    forbids;
  ///  * [ChatSessionActions] is wired — with no REST slice there is nothing
  ///    to close it WITH, and the same no-op applies;
  ///  * the session is not already terminal — "End conversation" on a
  ///    conversation the server has already closed would close nothing and
  ///    look broken.
  ///
  /// Read off `status` directly rather than through [endedSessionId], which
  /// answers a deliberately different question: it returns null for a PARKED
  /// session so the ended-footer stays down, and a parked session is closed
  /// server-side and equally cannot be ended again. Reusing it here would
  /// offer the row for exactly that case.
  bool get canEndConversation {
    final SessionSnapshot? session = state.session;
    if (session == null || _sessionActions == null) return false;
    return session.status != ChatStatus.closed &&
        session.status != ChatStatus.resolved;
  }

  // ── Consent ───────────────────────────────────────────────────────────

  /// Applies the one stored-consent read to the gate.
  ///
  /// Only ever opens the gate, never closes it: a read that lands after the
  /// visitor has already pressed "I agree" must not take the agreement back,
  /// and `false` is what the state already says. [ConsentGate.readAgreed]
  /// resolves `false` rather than rejecting when the store cannot be reached,
  /// which is the same as a first visit.
  Future<void> _restoreConsent() async {
    if (await _consent.readAgreed()) {
      emit(state.copyWith(consentAgreed: true));
    }
  }

  /// The visitor agreed to the merchant's notice.
  ///
  /// ── Honoured first, recorded second ─────────────────────────────────
  ///
  /// The gate opens on this frame and the write follows. A failed write does
  /// NOT revoke the click: refusing to let somebody chat because their device
  /// blocks app data would punish them for a setting they are entitled to,
  /// and the cost of the failure is only that they are asked again next
  /// visit. [ConsentGate.recordAgreed] therefore never rejects — it reports
  /// and returns.
  void agreeToConsent() {
    if (state.consentAgreed) return;
    emit(state.copyWith(consentAgreed: true));
    unawaited(_consent.recordAgreed());
  }

  // ── Inbound ───────────────────────────────────────────────────────────

  void _onConnectionState(ConnectionState connectionState) {
    emit(
      state.copyWith(
        connectionState: connectionState,
        // A completed handshake is the only proof the run of failures is over.
        // Without this reset the banner stays up forever after one bad minute.
        failedAttempts: connectionState == ConnectionState.connected ? 0 : null,
        // The drain happens on this same edge, so the count is read after the
        // client has had it — see ChatClient._onConnectionState.
        queuedCount: _client.queuedCount,
      ),
    );
    _syncReconnectCadence(connectionState);
  }

  void _onReconnecting(ReconnectingEvent event) =>
      emit(state.copyWith(failedAttempts: state.failedAttempts + 1));

  /// Arms the cadence while — and only while — a backoff is counting down.
  ///
  /// ── Why this cannot become a second retry loop ────────────────────────
  ///
  /// A UI layer retrying on its own timer while the client retries on its is
  /// the classic way to hammer a server that is already struggling. This
  /// cannot become that, for a reason in `dhaam_chat` rather than a rule here:
  /// `retryNow()` acts ONLY in [ConnectionState.reconnecting] — a state that
  /// by definition means no socket is open and a timer is counting down —
  /// and returns false everywhere else, including the `connecting` of an
  /// attempt already in flight. So it can never supersede a live attempt, open
  /// a second socket, or shorten anything below the client's own first delay.
  ///
  /// One-shot and re-armed rather than [Scheduler.periodic], because leaving
  /// `connecting` cancels it and re-entering `reconnecting` starts a fresh
  /// three seconds — which is the behaviour wanted, and a periodic timer would
  /// instead fire on whatever phase it happened to be in.
  void _syncReconnectCadence(ConnectionState connectionState) {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    if (connectionState != ConnectionState.reconnecting) return;

    _reconnectTimer = _scheduler.schedule(_reconnectInterval, () {
      _reconnectTimer = null;
      // Re-checked rather than trusted: a tick that fires in the same turn as
      // a transition must not act on the state it was armed for.
      if (_client.connectionState != ConnectionState.reconnecting) return;
      if (_client.retryNow()) return;
      // It refused — the state moved under us between the check and the call.
      // Re-arm rather than going quiet, so a client that lands back in
      // `reconnecting` without a transition event is still capped.
      _syncReconnectCadence(_client.connectionState);
    });
  }

  void _onMessage(ChatMessage message) {
    _byId[message.id] = message;
    emit(
      state.copyWith(
        messages: _byId.values.toList(growable: false),
        // Read on every message rather than tracked separately: a send joins
        // the queue and leaves it without any connection transition, and the
        // client is the one place that knows the real number.
        queuedCount: _client.queuedCount,
      ),
    );
    // A transcript that just stopped being empty closes the pre-chat gate's
    // own precondition — see `SurfaceSyncInputs.hasMessages`.
    _syncSurfaces();
  }

  void _onSession(SessionSnapshot session) {
    // Only a DIFFERENT, real session clears the park. A later snapshot for
    // the parked session itself — the server moving it CLOSED, then
    // RESOLVED — says the same thing again and must not be read as a
    // recovery, or the survey and the footer both arrive for a conversation
    // nobody ended.
    if (session.sessionId != _parkedSessionId) _parkedSessionId = null;
    emit(state.copyWith(session: session));
    _syncSurfaces();
  }

  /// A `session.closed` push (§12.5).
  ///
  /// The one frame that distinguishes a session that ENDED from one that was
  /// PARKED. Both reach [_onSession] as `ChatStatus.closed`; only the reason
  /// rides here, and only on this frame.
  void _onSessionClosed(SessionClosed event) {
    if (event.closeReason != CloseReason.switched) return;
    _parkedSessionId = event.sessionId;
    _syncSurfaces();
  }

  /// One session's CSAT verdict has landed or changed.
  void _onCsatVerdict(String sessionId) {
    final CsatMachine? machine = _csat;
    if (machine == null) return;
    // Read back rather than carried on the event: `lookupFor` is answered
    // from the machine's cache once the first call has started the request,
    // so this costs nothing and keeps the machine the single memory.
    _csatBySession[sessionId] = machine.lookupFor(sessionId);
    _syncSurfaces();
  }

  /// A §6.5 protocol error reached the client.
  ///
  /// Recorded on the state rather than only reported, because the two answer
  /// different questions: `onError` tells the HOST something went wrong, and
  /// this lets the WIDGET say so. Without it a misconfigured endpoint renders
  /// as an endless "Connecting…" with the reason available nowhere — which is
  /// exactly how this landed as a bug report.
  ///
  /// [WidgetChatClient.suspendReason] is read on the same tick because an
  /// error and the decision to give up arrive separately: the cap is reached
  /// by the LAST of several failures, and only then does the client stop.
  void _onProtocolError(ErrorPayload error) => emit(
        state.copyWith(
          lastError: error,
          suspendReason: _client.suspendReason,
        ),
      );

  /// A typing event landed. The indicator follows WHO is typing, not the
  /// flag on the event that happened to arrive last.
  ///
  /// Reading `event.isTyping` here looks right and is not: each event speaks
  /// for one participant. Agent A starts, agent B starts, A stops — and the
  /// last event says `false` while B is still mid-sentence. That is exactly
  /// the bug `TypingController`'s per-participant map exists to prevent, and
  /// collapsing the stream by hand reintroduces it one layer above the fix.
  ///
  /// So the answer comes from the client's own fold, which is also what makes
  /// the 5s auto-clear work end to end: a manufactured stop removes one
  /// participant from that map and the indicator stays up for the others.
  void _onTyping(TypingEvent event) =>
      emit(state.copyWith(isTyping: _client.typingParticipants.isNotEmpty));

  @override
  Future<void> close() async {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _csatSub?.cancel();
    await _csat?.dispose();
    await _sessionClosedSub.cancel();
    await _reconnectingSub.cancel();
    await _connectionSub.cancel();
    await _messagesSub.cancel();
    await _sessionsSub.cancel();
    await _typingSub.cancel();
    await _errorsSub.cancel();
    return super.close();
  }
}
