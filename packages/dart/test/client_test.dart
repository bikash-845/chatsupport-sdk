import 'dart:async';
import 'dart:convert';

import 'package:dhaam_chat/dhaam_chat.dart';
// The typing timings are internal machinery rather than public surface, but
// they ARE observable behaviour of `ChatClient.typing`, so the tests that pin
// that behaviour reach for the real constants instead of restating them.
import 'package:dhaam_chat/src/logic/typing.dart';
import 'package:test/test.dart';

import 'fakes.dart';

final PublishableKey testKey = PublishableKey.parse('dhp_${'test'}_abc123XYZ');

const String _serverUlid = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

/// One server-relayed typing frame (§7.3). [participantId] is null for the
/// malformed case where the server relays typing attributed to nobody.
String typingJson(String type, String? participantId) =>
    jsonEncode(<String, Object?>{
      'v': 1,
      't': type,
      'id': _serverUlid,
      'ts': 1700000000000,
      'd': <String, Object?>{
        if (participantId != null) 'participantId': participantId,
      },
    });

String ackJson({int seq = 5, String sessionId = 's1'}) =>
    jsonEncode(<String, Object?>{
      'v': 1,
      't': 'connection.ack',
      'id': _serverUlid,
      'ts': 1700000000000,
      'd': <String, Object?>{
        'protocolVersion': 1,
        'seq': seq,
        'session': <String, Object?>{
          'sessionId': sessionId,
          'status': 'OPEN',
          'mode': 'BOT',
          'participants': <Object?>[],
          'createdAt': '2026-08-19T10:00:00.000Z',
        },
      },
    });

String ackFor(String ref, {int seq = 6}) => jsonEncode(<String, Object?>{
      'v': 1,
      't': 'ack',
      'id': _serverUlid,
      'ref': ref,
      'ts': 1700000000000,
      'd': <String, Object?>{'ok': true, 'seq': seq},
    });

String deliveredJson({int deliveredUpToSeq = 7}) =>
    jsonEncode(<String, Object?>{
      'v': 1,
      't': 'message.delivered',
      'id': _serverUlid,
      'ts': 1700000000000,
      'd': <String, Object?>{
        'participantId': 'agent-1',
        'deliveredUpToSeq': deliveredUpToSeq,
        'deliveredAt': '2026-08-19T12:00:00Z',
      },
    });

class Harness {
  Harness({String? localParticipantId}) {
    scheduler = FakeScheduler();
    client = ChatClient(
      wsUrl: Uri.parse('wss://example.test/v2'),
      publishableKey: testKey,
      getToken: () async => 'jwt',
      scheduler: scheduler,
      localParticipantId: localParticipantId,
      socketFactory: (Uri _) async {
        final FakeSocket socket = FakeSocket();
        sockets.add(socket);
        return socket;
      },
    );
  }

  late final FakeScheduler scheduler;
  late final ChatClient client;
  final List<FakeSocket> sockets = <FakeSocket>[];

  FakeSocket get socket => sockets.last;

  Future<void> connected() async {
    unawaited(client.connect());
    await flush();
    socket.deliver(ackJson());
    await flush();
  }
}

void main() {
  group('optimistic send (D1)', () {
    test('returns an echo whose id is already the permanent id', () async {
      final Harness harness = Harness();
      await harness.connected();

      final ChatMessage echo = harness.client.sendMessage('hello');

      expect(isValidUlid(echo.id), isTrue);
      expect(echo.delivery, equals(MessageDelivery.pending));
      expect(echo.seq, isNull);
      expect(echo.content, equals('hello'));

      // The id on the wire IS the id on the echo. There is no swap path.
      final Map<String, Object?> sent =
          jsonDecode(harness.socket.sent.last) as Map<String, Object?>;
      expect(sent['id'], equals(echo.id));
      expect(sent['t'], equals('message.send'));

      await harness.client.dispose();
    });

    test('confirms the same id on ack, never a different one', () async {
      final Harness harness = Harness();
      await harness.connected();

      final List<ChatMessage> seen = <ChatMessage>[];
      harness.client.messages.listen(seen.add);

      final ChatMessage echo = harness.client.sendMessage('hi');
      await flush();
      harness.socket.deliver(ackFor(echo.id, seq: 6));
      await flush();

      expect(seen, hasLength(2));
      expect(seen[0].id, equals(echo.id));
      expect(seen[1].id, equals(echo.id));
      expect(seen[0].delivery, equals(MessageDelivery.pending));
      expect(seen[1].delivery, equals(MessageDelivery.confirmed));
      expect(seen[1].seq, equals(6));

      await harness.client.dispose();
    });

    test('sends type on the wire even for a plain text message', () async {
      final Harness harness = Harness();
      await harness.connected();
      harness.client.sendMessage('hi');

      final Map<String, Object?> sent =
          jsonDecode(harness.socket.sent.last) as Map<String, Object?>;
      final Map<String, Object?> d = sent['d']! as Map<String, Object?>;
      expect(d['type'], equals('TEXT'));
      expect(sent['ts'], isA<int>());

      await harness.client.dispose();
    });

    test('ids of successive sends sort in send order', () async {
      // Within one millisecond the fake clock never advances, so only the
      // monotonic ULID keeps these ordered.
      final Harness harness = Harness();
      await harness.connected();

      final List<String> ids = <String>[
        for (int i = 0; i < 50; i++) harness.client.sendMessage('m$i').id,
      ];
      expect(ids, equals(List<String>.of(ids)..sort()));

      await harness.client.dispose();
    });

    test('holds a send when the socket is not connected', () async {
      // §6.3: sending never throws for "offline", because offline is a QUEUED
      // state and not a failure. The echo says so, so a host renders a clock
      // rather than a warning triangle, and the composer stays usable.
      final Harness harness = Harness();
      final ChatMessage echo = harness.client.sendMessage('offline');

      expect(echo.delivery, equals(MessageDelivery.queued));
      expect(harness.client.queuedCount, equals(1));

      await harness.client.dispose();
    });

    test('marks a send failed when the server rejects it', () async {
      final Harness harness = Harness();
      await harness.connected();

      final List<ChatMessage> seen = <ChatMessage>[];
      harness.client.messages.listen(seen.add);

      final ChatMessage echo = harness.client.sendMessage('hi');
      await flush();
      harness.socket.deliver(jsonEncode(<String, Object?>{
        'v': 1,
        't': 'ack',
        'id': _serverUlid,
        'ref': echo.id,
        'ts': 1700000000000,
        'd': <String, Object?>{
          'ok': false,
          'error': <String, Object?>{
            'code': 'RATE_LIMITED',
            'message': 'slow down',
            'retryable': true,
          },
        },
      }));
      await flush();

      // The server's own two facts, carried rather than dropped: a host can
      // now state WHY and decide whether to offer Retry without calling
      // `retry()` to find out.
      expect(
        seen.last.delivery,
        equals(
          const MessageFailed(
            reason: SendFailureReason.rejected,
            retryable: true,
            code: ErrorCode.rateLimited,
          ),
        ),
      );
      expect(seen.last.id, equals(echo.id));

      await harness.client.dispose();
    });
  });

  group('inbound routing', () {
    test('emits server messages with their seq', () async {
      final Harness harness = Harness();
      await harness.connected();

      final List<ChatMessage> seen = <ChatMessage>[];
      harness.client.messages.listen(seen.add);

      harness.socket.deliver(jsonEncode(<String, Object?>{
        'v': 1,
        't': 'message.new',
        'id': _serverUlid,
        'ts': 1700000000000,
        'd': <String, Object?>{
          'id': '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'sessionId': 's1',
          'senderId': 'agent-1',
          'senderType': 'AGENT',
          'type': 'TEXT',
          'content': 'hello back',
          'seq': 6,
          'createdAt': '2026-08-19T12:00:00.000Z',
        },
      }));
      await flush();

      expect(seen.single.seq, equals(6));
      expect(seen.single.senderType, equals(SenderType.agent));
      expect(seen.single.delivery, equals(MessageDelivery.confirmed));

      await harness.client.dispose();
    });

    test('emits the session snapshot from connection.ack', () async {
      final Harness harness = Harness();
      final List<SessionSnapshot> sessions = <SessionSnapshot>[];
      harness.client.sessions.listen(sessions.add);

      await harness.connected();

      expect(sessions.single.sessionId, equals('s1'));
      expect(sessions.single.status, equals(ChatStatus.open));

      await harness.client.dispose();
    });

    test('emits typing in both directions off one frame pair', () async {
      final Harness harness = Harness();
      await harness.connected();

      final List<TypingEvent> events = <TypingEvent>[];
      harness.client.typing.listen(events.add);

      for (final String type in <String>['typing.start', 'typing.stop']) {
        harness.socket.deliver(jsonEncode(<String, Object?>{
          'v': 1,
          't': type,
          'id': _serverUlid,
          'ts': 1700000000000,
          'd': <String, Object?>{'participantId': 'p1'},
        }));
      }
      await flush();

      expect(events.map((TypingEvent e) => e.isTyping),
          equals(<bool>[true, false]));
      expect(events.first.participantId, equals('p1'));

      await harness.client.dispose();
    });

    test('a typing.stop that never arrives still clears the indicator',
        () async {
      // The integrator-visible half of the bug: on a live server the stop is
      // genuinely lost (dropped frame, agent's socket dying mid-compose,
      // server restart) and the transcript keeps an "agent is typing" bubble
      // up forever. Driven by FakeScheduler — a five-second real delay here
      // would be a test nobody runs.
      final Harness harness = Harness();
      await harness.connected();

      final List<TypingEvent> events = <TypingEvent>[];
      harness.client.typing.listen(events.add);

      harness.socket.deliver(typingJson('typing.start', 'p1'));
      await flush();
      expect(events.map((TypingEvent e) => e.isTyping), equals(<bool>[true]));

      await harness.scheduler.advance(kRemoteTypingTimeout);
      await flush();

      expect(
        events.map((TypingEvent e) => e.isTyping),
        equals(<bool>[true, false]),
        reason: 'no typing.stop was ever delivered',
      );
      expect(events.last.participantId, equals('p1'));

      await harness.client.dispose();
    });

    test('the server echoing our own typing.start never reaches the stream',
        () async {
      // A server that relays typing back to its sender would otherwise light
      // up "someone is typing" in the customer's own transcript while they
      // type. §7.3 does not say whether it does, so the client is made
      // correct under either behaviour.
      final Harness harness = Harness(localParticipantId: 'me');
      await harness.connected();

      final List<TypingEvent> events = <TypingEvent>[];
      harness.client.typing.listen(events.add);

      harness.socket.deliver(typingJson('typing.start', 'me'));
      await flush();
      expect(events, isEmpty);

      // ...while a real agent still gets through.
      harness.socket.deliver(typingJson('typing.start', 'agent'));
      await flush();
      expect(events.single.participantId, equals('agent'));

      await harness.client.dispose();
    });

    test('a dropped transport clears typing rather than leaving it up',
        () async {
      // Backoff reaches 30 seconds, so "it clears itself in 5" is not an
      // answer here: the socket is gone and nobody is typing over it.
      final Harness harness = Harness();
      await harness.connected();

      final List<TypingEvent> events = <TypingEvent>[];
      harness.client.typing.listen(events.add);

      harness.socket.deliver(typingJson('typing.start', 'p1'));
      await flush();
      await harness.socket.drop();
      await flush();

      expect(events.map((TypingEvent e) => e.isTyping),
          equals(<bool>[true, false]));

      await harness.client.dispose();
    });

    test('ignores frames it does not act on without erroring', () async {
      // message.read, message.delivered, ticket.linked, system.pong are all
      // out of scope for this pass. Decoded and dropped is not an error.
      final Harness harness = Harness();
      await harness.connected();

      harness.socket.deliver(jsonEncode(<String, Object?>{
        'v': 1,
        't': 'message.delivered',
        'id': _serverUlid,
        'ts': 1700000000000,
        'd': <String, Object?>{
          'participantId': 'p1',
          'deliveredUpToSeq': 6,
          'deliveredAt': '2026-08-19T12:00:00.000Z',
        },
      }));
      await flush();

      expect(harness.client.connectionState, equals(ConnectionState.connected));

      await harness.client.dispose();
    });
  });

  group('outbound helpers', () {
    test('typing.start and typing.stop are the only typing frames', () async {
      // §7.3 collapses v1's four names (§12.4) into one pair.
      final Harness harness = Harness();
      await harness.connected();
      final int before = harness.socket.sent.length;

      harness.client
        ..startTyping()
        ..stopTyping();

      final List<String> types = harness.socket.sent
          .skip(before)
          .map((String raw) =>
              (jsonDecode(raw) as Map<String, Object?>)['t']! as String)
          .toList();
      expect(types, equals(<String>['typing.start', 'typing.stop']));

      await harness.client.dispose();
    });

    test('markRead is one write path, over WebSocket only', () async {
      // v1 fired a WS event AND a redundant REST POST for the same fact
      // (§12.9). There is no REST call here to be out of sync with.
      final Harness harness = Harness();
      await harness.connected();
      final int before = harness.socket.sent.length;

      harness.client.markRead(upToMessageId: 'm1');

      expect(harness.socket.sent.length, equals(before + 1));
      final Map<String, Object?> sent =
          jsonDecode(harness.socket.sent.last) as Map<String, Object?>;
      expect(sent['t'], equals('message.markRead'));

      await harness.client.dispose();
    });
  });

  group('receipts', () {
    test('message.delivered reaches messageDelivered as a seq watermark',
        () async {
      // The frame was decoded and dropped for one release, which made the
      // delivered tick unreachable: nothing else on this wire carries another
      // participant's delivery position, so a host had no value to render.
      final Harness harness = Harness();
      await harness.connected();

      final List<MessageDelivered> seen = <MessageDelivered>[];
      harness.client.messageDelivered.listen(seen.add);

      harness.socket.deliver(deliveredJson(deliveredUpToSeq: 7));
      await flush();

      expect(seen, hasLength(1));
      expect(seen.single.participantId, equals('agent-1'));
      expect(seen.single.deliveredUpToSeq, equals(7));
      expect(seen.single.deliveredAt.isUtc, isTrue);

      await harness.client.dispose();
    });

    test('a lower watermark is still delivered — this client does not dedupe',
        () async {
      // Monotonicity belongs to whoever keeps the per-participant map, not
      // here. Swallowing the regression at this layer would hide a replayed
      // frame (D2) from a host that legitimately wants to see every push.
      final Harness harness = Harness();
      await harness.connected();

      final List<MessageDelivered> seen = <MessageDelivered>[];
      harness.client.messageDelivered.listen(seen.add);

      harness.socket.deliver(deliveredJson(deliveredUpToSeq: 9));
      harness.socket.deliver(deliveredJson(deliveredUpToSeq: 4));
      await flush();

      expect(
        seen.map((MessageDelivered d) => d.deliveredUpToSeq),
        equals(<int>[9, 4]),
      );

      await harness.client.dispose();
    });

    test('ticket.linked reaches ticketLinked with its url', () async {
      // `TicketLinked` was exported from the barrel with no producer at all —
      // a host could name the type and never receive one.
      final Harness harness = Harness();
      await harness.connected();

      final List<TicketLinked> seen = <TicketLinked>[];
      harness.client.ticketLinked.listen(seen.add);

      harness.socket.deliver(
        jsonEncode(<String, Object?>{
          'v': 1,
          't': 'ticket.linked',
          'id': _serverUlid,
          'ts': 1700000000000,
          'd': <String, Object?>{
            'ticketId': 'tk_1',
            'ticketUrl': 'https://crm.example.test/t/1',
          },
        }),
      );
      await flush();

      expect(seen, hasLength(1));
      expect(seen.single.ticketId, equals('tk_1'));
      expect(
        seen.single.ticketUrl,
        equals('https://crm.example.test/t/1'),
      );

      await harness.client.dispose();
    });

    test('dispose closes ticketLinked', () async {
      final Harness harness = Harness();
      await harness.connected();

      bool done = false;
      harness.client.ticketLinked.listen(null, onDone: () => done = true);

      await harness.client.dispose();
      await flush();

      expect(done, isTrue);
    });

    test('dispose closes messageDelivered', () async {
      final Harness harness = Harness();
      await harness.connected();

      bool done = false;
      harness.client.messageDelivered.listen(null, onDone: () => done = true);

      await harness.client.dispose();
      await flush();

      expect(done, isTrue);
    });
  });

  group('identity routing', () {
    test('agent.joined reaches agentEvents as a HandledBy', () async {
      // The frames were declared long before they were emitted; this is the
      // first release where a host actually receives one, so the routing is
      // worth an end-to-end assertion rather than only a decoder unit test.
      final Harness harness = Harness();
      await harness.connected();

      final List<AgentEvent> seen = <AgentEvent>[];
      harness.client.agentEvents.listen(seen.add);

      harness.socket.deliver(
        jsonEncode(<String, Object?>{
          'v': 1,
          't': 'agent.joined',
          'id': _serverUlid,
          'ts': 1787228815136,
          'd': <String, Object?>{
            'kind': 'AGENT',
            'id': 'agent-1',
            'displayName': 'Priya S.',
          },
        }),
      );
      await flush();

      expect(seen, hasLength(1));
      expect(seen.single.kind, equals(HandledByKind.agent));
      expect(seen.single.id, equals('agent-1'));
      expect(seen.single.displayName, equals('Priya S.'));

      await harness.client.dispose();
    });

    test('a session snapshot carries handledBy through to sessions', () async {
      final Harness harness = Harness();
      final List<SessionSnapshot> seen = <SessionSnapshot>[];
      harness.client.sessions.listen(seen.add);

      unawaited(harness.client.connect());
      await flush();
      harness.socket.deliver(
        jsonEncode(<String, Object?>{
          'v': 1,
          't': 'connection.ack',
          'id': _serverUlid,
          'ts': 1700000000000,
          'd': <String, Object?>{
            'protocolVersion': 1,
            'seq': 5,
            'session': <String, Object?>{
              'sessionId': 's1',
              'status': 'ASSIGNED',
              'mode': 'HUMAN',
              'participants': <Object?>[
                <String, Object?>{
                  'participantId': 'agent-1',
                  'type': 'AGENT',
                  'displayName': 'Priya S.',
                },
              ],
              'createdAt': '2026-08-19T10:00:00.000Z',
              'handledBy': <String, Object?>{
                'kind': 'AGENT',
                'id': 'agent-1',
                'displayName': 'Priya S.',
              },
            },
          },
        }),
      );
      await flush();

      expect(seen, hasLength(1));
      expect(seen.single.handledBy?.displayName, equals('Priya S.'));
      expect(seen.single.participants.single.displayName, equals('Priya S.'));

      await harness.client.dispose();
    });
  });

  group('startNewSession', () {
    /// The `d` of the hello on socket [index].
    Map<String, Object?> helloOf(Harness harness, int index) =>
        (jsonDecode(harness.sockets[index].sent[0])
            as Map<String, Object?>)['d']! as Map<String, Object?>;

    /// Every `message.send` written to socket [index].
    List<Map<String, Object?>> sendsOn(Harness harness, int index) =>
        harness.sockets[index].sent
            .map((String raw) => jsonDecode(raw) as Map<String, Object?>)
            .where((Map<String, Object?> f) => f['t'] == 'message.send')
            .toList();

    test('asks the server for a new session, with the topic and subject',
        () async {
      final Harness harness = Harness();
      await harness.connected();

      final Future<void> started =
          harness.client.startNewSession(topic: 'Billing', subject: 'Refund');
      await flush();

      expect(harness.sockets.length, equals(2));
      final Map<String, Object?> hello = helloOf(harness, 1);
      expect(hello['newSession'], isTrue);
      expect(hello['topic'], equals('Billing'));
      expect(hello['subject'], equals('Refund'));

      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      await started;

      await harness.client.dispose();
    });

    test('genuinely forgets the resume anchor', () async {
      // The single reason disconnect() + connect() is not already a working
      // "start over": a surviving anchor makes the next hello claim a history
      // the server has closed, and the v2 endpoint answers that with a
      // NON-RETRYABLE VALIDATION_FAILED — suspended, not restarted.
      final Harness harness = Harness();
      unawaited(harness.client.connect());
      await flush();
      harness.socket.deliver(ackJson(seq: 12));
      await flush();
      expect(helloOf(harness, 0).containsKey('resumeFrom'), isFalse);

      final Future<void> started = harness.client.startNewSession();
      await flush();

      // Absent, not 0 — 0 means "replay everything" (D2). Had the anchor
      // survived, this would read 12.
      expect(helloOf(harness, 1).containsKey('resumeFrom'), isFalse);

      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      await started;

      await harness.client.dispose();
    });

    test('a plain reconnect still resumes — the anchor is not always dropped',
        () async {
      // The control for the test above. forgetResumeAnchor is for this
      // transition only; a client that dropped its anchor on every reconnect
      // would silently stop resuming.
      final Harness harness = Harness();
      unawaited(harness.client.connect());
      await flush();
      harness.socket.deliver(ackJson(seq: 12));
      await flush();

      await harness.socket.drop();
      await flush();
      await harness.scheduler.advanceToNextTimer();
      await flush();

      expect(helloOf(harness, 1)['resumeFrom'], equals(12));

      harness.socket.deliver(ackJson());
      await flush();
      await harness.client.dispose();
    });

    test('fails queued sends instead of draining them into the new session',
        () async {
      final Harness harness = Harness();
      await harness.connected();

      // Compose with no wire to write to, so the send is HELD in the outbox.
      await harness.socket.drop();
      await flush();
      final ChatMessage held = harness.client.sendMessage('about order 41');
      expect(held.delivery, equals(MessageDelivery.queued));
      expect(harness.client.queuedCount, equals(1));

      final List<ChatMessage> seen = <ChatMessage>[];
      harness.client.messages.listen(seen.add);

      final Future<void> started = harness.client.startNewSession();
      await flush();
      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      await started;

      // Failed, not delivered. An unsent question about a resolved order must
      // not become the opening line of a brand-new ticket.
      expect(harness.client.queuedCount, equals(0));
      expect(sendsOn(harness, 1), isEmpty);
      // `sessionClosed`, not `rejected`: no server ever saw this send, so
      // there is no §7.4 code and the verdict is `kDefaultRetryable`.
      expect(
        seen.where((ChatMessage m) => m.id == held.id).last.delivery,
        equals(
          const MessageFailed(
            reason: SendFailureReason.sessionClosed,
            retryable: kDefaultRetryable,
          ),
        ),
      );

      await harness.client.dispose();
    });

    test('fails in-flight sends too, which the disconnect would re-queue',
        () async {
      // The one that is easy to get wrong. An unacked send sits in _pending,
      // and the disconnect in step 2 moves everything there to the FRONT of
      // the outbox — so clearing only the outbox beforehand hands those
      // orphans straight to the new session one microtask later.
      final Harness harness = Harness();
      await harness.connected();

      final ChatMessage inFlight = harness.client.sendMessage('about order 41');
      expect(inFlight.delivery, equals(MessageDelivery.pending));

      final List<ChatMessage> seen = <ChatMessage>[];
      harness.client.messages.listen(seen.add);

      final Future<void> started = harness.client.startNewSession();
      await flush();
      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      await started;

      expect(harness.client.queuedCount, equals(0));
      expect(sendsOn(harness, 1), isEmpty);
      expect(
        seen.where((ChatMessage m) => m.id == inFlight.id).last.delivery,
        equals(
          const MessageFailed(
            reason: SendFailureReason.sessionClosed,
            retryable: kDefaultRetryable,
          ),
        ),
      );

      await harness.client.dispose();
    });

    test('an abandoned send stays retryable, under its original address',
        () async {
      // Failed, not deleted: the customer typed it, and a host renders it as
      // dead with a Retry affordance. The replay carries the ORIGINAL frame,
      // so it is still addressed to the old session — the server answers with
      // a real verdict rather than the message quietly joining the new
      // conversation.
      final Harness harness = Harness();
      await harness.connected();

      final ChatMessage inFlight = harness.client.sendMessage('about order 41');

      final Future<void> started = harness.client.startNewSession();
      await flush();
      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      await started;

      final RetryOutcome outcome = harness.client.retry(inFlight.id);
      expect(outcome, isA<RetryRetried>());

      final List<Map<String, Object?>> replayed = sendsOn(harness, 1);
      expect(replayed, hasLength(1));
      expect(replayed.single['id'], equals(inFlight.id));
      expect(
        (replayed.single['d']! as Map<String, Object?>)['sessionId'],
        equals('s1'),
      );

      await harness.client.dispose();
    });

    test('sends composed afterwards address the NEW session', () async {
      final Harness harness = Harness();
      await harness.connected();

      final Future<void> started = harness.client.startNewSession();
      await flush();
      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      await started;

      harness.client.sendMessage('a fresh question');

      final List<Map<String, Object?>> sends = sendsOn(harness, 1);
      expect(sends, hasLength(1));
      expect(
        (sends.single['d']! as Map<String, Object?>)['sessionId'],
        equals('s2'),
      );

      await harness.client.dispose();
    });

    test('pushes the new session snapshot', () async {
      final Harness harness = Harness();
      await harness.connected();

      final List<SessionSnapshot> seen = <SessionSnapshot>[];
      harness.client.sessions.listen(seen.add);

      final Future<void> started = harness.client.startNewSession();
      await flush();
      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      await started;

      expect(seen.last.sessionId, equals('s2'));

      await harness.client.dispose();
    });

    test('a first attempt that dies still asks on the retry', () async {
      // End to end through the client: the latch is what keeps a flaky
      // reconnect from silently dropping the customer back into the old
      // session.
      final Harness harness = Harness();
      await harness.connected();

      final Future<void> started =
          harness.client.startNewSession(topic: 'Billing');
      await flush();
      expect(helloOf(harness, 1)['newSession'], isTrue);

      // Dies before the new session's ack.
      await harness.socket.drop();
      await flush();
      await harness.scheduler.advanceToNextTimer();
      await flush();

      expect(harness.sockets.length, equals(3));
      expect(helloOf(harness, 2)['newSession'], isTrue);
      expect(helloOf(harness, 2)['topic'], equals('Billing'));

      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      await started;

      await harness.client.dispose();
    });

    test('completes only once the new session has acked', () async {
      final Harness harness = Harness();
      await harness.connected();

      bool done = false;
      unawaited(harness.client.startNewSession().then((_) => done = true));
      await flush();
      // The socket is up and the hello is out, but no session exists yet.
      expect(done, isFalse);

      harness.socket.deliver(ackJson(sessionId: 's2'));
      await flush();
      expect(done, isTrue);

      await harness.client.dispose();
    });
  });
}
