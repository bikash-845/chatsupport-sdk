/// The typing bubble — three animated dots drawn as an INCOMING message.
///
/// Ports `.dh-typing` / `.dh-typing-dot` and the `dh-bounce` keyframes from
/// `packages/widget/src/ui/styles.ts`.
///
/// ── Why the dots move, and why that is not decoration ────────────────────
///
/// This was a static `Text('…')` in a box. Three characters that never
/// change do not say "someone is composing"; they say "this UI is stuck" —
/// which is exactly how the bug was reported. Motion is the whole signal,
/// and it is the one thing an ellipsis cannot carry.
///
/// ── Reduced motion ───────────────────────────────────────────────────────
///
/// `styles.ts` ends its `@media (prefers-reduced-motion: reduce)` block with
/// `.dh-typing-dot { animation: none; }` — the dots hold still and the
/// bubble stays. Flutter's equivalent of that query is
/// `MediaQueryData.disableAnimations`, which the framework populates from
/// `PlatformDispatcher.accessibilityFeatures`
/// (flutter/lib/src/widgets/media_query.dart, Flutter 3.24.4), so the port
/// is one read rather than a platform channel. The bubble is deliberately
/// NOT hidden in that case: a customer who asked for less motion still
/// needs to know somebody is replying.
library;

import 'package:flutter/material.dart';

/// One full cycle of the dot animation — `dh-bounce`'s `1.2s`.
const Duration kTypingDotPeriod = Duration(milliseconds: 1200);

/// Where each dot sits in that cycle.
///
/// `styles.ts` staggers them with `animation-delay: 0.15s` on the second dot
/// and `0.3s` on the third; expressed as a fraction of the 1.2s period that
/// is 0, 0.125 and 0.25. A CSS delay shifts the animation LATER, so a dot's
/// own progress at wall time `t` is `t - delay` — see [_bounceAt]'s caller.
const List<double> _dotPhases = <double>[0, 0.125, 0.25];

/// `dh-bounce`, evaluated at [progress] (0..1 through one cycle).
///
/// The keyframes verbatim:
///
///     0%, 60%, 100% { transform: translateY(0);    opacity: 0.5; }
///     30%           { transform: translateY(-3px); opacity: 1;   }
///
/// Interpolated linearly between them. CSS would ease each segment; the
/// difference across a 6px dot over 360ms is under a pixel, and a curve
/// here would be a second, differently-shaped copy of a rule that already
/// lives in `styles.ts`.
({double dy, double opacity}) _bounceAt(double progress) {
  const double liftPx = -3;
  const double restOpacity = 0.5;

  if (progress < 0.3) {
    final double t = progress / 0.3;
    return (dy: liftPx * t, opacity: restOpacity + 0.5 * t);
  }
  if (progress < 0.6) {
    final double t = (progress - 0.3) / 0.3;
    return (dy: liftPx * (1 - t), opacity: 1 - 0.5 * t);
  }
  return (dy: 0, opacity: restOpacity);
}

/// The typing bubble: an incoming bubble containing three bouncing dots.
///
/// Deliberately not a live region — a typing indicator that announces itself
/// interrupts the message the customer is actually reading, and it can flap
/// several times a second. [label] is the only channel that can say WHO; it
/// used to be the fixed word "Agent", which named a human on a session being
/// handled by the bot.
class TypingIndicator extends StatelessWidget {
  const TypingIndicator({super.key, required this.label});

  /// "<who> is typing", from `MessageListRender.typingLabel`.
  final String label;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Container(
      // The incoming bubble's own padding and radius, from
      // `MessageBubbleRow` — the point of this row is that it reads as a
      // message someone is composing, so it may not be shaped differently
      // from the message that follows it.
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Semantics(
        label: label,
        liveRegion: false,
        // The three animated dots say SOMEONE is composing; this label is
        // the only channel that can say who. Excluded rather than merged,
        // so a screen reader reads the name and not the dots.
        excludeSemantics: true,
        child: const TypingDots(),
      ),
    );
  }
}

/// The three dots on their own, without the bubble.
///
/// Split out so the animation can be exercised — and so [TypingIndicator]
/// stays a plain [StatelessWidget] that any layout can place.
class TypingDots extends StatefulWidget {
  const TypingDots({super.key});

  @override
  State<TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _cycle = AnimationController(
    vsync: this,
    duration: kTypingDotPeriod,
  );

  /// Whether the ticker is currently running.
  ///
  /// Tracked rather than re-derived from the controller because the answer
  /// depends on [MediaQueryData.disableAnimations], which can change while
  /// this widget is mounted (the customer turns "reduce motion" on in system
  /// settings) — and `didChangeDependencies` is the only place that is
  /// observable.
  bool _running = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // `maybeDisableAnimationsOf`, not `disableAnimationsOf`: this widget is
    // usable outside a MediaQuery, and the accessible default for "nobody
    // said" is to animate, exactly as a browser with no
    // `prefers-reduced-motion` preference does.
    final bool shouldRun =
        !(MediaQuery.maybeDisableAnimationsOf(context) ?? false);
    if (shouldRun == _running) return;
    _running = shouldRun;
    if (shouldRun) {
      _cycle.repeat();
    } else {
      // Stopped at rest, not mid-bounce: a frozen dot lifted 3px above its
      // neighbours reads as a rendering glitch.
      _cycle.stop();
      _cycle.value = 0;
    }
  }

  @override
  void dispose() {
    _cycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Color dotColor = Theme.of(context).colorScheme.onSurfaceVariant;
    return SizedBox(
      // Tall enough for the 6px dot plus `dh-bounce`'s 3px lift, so the
      // bubble does not change height as the dots move.
      height: 12,
      child: AnimatedBuilder(
        animation: _cycle,
        builder: (BuildContext context, Widget? child) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              for (int i = 0; i < _dotPhases.length; i += 1) ...<Widget>[
                // `.dh-typing`'s `gap: calc(var(--dh-space) * 1)` — 4px.
                if (i > 0) const SizedBox(width: 4),
                _Dot(
                  color: dotColor,
                  // Wrapped into 0..1: a CSS delay shifts a dot BACK through
                  // the cycle, so the second dot shows what the first showed
                  // 0.15s ago.
                  progress: (_cycle.value - _dotPhases[i] + 1) % 1,
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.color, required this.progress});

  final Color color;
  final double progress;

  @override
  Widget build(BuildContext context) {
    final ({double dy, double opacity}) frame = _bounceAt(progress);
    return Transform.translate(
      offset: Offset(0, frame.dy),
      child: Opacity(
        opacity: frame.opacity,
        child: Container(
          // `.dh-typing-dot`'s `width: 6px; height: 6px; border-radius: 999px`.
          width: 6,
          height: 6,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
      ),
    );
  }
}
