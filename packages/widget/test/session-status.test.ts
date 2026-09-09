// @vitest-environment jsdom
//
// Defect 4, client half: EVERY conversation shows a status, on BOTH lists, out
// of ONE mapping.
//
// What was wrong. `ui/home-screen.ts` carried a private three-entry table
// (RESOLVED / CLOSED / WAITING_FOR_AGENT) and rendered an empty, hidden pill
// for OPEN, ASSIGNED and ON_HOLD — so the recent conversation a customer was
// most likely still in the middle of was the one row that said nothing about
// where it stood. The Messages list named all six, from a second table living
// in `ui/session-picker.ts`. Two tables, one of them incomplete, is how that
// happens, so the words now live once in `ui/session-status.ts` and this file
// holds both screens to it.
//
// Component-level rather than through a mounted widget on purpose: this is
// about the mapping being TOTAL and SHARED, which is a property of the two
// render functions and not of any particular session's journey.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatStatus } from '@dhaam-ccrm/core';
import type { ChatSessionSummary } from '@dhaam-ccrm/js';

import { createHomeScreen } from '../src/ui/home-screen.js';
import type { ResolvedEntry } from '../src/remote-config.js';
import { createMessagesScreen } from '../src/ui/messages-screen.js';
import { SESSION_STATUS_WORDS, statusLabel, statusPill } from '../src/ui/session-status.js';

/** Every status the wire can name — the union `ChatStatus` itself. */
const ALL_STATUSES: readonly ChatStatus[] = [
  'OPEN',
  'WAITING_FOR_AGENT',
  'ASSIGNED',
  'ON_HOLD',
  'RESOLVED',
  'CLOSED',
];

/**
 * This file is about the status vocabulary being shared and total, not about
 * the chooser — so every call below uses the pre-`support` "assumed" entry,
 * the same one `entryFor` answers when a fetch never carried one.
 */
const ASSUMED_ENTRY: ResolvedEntry = { primary: 'chat', secondary: null, hours: 'UNKNOWN', source: 'assumed' };

function summary(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id: 's1',
    status: 'ASSIGNED',
    mode: 'HUMAN',
    createdAt: '2026-08-19T09:00:00.000Z',
    closedAt: null,
    lastMessageAt: '2026-08-19T09:30:00.000Z',
    lastMessagePreview: 'Where is my order?',
    unreadCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the shared status vocabulary', () => {
  it('names all six statuses, in both lengths, with nothing blank', () => {
    for (const status of ALL_STATUSES) {
      expect(statusLabel(status), status).not.toBe('');
      expect(statusPill(status), status).not.toBe('');
    }
    expect(Object.keys(SESSION_STATUS_WORDS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('gives every status a distinct label, so two states never read the same', () => {
    const labels = ALL_STATUSES.map(statusLabel);
    expect(new Set(labels).size).toBe(ALL_STATUSES.length);
  });

  // The internal routing word, translated. "Assigned" answers "which agent
  // owns this row", which is the queue's question, not the customer's.
  it('renders ASSIGNED as something the customer can act on, not as "Assigned"', () => {
    expect(statusLabel('ASSIGNED')).toBe('With an agent');
    expect(statusLabel('ASSIGNED')).not.toBe('Assigned');
  });

  // Home's pill sits inline beside the handler's name and is `flex: none`, so
  // a long one eats the name; a list row gives the status its own line. Same
  // entry, two lengths — never two tables.
  it('keeps the pill no longer than the label', () => {
    for (const status of ALL_STATUSES) {
      expect(statusPill(status).length, status).toBeLessThanOrEqual(statusLabel(status).length);
    }
  });
});

describe('the Messages list shows a status for every session', () => {
  for (const status of ALL_STATUSES) {
    it(`renders ${status} rather than leaving the row unlabelled`, () => {
      const screen = createMessagesScreen({ onOpenConversation: vi.fn(), onStartNew: vi.fn() });
      document.body.appendChild(screen.node);
      screen.render([summary({ status })], null);

      const pill = screen.node.querySelector<HTMLElement>('.dh-messages-status');
      expect(pill?.textContent).toBe(statusLabel(status));
      // The spoken account carries it too — see messages-screen.ts on why the
      // aria-label is composed from the summary, not from the rendered spans.
      expect(screen.node.querySelector('.dh-messages-row')?.getAttribute('aria-label')).toContain(
        statusLabel(status),
      );
    });
  }
});

describe("Home's recent conversation shows a status for every session", () => {
  for (const status of ALL_STATUSES) {
    it(`renders ${status} rather than a blank, hidden pill`, () => {
      const home = createHomeScreen({
        onStartNew: vi.fn(),
        onOpenConversation: vi.fn(),
        onSeeAll: vi.fn(),
        onLeaveMessage: vi.fn(),
        onChooseChat: vi.fn(),
      });
      document.body.appendChild(home.node);
      home.update(summary({ status }), '', ASSUMED_ENTRY);

      const pill = home.node.querySelector<HTMLElement>('.dh-home-recent-status');
      expect(pill?.textContent).toBe(statusPill(status));
      // The named regression: OPEN, ASSIGNED and ON_HOLD used to land here.
      //
      // This is the PILL's own `hidden`, not the section's. Home only SHOWS
      // the recent section for an OPEN conversation (see the D4 block at the
      // bottom of this file), so for the other five the row below is filled
      // in correctly inside a hidden section — which is the point: the
      // vocabulary stays total whatever the visibility rule does next.
      expect(pill?.hidden).toBe(false);
      expect(pill?.getAttribute('data-status')).toBe(status);
    });
  }

  it('still hides the whole section when there is no recent conversation', () => {
    const home = createHomeScreen({
      onStartNew: vi.fn(),
      onOpenConversation: vi.fn(),
      onSeeAll: vi.fn(),
      onLeaveMessage: vi.fn(),
      onChooseChat: vi.fn(),
    });
    document.body.appendChild(home.node);
    home.update(null, '', ASSUMED_ENTRY);
    expect(home.node.querySelector<HTMLElement>('.dh-home-section')?.hidden).toBe(true);
  });
});

// ── D4: Home shows "Recent conversation" only for an OPEN one ─────────────
//
// The user's decision, in answer to a direct question and in their own words:
// "in home only open recent conversation if not then display none."
//
// They were shown a broader option — hide only RESOLVED and CLOSED, keeping
// the three live-but-not-open states — and chose the narrow one. WAITING,
// ASSIGNED and ON_HOLD are hidden here on purpose, not by oversight, so this
// is asserted status by status rather than as "not resolved and not closed":
// a future edit that widens it fails loudly instead of quietly being kinder.
//
// Nothing becomes unreachable. Every conversation, in every status, is still
// listed on the Messages screen, reached from the bottom tab bar that is on
// screen whenever Home is — this section is a shortcut back into the one
// conversation still going, not the list. NOT via Home's "See all": that
// button is a child of the section this hides, so it goes when the section
// goes. The Messages tab is the whole surviving route.
//
// The pill's WORDS are still computed for every status (the loop above), so
// the section is hidden with correct content inside it rather than emptied.
// That keeps this a visibility decision, and keeps the vocabulary total.
describe("Home's recent conversation appears only when it is still OPEN", () => {
  function homeShowing(recent: ChatSessionSummary | null): boolean {
    const home = createHomeScreen({
      onStartNew: vi.fn(),
      onOpenConversation: vi.fn(),
      onSeeAll: vi.fn(),
      onLeaveMessage: vi.fn(),
      onChooseChat: vi.fn(),
    });
    document.body.appendChild(home.node);
    home.update(recent, '', ASSUMED_ENTRY);
    const section = home.node.querySelector<HTMLElement>('.dh-home-section');
    if (section === null) throw new Error('no recent section');
    return !section.hidden;
  }

  it('shows the section for an OPEN conversation', () => {
    expect(homeShowing(summary({ status: 'OPEN' }))).toBe(true);
  });

  for (const status of ALL_STATUSES.filter((candidate) => candidate !== 'OPEN')) {
    it(`hides the section for ${status}`, () => {
      expect(homeShowing(summary({ status }))).toBe(false);
    });
  }

  it('hides the section when there is no recent conversation at all', () => {
    expect(homeShowing(null)).toBe(false);
  });

  // `widget.ts`'s `mostRecentSession` still picks the newest session OVERALL,
  // and that is deliberate and unchanged: it is not "the newest OPEN one".
  // So a visitor whose newest conversation was just closed sees no Recent
  // section even though an older OPEN one exists. Approved as-is — the older
  // one is one tap away on Messages, and a Home shortcut that skips past the
  // conversation you were last in is more confusing than no shortcut.
  it('hides the section for a closed newest conversation, older OPEN one or not', () => {
    expect(homeShowing(summary({ id: 'newest', status: 'CLOSED' }))).toBe(false);
  });
});

describe('the two screens read the same table', () => {
  it('never disagrees about which status a conversation is in', () => {
    const home = createHomeScreen({
      onStartNew: vi.fn(),
      onOpenConversation: vi.fn(),
      onSeeAll: vi.fn(),
      onLeaveMessage: vi.fn(),
      onChooseChat: vi.fn(),
    });
    const messages = createMessagesScreen({ onOpenConversation: vi.fn(), onStartNew: vi.fn() });
    document.body.append(home.node, messages.node);

    for (const status of ALL_STATUSES) {
      home.update(summary({ status }), '', ASSUMED_ENTRY);
      messages.render([summary({ status })], null);

      const pill = home.node.querySelector<HTMLElement>('.dh-home-recent-status')?.textContent ?? '';
      const label =
        messages.node.querySelector<HTMLElement>('.dh-messages-status')?.textContent ?? '';
      // Not necessarily the same STRING — the pill is the short form — but
      // always the same ENTRY, which is the property one table guarantees and
      // two tables cannot.
      expect(SESSION_STATUS_WORDS[status]).toEqual({ label, pill });
    }
  });
});
