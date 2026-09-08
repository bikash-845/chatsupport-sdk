# `dhaam_chat_flutter` example

A runnable host app for the SDK. It is the smallest complete thing that mounts
`ChatWidget` and fills the seams the package deliberately leaves injectable —
so it is also the only place the real implementations of those seams meet each
other.

The package's own suite drives every seam with a closure, on purpose: that is
what lets it run without a platform channel or a socket. The cost is that
nothing in it exercises `file_picker`, `RestClient` and the widget tree
together. This app is that check.

## Run it

```bash
flutter run \
  --dart-define=DHAAM_WS_URL=wss://chat.your-host.example \
  --dart-define=DHAAM_API_URL=https://api.your-host.example \
  --dart-define=DHAAM_PUBLISHABLE_KEY=dhp_test_… \
  --dart-define=DHAAM_ACCESS_TOKEN=…
```

Nothing is hardcoded and there are no defaults. Launch it with any of these
missing and you get a page naming the missing keys, not a stack trace and not a
socket retrying in backoff under the word "Connecting…". `DHAAM_SESSION_ID` is
optional — set it to land straight in an existing conversation.

The publishable key is `dhp_live_…` or `dhp_test_…`. It is **not** `pk_…`:
`PublishableKey.parse` refuses that shape deliberately, because a bare
`pk_test_` is Stripe's and secret scanners report such a key as a Stripe key.

See the package README for the full key table and for why the access token must
be minted by your own backend rather than taken from an identity provider.

## Guests need a token too

There is no tokenless mode. Every visitor needs a token, and a guest's token
identifies an anonymous **visitor** — a shipped app is never given the secret
key, so the token has to come from your backend either way.

What marks somebody as a known **customer** is a different input entirely:

| | `DHAAM_ACCESS_TOKEN` | `identity.profile` |
|---|---|---|
| What it is | a credential from your backend | data your app already has |
| Guest | required | omitted |
| Signed-in customer | required | supplied |
| Omit it and | you cannot connect at all | the visitor is a guest, and is asked the pre-chat questions |

`identity.userId` decides nothing. Every visitor has one, so a gate built on it
never fires for anybody — which is why `ChatIdentity.isGuest` is
`profile == null` and nothing else.

## What the host screen shows you

The screen you land on is the merchant's app; the chat panel is a route it
pushes. That split is deliberate — `ChatWidget` builds a scoped `Theme` and no
`MaterialApp`, because it is meant to be mounted inside a host rather than to
be one.

- **Visitor** — a switch between guest and signed-in customer. Flip it, then
  open the chat: the panel is built fresh each time, so both modes are
  reachable in one run. The user id is shown in both states and is the *same*
  string; only the profile moves, because only the profile decides.
- **Connection** — the endpoints and the key in use. The publishable key prints
  redacted with its environment, which is not a secret and is worth seeing: a
  live build pointed at a test tenant otherwise goes unnoticed.
- **Published config** — what `GET /widget/config` returned, including
  **Uploads enabled**, which is the merchant switch that governs the composer's
  paperclip. Shown whether or not the fetch succeeded, because that row is the
  one people come looking for when the paperclip is missing.
- **Contact info** — what `captureContactInfo` collected.
- **Seams** — every injectable seam and whether this app actually fills it.

That last panel is on screen rather than in a document because the person it
matters to is holding the running app and wondering why a control is missing.
Keeping it truthful is a maintenance obligation: a "not wired" row nobody
rechecks reads as a missing SDK feature rather than as a missing line here.

## Where each seam is filled

| Seam | File |
|---|---|
| `TokenProvider`, `GeolocationProbe`, `AttachmentPicker`/`AttachmentUploader`, `ChimePlayer` | `lib/seams.dart` |
| `ChatSessionActions` (close / reopen / CSAT) | `lib/rest_session_actions.dart` |
| The session list → `updateSessionSummaries` | `lib/session_list.dart` |
| `ChatIdentity` (guest vs. known customer) | `lib/example_identity.dart` |
| Configuration and its failure page | `lib/example_config.dart` |

The session list is the one that is not a callback the package takes. It is a
page a host goes and gets: `dhaam_chat` has no HTTP layer and cannot list
sessions at all, so `ChatWidgetCubit` cannot fill the Messages screen itself.
An empty page there is ordinary success — it is what a guest gets, and it is
never an error.

## Tests

```bash
flutter test
```

These cover what can be checked without a network: that the configuration
reader reports every missing key rather than the first, that the identity
switch changes `isGuest` and that the user id does *not* move with it, that the
attachment seam produces a draft controller (and produces none without an
uploader), and that the session refresher writes an empty page instead of
swallowing it.

Wiring that the compiler already checks is not retested here — `seams.dart`
stops compiling if a seam's shape drifts, which is the whole reason the recipes
there are written as code rather than as prose.
