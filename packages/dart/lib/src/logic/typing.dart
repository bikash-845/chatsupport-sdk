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
    Duration remoteTimeout = kRemoteTypingTimeout,
  })  : _scheduler = scheduler,
        _onChanged = onChanged,
        _remoteTimeout = remoteTimeout {
    assertTypingTimings(
      remoteTimeout: remoteTimeout,
      startInterval: kTypingStartInterval,
      idleTimeout: kTypingIdleTimeout,
    );
  }

  final Scheduler _scheduler;
  final TypingStateChanged _onChanged;
  final Duration _remoteTimeout;

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
  void applyStart(String? participantId) {
    if (participantId == null) return;

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
    if (!_typers.containsKey(participantId)) return;

    _cancel(participantId);
    _onChanged(participantId, isTyping: false);
  }

  /// Clears everyone, reporting each as stopped.
  ///
  /// Called when the transport goes away. A socket that drops while an agent
  /// is mid-sentence would otherwise leave the indicator up for the remainder
  /// of the timeout, attributing live typing to a connection that no longer
  /// exists — and on reconnect the sender's next `typing.start` re-arms it
  /// anyway, so nothing is lost by clearing early.
  void reset() {
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
}
