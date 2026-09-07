// The Home screen — the first thing the panel shows.
//
// Mirrors the reference product's `ChatHome`: the merchant's greeting, one
// prominent "start a conversation" card, the most recent conversation with a
// way to see the rest, and the merchant's Common Questions.
//
// ── What this does NOT own ───────────────────────────────────────────────
//
// The hero header above it, and the Common Questions list itself. Both already
// exist (`ui/hero-header.ts`, `ui/common-questions.ts`), are already driven by
// published config, and are already tested. This screen arranges them; it does
// not re-implement either, and a second Common Questions renderer would be a
// second place for one console setting to be interpreted.

import { el, icon, ICONS } from './dom.js';
import { relativeTimeLabel } from './session-picker.js';
import { statusPill } from './session-status.js';
import type { ChatSessionSummary } from '@dhaam-ccrm/js';
import type { ResolvedEntry } from '../remote-config.js';

export interface HomeScreenCallbacks {
  /** Start a fresh conversation. */
  readonly onStartNew: () => void;
  /** Open the conversation named by id. */
  readonly onOpenConversation: (sessionId: string) => void;
  /** Go to the full conversation list. */
  readonly onSeeAll: () => void;
  /** Row 1's alt and row 2's CTA — hand the visitor to the web-form surface. */
  readonly onLeaveMessage: () => void;
  /** Row 2's alt — reach a real chat despite the tenant being closed. */
  readonly onChooseChat: () => void;
}

export interface HomeScreenView {
  readonly node: HTMLElement;
  /**
   * @param recent the newest conversation, or `null` when there is none —
   *   which is the case for every first-time visitor, and the reason the
   *   whole "Recent conversation" section is conditional rather than an
   *   empty-state box.
   * @param entry the resolved support entry — which of the six PRD rows this
   *   render is for. Drives the CTA's title/sub-line, the alt button beside
   *   it, and the mid-visit chat→ticket announcement.
   */
  update(recent: ChatSessionSummary | null, subtitle: string, entry: ResolvedEntry): void;
}

/**
 * The CTA's title and sub-line for `entry`.
 *
 * A three-entry table, keyed on `primary` — NOT a table of all six rows,
 * because the CTA only ever says one of three things. `source` is checked
 * FIRST and separately from `primary`: an `'assumed'` entry's `primary` is
 * always `'chat'` (see `entryFor`), and without this guard that would take
 * the 'chat' branch below and start showing "Chat now" — a claim of
 * knowledge — on every deployment that has not yet published a `support`
 * block, which is every deployment on the day this ships. Today's exact
 * copy, "Send us a message", is what an assumed entry gets instead.
 */
function ctaCopy(entry: ResolvedEntry, subtitle: string): { readonly title: string; readonly sub: string } {
  if (entry.source === 'published' && entry.primary === 'ticket') {
    return {
      title: 'Leave a message',
      // Row 2 (chat also on, but closed) vs row 5 (chat never offered): the
      // widget must not imply a live human is waiting either way, but row 2
      // alone gets to say the team is closed, because only there was a live
      // option ever on the table.
      sub: entry.secondary === 'chat' ? "We're closed — we'll reply by email." : "We'll reply by email.",
    };
  }
  if (entry.source === 'published' && entry.primary === 'chat') {
    return { title: 'Chat now', sub: subtitle };
  }
  // Assumed, offline, or none: today's copy, byte-identical. Rows 4 and 6
  // either keep this card's pre-chooser behaviour or never render it at all
  // (row 6 hides the whole launcher — see `shouldMount`).
  return { title: 'Send us a message', sub: subtitle };
}

/** The alt button beneath the CTA, or `null` for a row that offers none. */
function altFor(entry: ResolvedEntry): { readonly label: string; readonly kind: 'ticket' | 'chat' } | null {
  if (entry.source !== 'published') return null;
  if (entry.secondary === 'ticket') return { label: 'Leave a message instead', kind: 'ticket' };
  if (entry.secondary === 'chat') return { label: 'Try live chat anyway', kind: 'chat' };
  return null;
}

export function createHomeScreen(callbacks: HomeScreenCallbacks): HomeScreenView {
  // The primary action. A card rather than a button, because it carries a
  // second line — the response-time promise the merchant configured — and a
  // button with two lines of different weight is a card that has not admitted
  // it yet.
  const ctaSubtitle = el('span', { attrs: { class: 'dh-home-cta-sub' } });
  const ctaTitle = el('span', { attrs: { class: 'dh-home-cta-title' }, text: 'Send us a message' });
  // Reassigned on every `update()`, same as `recentRow.onclick` below —
  // rebuilding the button itself would take it out from under a visitor
  // mid-press, the same reason the launcher glyph lives in a slot.
  let onCtaPress: () => void = callbacks.onStartNew;
  const cta = el('button', {
    attrs: { class: 'dh-home-cta', type: 'button' },
    children: [
      el('span', { attrs: { class: 'dh-home-cta-icon' }, children: [icon(ICONS.chat, 20)] }),
      el('span', { attrs: { class: 'dh-home-cta-text' }, children: [ctaTitle, ctaSubtitle] }),
      el('span', { attrs: { class: 'dh-home-chevron', 'aria-hidden': 'true' }, text: '›' }),
    ],
    on: { click: () => onCtaPress() },
  });

  // The alt affordance beside the CTA — Row 1's "Leave a message instead" or
  // Row 2's "Try live chat anyway". A real `<button>` with a visible text
  // label, not an `<a>` (it navigates nowhere).
  //
  // Its own class, deliberately NOT `.dh-form-skip`: that class already means
  // something specific in every test and every other surface — "the one Skip
  // /Cancel control in the currently-open form" — and this button sits on
  // Home, permanently in the DOM (hidden, not removed) whichever screen is
  // showing. Sharing the class made `.dh-form-skip` stop being unique the
  // moment a surface with its own Skip button was open at the same time,
  // which broke an existing, unrelated pre-chat test that queries for
  // exactly that uniqueness. `.dh-home-alt` gets `.dh-form-skip`'s LOOK
  // (styles.ts) without its identity.
  let onAltPress: () => void = () => undefined;
  const alt = el('button', {
    attrs: { class: 'dh-home-alt', type: 'button', hidden: true },
    on: { click: () => onAltPress() },
  });

  // The mid-visit chat→ticket announcement — `role="status"`, never `alert`,
  // for the reason `ui/offline-banner.ts` already gives about interrupting a
  // screen reader mid-sentence. Hidden until a flip is actually observed.
  const notice = el('p', {
    attrs: { class: 'dh-entry-note', role: 'status', 'aria-live': 'polite', hidden: true },
  });

  // ── Recent conversation ────────────────────────────────────────────────
  const recentTitle = el('span', { attrs: { class: 'dh-home-recent-title' } });
  const recentStatus = el('span', { attrs: { class: 'dh-home-recent-status' } });
  const recentPreview = el('span', { attrs: { class: 'dh-home-recent-preview' } });
  const recentTime = el('span', { attrs: { class: 'dh-home-recent-time' } });
  const recentRow = el('button', {
    attrs: { class: 'dh-home-recent-row', type: 'button' },
    children: [
      el('span', {
        attrs: { class: 'dh-home-recent-body' },
        children: [
          el('span', { attrs: { class: 'dh-home-recent-head' }, children: [recentTitle, recentStatus] }),
          recentPreview,
          recentTime,
        ],
      }),
      el('span', { attrs: { class: 'dh-home-chevron', 'aria-hidden': 'true' }, text: '›' }),
    ],
  });

  const seeAll = el('button', {
    attrs: { class: 'dh-home-seeall', type: 'button' },
    text: 'See all',
    on: { click: () => callbacks.onSeeAll() },
  });

  const recentSection = el('section', {
    attrs: { class: 'dh-home-section', hidden: true, 'aria-labelledby': 'dh-home-recent-heading' },
    children: [
      el('div', {
        attrs: { class: 'dh-home-section-head' },
        children: [
          el('h3', {
            attrs: { class: 'dh-home-section-title', id: 'dh-home-recent-heading' },
            text: 'Recent conversation',
          }),
          seeAll,
        ],
      }),
      recentRow,
    ],
  });

  // The Common Questions row is MOUNTED here by the widget, not built here —
  // it is the same `commonQuestionsHost` the conversation screen used, moved
  // rather than duplicated.
  const questionsSlot = el('section', {
    attrs: { class: 'dh-home-section dh-home-questions', hidden: true, 'aria-labelledby': 'dh-home-q-heading' },
    children: [
      el('h3', {
        attrs: { class: 'dh-home-section-title', id: 'dh-home-q-heading' },
        text: 'Common Questions',
      }),
    ],
  });

  const node = el('div', {
    attrs: { class: 'dh-home' },
    children: [notice, cta, alt, recentSection, questionsSlot],
  });

  // `null` until the first `update()` — see the flip guard below, which must
  // not fire on the very first render just because it differs from an
  // arbitrary seed.
  let previousPrimary: ResolvedEntry['primary'] | null = null;

  return {
    node,
    update(recent, subtitle, entry) {
      // The merchant's own response-time line, reused rather than a second
      // hardcoded "We usually reply instantly" — it is the same promise the
      // status line makes, and two copies would drift. Used only when the
      // CTA is actually about chat; `ctaCopy` supplies its own sentence for
      // a ticket row.
      const copy = ctaCopy(entry, subtitle);
      ctaTitle.textContent = copy.title;
      ctaSubtitle.textContent = copy.sub;
      ctaSubtitle.hidden = copy.sub === '';
      onCtaPress =
        entry.source === 'published' && entry.primary === 'ticket'
          ? callbacks.onLeaveMessage
          : callbacks.onStartNew;

      const altChoice = altFor(entry);
      alt.hidden = altChoice === null;
      if (altChoice !== null) {
        alt.textContent = altChoice.label;
        onAltPress = altChoice.kind === 'ticket' ? callbacks.onLeaveMessage : callbacks.onChooseChat;
      }

      // Only a genuine chat→ticket flip announces itself, and only once per
      // flip — a repaint that lands on the same row again (a second message
      // arriving, a session change) must not restart the announcement mid-
      // sentence, the same discipline `ui/offline-banner.ts` applies to its
      // own live region.
      const flipped =
        previousPrimary === 'chat' && entry.source === 'published' && entry.primary === 'ticket';
      if (flipped) {
        const text = "We've just closed — leave a message and we'll reply by email.";
        if (notice.textContent !== text) notice.textContent = text;
        notice.hidden = false;
      } else {
        notice.hidden = true;
      }
      previousPrimary = entry.source === 'published' ? entry.primary : 'chat';

      recentSection.hidden = recent === null;
      if (recent === null) return;

      // NOT a subject line. The reference product shows one ("Delivery
      // issue", "Refund request"), but that is its own mock data: there is no
      // subject, title or topic on `chat_sessions`, in the REST projection, or
      // on core's `ChatSessionSummary`. Inventing one — from the first message,
      // say — would put a label on the row that the customer never wrote and
      // that nothing else in the product agrees with.
      //
      // So the heading is WHO handled it, which is real, and the preview
      // below carries what it was about. A row with neither still identifies
      // itself by time.
      recentTitle.textContent = recent.handledBy?.displayName ?? 'Conversation';
      // ALWAYS a pill, for every status. This used to carry a private
      // three-status table (RESOLVED/CLOSED/WAITING_FOR_AGENT) and render
      // nothing at all for OPEN, ASSIGNED and ON_HOLD — so the conversation a
      // customer was most likely still in the middle of was the one row that
      // refused to say where it stood, which is the half of defect 4 that is
      // purely client-side. The words come from `ui/session-status.ts`, the
      // same table the Messages list reads, so the two screens cannot drift.
      recentStatus.textContent = statusPill(recent.status);
      recentStatus.setAttribute('data-status', recent.status);
      recentPreview.textContent = recent.lastMessagePreview ?? '';
      recentPreview.hidden = (recent.lastMessagePreview ?? '') === '';
      recentTime.textContent = relativeTimeLabel(recent.lastMessageAt ?? recent.createdAt);
      recentRow.onclick = () => callbacks.onOpenConversation(recent.id);
    },
  };
}

/** Where the widget mounts the shared Common Questions row on this screen. */
export function homeQuestionsSlot(view: HomeScreenView): HTMLElement {
  return view.node.querySelector('.dh-home-questions')!;
}
