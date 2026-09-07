/// Everything a screen needs to render, in one immutable snapshot —
/// [ChatWidgetCubit]'s state.
library;

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:equatable/equatable.dart';

import '../config/remote_config.dart';
import '../nav/chat_screens.dart';
import '../session/chat_session_summary.dart';
import '../surfaces/product_surface_slot.dart';
import '../ui/composer_affordances/reply_target.dart';
import '../ui/pre_chat/chat_identity.dart';

class ChatWidgetState extends Equatable {
  const ChatWidgetState({
    required this.connectionState,
    required this.config,
    required this.screen,
    required this.canGoBack,
    required this.session,
    required this.messages,
    required this.isTyping,
    required this.sessionSummaries,
    required this.unreadCount,
    required this.online,
    required this.failedAttempts,
    required this.queuedCount,
    this.selectedTopic,
    // ── Appended, never interleaved ────────────────────────────────────
    //
    // New fields go on the END of this list and default to their
    // "nothing has happened yet" reading, so a later node adding one more
    // does not reorder anybody else's arguments and a half-built state
    // cannot put a form in front of anybody. Same discipline
    // `SurfaceSyncInputs` states for its own defaults.
    this.identity = ChatIdentity.guest,
    this.activeSurface,
    this.conversationOpened = false,
    this.preChatAnswered = false,
    this.preChatAnswers,
    this.startedTopicLabel,
    this.localParticipantId,
    this.csatBySession = const <String, CsatLookup>{},
    this.muted = false,
    this.replyingTo,
    this.consentAgreed = false,
    this.lastError,
    this.suspendReason,
  });

  /// Starting point for a fresh [ChatWidgetCubit] — disconnected, the
  /// widget's own defaults, on Home, nothing loaded yet. Never renders a
  /// blank screen while waiting: every field already has a safe value.
  factory ChatWidgetState.initial({
    RemoteConfig config = defaultRemoteConfig,
    ScreenName screen = ScreenName.home,
    ChatIdentity identity = ChatIdentity.guest,
    bool conversationOpened = false,
  }) =>
      ChatWidgetState(
        connectionState: ConnectionState.idle,
        config: config,
        screen: screen,
        identity: identity,
        // The port of `widget.ts:524` — the identity's own user id, not a
        // guess read off the ack's participant rows. See the field's doc.
        localParticipantId: identity.userId,
        // A host that mounted this straight into a conversation put one in
        // front of the customer — see [conversationOpened].
        conversationOpened: conversationOpened,
        canGoBack: false,
        session: null,
        messages: const <ChatMessage>[],
        isTyping: false,
        sessionSummaries: const <ChatSessionSummary>[],
        unreadCount: 0,
        // Optimistic, and the only safe default: a widget that has not been
        // told otherwise must not paint an offline notice on its first frame.
        online: true,
        failedAttempts: 0,
        queuedCount: 0,
      );

  final ConnectionState connectionState;
  final RemoteConfig config;
  final ScreenName screen;
  final bool canGoBack;

  /// Whether [ScreenName.conversation] should render the New Conversation
  /// composer (topic chips + textarea + Start) rather than a transcript.
  ///
  /// ── A GETTER over the slot, not a field ─────────────────────────────
  ///
  /// This used to be stored, set by [ChatWidgetCubit.startNewConversation]
  /// and cleared in three other places. `activeSurface is
  /// ComposingNewSurface` now says exactly the same thing, and two
  /// derivations of one fact is precisely the bug the surface slot exists to
  /// prevent — the same shape as the `isGuest` duplication that put the
  /// pre-chat form on one path and not the other.
  ///
  /// Keeping it as a getter rather than deleting it is deliberate: it is the
  /// name every screen already asks this question by, and the question is
  /// still a real one. What is gone is the second place the answer could be
  /// wrong. A parallel field alongside the slot would have re-created the
  /// bug under a new name.
  ///
  /// ── Why "new conversation" is not a fourth [ScreenName] ─────────────
  ///
  /// `screens.ts`'s `ScreenName` union has exactly three members — home,
  /// messages, conversation — and this package matches it rather than
  /// inventing a fourth. "New conversation" is a MODE of the conversation
  /// screen, not a separate place in the back stack: the CTA on Home and a
  /// row on Messages both land on `ScreenName.conversation`, differing only
  /// in whether they name a session to join.
  bool get composingNew => activeSurface is ComposingNewSurface;

  /// Who the host says this visitor is. See [ChatIdentity].
  final ChatIdentity identity;

  /// Whether nobody has vouched for this visitor.
  ///
  /// A FORWARDER to [ChatIdentity.isGuest], not a second derivation: the
  /// discriminator itself is stated exactly once, on that getter. This exists
  /// so the Cubit and the screens can ask without reaching through to the
  /// identity object, and it must stay a one-line delegation — the moment it
  /// grows a condition of its own there are two answers again.
  bool get isGuest => identity.isGuest;

  /// The surface standing IN PLACE OF the conversation, or null for none.
  ///
  /// A mirror of `ProductSurfaceSlot.active`, and only ever that:
  /// [ChatWidgetCubit] overrides `emit` to stamp the live slot onto every
  /// state it emits, so there is no path by which this and the slot can
  /// disagree. Nothing outside that override may set it.
  final ProductSurface? activeSurface;

  /// Whether the customer has actually OPENED a conversation — as opposed to
  /// merely having one on the server.
  ///
  /// chat-service mints or resumes a session on `connection.hello`, so a
  /// brand-new visitor has a live, zero-message session as soon as the socket
  /// acks: at mount, before the panel has ever been opened. "A session
  /// exists" is therefore NOT the same question, and the pre-chat gate needs
  /// this one. Asked the other, the gate went up at MOUNT and took the panel
  /// straight to the conversation screen, leaving Home reachable only by
  /// pressing Back off a form nobody had asked for.
  ///
  /// Set where the widget deliberately PUTS a conversation on screen — see
  /// [ChatWidgetCubit.openConversation] and
  /// [ChatWidgetCubit.startCommonQuestion], plus construction for a host that
  /// named a session. A SURFACE taking the slot deliberately does not count
  /// even though opening one navigates: a new-conversation form opened from
  /// Home is a detour, and the customer is not looking at a conversation yet.
  ///
  /// Never reset to false. It records that something happened, and it stays
  /// having happened.
  final bool conversationOpened;

  /// Whether the customer has answered or skipped the pre-chat questions, for
  /// this widget's lifetime.
  ///
  /// Not persisted: a reload asks again, matching the reference. Set by the
  /// gate's submit and its Skip, and by a new-conversation start that
  /// actually SHOWED fields. Deliberately NOT set by a Common Question tap —
  /// that is a customer asking one specific thing, not filling in a form, so
  /// the questions are still owed.
  final bool preChatAnswered;

  /// The pre-chat answers from the conversation the customer most recently
  /// started, or null when they were never asked.
  ///
  /// ── null and {} are different answers ───────────────────────────────
  ///
  /// null says the customer was never asked — no fields showed, because the
  /// merchant configured none, or the toggle is off, or this visitor is not a
  /// guest. An empty map says they WERE asked and left every optional
  /// question blank. Those reach an agent as different facts, and collapsing
  /// them blames the customer for the merchant's configuration. See
  /// `preChatAnswersFor`, which is where the distinction is produced.
  final Map<String, String>? preChatAnswers;

  /// The topic chip carried by the conversation the customer most recently
  /// started, as its LABEL — or null when they picked none.
  ///
  /// ── The label, never the id ─────────────────────────────────────────
  ///
  /// The id is a console key that means nothing outside the merchant's own
  /// configuration; the label is what the customer saw themselves press, and
  /// what an agent reads. Resolved once, at the form, from the chip that was
  /// actually selected — so there is no second lookup that could resolve a
  /// stale id against a republished topic list.
  ///
  /// Distinct from [selectedTopic], which is the LIVE selection on a form the
  /// customer is still filling in and is cleared the moment they start: this
  /// records what the start actually carried.
  ///
  /// Held here rather than sent, because the wire hop for it is
  /// `startNewSession({topic, subject})` and [WidgetChatClient] does not
  /// expose that yet. The value is resolved correctly and waiting; the node
  /// that widens that interface passes this straight through.
  final String? startedTopicLabel;

  /// Which participant WE are, for deciding whose messages are our own.
  ///
  /// ── Where this comes from, and where it cannot ──────────────────────
  ///
  /// From the host-supplied identity — the port of `widget.ts:524`:
  ///
  /// ```ts
  /// const localParticipantId = config.identity.userId;
  /// ```
  ///
  /// NOT from the connection handshake, and that is not a shortcut.
  /// `ConnectionAck` carries a [SessionSnapshot] whose `participants` are
  /// [ParticipantSnapshot]s, and a participant row has `participantId`,
  /// `type`, `lastReadAt` and `displayName` — no "this one is you" marker.
  /// The ack tells you who is IN the session; it cannot tell you which of
  /// them you are. Picking the sole `CUSTOMER` row would be a guess, and
  /// wrong in exactly the case that matters: an agent-side embed, where the
  /// customer row is somebody else.
  ///
  /// Null when the host named nobody. A consumer must treat that as "not
  /// known" and render no ownership-dependent affordance, rather than
  /// falling back to `senderType == customer` — the same refusal the
  /// reference's own tick derivation makes, and for the same reason.
  final String? localParticipantId;

  /// What the server has said about each session's rating, keyed by session
  /// id.
  ///
  /// ── A mirror of `CsatMachine`, never a second memory ────────────────
  ///
  /// Exactly the shape [ChatWidgetState.activeSurface] has: [ChatWidgetCubit]
  /// overrides `emit` to stamp the live machine's verdicts onto every state it
  /// emits, so there is no path by which this and the machine can disagree,
  /// and nothing outside that override may set it. It exists because a
  /// verdict landing is a state change like any other — whatever a widget
  /// decided while the lookup was [CsatLoading] has to be decided again — and
  /// a `Cubit` repaints on state, not on someone else's stream.
  ///
  /// Five states, and the three that are NOT answers matter as much as the
  /// two that are: `unrated` is a fact the server stated, while `unknown`
  /// WITHHOLDS the survey, because `POST …/csat` is an upsert and only one of
  /// the two ways to be wrong loses data. See `CsatLookup` for the whole
  /// rule; none of it is re-derived here.
  ///
  /// Empty when the host wired up no `ChatSessionActions` — the feature is
  /// off, not broken.
  final Map<String, CsatLookup> csatBySession;

  /// Whether THIS VISITOR has silenced the local chime.
  ///
  /// ── Not a merchant setting ──────────────────────────────────────────
  ///
  /// `RemoteConfig.sound` is the merchant deciding whether a chime exists at
  /// all; this is the person in front of the screen deciding they have heard
  /// enough of it. Both have to agree before anything plays — see
  /// `chime.dart`, which is the one place the two are combined.
  ///
  /// ── Not persisted, and where that belongs ───────────────────────────
  ///
  /// The reference remembers it in `localStorage` under
  /// `chatsdk:<publishableKey>:muted`, keyed per publishable key so two
  /// tenants on one browser cannot mute each other. This package has no
  /// key-value store and does not add one here: the consent gate needs the
  /// same store, under the same per-publishable-key rule, and inventing a
  /// second one now would leave two answers to "where does this widget
  /// remember a per-visitor decision".
  ///
  /// So for this widget's lifetime, and re-asked on the next mount — which
  /// is the safe direction (a visitor who muted and comes back hears one
  /// chime and can mute again; the reverse would silence someone who never
  /// asked for it). `HeaderMenu` already paints the flipped label from
  /// whatever this says, including an already-muted value it has never seen
  /// change, so wiring a persisted read to it later is one line and no new
  /// behaviour.
  final bool muted;

  /// The message the customer is composing a reply TO, or null for none.
  ///
  /// ── One owner, and why it is this one ───────────────────────────────
  ///
  /// "Which message is being replied to" is a fact with exactly one home,
  /// and it is here. It deliberately does NOT also live in
  /// `ConversationScreen`'s local state, which is where it would be easiest
  /// to put: the send that consumes it is [ChatWidgetCubit.sendMessage]'s,
  /// so a copy held beside the screen would be a second answer that the
  /// Cubit could not see and the screen could not clear in step with a send.
  /// The same shape [composingNew] was collapsed into the surface slot to
  /// end.
  ///
  /// It also has to survive a rebuild that has nothing to do with it — a
  /// theme change, the keyboard opening, a parent repainting — and screen
  /// state does not: a customer who pressed Reply and then rotated the
  /// device would find the chip gone and their next message quietly not a
  /// reply.
  ///
  /// Cleared by the send that consumes it and by the chip's own dismiss, and
  /// by nothing else — see [copyWith]'s `clearReplyingTo`.
  final ReplyTarget? replyingTo;

  /// The session this client is currently in, or `null` before the first
  /// `connection.ack`/`session.updated` snapshot lands.
  final SessionSnapshot? session;

  /// The live transcript, in ARRIVAL order (a `Map` keyed by id preserves
  /// insertion position even when an entry is later updated in place — see
  /// [ChatWidgetCubit]'s header on why that is enough for this pass, and
  /// what it does not attempt).
  final List<ChatMessage> messages;
  final bool isTyping;

  /// Host-supplied conversation summaries for the Messages/Home screens.
  /// Empty by default — see [ChatSessionSummary]'s header on why this
  /// package cannot populate it itself.
  final List<ChatSessionSummary> sessionSummaries;

  /// Sum of [sessionSummaries]' `unreadCount` — the Messages tab's badge.
  /// `0` whenever no summaries have been supplied, which reads as "no
  /// unread", the same safe default an unread badge should have absent real
  /// data.
  final int unreadCount;

  /// Whether the DEVICE has a network, as last reported by the host.
  ///
  /// Not something this package can determine on its own — see
  /// [ChatWidgetCubit.setOnline] for why the connectivity plugin is the host's
  /// dependency and not this library's. `true` until told otherwise.
  ///
  /// Read `false` as hard evidence and `true` as no evidence at all: an
  /// interface existing says nothing about whether anything can be reached
  /// through it. `resolveOfflineBanner` is where the two are combined, and it
  /// treats them exactly that asymmetrically.
  final bool online;

  /// Consecutive failed connection attempts since the last successful connect.
  ///
  /// Counted from `ChatClient.reconnecting`, which fires once per scheduled
  /// retry, and reset by a `connected` transition — the only proof the run is
  /// over. See [WidgetChatClient.reconnecting] on why no snapshot carries it.
  final int failedAttempts;

  /// Composed messages waiting on the connection. They send themselves (§8.4).
  final int queuedCount;

  /// The New Conversation screen's chosen topic chip, or `null` — nothing
  /// picked, which is the default and stays valid: a topic is an optional
  /// refinement on a new conversation, never a requirement to start one.
  ///
  /// Cleared (not carried forward) once a new conversation actually starts
  /// composing again, once its first message sends, or when an existing
  /// conversation is opened instead — see [ChatWidgetCubit.startNewConversation],
  /// [ChatWidgetCubit.sendMessage] and [ChatWidgetCubit.openConversation].
  final ConversationTopic? selectedTopic;

  /// Whether THIS VISITOR has agreed to the merchant's consent notice.
  ///
  /// ── Gates the COMPOSER, not the widget ──────────────────────────────
  ///
  /// A visitor who has not agreed may still open the panel, read the
  /// greeting and see who they would be talking to — none of which stores
  /// anything about them. What they may not do is send, because sending is
  /// the act that creates the record the notice is about. See
  /// `ui/consent/consent_gate.dart` for the full statement of what the gate
  /// claims.
  ///
  /// ── `false` is the fail-safe, not merely the initial value ───────────
  ///
  /// The remembered answer lives in [ChatStorage] and is read ONCE, at
  /// [ChatWidgetCubit] construction. That read is async and every consumer
  /// of this is a synchronous build, so between construction and the read
  /// landing this reads `false` and the gate is CLOSED. A visitor briefly
  /// seeing a notice they already dismissed is a smaller failure than a
  /// conversation stored before the answer was known.
  ///
  /// This alone does NOT decide whether the composer is usable:
  /// `consentSatisfied(gating:, agreed:)` combines it with whether the
  /// merchant's notice is in force at all. A merchant who required nothing —
  /// or who switched the toggle on and left the text empty — gates nobody,
  /// whatever this says.
  final bool consentAgreed;

  /// The most recent §6.5 protocol error, or null if none has arrived.
  ///
  /// Diagnostic, not fatal: the connection may well recover on the next
  /// attempt, so this names what went wrong without asserting that anything
  /// is over. [suspendReason] is the one that says the client gave up.
  ///
  /// It exists because it was missing, and the absence was expensive: a
  /// client pointed at a misconfigured endpoint reconnected forever and the
  /// widget layer had no way to learn why — `AUTH_INVALID` and a refused
  /// protocol version both rendered as an endless "Connecting…".
  final ErrorPayload? lastError;

  /// Why the client stopped trying, or null while it is still trying.
  final SuspendReason? suspendReason;

  ChatWidgetState copyWith({
    ConnectionState? connectionState,
    RemoteConfig? config,
    ScreenName? screen,
    bool? canGoBack,
    SessionSnapshot? session,
    List<ChatMessage>? messages,
    bool? isTyping,
    List<ChatSessionSummary>? sessionSummaries,
    int? unreadCount,
    bool? online,
    int? failedAttempts,
    int? queuedCount,
    ConversationTopic? selectedTopic,
    // Unlike every other field here, "clear selectedTopic" IS something a
    // real caller needs (see the field's own doc: three different Cubit
    // methods reset it) — plain `??` cannot express "set this to null", so
    // this is the sentinel wrapper `session`'s own comment says was not yet
    // worth adding, now that there is an actual caller for it.
    bool clearSelectedTopic = false,
    ChatIdentity? identity,
    ProductSurface? activeSurface,
    // The slot's occupant genuinely goes back to null — every close, cancel
    // and discard does it — so this one needs the same sentinel
    // `selectedTopic` has, and for the same reason: `??` cannot say "null".
    bool clearActiveSurface = false,
    bool? conversationOpened,
    bool? preChatAnswered,
    Map<String, String>? preChatAnswers,
    String? startedTopicLabel,
    String? localParticipantId,
    Map<String, CsatLookup>? csatBySession,
    bool? muted,
    ReplyTarget? replyingTo,
    // A third sentinel, for the same reason as the two above and a more
    // frequent one: this field goes back to null on EVERY send and on every
    // dismiss, which is the ordinary course of a conversation rather than an
    // edge case. `??` cannot say "no longer replying to anything", and a
    // reply target that cannot be cleared would make every message after the
    // first one silently a reply too.
    bool clearReplyingTo = false,
    // No "clear" sentinel: consent is not withdrawn from inside the
    // widget — there is no control that un-agrees, and the record is
    // cleared by clearing the app's data — so `??` says everything it
    // needs to.
    bool? consentAgreed,
    ErrorPayload? lastError,
    SuspendReason? suspendReason,
  }) {
    return ChatWidgetState(
      connectionState: connectionState ?? this.connectionState,
      config: config ?? this.config,
      screen: screen ?? this.screen,
      canGoBack: canGoBack ?? this.canGoBack,
      // `session` has no way to be reset to null through `??` — not needed
      // yet (nothing in this package clears it) and not worth a sentinel
      // wrapper ahead of an actual caller.
      session: session ?? this.session,
      messages: messages ?? this.messages,
      isTyping: isTyping ?? this.isTyping,
      sessionSummaries: sessionSummaries ?? this.sessionSummaries,
      unreadCount: unreadCount ?? this.unreadCount,
      online: online ?? this.online,
      failedAttempts: failedAttempts ?? this.failedAttempts,
      queuedCount: queuedCount ?? this.queuedCount,
      selectedTopic:
          clearSelectedTopic ? null : (selectedTopic ?? this.selectedTopic),
      identity: identity ?? this.identity,
      activeSurface:
          clearActiveSurface ? null : (activeSurface ?? this.activeSurface),
      conversationOpened: conversationOpened ?? this.conversationOpened,
      preChatAnswered: preChatAnswered ?? this.preChatAnswered,
      // No "clear" sentinel: nothing resets this to "never asked" once the
      // customer has been asked, so `??` says everything it needs to.
      preChatAnswers: preChatAnswers ?? this.preChatAnswers,
      startedTopicLabel: startedTopicLabel ?? this.startedTopicLabel,
      localParticipantId: localParticipantId ?? this.localParticipantId,
      // No "clear" sentinel: the machine's verdicts only ever accumulate
      // within one widget lifetime, so `??` says everything it needs to.
      csatBySession: csatBySession ?? this.csatBySession,
      muted: muted ?? this.muted,
      replyingTo: clearReplyingTo ? null : (replyingTo ?? this.replyingTo),
      consentAgreed: consentAgreed ?? this.consentAgreed,
      lastError: lastError ?? this.lastError,
      suspendReason: suspendReason ?? this.suspendReason,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        connectionState,
        config,
        screen,
        canGoBack,
        // `composingNew` is deliberately absent: it is a getter over
        // `activeSurface`, which is right below, so listing it would compare
        // the same fact twice.
        session,
        messages,
        isTyping,
        sessionSummaries,
        unreadCount,
        online,
        failedAttempts,
        queuedCount,
        selectedTopic,
        identity,
        activeSurface,
        conversationOpened,
        preChatAnswered,
        preChatAnswers,
        startedTopicLabel,
        localParticipantId,
        csatBySession,
        muted,
        replyingTo,
        consentAgreed,
        lastError,
        suspendReason,
      ];
}
