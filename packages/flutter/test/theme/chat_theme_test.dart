import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/remote_config_fixtures.dart';

/// Scoped to just the theme-relevant leaves this file exercises — the
/// shared [testRemoteConfig] takes every leaf, but repeating "accent:
/// accent, theme: theme, ..." at each call site below would be its own kind
/// of noise.
RemoteConfig _config(
    {String? accent,
    WidgetTheme? theme,
    String? fontFamily,
    double? cornerRadius}) {
  return testRemoteConfig(
      accent: accent,
      theme: theme,
      fontFamily: fontFamily,
      cornerRadius: cornerRadius);
}

void main() {
  group('parseHexColor', () {
    test('parses a 6-digit hex string, with or without the #', () {
      expect(parseHexColor('#ff0000'), const Color(0xFFFF0000));
      expect(parseHexColor('00ff00'), const Color(0xFF00FF00));
    });

    test('expands the 3-digit shorthand', () {
      expect(parseHexColor('#f00'), const Color(0xFFFF0000));
    });

    test('is case-insensitive', () {
      expect(parseHexColor('#AbCdEf'), parseHexColor('#abcdef'));
    });

    test('null for absent, malformed, or a CSS colour Flutter cannot parse',
        () {
      expect(parseHexColor(null), isNull);
      expect(parseHexColor('not-a-color'), isNull);
      expect(parseHexColor('rebeccapurple'), isNull);
      expect(parseHexColor('rgb(0, 0, 0)'), isNull);
      expect(parseHexColor('#12'), isNull);
    });
  });

  group('chatThemeData', () {
    test(
        'an absent accent falls back to the JS widget\'s own default (#1f2937)',
        () {
      final theme = chatThemeData(_config(), Brightness.light);
      expect(theme.colorScheme.primary, kDefaultAccent);
    });

    test('a published accent reaches primary VERBATIM, not tonally mapped', () {
      // The bug this pins, reported from a real tenant: `ColorScheme.fromSeed`
      // does not preserve its seed. It maps the colour into a Material 3 tonal
      // palette, so crimson came back as maroon and a violet came back pale.
      // A brand colour is the one value a merchant will hold us to exactly,
      // and the reference does not transform it at all (`styles.ts:105`).
      for (final int hex in <int>[0xFFE11D48, 0xFF7C3AED, 0xFFFF0000]) {
        final Color accent = Color(hex);
        final ThemeData theme = chatThemeData(
          _config(accent: '#${hex.toRadixString(16).substring(2)}'),
          Brightness.light,
        );
        expect(theme.colorScheme.primary, accent,
            reason: 'accent must survive theming unchanged');
        // The guard that makes pinning `primary` safe: a generated onPrimary
        // would have been computed against the tonal colour, not this one.
        expect(theme.colorScheme.onPrimary, readableOn(accent));
      }
    });

    test('fromSeed would NOT have preserved the accent — the control', () {
      // Without this, the test above could pass against an implementation
      // that never had the problem, and would not notice a revert to
      // plain fromSeed.
      const Color crimson = Color(0xFFE11D48);
      final ColorScheme seeded = ColorScheme.fromSeed(
          seedColor: crimson, brightness: Brightness.light);
      expect(seeded.primary, isNot(crimson),
          reason: 'if this ever passes, Flutter changed fromSeed and the '
              'pinning above may no longer be necessary');
    });

    test(
        'WidgetTheme.light and .dark pin the brightness regardless of the platform',
        () {
      expect(
          chatThemeData(_config(theme: WidgetTheme.light), Brightness.dark)
              .brightness,
          Brightness.light);
      expect(
          chatThemeData(_config(theme: WidgetTheme.dark), Brightness.light)
              .brightness,
          Brightness.dark);
    });

    test('WidgetTheme.auto and an absent theme both follow the platform', () {
      expect(
          chatThemeData(_config(theme: WidgetTheme.auto), Brightness.dark)
              .brightness,
          Brightness.dark);
      expect(chatThemeData(_config(), Brightness.dark).brightness,
          Brightness.dark);
      expect(chatThemeData(_config(), Brightness.light).brightness,
          Brightness.light);
    });

    test('a published fontFamily reaches the text theme', () {
      // ThemeData has no `fontFamily` getter of its own — the constructor
      // parameter is sugar that applies onto textTheme (confirmed against
      // https://api.flutter.dev/flutter/material/ThemeData/ThemeData.html),
      // so that is where a published font actually shows up.
      expect(
        chatThemeData(_config(fontFamily: 'Inter'), Brightness.light)
            .textTheme
            .bodyMedium
            ?.fontFamily,
        'Inter',
      );
    });

    test('an unset fontFamily leaves Material 3\'s own default (Roboto) alone',
        () {
      // Not null: passing fontFamily: null to ThemeData() does not blank the
      // font, it leaves Material 3's own default text theme untouched. An
      // absent RemoteConfig.fontFamily should mean exactly that — "no
      // opinion" — not "no font at all".
      expect(
          chatThemeData(_config(), Brightness.light)
              .textTheme
              .bodyMedium
              ?.fontFamily,
          'Roboto');
    });
  });

  group('chatCornerRadius', () {
    test('defaults to 12 when unset', () {
      expect(chatCornerRadius(_config()), 12);
    });

    test('passes a sane published value through', () {
      expect(chatCornerRadius(_config(cornerRadius: 20)), 20);
    });

    test('clamps a negative value to 0', () {
      expect(chatCornerRadius(_config(cornerRadius: -5)), 0);
    });

    test('clamps an absurd value to 32', () {
      expect(chatCornerRadius(_config(cornerRadius: 999)), 32);
    });
  });
}
