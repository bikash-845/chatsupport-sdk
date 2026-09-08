/// One state snapshot in, one render out. The whole of `message-list.ts`'s
/// `render()` and `announce()`, minus the DOM.
///
/// ── Why this is one call and not six helpers the view stitches together ──
///
/// Every rule the transcript has to get right — the §12.10 placeholder, the
/// tick that may only come from [deriveTickState], `retryable` never
/// re-derived, the author name on the first bubble of a run against the
/// avatar on every row, the remembered bot name, the announce watermark —
/// interacts with at least one other. Handing the view six functions and a
/// loop is handing it six chances to combine them differently from the next
/// caller. [present] is the whole interface: the view receives rows and
/// draws them.
///
/// It is also what makes the rules assertable without pumping a widget.
///
/// ── The announce discipline ─────────────────────────────────────────────
///
/// Three filters, each removing a real annoyance: our own messages are never
/// announced (the user wrote them), nothing is announced on the first state
/// seen (that is history loading, and announcing forty messages on open is
/// hostile), and a message already announced is never repeated when an
/// unrelated field on it changes — which is why the watermark is the message
/// ID rather than the array length, since a tick update does not lengthen
/// the array but a retry-then-succeed does reorder it.
library;

import 'package:dhaam_chat/dhaam_chat.dart'
    show ChatMessage, MessageFailed, SessionSnapshot;

import 'message_content.dart';
import 'message_row.dart';
import 'quick_reply_options.dart';
import 'reply_quote.dart';
import 'sender_label.dart';
import 'tick_state.dart';

/// Everything [MessageListPresenter.present] reads.
///
/// A projection of the widget's state rather than a re-ordering of it: the
/// watermark maps are named exactly as a `ChatState` names them, and the
/// fields this module must NOT see — presence, connection state, agent
/// liveness — are absent by construction.
class MessageListInputs {
  const MessageListInputs({
    required this.messages,
    this.session,
    this.localParticipantId,
    this.deliveredWatermarks = const <String, int>{},
    this.readWatermarks = const <String, DateTime>{},
    this.handoffKeywords = const <String>[],
    this.sessionClosed = false,
    this.isTyping = false,
    this.initialLoaded = false,
  });

  /// The transcript, in ARRIVAL order (oldest first).
  final List<ChatMessage> messages;

  final SessionSnapshot? session;

  /// Who "we" are — see [TickInput.localParticipantId].
  final String? localParticipantId;

  final Map<String, int> deliveredWatermarks;
  final Map<String, DateTime> readWatermarks;

  /// The tenant's `RemoteConfig.handoffKeywords`, for the chip filter.
  final List<String> handoffKeywords;

  /// Whether the session has ended. Suppresses the chips — one that would
  /// reopen nothing is a dead control.
  final bool sessionClosed;

  final bool isTyping;

  /// Whether the first page of history has come back.
  ///
  /// An empty list before it has means "nobody has asked yet", and telling a
  /// customer with a year of history that their conversation is empty is a
  /// lie — one they re-read on every session switch, which clears the
  /// transcript on purpose.
  final bool initialLoaded;
}

/// What the view draws.
class MessageListRender {
  const MessageListRender({
    required this.rows,
    required this.announcement,
    required this.quickReplies,
    required this.typingLabel,
    required this.typingAvatarLetter,
    required this.showEmptyState,
  });

  final List<MessageRow> rows;

  /// The one thing to say through the live region on this tick, or `null`.
  final String? announcement;

  /// The bot's suggested follow-ups, already handoff-filtered.
  final List<String> quickReplies;

  /// "<who> is typing" — the only channel that can say WHO.
  final String typingLabel;

  /// The initial for the typing row's avatar disc.
  ///
  /// Derived from the SAME [handlerName] that [typingLabel] is, so the disc
  /// and the name a screen reader hears can never name two different people
  /// — which is exactly what a second derivation off `session.assignedAgent`
  /// would produce the moment a session escalates away from the bot.
  final String? typingAvatarLetter;

  /// Whether to show "no messages yet". See [MessageListInputs.initialLoaded].
  final bool showEmptyState;
}

class MessageListPresenter {
  final BotNameMemory _botName = BotNameMemory();

  String? _announcedUpTo;
  bool _seenAnyState = false;

  /// The bot name currently remembered. Exposed for assertions and for a
  /// host that wants the same name elsewhere; never a second derivation.
  String? get lastBotName => _botName.name;

  MessageListRender present(MessageListInputs inputs) {
    final String? botName = _botName.observe(inputs.session);

    final List<MessageRow> rows = <MessageRow>[];
    // Names the FIRST message of each run only.
    String? previousAuthor;

    for (final ChatMessage message in inputs.messages) {
      final bool outgoing = isOutgoing(message);
      // Only incoming messages are named — but `senderName` (unlike
      // `showAuthorName`) is NOT suppressed for a continued run, because the
      // avatar draws from it on every row.
      final String? senderName =
          outgoing ? null : senderLabel(message, inputs.session, botName);
      final bool showAuthorName =
          senderName != null && senderName != previousAuthor;
      previousAuthor = senderName;

      rows.add(
        MessageRow(
          message: message,
          outgoing: outgoing,
          text: visibleContent(message),
          senderName: senderName,
          showAuthorName: showAuthorName,
          avatarLetter: _avatarLetter(senderName),
          tick: deriveTickState(
            TickInput(
              message: message,
              localParticipantId: inputs.localParticipantId,
              deliveredWatermarks: inputs.deliveredWatermarks,
              readWatermarks: inputs.readWatermarks,
            ),
          ),
          // Read off the message, not out of a map beside it.
          //
          // This WAS `inputs.failures[message.id]`, a lookup the caller had
          // to fill — and no caller could, because the reason and the
          // `retryable` verdict were computed inside `ChatClient` and never
          // escaped a private map. The Retry affordance and every failure
          // sentence in this module therefore rendered nothing at all. The
          // union closed that: a failure is now a property of the message,
          // so a row cannot disagree with its own delivery state and there
          // is no second source to keep in step.
          failure: switch (message.delivery) {
            final MessageFailed failed => failed,
            _ => null,
          },
          quote: readReplyQuote(message.metadata),
        ),
      );
    }

    final String handler = handlerName(inputs.session, botName);

    return MessageListRender(
      rows: List<MessageRow>.unmodifiable(rows),
      announcement: _announce(inputs, botName),
      quickReplies: quickRepliesFor(
        inputs.messages,
        handoffKeywords: inputs.handoffKeywords,
        sessionClosed: inputs.sessionClosed,
      ),
      typingLabel: '$handler is typing',
      typingAvatarLetter: _avatarLetter(handler),
      showEmptyState: inputs.messages.isEmpty && inputs.initialLoaded,
    );
  }

  /// The newest INCOMING message, spoken once. See this file's header.
  String? _announce(MessageListInputs inputs, String? botName) {
    final ChatMessage? newest =
        inputs.messages.isEmpty ? null : inputs.messages.last;

    if (!_seenAnyState) {
      _seenAnyState = true;
      _announcedUpTo = newest?.id;
      return null;
    }
    if (newest == null) return null;
    if (newest.id == _announcedUpTo) return null;

    _announcedUpTo = newest.id;

    // Two tests for "ours", and both are needed here. `senderId` is the
    // authoritative one and is what `message-list.ts` uses — but this
    // package's state layer does not carry `localParticipantId` yet, where
    // the JS widget's socket always knows it, so on the common path the
    // first test is unavailable. `isOutgoing` closes that window: this is
    // the customer's widget, and a CUSTOMER-authored message is ours by
    // definition. With the id known the two agree, so this is strictly a
    // narrowing — it can only ever announce less, never more.
    final String? local = inputs.localParticipantId;
    if (local != null && newest.senderId == local) return null;
    if (isOutgoing(newest)) return null;

    final String who = senderLabel(newest, inputs.session, botName);
    return '$who: ${describeContent(newest)}';
  }
}

/// One character for the avatar disc, upper-cased.
///
/// `runes.first` rather than `substring(0, 1)`: a name beginning with an
/// astral character (an emoji, or a rarer CJK ideograph) is two UTF-16 code
/// units, and taking one of them yields half a surrogate pair — a replacement
/// glyph where the customer expected a letter.
///
/// Upper-casing happens here rather than in the view because Flutter has no
/// `text-transform`, so there is no styling layer to leave it to as
/// `ui/styles.ts` does.
String? _avatarLetter(String? senderName) {
  if (senderName == null) return null;
  final String trimmed = senderName.trim();
  if (trimmed.isEmpty) return null;
  return String.fromCharCode(trimmed.runes.first).toUpperCase();
}
