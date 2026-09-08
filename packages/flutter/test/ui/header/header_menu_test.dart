import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

/// Reproduces `packages/widget/test/header-menu.test.ts` and the
/// `the conversation menu` block of `remote-config-gating.test.ts`.
///
/// Four of `header-menu.test.ts`'s seven cases are its `outside-dismiss vs
/// shadow retargeting` block, which does not transfer — see `header_menu.dart`
/// for why (no shadow boundary, so nothing to retarget). The dismissal
/// behaviour those cases were protecting is asserted below through the
/// framework's own modal barrier instead of around it.
void main() {
  Future<void> mount(
    WidgetTester tester, {
    bool canEnd = true,
    String? privacyUrl,
    bool reportIssue = true,
    bool muted = false,
    bool sound = true,
    ValueChanged<bool>? onMuteChange,
    VoidCallback? onStartNew,
    VoidCallback? onEndConversation,
    VoidCallback? onReportIssue,
    ValueChanged<String>? onOpenPrivacy,
  }) {
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          appBar: AppBar(
            actions: <Widget>[
              HeaderMenu(
                canEnd: canEnd,
                privacyUrl: privacyUrl,
                reportIssue: reportIssue,
                muted: muted,
                sound: sound,
                onStartNew: onStartNew ?? () {},
                onEndConversation: onEndConversation ?? () {},
                onReportIssue: onReportIssue ?? () {},
                onMuteChange: onMuteChange ?? (_) {},
                onOpenPrivacy: onOpenPrivacy ?? (_) {},
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(find.byIcon(Icons.more_horiz));
    await tester.pumpAndSettle();
  }

  /// Every row label currently on screen, in order — the Dart counterpart of
  /// the TS helper that maps `.dh-hmenu-item` textContent, filtering hidden.
  /// Nothing is filtered here, because an unbacked row is never built.
  List<String> labels(WidgetTester tester) => tester
      .widgetList<PopupMenuItem<HeaderMenuAction>>(
        find.byType(PopupMenuItem<HeaderMenuAction>),
      )
      .map(
        (PopupMenuItem<HeaderMenuAction> item) =>
            (((item.child! as Row).children.last as Expanded).child as Text)
                .data!,
      )
      .toList();

  // ── The mute item states what pressing it will do ─────────────────────
  //
  // It used to read "Mute notifications" in both states — only the bell glyph
  // changed — so a customer who had muted the chime was offered "Mute
  // notifications" again and could not tell what pressing it would do.
  group('the mute item states what pressing it will do', () {
    test('the label is derived from the state, never toggled blindly', () {
      // The pure half, with no widget at all: two states, two strings, and a
      // function that cannot drift out of step with itself.
      expect(muteLabel(muted: false), 'Mute notifications');
      expect(muteLabel(muted: true), 'Unmute notifications');
    });

    testWidgets(
      'reads "Mute notifications" while sound is on and "Unmute '
      'notifications" once muted',
      (WidgetTester tester) async {
        bool muted = false;
        await tester.pumpWidget(
          MaterialApp(
            home: StatefulBuilder(
              builder: (BuildContext context, StateSetter setState) => Scaffold(
                appBar: AppBar(
                  actions: <Widget>[
                    HeaderMenu(
                      canEnd: true,
                      privacyUrl: null,
                      reportIssue: true,
                      muted: muted,
                      sound: true,
                      onStartNew: () {},
                      onEndConversation: () {},
                      onReportIssue: () {},
                      onMuteChange: (bool next) => setState(() => muted = next),
                      onOpenPrivacy: (_) {},
                    ),
                  ],
                ),
              ),
            ),
          ),
        );

        await openMenu(tester);
        expect(find.text('Mute notifications'), findsOneWidget);

        await tester.tap(find.text('Mute notifications'));
        await tester.pumpAndSettle();

        await openMenu(tester);
        expect(find.text('Unmute notifications'), findsOneWidget);
        expect(find.text('Mute notifications'), findsNothing);

        // And back — the label follows the state in both directions.
        await tester.tap(find.text('Unmute notifications'));
        await tester.pumpAndSettle();
        await openMenu(tester);
        expect(find.text('Mute notifications'), findsOneWidget);
      },
    );

    testWidgets(
        'paints the muted label from a build that arrives already '
        'muted', (WidgetTester tester) async {
      // The persisted-preference path: a stored mute flag pushed straight in,
      // which must paint the same label a tap would have. Here it is not a
      // special path at all — `muted` is a prop, so there is no second copy
      // that could be out of date.
      await mount(tester, muted: true);
      await openMenu(tester);
      expect(find.text('Unmute notifications'), findsOneWidget);
    });

    testWidgets('reports the NEW muted state, not the old one',
        (WidgetTester tester) async {
      final List<bool> reported = <bool>[];
      await mount(tester, muted: false, onMuteChange: reported.add);
      await openMenu(tester);
      await tester.tap(find.text('Mute notifications'));
      await tester.pumpAndSettle();
      expect(reported, <bool>[true]);
    });

    testWidgets('reports false when a muted visitor asks for sound back',
        (WidgetTester tester) async {
      final List<bool> reported = <bool>[];
      await mount(tester, muted: true, onMuteChange: reported.add);
      await openMenu(tester);
      await tester.tap(find.text('Unmute notifications'));
      await tester.pumpAndSettle();
      expect(reported, <bool>[false]);
    });

    testWidgets(
      'is a plain menu item with no contradictory checked state',
      (WidgetTester tester) async {
        // The a11y contract that replaced `menuitemcheckbox`/`aria-checked`.
        // A checkbox announcing "Unmute notifications, checked" would state
        // the opposite of what the control does; pinning a stable accessible
        // name instead is a WCAG 2.5.3 (Label in Name) failure.
        // Disposed inside the body rather than through `addTearDown`: the
        // framework's end-of-test verification runs BEFORE tear-downs and
        // fails on a live handle.
        final SemanticsHandle handle = tester.ensureSemantics();

        await mount(tester, muted: false);
        await openMenu(tester);

        SemanticsNode row(String label) =>
            tester.getSemantics(find.text(label));

        final SemanticsData unmutedRow =
            row('Mute notifications').getSemanticsData();
        expect(unmutedRow.hasFlag(SemanticsFlag.hasCheckedState), isFalse);
        expect(unmutedRow.hasFlag(SemanticsFlag.isChecked), isFalse);
        expect(unmutedRow.hasFlag(SemanticsFlag.isButton), isTrue);
        // The accessible name IS the visible label — nothing overrides it.
        expect(unmutedRow.label, 'Mute notifications');

        // Selecting a row pops the menu route, so the tree is clean before
        // the muted build is mounted over it.
        await tester.tap(find.text('Mute notifications'));
        await tester.pumpAndSettle();

        await mount(tester, muted: true);
        await openMenu(tester);

        final SemanticsData mutedRow =
            row('Unmute notifications').getSemanticsData();
        expect(mutedRow.hasFlag(SemanticsFlag.hasCheckedState), isFalse);
        expect(mutedRow.hasFlag(SemanticsFlag.isChecked), isFalse);
        expect(mutedRow.label, 'Unmute notifications');

        handle.dispose();
      },
    );
  });

  // ── The mute row is backed by the merchant's chime, or it is not there ──
  //
  // It used to be the one row offered unconditionally. On a tenant that
  // published no `sound` — the DEFAULT, since an unreadable config is not
  // consent to make noise — `Chime` refuses before it ever reads `muted`, so
  // pressing this row flipped a label and changed nothing anyone could hear.
  // That is what "mute notification and unmute notification not working" was.
  group('mute is offered only when there is a chime to silence', () {
    test('the pure function drops it with no published sound', () {
      expect(
        headerMenuEntries(
          canEnd: true,
          privacyUrl: null,
          reportIssue: true,
          muted: false,
          sound: false,
        ).map((HeaderMenuEntry e) => e.label),
        <String>[
          'Start new conversation',
          'End conversation',
          'Report an issue'
        ],
      );
    });

    testWidgets('and so does the menu', (WidgetTester tester) async {
      await mount(tester, sound: false);
      await openMenu(tester);
      expect(labels(tester), isNot(contains('Mute notifications')));
    });

    testWidgets('including for a visitor who had already muted it',
        (WidgetTester tester) async {
      // A remembered `muted: true` must not resurrect a row the merchant does
      // not back — the state is about a chime that no longer exists.
      await mount(tester, sound: false, muted: true);
      await openMenu(tester);
      expect(labels(tester), isNot(contains('Unmute notifications')));
    });

    testWidgets('present the moment the merchant publishes one',
        (WidgetTester tester) async {
      await mount(tester, sound: true);
      await openMenu(tester);
      expect(labels(tester), contains('Mute notifications'));
    });
  });

  // ── Nothing in this menu is decorative ────────────────────────────────
  group('offers only what is actually backed', () {
    test('the entry list is decided by a pure function, off any widget tree',
        () {
      expect(
        headerMenuEntries(
          canEnd: false,
          privacyUrl: null,
          reportIssue: false,
          muted: false,
          sound: true,
        ).map((HeaderMenuEntry e) => e.label),
        <String>['Mute notifications', 'Start new conversation'],
      );
    });

    testWidgets('drops End conversation when there is nothing live to end',
        (WidgetTester tester) async {
      await mount(tester, canEnd: false, reportIssue: false);
      await openMenu(tester);
      expect(labels(tester),
          <String>['Mute notifications', 'Start new conversation']);
      expect(find.text('End conversation'), findsNothing);
    });

    testWidgets('offers End conversation on a live conversation',
        (WidgetTester tester) async {
      await mount(tester, canEnd: true, reportIssue: false);
      await openMenu(tester);
      expect(labels(tester), contains('End conversation'));
    });

    testWidgets('offers nothing until the merchant turns Report on',
        (WidgetTester tester) async {
      await mount(tester, reportIssue: false);
      await openMenu(tester);
      expect(labels(tester), isNot(contains('Report an issue')));
    });

    testWidgets('adds Report an issue when the merchant offers it',
        (WidgetTester tester) async {
      await mount(tester, reportIssue: true);
      await openMenu(tester);
      expect(labels(tester), contains('Report an issue'));
    });

    testWidgets('hidden, never disabled — an unbacked row is not built at all',
        (WidgetTester tester) async {
      // The distinction the reference is explicit about: a disabled row still
      // reads as a feature the customer is not allowed to use, and there is
      // no permission to go looking for.
      await mount(tester, canEnd: false, reportIssue: false);
      await openMenu(tester);
      for (final PopupMenuItem<HeaderMenuAction> item
          in tester.widgetList<PopupMenuItem<HeaderMenuAction>>(
        find.byType(PopupMenuItem<HeaderMenuAction>),
      )) {
        expect(item.enabled, isTrue);
      }
    });
  });

  group('Privacy links the merchant policy, or is absent', () {
    testWidgets('hides Privacy until the merchant sets a URL',
        (WidgetTester tester) async {
      await mount(tester, privacyUrl: null);
      await openMenu(tester);
      expect(labels(tester), isNot(contains('Privacy')));
    });

    testWidgets('hides Privacy for a blank URL', (WidgetTester tester) async {
      await mount(tester, privacyUrl: '   ');
      await openMenu(tester);
      expect(labels(tester), isNot(contains('Privacy')));
    });

    testWidgets("links Privacy to the merchant's own policy",
        (WidgetTester tester) async {
      final List<String> opened = <String>[];
      await mount(
        tester,
        privacyUrl: 'https://acme.test/privacy',
        onOpenPrivacy: opened.add,
      );
      await openMenu(tester);
      expect(labels(tester), contains('Privacy'));

      await tester.tap(find.text('Privacy'));
      await tester.pumpAndSettle();
      expect(opened, <String>['https://acme.test/privacy']);
    });

    testWidgets('refuses a javascript: privacy URL rather than linking it',
        (WidgetTester tester) async {
      // Merchant-supplied and about to become a navigation, so the allowlist
      // has to apply — and it applies HERE, at the link, not at the parse.
      await mount(tester, privacyUrl: 'javascript:alert(1)');
      await openMenu(tester);
      expect(labels(tester), isNot(contains('Privacy')));
    });

    test('the offered href is exactly what safeLinkUrl accepted', () {
      final HeaderMenuEntry privacy = headerMenuEntries(
        canEnd: false,
        privacyUrl: '  https://acme.test/privacy  ',
        reportIssue: false,
        muted: false,
        sound: true,
      ).last;
      expect(privacy.action, HeaderMenuAction.privacy);
      // Trimmed by the validator, not by this module — one answer, one place.
      expect(privacy.href, 'https://acme.test/privacy');
    });
  });

  group('the rest of the rows reach their callbacks', () {
    testWidgets('Start new conversation', (WidgetTester tester) async {
      int calls = 0;
      await mount(tester, onStartNew: () => calls += 1);
      await openMenu(tester);
      await tester.tap(find.text('Start new conversation'));
      await tester.pumpAndSettle();
      expect(calls, 1);
    });

    testWidgets('End conversation', (WidgetTester tester) async {
      int calls = 0;
      await mount(tester, onEndConversation: () => calls += 1);
      await openMenu(tester);
      await tester.tap(find.text('End conversation'));
      await tester.pumpAndSettle();
      expect(calls, 1);
    });

    testWidgets('Report an issue', (WidgetTester tester) async {
      int calls = 0;
      await mount(tester, onReportIssue: () => calls += 1);
      await openMenu(tester);
      await tester.tap(find.text('Report an issue'));
      await tester.pumpAndSettle();
      expect(calls, 1);
    });
  });

  group('opening and dismissing', () {
    testWidgets('starts closed', (WidgetTester tester) async {
      await mount(tester);
      expect(find.byType(PopupMenuItem<HeaderMenuAction>), findsNothing);
    });

    testWidgets(
        'the toggle carries the reference name, not the framework '
        'default', (WidgetTester tester) async {
      await mount(tester);
      expect(
        tester
            .widget<PopupMenuButton<HeaderMenuAction>>(
              find.byType(PopupMenuButton<HeaderMenuAction>),
            )
            .tooltip,
        'Conversation options',
      );
    });

    testWidgets('a press outside closes it, and fires nothing',
        (WidgetTester tester) async {
      // The behaviour `header-menu.test.ts`'s retargeting block protects,
      // asserted through the framework's own modal barrier — there is no
      // shadow boundary here for a press to be retargeted across.
      final List<bool> muteCalls = <bool>[];
      await mount(tester, onMuteChange: muteCalls.add);
      await openMenu(tester);
      expect(find.text('Mute notifications'), findsOneWidget);

      await tester.tapAt(const Offset(20, 400));
      await tester.pumpAndSettle();

      expect(find.byType(PopupMenuItem<HeaderMenuAction>), findsNothing);
      expect(muteCalls, isEmpty);
    });

    testWidgets(
        'a press on a row still lands — it is not swallowed by the '
        'dismiss', (WidgetTester tester) async {
      final List<bool> muteCalls = <bool>[];
      await mount(tester, onMuteChange: muteCalls.add);
      await openMenu(tester);
      await tester.tap(find.text('Mute notifications'));
      await tester.pumpAndSettle();
      expect(muteCalls, <bool>[true]);
      expect(find.byType(PopupMenuItem<HeaderMenuAction>), findsNothing);
    });
  });
}
