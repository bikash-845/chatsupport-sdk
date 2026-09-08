/// The identity disc that sits beside an incoming bubble.
///
/// Its own file because two rows draw it: a real incoming message
/// ([MessageBubbleRow]) and the typing bubble ([TypingIndicator]). Those
/// live in different libraries, and a disc defined in one of them and
/// imported by the other is how the two rows end up subtly out of column.
library;

import 'package:flutter/material.dart';

/// The per-row identity disc.
///
/// Deliberately NOT the header avatar's content: that disc's letters come
/// from the merchant's configured initials, which name the BRAND rather than
/// whoever sent this particular message. The letter here always comes from
/// the resolved sender name — the same resolution the visible author heading
/// uses.
///
/// Hidden from assistive tech: a screen reader already gets this message's
/// sender from the author heading on the first bubble of a run, and gets
/// nothing extra for a later bubble — same as a sighted reader, who has only
/// the earlier heading and the alignment to go on. This disc is a
/// sighted-only convenience on top of that rule, not a new source of truth.
class MessageAvatar extends StatelessWidget {
  const MessageAvatar({super.key, required this.letter});

  final String letter;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return ExcludeSemantics(
      child: Container(
        width: 24,
        height: 24,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: scheme.primaryContainer,
          shape: BoxShape.circle,
        ),
        child: Text(
          letter,
          style: Theme.of(context)
              .textTheme
              .labelSmall
              ?.copyWith(color: scheme.onPrimaryContainer),
        ),
      ),
    );
  }
}
