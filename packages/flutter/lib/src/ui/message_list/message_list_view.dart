/// The scrollback itself. Draws whatever [MessageListPresenter] projected
/// and decides nothing of its own.
///
/// The one thing this widget owns that the projection cannot is the scroll
/// anchor: whether the customer was at the bottom has to be read from a laid
/// out list, and read BEFORE it grows (see [isNearBottom]).
library;

import 'package:dhaam_chat/dhaam_chat.dart'
    show AttachmentMetadata, ChatMessage;
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../quick_replies.dart';
import 'linkified_text.dart';
import 'message_actions.dart';
import 'message_avatar.dart';
import 'message_list_presenter.dart';
import 'message_row.dart';
import 'reply_quote.dart';
import 'scroll_anchor.dart';
import 'tick_state.dart';
import 'typing_indicator.dart';

/// Everything the transcript hands back to its host.
class MessageListCallbacks {
  const MessageListCallbacks({
    required this.onCopyMessage,
    required this.onQuickReply,
    this.onRetry,
    this.onReplyToMessage,
    this.onOpenLink,
  });

  /// Replays THIS message — the object core gave the row, id and all, never
  /// its rendered text. A retry keyed on `message.id` can therefore never
  /// see the §12.10 placeholder-stripped string.
  ///
  /// `null` when the host has no per-message replay to offer, and then no
  /// Retry button is drawn at all — `WidgetChatClient` deliberately does not
  /// expose `ChatClient.retry()` yet, and its `retryNow()` is a CONNECTION
  /// retry, not a message one. Wiring the button to that would be the same
  /// lie in a new place: a control that cannot do what its label says.
  /// [MessageRow.showRetry] is unchanged — the projection still answers
  /// "should this message be retryable"; this answers "can anyone retry it".
  final ValueChanged<ChatMessage>? onRetry;

  /// Puts the message's text on the clipboard. Throws if the platform
  /// refuses.
  final Future<void> Function(ChatMessage message) onCopyMessage;

  /// Starts a reply addressed to this message.
  ///
  /// The resolved sender name rides along because only the transcript can
  /// resolve it: a [ChatMessage] carries no display name, and the composer
  /// needs the name for its quote chip and for the send's `reply` metadata
  /// without re-deriving it from state a second way.
  ///
  /// `null` removes the Reply item from the menu entirely, for the same
  /// reason edit and delete are absent: reply needs somewhere to put the
  /// draft, and a menu item that cannot work is worse than an absent one.
  final void Function(ChatMessage message, String senderName)? onReplyToMessage;

  /// Sends one of the bot's suggested follow-ups as the customer's next
  /// message — verbatim, which is why the chip row is handoff-filtered.
  final ValueChanged<String> onQuickReply;

  /// Opens a link the customer tapped. `null` renders links inert.
  final ValueChanged<String>? onOpenLink;
}

class MessageListView extends StatefulWidget {
  const MessageListView({
    super.key,
    required this.inputs,
    required this.callbacks,
    this.presenter,
    this.attachmentBuilder,
  });

  final MessageListInputs inputs;
  final MessageListCallbacks callbacks;

  /// The projection. Externally owned when a caller needs its remembered bot
  /// name or its announce watermark to survive this widget; otherwise this
  /// widget owns one for its lifetime.
  final MessageListPresenter? presenter;

  /// Draws one attachment. Left as a seam: attachment rendering is its own
  /// node's work, and a half-built one here would be the "menu item that
  /// cannot work" mistake in another shape.
  final Widget Function(BuildContext context, AttachmentMetadata attachment)?
      attachmentBuilder;

  @override
  State<MessageListView> createState() => _MessageListViewState();
}

/// The typing row's slot in the sliver.
///
/// Deliberately NOT a `ValueKey<String>`: `findChildIndexCallback` reads
/// those as message ids, and a message whose id happened to match would
/// silently claim the typing row's position.
const Key _typingRowKey = ValueKey<Type>(TypingIndicator);

class _MessageListViewState extends State<MessageListView> {
  final ScrollController _scroll = ScrollController();

  MessageListPresenter? _owned;
  MessageListPresenter get _presenter =>
      widget.presenter ?? (_owned ??= MessageListPresenter());

  /// Whether the transcript should follow the newest message down once this
  /// frame is laid out.
  ///
  /// Armed ONLY by a new [MessageListInputs] — never by a plain rebuild. A
  /// theme change, a keyboard opening or a parent rebuilding does not move
  /// the transcript, and a customer who has scrolled up to re-read something
  /// is not yanked back to the bottom because the phone rotated. The first
  /// frame arms it, so a transcript opens at its newest end.
  bool _followToBottom = true;

  @override
  void didUpdateWidget(MessageListView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.inputs, widget.inputs)) return;
    // Read BEFORE the new list is laid out: a scroll offset read after an
    // append gives the post-append value, which would make "was the customer
    // at the bottom" always true for a growing list.
    _followToBottom = _atBottomNow();
  }

  bool _atBottomNow() {
    if (!_scroll.hasClients) return true;
    return isNearBottom(
      pixels: _scroll.position.pixels,
      maxScrollExtent: _scroll.position.maxScrollExtent,
    );
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _afterLayout(String? announcement) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_followToBottom) {
        _followToBottom = false;
        if (_scroll.hasClients) {
          _scroll.jumpTo(_scroll.position.maxScrollExtent);
        }
      }
      // No de-duplication here: `present` already returns `null` for a
      // rebuild that brought no new message, so an announcement reaching
      // this point is one the customer has not heard. Comparing against the
      // last text instead would swallow the second of two identical
      // messages, which is a real thing an agent sends.
      if (announcement != null) {
        SemanticsService.announce(announcement, Directionality.of(context));
      }
    });
  }

  /// message id → its position in the rows currently rendered. Rebuilt each
  /// pass; see [ListView.builder]'s `findChildIndexCallback` below.
  final Map<String, int> _indexById = <String, int>{};

  @override
  Widget build(BuildContext context) {
    final MessageListRender render = _presenter.present(widget.inputs);
    _afterLayout(render.announcement);

    _indexById.clear();
    for (int i = 0; i < render.rows.length; i += 1) {
      _indexById[render.rows[i].message.id] = i;
    }

    // The typing bubble is the LAST item of the transcript, not a band
    // below it — `message-list.ts` appends its node to `log`, the element
    // that scrolls, and says why: it has to read as "someone is composing
    // the next message", not as an interruption in the middle of history.
    //
    // Being inside the sliver is also what puts it under the near-bottom
    // rule. Outside it, the row grew the COLUMN rather than the scrollable,
    // so `maxScrollExtent` never moved and following the transcript down
    // could not reach it; a customer sitting at the bottom watched the
    // bubble appear underneath the message they were reading instead of
    // after it.
    final bool typing = widget.inputs.isTyping;
    final int itemCount = render.rows.length + (typing ? 1 : 0);

    return Column(
      children: <Widget>[
        Expanded(
          child: itemCount == 0
              ? _EmptyTranscript(show: render.showEmptyState)
              : Semantics(
                  container: true,
                  label: 'Conversation',
                  child: ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    itemCount: itemCount,
                    // What makes the keys below actually reuse an element
                    // across an insertion. A sliver matches children by
                    // INDEX unless it is told where a key moved to, so
                    // without this the keys would only prevent the wrong
                    // state being inherited — they would not preserve the
                    // right state either, and an open menu would still shut
                    // the moment a message landed above it.
                    findChildIndexCallback: (Key key) {
                      // The typing row answers too, and has to: it is the
                      // one child whose index moves on every arrival, and a
                      // `null` here would rebuild it from scratch — which
                      // restarts its dots mid-bounce every time a message
                      // lands.
                      if (key == _typingRowKey) {
                        return typing ? render.rows.length : null;
                      }
                      final String? id =
                          key is ValueKey<String> ? key.value : null;
                      return id == null ? null : _indexById[id];
                    },
                    itemBuilder: (BuildContext context, int index) {
                      if (index == render.rows.length) {
                        return Padding(
                          key: _typingRowKey,
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: TypingIndicator(
                            label: render.typingLabel,
                            avatarLetter: render.typingAvatarLetter,
                          ),
                        );
                      }
                      final MessageRow row = render.rows[index];
                      return Padding(
                        // Keyed by message id, the way `message-list.ts`
                        // keys its rows: a `ListView` recycles elements by
                        // INDEX, so without this an open action menu (or a
                        // half-finished Copy) would ride an insertion onto
                        // a different message.
                        key: ValueKey<String>(row.message.id),
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: MessageBubbleRow(
                          row: row,
                          callbacks: widget.callbacks,
                          attachmentBuilder: widget.attachmentBuilder,
                        ),
                      );
                    },
                  ),
                ),
        ),
        if (render.quickReplies.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: QuickReplies(
              options: render.quickReplies,
              onSelect: widget.callbacks.onQuickReply,
            ),
          ),
      ],
    );
  }
}

/// One row: the avatar beside the bubble, never inside it.
///
/// The avatar sits on [MessageBubbleRow] rather than on the bubble so it is
/// not painted into the bubble's own coloured background.
class MessageBubbleRow extends StatelessWidget {
  const MessageBubbleRow({
    super.key,
    required this.row,
    required this.callbacks,
    this.attachmentBuilder,
  });

  final MessageRow row;
  final MessageListCallbacks callbacks;
  final Widget Function(BuildContext context, AttachmentMetadata attachment)?
      attachmentBuilder;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final Color bubbleColor =
        row.outgoing ? scheme.primary : scheme.surfaceContainerHighest;
    final Color textColor = row.outgoing ? scheme.onPrimary : scheme.onSurface;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisAlignment:
          row.outgoing ? MainAxisAlignment.end : MainAxisAlignment.start,
      children: <Widget>[
        if (row.avatarLetter != null) ...<Widget>[
          MessageAvatar(letter: row.avatarLetter!),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: Column(
            crossAxisAlignment: row.outgoing
                ? CrossAxisAlignment.end
                : CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: bubbleColor,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    // Above the text rather than beside the timestamp: the
                    // customer needs to know who is speaking BEFORE they
                    // read the words, and a name discovered underneath them
                    // arrives too late to frame what they just read.
                    if (row.showAuthorName && row.senderName != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 2),
                        child: Text(
                          row.senderName!,
                          style: Theme.of(context)
                              .textTheme
                              .labelSmall
                              ?.copyWith(color: textColor),
                        ),
                      ),
                    if (row.quote != null)
                      _QuoteStrip(quote: row.quote!, color: textColor),
                    if (row.message.attachment != null &&
                        attachmentBuilder != null)
                      attachmentBuilder!(context, row.message.attachment!),
                    if (row.text.isNotEmpty)
                      LinkifiedText(
                        row.text,
                        style: TextStyle(color: textColor),
                        onOpenLink: callbacks.onOpenLink,
                      ),
                  ],
                ),
              ),
              _MetaRow(row: row, callbacks: callbacks),
            ],
          ),
        ),
        MessageActions(
          onCopy: () => callbacks.onCopyMessage(row.message),
          onReply: callbacks.onReplyToMessage == null
              ? null
              : () => callbacks.onReplyToMessage!(
                    row.message,
                    row.replyAttribution,
                  ),
        ),
      ],
    );
  }
}

/// The quoted message this one replies to: a quiet strip above the message's
/// own words, name on top.
///
/// Drawn from the message's OWN metadata — the quoted message may have
/// scrolled out of the loaded page entirely, so the excerpt travels with the
/// reply rather than being looked up.
class _QuoteStrip extends StatelessWidget {
  const _QuoteStrip({required this.quote, required this.color});

  final ReplyQuote quote;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.only(left: 8),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: color.withOpacity(0.5))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            quote.senderName,
            style: Theme.of(context)
                .textTheme
                .labelSmall
                ?.copyWith(color: color, fontWeight: FontWeight.w600),
          ),
          Text(
            quote.excerpt,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: color.withOpacity(0.85)),
          ),
        ],
      ),
    );
  }
}

/// The time, the tick, the failure sentence and the retry control.
class _MetaRow extends StatelessWidget {
  const _MetaRow({required this.row, required this.callbacks});

  final MessageRow row;
  final MessageListCallbacks callbacks;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final TextStyle? meta = Theme.of(context)
        .textTheme
        .labelSmall
        ?.copyWith(color: scheme.onSurfaceVariant);
    final MessageTickState? tick = row.tick;
    final String? failureText = row.failureText;

    return Padding(
      padding: const EdgeInsets.only(top: 2, left: 2, right: 2),
      child: Column(
        crossAxisAlignment:
            row.outgoing ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(_time(context, row.message.createdAt), style: meta),
              if (tick != null) ...<Widget>[
                const SizedBox(width: 4),
                // The glyph carries no meaning of its own to assistive tech;
                // the word beside it does. WCAG 1.4.1: colour alone cannot
                // be the difference between "delivered" and "read".
                ExcludeSemantics(
                  child: Text(tickPresentation(tick).glyph, style: meta),
                ),
                const SizedBox(width: 2),
                Text(tickPresentation(tick).label, style: meta),
              ],
            ],
          ),
          if (failureText != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(Icons.error_outline, size: 12, color: scheme.error),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      failureText,
                      style: meta?.copyWith(color: scheme.error),
                    ),
                  ),
                  // Offered only when core said retrying is worth
                  // attempting. `showRetry` is `!failure.retryable` and
                  // nothing else — never re-derived from the reason or the
                  // code. The second half of the condition is a different
                  // question: whether the host has a per-message replay to
                  // offer at all. See `onRetry`.
                  if (row.showRetry && callbacks.onRetry != null) ...<Widget>[
                    const SizedBox(width: 4),
                    TextButton(
                      onPressed: () => callbacks.onRetry!(row.message),
                      style: TextButton.styleFrom(
                        minimumSize: Size.zero,
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      child: const Text('Retry'),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }

  static String _time(BuildContext context, DateTime createdAt) {
    return MaterialLocalizations.of(context).formatTimeOfDay(
      TimeOfDay.fromDateTime(createdAt.toLocal()),
    );
  }
}

class _EmptyTranscript extends StatelessWidget {
  const _EmptyTranscript({required this.show});

  /// `false` before the first page has come back. An empty list then means
  /// "nobody has asked yet", and telling a customer with a year of history
  /// that their conversation is empty is a lie — one they would re-read on
  /// every session switch, which clears the transcript on purpose.
  final bool show;

  @override
  Widget build(BuildContext context) {
    if (!show) return const SizedBox.expand();
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          'No messages yet. Ask us anything about your order.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
        ),
      ),
    );
  }
}
