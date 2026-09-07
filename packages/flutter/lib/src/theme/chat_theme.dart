/// Building a Flutter [ThemeData] from [RemoteConfig]'s appearance leaves —
/// the root widget's one theme-level read of the published config.
///
/// Deliberately narrow: only the leaves every screen shares (accent colour,
/// light/dark, font family, corner radius) live here. A hero's background
/// mode, a thread's backdrop pattern — those are screen-specific and read
/// directly by the screen that owns them, not folded into one theme object
/// speculatively ahead of the widgets that would use them.
library;

import 'package:flutter/material.dart';

import '../config/remote_config.dart';
import 'header_style.dart';

/// The seed colour when the merchant published none, or published something
/// this file cannot parse.
///
/// `#1f2937` (Tailwind slate-800) — the EXACT fallback the JS widget's own
/// resolved-appearance default uses (`config.ts`: `accent: config.accent ??
/// '#1f2937'`), so an unthemed Flutter panel matches an unthemed JS panel
/// rather than inventing a second "no accent" look. Verified by reading that
/// default directly rather than assumed from this package's own judgement of
/// what a reasonable neutral would be.
const Color kDefaultAccent = Color(0xFF1F2937);

/// Parses `#RRGGBB` or its `#RGB` shorthand into a fully-opaque [Color], or
/// `null` for anything else.
///
/// Narrower than the JS widget's own `cssColor`, which hands the string
/// straight to the BROWSER's CSS engine and so accepts named colours,
/// `rgb()`, `hsl()` — anything CSS can parse. Flutter has no equivalent
/// built-in arbitrary-CSS-colour parser, and the console's own accent
/// control is an `<input type="color">` swatch (styles.ts's header), which
/// only ever WRITES `#RRGGBB` — so hex is the one format a real published
/// config actually contains. `#RGB` is accepted too because it is three
/// lines to support and a hand-edited config is not otherwise validated
/// (remote_config.dart's header); anything else — including a CSS named
/// colour a raw API caller might publish — falls back to [kDefaultAccent]
/// rather than crashing the panel over a decorative field.
Color? parseHexColor(String? value) {
  if (value == null) return null;
  final String hex = value.trim().replaceFirst('#', '');
  if (!RegExp(r'^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$').hasMatch(hex)) return null;

  final String rrggbb =
      hex.length == 3 ? hex.split('').map((String c) => '$c$c').join() : hex;
  final int? rgb = int.tryParse(rrggbb, radix: 16);
  return rgb == null ? null : Color(0xFF000000 | rgb);
}

/// Builds the [ThemeData] a `ChatWidget` renders with.
///
/// [platformBrightness] is a parameter, not a `PlatformDispatcher.instance`
/// read buried in here, for the same testability reason
/// `session_display.dart`'s `relativeTimeLabel` takes `now` as a parameter
/// rather than calling `DateTime.now()` itself — this stays a pure function
/// a test can assert against exactly.
///
/// [WidgetTheme.auto] and an absent [RemoteConfig.theme] both defer to
/// [platformBrightness]. "Follow the OS" is the documented meaning of `auto`
/// (see [WidgetTheme]'s own doc) and is also the safest reading of "the
/// merchant never said" — the same "absent means unchanged" rule every other
/// appearance leaf in this package follows.
ThemeData chatThemeData(RemoteConfig config, Brightness platformBrightness) {
  final Brightness brightness = switch (config.theme) {
    WidgetTheme.light => Brightness.light,
    WidgetTheme.dark => Brightness.dark,
    WidgetTheme.auto || null => platformBrightness,
  };

  final Color accent = parseHexColor(config.accent) ?? kDefaultAccent;

  // ── The accent is used VERBATIM, and fromSeed alone will not do that ─────
  //
  // `ColorScheme.fromSeed` builds a full Material 3 tonal palette, which is
  // exactly what the surface/background/outline roles want — 40-odd colours
  // nobody should name by hand. But it does NOT preserve the seed: M3 maps it
  // into a harmonised tonal range, so `primary` comes back as roughly tone 40
  // of the seed's HUE with its chroma clamped, not the seed itself. A merchant
  // who published crimson `#e11d48` gets maroon; one who published a violet
  // gets a pale lavender. Reported from a real tenant, not theorised.
  //
  // The reference does not transform the accent at all — `styles.ts:105` is
  // `--dh-accent: ${cssColor(config.accent)}`, straight through — and a brand
  // colour is the one value in this config a merchant will hold us to
  // exactly. So the tonal palette is kept for everything derived, and the
  // roles that ARE the brand colour are pinned back to what was published.
  //
  // `onPrimary` comes from `readableOn` (the port of `styles.ts`'s own
  // helper) rather than from the palette, because a pinned `primary` and a
  // generated `onPrimary` are computed against different colours — which is
  // how you get unreadable text on a correct button.
  final ColorScheme generated = ColorScheme.fromSeed(
    seedColor: accent,
    brightness: brightness,
  );
  final ColorScheme scheme = generated.copyWith(
    primary: accent,
    onPrimary: readableOn(accent),
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    brightness: brightness,
    // null is a valid ThemeData.fontFamily — "use the platform default" —
    // which is exactly what an absent RemoteConfig.fontFamily should mean.
    fontFamily: config.fontFamily,
  );
}

/// The corner-radius appearance leaf, clamped to a bound a `BorderRadius`
/// can be trusted with.
///
/// A screen widget applies this to its OWN buttons/cards/chips directly —
/// this is not baked into every component sub-theme here speculatively,
/// ahead of the widgets that would use them (incremental-implementation's
/// Rule 0.5: touch only what the task requires).
///
/// Clamped for the same reason `remote_config.dart`'s `readSeconds` clamps a
/// delay: this feeds straight into `BorderRadius.circular`, and an absurd or
/// negative published number should degrade to a sane corner rather than
/// distort every control in the panel. `12` — a middling, unopinionated
/// default — matches neither a sharp nor a pill shape, so an unthemed panel
/// does not read as a deliberate design choice either way.
double chatCornerRadius(RemoteConfig config) =>
    (config.cornerRadius ?? 12).clamp(0, 32).toDouble();
