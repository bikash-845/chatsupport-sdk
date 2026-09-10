// The Messages screen — every conversation this customer has ever had, with
// search and a way to start a fresh one.
//
// ── Why this is not a third copy of the row markup ───────────────────────
//
// `ui/session-picker.ts` already renders session rows twice (the pre-chat
// screen and the in-chat switcher), both keyed off `statusLabel` and
// `relativeTimeLabel`. This screen is a fourth place that needs to agree with
// the first three about what "Waiting for an agent" or "3 hours ago" means,
// so it imports both rather than re-deriving them — the status vocabulary now
// lives in `ui/session-status.ts`, which Home's pill reads off too. It does
// NOT reuse that module's row
// FACTORY, though: this row shows a different field set (no handler line,
// see below) and is about to outlive session-picker's two screens, which the
// three-screen navigation this belongs to is replacing.
//
// ── Why the row has no "handled by" line ──────────────────────────────────
//
// The task that specifies this screen names exactly four fields — status
// pill, preview, relative time, unread badge — and home-screen.ts's own
// "Recent conversation" row already establishes the precedent of NOT
// inventing a subject/title from thin air. Dropping the handler line here
// keeps this row a strict subset of what is visible, which is also all that
// search matches against below: nothing is searchable that is not on screen,
// so a match is always explainable by looking at the row that produced it.
//
// ── Search is client-side, over the loaded page ───────────────────────────
//
// `listSessions` already fetched once (widget.ts's `requestSessions`, capped
// at `SESSION_PICKER_LIMIT`) and this screen renders exactly that page —
// same discipline session-picker.ts's row list documents for itself: this
// component draws whatever `sessions` array it is given and fetches nothing
// of its own. So a query narrows what is already on screen by hiding rows
// rather than requesting a smaller page, which keeps every row's identity
// (and a keyboard user's focus, if it happened to be on one) stable across
// keystrokes.
//
// ── Redesign: Dhaam UI (Customers / Merchants tabs) ───────────────────────
//
// The new design shows two tabs at the top: "Customers" and "Merchants".
// For now all sessions are shown under "Merchants" (the admin's merchant
// conversations). "Customers" tab is reserved for future use.

import type { ChatSessionSummary } from '@dhaam-ccrm/js';

import { ICONS, el, icon } from './dom.js';
import { relativeTimeLabel } from './session-picker.js';
import { statusLabel } from './session-status.js';

export interface MessagesScreenCallbacks {
  /** The customer picked a row — including a terminal one, which reactivates it server-side. */
  readonly onOpenConversation: (sessionId: string) => void;
  /** "New conversation" was pressed. */
  readonly onStartNew: () => void;
}

export interface MessagesScreenView {
  readonly node: HTMLElement;
  /** @param currentSessionId the conversation on screen behind this tab, or `null`. */
  render(sessions: readonly ChatSessionSummary[], currentSessionId: string | null): void;
  setStartingNew(busy: boolean): void;
  /** Moves focus to the search field. Call after navigating to this screen. */
  focus(): void;
  destroy(): void;
}

/** Heroicons' `magnifying-glass` outline, stroked like every other glyph `icon()` draws. */
const SEARCH_ICON = ['m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z'];

/** Chevron-right icon for conversation row. */
const CHEVRON_ICON = ['M8.25 4.5l7.5 7.5-7.5 7.5'];

/** Whether `session` should stay visible under `query` — `''` matches everything. */
function matchesQuery(session: ChatSessionSummary, query: string): boolean {
  if (query === '') return true;
  const haystack = `${statusLabel(session.status)} ${session.lastMessagePreview ?? ''}`.toLowerCase();
  return haystack.includes(query);
}

/** Extract initials from a session identifier for the avatar circle. */
function sessionInitials(session: ChatSessionSummary): string {
  // Use first 1-2 chars of the session id or preview as avatar initials
  const preview = session.lastMessagePreview ?? '';
  if (preview.length > 0) return preview.charAt(0).toUpperCase();
  return 'C';
}

/** Map a status string to a display label for the pill. */
function pillLabel(status: string): string {
  switch (status) {
    case 'OPEN': return 'Open';
    case 'CLOSED': return 'Closed';
    case 'RESOLVED': return 'Resolved';
    case 'ON_HOLD': return 'On Hold';
    case 'WAITING_FOR_AGENT': return 'Waiting';
    case 'ASSIGNED': return 'Assigned';
    default: return statusLabel(status as any);
  }
}

interface MessageRow {
  readonly node: HTMLLIElement;
  update(summary: ChatSessionSummary, isCurrent: boolean): void;
}

function createMessageRow(onSelect: (sessionId: string) => void): MessageRow {
  // Avatar circle (initial letter)
  const avatarText = el('span', { attrs: { class: 'dh-mrow-avatar-text' } });
  const avatar = el('div', { attrs: { class: 'dh-mrow-avatar' }, children: [avatarText] });

  // Name (bold, left)
  const name = el('span', { attrs: { class: 'dh-mrow-name' } });
  // Status pill
  const statusPill = el('span', { attrs: { class: 'dh-mrow-status-pill' } });
  // Unread badge (circle, right side)
  const unreadBadge = el('span', { attrs: { class: 'dh-mrow-unread-badge', hidden: true } });
  // Chevron
  const chevron = el('span', { attrs: { class: 'dh-mrow-chevron', 'aria-hidden': 'true' }, children: [icon(CHEVRON_ICON, 14)] });

  // Top row: name + pill | badge + chevron
  const nameRow = el('div', { attrs: { class: 'dh-mrow-name-row' }, children: [name, statusPill] });
  const rightCol = el('div', { attrs: { class: 'dh-mrow-right' }, children: [unreadBadge, chevron] });
  const topRow = el('div', { attrs: { class: 'dh-mrow-top' }, children: [nameRow, rightCol] });

  // Preview text
  const preview = el('span', { attrs: { class: 'dh-mrow-preview', hidden: true } });
  // Timestamp
  const time = el('time', { attrs: { class: 'dh-mrow-time' } });

  // Body: preview + time
  const body = el('div', { attrs: { class: 'dh-mrow-body' }, children: [topRow, preview, time] });

  const button = el('button', {
    // Never `disabled` — see session-picker.ts's module header: a terminal
    // status is information shown via the pill, not a reason to disable the
    // row underneath it.
    attrs: { class: 'dh-mrow-btn', type: 'button' },
    children: [avatar, body],
  });
  const node = el('li', { attrs: { class: 'dh-mrow-item' }, children: [button] });

  let current: ChatSessionSummary | null = null;
  button.addEventListener('click', () => {
    if (current !== null) onSelect(current.id);
  });

  return {
    node,
    update(summary, isCurrent) {
      current = summary;

      node.setAttribute('data-status', summary.status);
      if (isCurrent) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');

      // Avatar initials
      avatarText.textContent = sessionInitials(summary);

      // Name: use preview first word or "Conversation" as display name
      name.textContent = `Conversation`;

      // Status pill
      statusPill.textContent = pillLabel(summary.status);
      statusPill.setAttribute('data-status', summary.status);

      const whenIso = summary.lastMessageAt ?? summary.createdAt;
      if (time.getAttribute('datetime') !== whenIso) time.setAttribute('datetime', whenIso);
      time.textContent = relativeTimeLabel(whenIso);

      const hasPreview = summary.lastMessagePreview !== undefined && summary.lastMessagePreview !== '';
      preview.textContent = hasPreview ? (summary.lastMessagePreview as string) : '';
      preview.hidden = !hasPreview;

      const hasUnread = summary.unreadCount > 0;
      // Capped like the nav tab's own badge (ui/nav.ts) — a real count past
      // 99 tells the customer nothing the cap does not.
      unreadBadge.textContent = hasUnread ? (summary.unreadCount > 99 ? '99+' : String(summary.unreadCount)) : '';
      unreadBadge.hidden = !hasUnread;

      // The one spoken account of this row — never derived from the visible
      // spans themselves, same split session-picker.ts's `describeRow` uses
      // and for the same reason: the wording can drift, the underlying facts
      // must not.
      const parts = [statusLabel(summary.status)];
      if (isCurrent) parts.push('current conversation');
      const relative = relativeTimeLabel(whenIso);
      if (relative !== '') parts.push(relative);
      if (hasPreview) parts.push(summary.lastMessagePreview as string);
      if (hasUnread) {
        parts.push(`${summary.unreadCount} unread ${summary.unreadCount === 1 ? 'message' : 'messages'}`);
      }
      button.setAttribute('aria-label', parts.join(', '));
    },
  };
}

export function createMessagesScreen(callbacks: MessagesScreenCallbacks): MessagesScreenView {
  // ── Tab bar: Customers | Merchants ──────────────────────────────────────
  const customersCountBadge = el('span', { attrs: { class: 'dh-mtab-count' }, text: '0' });
  const merchantsCountBadge = el('span', { attrs: { class: 'dh-mtab-count dh-mtab-count--active' }, text: '0' });

  const customersTab = el('button', {
    attrs: { class: 'dh-mtab', type: 'button', 'aria-selected': 'false', role: 'tab' },
    children: [
      el('span', { text: 'Customers' }),
      customersCountBadge,
    ],
    on: { click: () => switchTab('customers') },
  });
  const merchantsTab = el('button', {
    attrs: { class: 'dh-mtab dh-mtab--active', type: 'button', 'aria-selected': 'true', role: 'tab' },
    children: [
      el('span', { text: 'Merchants' }),
      merchantsCountBadge,
    ],
    on: { click: () => switchTab('merchants') },
  });

  const tabBar = el('div', {
    attrs: { class: 'dh-mtab-bar', role: 'tablist', 'aria-label': 'Conversation categories' },
    children: [customersTab, merchantsTab],
  });

  // ── Search bar ──────────────────────────────────────────────────────────
  const searchInput = el('input', {
    attrs: {
      class: 'dh-messages-search-input',
      type: 'search',
      placeholder: 'Search conversations',
      'aria-label': 'Search conversations',
      autocomplete: 'off',
    },
    on: { input: () => applyFilter() },
  });
  const search = el('div', {
    attrs: { class: 'dh-messages-search' },
    children: [
      el('span', { attrs: { class: 'dh-messages-search-icon', 'aria-hidden': 'true' }, children: [icon(SEARCH_ICON, 16)] }),
      searchInput,
    ],
  });

  // ── Conversation list ────────────────────────────────────────────────────
  const empty = el('li', { attrs: { class: 'dh-messages-empty' }, text: 'No conversations yet.' });
  // `role="list"` restored explicitly — see session-picker.ts's own note on
  // Safari/VoiceOver dropping the implicit role once `list-style` is styled away.
  const list = el('ul', {
    attrs: { class: 'dh-messages-list', role: 'list', 'aria-label': 'Your conversations' },
    children: [empty],
  });

  const newButtonLabel = el('span', { text: 'New conversation' });
  const newButton = el('button', {
    attrs: { class: 'dh-messages-new', type: 'button' },
    // The same speech-bubble glyph the Home screen's own CTA uses
    // (ui/home-screen.ts) — both start the same thing, so they share an icon
    // rather than introducing a second "start a conversation" symbol.
    children: [icon(ICONS.chat, 18), newButtonLabel],
    on: { click: () => callbacks.onStartNew() },
  });

  const node = el('div', { attrs: { class: 'dh-messages' }, children: [tabBar, search, list, newButton] });

  const rows = new Map<string, MessageRow>();
  let allSessions: readonly ChatSessionSummary[] = [];
  let currentId: string | null = null;
  let activeTab: 'customers' | 'merchants' = 'merchants';

  function switchTab(tab: 'customers' | 'merchants'): void {
    activeTab = tab;
    if (tab === 'customers') {
      customersTab.classList.add('dh-mtab--active');
      customersTab.setAttribute('aria-selected', 'true');
      merchantsTab.classList.remove('dh-mtab--active');
      merchantsTab.setAttribute('aria-selected', 'false');
      customersCountBadge.classList.add('dh-mtab-count--active');
      merchantsCountBadge.classList.remove('dh-mtab-count--active');
    } else {
      merchantsTab.classList.add('dh-mtab--active');
      merchantsTab.setAttribute('aria-selected', 'true');
      customersTab.classList.remove('dh-mtab--active');
      customersTab.setAttribute('aria-selected', 'false');
      merchantsCountBadge.classList.add('dh-mtab-count--active');
      customersCountBadge.classList.remove('dh-mtab-count--active');
    }
    applyFilter();
  }

  function applyFilter(): void {
    const query = searchInput.value.trim().toLowerCase();
    // "Customers" tab is reserved — show empty state there.
    // "Merchants" tab shows all current sessions.
    if (activeTab === 'customers') {
      for (const [, row] of rows) row.node.hidden = true;
      empty.textContent = 'No customer conversations yet.';
      empty.hidden = false;
      return;
    }

    let anyVisible = false;
    for (const summary of allSessions) {
      const row = rows.get(summary.id);
      if (row === undefined) continue;
      const matches = matchesQuery(summary, query);
      row.node.hidden = !matches;
      if (matches) anyVisible = true;
    }

    if (allSessions.length === 0) {
      empty.textContent = 'No conversations yet.';
      empty.hidden = false;
    } else {
      empty.textContent = 'No conversations match your search.';
      empty.hidden = anyVisible;
    }
  }

  return {
    node,
    render(sessions, currentSessionId) {
      allSessions = sessions;
      currentId = currentSessionId;

      // Update tab counts
      merchantsCountBadge.textContent = String(sessions.length);
      customersCountBadge.textContent = '0';

      const live = new Set<string>();
      let previous: Node = empty;
      for (const summary of sessions) {
        live.add(summary.id);
        let row = rows.get(summary.id);
        if (row === undefined) {
          row = createMessageRow((sessionId) => callbacks.onOpenConversation(sessionId));
          rows.set(summary.id, row);
        }
        row.update(summary, summary.id === currentId);
        if (previous.nextSibling !== row.node) list.insertBefore(row.node, previous.nextSibling);
        previous = row.node;
      }
      for (const [id, row] of rows) {
        if (live.has(id)) continue;
        row.node.remove();
        rows.delete(id);
      }

      applyFilter();
    },
    setStartingNew(busy) {
      newButton.disabled = busy;
      newButtonLabel.textContent = busy ? 'Starting…' : 'New conversation';
    },
    focus() {
      searchInput.focus({ preventScroll: true });
    },
    destroy() {
      rows.clear();
    },
  };
}
