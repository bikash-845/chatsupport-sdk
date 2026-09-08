/// A host app for `dhaam_chat_flutter`.
///
/// ── What this is demonstrating ───────────────────────────────────────────
///
/// `ChatWidget` is a widget a host mounts INSIDE its own app — a pushed route,
/// a modal, a pane — not a standalone application. Its own doc says so, and it
/// is why it builds a scoped `Theme` and no `MaterialApp` of its own. This
/// example therefore has a host screen you land on and a chat panel you push,
/// rather than opening straight into the widget: mounting it the way a
/// merchant would is more useful than mounting it the way that needs least
/// code.
///
/// ── Who owns what ────────────────────────────────────────────────────────
///
/// `ChatWidget` takes an already-built `ChatWidgetCubit` and deliberately does
/// not construct one — "accept dependencies, don't create them", applied one
/// level up. The consequence is that the host owns the lifecycle of everything
/// underneath: `RestClient`, `ChatClient` and the Cubit are all created here
/// and all closed here. `ChatWidget` uses `BlocProvider.value` precisely so it
/// does not close a Cubit it did not create.
///
/// So the split below is not arbitrary:
///
///  * [_HostHomePageState] owns the [RestClient] and the config/contact-info
///    fetches, because they outlive any one visit to the panel.
///  * [_ChatPanelPageState] owns the [ChatClient] and the [ChatWidgetCubit],
///    because a socket should not be held open behind a screen nobody is
///    looking at.
library;

import 'dart:async';

import 'package:dhaam_chat/dhaam_chat.dart'
    show ChatClient, ErrorCode, ErrorPayload;
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart'
    show
        ChatClientAdapter,
        ChatIdentity,
        ChatWidget,
        ChatWidgetState,
        ChatWidgetCubit,
        RemoteConfig,
        defaultRemoteConfig,
        Chime,
        fetchRemoteConfig,
        restIssueReporter;
import 'package:dhaam_chat_rest/dhaam_chat_rest.dart'
    show RestClient, RestContactInfo, captureContactInfo;
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'example_config.dart';
import 'example_identity.dart';
import 'rest_session_actions.dart';
import 'seams.dart';
import 'token_shape.dart';

void main() {
  // Resolved once, before the tree exists. It is pure and synchronous, so
  // there is no loading state to render and no window in which a half-built
  // client could be constructed against a value that turns out to be missing.
  runApp(ExampleApp(config: readExampleConfig()));
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key, required this.config});

  final ExampleConfig config;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Dhaam chat example',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF3B5BFD)),
        useMaterial3: true,
      ),
      // The switch is exhaustive over the sealed config, so a third outcome
      // would be a compile error here rather than a blank screen.
      home: switch (config) {
        final ExampleConfigReady ready => _HostHomePage(config: ready),
        final ExampleConfigIncomplete incomplete =>
          _SetupRequiredPage(problems: incomplete.problems),
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────

/// What an unset `--dart-define` looks like: a page, not a stack trace.
///
/// This is the whole reason `readExampleConfig` validates rather than letting
/// `PublishableKey.parse` and `Uri.parse` throw where they are called. Left
/// alone, a missing key is either a red error screen or — worse, because it
/// looks like a server problem — a socket retrying in backoff forever under
/// the word "Connecting…".
class _SetupRequiredPage extends StatelessWidget {
  const _SetupRequiredPage({required this.problems});

  final List<ConfigProblem> problems;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Setup required')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          Text(
            'This example reads its endpoint and credentials from '
            '--dart-define. Nothing is hardcoded and there are no defaults, so '
            'it cannot start until these are supplied.',
            style: text.bodyMedium,
          ),
          const SizedBox(height: 20),
          for (final ConfigProblem problem in problems)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Padding(
                    padding: EdgeInsets.only(top: 2, right: 10),
                    child: Icon(Icons.error_outline, size: 18),
                  ),
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        children: <InlineSpan>[
                          TextSpan(
                            text: '${problem.key} ',
                            style: text.bodyMedium?.copyWith(
                              fontFamily: 'monospace',
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          TextSpan(text: problem.detail),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 12),
          Text('Run it like this', style: text.titleSmall),
          const SizedBox(height: 8),
          const _CodeBlock(_kRunCommand),
          const SizedBox(height: 16),
          Text(
            'DHAAM_SESSION_ID is optional — set it to land straight in an '
            'existing conversation instead of on Home.',
            style: text.bodySmall,
          ),
        ],
      ),
    );
  }
}

/// The launch command, built from the same constants the reader is validated
/// against so the two cannot drift.
const String _kRunCommand = 'flutter run \\\n'
    '  --dart-define=$kWsUrlKey=wss://chat.your-host.example \\\n'
    '  --dart-define=$kApiUrlKey=https://api.your-host.example \\\n'
    '  --dart-define=$kPublishableKeyKey=dhp_test_… \\\n'
    '  --dart-define=$kAccessTokenKey=…';

class _CodeBlock extends StatelessWidget {
  const _CodeBlock(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      // Wide content scrolls inside its own box rather than making the page
      // scroll sideways.
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Text(
          text,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The host app
// ─────────────────────────────────────────────────────────────────────────

class _HostHomePage extends StatefulWidget {
  const _HostHomePage({required this.config});

  final ExampleConfigReady config;

  @override
  State<_HostHomePage> createState() => _HostHomePageState();
}

class _HostHomePageState extends State<_HostHomePage> {
  late final RestClient _rest;
  late final RestSessionActions _sessionActions;

  /// The merchant's published appearance, or null until the fetch settles.
  ///
  /// `fetchRemoteConfig` answers `null` for every failure class — down, slow,
  /// not JSON — and the widget renders on [defaultRemoteConfig] in that case
  /// rather than blocking. Holding a nullable here and substituting at the
  /// call site keeps "we have not asked yet" distinguishable from "we asked
  /// and got nothing", which is the difference the diagnostics panel shows.
  RemoteConfig? _config;
  bool _configSettled = false;

  /// Whatever `captureContactInfo` managed to collect, merged as it arrives.
  RestContactInfo _contact = const RestContactInfo();

  /// Which visitor the next panel will be opened as.
  ///
  /// Held HERE, on the host screen, rather than inside the panel — because
  /// that is where it lives in a real app. A merchant's app knows whether it
  /// has a signed-in customer long before anybody taps the chat button, and
  /// `ChatWidgetCubit` takes the answer once, at construction. Flipping this
  /// switch therefore changes the NEXT panel, and the panel is built fresh on
  /// every open, so no rebuild of the app is needed to see both modes.
  ExampleVisitor _visitor = ExampleVisitor.guest;

  @override
  void initState() {
    super.initState();

    _rest = RestClient(
      apiUrl: widget.config.apiUrl,
      publishableKey: widget.config.publishableKey,
      getAccessToken: exampleTokenProvider(widget.config.accessToken),
    );
    _sessionActions = RestSessionActions(_rest);

    _loadRemoteConfig();
    _captureContactInfo();
  }

  @override
  void dispose() {
    // This state created the client, so this state closes it — the same
    // ownership rule `ChatWidget` follows by NOT closing the Cubit it was
    // handed.
    _rest.close();
    super.dispose();
  }

  Future<void> _loadRemoteConfig() async {
    // Never throws; every failure class is `null`.
    final RemoteConfig? fetched = await fetchRemoteConfig(
      apiUrl: widget.config.apiUrl,
      publishableKey: widget.config.publishableKey,
    );
    if (!mounted) return;
    setState(() {
      _config = fetched;
      _configSettled = true;
    });
  }

  /// Kicked off, deliberately not awaited.
  ///
  /// `captureContactInfo`'s own doc is emphatic about this: the data is
  /// enrichment, not a precondition, and GPS in particular must never gate the
  /// chat opening. It is called here — on the host screen, before anything can
  /// have connected — rather than next to the socket, which is as early as
  /// this app can manage.
  void _captureContactInfo() {
    unawaited(
      captureContactInfo(
        apiUrl: widget.config.apiUrl,
        userAgent: exampleUserAgent(),
        geolocation: kExampleGeolocationProbe,
        // Each capture arrives on its own; this merges rather than replaces,
        // because a `RestContactInfo` is a partial contribution and never
        // claims to be whole.
        sink: (RestContactInfo info) {
          if (!mounted) return;
          setState(() {
            _contact = RestContactInfo(
              ip: info.ip ?? _contact.ip,
              ipWatermark: info.ipWatermark ?? _contact.ipWatermark,
              userAgent: info.userAgent ?? _contact.userAgent,
              geo: info.geo ?? _contact.geo,
            );
          });
        },
      ),
    );
  }

  void _openChat() {
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext context) => _ChatPanelPage(
          config: widget.config,
          initialConfig: _config ?? defaultRemoteConfig,
          sessionActions: _sessionActions,
          // Read at PUSH time, not captured when this state was built, so the
          // switch above governs the panel about to open rather than the one
          // the app happened to start with.
          identity: exampleIdentity(_visitor),
          // The same client the session actions were built from, threaded
          // down the same way and for the same reason: three more seams — the
          // issue reporter, the attachment uploader, and the transcript
          // emailer behind them — are `RestClient` calls the panel wires, and
          // a second client here would open a second connection pool to talk
          // to the one endpoint.
          rest: _rest,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Host app')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          Text(
            'This screen is the merchant’s app. The chat panel is a route it '
            'pushes — ChatWidget builds a scoped Theme and a Scaffold, and no '
            'MaterialApp of its own, because it is meant to be mounted inside '
            'a host rather than to be one.',
            style: text.bodyMedium,
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _openChat,
            icon: const Icon(Icons.chat_bubble_outline),
            label: const Text('Open chat'),
          ),
          const SizedBox(height: 28),
          _Section(
            title: 'Visitor',
            children: <Widget>[
              // A merchant's app knows this before the chat button is tapped.
              // Here it is a switch so both modes can be seen in one run.
              SwitchListTile(
                key: const Key('host.identifiedSwitch'),
                contentPadding: EdgeInsets.zero,
                value: _visitor == ExampleVisitor.identified,
                onChanged: (bool on) => setState(() {
                  _visitor =
                      on ? ExampleVisitor.identified : ExampleVisitor.guest;
                }),
                title: const Text('Sign in as a known customer'),
                subtitle: Text(exampleVisitorExplanation(_visitor)),
              ),
              const SizedBox(height: 8),
              // Both rows, always, and this pairing is the point of the
              // section: the id does NOT change across the switch and the
              // answer does. A demo where the guest had no id would teach the
              // most available wrong answer — that the id is what decides.
              _Fact('identity.userId', kExampleUserId),
              _Fact(
                'identity.profile',
                _visitor == ExampleVisitor.identified
                    ? '${kExampleProfile.name} <${kExampleProfile.email}>'
                    : 'absent',
              ),
              _Fact('→ isGuest', '${exampleIdentity(_visitor).isGuest}'),
              const _Fact(
                'Pre-chat form',
                'asked of guests only, and only when the merchant enabled it '
                    'AND published at least one field',
              ),
            ],
          ),
          _Section(
            title: 'Connection',
            children: <Widget>[
              _Fact('WS endpoint', widget.config.wsUrl.toString()),
              _Fact('REST origin', widget.config.apiUrl),
              // `PublishableKey.toString()` is redacted by design and prints
              // its environment, which is not a secret and IS worth seeing: a
              // live build pointed at a test tenant otherwise goes unnoticed
              // until somebody wonders where the conversations went.
              _Fact('Publishable key', widget.config.publishableKey.toString()),
              // The token is never rendered, not even truncated. A length or a
              // prefix fingerprints a credential; `keys.dart` makes that rule
              // absolute and there is no reason to hold this file to a looser
              // one.
              const _Fact('Access token', 'supplied (never displayed)'),
              _Fact(
                'Opens on',
                widget.config.sessionId == null
                    ? 'Home (no $kSessionIdKey set)'
                    : 'session ${widget.config.sessionId}',
              ),
            ],
          ),
          _Section(
            title: 'Published config',
            children: <Widget>[
              if (!_configSettled)
                const _Fact('GET /widget/config', 'fetching…')
              else if (_config == null)
                const _Fact(
                  'GET /widget/config',
                  'no answer — the widget renders on defaultRemoteConfig',
                )
              else ...<Widget>[
                const _Fact('GET /widget/config', 'loaded'),
                _Fact('Uploads enabled', '${_config!.fileUploads}'),
                _Fact('Sound enabled', '${_config!.sound}'),
              ],
            ],
          ),
          _Section(
            title: 'Contact info',
            children: <Widget>[
              _Fact('User agent', _contact.userAgent ?? '—'),
              // Unauthenticated, no publishable key, `credentials: omit`. It
              // is also the cheapest proof that DHAAM_API_URL is reachable at
              // all, which is why it earns a row here.
              _Fact('IP (GET /ip-watermark)', _contact.ip ?? '—'),
              _Fact('Watermark', _contact.ipWatermark ?? '—'),
              _Fact(
                'Geolocation',
                _contact.geo == null
                    ? '— (probe declines; see seams.dart)'
                    : '${_contact.geo!.lat}, ${_contact.geo!.lng}',
              ),
            ],
          ),
          _Section(
            title: 'Seams',
            children: <Widget>[
              for (final SeamReport report in seamReports)
                _SeamRow(report: report),
            ],
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The chat panel
// ─────────────────────────────────────────────────────────────────────────

/// The pushed route that owns one socket and one Cubit.
class _ChatPanelPage extends StatefulWidget {
  const _ChatPanelPage({
    required this.config,
    required this.initialConfig,
    required this.sessionActions,
    required this.identity,
    required this.rest,
  });

  final ExampleConfigReady config;
  final RemoteConfig initialConfig;
  final RestSessionActions sessionActions;

  /// Who the host says this visitor is. See `example_identity.dart` — the
  /// profile inside it is the single thing that decides whether the pre-chat
  /// questions get asked.
  final ChatIdentity identity;

  /// Owned by `_HostHomePageState`, borrowed here. This route does not close
  /// it — the state that created it does, which is the same ownership rule
  /// `ChatWidget` follows by not closing the Cubit it was handed.
  final RestClient rest;

  @override
  State<_ChatPanelPage> createState() => _ChatPanelPageState();
}

class _ChatPanelPageState extends State<_ChatPanelPage> {
  late final ChatClient _client;

  /// `late final` rather than plain `late`: the issue reporter and the
  /// attachment uploader below both close over this very field, which is
  /// only expressible if the closure can name it before it is assigned. Safe
  /// because neither closure runs during construction.
  late final ChatWidgetCubit _cubit;

  /// Built once and held, not rebuilt in `build`: `Chime` remembers the last
  /// unread count it saw, and a fresh one on every rebuild would either
  /// re-announce or go silent depending on which way the count moved.
  final Chime _chime = exampleChime();

  @override
  void initState() {
    super.initState();

    _client = ChatClient(
      wsUrl: widget.config.wsUrl,
      publishableKey: widget.config.publishableKey,
      // The same provider the RestClient holds. Both packages take the
      // identical `TokenProvider` type precisely so a host that builds both
      // shares ONE token source instead of writing an adapter at every call
      // site — orchestrator decision D1, visible here as one argument passed
      // twice rather than two callbacks kept in step.
      getToken: exampleTokenProvider(widget.config.accessToken),
    );

    _cubit = ChatWidgetCubit(
      // `ChatClientAdapter` is the package's own bridge from `dhaam_chat`'s
      // `ChatClient` to the narrower `WidgetChatClient` the Cubit reads. The
      // narrowing is what lets every widget test drive the Cubit with a fake
      // and no socket.
      client: ChatClientAdapter(_client),
      initialConfig: widget.initialConfig,
      sessionId: widget.config.sessionId,
      // The argument whose absence was the reported "pre-chat form shows for
      // logged-in users" bug. The parameter defaults to `ChatIdentity.guest`,
      // so an app that never passes one has no logged-in path at all — every
      // visitor is a guest and every visitor is asked.
      identity: widget.identity,
      // The seam that turns the end-of-conversation surfaces on. Absent means
      // OFF, not broken: no rating card, no ended footer, no way to end a
      // conversation — which is the correct outcome for a host that wired no
      // REST, and the wrong one for this app, which has one.
      sessionActions: widget.sessionActions,
      // The raw `POST /chat/sessions/{id}/report-issue` route. Absent means
      // the ⋯ menu drops the row entirely rather than offering one that
      // quietly does nothing — so without this line the report form T14
      // built and T23 mounted is unreachable for a user.
      //
      // `sessionId` is a CLOSURE over this Cubit's own state, read at the
      // moment Send is pressed rather than captured when the panel was
      // built. `late final _cubit` is what lets it refer to the very Cubit
      // it is being passed to, and it is safe because the closure is not
      // invoked during construction.
      issueReporter: restIssueReporter(
        client: widget.rest,
        sessionId: () => _cubit.state.session?.sessionId,
      ),
      // `POST /upload`. Absent means no paperclip at all — the same "off,
      // not broken" rule. The session id is read at upload time for the
      // reason the reporter's is: a file must be posted against the
      // conversation it is being sent to, not the one that was open when
      // the composer was built.
      attachmentUploader: exampleAttachmentUploader(
        widget.rest,
        () => _cubit.state.session?.sessionId ?? '',
      ),
    );
  }

  @override
  void dispose() {
    // Created here, closed here. `ChatWidget` will not do it — it was handed
    // the Cubit through `BlocProvider.value`, which provides an existing
    // instance without taking over its lifecycle.
    //
    // Order matters: the Cubit holds subscriptions to the client's streams, so
    // it is closed before the client that feeds them.
    _cubit.close();
    unawaited(_client.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // No Scaffold and no AppBar around it: `ChatWidget` builds its own, and
    // wrapping it in a second one would put two app bars on the screen the
    // moment it drills into a conversation.
    // A developer-facing strip over the widget, not part of the SDK's own UI.
    //
    // The package deliberately does NOT put protocol errors in front of a
    // customer — "AUTH_INVALID" means nothing to someone who wants to ask
    // about their order. But an integrator pointing the SDK at a new endpoint
    // needs exactly that string, and its absence is what turned a one-line
    // misconfiguration into an afternoon: the client reconnects forever and
    // every cause renders identically as "Connecting…".
    return Stack(
      children: <Widget>[
        ChatWidget(
          // The package builds its own when a host passes none, so this
          // changes no behaviour — it is here because the seam exists and a
          // host is the party that would replace the sound. See seams.dart.
          chime: _chime,
          cubit: _cubit,
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: 0,
          child: BlocBuilder<ChatWidgetCubit, ChatWidgetState>(
            bloc: _cubit,
            builder: (BuildContext context, ChatWidgetState state) {
              final ErrorPayload? error = state.lastError;
              if (error == null) return const SizedBox.shrink();
              final bool gaveUp = state.suspendReason != null;
              return Material(
                color:
                    gaveUp ? const Color(0xFF7F1D1D) : const Color(0xFF78350F),
                child: SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: Text(
                      _errorLine(state, error, gaveUp: gaveUp),
                      maxLines: 12,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

/// What the diagnostics strip says.
///
/// An `AUTH_INVALID` on its own is a dead end for whoever is integrating: the
/// token is present, unexpired and obviously a JWT, and the server will not
/// say more than "Authentication failed" — correctly, since a chattier auth
/// failure is an oracle. So where the token's SHAPE explains it, this says so
/// instead of repeating the server.
String _errorLine(
  ChatWidgetState state,
  ErrorPayload error, {
  required bool gaveUp,
}) {
  final String head = gaveUp
      // Naming the reason separately matters: an exhausted auth cap and a
      // refused protocol version are both terminal and want different fixes.
      ? 'GAVE UP (${state.suspendReason!.name}) — '
          '${error.code.name}: ${error.message}'
      : '${error.code.name}: ${error.message}'
          '${error.retryable ? " (retrying)" : ""}';

  if (error.code != ErrorCode.authInvalid &&
      error.code != ErrorCode.authExpired) {
    return head;
  }
  // `ExampleConfig` is a sealed pair; only the ready half carries a token, and
  // the incomplete half never reaches a live connection to fail one.
  final ExampleConfig config = readExampleConfig();
  if (config is! ExampleConfigReady) return head;
  final String? hint = describeSuspiciousToken(config.accessToken);
  return hint == null ? head : '$head\n\n$hint';
}

// ─────────────────────────────────────────────────────────────────────────
// Small presentational pieces
// ─────────────────────────────────────────────────────────────────────────

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          ...children,
        ],
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 160,
            child: Text(label, style: text.bodySmall),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: text.bodySmall?.copyWith(fontFamily: 'monospace'),
            ),
          ),
        ],
      ),
    );
  }
}

class _SeamRow extends StatelessWidget {
  const _SeamRow({required this.report});

  final SeamReport report;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool wired = report.wiring == SeamWiring.wired;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 2, right: 8),
            child: Icon(
              wired ? Icons.check_circle_outline : Icons.link_off,
              size: 16,
              color:
                  wired ? theme.colorScheme.primary : theme.colorScheme.outline,
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(report.name, style: theme.textTheme.bodyMedium),
                Text(
                  report.detail,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
