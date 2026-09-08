/// Everything this example needs from the outside world, read from
/// `--dart-define` and validated before a single socket is opened.
///
/// ── Why `--dart-define` and not a `.env` file or a constant ──────────────
///
/// Three of the four values below are deployment facts and one of them
/// (`DHAAM_ACCESS_TOKEN`) is a credential. A checked-in constant would put a
/// credential in git history, and a `.env` file would need a plugin, an asset
/// entry and a `.gitignore` rule to be no safer. `--dart-define` keeps every
/// one of them on the command line that launches the build and out of the
/// repository entirely.
///
/// **There are no defaults.** Every key below defaults to the empty string,
/// which this file then reports as missing. A plausible-looking placeholder —
/// `https://chat.example.com`, `dhp_test_abc123` — would be worse than no
/// default at all: the app would start, the socket would fail somewhere deep
/// in reconnect backoff, and the person testing by hand would be debugging a
/// value nobody typed.
///
/// ── The failure mode this file exists to prevent ─────────────────────────
///
/// `PublishableKey.parse` throws, `Uri.parse` throws, and `ChatClient` opens a
/// socket that retries with backoff rather than reporting anything. Left
/// alone, an unset key is either a red screen with a Dart stack trace or an
/// app that says "Connecting…" forever. Both are the same bug — the
/// configuration error is never named. So the whole configuration is resolved
/// and validated ONCE, synchronously, before `runApp`'s tree is built, and a
/// failure becomes a page that names the missing keys.
library;

import 'package:dhaam_chat/dhaam_chat.dart'
    show InvalidPublishableKeyError, PublishableKey, SecretKeyInClientError;

/// The `--dart-define` key naming the WebSocket endpoint (`ws://`/`wss://`).
///
/// The names are spelled out as constants rather than inlined so the setup
/// page can print the exact string a person has to type, and so a rename
/// cannot leave the two out of step.
const String kWsUrlKey = 'DHAAM_WS_URL';

/// The `--dart-define` key naming the REST origin (`http://`/`https://`).
///
/// The ORIGIN only — `RestClient` appends `/chat-services/api/v1` itself, and
/// so do `fetchRemoteConfig` and `fetchIpWatermark`. Passing a value that
/// already carries the base path produces a doubled one.
const String kApiUrlKey = 'DHAAM_API_URL';

/// The `--dart-define` key naming the tenant's publishable key.
const String kPublishableKeyKey = 'DHAAM_PUBLISHABLE_KEY';

/// The `--dart-define` key naming a user JWT for this run.
///
/// ── A guest needs one of these too ───────────────────────────────────────
///
/// This is the misconception the setup page exists to head off, and this app
/// is what taught it: the token was presented as a flat requirement next to
/// three deployment facts, with nothing said about what it identifies, so
/// "there is no logged-in user yet" reads as "so there is nothing to
/// authenticate".
///
/// Every visitor needs a token. `resolveConfig` in `packages/widget` refuses a
/// config with neither a `tokenEndpoint` nor a `getToken` for the reason it
/// states outright — "the browser is never given a secret key, so a token has
/// to come from your own backend" — and a Flutter app is in exactly the same
/// position: it ships to devices, so it cannot hold the secret key either.
///
/// What a guest's token differs in is WHO it says they are: it identifies an
/// anonymous VISITOR. What marks somebody as a known customer is
/// `ChatIdentity.profile`, which is a different input entirely and travels
/// nowhere near this one — see `example_identity.dart`. The two are
/// independent, which is why there are two switches on the host screen and
/// only one of them is a credential.
///
/// ── A static token here is an EXAMPLE-ONLY shortcut ──────────────────────
///
/// A real host implements [TokenProvider][dhaam_chat.TokenProvider] by calling
/// its own backend, which holds the secret key and mints a short-lived token
/// via `POST /tokens`. That is why `ChatClient` takes a callback and not a
/// string: §6.1 requires it to be structurally impossible to pass a static
/// token, and in Dart it is, because a `String` is not a
/// `Future<String> Function()`.
///
/// This example still supplies a static one, because standing up a token
/// endpoint is not what a person opening this app is trying to test. What it
/// does NOT do is pretend that is the design — see `exampleTokenProvider` in
/// `seams.dart`, which is the callback, and says so.
const String kAccessTokenKey = 'DHAAM_ACCESS_TOKEN';

/// The `--dart-define` key naming a conversation to open on. Optional.
///
/// Maps to `ChatWidgetCubit(sessionId:)`, which decides two things at once:
/// which screen the panel starts on, and whether the customer is looking at a
/// conversation from the first frame. Leave it unset to land on Home, which is
/// what a visitor arriving fresh sees.
const String kSessionIdKey = 'DHAAM_SESSION_ID';

// Read in a const context so the values are resolved at compile time, which is
// what `--dart-define` means. Each defaults to `''` — see this library's
// header on why no default here looks like a real value.
const String _wsUrl = String.fromEnvironment(kWsUrlKey);
const String _apiUrl = String.fromEnvironment(kApiUrlKey);
const String _publishableKey = String.fromEnvironment(kPublishableKeyKey);
const String _accessToken = String.fromEnvironment(kAccessTokenKey);
const String _sessionId = String.fromEnvironment(kSessionIdKey);

/// One thing wrong with the configuration, in words a person can act on.
///
/// [key] is the `--dart-define` name, so the setup page can show which switch
/// to add rather than describing it. [detail] never contains any part of the
/// offending value: `keys.dart` makes that rule absolute for credentials, and
/// applying it to every field here means there is no judgement call at the one
/// moment it would matter.
class ConfigProblem {
  const ConfigProblem(this.key, this.detail);

  final String key;
  final String detail;
}

/// The configuration, either usable or not. Never partially usable.
sealed class ExampleConfig {
  const ExampleConfig();
}

/// Every value present and well-formed.
final class ExampleConfigReady extends ExampleConfig {
  const ExampleConfigReady({
    required this.wsUrl,
    required this.apiUrl,
    required this.publishableKey,
    required this.accessToken,
    required this.sessionId,
  });

  final Uri wsUrl;
  final String apiUrl;
  final PublishableKey publishableKey;

  /// Held, never displayed. See [kAccessTokenKey].
  final String accessToken;

  /// The conversation to open on, or null to land on Home.
  final String? sessionId;
}

/// At least one value missing or malformed. Carries every problem, not the
/// first: someone launching this for the first time has typically set none of
/// them, and reporting one key per attempt would take four runs.
final class ExampleConfigIncomplete extends ExampleConfig {
  const ExampleConfigIncomplete(this.problems);

  final List<ConfigProblem> problems;
}

/// Resolves and validates the whole configuration.
///
/// Pure and synchronous — it reads compile-time constants and parses them.
/// Nothing here touches the network, so the setup page renders instantly and a
/// mistyped URL is reported before anything tries to reach it.
ExampleConfig readExampleConfig() {
  final List<ConfigProblem> problems = <ConfigProblem>[];

  final Uri? wsUrl = _validateWsUrl(problems);
  final String? apiUrl = _validateApiUrl(problems);
  final PublishableKey? key = _validatePublishableKey(problems);

  if (_accessToken.isEmpty) {
    problems.add(
      const ConfigProblem(
        kAccessTokenKey,
        'not set. Every visitor needs one, guests included — this token says '
        'WHICH visitor, and a guest is simply an anonymous one. What marks '
        'somebody as a known customer is identity.profile, which is a '
        'separate input and not a credential. See the README on how a real '
        'host mints this from its own backend.',
      ),
    );
  }

  if (wsUrl == null || apiUrl == null || key == null || problems.isNotEmpty) {
    return ExampleConfigIncomplete(problems);
  }

  return ExampleConfigReady(
    wsUrl: wsUrl,
    apiUrl: apiUrl,
    publishableKey: key,
    accessToken: _accessToken,
    // Absent and blank are the same answer to `ChatWidgetCubit`: no session
    // was named. Collapsing them here means the Cubit never sees a `''` that
    // would land it on the conversation screen with nothing to show.
    sessionId: _sessionId.isEmpty ? null : _sessionId,
  );
}

Uri? _validateWsUrl(List<ConfigProblem> problems) {
  if (_wsUrl.isEmpty) {
    problems.add(
      const ConfigProblem(
          kWsUrlKey, 'not set. Expected a ws:// or wss:// URL.'),
    );
    return null;
  }

  // `Uri.tryParse` rather than `Uri.parse`: this function's whole job is to
  // turn a bad value into a sentence, and letting it throw would defeat that.
  final Uri? parsed = Uri.tryParse(_wsUrl);
  if (parsed == null) {
    problems.add(const ConfigProblem(kWsUrlKey, 'is not a parseable URL.'));
    return null;
  }
  if (parsed.scheme != 'ws' && parsed.scheme != 'wss') {
    problems.add(
      ConfigProblem(
        kWsUrlKey,
        'has scheme "${parsed.scheme}". Expected ws or wss — this is the '
        'socket endpoint, not the REST one.',
      ),
    );
    return null;
  }
  return parsed;
}

String? _validateApiUrl(List<ConfigProblem> problems) {
  if (_apiUrl.isEmpty) {
    problems.add(
      const ConfigProblem(
        kApiUrlKey,
        'not set. Expected an http:// or https:// ORIGIN, with no path — '
        'the SDK appends /chat-services/api/v1 itself.',
      ),
    );
    return null;
  }

  final Uri? parsed = Uri.tryParse(_apiUrl);
  if (parsed == null) {
    problems.add(const ConfigProblem(kApiUrlKey, 'is not a parseable URL.'));
    return null;
  }
  if (parsed.scheme != 'http' && parsed.scheme != 'https') {
    problems.add(
      ConfigProblem(
        kApiUrlKey,
        'has scheme "${parsed.scheme}". Expected http or https.',
      ),
    );
    return null;
  }
  // Caught here rather than left to fail later: `RestClient` strips trailing
  // slashes but keeps a path, so `https://host/chat-services/api/v1` silently
  // builds `…/chat-services/api/v1/chat-services/api/v1/…` and every REST call
  // 404s while the socket works fine — a split-brain symptom that is very hard
  // to read backwards.
  if (parsed.path.isNotEmpty && parsed.path != '/') {
    problems.add(
      ConfigProblem(
        kApiUrlKey,
        'carries a path ("${parsed.path}"). Pass the origin only; the SDK '
        'appends /chat-services/api/v1 itself.',
      ),
    );
    return null;
  }
  return _apiUrl;
}

PublishableKey? _validatePublishableKey(List<ConfigProblem> problems) {
  if (_publishableKey.isEmpty) {
    problems.add(
      const ConfigProblem(
        kPublishableKeyKey,
        // The prefixes `keys.dart` actually accepts. It refuses `pk_`
        // deliberately — a bare `pk_test_` is Stripe's shape, and secret
        // scanners report such a key as a Stripe key — so a placeholder
        // spelled `pk_test_…` sends someone to look for a key that is not
        // the one they have, and the SDK's own refusal then names a third
        // string. See `keys.dart`'s closing note on the naming decision.
        'not set. Expected the tenant publishable key '
        '(dhp_live_… or dhp_test_…).',
      ),
    );
    return null;
  }

  // `parse`, not `tryParse`. `tryParse` folds a leaked SECRET key into the
  // same null a typo produces, and its own doc says so: a caller who needs to
  // tell the two apart must use `parse`. Here they must be told apart —
  // "rotate this credential" and "fix this typo" are different instructions.
  try {
    return PublishableKey.parse(_publishableKey);
  } on SecretKeyInClientError {
    problems.add(
      const ConfigProblem(
        kPublishableKeyKey,
        'is a SECRET key, not a publishable one. It has been in a shell '
        'history and a build argument — rotate it, then pass the publishable '
        'key instead.',
      ),
    );
    return null;
  } on InvalidPublishableKeyError catch (error) {
    // `reason` is documented never to contain any part of the input, which is
    // what makes it safe to put on screen.
    problems
        .add(ConfigProblem(kPublishableKeyKey, 'is rejected: ${error.reason}'));
    return null;
  }
}
