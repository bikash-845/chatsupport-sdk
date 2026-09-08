import 'package:dhaam_chat/src/logic/typing.dart';
import 'package:test/test.dart';

import '../fakes.dart';

/// One recorded `onChanged` call, so a test can assert on order as well as
/// content — "who was reported, and in what sequence" is most of what this
/// module gets wrong when it gets anything wrong.
class _Change {
  const _Change(this.participantId, {required this.isTyping});

  final String participantId;
  final bool isTyping;

  @override
  String toString() => '$participantId:${isTyping ? 'start' : 'stop'}';

  // Value equality by hand — `package:equatable` is `packages/flutter`'s
  // dependency, and `packages/dart` has exactly one (`web_socket_channel`).
  @override
  bool operator ==(Object other) =>
      other is _Change &&
      other.participantId == participantId &&
      other.isTyping == isTyping;

  @override
  int get hashCode => Object.hash(participantId, isTyping);
}

void main() {
  late FakeScheduler scheduler;
  late List<_Change> changes;

  TypingController build(
          {Duration? remoteTimeout, String? localParticipantId}) =>
      TypingController(
        scheduler: scheduler,
        onChanged: (String id, {required bool isTyping}) =>
            changes.add(_Change(id, isTyping: isTyping)),
        remoteTimeout: remoteTimeout ?? kRemoteTypingTimeout,
        localParticipantId: localParticipantId,
      );

  setUp(() {
    scheduler = FakeScheduler();
    changes = <_Change>[];
  });

  group('receive-side auto-clear', () {
    test('a lost typing.stop still clears the indicator', () async {
      // THE bug. The server relays a start and the matching stop never
      // arrives — dropped frame, agent's socket died mid-compose, server
      // restart. Without the timer the indicator stays up for the life of
      // the process.
      final TypingController controller = build();
      controller.applyStart('p1');

      expect(changes, equals(<_Change>[const _Change('p1', isTyping: true)]));

      await scheduler.advance(kRemoteTypingTimeout);

      expect(
        changes,
        equals(<_Change>[
          const _Change('p1', isTyping: true),
          const _Change('p1', isTyping: false),
        ]),
      );
      expect(controller.typers, isEmpty);
    });

    test('does not clear before the timeout is actually reached', () async {
      // Guards the other direction: a net that fires early is a flicker, and
      // would be "fixed" by deleting the net.
      final TypingController controller = build();
      controller.applyStart('p1');

      await scheduler
          .advance(kRemoteTypingTimeout - const Duration(seconds: 1));

      expect(changes, hasLength(1));
      expect(controller.typers, equals(<String>['p1']));
    });

    test('a refresh re-arms the window, so sustained typing never blinks',
        () async {
      // The sender's 3s cadence exists to land inside the 5s window. Four
      // refreshes at 3s cover 12 seconds of continuous typing, and the
      // indicator must survive all of it with no stop reported.
      final TypingController controller = build();
      controller.applyStart('p1');

      for (int i = 0; i < 4; i++) {
        await scheduler.advance(kTypingStartInterval);
        controller.applyStart('p1');
      }

      expect(
        changes,
        equals(<_Change>[const _Change('p1', isTyping: true)]),
        reason: 'a keepalive refresh is not a state change (§6.5)',
      );
      expect(controller.typers, equals(<String>['p1']));

      // ...and once the refreshes stop, the net still catches it.
      await scheduler.advance(kRemoteTypingTimeout);
      expect(changes.last, equals(const _Change('p1', isTyping: false)));
    });

    test('a delivered stop disarms the timer rather than racing it', () async {
      // A stop that arrived normally must not be followed by a second,
      // manufactured stop when the original timer would have fired.
      final TypingController controller = build();
      controller.applyStart('p1');
      controller.applyStop('p1');

      await scheduler.advance(const Duration(minutes: 1));

      expect(
        changes,
        equals(<_Change>[
          const _Change('p1', isTyping: true),
          const _Change('p1', isTyping: false),
        ]),
      );
      expect(scheduler.pending, isZero, reason: 'the timer must be cancelled');
    });

    test('a stop for someone not typing is silent', () {
      final TypingController controller = build();
      controller.applyStop('ghost');
      expect(changes, isEmpty);
    });

    test('an inbound frame naming nobody is dropped, not shown', () {
      // It cannot be keyed, so it cannot be auto-cleared; showing it would
      // raise the one indicator that provably cannot come down. Matches
      // `typing.ts:203`.
      final TypingController controller = build();
      controller
        ..applyStart(null)
        ..applyStop(null);

      expect(changes, isEmpty);
      expect(scheduler.pending, isZero);
    });
  });

  group('self-echo filter', () {
    test('a server that echoes our own typing.start does not light us up', () {
      // §7.3 does not say whether the server relays a start back to the
      // sender. If it does and we apply it, the customer watches a "someone
      // is typing" bubble follow their own keystrokes in their own
      // transcript.
      final TypingController controller = build(localParticipantId: 'me');
      controller.applyStart('me');

      expect(changes, isEmpty);
      expect(controller.typers, isEmpty);
      expect(
        scheduler.pending,
        isZero,
        reason: 'a filtered frame must not arm a timer either',
      );
    });

    test('our own echoed stop is dropped too', () {
      final TypingController controller = build(localParticipantId: 'me');
      controller.applyStop('me');
      expect(changes, isEmpty);
    });

    test('everybody else still comes through', () {
      // The filter must be an equality test on one id, not a mute button.
      final TypingController controller = build(localParticipantId: 'me');
      controller
        ..applyStart('me')
        ..applyStart('agent');

      expect(controller.typers, equals(<String>['agent']));
      expect(
        changes,
        equals(<_Change>[const _Change('agent', isTyping: true)]),
      );
    });

    test('a host that names nobody filters nothing', () {
      // Null disables the filter (`typing.ts:184`) rather than guessing at an
      // id on the host's behalf.
      final TypingController controller = build();
      controller.applyStart('me');

      expect(
        changes,
        equals(<_Change>[const _Change('me', isTyping: true)]),
      );
    });
  });

  group('per-participant state (§12.9 multi-agent)', () {
    test('one agent stopping does not clear another who is still typing', () {
      // The concrete bug a single slot has, and the reason this is a map.
      final TypingController controller = build();
      controller
        ..applyStart('a')
        ..applyStart('b')
        ..applyStop('a');

      expect(controller.typers, equals(<String>['b']));
      expect(
        changes,
        equals(<_Change>[
          const _Change('a', isTyping: true),
          const _Change('b', isTyping: true),
          const _Change('a', isTyping: false),
        ]),
      );
    });

    test('each participant times out on their own schedule', () async {
      final TypingController controller = build();
      controller.applyStart('a');
      await scheduler.advance(const Duration(seconds: 2));
      controller.applyStart('b');

      // 'a' is 5s in, 'b' only 3s in.
      await scheduler.advance(const Duration(seconds: 3));
      expect(controller.typers, equals(<String>['b']));

      await scheduler.advance(const Duration(seconds: 2));
      expect(controller.typers, isEmpty);
    });

    test('a refresh moves the refreshed typer to most-recent', () {
      // Insertion order is what a host reads to name a single typer.
      final TypingController controller = build();
      controller
        ..applyStart('a')
        ..applyStart('b')
        ..applyStart('a');

      expect(controller.typers, equals(<String>['b', 'a']));
    });
  });

  group('lifecycle', () {
    test('reset clears everyone and reports each as stopped', () async {
      final TypingController controller = build();
      controller
        ..applyStart('a')
        ..applyStart('b');
      changes.clear();

      controller.reset();

      expect(
        changes,
        equals(<_Change>[
          const _Change('a', isTyping: false),
          const _Change('b', isTyping: false),
        ]),
      );
      expect(controller.typers, isEmpty);
      expect(scheduler.pending, isZero);

      // No manufactured stop afterwards from a timer that outlived the reset.
      await scheduler.advance(const Duration(minutes: 1));
      expect(changes, hasLength(2));
    });

    test('dispose cancels timers without reporting into a closing stream',
        () async {
      final TypingController controller = build();
      controller.applyStart('a');
      changes.clear();

      controller.dispose();

      expect(changes, isEmpty);
      expect(scheduler.pending, isZero, reason: 'a pending timer is a leak');

      await scheduler.advance(const Duration(minutes: 1));
      expect(changes, isEmpty);
    });
  });

  group('timing invariants', () {
    test('the shipped defaults satisfy the relationship they depend on', () {
      // The 5s net is only a net because the sender refreshes faster than it.
      expect(kTypingStartInterval, lessThan(kRemoteTypingTimeout));
      expect(kTypingIdleTimeout, lessThan(kRemoteTypingTimeout));
      expect(
        () => assertTypingTimings(
          remoteTimeout: kRemoteTypingTimeout,
          startInterval: kTypingStartInterval,
          idleTimeout: kTypingIdleTimeout,
        ),
        returnsNormally,
      );
    });

    test('a remote timeout at or below the refresh cadence is refused', () {
      // Configured this way the indicator blinks during sustained typing, and
      // it looks like a protocol fault rather than a settings mistake.
      expect(
        () => build(remoteTimeout: kTypingStartInterval),
        throwsA(isA<ArgumentError>()),
      );
      expect(
        () => build(remoteTimeout: const Duration(seconds: 1)),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('a non-positive timeout is refused', () {
      expect(
        () => build(remoteTimeout: Duration.zero),
        throwsA(isA<ArgumentError>()),
      );
    });
  });
}
