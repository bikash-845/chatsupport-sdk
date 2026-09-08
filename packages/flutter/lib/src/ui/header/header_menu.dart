/// The conversation header's ⋯ menu.
///
/// Ported from `packages/widget/src/ui/header-menu.ts`.
///
/// ── Every item here does something ───────────────────────────────────────
///
/// The reference design shows five, and all five are backed by something real
/// before they were built. That check is the point of this comment, because
/// the alternative — a menu item that looks like a feature and does nothing —
/// is a promise the product breaks in front of the customer, and it is the
/// trap this codebase has already documented twice (the emailed transcript
/// before its route existed; edit/delete, which have no protocol frame and
/// were therefore left out of the per-message menu).
///
///   Mute / Unmute notifications → silences the local chime (`chime.dart`),
///                         or gives it back. Per DEVICE, not per tenant: it
///                         is this visitor's preference about noise on their
///                         own machine. The label states the ACTION and
///                         therefore flips — see [muteLabel]. HIDDEN when the
///                         merchant published no chime, for the same reason
///                         Privacy is hidden without a URL — see [sound] on
///                         [headerMenuEntries].
///   Start new conversation → the new-conversation flow.
///   End conversation    → `POST /chat/sessions/:id/close`, customer-owned.
///   Report an issue     → `report_issue_form.dart`, filing a real ticket.
///   Privacy             → `RemoteConfig.privacyUrl`. HIDDEN when the
///                         merchant has not published one, rather than
///                         linking nowhere.
///
/// ── Hidden, never disabled ───────────────────────────────────────────────
///
/// An unbacked item is absent from [headerMenuEntries] entirely. A disabled
/// row still occupies the menu and still reads as a feature the customer is
/// somehow not allowed to use, which invites them to go looking for the
/// permission they are missing. There is no permission; the thing simply is
/// not offered here.
///
/// ── What did NOT port from `header-menu.test.ts` ─────────────────────────
///
/// That file's `outside-dismiss vs shadow retargeting` block — four of its
/// seven cases — is about a bug with no Flutter analogue. There, the menu's
/// dismiss listener lives on the `document`, outside the shadow tree, so a
/// press on the menu's own item is RETARGETED to the shadow host, looks
/// "outside", and closes the menu between pointerdown and pointerup —
/// swallowing the click. Flutter's menus are routes with their own modal
/// barrier: there is no shadow boundary, no retargeting, and the framework
/// owns the barrier press. Those cases are in the same category the parity
/// plan already names for `focus.test.ts` and `presentation.test.ts` — DOM
/// idioms that do not transfer. The dismissal BEHAVIOUR is still asserted in
/// `header_menu_test.dart`, through the framework rather than around it.
library;

import 'package:dhaam_chat/dhaam_chat.dart' show safeLinkUrl;
import 'package:equatable/equatable.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// What pressing one of the menu's rows means.
///
/// A closed enum rather than five callbacks threaded through
/// [headerMenuEntries], so the "which items are offered" question can be
/// answered — and tested — without a widget tree, a route, or a tap.
enum HeaderMenuAction {
  /// Toggle this device's chime. See [muteLabel].
  mute,
  startNew,
  endConversation,
  reportIssue,

  /// Opens [HeaderMenuEntry.href] in the platform browser.
  privacy,
}

/// The label for the mute row, given the current state.
///
/// ── Why the label flips, and why that ruled out a checkbox ───────────────
///
/// The label states the ACTION: "Mute notifications" while sound is on,
/// "Unmute notifications" once it is off. The reference pinned it to "Mute
/// notifications" forever with only the bell glyph changing, which left the
/// one word that says what pressing it does permanently lying.
///
/// A flipping action label cannot coexist with checkbox semantics. Once
/// muted, `role="menuitemcheckbox"` + `aria-checked` announces "Unmute
/// notifications, checked" — which asserts the OPPOSITE of what the control
/// will do. The escape (keep the checkbox, pin a stable accessible name) is
/// worse: the accessible name would no longer contain the visible label,
/// which is a WCAG 2.5.3 (Label in Name) failure, and it leaves a
/// voice-control user saying "unmute notifications" at a control the platform
/// knows only as "mute notifications".
///
/// In Flutter that means: no `Semantics(checked:)`, no [CheckboxListTile], no
/// [Semantics] label override anywhere on this row. The visible [Text] IS the
/// accessible name, and it is this string. Its state stays legible from the
/// label itself and from the struck-through bell beside it.
///
/// https://www.w3.org/WAI/WCAG21/Understanding/label-in-name.html
String muteLabel({required bool muted}) =>
    muted ? 'Unmute notifications' : 'Mute notifications';

/// One row the menu is actually offering.
@immutable
class HeaderMenuEntry extends Equatable {
  const HeaderMenuEntry({
    required this.action,
    required this.label,
    required this.icon,
    this.isDestructive = false,
    this.href,
  });

  final HeaderMenuAction action;

  /// The visible label AND the accessible name. One string, never two — see
  /// [muteLabel].
  final String label;

  final IconData icon;

  /// Whether this row ends something the customer cannot undo from this side.
  ///
  /// True for exactly one row. chat-service reopens a session on the agent's
  /// say-so, not the customer's, so a mis-tap ends the conversation they were
  /// in the middle of. It is coloured as such and it asks once — inside the
  /// widget, in the surface slot every other form uses, never through a
  /// platform confirm dialog.
  final bool isDestructive;

  /// Where [HeaderMenuAction.privacy] goes. Non-null only for that row, and
  /// only for a string [safeLinkUrl] has already accepted.
  ///
  /// Kept as the validated STRING rather than a parsed [Uri]: the row exists
  /// if and only if `safeLinkUrl` accepted it, and a `Uri.tryParse` here
  /// would be a second gate that could silently drop a row the first gate
  /// passed. The parse happens at the launch, in [openPrivacyUrl], which is
  /// the only code that needs a `Uri` at all.
  final String? href;

  @override
  List<Object?> get props =>
      <Object?>[action, label, icon, isDestructive, href];
}

/// The rows this menu offers right now, in the reference's order.
///
/// A pure function: the whole visibility rule in one place, decided from five
/// facts, with no widget and no `BuildContext`. Every "is this item backed"
/// question is answered here and nowhere else, which is what stops the menu
/// and the screen behind it from disagreeing about whether a feature exists.
///
/// [canEnd] — whether there is a live conversation to end. "End conversation"
/// on an already-closed one would do nothing and look broken.
///
/// [privacyUrl] — the merchant's published policy, raw. Run through
/// [safeLinkUrl] here rather than at the parse (see `RemoteConfig.privacyUrl`)
/// because this is the code that is about to navigate: merchant-supplied and
/// landing in a link, so `javascript:` has to be unreachable rather than
/// unlikely.
///
/// [reportIssue] — whether the merchant offers the report form at all.
///
/// [sound] — `RemoteConfig.sound`, the merchant's decision that a chime
/// exists at all. The mute row is the ONE thing this menu offers that only
/// has an effect through [Chime], and `chime.dart` refuses on `!sound` alone
/// — before it ever looks at [muted]. So on a tenant that published no chime
/// (and `sound` DEFAULTS to false, deliberately: an unreadable config is not
/// consent to make noise), muting and unmuting were both no-ops, and the row
/// was the only unbacked item in a menu whose whole rule is that there are
/// none. It reads as a feature, the customer presses it, the label flips, and
/// nothing about their device changes — which is the "promise the product
/// breaks in front of the customer" this module's header names, arrived at
/// from the other direction.
///
/// This is the merchant's half and it is the half this package can know.
/// Whether the DEVICE can make the sound is a separate question that no
/// caller here can answer: the default [ChimePlayer] is [SystemSound], which
/// Flutter documents as ignored on Android, iOS and web, so a host on those
/// platforms has to supply its own player. Hiding the row on that basis would
/// mean second-guessing a player a host may well have wired — so the gate is
/// the one fact that is actually published.
///
/// Required, with no default, and deliberately: this and [HeaderMenu.sound]
/// are a breaking change for any caller outside this repo, and that is the
/// intended signal. A `sound = true` default would read as "assume the
/// merchant published a chime", which is the exact assumption
/// `RemoteConfig.sound`'s own false default exists to refuse — so the caller
/// that forgot to update would silently get the unbacked row back. Every
/// other gate on this function ([canEnd], [privacyUrl], [reportIssue]) is
/// required for the same reason.
List<HeaderMenuEntry> headerMenuEntries({
  required bool canEnd,
  required String? privacyUrl,
  required bool reportIssue,
  required bool muted,
  required bool sound,
}) {
  // `safeLinkUrl` takes a nullable string and answers both questions at once
  // — "did the merchant publish one" and "may it become a link" — which is
  // exactly why its own doc says a caller holding an optional config field
  // should gate on the result rather than null-check twice.
  final String? privacyHref = safeLinkUrl(privacyUrl);

  return <HeaderMenuEntry>[
    if (sound)
      HeaderMenuEntry(
        action: HeaderMenuAction.mute,
        label: muteLabel(muted: muted),
        // Struck through once muted, matching the reference's own glyph swap
        // — a second, redundant reading of a state the label already states.
        icon: muted
            ? Icons.notifications_off_outlined
            : Icons.notifications_outlined,
      ),
    const HeaderMenuEntry(
      action: HeaderMenuAction.startNew,
      label: 'Start new conversation',
      icon: Icons.edit_outlined,
    ),
    if (canEnd)
      const HeaderMenuEntry(
        action: HeaderMenuAction.endConversation,
        label: 'End conversation',
        icon: Icons.cancel_outlined,
        isDestructive: true,
      ),
    if (reportIssue)
      const HeaderMenuEntry(
        action: HeaderMenuAction.reportIssue,
        label: 'Report an issue',
        icon: Icons.flag_outlined,
      ),
    if (privacyHref != null)
      HeaderMenuEntry(
        action: HeaderMenuAction.privacy,
        label: 'Privacy',
        icon: Icons.shield_outlined,
        href: privacyHref,
      ),
  ];
}

/// Opens the merchant's policy page in the platform browser.
///
/// The one place in this module that touches the platform, and the default
/// for [HeaderMenu.onOpenPrivacy]. [href] must already have come from
/// [headerMenuEntries] — this does not re-validate, because there is one
/// allowlist and it ran at the point the row was offered.
///
/// `externalApplication` rather than the default: this is the merchant's own
/// site, not the widget's, and a policy opened inside an in-app web view has
/// no address bar to prove whose page the customer is reading.
/// https://pub.dev/documentation/url_launcher/latest/url_launcher/launchUrl.html
Future<void> openPrivacyUrl(String href) async {
  final Uri? uri = Uri.tryParse(href);
  if (uri == null) return;
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}

/// The header's ⋯ button and the menu behind it.
///
/// ── Why props rather than the reference's `update()` ─────────────────────
///
/// `createHeaderMenu` returns a view with an imperative `update({canEnd,
/// privacyUrl, reportIssue, muted})`, and it keeps its OWN copy of `muted` so
/// a click can flip the label before the host has heard about it. That second
/// copy is exactly why `header-menu.test.ts` needs a dedicated case for "an
/// `update()` that arrives already muted" — the persisted-preference path,
/// which the view had to be able to repaint from.
///
/// Here [muted] is a prop and nothing else. The owner ([ChatWidgetState])
/// holds the one copy, [onMuteChange] asks it to flip, and the rebuild paints
/// the new label. The already-muted case is then not a special path at all,
/// which is the stronger version of passing that test rather than a way
/// around it.
class HeaderMenu extends StatelessWidget {
  const HeaderMenu({
    super.key,
    required this.canEnd,
    required this.privacyUrl,
    required this.reportIssue,
    required this.muted,
    required this.sound,
    required this.onStartNew,
    required this.onEndConversation,
    required this.onReportIssue,
    required this.onMuteChange,
    required this.onOpenPrivacy,
  });

  final bool canEnd;
  final String? privacyUrl;
  final bool reportIssue;
  final bool muted;

  /// `RemoteConfig.sound`. Decides whether the mute row exists at all — see
  /// [headerMenuEntries].
  final bool sound;

  final VoidCallback onStartNew;
  final VoidCallback onEndConversation;
  final VoidCallback onReportIssue;

  /// Receives the NEW muted state, matching the reference's `onMuteChange`.
  final ValueChanged<bool> onMuteChange;

  /// Opens the merchant's policy.
  ///
  /// A callback rather than a `launchUrl` call inlined here, for the reason
  /// `attachments.dart` states about pickers: a platform launch cannot be
  /// faked after the fact, so a widget that performs one directly is a widget
  /// whose tests cannot run in CI. [openPrivacyUrl] is the real
  /// implementation and the only place in this module that touches the
  /// platform.
  final ValueChanged<String> onOpenPrivacy;

  @override
  Widget build(BuildContext context) {
    final List<HeaderMenuEntry> entries = headerMenuEntries(
      canEnd: canEnd,
      privacyUrl: privacyUrl,
      reportIssue: reportIssue,
      muted: muted,
      sound: sound,
    );
    final ColorScheme colors = Theme.of(context).colorScheme;

    return PopupMenuButton<HeaderMenuAction>(
      icon: const Icon(Icons.more_horiz),
      // The same name the reference gives its toggle. `PopupMenuButton` has
      // no `semanticLabel` of its own in this SDK (checked, not assumed) —
      // it forwards `tooltip` to the `IconButton` it builds, which is what
      // becomes the control's accessible name. Left unset it would fall back
      // to MaterialLocalizations' generic "Show menu".
      tooltip: 'Conversation options',
      onSelected: (HeaderMenuAction action) => _select(action, entries),
      itemBuilder: (BuildContext context) => <PopupMenuEntry<HeaderMenuAction>>[
        for (final HeaderMenuEntry entry in entries)
          PopupMenuItem<HeaderMenuAction>(
            value: entry.action,
            child: Row(
              children: <Widget>[
                Icon(
                  entry.icon,
                  size: 18,
                  color: entry.isDestructive ? colors.error : null,
                ),
                const SizedBox(width: 12),
                // Expanded, and deliberately NOT `TextOverflow.ellipsis`: a
                // truncated label is a label the accessible name no longer
                // matches, which is the WCAG 2.5.3 failure this row is built
                // to avoid. Wrapping is the only way a long row (or a large
                // system text scale) may resolve here.
                //
                // No `Semantics` wrapper and no `semanticsLabel` on this
                // Text. The accessible name is the visible string, which is
                // the whole point of `muteLabel` — see its doc.
                Expanded(
                  child: Text(
                    entry.label,
                    style: entry.isDestructive
                        ? TextStyle(color: colors.error)
                        : null,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  void _select(HeaderMenuAction action, List<HeaderMenuEntry> entries) {
    switch (action) {
      case HeaderMenuAction.mute:
        onMuteChange(!muted);
      case HeaderMenuAction.startNew:
        onStartNew();
      case HeaderMenuAction.endConversation:
        onEndConversation();
      case HeaderMenuAction.reportIssue:
        onReportIssue();
      case HeaderMenuAction.privacy:
        // Read back off the entry rather than re-validating `privacyUrl`
        // here: the row only exists because `safeLinkUrl` already accepted
        // it, and a second validation is a second place for the two answers
        // to differ.
        final String? href =
            entries.firstWhere((HeaderMenuEntry e) => e.action == action).href;
        if (href != null) onOpenPrivacy(href);
    }
  }
}
