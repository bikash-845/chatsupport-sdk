// The scrollback, its ticks, and the announcement channel behind it.
//
// ── Ticks come from core, always ────────────────────────────────────────
//
// `deriveTickState` is imported and called. This file computes nothing about
// delivery: not from `presence`, not from `seq` alone, not "if the agent is
// online". That is the exact bug v1 shipped — it drew the double tick from
// connectivity, which is a claim about a socket rather than about a message —
// and core's ticks.ts exists so no binding has to get it right a second time.
//
// ── Rendering is keyed, not wholesale ───────────────────────────────────
//
// A naive `log.replaceChildren(...messages.map(render))` on every state change
// is a paragraph shorter and wrong in four ways a user notices: it destroys
// any text selection mid-drag, it re-decodes every image attachment on every
// keystroke of a typing indicator, it makes the `<audio>` element restart, and
// it moves focus off any focused retry button. So elements are keyed by
// message id, created once, and patched in place.

import { deriveTickState } from '@dhaam-ccrm/js';
import type { ChatMessage, ChatState, MessageTickState } from '@dhaam-ccrm/js';
// Straight from core: `@dhaam-ccrm/js` re-exports the whole of `ChatState`'s
// shape EXCEPT `AttachmentMetadata`/`SendFailureReason`'s sibling copy here,
// even though `ChatMessage.attachment`/`.delivery` are typed with them — so a
// binding consumer cannot name the type of a field the binding hands them.
// Reported as a gap in that package; imported from the source here rather
// than restated locally.
import type { AttachmentMetadata, CloseReason, SendFailureReason } from '@dhaam-ccrm/core';

import { ICONS, el, icon } from './dom.js';
import { createMessageActions } from './message-actions.js';
import { renderLinkified } from './linkify.js';
import { createQuickReplies, readQuickReplies } from './quick-replies.js';

/** Glyph plus the phrase a screen reader gets. The phrase is not optional. */
const TICK_PRESENTATION: Record<MessageTickState, { glyph: string; label: string }> = {
  pending: { glyph: '○', label: 'Sending' },
  sent: { glyph: '✓', label: 'Sent' },
  delivered: { glyph: '✓✓', label: 'Delivered' },
  read: { glyph: '✓✓', label: 'Read' },
};

/**
 * What a failed send says, per `SendFailureReason` (state/types.ts). Shown
 * on EVERY failure, whether or not a Retry button accompanies it — a
 * `Record` so the compiler catches a reason core adds that this list has not
 * been taught to describe.
 */
const FAILURE_REASON_COPY: Record<SendFailureReason, string> = {
  rejected: 'This message could not be sent.',
  sessionClosed: 'This conversation ended before this message could send.',
  expired: 'This message took too long to send.',
  evicted: 'Too many messages were waiting to send.',
  storage: 'This message could not be saved on this device.',
};

/**
 * What the closing line says, per §12.5 `CloseReason`.
 *
 * "Resolved" and "closed" are not interchangeable to a customer: the first
 * says their problem was dealt with, the second only that the conversation
 * ended. Reporting the second as the first is the kind of small dishonesty
 * that makes someone re-open a ticket to check.
 *
 * `SWITCHED` has an entry only so this record stays total. It is a *parked*
 * reason (`isParkedCloseReason`) — the session is not over, and widget.ts
 * filters it out before it can reach here, so this copy should never render.
 */
const CLOSURE_COPY: Record<CloseReason, string> = {
  RESOLVED: 'This conversation was marked resolved.',
  MANUAL: 'This conversation was closed.',
  SWITCHED: 'This conversation was moved.',
};

export interface MessageListCallbacks {
  readonly onRetry: (message: ChatMessage) => void;
  readonly onLoadOlder: () => void;
  /** The customer asking for a fresh conversation after this one ended. */
  readonly onStartNewConversation: () => void;
  /** Emails the conversation to the address already on file. Rejects on failure. */
  readonly onEmailTranscript: () => Promise<void>;
  /** Sends one of the bot's suggested follow-ups as the customer's next message. */
  readonly onQuickReply: (text: string) => void;
  /** Puts the message's text on the clipboard. Rejects if the browser refuses. */
  readonly onCopyMessage: (message: ChatMessage) => Promise<void>;
  /**
   * Starts a reply addressed to this message.
   *
   * `senderName` rides along because only THIS file can resolve it: a
   * `ChatMessage` carries no display name (see {@link senderLabel}), and the
   * widget needs the name for the composer's quote chip and for the send's
   * `reply` metadata without re-deriving it from state a second way.
   */
  readonly onReplyToMessage: (message: ChatMessage, senderName: string) => void;
  /**
   * The tenant's live `behaviour.handoffKeywords`, for filtering the bot's
   * suggested replies — see `readQuickReplies`. A getter rather than an
   * array because a config publish can change the list under a mounted
   * widget, and this list does not hear about publishes.
   */
  readonly handoffKeywords?: () => readonly string[];
}

export interface MessageListView {
  readonly log: HTMLElement;
  readonly liveRegion: HTMLElement;
  render(state: ChatState, localParticipantId: string | null): void;

  /**
   * Marks the conversation ended, or `null` to clear it for a new one.
   *
   * The transcript is deliberately left in place: the history is still valid
   * and the customer may well want to re-read what the agent told them.
   */
  setClosure(reason: CloseReason | null): void;

  /**
   * Whether the merchant offers an emailed transcript. Off by default, so a
   * build whose config never landed shows no control rather than one that
   * fails when pressed.
   */
  setTranscriptEmail(enabled: boolean): void;

  /**
   * Marks the new-conversation request in flight.
   *
   * Disabling the control is what stops a second click from minting a second
   * session — the transition is a socket round trip, which is long enough for
   * an impatient double-click to land inside.
   */
  setStartingNewConversation(busy: boolean): void;
}

export function createMessageList(callbacks: MessageListCallbacks): MessageListView {
  const loadOlder = el('button', {
    attrs: { class: 'dh-more', type: 'button', hidden: true },
    text: 'Load earlier messages',
    on: { click: () => callbacks.onLoadOlder() },
  });

  const empty = el('p', {
    attrs: { class: 'dh-empty' },
    text: 'No messages yet.',
  });

  const log = el('div', {
    attrs: {
      class: 'dh-log',
      // `log` rather than `feed`: this is a chronological conversation whose
      // relevant end is the newest entry, which is exactly what `log` means.
      // `feed` implies article-level navigation this UI does not implement.
      role: 'log',
      'aria-label': 'Conversation',
      // The list itself is NOT the live region — see `liveRegion` below.
      'aria-live': 'off',
      // Focusable so a keyboard user can scroll the history without a mouse;
      // a scrollable region that cannot take focus is unreachable by keyboard.
      tabindex: '0',
    },
    children: [loadOlder, empty],
  });

  // The announcement channel. Separate from `log` on purpose: marking the log
  // itself `aria-live` would announce the entire backfill every time older
  // messages load, and would re-announce our own outgoing message the instant
  // its optimistic echo appears — telling the user what they just typed.
  const liveRegion = el('div', {
    attrs: { class: 'dh-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });

  // The closing line and the way out of it. A `<p>` plus a real `<button>`,
  // matching `dh-empty`/`dh-more` above: same hand-authored chrome, same
  // keyboard behaviour, and the button's accessible name is its visible text.
  const closureText = el('p', { attrs: { class: 'dh-system-text' } });
  const closureAction = el('button', {
    attrs: { class: 'dh-system-action', type: 'button' },
    text: 'Start a new conversation',
    on: { click: () => callbacks.onStartNewConversation() },
  });
  /**
   * `behaviour.transcriptEmail` — "Sent when the chat ends, if you have their
   * address", which is why it lives in the closure block and nowhere else.
   *
   * Hidden until {@link MessageListView.setTranscriptEmail} enables it, so a
   * merchant with the setting off — or a build talking to a chat-service too
   * old to have the endpoint — shows no control at all rather than one that
   * fails when pressed.
   *
   * Its label changes rather than disappearing on success: the address is the
   * one already on file, which the widget deliberately never echoes back, so
   * "Sent" is the whole of what it can honestly say.
   */
  const transcriptAction = el('button', {
    attrs: { class: 'dh-system-action', type: 'button', hidden: true },
    text: 'Email me a transcript',
    on: {
      click: () => {
        transcriptAction.disabled = true;
        transcriptAction.textContent = 'Sending…';
        void callbacks
          .onEmailTranscript()
          .then(() => {
            transcriptAction.textContent = 'Transcript sent';
          })
          .catch(() => {
            // Re-armed, and honest about it. A control that stays on "Sending…"
            // after a failure tells the customer their transcript is on its way
            // when nothing was sent.
            transcriptAction.disabled = false;
            transcriptAction.textContent = "Couldn't send — try again";
          });
      },
    },
  });

  const closure = el('div', {
    attrs: {
      class: 'dh-system',
      hidden: true,
      // Not a live region of its own. There is exactly one announcement
      // channel in this file (`liveRegion`) and `setClosure` speaks through
      // it — a second one would race the first and double-announce.
      role: 'group',
      'aria-label': 'Conversation ended',
    },
    children: [closureText, closureAction, transcriptAction],
  });
  log.appendChild(closure);

  // The bot's own suggestions. One row reused across renders — see the
  // module's note on why it is not per-message.
  const quickReplies = createQuickReplies((text) => callbacks.onQuickReply(text));
  log.appendChild(quickReplies.node);

  const typing = createTypingIndicator();
  log.appendChild(typing.node);

  /** id → rendered row, so a re-render patches rather than rebuilds. */
  const rows = new Map<string, MessageRow>();
  let announcedUpTo: string | null = null;
  let seenAnyState = false;
  let closedReason: CloseReason | null = null;
  /** The bot's name for the session in {@link lastBotNameSessionId}. See `render`. */
  let lastBotName: string | null = null;
  let lastBotNameSessionId: string | null = null;

  function render(state: ChatState, localParticipantId: string | null): void {
    // Captured BEFORE mutating: reading `scrollTop` after an append gives the
    // post-append value and would make "was the user at the bottom" always
    // true for a growing list.
    const wasAtBottom = isNearBottom(log);

    // `initialLoaded`, not `messages.length` alone: an empty list before the
    // first page has come back means "not asked yet", and "No messages yet.
    // Ask us anything" is a lie in that window — it tells a customer with a
    // year of history that their conversation is empty, for as long as the
    // fetch takes. It is also the window a session switch re-enters, where the
    // wrong answer would flash on every switch.
    empty.hidden = state.messages.length > 0 || !state.pagination.initialLoaded;
    loadOlder.hidden = !state.pagination.hasMore;
    loadOlder.disabled = state.pagination.loadingMore;
    loadOlder.textContent = state.pagination.loadingMore
      ? 'Loading…'
      : 'Load earlier messages';

    // The bot's name is only on the wire while the BOT still holds the
    // session; after a hand-off it is gone and its earlier bubbles would go
    // back to the generic word. Remembered per session, and dropped the moment
    // the session changes so one conversation's bot name can never be printed
    // over another's messages.
    const sessionId = state.session?.id ?? null;
    if (sessionId !== lastBotNameSessionId) {
      lastBotNameSessionId = sessionId;
      lastBotName = null;
    }
    lastBotName = botNameFrom(state) ?? lastBotName;

    const live = new Set<string>();
    let previous: Node = loadOlder;
    // Names the FIRST message of each run only — see `MessageRow.update`.
    let previousAuthor: string | null = null;

    for (const message of state.messages) {
      live.add(message.id);
      let row = rows.get(message.id);
      if (row === undefined) {
        row = createRow(message, callbacks);
        rows.set(message.id, row);
      }

      // Only incoming messages are named. "You" over the customer's own
      // bubble tells them nothing they do not already know, and the bubble is
      // already aligned and coloured as theirs. `senderName` (unlike
      // `showAuthorName` below) is not suppressed for a continued run — the
      // avatar draws from it on every row; see `MessageRow.update`'s doc.
      const senderName = isOutgoing(message) ? null : senderLabel(message, state, lastBotName);
      const showAuthorName = senderName !== null && senderName !== previousAuthor;
      previousAuthor = senderName;

      row.update(message, deriveTickState({
        message,
        localParticipantId,
        deliveredWatermarks: state.deliveredWatermarks,
        readWatermarks: state.readWatermarks,
      }), senderName, showAuthorName);

      // Keeps DOM order equal to core's array order without a full rebuild.
      // Core may reorder on a `seq` arriving late (D2), so position is
      // asserted every pass rather than assumed from insertion.
      if (previous.nextSibling !== row.node) {
        log.insertBefore(row.node, previous.nextSibling);
      }
      previous = row.node;
    }

    for (const [id, row] of rows) {
      if (live.has(id)) continue;
      // Before removal: the action menu holds a document-level `pointerdown`
      // listener, which outlives the node it belongs to unless released.
      row.destroy();
      row.node.remove();
      rows.delete(id);
    }

    // The bot's suggested follow-ups, from the NEWEST message and only while
    // it is the bot's own. Older ones are stale by construction — they were
    // answers to a question two turns ago — and the customer's own message
    // arriving is what retires them.
    //
    // Appended before the closure so they sit with the message they belong to;
    // a closed conversation clears them below, because a suggestion that would
    // reopen nothing is a dead control.
    const newestMessage = state.messages[state.messages.length - 1];
    const suggestions =
      closedReason === null && newestMessage !== undefined && !isOutgoing(newestMessage)
        ? readQuickReplies(newestMessage.metadata, callbacks.handoffKeywords?.() ?? [])
        : [];
    quickReplies.update(suggestions);
    log.appendChild(quickReplies.node);

    // The closing line sits after the transcript it closes, and before the
    // typing bubble, so the reading order matches the order things happened.
    log.appendChild(closure);

    // Typing bubble stays last so it reads as "someone is composing the next
    // message", not as an interruption in the middle of history.
    log.appendChild(typing.node);
    typing.update(state, handlerName(state, lastBotName));

    announce(state, localParticipantId);

    if (wasAtBottom) scrollToBottom(log);
  }

  /**
   * Speaks the newest INCOMING message, once.
   *
   * Three filters, each removing a real annoyance: our own messages are never
   * announced (the user wrote them), nothing is announced on the first state
   * we see (that is history loading, and announcing 40 messages on open is
   * hostile), and a message already announced is never repeated when an
   * unrelated field on it changes — which is why the watermark is the id
   * rather than the array length, since a tick update does not lengthen the
   * array but a retry-then-succeed does reorder it.
   */
  function announce(state: ChatState, localParticipantId: string | null): void {
    const newest = state.messages[state.messages.length - 1];

    if (!seenAnyState) {
      seenAnyState = true;
      announcedUpTo = newest?.id ?? null;
      return;
    }
    if (newest === undefined) return;
    if (newest.id === announcedUpTo) return;

    announcedUpTo = newest.id;
    if (localParticipantId !== null && newest.senderId === localParticipantId) return;

    const who = senderLabel(newest, state, lastBotName);
    liveRegion.textContent = `${who}: ${describeContent(newest)}`;
  }

  function setClosure(reason: CloseReason | null): void {
    if (reason === closedReason) return;
    const previous = closedReason;
    closedReason = reason;

    closure.hidden = reason === null;
    // Drives `.dh-log[data-closed="true"] .dh-retry { display: none }`. A
    // retry button on a closed session is the dead end this whole change
    // exists to remove: the send would be queued against a session that can
    // never accept it. The way forward is the button below, not that one.
    log.setAttribute('data-closed', String(reason !== null));

    if (reason === null) return;
    closureText.textContent = CLOSURE_COPY[reason];

    // Announced once per closure, through the file's single channel. Guarded
    // on the previous value rather than fired unconditionally because
    // `setClosure` is driven from a state subscription that may re-run for
    // reasons that have nothing to do with the session ending, and a screen
    // reader repeating "this conversation was marked resolved" every time an
    // unrelated field changes is worse than not saying it at all.
    if (previous === null) {
      liveRegion.textContent = `${CLOSURE_COPY[reason]} You can start a new conversation.`;
    }
  }

  function setStartingNewConversation(busy: boolean): void {
    closureAction.disabled = busy;
    closureAction.textContent = busy ? 'Starting…' : 'Start a new conversation';
  }

  function setTranscriptEmail(enabled: boolean): void {
    transcriptAction.hidden = !enabled;
  }

  return { log, liveRegion, render, setClosure, setStartingNewConversation, setTranscriptEmail };
}

/**
 * What a reply-carrying message quotes. Parsed from the metadata bag, never
 * trusted — see {@link readReplyQuote}.
 */
export interface ReplyQuote {
  readonly senderName: string;
  readonly excerpt: string;
}

/**
 * Longest excerpt a quote block will render.
 *
 * The wire contract (agreed with the console team) caps the excerpt at 120
 * characters, but this record arrives over the socket from another
 * participant's client, so the cap is enforced again here rather than assumed
 * — the quote is context for a message, and one that outgrows the message it
 * sits above has inverted the hierarchy.
 */
const MAX_QUOTE_EXCERPT = 160;

/**
 * `metadata: { kind: 'reply', replyTo: {…} }` → the quote to draw, or `null`.
 * Never throws — same defensive posture as `readQuickReplies`, for the same
 * reason: the bag is another client's data.
 *
 * Exported for tests: a pure function of the bag, and the half worth
 * asserting exhaustively.
 */
export function readReplyQuote(metadata: unknown): ReplyQuote | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const bag = metadata as Record<string, unknown>;
  if (bag['kind'] !== 'reply') return null;

  const ref = bag['replyTo'];
  if (typeof ref !== 'object' || ref === null) return null;
  const { senderName, excerpt } = ref as Record<string, unknown>;
  if (typeof senderName !== 'string' || typeof excerpt !== 'string') return null;

  const name = senderName.trim();
  const text = excerpt.trim();
  // Both or nothing: a quote naming nobody, or naming someone who said
  // nothing, reads as a rendering bug rather than as context.
  if (name === '' || text === '') return null;

  return {
    senderName: name,
    excerpt: text.length > MAX_QUOTE_EXCERPT ? `${text.slice(0, MAX_QUOTE_EXCERPT - 1)}…` : text,
  };
}

interface MessageRow {
  readonly node: HTMLElement;
  /**
   * @param senderName who actually wrote this message (agent/bot/system),
   *   or `null` for the customer's own — the source for the avatar, which
   *   this file draws on EVERY such row.
   * @param showAuthorName whether `senderName` should also be printed as
   *   text above the bubble — only the first bubble of a run from the same
   *   sender; see the module's note on why the avatar does not share this
   *   gate.
   */
  update(
    message: ChatMessage,
    tick: MessageTickState | null,
    senderName: string | null,
    showAuthorName: boolean,
  ): void;
  /** Releases the row's document-level listeners. See `createMessageActions`. */
  destroy(): void;
}

function createRow(initial: ChatMessage, callbacks: MessageListCallbacks): MessageRow {
  // Who wrote this. Above the text rather than in `meta` alongside the
  // timestamp: the customer needs to know who is speaking BEFORE they read
  // the words, and a name discovered underneath them arrives too late to
  // frame what they just read.
  const author = el('span', { attrs: { class: 'dh-msg-author', hidden: true } });
  // The per-message identity cue the module header calls out as the gap this
  // whole file otherwise has: before this, the only place a customer ever
  // saw WHO they were talking to was the panel's title bar. Present on EVERY
  // incoming row, not just the first of a run — unlike `author` above, which
  // is deliberately a heading for the run rather than a per-line label.
  //
  // The disc reuses the header avatar's OWN class (`.dh-avatar`, styled off
  // `--dh-accent` — see ui/styles.ts) so the two read as the same component
  // family, but never the header's actual content: that disc's letters come
  // from the merchant's own configured initials, which name the BRAND, not
  // whoever sent this particular message. The letter here always comes from
  // `senderName` below — the exact same resolution `senderLabel` already
  // does for the visible author heading — so an agent's or the bot's own
  // resolved name is what shows, never a stand-in for it.
  //
  // `aria-hidden`: a screen reader already gets this message's sender from
  // the visible `author` text when this is the first bubble of a run, and
  // gets nothing extra for a later bubble in the same run today — same as a
  // sighted reader, who has only the earlier heading and alignment to go on.
  // This disc is a sighted-only convenience on top of that existing rule,
  // not a new source of truth, so hiding it from assistive tech announces
  // nothing twice and withholds nothing that was available before.
  const avatar = el('span', {
    attrs: { class: 'dh-avatar dh-msg-avatar', 'aria-hidden': 'true', hidden: true },
  });
  const body = el('span', { attrs: { class: 'dh-msg-body' } });
  const time = el('time', { attrs: { class: 'dh-msg-time' } });
  const tickGlyph = el('span', { attrs: { class: 'dh-tick', 'aria-hidden': 'true' } });
  const tickLabel = el('span', { attrs: { class: 'dh-sr' } });
  // Shown on EVERY failure, retryable or not — see `FAILURE_REASON_COPY`.
  // This is what a permanently-refused send falls back to once `retry`
  // below is hidden: the customer is told why, even with no button to press.
  const failureText = el('span', { attrs: { class: 'dh-failure', hidden: true } });
  const retry = el('button', {
    attrs: { class: 'dh-retry', type: 'button', hidden: true },
    text: 'Retry',
  });
  const meta = el('div', {
    attrs: { class: 'dh-msg-meta' },
    children: [time, tickGlyph, tickLabel, failureText, retry],
  });

  // Copy and Reply. Built per row because both act on THIS message; the
  // menu's own document listener is released through `destroy` below.
  // `currentSenderLabel` (kept fresh by `update`) is the resolved name the
  // reply quote will carry — the customer's own rows resolve to 'You', which
  // is also what WhatsApp prints when someone quotes themselves.
  const actions = createMessageActions({
    onCopy: () => callbacks.onCopyMessage(current),
    onReply: () => callbacks.onReplyToMessage(current, currentSenderLabel),
  });

  // The quoted message this one replies to, WhatsApp-style: a quiet strip
  // above the message's own words, name on top. Drawn from the message's OWN
  // `reply` metadata — the quoted message may have scrolled out of the loaded
  // page entirely, so the excerpt travels with the reply rather than being
  // looked up.
  const quoteName = el('span', { attrs: { class: 'dh-quote-name' } });
  const quoteText = el('span', { attrs: { class: 'dh-quote-text' } });
  const quote = el('span', {
    attrs: { class: 'dh-msg-quote', hidden: true },
    children: [quoteName, quoteText],
  });

  // The bubble's own visual — background, padding, shape — lives on this
  // inner element rather than on `node` itself, so `node` can be a plain row
  // holding the avatar BESIDE the bubble without painting the avatar into
  // the bubble's own coloured background.
  const bubble = el('div', {
    attrs: { class: 'dh-msg-bubble' },
    children: [author, quote, body, meta],
  });

  const node = el('div', {
    attrs: { class: 'dh-msg' },
    children: [avatar, bubble, actions.node],
  });

  let current = initial;
  /** The resolved name for this row's sender — see the actions comment above. */
  let currentSenderLabel = 'You';
  retry.addEventListener('click', () => callbacks.onRetry(current));

  let attachmentNode: HTMLElement | null = null;

  return {
    node,
    destroy() {
      actions.destroy();
    },
    update(message, tick, senderName, showAuthorName) {
      current = message;
      currentSenderLabel = senderName ?? 'You';

      // The quote is compared before rewriting, like `body` below, and for
      // the same reason: an unrelated re-render (a tick change, a typing
      // flap) must not destroy a text selection inside it.
      const replyQuote = readReplyQuote(message.metadata);
      quote.hidden = replyQuote === null;
      if (replyQuote !== null) {
        // `textContent` on both — a name and an excerpt are another party's
        // data, exactly as `author` above says of its own.
        if (quoteName.textContent !== replyQuote.senderName) {
          quoteName.textContent = replyQuote.senderName;
        }
        if (quoteText.textContent !== replyQuote.excerpt) {
          quoteText.textContent = replyQuote.excerpt;
        }
      }

      // `false` means "do not name this one" — the customer's own messages,
      // and every message after the first in a run from the same sender.
      // Repeating the name on each of five consecutive bot replies is noise
      // that pushes the words themselves off the screen.
      if (!showAuthorName) {
        author.hidden = true;
        author.textContent = '';
      } else {
        author.hidden = false;
        // `textContent`: a display name is another party's data.
        if (author.textContent !== senderName) author.textContent = senderName ?? '';
      }

      // The avatar, unlike the heading above, is not gated on being first in
      // a run — see its construction comment for why every incoming row
      // carries one.
      if (senderName === null) {
        avatar.hidden = true;
      } else {
        avatar.hidden = false;
        // One character: `.dh-avatar`'s CSS uppercases it, matching the
        // header avatar's own convention of leaving case to CSS rather than
        // baking it into the string (ui/styles.ts).
        const letter = senderName.trim().slice(0, 1);
        if (avatar.textContent !== letter) avatar.textContent = letter;
      }

      node.setAttribute('data-mine', String(isOutgoing(message)));
      node.setAttribute('data-failed', String(message.delivery?.state === 'failed'));

      // Still never `innerHTML`. `renderLinkified` builds text nodes and
      // `<a>` elements by hand and runs every href through the same allowlist
      // the branding link uses — see ui/linkify.ts's header for why that file
      // is the one place allowed to turn this string into elements.
      //
      // Compared before rewriting so an unrelated re-render does not destroy a
      // text selection the customer is in the middle of making.
      const shown = visibleContent(message);
      if (body.textContent !== shown) renderLinkified(body, shown);

      const created = new Date(message.createdAt);
      const iso = Number.isNaN(created.getTime()) ? '' : created.toISOString();
      if (time.getAttribute('datetime') !== iso) {
        time.setAttribute('datetime', iso);
        time.textContent = Number.isNaN(created.getTime())
          ? ''
          : created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      }

      if (attachmentNode === null && message.attachment !== undefined) {
        attachmentNode = renderAttachment(message.attachment);
        bubble.insertBefore(attachmentNode, meta);
      }

      const presentation = tick === null ? null : TICK_PRESENTATION[tick];
      tickGlyph.textContent = presentation?.glyph ?? '';
      tickGlyph.setAttribute('data-state', tick ?? '');
      // The tick's meaning as words. Colour distinguishes `read` from
      // `delivered` visually; this is what distinguishes them otherwise.
      tickLabel.textContent = presentation === null ? '' : ` ${presentation.label}`;

      // Bug #4: this used to be `retry.hidden = !failed`, which showed Retry
      // for EVERY failure — including one the server (or core, locally) has
      // already refused as non-retryable, e.g. `code: 'SESSION_CLOSED'`.
      // Retrying that exact send is refused identically every time
      // (`MessageDelivery.retryable`'s own doc: it "mirrors the server's
      // `ErrorPayload.retryable`... the server already computes this once
      // per code"), so a button offering it is a lie the customer has no way
      // to detect until they click it. `delivery.retryable` is core's own
      // canonical answer — never re-derived here from `reason` or `code`,
      // the same reasoning `deriveTickState` gets for ticks.
      if (message.delivery?.state === 'failed') {
        const { reason, retryable } = message.delivery;
        failureText.textContent = FAILURE_REASON_COPY[reason];
        failureText.hidden = false;
        retry.hidden = !retryable;
        if (retryable) retry.setAttribute('aria-label', `Retry sending this message`);
      } else {
        failureText.hidden = true;
        failureText.textContent = '';
        retry.hidden = true;
      }
    },
  };
}

/**
 * Renders one attachment.
 *
 * Images are shown inline; everything else is a link. `rel="noreferrer"` is
 * not decoration — an attachment URL is served by the customer's own storage
 * and the referrer would otherwise leak the host page's URL (which on a
 * food-ordering site contains an order id) to it.
 */
function renderAttachment(attachment: AttachmentMetadata): HTMLElement {
  // Typed as core's shape but read defensively: this record arrives over the
  // socket from another participant's client, so the compiler's guarantee is
  // about our own call sites, not about what the server actually sent.
  const url = typeof attachment.url === 'string' ? attachment.url : '';
  const name = typeof attachment.fileName === 'string' && attachment.fileName !== ''
    ? attachment.fileName
    : 'Attachment';
  const mime = typeof attachment.mimeType === 'string' ? attachment.mimeType : '';

  // Only http(s) and blob. An attacker-supplied `javascript:` URL in an
  // attachment record would otherwise become a one-click script execution
  // inside the host's page.
  const safe = /^(https?:|blob:)/i.test(url) ? url : '';

  if (safe !== '' && mime.startsWith('image/')) {
    const img = el('img', {
      attrs: { class: 'dh-attachment-image', src: safe, alt: name, loading: 'lazy', decoding: 'async' },
    });
    return el('div', { children: [img] });
  }

  if (safe !== '' && mime.startsWith('audio/')) {
    const audio = el('audio', { attrs: { class: 'dh-audio', controls: true, src: safe, preload: 'none' } });
    return el('div', {
      children: [audio, el('span', { attrs: { class: 'dh-sr' }, text: `Voice message: ${name}` })],
    });
  }

  if (safe === '') return el('div', { attrs: { class: 'dh-attachment' }, text: name });

  return el('a', {
    attrs: { class: 'dh-attachment', href: safe, target: '_blank', rel: 'noopener noreferrer', download: name },
    children: [icon(ICONS.paperclip, 14), el('span', { text: name })],
  });
}

function createTypingIndicator(): {
  node: HTMLElement;
  /** @param who the name of whoever is typing — see `handlerName`. */
  update(state: ChatState, who: string): void;
} {
  const dots = [0, 1, 2].map(() => el('span', { attrs: { class: 'dh-typing-dot' } }));
  // Screen-reader-only, and named: the three animated dots say SOMEONE is
  // composing, and this is the only channel that can say who. It used to be
  // the fixed word "Agent", which named a human on a session being handled by
  // the bot.
  const label = el('span', { attrs: { class: 'dh-sr' }, text: 'Agent is typing' });
  const node = el('div', {
    attrs: {
      class: 'dh-typing',
      hidden: true,
      // Deliberately not a live region. A typing indicator that announces
      // itself interrupts the message the user is actually reading, and it
      // can flap several times a second.
      'aria-hidden': 'false',
    },
    children: [...dots, label],
  });

  return {
    node,
    update(state, who) {
      node.hidden = !state.typing.isTyping;
      const text = `${who} is typing`;
      if (label.textContent !== text) label.textContent = text;
    },
  };
}

/**
 * The name of whoever is handling the conversation right now — an agent if one
 * is on it, otherwise the bot, falling back to the generic word only when
 * neither has a resolved name.
 *
 * Same sources as {@link senderLabel}, kept separate because this answers "who
 * holds the session" (for the typing indicator) rather than "who wrote this
 * message" (for a bubble), and a transcript can contain both.
 */
function handlerName(state: ChatState, lastBotName: string | null): string {
  const handledBy = state.session?.handledBy;
  if (handledBy !== undefined) return handledBy.displayName;
  return state.session?.assignedAgent?.displayName ?? lastBotName ?? 'Agent';
}

function isOutgoing(message: ChatMessage): boolean {
  return message.senderType === 'CUSTOMER';
}

/**
 * The name to put on one incoming message.
 *
 * Every name here comes from `ChatState.session`, because that is the only
 * place a name exists: `ChatMessage` carries `senderId` and no display name at
 * all (core's state/types.ts), so a bubble cannot name its own author.
 *
 * ── The BOT branch was a hardcoded string ────────────────────────────────
 *
 * It returned the literal `'Assistant'` for every deployment, which threw away
 * the per-tenant bot name the backend resolves and sends
 * (`Tenant.config.botDisplayName` → `resolveBotDisplayName` →
 * `SessionSnapshot.handledBy`). A tenant who names their bot "Kai" got
 * "Assistant" on every bubble regardless.
 *
 * `lastBotName` covers the case `handledBy` cannot: once a session escalates
 * to a human, `handledBy` names the AGENT, and the bot's earlier messages —
 * still in the transcript, right above the agent's — would fall back to the
 * generic word. The name is remembered per session (cleared when the session
 * id changes, see `render`) rather than re-derived, because nothing else on
 * the wire still carries it at that point.
 *
 * AGENT prefers `assignedAgent` and falls back to a `handledBy` that names an
 * agent: on a session the customer has just joined from history, `participants`
 * may be empty (everyone has left) while `handledBy` still names who had it.
 */
function senderLabel(message: ChatMessage, state: ChatState, lastBotName: string | null): string {
  const handledBy = state.session?.handledBy;

  if (message.senderType === 'AGENT') {
    return (
      state.session?.assignedAgent?.displayName ??
      (handledBy?.kind === 'AGENT' ? handledBy.displayName : undefined) ??
      'Agent'
    );
  }
  if (message.senderType === 'SYSTEM') return 'System';
  if (message.senderType === 'BOT') {
    if (handledBy?.kind === 'BOT') return handledBy.displayName;
    return lastBotName ?? 'Assistant';
  }
  return 'You';
}

/** The bot's name as this session currently reports it, or `null`. */
function botNameFrom(state: ChatState): string | null {
  const handledBy = state.session?.handledBy;
  return handledBy?.kind === 'BOT' ? handledBy.displayName : null;
}

/**
 * The text to show in the bubble and read aloud, with core's wire-shape
 * quirk subtracted out.
 *
 * Per §12.10 (packages/core/src/messages/controller.ts), a plain-attachment
 * message arrives with `content` SET TO `attachment.url` — a placeholder for
 * clients that predate attachment rendering, not a caption. Showing or
 * speaking that URL is the bug; suppressing it is the fix. The comparison is
 * against `attachment.url` specifically, not "an attachment is present",
 * because an agent can send a real caption alongside an attachment and that
 * caption is a distinct string from the url — it must still render and be
 * announced.
 *
 * Both the row's body text and `describeContent` call this so the two can
 * never diverge — a caption visible in the bubble but unannounced (or vice
 * versa) is the same bug class this function exists to close.
 */
function visibleContent(message: ChatMessage): string {
  // Optional chaining, not `!== undefined` plus a direct `.url` read: this
  // record arrives over the socket from another participant's client (see
  // `renderAttachment`'s comment above), so `attachment` being present is a
  // compile-time guarantee about our own call sites, not a runtime one about
  // what the server actually sent. A present-but-null `attachment` would
  // otherwise throw here, on `render()` — the one path that repaints the
  // whole scrollback — freezing the UI.
  if (message.attachment?.url !== undefined && message.content === message.attachment.url) {
    return '';
  }
  return message.content;
}

/**
 * What the live region says. Once `visibleContent` has suppressed the
 * attachment-url placeholder (see above), there are no words left in
 * `content` for a screen reader to read, so the mime family supplies them.
 */
function describeContent(message: ChatMessage): string {
  const shown = visibleContent(message);
  if (shown.trim() !== '') return shown;
  if (message.attachment !== undefined) {
    const mime = typeof message.attachment.mimeType === 'string' ? message.attachment.mimeType : '';
    if (mime.startsWith('image/')) return 'sent an image';
    if (mime.startsWith('audio/')) return 'sent a voice message';
    return 'sent a file';
  }
  return 'sent a message';
}

/**
 * Whether the user is close enough to the bottom that new messages should
 * follow them down.
 *
 * A tolerance rather than `=== 0`, because sub-pixel scroll positions and
 * fractional device pixel ratios mean an "at the bottom" list routinely
 * reports a remainder of 0.5 to 2px, and an exact test would silently stop
 * auto-scrolling on exactly the high-DPI phones this is aimed at.
 */
function isNearBottom(log: HTMLElement, tolerancePx = 40): boolean {
  const remaining = log.scrollHeight - log.scrollTop - log.clientHeight;
  return remaining <= tolerancePx;
}

function scrollToBottom(log: HTMLElement): void {
  log.scrollTop = log.scrollHeight;
}
