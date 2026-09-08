/// The receive side of the typing indicator: a safety net under `typing.stop`.
///
/// Ports the inbound half of `packages/core/src/presence/typing.ts`
/// (`applyTypingStart` at :203, `applyTypingStop` at :219, `#armAutoClear` at
/// :296), whose own header calls the failure this module prevents "the most
/// visible bug this module can ship".
///
/// ── Why a timeout here is not paranoia ────────────────────────────────────
///
/// `typing.stop` is a single, unacknowledged frame, and nothing in the
/// protocol repairs a lost one. It carries no `seq` — `resume_tracker.dart`
/// sequences only the frames that advance the transcript — so the D2 resume
/// path cannot notice one missing and will never refetch it. There is no
/// retransmission and no ack. Every ordinary way a socket ends loses it: a
/// dropped frame, the agent's browser closing mid-compose, a server restart
/// between the start and the stop.
///
/// So the receiver is the ONLY place the repair can happen, and without it the
/// indicator is not merely wrong for a while — it is wrong until the process
/// dies. That is what separates this from an ordinary timeout: the failure it
/// covers has no other recovery path anywhere in the protocol.
///
/// ── Why the number is 5 seconds, and why that is not a guess ─────────────
///
/// Because the SENDER refreshes faster than it. A sender emits a fresh
/// `typing.start` every 3 seconds during sustained typing
/// ([kTypingStartInterval]), specifically so that each one re-arms this timer
/// before it can fire. The 5-second window is therefore a net stretched under
/// a 3-second cadence, not a bet on how long a human pauses between words:
///
///     refresh cadence (3s)  <  remote timeout (5s)
///     idle auto-stop  (3s)  <  remote timeout (5s)
///
/// Invert either inequality and the indicator blinks off and on while somebody
/// is visibly typing — a bug that reads as a protocol fault and gets debugged
/// as one. [assertTypingTimings] enforces the relationship rather than leaving
/// it as a comment for a future tuner to walk past. 5s also matches v1's
/// confirmed auto-clear window (§12.4), so this restores behaviour v1 had
/// rather than inventing a new one.
///
/// ── Why a map, when the host renders one bool ────────────────────────────
///
/// Multi-agent sessions are real (§12.9), and the single-slot version has a
/// concrete bug: agent A starts, agent B starts, agent A stops — with one slot
/// the indicator clears while B is still typing. Per-participant state costs a
/// map and removes that whole class of failure. A host that collapses the
/// stream to one bool (`ChatWidgetCubit` does) still benefits, because what it
/// collapses is already correct.
library;

import '../connection/socket.dart';

/// Receive-side safety net. Matches v1's confirmed 5-second window (§12.4).
///
/// Mirrors `DEFAULT_REMOTE_TYPING_TIMEOUT_MS` (`typing.ts:64`).
const Duration kRemoteTypingTimeout = Duration(seconds: 5);

/// Send-side: at most one `typing.start` per this window while typing
/// continues. Mirrors `DEFAULT_TYPING_START_INTERVAL_MS` (`typing.ts:67`).
const Duration kTypingStartInterval = Duration(seconds: 3);

/// Send-side: emit `typing.stop` after this long with no further activity.
/// Mirrors `DEFAULT_TYPING_IDLE_MS` (`typing.ts:70`).
const Duration kTypingIdleTimeout = Duration(seconds: 3);

/// Rejects a timing set that would make the indicator flicker.
///
/// Called from [TypingController]'s constructor rather than left to review,
/// because these are the one class of misconfiguration whose symptom — an
/// indicator blinking off and on while somebody is visibly typing — looks like
/// a protocol bug rather than a settings mistake, and would be hunted as one
/// through the frame log before anybody thought to check a constructor
/// argument. Mirrors `assertTypingTimings` (`typing.ts:86`).
void assertTypingTimings({
  required Duration remoteTimeout,
  required Duration startInterval,
  required Duration idleTimeout,
}) {
  if (remoteTimeout <= Duration.zero ||
      startInterval <= Duration.zero ||
      idleTimeout <= Duration.zero) {
    throw ArgumentError('typing timings must all be positive');
  }
  if (startInterval >= remoteTimeout) {
    throw ArgumentError(
      'startInterval ($startInterval) must be < remoteTimeout '
      '($remoteTimeout): a refresh slower than the receiver timeout makes the '
      'indicator flicker during sustained typing',
    );
  }
  if (idleTimeout >= remoteTimeout) {
    throw ArgumentError(
      'idleTimeout ($idleTimeout) must be < remoteTimeout ($remoteTimeout): '
      'the explicit stop must arrive before the receiver would have timed out '
      'anyway',
    );
  }
}

/// Reports that [participantId]'s typing state changed.
///
/// [isTyping] is named rather than positional because the two arguments would
/// otherwise be a `String` and a bare `bool`, and a bare bool argument is
/// unreadable at exactly the call site that matters most — the one deciding
/// whether an indicator goes up or comes down.
typedef TypingStateChanged = void Function(
  String participantId, {
  required bool isTyping,
});

/// Puts one outbound `typing.start` / `typing.stop` on the wire (§7.3).
typedef TypingFrameSink = void Function({required bool isTyping});

/// Tracks who is currently typing, and clears anyone the server stops
/// mentioning.
///
/// Owns no transport and no clock of its own: [Scheduler] is the same seam
/// `connection.dart` uses for every timeout it owns, so the 5-second window is
/// exercisable in a unit test that takes no real time. A timer only a real
/// delay can drive is a test nobody writes.
class TypingController {
  TypingController({
    required Scheduler scheduler,
    required TypingStateChanged onChanged,
    required TypingFrameSink onSend,
    Duration remoteTimeout = kRemoteTypingTimeout,
    Duration startInterval = kTypingStartInterval,
    Duration idleTimeout = kTypingIdleTimeout,
    String? localParticipantId,
  })  : _scheduler = scheduler,
        _onChanged = onChanged,
        _onSend = onSend,
        _remoteTimeout = remoteTimeout,
        _startInterval = startInterval,
        _idleTimeout = idleTimeout,
        _localParticipantId = localParticipantId {
    assertTypingTimings(
      remoteTimeout: remoteTimeout,
      startInterval: startInterval,
      idleTimeout: idleTimeout,
    );
  }

  final Scheduler _scheduler;
  final TypingStateChanged _onChanged;
  final TypingFrameSink _onSend;
  final Duration _remoteTimeout;
  final Duration _startInterval;
  final Duration _idleTimeout;

  /// Whose relayed typing frames are this client's own echo, or null when the
  /// host has not said — see `ChatClient.localParticipantId` for why this can
  /// only ever be told to us. Null disables the filter, matching
  /// `typing.ts:184` ("Pass `null` to disable filtering").
  ///
  /// Immutable, unlike the reference's, which carries a `setLocalParticipantId`
  /// (`typing.ts:186`). That setter exists in core for one reason: its
  /// `WatermarkTracker` can ADOPT an id later by guessing the session
  /// snapshot's lone `CUSTOMER` participant is us
  /// (`packages/core/src/presence/watermarks.ts:220`). Core overrides that
  /// guess at both of its real call sites, and this package does not port it
  /// at all, so nothing here can ever learn the id after construction and a
  /// setter would be a seam with nothing on the other side of it.
  final String? _localParticipantId;

  /// Who is typing, mapped to the canceller for their auto-clear.
  ///
  /// Insertion order is meaningful and maintained: [_arm] deletes before it
  /// re-inserts, so the most recently active typer is always last. A host that
  /// names a single typer ("Priya is typing…") reads the last entry and gets
  /// the one who most recently touched a key, which is the one a reader
  /// expects to be named.
  final Map<String, Cancellable> _typers = <String, Cancellable>{};

  /// Participants currently shown as typing, least recently active first.
  Iterable<String> get typers => _typers.keys;

  // Outbound throttle state.
  bool _outboundActive = false;
  DateTime? _lastStartSentAt;
  Cancellable? _idleTimer;

  /// Applies a server-relayed `typing.start` (§7.3).
  ///
  /// A frame with no `participantId` is dropped rather than guessed at, which
  /// is what `typing.ts:203` does — and the reason is sharper here than there:
  /// this class is keyed by participant, so a frame naming nobody cannot be
  /// armed with an auto-clear at all. Emitting it anyway would raise the one
  /// indicator in this class that provably cannot come down, reintroducing the
  /// exact bug the module exists to close. Per §7.3 the field is populated
  /// whenever the server relays typing onward (see `typingPayload`, which
  /// sends an empty `d` precisely because the server attributes it), so a
  /// relayed frame without one is malformed rather than merely terse.
  /// A frame attributed to US is dropped as self-echo (`typing.ts:205`). §7.3
  /// does not say whether the server relays a `typing.start` back to the
  /// participant who sent it. If it does, and this applied it, the customer
  /// would watch a "someone is typing" bubble track their own keystrokes in
  /// their own transcript. Filtering on our own id makes the client correct
  /// under EITHER server behaviour rather than depending on the one §7.3
  /// declines to specify.
  void applyStart(String? participantId) {
    if (participantId == null) return;
    if (participantId == _localParticipantId) return;

    final bool wasTyping = _typers.containsKey(participantId);
    _arm(participantId);

    // §6.5 defines this as "remote typing state CHANGED". A keepalive refresh
    // for somebody already typing is not a change, and forwarding it would
    // rebuild every listening widget every 3 seconds to say what the screen
    // already shows.
    if (!wasTyping) _onChanged(participantId, isTyping: true);
  }

  /// Applies a server-relayed `typing.stop` (§7.3).
  ///
  /// Silent for a participant who is not currently typing. That covers the
  /// duplicate stop a sender emits when an integrator wires both "input
  /// cleared" and "blur", and the stop that lands just after this class had
  /// already timed the same participant out.
  void applyStop(String? participantId) {
    if (participantId == null) return;
    // Redundant today — a self-echoed start never entered the map, so the
    // membership check below would refuse this anyway — and kept because that
    // redundancy is exactly what stops "the stop path is correct" from
    // silently depending on "the id never changes after construction".
    if (participantId == _localParticipantId) return;
    if (!_typers.containsKey(participantId)) return;

    _cancel(participantId);
    _onChanged(participantId, isTyping: false);
  }

  // ── Outbound: the cadence the receive-side window is stretched under ────

  /// Reports local typing activity. Safe to call on every keystroke.
  ///
  /// Ports `typing.ts:237`. Three rules, and they are one policy rather than
  /// three knobs:
  ///
  ///  1. LEADING EDGE. The first call emits `typing.start` immediately, NOT
  ///     trailing-edge debounced. The whole value of the indicator is that it
  ///     appears while the user is still typing, and delaying it by the
  ///     debounce window is the wrong trade.
  ///  2. REFRESH, NOT SUPPRESS-FOREVER. Calls within [kTypingStartInterval] of
  ///     the last emitted start are dropped; the first call after that window
  ///     emits a fresh one. Sustained typing costs one frame per interval
  ///     instead of one per character (~200 frames to communicate one bit),
  ///     and each frame doubles as the keepalive that re-arms the RECEIVER's
  ///     auto-clear. This is the half that makes the 5-second window on the
  ///     other side a net rather than a guess — see the library doc.
  ///  3. IDLE AUTO-STOP. Every call re-arms an idle timer of
  ///     [kTypingIdleTimeout]; when it fires, `typing.stop` goes out by
  ///     itself. A user who types and walks away therefore does not strand an
  ///     indicator on somebody else's screen even if the integrator never
  ///     calls [stopTyping].
  void startTyping() {
    final DateTime now = _scheduler.now();
    final DateTime? lastSent = _lastStartSentAt;
    final bool dueForRefresh =
        lastSent == null || now.difference(lastSent) >= _startInterval;

    // Either this is a fresh burst of typing or the keepalive is due. The
    // first disjunct is what preserves the leading edge across a stop/start
    // inside one interval: [stopTyping] leaves [_lastStartSentAt] alone, so
    // without it a user who sent a message and immediately began typing again
    // would show nothing until the interval elapsed.
    final bool shouldSend = !_outboundActive || dueForRefresh;

    _outboundActive = true;
    _armIdleTimer();

    if (shouldSend) {
      _lastStartSentAt = now;
      _onSend(isTyping: true);
    }
  }

  /// Reports that local typing ended — message sent, input cleared, blur.
  ///
  /// A no-op when not currently typing, so an integrator wiring this to both
  /// "input cleared" and "blur" does not emit two stops for one stop.
  void stopTyping() {
    if (!_outboundActive) return;
    _resetOutbound();
    _onSend(isTyping: false);
  }

  /// Clears everyone, reporting each as stopped.
  ///
  /// Called when the transport goes away. A socket that drops while an agent
  /// is mid-sentence would otherwise leave the indicator up for the remainder
  /// of the timeout, attributing live typing to a connection that no longer
  /// exists — and on reconnect the sender's next `typing.start` re-arms it
  /// anyway, so nothing is lost by clearing early.
  void reset() {
    // The outbound half goes too, and forgetting the last-sent time is the
    // load-bearing part: the server never saw the start that was in flight
    // when the socket died, so the next keystroke after a reconnect has to
    // send a fresh one rather than be suppressed as a duplicate refresh.
    _resetOutbound();
    _lastStartSentAt = null;

    // Cancelled in full BEFORE anything is reported. A listener that reacts
    // synchronously can call straight back into this class, and doing both in
    // one pass would let it mutate the map being iterated.
    final List<String> cleared = _typers.keys.toList();
    for (final String participantId in cleared) {
      _cancel(participantId);
    }
    for (final String participantId in cleared) {
      _onChanged(participantId, isTyping: false);
    }
  }

  /// Cancels every pending timer without reporting anything.
  ///
  /// For teardown, where [reset]'s notifications would be delivered into a
  /// stream that is closing and to listeners already going away. The timers
  /// still have to be cancelled: a pending one holds a closure over this
  /// object, and a disposed client keeping a 5-second timer alive is a leak
  /// that outlives the thing that created it.
  void dispose() {
    _resetOutbound();
    for (final Cancellable timer in _typers.values) {
      timer.cancel();
    }
    _typers.clear();
  }

  /// (Re)starts [participantId]'s auto-clear, moving them to most-recent.
  void _arm(String participantId) {
    _cancel(participantId);
    _typers[participantId] = _scheduler.schedule(_remoteTimeout, () {
      // Deliberately identical to receiving a `typing.stop`: the whole point
      // of the net is that a lost stop and a delivered one leave the receiver
      // in the same state, so no host can tell which one it got.
      if (_typers.remove(participantId) == null) return;
      _onChanged(participantId, isTyping: false);
    });
  }

  void _cancel(String participantId) => _typers.remove(participantId)?.cancel();

  void _armIdleTimer() {
    _idleTimer?.cancel();
    _idleTimer = _scheduler.schedule(_idleTimeout, () {
      if (!_outboundActive) return;
      _resetOutbound();
      _onSend(isTyping: false);
    });
  }

  /// Drops the outbound throttle state WITHOUT emitting a stop.
  ///
  /// The silence is the point at the two lifecycle call sites: [reset] runs
  /// because the transport went away, so a stop frame would be written to a
  /// socket that is already gone, and [dispose] runs during teardown. Only
  /// [stopTyping] and the idle timer, which have a live connection and a
  /// reason, actually send one.
  void _resetOutbound() {
    _idleTimer?.cancel();
    _idleTimer = null;
    _outboundActive = false;
  }
}
