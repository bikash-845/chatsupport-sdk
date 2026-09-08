/// The two visitors this example can be, and the one difference between them.
///
/// ── The reported bug this file exists to answer ──────────────────────────
///
/// "The pre-chat form shows for logged-in users." It did, and the cause was
/// not in the package: `ChatWidgetCubit` takes `ChatIdentity identity =
/// ChatIdentity.guest`, this app never passed one, so every visitor was a
/// guest and every visitor got the form. There was no logged-in path to be
/// broken — there was no logged-in path at all.
///
/// So the fix is not a condition anywhere; it is an argument. What this file
/// adds is the ability to supply the OTHER value, and the host screen's
/// switch is the thing that supplies it.
///
/// ── Why both visitors carry a user id ────────────────────────────────────
///
/// This is the part worth reading, and it is the reason this is a file rather
/// than two literals inlined at a call site.
///
/// `chat_identity.dart` states the discriminator once: a guest is a visitor
/// whose `profile` is ABSENT. It is emphatically NOT "a visitor with no user
/// id" — chat-service mints an id for every visitor the moment the socket
/// acks, so `userId == null` is false for everybody and a gate built on it
/// never fires for anybody.
///
/// A demo where the guest had no id and the customer had one would let a
/// reader walk away believing the id is what matters. It is the single most
/// available wrong answer here, and it is wrong in the direction that looks
/// right. So [kExampleUserId] is the SAME on both sides of the switch: the
/// only thing that changes across it is [ChatParticipantProfile], which is
/// the only thing that decides.
///
/// The reference agrees, from the other end. `packages/widget/src/config.ts`
/// makes `identity.userId` REQUIRED for everyone (`resolveConfig` calls
/// `requireString(config.identity?.userId, 'identity.userId')`), and says of
/// the profile beside it: "Supplying it — and only supplying it — is what
/// makes the widget upsert that user as a Contact via `POST /identify`.
/// `userId` alone does not and must not, because every guest has one of those
/// too."
library;

import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show ChatIdentity, ChatParticipantProfile;

/// Which visitor the host screen's switch has selected.
///
/// An enum rather than a `bool isSignedIn`, because the two values are named
/// on screen and in [exampleIdentity]'s switch — and because a bare boolean
/// at a call site is exactly the shape that invites somebody to re-derive
/// "is this a guest" from something other than the profile.
enum ExampleVisitor {
  /// Nobody has vouched for this visitor. Carries a [kExampleUserId] anyway;
  /// see this library's header for why that is the point and not an oversight.
  guest,

  /// The host has authenticated somebody and describes them.
  identified,
}

/// The id chat-service would have minted for this visitor.
///
/// Shared by BOTH visitors deliberately. See this library's header.
///
/// It reaches `ChatWidgetState.localParticipantId` — the port of
/// `widget.ts:524` — which is how the transcript knows which messages are the
/// customer's own. That is a job every visitor needs done, guest or not,
/// which is the same fact stated from the rendering side.
const String kExampleUserId = 'example-visitor-7f3a';

/// What a host that has authenticated somebody hands over.
///
/// Every field of [ChatParticipantProfile] is optional, and its own doc is
/// clear that presence of the PROFILE is what matters rather than presence of
/// anything inside it — a host that knows only that somebody is logged in
/// passes `ChatParticipantProfile()` and that visitor is correctly not a
/// guest. This one is populated because a populated profile is what makes the
/// on-screen difference legible: these are the answers the pre-chat form
/// would otherwise be asking this customer to type back.
const ChatParticipantProfile kExampleProfile = ChatParticipantProfile(
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  attributes: <String, String>{'plan': 'pro'},
);

/// The identity to hand `ChatWidgetCubit(identity:)` for [visitor].
///
/// Pure, and the whole of what the switch does — which is what lets the
/// reported behaviour be pinned in a test with no widget tree and no socket.
ChatIdentity exampleIdentity(ExampleVisitor visitor) => switch (visitor) {
      // NOT `ChatIdentity.guest`, which carries no id. This is the same
      // visitor as the line below with the profile taken away, so the switch
      // on screen changes exactly one thing.
      ExampleVisitor.guest => const ChatIdentity(userId: kExampleUserId),
      ExampleVisitor.identified => const ChatIdentity(
          userId: kExampleUserId,
          profile: kExampleProfile,
        ),
    };

/// What the host screen says this switch will do, in one sentence per side.
///
/// Kept next to [exampleIdentity] rather than in `main.dart` so the sentence
/// and the value it describes cannot drift apart.
String exampleVisitorExplanation(ExampleVisitor visitor) => switch (visitor) {
      ExampleVisitor.guest =>
        'profile: absent → isGuest. The merchant’s pre-chat questions are '
            'asked, because nobody has supplied the answers.',
      ExampleVisitor.identified =>
        'profile: supplied → not a guest. The pre-chat questions are skipped '
            '— asking would be asking a signed-in customer to type their own '
            'email back.',
    };
