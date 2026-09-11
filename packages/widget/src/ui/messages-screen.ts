// The Messages screen — every conversation with search and category tabs.
//
// ── Redesign: Dhaam UI (Role-based tabs) ──────────────────────────────────
//
// Shows two tabs at the top:
// - When Admin is logged in: "Customers" and "Merchants"
// - When Merchant is logged in: "Customers" and "Admin"
// - Display name replaces generic "Conversation" with real merchant / customer / admin names.
// - Avatar circle shows the first letter of that specific entity's name.
// - "New conversation" button is removed.

import type { ChatSessionSummary } from '@dhaam-ccrm/js';

import { ICONS, el, icon } from './dom.js';
import { relativeTimeLabel } from './session-picker.js';
import { statusLabel } from './session-status.js';

export type ActiveConversationTab = 'customers' | 'merchants' | 'admin';

export interface MessagesScreenCallbacks {
  /** The customer picked a row — including a terminal one, which reactivates it server-side. */
  readonly onOpenConversation: (sessionId: string, displayName: string, subtitle?: string) => void;
  /** Optional start-new callback. */
  readonly onStartNew?: () => void;
  /** Current user role in the portal ('admin' | 'merchant' | 'customer'). */
  readonly userRole?: string;
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

/** Resolve the appropriate display name for a conversation row. */
export function getRowDisplayName(
  summary: ChatSessionSummary,
  tab: ActiveConversationTab,
  userRole?: string
): string {
  const s = summary as any;
  const isMerchantUser = userRole === 'merchant';

  if (isMerchantUser) {
    if (tab === 'admin' || tab === 'merchants') {
      // Merchant viewing Admin chat
      if (s.adminName && typeof s.adminName === 'string' && s.adminName.trim()) return s.adminName.trim();
      if (s.customerName && s.customerName.toLowerCase().includes('admin')) return s.customerName.trim();
      if (s.targetName && s.targetName.toLowerCase().includes('admin')) return s.targetName.trim();
      if (s.handledBy?.displayName && s.handledBy.displayName !== 'Support Bot' && s.handledBy.displayName !== 'Dhaam Bot') {
        return s.handledBy.displayName;
      }
      return 'tse';
    } else {
      // Merchant viewing Customer chat
      if (s.customerName && typeof s.customerName === 'string' && s.customerName.trim() && !s.customerName.toLowerCase().includes('admin')) {
        return s.customerName.trim();
      }
      if (s.handledBy?.displayName) return s.handledBy.displayName;
      return 'Customer';
    }
  } else {
    // Admin user
    if (tab === 'merchants' || tab === 'admin') {
      // Admin viewing Merchant chat
      if (s.storeName && typeof s.storeName === 'string' && s.storeName.trim() && s.storeName.trim() !== 'Merchant') {
        return s.storeName.trim();
      }
      if (s.merchantName && typeof s.merchantName === 'string' && s.merchantName.trim() && s.merchantName.trim() !== 'Merchant') {
        return s.merchantName.trim();
      }
      if (s.targetName && typeof s.targetName === 'string' && s.targetName.trim() && s.targetName.trim() !== 'Merchant') {
        return s.targetName.trim();
      }
      if (s.customerName && typeof s.customerName === 'string' && s.customerName.trim() &&
          !s.customerName.toLowerCase().includes('admin')) {
        return s.customerName.trim();
      }
      if (s.merchantEmail && typeof s.merchantEmail === 'string' && s.merchantEmail.includes('@')) {
        return s.merchantEmail.split('@')[0];
      }
      if (s.customerEmail && typeof s.customerEmail === 'string' && s.customerEmail.includes('@') && !s.customerEmail.toLowerCase().includes('admin')) {
        return s.customerEmail.split('@')[0];
      }
      if (s.handledBy?.displayName && s.handledBy.displayName !== 'Support Bot' && s.handledBy.displayName !== 'Dhaam Bot') {
        return s.handledBy.displayName;
      }
      if (s.targetId) return `Merchant #${String(s.targetId).slice(0, 8)}`;
      return 'Merchant';
    } else {
      // Admin viewing Customer chat
      if (s.customerName && typeof s.customerName === 'string' && s.customerName.trim() && s.customerName !== 'Store Admin') {
        return s.customerName.trim();
      }
      if (s.customerEmail && typeof s.customerEmail === 'string' && s.customerEmail.includes('@')) {
        return s.customerEmail.split('@')[0];
      }
      if (s.handledBy?.displayName) return s.handledBy.displayName;
      return 'Customer';
    }
  }
}

/** Resolve subtitle / email info for a conversation row and header status. */
export function getRowSubtitle(
  summary: ChatSessionSummary,
  tab: ActiveConversationTab,
  userRole?: string
): string {
  const s = summary as any;
  const isMerchantUser = userRole === 'merchant';

  if (isMerchantUser) {
    if (tab === 'admin' || tab === 'merchants') {
      // Merchant viewing Admin chat: display Admin's email
      const email = s.adminEmail || s.targetEmail || (s.handledBy?.email) || 'tse@gmail.com';
      return `Admin • ${email}`;
    } else {
      // Merchant viewing Customer chat: display Customer's email
      if (s.customerEmail) return `Customer • ${s.customerEmail}`;
      return 'Customer';
    }
  } else {
    // Admin user viewing chat
    if (tab === 'merchants' || tab === 'admin') {
      // Admin viewing Merchant chat: display Merchant's email
      const email = s.merchantEmail || s.storeEmail || (s.customerEmail && !s.customerEmail.toLowerCase().includes('admin') ? s.customerEmail : '') || s.targetEmail || '';
      if (email) return `Merchant • ${email}`;
      return 'Merchant Chat';
    } else {
      // Admin viewing Customer chat: display Customer's email
      if (s.customerEmail) return `Customer • ${s.customerEmail}`;
      return 'Customer';
    }
  }
}

/** Extract initial for avatar circle from the display name. */
export function getRowInitials(displayName: string): string {
  const clean = displayName.trim();
  if (clean.length > 0) return clean.charAt(0).toUpperCase();
  return 'A';
}

/** Determine which tab a session belongs to. */
export function sessionBelongsToTab(
  summary: ChatSessionSummary,
  tab: ActiveConversationTab,
  userRole?: string
): boolean {
  const s = summary as any;
  const isMerchantUser = userRole === 'merchant';

  // Primary: use server-provided chatType when available
  if (s.chatType === 'merchant') {
    // For a merchant viewer: admin↔merchant sessions carry chatType='merchant'
    // (because the target IS the merchant). The merchant's 2nd tab has key 'admin',
    // so we must match on 'admin' (or 'merchants' which is the same slot key-wise).
    // For an admin viewer: correctly routed to the 'merchants' tab.
    return isMerchantUser ? (tab === 'admin' || tab === 'merchants') : tab === 'merchants';
  }
  if (s.chatType === 'admin') {
    return isMerchantUser ? (tab === 'admin' || tab === 'merchants') : tab === 'merchants';
  }
  if (s.chatType === 'customer') {
    if (!isMerchantUser && (s.storeName || s.merchantName || s.targetRole === 'merchant')) {
      return tab === 'merchants';
    }
    return tab === 'customers';
  }

  // Fallbacks:
  if (isMerchantUser) {
    // When Merchant is logged in:
    // Tab 1: Customers
    // Tab 2: Admin
    if (tab === 'customers') {
      if (s.targetRole === 'customer') return true;
      if (s.customerName && !s.customerName.toLowerCase().includes('admin') && s.targetRole !== 'merchant') {
        return true;
      }
      return false;
    }
    if (tab === 'admin' || tab === 'merchants') {
      if (s.customerName && s.customerName.toLowerCase().includes('admin')) return true;
      if (s.targetRole === 'merchant' || s.targetRole === 'admin') return true;
      if (!s.targetRole && (!s.customerName || s.customerName.toLowerCase().includes('admin'))) return true;
      if (s.customerName && !s.customerName.toLowerCase().includes('admin')) return false;
      return true;
    }
  } else {
    // When Admin is logged in:
    // Tab 1: Customers
    // Tab 2: Merchants
    if (tab === 'customers') {
      if (s.targetRole === 'customer') return true;
      if (s.targetRole === 'merchant' || s.storeName || s.merchantName) return false;
      if (s.customerName && !s.customerName.toLowerCase().includes('admin')) {
        return true;
      }
      return !s.targetRole;
    }
    if (tab === 'merchants' || tab === 'admin') {
      if (s.targetRole === 'merchant') return true;
      if (s.storeName || s.merchantName) return true;
      return false;
    }
  }

  return true;
}

/** Whether `session` should stay visible under `query` — `''` matches everything. */
function matchesQuery(
  session: ChatSessionSummary,
  query: string,
  tab: ActiveConversationTab,
  userRole?: string
): boolean {
  if (query === '') return true;
  const name = getRowDisplayName(session, tab, userRole);
  const haystack = `${name} ${statusLabel(session.status)} ${session.lastMessagePreview ?? ''}`.toLowerCase();
  return haystack.includes(query);
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
  update(
    summary: ChatSessionSummary,
    isCurrent: boolean,
    tab: ActiveConversationTab,
    userRole?: string
  ): void;
}

function createMessageRow(onSelect: (sessionId: string, displayName: string, subtitle?: string) => void): MessageRow {
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
    attrs: { class: 'dh-mrow-btn', type: 'button' },
    children: [avatar, body],
  });
  const node = el('li', { attrs: { class: 'dh-mrow-item' }, children: [button] });

  let current: ChatSessionSummary | null = null;
  let currentTab: ActiveConversationTab = 'merchants';
  let currentUserRole: string | undefined = undefined;

  button.addEventListener('click', () => {
    if (current !== null) {
      const displayName = getRowDisplayName(current, currentTab, currentUserRole);
      const subtitle = getRowSubtitle(current, currentTab, currentUserRole);
      onSelect(current.id, displayName, subtitle);
    }
  });

  return {
    node,
    update(summary, isCurrent, tab, userRole) {
      current = summary;
      currentTab = tab;
      currentUserRole = userRole;

      node.setAttribute('data-status', summary.status);
      if (isCurrent) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');

      // Display name and avatar initials based on active tab and role
      const displayName = getRowDisplayName(summary, tab, userRole);
      name.textContent = displayName;
      avatarText.textContent = getRowInitials(displayName);

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
      unreadBadge.textContent = hasUnread ? (summary.unreadCount > 99 ? '99+' : String(summary.unreadCount)) : '';
      unreadBadge.hidden = !hasUnread;

      const parts = [displayName, statusLabel(summary.status)];
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

/**
 * Resolves the name of the entity the customer is chatting with:
 * Store name, Merchant name, assigned Agent name, or Support.
 * NEVER returns the user's message/subject.
 */
export function getCustomerConversationTitle(summary: ChatSessionSummary, fallbackTitle = 'Support'): string {
  const s = summary as any;
  if (s.storeName && typeof s.storeName === 'string' && s.storeName.trim() && s.storeName.trim() !== 'General Support') {
    return s.storeName.trim();
  }
  if (s.merchantName && typeof s.merchantName === 'string' && s.merchantName.trim() && s.merchantName.trim() !== 'Merchant') {
    return s.merchantName.trim();
  }
  if (s.targetName && typeof s.targetName === 'string' && s.targetName.trim() && s.targetName.trim() !== 'Merchant') {
    return s.targetName.trim();
  }
  if (s.handledBy?.displayName && typeof s.handledBy.displayName === 'string' && s.handledBy.displayName.trim() && s.handledBy.displayName !== 'Support Bot') {
    return s.handledBy.displayName.trim();
  }
  if (s.adminName && typeof s.adminName === 'string' && s.adminName.trim() && s.adminName.trim() !== 'Admin') {
    return s.adminName.trim();
  }
  return fallbackTitle;
}

interface CustomerMessageRow {
  readonly node: HTMLLIElement;
  update(summary: ChatSessionSummary, isCurrent: boolean): void;
}

function createCustomerMessageRow(
  onSelect: (sessionId: string, displayName?: string, subtitle?: string) => void,
): CustomerMessageRow {
  const status = el('span', { attrs: { class: 'dh-messages-status' } });
  const time = el('time', { attrs: { class: 'dh-messages-time' } });
  const top = el('div', { attrs: { class: 'dh-messages-row-top' }, children: [status, time] });

  const title = el('span', { attrs: { class: 'dh-messages-title' } });
  const preview = el('span', { attrs: { class: 'dh-messages-preview', hidden: true } });
  const unread = el('span', { attrs: { class: 'dh-messages-unread', hidden: true } });

  const button = el('button', {
    attrs: { class: 'dh-messages-row', type: 'button' },
    children: [top, title, preview, unread],
  });
  const node = el('li', { attrs: { class: 'dh-messages-item' }, children: [button] });

  let current: ChatSessionSummary | null = null;
  button.addEventListener('click', () => {
    if (current !== null) {
      const titleText = getCustomerConversationTitle(current);
      onSelect(current.id, titleText);
    }
  });

  return {
    node,
    update(summary, isCurrent) {
      current = summary;
      node.setAttribute('data-status', summary.status);
      if (isCurrent) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');

      status.textContent = pillLabel(summary.status);
      status.setAttribute('data-status', summary.status);

      const whenIso = summary.lastMessageAt ?? summary.createdAt;
      if (time.getAttribute('datetime') !== whenIso) time.setAttribute('datetime', whenIso);
      time.textContent = relativeTimeLabel(whenIso);

      const displayName = getCustomerConversationTitle(summary);
      title.textContent = displayName;

      const previewContent = (summary.lastMessagePreview && summary.lastMessagePreview !== '')
        ? summary.lastMessagePreview
        : (summary.subject && summary.subject !== '')
        ? summary.subject
        : '';
      const hasPreview = previewContent !== '';
      preview.textContent = hasPreview ? previewContent : '';
      preview.hidden = !hasPreview;

      const hasUnread = summary.unreadCount > 0;
      unread.textContent = hasUnread ? (summary.unreadCount > 99 ? '99+' : String(summary.unreadCount)) : '';
      unread.hidden = !hasUnread;

      const parts = [displayName, statusLabel(summary.status)];
      if (isCurrent) parts.push('current conversation');
      const relative = relativeTimeLabel(whenIso);
      if (relative !== '') parts.push(relative);
      if (hasPreview) parts.push(previewContent);
      if (hasUnread) {
        parts.push(`${summary.unreadCount} unread ${summary.unreadCount === 1 ? 'message' : 'messages'}`);
      }
      button.setAttribute('aria-label', parts.join(', '));
    },
  };
}

function createCustomerMessagesScreen(callbacks: MessagesScreenCallbacks): MessagesScreenView {
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

  const empty = el('li', { attrs: { class: 'dh-messages-empty' }, text: 'No conversations yet.' });
  const list = el('ul', {
    attrs: { class: 'dh-messages-list', role: 'list', 'aria-label': 'Your conversations' },
    children: [empty],
  });

  const newLabel = el('span', { text: 'New conversation' });
  const newButton = el('button', {
    attrs: { class: 'dh-messages-new', type: 'button' },
    children: [icon(ICONS.chat, 18), newLabel],
    on: { click: () => callbacks.onStartNew?.() },
  });

  const node = el('div', { attrs: { class: 'dh-messages' }, children: [search, list, newButton] });

  const rows = new Map<string, CustomerMessageRow>();
  let allSessions: readonly ChatSessionSummary[] = [];
  let currentId: string | null = null;

  function applyFilter(): void {
    const query = searchInput.value.trim().toLowerCase();
    let anyVisible = false;
    for (const summary of allSessions) {
      const row = rows.get(summary.id);
      if (row === undefined) continue;

      const titleName = getCustomerConversationTitle(summary);
      const haystack = `${titleName} ${statusLabel(summary.status)} ${summary.lastMessagePreview ?? ''} ${summary.subject ?? ''}`.toLowerCase();
      const matches = query === '' || haystack.includes(query);
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

      const live = new Set<string>();
      let previous: Node = empty;
      for (const summary of sessions) {
        live.add(summary.id);
        let row = rows.get(summary.id);
        if (row === undefined) {
          row = createCustomerMessageRow((sessionId, displayName, subtitle) =>
            callbacks.onOpenConversation(sessionId, displayName ?? 'Support', subtitle)
          );
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
      newLabel.textContent = busy ? 'Starting…' : 'New conversation';
    },
    focus() {
      searchInput.focus({ preventScroll: true });
    },
    destroy() {
      rows.clear();
    },
  };
}

function createPortalMessagesScreen(callbacks: MessagesScreenCallbacks): MessagesScreenView {
  const isMerchantUser = callbacks.userRole === 'merchant';
  const secondTabKey: ActiveConversationTab = isMerchantUser ? 'admin' : 'merchants';
  const secondTabLabel = isMerchantUser ? 'Admin' : 'Merchants';

  // ── Tab bar: Customers | [Merchants / Admin] ────────────────────────────
  const customersCountBadge = el('span', { attrs: { class: 'dh-mtab-count' }, text: '0' });
  const secondTabCountBadge = el('span', { attrs: { class: 'dh-mtab-count dh-mtab-count--active' }, text: '0' });

  const customersTab = el('button', {
    attrs: { class: 'dh-mtab', type: 'button', 'aria-selected': 'false', role: 'tab' },
    children: [
      el('span', { text: 'Customers' }),
      customersCountBadge,
    ],
    on: { click: () => switchTab('customers') },
  });
  const secondTab = el('button', {
    attrs: { class: 'dh-mtab dh-mtab--active', type: 'button', 'aria-selected': 'true', role: 'tab' },
    children: [
      el('span', { text: secondTabLabel }),
      secondTabCountBadge,
    ],
    on: { click: () => switchTab(secondTabKey) },
  });

  const tabBar = el('div', {
    attrs: { class: 'dh-mtab-bar', role: 'tablist', 'aria-label': 'Conversation categories' },
    children: [customersTab, secondTab],
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
  const list = el('ul', {
    attrs: { class: 'dh-messages-list', role: 'list', 'aria-label': 'Your conversations' },
    children: [empty],
  });

  const node = el('div', { attrs: { class: 'dh-messages' }, children: [tabBar, search, list] });

  const rows = new Map<string, MessageRow>();
  let allSessions: readonly ChatSessionSummary[] = [];
  let currentId: string | null = null;
  let activeTab: ActiveConversationTab = secondTabKey;

  function switchTab(tab: ActiveConversationTab): void {
    activeTab = tab;
    if (tab === 'customers') {
      customersTab.classList.add('dh-mtab--active');
      customersTab.setAttribute('aria-selected', 'true');
      secondTab.classList.remove('dh-mtab--active');
      secondTab.setAttribute('aria-selected', 'false');
      customersCountBadge.classList.add('dh-mtab-count--active');
      secondTabCountBadge.classList.remove('dh-mtab-count--active');
    } else {
      secondTab.classList.add('dh-mtab--active');
      secondTab.setAttribute('aria-selected', 'true');
      customersTab.classList.remove('dh-mtab--active');
      customersTab.setAttribute('aria-selected', 'false');
      secondTabCountBadge.classList.add('dh-mtab-count--active');
      customersCountBadge.classList.remove('dh-mtab-count--active');
    }
    applyFilter();
  }

  function applyFilter(): void {
    const query = searchInput.value.trim().toLowerCase();
    let anyVisible = false;
    let totalInTab = 0;

    for (const summary of allSessions) {
      const row = rows.get(summary.id);
      if (row === undefined) continue;

      const inTab = sessionBelongsToTab(summary, activeTab, callbacks.userRole);
      if (!inTab) {
        row.node.hidden = true;
        continue;
      }
      totalInTab++;
      row.update(summary, summary.id === currentId, activeTab, callbacks.userRole);

      const matches = matchesQuery(summary, query, activeTab, callbacks.userRole);
      row.node.hidden = !matches;
      if (matches) anyVisible = true;
    }

    if (totalInTab === 0) {
      if (activeTab === 'customers') {
        empty.textContent = 'No customer conversations yet.';
      } else if (isMerchantUser) {
        empty.textContent = 'No admin conversations yet.';
      } else {
        empty.textContent = 'No merchant conversations yet.';
      }
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
      let secondTabCount = 0;
      let customerCount = 0;
      for (const s of sessions) {
        if (sessionBelongsToTab(s, secondTabKey, callbacks.userRole)) secondTabCount++;
        if (sessionBelongsToTab(s, 'customers', callbacks.userRole)) customerCount++;
      }
      secondTabCountBadge.textContent = String(secondTabCount);
      customersCountBadge.textContent = String(customerCount);

      const live = new Set<string>();
      let previous: Node = empty;
      for (const summary of sessions) {
        live.add(summary.id);
        let row = rows.get(summary.id);
        if (row === undefined) {
          row = createMessageRow((sessionId, displayName, subtitle) => callbacks.onOpenConversation(sessionId, displayName, subtitle));
          rows.set(summary.id, row);
        }
        row.update(summary, summary.id === currentId, activeTab, callbacks.userRole);
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
    setStartingNew(_busy) {},
    focus() {
      searchInput.focus({ preventScroll: true });
    },
    destroy() {
      rows.clear();
    },
  };
}

export function createMessagesScreen(callbacks: MessagesScreenCallbacks): MessagesScreenView {
  const isPortalUser = callbacks.userRole === 'merchant' || callbacks.userRole === 'admin';
  if (!isPortalUser) {
    return createCustomerMessagesScreen(callbacks);
  }
  return createPortalMessagesScreen(callbacks);
}
