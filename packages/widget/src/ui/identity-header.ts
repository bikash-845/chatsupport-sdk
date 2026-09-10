// Who the customer is talking to, in the panel header.
//
// ── The two semantics this file exists to get right ──────────────────────
//
// `ChatSession.handledBy` (core, state/types.ts) carries exactly one bit of
// presentation information, and getting either half of it wrong tells the
// customer something false:
//
//   1. ABSENT means "render your own configured title" — never "nobody is
//      handling this chat". `status`/`mode` carry that signal, not this
//      field. An absent `handledBy` must never blank the header, spin it, or
//      say "no agent".
//
//   2. PRESENT does not always mean CURRENT. A session reactivated from
//      CLOSED/RESOLVED keeps its previous agent server-side, so `handledBy`
//      can still name someone while `status` is back to
//      `WAITING_FOR_AGENT` — that person is not actually on the chat right
//      now. Core's `isHandledByCurrent` (client/session.ts, T10) is the one
//      canonical gate for this, "same spirit as `deriveTickState`" per its
//      own doc — every binding calls it rather than re-deriving the
//      WAITING_FOR_AGENT special case locally. Both rules collapse into one
//      call: `isHandledByCurrent` already returns `false` for an absent
//      `handledBy` (its first conjunct), so gating the whole label on it
//      handles rule 1 and rule 2 with a single branch — there is no second,
//      separate "is it absent" check to keep in sync with it.
//
// `HandledBy`/`ChatStatus` are imported straight from `@dhaam-ccrm/core`
// rather than `@dhaam-ccrm/js`, matching message-list.ts's existing
// AttachmentMetadata/CloseReason workaround: the binding package re-exports
// most of ChatState's shape but not every type reachable from it, and a
// type-only import costs nothing at runtime.

import { isHandledByCurrent } from '@dhaam-ccrm/core';
import type { ChatSession } from '@dhaam-ccrm/js';

import { el } from './dom.js';

export interface IdentityHeaderView {
  /**
   * The title element itself — an `<h2 id="dh-title">`, the same id the
   * panel's `aria-labelledby` already points at. Mount this node where a
   * hand-built title `<h2>` used to go; do not create a second one.
   */
  readonly node: HTMLHeadingElement;

  /**
   * The announcement channel for identity CHANGES only. Separate from any
   * other live region in the panel (same reasoning as message-list.ts's
   * `liveRegion` split from its `log`): marking `node` itself live would
   * re-announce the title on every unrelated header re-render, and folding
   * this into the message log's region would race whatever it is announcing
   * at the same moment. Mount it once, anywhere in the panel — it carries no
   * visible layout.
   */
  readonly liveRegion: HTMLElement;

  /**
   * Replaces the title used when no agent is driving it — published config,
   * which arrives after mount. No-ops visually while an agent's name is
   * showing, and never announces.
   */
  setFallbackTitle(title: string): void;

  /**
   * Recomputes the displayed identity from `session.status`/`handledBy` and
   * speaks the change — but only when the DISPLAYED LABEL actually differs
   * from what was last shown, and never on the very first call.
   *
   * The first-call suppression matches message-list.ts's `seenAnyState`
   * exactly, and for the same reason: the first `update()` a mount produces
   * is describing whatever was ALREADY true when the panel appeared (a
   * resumed session an agent was already handling), not a live hand-off that
   * just happened. Announcing "you're now chatting with Ada" the instant the
   * widget mounts, for a fact that predates the mount, is the same class of
   * hostility as announcing forty backfilled messages on open.
   *
   * `session: null` is a legitimate input (no session yet, or one not loaded)
   * and always resolves to the fallback title — it is not a distinct "error"
   * state requiring different handling.
   */
  update(session: Pick<ChatSession, 'status' | 'handledBy'> | null): void;

  setFallbackTitle(title: string): void;
  setTitle(title: string): void;
}

/**
 * Checks if a title is a generic system title or a specific merchant/store title.
 */
function isGenericTitle(t: string | undefined): boolean {
  if (!t) return true;
  const lower = t.trim().toLowerCase();
  return (
    lower === 'chat with us' ||
    lower === 'admin support chat' ||
    lower === 'store support & chat' ||
    lower === 'dhaam ai'
  );
}

/**
 * @param fallbackTitle The widget's own configured title (`WidgetConfig.title`),
 *   shown whenever there is no CURRENT handler to name — see the module
 *   header's rule 1 and rule 2. Read once at construction: a host does not
 *   change its own configured title at runtime.
 */
export function createIdentityHeader(initialTitle: string): IdentityHeaderView {
  let fallbackTitle = initialTitle;
  const node = el('h2', { attrs: { class: 'dh-title', id: 'dh-title' }, text: fallbackTitle });

  // Same shape as message-list.ts's `liveRegion`: `role="status"` rather than
  // `alert` (this is informational, not urgent), `aria-atomic` so a screen
  // reader reads the whole sentence rather than only the changed word.
  const liveRegion = el('div', {
    attrs: { class: 'dh-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });

  let currentLabel = fallbackTitle;
  let seenAnyState = false;

  function labelFor(session: Pick<ChatSession, 'status' | 'handledBy'> | null): string {
    // If a specific custom title is configured (e.g. store name "Food Hub"), always keep it
    if (!isGenericTitle(fallbackTitle)) {
      return fallbackTitle;
    }
    if (session === null) return fallbackTitle;
    if (!isHandledByCurrent(session)) return fallbackTitle;
    const { handledBy } = session;
    return handledBy === undefined ? fallbackTitle : handledBy.displayName;
  }

  function update(session: Pick<ChatSession, 'status' | 'handledBy'> | null): void {
    const label = labelFor(session);
    node.textContent = label;

    // A CSS/testing hook for the identity actually driving the title, not
    // merely for whether one is present — `''` covers both the fallback
    // case and a stale (not-current) handledBy alike, on purpose, since both
    // render identical copy.
    const kind = session !== null && isHandledByCurrent(session) ? session.handledBy?.kind : undefined;
    node.setAttribute('data-handled-by', kind ?? '');

    if (!seenAnyState) {
      seenAnyState = true;
      currentLabel = label;
      return;
    }
    if (label === currentLabel) return;
    currentLabel = label;
    liveRegion.textContent = `You're now chatting with ${label}.`;
  }

  /**
   * Replaces the title shown when no agent is driving it.
   */
  function setFallbackTitle(title: string): void {
    fallbackTitle = title;
    node.textContent = title;
    currentLabel = title;
  }

  /**
   * Force set active conversation title (e.g. store name when chatting with merchant).
   */
  function setTitle(title: string): void {
    fallbackTitle = title;
    node.textContent = title;
    currentLabel = title;
  }

  return { node, liveRegion, update, setFallbackTitle, setTitle };
}
