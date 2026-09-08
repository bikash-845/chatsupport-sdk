/// The one behaviour of this example worth pinning: an unset `--dart-define`
/// produces a page, not a crash and not a silent hang.
///
/// Everything else here is wiring, and wiring is checked by the compiler —
/// `seams.dart` does not build if a seam's shape drifts, and
/// `RestSessionActions` does not build if `ChatSessionActions` gains a method.
/// This file covers the one path where the failure mode is a runtime one.
///
/// ── Why the reader can be tested at all ──────────────────────────────────
///
/// `readExampleConfig` resolves `String.fromEnvironment` constants, and
/// `flutter test` runs with none of them defined. So the suite sees exactly
/// the state a person gets on a bare `flutter run`, without having to simulate
/// it.
library;

import 'package:dhaam_chat/dhaam_chat.dart'
    show InvalidPublishableKeyError, PublishableKey;
import 'package:dhaam_chat_flutter_example/example_config.dart';
import 'package:dhaam_chat_flutter_example/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('readExampleConfig with nothing defined', () {
    test('reports every missing key, not just the first', () {
      final ExampleConfig config = readExampleConfig();

      // Someone launching this for the first time has typically set none of
      // them. Reporting one key per attempt would take four runs.
      expect(config, isA<ExampleConfigIncomplete>());
      final List<String> keys = (config as ExampleConfigIncomplete)
          .problems
          .map((ConfigProblem problem) => problem.key)
          .toList();

      expect(
        keys,
        containsAll(<String>[
          kWsUrlKey,
          kApiUrlKey,
          kPublishableKeyKey,
          kAccessTokenKey,
        ]),
      );
    });

    test('never puts an offending value in a problem detail', () {
      final ExampleConfigIncomplete config =
          readExampleConfig() as ExampleConfigIncomplete;

      // The rule `keys.dart` makes absolute for credentials, applied to every
      // field so there is no judgement call at the one moment it matters. With
      // nothing defined the values are all empty, so this asserts the shape
      // rather than a specific leak: a detail is a sentence about a category.
      for (final ConfigProblem problem in config.problems) {
        expect(problem.detail, isNotEmpty);
        expect(problem.detail, isNot(contains('=')));
      }
    });
  });

  testWidgets('an unconfigured launch renders the setup page', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(ExampleApp(config: readExampleConfig()));

    expect(find.text('Setup required'), findsOneWidget);

    // The keys themselves are on screen, so the fix is readable off the page
    // rather than out of a README somebody has to go and find.
    expect(find.textContaining(kWsUrlKey), findsWidgets);
    expect(find.textContaining(kApiUrlKey), findsWidgets);
    expect(find.textContaining(kPublishableKeyKey), findsWidgets);
    expect(find.textContaining(kAccessTokenKey), findsWidgets);

    // No exception reached the framework. This is the assertion that would
    // have failed if the config were parsed where it is used instead of up
    // front — `PublishableKey.parse('')` throws.
    expect(tester.takeException(), isNull);
  });

  testWidgets('the setup page shows a runnable command', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      const ExampleApp(
        config: ExampleConfigIncomplete(<ConfigProblem>[
          ConfigProblem(kWsUrlKey, 'not set.'),
        ]),
      ),
    );

    expect(find.textContaining('flutter run'), findsOneWidget);
    expect(find.textContaining('--dart-define=$kWsUrlKey'), findsOneWidget);
  });

  /// The launch command is copied verbatim. Its placeholder has to be a
  /// prefix the SDK actually accepts.
  ///
  /// It was `pk_test_…`, which `PublishableKey.parse` refuses — so the one
  /// person most likely to copy this line, somebody running the SDK for the
  /// first time, was sent to look for a key that does not exist, and the
  /// refusal they then got named a third string. The two assertions here are
  /// the placeholder and the reason it had to change; the second is what
  /// stops the old spelling being restored as a harmless-looking tidy-up.
  testWidgets('the launch command names a prefix the SDK will accept', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      const ExampleApp(
        config: ExampleConfigIncomplete(<ConfigProblem>[
          ConfigProblem(kPublishableKeyKey, 'not set.'),
        ]),
      ),
    );

    expect(
      find.textContaining('--dart-define=$kPublishableKeyKey=dhp_test_'),
      findsOneWidget,
    );

    // Why that spelling and not the previous one.
    expect(PublishableKey.parse('dhp_test_yourkey'), isA<PublishableKey>());
    expect(
      () => PublishableKey.parse('pk_test_yourkey'),
      throwsA(isA<InvalidPublishableKeyError>()),
    );
  });

  test('the missing-key problem names the prefixes the parser accepts', () {
    final ExampleConfigIncomplete config =
        readExampleConfig() as ExampleConfigIncomplete;
    final ConfigProblem problem = config.problems
        .firstWhere((ConfigProblem p) => p.key == kPublishableKeyKey);

    // Same rule as the launch command: the sentence a person reads and the
    // string the parser wants must be one fact, not two.
    expect(problem.detail, contains('dhp_live_'));
    expect(problem.detail, contains('dhp_test_'));
  });
}
