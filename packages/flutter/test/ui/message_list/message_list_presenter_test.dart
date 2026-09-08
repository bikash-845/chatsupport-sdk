// Reproduces `message-list.test.ts:80-301` — the live-region block, the
// retry/failure block, and the naming rules — against the projection rather
// than against the DOM.

import 'package:dhaam_chat/dhaam_chat.dart';
import 'package:dhaam_chat_flutter/dhaam_chat_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

const String _me = 'cus_1';
const String _agentId = 'agt_9';
final DateTime _at = DateTime.utc(2026, 8, 19, 10);

ChatMessage _msg({
  required String id,
  String content = 'where is my order',
  SenderType senderType = SenderType.customer,
  String? senderId,
  int? seq,
  MessageDelivery delivery = MessageDelivery.confirmed,
  Map<String, Object?>? metadata,
  AttachmentMetadata? attachment,
}) {
  return ChatMessage(
    id: id,
    sessionId: 's1',
    senderId: senderId ?? (senderType == SenderType.customer ? _me : _agentId),
    senderType: senderType,
    type: MessageType.text,
    content: content,
    seq: seq,
    createdAt: _at,
    delivery: delivery,
    metadata: metadata,
    attachment: attachment,
  );
}

SessionSnapshot _session({
  String id = 's1',
  HandledBy? handledBy,
  List<ParticipantSnapshot> participants = const <ParticipantSnapshot>[],
}) {
  return SessionSnapshot(
    sessionId: id,
    status: ChatStatus.assigned,
    mode: ChatMode.human,
    participants: participants,
    createdAt: _at,
    handledBy: handledBy,
  );
}

MessageListInputs _inputs({
  required List<ChatMessage> messages,
  SessionSnapshot? session,
  String? local = _me,
  bool initialLoaded = false,
}) {
  return MessageListInputs(
    messages: messages,
    session: session,
    localParticipantId: local,
    initialLoaded: initialLoaded,
  );
}

void main() {
  group('the live region', () {
    test('stays silent on the first render, which is history loading', () {
      // INCOMING messages specifically: using our own would be suppressed by
      // the "never announce your own" rule anyway, and the test would pass
      // with the first-render guard deleted.
      final MessageListPresenter presenter = MessageListPresenter();
      final MessageListRender render = presenter.present(
        _inputs(
          messages: <ChatMessage>[
            _msg(id: 'a', senderType: SenderType.agent, content: 'hello'),
            _msg(id: 'b', senderType: SenderType.agent, content: 'on its way'),
          ],
        ),
      );
      expect(render.announcement, isNull);
    });

    test('announces an incoming message once it is live', () {
      final MessageListPresenter presenter = MessageListPresenter();
      presenter.present(_inputs(messages: <ChatMessage>[_msg(id: 'a')]));
      final MessageListRender render = presenter.present(
        _inputs(
          messages: <ChatMessage>[
            _msg(id: 'a'),
            _msg(
              id: 'b',
              senderType: SenderType.agent,
              content: 'ten minutes away',
            ),
          ],
        ),
      );
      expect(render.announcement, contains('ten minutes away'));
    });

    test("never announces the user's own message back to them", () {
      final MessageListPresenter presenter = MessageListPresenter();
      presenter.present(_inputs(messages: <ChatMessage>[_msg(id: 'a')]));
      final MessageListRender render = presenter.present(
        _inputs(
          messages: <ChatMessage>[
            _msg(id: 'a'),
            _msg(id: 'b', content: 'still waiting'),
          ],
        ),
      );
      expect(render.announcement, isNull);
    });

    test('suppresses our own even when the participant id is unknown', () {
      // The Dart port's one addition: this package's state layer does not
      // carry `localParticipantId`, so `isOutgoing` closes the window the
      // id would otherwise have covered.
      final MessageListPresenter presenter = MessageListPresenter();
      presenter.present(
        _inputs(messages: <ChatMessage>[_msg(id: 'a')], local: null),
      );
      final MessageListRender render = presenter.present(
        _inputs(
          messages: <ChatMessage>[
            _msg(id: 'a'),
            _msg(id: 'b', content: 'still waiting'),
          ],
          local: null,
        ),
      );
      expect(render.announcement, isNull);
    });

    test('does not re-announce when an unrelated field changes', () {
      // The watermark is the id, not the array length: a tick advancing does
      // not lengthen the array, and re-reading the message aloud on every
      // watermark update would make the widget unusable with a screen reader.
      final MessageListPresenter presenter = MessageListPresenter();
      final ChatMessage incoming = _msg(
        id: 'b',
        senderType: SenderType.agent,
        content: 'on its way',
        seq: 2,
      );

      presenter.present(_inputs(messages: <ChatMessage>[_msg(id: 'a')]));
      expect(
        presenter
            .present(
              _inputs(messages: <ChatMessage>[_msg(id: 'a'), incoming]),
            )
            .announcement,
        contains('on its way'),
      );

      final MessageListRender again = presenter.present(
        MessageListInputs(
          messages: <ChatMessage>[_msg(id: 'a'), incoming],
          localParticipantId: _me,
          deliveredWatermarks: const <String, int>{_agentId: 2},
        ),
      );
      expect(again.announcement, isNull);
    });

    test('describes an attachment rather than reading its url aloud', () {
      const String url = 'https://cdn.example.com/receipts/receipt.png';
      final MessageListPresenter presenter = MessageListPresenter();
      presenter.present(_inputs(messages: <ChatMessage>[_msg(id: 'a')]));
      final MessageListRender render = presenter.present(
        _inputs(
          messages: <ChatMessage>[
            _msg(id: 'a'),
            _msg(
              id: 'b',
              senderType: SenderType.agent,
              content: url,
              attachment: const AttachmentMetadata(
                url: url,
                fileName: 'receipt.png',
                mimeType: 'image/png',
                size: 10,
                mediaType: 'image',
              ),
            ),
          ],
        ),
      );
      expect(render.announcement, 'Agent: sent an image');
      expect(render.rows.last.text, '');
    });
  });

  group('failure and retry', () {
    test('offers retry, and no tick, on a failure core marked retryable', () {
      final MessageListRender render = MessageListPresenter().present(
        _inputs(
          messages: <ChatMessage>[
            _msg(
              id: 'a',
              seq: 5,
              delivery: const MessageFailed(
                reason: SendFailureReason.rejected,
                retryable: true,
              ),
            ),
          ],
        ),
      );
      final MessageRow row = render.rows.single;
      expect(row.showRetry, isTrue);
      // A tick would claim something untrue about a message that will never
      // arrive; the reason plus a retry button is the right affordance.
      expect(row.tick, isNull);
      // The failure is stated in words regardless of the button, and stays
      // stated once the button is present too.
      expect(row.failureText, 'This message could not be sent.');
    });

    test('bug #4: hides retry — and states why — on a non-retryable one', () {
      final MessageListRender render = MessageListPresenter().present(
        _inputs(
          messages: <ChatMessage>[
            _msg(
              id: 'a',
              delivery: const MessageFailed(
                reason: SendFailureReason.rejected,
                code: ErrorCode.sessionClosed,
                retryable: false,
              ),
            ),
          ],
        ),
      );
      final MessageRow row = render.rows.single;
      expect(row.showRetry, isFalse);
      expect(row.failureText, 'This message could not be sent.');
    });

    test('retryable is never re-derived from the reason or the code', () {
      // Same reason, same code, opposite answers — because the answer comes
      // from core and nothing here recomputes it.
      for (final bool retryable in <bool>[true, false]) {
        final MessageListRender render = MessageListPresenter().present(
          _inputs(
            messages: <ChatMessage>[
              _msg(
                id: 'a',
                delivery: MessageFailed(
                  reason: SendFailureReason.sessionClosed,
                  code: ErrorCode.sessionClosed,
                  retryable: retryable,
                ),
              ),
            ],
          ),
        );
        expect(render.rows.single.showRetry, retryable);
        expect(
          render.rows.single.failureText,
          'This conversation ended before this message could send.',
        );
      }
    });

    test('clears the failure line once a message stops being failed', () {
      final MessageListPresenter presenter = MessageListPresenter();
      final MessageListRender failed = presenter.present(
        _inputs(
          messages: <ChatMessage>[
            _msg(
              id: 'a',
              delivery: const MessageFailed(
                reason: SendFailureReason.rejected,
                retryable: true,
              ),
            ),
          ],
        ),
      );
      expect(failed.rows.single.failureText, isNotNull);

      final MessageListRender confirmed = presenter.present(
        _inputs(messages: <ChatMessage>[_msg(id: 'a', seq: 3)]),
      );
      expect(confirmed.rows.single.failureText, isNull);
      expect(confirmed.rows.single.showRetry, isFalse);
    });

    test('the row carries the REAL message, placeholder and all', () {
      // The related bug: retry used to be able to send '' for an attachment
      // message because something read the SUPPRESSED bubble text.
      const String url = 'https://cdn.example.com/receipts/receipt.png';
      const AttachmentMetadata attachment = AttachmentMetadata(
        url: url,
        fileName: 'receipt.png',
        mimeType: 'image/png',
        size: 10,
        mediaType: 'image',
      );
      final MessageListRender render = MessageListPresenter().present(
        _inputs(
          messages: <ChatMessage>[
            _msg(
              id: 'att-1',
              content: url,
              attachment: attachment,
              delivery: const MessageFailed(
                reason: SendFailureReason.rejected,
                retryable: true,
              ),
            ),
          ],
        ),
      );
      final MessageRow row = render.rows.single;
      // Confirms the suppression really did fire on this fixture...
      expect(row.text, '');
      // ...and that what a retry would be handed is untouched.
      expect(row.message.id, 'att-1');
      expect(row.message.content, url);
      expect(row.message.attachment, same(attachment));
    });
  });

  group('naming a run', () {
    test('names the first bubble of a run, and every avatar', () {
      final MessageListRender render = MessageListPresenter().present(
        _inputs(
          messages: <ChatMessage>[
            _msg(id: 'a', senderType: SenderType.agent),
            _msg(id: 'b', senderType: SenderType.agent),
            _msg(id: 'c'),
            _msg(id: 'd', senderType: SenderType.agent),
          ],
          session: _session(
            participants: const <ParticipantSnapshot>[
              ParticipantSnapshot(
                participantId: _agentId,
                type: ParticipantType.agent,
                displayName: 'Priya',
              ),
            ],
          ),
        ),
      );

      expect(
        render.rows.map((MessageRow r) => r.showAuthorName).toList(),
        <bool>[true, false, false, true],
      );
      // The avatar is NOT gated on being first in a run.
      expect(
        render.rows.map((MessageRow r) => r.avatarLetter).toList(),
        <String?>['P', 'P', null, 'P'],
      );
      // ...and never the customer's own row.
      expect(render.rows[2].senderName, isNull);
      expect(render.rows[2].replyAttribution, 'You');
    });

    test('the avatar letter comes from the resolved name, upper-cased', () {
      final MessageListRender render = MessageListPresenter().present(
        _inputs(
          messages: <ChatMessage>[_msg(id: 'a', senderType: SenderType.bot)],
          session: _session(
            handledBy: const HandledBy(
              kind: HandledByKind.bot,
              id: 'bot_1',
              displayName: 'kai',
            ),
          ),
        ),
      );
      expect(render.rows.single.senderName, 'kai');
      expect(render.rows.single.avatarLetter, 'K');
    });

    test('an agent run interrupted by the bot re-names on resumption', () {
      final MessageListRender render = MessageListPresenter().present(
        _inputs(
          messages: <ChatMessage>[
            _msg(id: 'a', senderType: SenderType.agent),
            _msg(id: 'b', senderType: SenderType.system),
            _msg(id: 'c', senderType: SenderType.agent),
          ],
        ),
      );
      expect(
        render.rows.map((MessageRow r) => r.senderName).toList(),
        <String?>['Agent', 'System', 'Agent'],
      );
      expect(
        render.rows.map((MessageRow r) => r.showAuthorName).toList(),
        <bool>[true, true, true],
      );
    });
  });

  group('the remembered bot name', () {
    test("keeps the bot's earlier bubbles named after an escalation", () {
      final MessageListPresenter presenter = MessageListPresenter();
      final ChatMessage botMessage =
          _msg(id: 'a', senderType: SenderType.bot, content: 'hi');

      presenter.present(
        _inputs(
          messages: <ChatMessage>[botMessage],
          session: _session(
            handledBy: const HandledBy(
              kind: HandledByKind.bot,
              id: 'bot_1',
              displayName: 'Kai',
            ),
          ),
        ),
      );
      expect(presenter.lastBotName, 'Kai');

      // Escalated: `handledBy` now names the AGENT, and nothing on the wire
      // still carries the bot's name.
      final MessageListRender after = presenter.present(
        _inputs(
          messages: <ChatMessage>[
            botMessage,
            _msg(id: 'b', senderType: SenderType.agent),
          ],
          session: _session(
            handledBy: const HandledBy(
              kind: HandledByKind.agent,
              id: _agentId,
              displayName: 'Priya',
            ),
          ),
        ),
      );
      expect(after.rows.first.senderName, 'Kai');
      expect(after.rows.last.senderName, 'Priya');
    });

    test('drops the remembered name when the session id changes', () {
      // One conversation's bot name must never be printed over another's
      // messages.
      final MessageListPresenter presenter = MessageListPresenter();
      presenter.present(
        _inputs(
          messages: <ChatMessage>[_msg(id: 'a', senderType: SenderType.bot)],
          session: _session(
            handledBy: const HandledBy(
              kind: HandledByKind.bot,
              id: 'bot_1',
              displayName: 'Kai',
            ),
          ),
        ),
      );

      final MessageListRender switched = presenter.present(
        _inputs(
          messages: <ChatMessage>[_msg(id: 'z', senderType: SenderType.bot)],
          session: _session(id: 's2'),
        ),
      );
      expect(presenter.lastBotName, isNull);
      expect(switched.rows.single.senderName, 'Assistant');
    });

    test('the typing label names the handler, not the fixed word Agent', () {
      final MessageListPresenter presenter = MessageListPresenter();
      final MessageListRender render = presenter.present(
        _inputs(
          messages: const <ChatMessage>[],
          session: _session(
            handledBy: const HandledBy(
              kind: HandledByKind.bot,
              id: 'bot_1',
              displayName: 'Kai',
            ),
          ),
        ),
      );
      expect(render.typingLabel, 'Kai is typing');

      final MessageListRender fallback = MessageListPresenter().present(
        _inputs(messages: const <ChatMessage>[]),
      );
      expect(fallback.typingLabel, 'Agent is typing');
    });

    test('the typing avatar takes its letter from the same handler', () {
      // One derivation, not two. A disc fed from `session.assignedAgent`
      // while the label came from `handledBy` would put the agent's initial
      // beside the bot's name for as long as both are resolvable.
      final MessageListRender render = MessageListPresenter().present(
        _inputs(
          messages: const <ChatMessage>[],
          session: _session(
            handledBy: const HandledBy(
              kind: HandledByKind.bot,
              id: 'bot_1',
              displayName: 'Kai',
            ),
          ),
        ),
      );
      expect(render.typingLabel, 'Kai is typing');
      expect(render.typingAvatarLetter, 'K');

      // The generic fallback still gets a disc — 'Agent' is a name for this
      // purpose, and a bubble that loses its disc at that moment jumps left.
      expect(
        MessageListPresenter()
            .present(_inputs(messages: const <ChatMessage>[]))
            .typingAvatarLetter,
        'A',
      );
    });

    test('after an escalation the typing row names the AGENT', () {
      // `handlerName` answers "who holds the session", which is not the same
      // question as "who wrote this bubble". Once a session escalates,
      // `handledBy` names the human — and the bot name the presenter still
      // remembers for the transcript's earlier bubbles must NOT leak onto
      // the typing row, or the customer watches "Kai is typing" while a
      // person called Nadia is the one composing.
      final MessageListPresenter presenter = MessageListPresenter();
      presenter.present(
        _inputs(
          messages: <ChatMessage>[_msg(id: 'a', senderType: SenderType.bot)],
          session: _session(
            handledBy: const HandledBy(
              kind: HandledByKind.bot,
              id: 'bot_1',
              displayName: 'Kai',
            ),
          ),
        ),
      );
      expect(presenter.lastBotName, 'Kai');

      final MessageListRender escalated = presenter.present(
        _inputs(
          messages: <ChatMessage>[_msg(id: 'a', senderType: SenderType.bot)],
          session: _session(
            handledBy: const HandledBy(
              kind: HandledByKind.agent,
              id: 'agt_9',
              displayName: 'Nadia',
            ),
          ),
        ),
      );
      expect(escalated.typingLabel, 'Nadia is typing');
      expect(escalated.typingAvatarLetter, 'N');
      // ...and the bot's own earlier bubble keeps its name, which is the
      // reason `lastBotName` exists at all.
      expect(escalated.rows.single.senderName, 'Kai');
    });
  });

  group('the empty state', () {
    test('says "no messages yet" only once it knows there are none', () {
      final MessageListPresenter presenter = MessageListPresenter();
      // Before the first page comes back, an empty list means "nobody has
      // asked yet".
      expect(
        presenter
            .present(_inputs(messages: const <ChatMessage>[]))
            .showEmptyState,
        isFalse,
      );
      expect(
        presenter
            .present(
              _inputs(messages: const <ChatMessage>[], initialLoaded: true),
            )
            .showEmptyState,
        isTrue,
      );
      expect(
        presenter
            .present(
              _inputs(
                messages: <ChatMessage>[_msg(id: 'a')],
                initialLoaded: true,
              ),
            )
            .showEmptyState,
        isFalse,
      );
    });
  });

  group('isNearBottom', () {
    test('follows the list down within 40 logical pixels', () {
      expect(isNearBottom(pixels: 960, maxScrollExtent: 1000), isTrue);
      expect(isNearBottom(pixels: 959.9, maxScrollExtent: 1000), isFalse);
      // Sub-pixel remainders are exactly what the tolerance exists for.
      expect(isNearBottom(pixels: 999.5, maxScrollExtent: 1000), isTrue);
      expect(kNearBottomTolerancePx, 40);
    });
  });
}
