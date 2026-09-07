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
