# `dhaam_chat_flutter` — Flutter UI for the Dhaam chat widget

The screens, navigation and state container that turn `dhaam_chat`'s streams
into something a customer can look at. This is a **library a host app mounts**,
not an app: `ChatWidget` builds a scoped `Theme` and a `Scaffold` and no
`MaterialApp` of its own, because it is meant to live inside a route, a modal
or a pane that the host owns.

There is a runnable host app in [`example/`](example/). If you want to see this
work rather than read about it, start there — [Running the
example](#running-the-example) below.

---

## The three packages, and why the split is where it is

| Package | What it is | Depends on |
|---|---|---|
| `packages/dart` — `dhaam_chat` | The WebSocket protocol client. Pure Dart, **no HTTP dependency at all**, no Flutter. Frames, sessions, messages, resume, backoff. | `web_socket_channel` |
| `packages/dart_rest` — `dhaam_chat_rest` | The REST surface the socket deliberately does not speak: history pagination, `POST /upload`, session close/reopen, CSAT, the session picker, identify, `ip-watermark`. Pure Dart, no Flutter. | `dhaam_chat`, `http`, `http_parser` |
| `packages/flutter` — `dhaam_chat_flutter` | **This package.** Widgets, `ChatWidgetCubit`, the remote-config model, the theme layer. | `dhaam_chat`, `dhaam_chat_rest`, `flutter_bloc`, `http`, `url_launcher`, `file_picker`, `mime` |

**The dependency runs one way.** `dhaam_chat` imports nothing from
`dhaam_chat_rest`, and that is asserted by a test
(`packages/dart_rest/test/no_core_import_test.dart`) rather than left as a
convention. Its zero-HTTP boundary is the reason `dhaam_chat_rest` exists as a
separate package instead of living inside it.

This is deliberately **the opposite** of the TypeScript pair, where
`@dhaam-ccrm/rest` imports nothing from `@dhaam-ccrm/core`. That invariant
exists in TS to keep `rest` installable standalone, because `createChatClient`
accepts five independently-substitutable structural seams. Nothing in this
workspace composes a Dart `ChatClient` and a REST layer behind such a function,
so enforcing it here would protect nothing while costing two incompatible
`TokenProvider` types, a duplicated `PublishableKey.parse` (which carries the
secret-key-in-client refusal), and parallel message/attachment hierarchies
needing a translation layer in this package.

### This package does not modify `packages/dart`

`ChatClientAdapter` wraps a `ChatClient` to satisfy `WidgetChatClient` by
delegation, rather than having `ChatClient` implement that interface directly.
That is the boundary: `dhaam_chat` is a protocol client with its own tests and
its own consumers, and a Flutter-shaped interface on it would be this package
reaching upward into a package that must not know Flutter exists. The narrowing
also buys something concrete — `WidgetChatClient` is small enough that every
widget test in this package drives the Cubit with a fake and never opens a
socket.

### Why `Cubit` and not `Bloc`

Both sibling apps (`dh-customer-app-flutter`, `dh-merchant-app-flutter`)
standardise on `flutter_bloc` `^9.1.1`, so that choice was made before this
package existed. Within it, `ChatWidgetCubit` is a `Cubit` for the same reason
`dh-customer-app-flutter`'s own `ConnectivityCubit` is one: the job is mirroring
an external source's streams into widget-renderable state via direct method
calls, not routing a taxonomy of discrete user-typed events through
transformers. `flutter_bloc` is the one pattern; Cubit vs Bloc is a style choice
inside it, not a second pattern introduced alongside it.

### The host publishes appearance; the host cannot override it

`remote-config.ts` supports a host-precedence merge — a host passes appearance
fields that win over the console publish. **That does not carry over here, and
it is a deliberate divergence rather than an omission.** The console publish
remains the single source of truth for appearance on Flutter, which means a
Flutter host **cannot pin an appearance field against a publish**. The
consequence inside the code is that this package never builds the fully-resolved
appearance shape TS's `config.ts` uses: the published, possibly-partial reading
is the only one that exists, which is why `appearance.dart`'s fields are
nullable on one class rather than wrapped in a second `Partial<T>`-shaped type.

---


### The access token is minted by YOUR backend, not by an identity provider

This is the single most common way to get a working setup that will not
connect. `DHAAM_ACCESS_TOKEN` is **not** a Cognito/Auth0/Firebase token, and
not your app's own session JWT. The chat service issues its own short-lived,
scoped token:

```
POST /chat-services/api/v1/tokens
Authorization: Bearer <dhk_test_… secret key>
Content-Type: application/json

{"userId": "...", "name": "..."}
  ->  {"accessToken": "...", "expiresIn": 3600}
```

Called by your **backend**, with your secret key, which must never reach a
client (`openapi/chat-api.yaml:434`, PRD §10.3). Your frontend relays only the
resulting `accessToken`.

Handing the SDK an IdP token instead produces `AUTH_INVALID`, and the client
correctly stops after its auth cap — leaving you looking at
"authentication failed repeatedly" holding a token that is present, unexpired
and visibly a JWT. The example app decodes the token's *shape* (never its
signature) and names this case explicitly in its diagnostics strip.


## Running the example

```bash
cd packages/flutter/example
flutter pub get

flutter run \
  --dart-define=DHAAM_WS_URL=wss://chat.your-host.example \
  --dart-define=DHAAM_API_URL=https://api.your-host.example \
  --dart-define=DHAAM_PUBLISHABLE_KEY=pk_test_yourkey \
  --dart-define=DHAAM_ACCESS_TOKEN=your.jwt.here
```

You land on a plain host screen — the merchant's app — with an **Open chat**
button that pushes the panel, plus a diagnostics section showing what the
config fetch and `captureContactInfo` came back with, and which seams this
example was able to wire.

**Nothing is hardcoded and there are no defaults.** Launch it with a key
missing and you get a page naming every key that is missing and the command to
fix it — not a stack trace, and not a socket retrying in backoff forever under
the word "Connecting…". That page is the point: `PublishableKey.parse` throws
and `ChatClient` retries silently, so an unvalidated config fails in whichever
of those two ways is least legible.

### The `--dart-define` keys

| Key | Required | What it is |
|---|---|---|
| `DHAAM_WS_URL` | yes | The WebSocket endpoint. `ws://` or `wss://`. Goes to `ChatClient(wsUrl:)`. |
| `DHAAM_API_URL` | yes | The REST **origin**, `http://` or `https://`, **with no path** — `RestClient`, `fetchRemoteConfig` and `fetchIpWatermark` each append `/chat-services/api/v1` themselves. Passing a value that already carries the base path builds a doubled one, and the symptom (every REST call 404s while the socket works fine) is hard to read backwards, so the example refuses it up front. |
| `DHAAM_PUBLISHABLE_KEY` | yes | The tenant key, `pk_live_…` or `pk_test_…`. Public by design: it identifies a tenant and grants nothing. |
| `DHAAM_ACCESS_TOKEN` | yes | A user JWT for this run. **See the warning below.** |
| `DHAAM_SESSION_ID` | no | A conversation to open on. Unset lands on Home, which is what a visitor arriving fresh sees. |

`--dart-define` rather than a checked-in constant or a `.env` file: one of these
values is a credential, a constant would put it in git history, and a `.env`
file would need a plugin, an asset entry and a `.gitignore` rule to end up no
safer.

### The static token is an example-only shortcut

`ChatClient` and `RestClient` both take `TokenProvider`, which is
`Future<String> Function()` — a **callback**, never a string. §6.1 requires it
to be structurally impossible to pass a static token in place of one, and in
Dart that is free, because a `String` is not a `Future<String> Function()`.

A real host implements it as a call to **its own backend**, which holds the
secret key and mints a short-lived token via `POST /tokens`. The secret key
never travels to the device, and both clients re-read the callback on every
connect, reauth and request, so a refreshed token is picked up without
restarting anything.

The example closes over a string from `--dart-define` and returns the same
value every time, which means a run outlives its token by exactly as long as the
token had left. That is the one place in `example/seams.dart` where copying the
code verbatim into a production host would be wrong, and it says so in place.

---

## Host platform entries

The package cannot add these for you; they belong to the app that ships it.

### macOS — `macos/Runner/{DebugProfile,Release}.entitlements`

```xml
<key>com.apple.security.network.client</key>
<true/>
<key>com.apple.security.files.user-selected.read-only</key>
<true/>
<key>com.apple.security.device.audio-input</key>
<true/>
```

* **`com.apple.security.network.client`** — required for *any* outbound
  request under App Sandbox. `flutter create` scaffolds only
  `network.server`, which is for the debug VM service, so without this the
  chat socket and every REST call fail with `SocketException: Connection
  failed (OS Error: Operation not permitted, errno = 1)`.
  ([Flutter macOS docs](https://docs.flutter.dev/platform-integration/macos/building))
* **`com.apple.security.files.user-selected.read-only`** — the *User Selected
  File Read* entitlement the attachment picker needs. `file_picker` 11.0.3's
  own `pickFiles` doc states it verbatim: *"Note: This requires the User
  Selected File Read entitlement on macOS."* Read-**only**, not read-write:
  the plugin's own example asks for the wider one because it also demonstrates
  `saveFile`, and this SDK never writes a file back.
* **`com.apple.security.device.audio-input`** — *Audio Input*, which a
  sandboxed app needs before it can open a capture device at all. `record`'s
  own setup notes say to activate it "in debug AND release schemes, or
  directly in `*.entitlements` files", which is why it belongs in **both**
  `DebugProfile.entitlements` and `Release.entitlements` rather than one of
  them. macOS also needs `NSMicrophoneUsageDescription` in
  `macos/Runner/Info.plist` — the entitlement lets the app open the device,
  the plist string explains the prompt, and missing either one fails
  differently.

### Android — `android/app/src/main/AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
```

`flutter create` puts `INTERNET` in `src/debug` and `src/profile` only, where
the Flutter tool needs it for hot reload — **not** in `main`. A host that never
adds this line debugs perfectly and then cannot connect at all once shipped.

`RECORD_AUDIO` is declared by `record_android` 1.5.2's own manifest and would
merge in regardless; it is written out because a permission users are asked
for at runtime should be visible in the host's own manifest rather than
arriving invisibly through a transitive dependency.

**Android also needs `minSdk 23`**, in `android/app/build.gradle`:

```gradle
defaultConfig {
    minSdk = 23  // not flutter.minSdkVersion, which is 21
}
```

`record_android` declares `minSdk = 23`, so the Flutter 3.24.4 default of 21
fails the manifest merge outright — `uses-sdk:minSdkVersion 21 cannot be
smaller than version 23 declared in library [record_android]`. A build error
rather than a runtime one, which is the good kind, but a real cost this
dependency imposes.

### iOS — `ios/Runner/Info.plist`

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Record a voice message to send to the support team.</string>
```

`record_ios` links AVFoundation, so this is required of any host that
**builds** against this SDK, not only one that shows the voice button — App
Store review rejects a binary that links the framework without it. Write it
for the person reading the prompt; Apple rejects boilerplate.

`NSSpeechRecognitionUsageDescription` is deliberately **not** required. It
belongs to speech recognition, which this SDK does not do: the voice button
records audio and uploads it for an agent to listen to, and nothing here
transcribes anything. Declaring it would ask a host to justify a capability
to Apple that their binary does not have.

`file_picker` 11.0.3 itself needs no `NSUsageDescription` key on iOS and no
`uses-permission` on Android (its Android manifest carries a `<queries>`
block and nothing else).

### Microphone — not yet

`NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription` and
`RECORD_AUDIO` are **not** listed here, because there is no voice module:
`lib/src/ui/voice/` does not exist. Add them when it does, and not before —
a permission string for a feature that cannot run is a prompt a customer is
asked to answer for nothing.

---

## What is not wired yet

The parity port is not finished, and the honest list matters more than the
green test count. Everything below is a real gap between this package and
`packages/widget/src/**`, not a rough edge.

**Nothing plays a merchant-supplied chime sound.** `Chime` is mounted and
message arrivals do chime, on `SystemSound.alert`. What has no path is
*replacing* that sound with an asset: the `ChimePlayer` seam exists and
`ChatWidget` takes one, but this package bundles no audio plugin, so a
merchant who wants their own tone needs the host to supply the player.

**`captureContactInfo` still has nowhere to deliver.** `dhaam_chat_rest`
captures user agent, IP, watermark and geolocation through a
`ContactInfoSink`, and the hello frame carries no field for any of it. The
example displays what it captured because displaying it is the only consumer
that exists.

**The consent gate, the offline form, and the hero-header
collapse-oscillation guard are only partly landed.** `lib/src/ui/consent/`
and `lib/src/ui/offline_form/` exist and are mounted; the hero header carries
`kHeroCollapseSlackPx` but the second guard — the layout check read *at
collapse time* — has not been verified end to end. `mergeRemoteConfig`
host-precedence is deliberately not ported (see above). ADR
`docs/adr/0005-flutter-parity-scope.md`, which is to record the full
deliberately-N/A table, is not written yet.

**The session switcher is mounted nowhere** — and neither is
`createSessionSwitcher` in the reference (`session-picker.ts:288` has no call
site in `packages/widget/src`), so this is a faithful port of an unmounted
module rather than a gap. `SessionPickerScreen` looks like superseded code:
Home and Messages read `state.sessionSummaries` directly, expressing the same
`sessions.length > 0` gate as rows rather than as a surface.

**The inline report-issue entry point is not ported.** `widget.ts` opens the
report form from two places — the header menu (`:858`, ported) and an inline
button on the seam between the transcript and the composer (`:1401`). Only
the first exists here.

**Voice notes are WAV, where the web widget records WebM or MP4.** `record`'s
stream mode is the only capture path that works on all six platforms without
`dart:io`, and its only universally-available encoder there is `pcm16bits`,
which this package wraps in a WAVE header. The result is uncompressed: about
32 KB per second at 16 kHz mono, so the 25 MiB attachment cap lands at
roughly thirteen minutes rather than the hour a compressed codec would give.
Refused in words at the cap, like any other oversized file.

**Taking `record` imposes three things on every host**, whether or not it
shows the microphone, because the plugin's native code is linked at build
time: `NSMicrophoneUsageDescription` in `ios/Runner/Info.plist`; the same key
plus the `com.apple.security.device.audio-input` entitlement in **both**
`macos/Runner/*.entitlements`; and `RECORD_AUDIO` with **`minSdk 23`** on
Android — the Flutter 3.24.4 default of 21 fails the manifest merge outright.
`packages/flutter/example/` carries exactly these entries and no invented
ones. `NSSpeechRecognitionUsageDescription` is deliberately **not** among
them: this SDK records audio and never transcribes it, so declaring it would
ask a host to justify a capability their binary does not have.

### Deliberately not ported, and not coming

`embed.ts` (script-tag entry), `attributes.ts` (`data-*` → config — it cannot
even express `identity.profile`), `singleton.ts` (one widget per page across
separately-evaluated bundle copies; pub guarantees one copy, and multi-instance
is the *normal* case in Flutter), `ui/dom.ts`, `ui/focus.ts`,
`ui/platform-color.ts` (it samples the **host page's** computed colours, and
there is no host page), `ui/presentation.ts`, `ui/styles.ts`, `ui/root.ts`, and
the launcher/auto-open/**exit-intent** cluster. Exit-intent is structurally
impossible — it fires on a pointer leaving the document toward *browser
chrome* — and the widget already degrades it to `'never'` on touch devices, so
omitting it is behaviourally identical to the web widget on the same class of
device. Those fields are parsed and exposed; nothing acts on them.

---

## Tests

```bash
cd packages/flutter && flutter test
```

`packages/flutter/example` has its own small suite (`flutter test` from inside
`example/`) covering the one behaviour there whose failure mode is a runtime
one: an unset `--dart-define` produces a page rather than a crash.

`dart format` is **not** clean on this package and that is known: it is written
at a wider line length than the formatter's fixed 80 columns, and the one-shot
reformat is deliberately deferred so it does not collide with in-flight work.
(`dart format --output=none --set-exit-if-changed lib test` reports 43 of 148
files changed as of this writing — a figure worth re-measuring rather than
quoting, which is why the command is here and the number is parenthetical.) The CI job runs `analyze --fatal-infos`
and `test` here, and keeps its format gate on `packages/dart` and
`packages/dart_rest`, which are both clean.
