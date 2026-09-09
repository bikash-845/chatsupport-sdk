// @vitest-environment jsdom
//
// T11 built the two picker surfaces (session-picker.ts's pre-chat screen and
// header switcher); the screens rewrite retired both in favour of the Home
// and Messages screens (ui/home-screen.ts, ui/messages-screen.ts) plus the
// new-conversation surface (ui/new-conversation.ts). This file proves the
// SAME invariants that mattered before still hold under the new mounting:
// past sessions render, a terminal one stays pickable, picking one joins it,
// and starting a new one mints rather than joins.
//
// ── There is no more "gate that hides a whole surface" ────────────────────
//
// Home and Messages are always mounted and always reachable via the nav
// tabs, regardless of session count — `sessions.length > 0` no longer
// decides whether a SURFACE shows, only whether a ROW does (Home's single
// "Recent conversation" row, Messages' full list). Every test below reflects
// that: "the gate" is now about row presence, not screen visibility.
//
// ── The two actions are not interchangeable ───────────────────────────────
//
// `switchSession` is `session.join` under the hood and deliberately does NOT
// mint a session; `startNewSession` does. Wiring "start a new conversation" to
// the former would drop the customer into whichever conversation the server
// picked instead of the fresh one they asked for, which is why there is an
// explicit test below that they stay distinct.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatClientConfigError } from '@dhaam-ccrm/js';

import { mount, unmount } from '../src/index.js';
import type { ChatWidget } from '../src/widget.js';
import type { WidgetConfig } from '../src/config.js';

const PK_TEST = 'dhp_' + 'test_' + '0123456789abcdefghijklmn';

let frameCounter = 0;
const frameId = (): string => `01ARZ3NDEKTSV4RRFFQ69G5F${String(frameCounter++ % 10)}0`;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
  open(): void {
    this.onopen?.();
  }

  frames(type: string): Array<{ id: string; d: Record<string, unknown> }> {
    return this.sent
      .map((raw) => JSON.parse(raw) as { t: string; id: string; d: Record<string, unknown> })
      .filter((frame) => frame.t === type);
  }

  push(t: string, d: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ v: 1, t, id: frameId(), ts: Date.now(), d }) });
  }

  ack(sessionId = 'sess_current', status = 'ASSIGNED'): void {
    this.push('connection.ack', {
      protocolVersion: 1,
      seq: 0,
      session: {
        sessionId,
        status,
        mode: 'HUMAN',
        participants: [{ participantId: 'cus_1', type: 'CUSTOMER' }],
        createdAt: new Date().toISOString(),
      },
    });
  }
}

function summaryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sess_past',
    status: 'RESOLVED',
    mode: 'HUMAN',
    createdAt: '2026-08-19T09:00:00.000Z',
    closedAt: '2026-08-19T10:00:00.000Z',
    lastMessageAt: '2026-08-19T09:30:00.000Z',
    lastMessagePreview: 'Thanks!',
    unreadCount: 0,
    ...overrides,
  };
}

function config(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    auth: { publishableKey: PK_TEST, tokenEndpoint: '/api/chat-token' },
    identity: { userId: 'cus_1' },
    apiUrl: 'https://chat.example.com',
    wsUrl: 'wss://chat.example.com',
    onError: () => undefined,
    ...overrides,
  };
}

let sessionRows: unknown[] = [];

function shadow(): ShadowRoot {
  const element = document.querySelector<HTMLElement>('dh-chat-widget');
  if (element === null) throw new Error('widget host not found');
  const root = element.shadowRoot;
  if (root === null) throw new Error('shadow root not found');
  return root;
}

const query = <T extends Element>(selector: string): T => {
  const found = shadow().querySelector<T>(selector);
  if (found === null) throw new Error(`not found: ${selector}`);
  return found;
};

/** Unlike `query`, returns `null` instead of throwing — for asserting a selector is genuinely ABSENT. */
const find = <T extends Element>(selector: string): T | null => shadow().querySelector<T>(selector);

const visible = (node: HTMLElement): boolean => !node.hidden && node.style.display !== 'none';
/** Whether `node` is on screen INCLUDING its ancestors — `hidden` on a parent (e.g. Home's recent-conversation section) hides everything inside it too. */
const reallyVisible = (node: Element): boolean => {
  let current: Element | null = node;
  while (current !== null) {
    if (current instanceof HTMLElement && !visible(current)) return false;
    current = current.parentElement;
  }
  return true;
};
const homePane = (): HTMLElement => query<HTMLElement>('.dh-home');
/** Home always BUILDS its recent-conversation row; `update()` hides the SECTION around it rather than removing it — see home-screen.ts. So presence alone proves nothing; visibility does. */
const homeShowsRecentRow = (): boolean => {
  const row = homePane().querySelector('.dh-home-recent-row');
  return row !== null && reallyVisible(row);
};
const messagesPane = (): HTMLElement => query<HTMLElement>('.dh-messages');
const messagesRows = (): HTMLButtonElement[] => [
  ...messagesPane().querySelectorAll<HTMLButtonElement>('.dh-messages-row'),
];

/** The nav bar has exactly two tabs; found by label rather than position so a reorder cannot silently break this. */
function navTab(label: 'Home' | 'Messages'): HTMLButtonElement {
  const tab = [...shadow().querySelectorAll<HTMLButtonElement>('.dh-nav-tab')].find(
    (candidate) => candidate.querySelector('.dh-nav-label')?.textContent === label,
  );
  if (tab === undefined) throw new Error(`${label} tab not found`);
  return tab;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function goToMessages(): Promise<void> {
  navTab('Messages').click();
  await settle();
}

/** Sockets whose `connection.hello` has already been answered. */
let handshaked = new WeakSet<FakeWebSocket>();

/**
 * Completes the handshake on every socket the client opened but nobody drove,
 * and returns the newest one.
 *
 * Picking a row calls `switchSession()`, which is a TEARDOWN and a
 * re-establish (see core's `switchToSession`): it drops the socket the widget
 * booted on and opens another, whose `connection.ack` the server resolves on
 * its own — `connection.hello` carries no session id. The explicit
 * `session.join` that follows is what corrects it.
 */
async function driveHandshakes(resolved = 'sess_current'): Promise<FakeWebSocket> {
  for (const instance of FakeWebSocket.instances) {
    if (handshaked.has(instance)) continue;
    handshaked.add(instance);
    instance.open();
    instance.ack(resolved);
    await settle();
  }
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (socket === undefined) throw new Error('no socket was opened');
  return socket;
}

async function openedWidget(
  overrides: Partial<WidgetConfig> = {},
): Promise<{ widget: ChatWidget; socket: FakeWebSocket }> {
  const widget = mount(config(overrides));
  await settle();
  const socket = await driveHandshakes();
  widget.open();
  await settle();
  return { widget, socket };
}

beforeEach(() => {
  localStorage.clear();
  frameCounter = 0;
  sessionRows = [];
  FakeWebSocket.instances = [];
  handshaked = new WeakSet<FakeWebSocket>();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/chat-token')) {
        return new Response(JSON.stringify({ accessToken: 'tok', expiresIn: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/chat/sessions/customer')) {
        return new Response(JSON.stringify({ success: true, data: { sessions: sessionRows } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: { messages: [], hasMore: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  document.body.innerHTML = '';
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe('the gate is exactly sessions.length > 0 — now expressed as rows, not surfaces', () => {
  it('Home and Messages both mount for an empty page, with no rows — what a guest gets', async () => {
    sessionRows = [];
    await openedWidget();

    // The launcher opens onto Home either way now — the "conversation is
    // shown instead" behavior this test used to prove no longer applies,
    // since there is no conversation to show yet and nothing was asked for.
    expect(visible(homePane())).toBe(true);
    expect(homeShowsRecentRow()).toBe(false);

    await goToMessages();
    expect(messagesRows()).toHaveLength(0);
    expect(messagesPane().querySelector('.dh-messages-empty')?.textContent).toBe('No conversations yet.');
  });

  // `status: 'OPEN'` explicitly, overriding the fixture's `RESOLVED`: Home
  // shows the recent row only for a conversation that is still open (see
  // `ui/home-screen.ts`'s `SHOWN_IN_RECENT` and the D4 block in
  // session-status.test.ts). This test is about the GATE — sessions exist, so
  // Home mounts with a row rather than the panel becoming a conversation — so
  // it has to hand Home a session the row is shown for, or it proves nothing
  // about the gate and everything about the status rule.
  it('Home shows the most recent session as its own row', async () => {
    sessionRows = [summaryRow({ id: 'sess_past', status: 'OPEN', closedAt: null })];
    await openedWidget();

    expect(visible(homePane())).toBe(true);
    expect(homeShowsRecentRow()).toBe(true);
  });

  // The same gate, the other side of the status rule: sessions exist, Home
  // still mounts as Home, and the recent row is simply not offered — the
  // conversation is over and Messages is where the finished ones live.
  it('Home mounts without a recent row when the newest session is finished', async () => {
    sessionRows = [summaryRow({ id: 'sess_past', status: 'RESOLVED' })];
    await openedWidget();

    expect(visible(homePane())).toBe(true);
    expect(homeShowsRecentRow()).toBe(false);
    // Not lost, just not on Home.
    await goToMessages();
    expect(messagesRows()).toHaveLength(1);
  });

  it('Messages renders one row per session', async () => {
    sessionRows = [summaryRow({ id: 'a' }), summaryRow({ id: 'b' })];
    await openedWidget();
    await goToMessages();

    expect(messagesRows()).toHaveLength(2);
  });

  it('keeps a terminal session pickable — reactivation is a real path back', async () => {
    sessionRows = [summaryRow({ id: 'closed_one', status: 'CLOSED' })];
    await openedWidget();
    await goToMessages();

    const row = messagesRows()[0];
    if (row === undefined) throw new Error('no row rendered');
    expect(row.disabled).toBe(false);
    expect(row.closest('.dh-messages-item')?.getAttribute('data-status')).toBe('CLOSED');
  });
});

describe('picking a conversation', () => {
  it('joins the chosen session and puts the conversation back on screen', async () => {
    sessionRows = [summaryRow({ id: 'sess_past' })];
    const { socket } = await openedWidget();
    await goToMessages();

    const row = messagesRows()[0];
    if (row === undefined) throw new Error('no row rendered');
    row.click();
    await settle();

    // The socket the switch opened, not the one the widget booted on: the
    // teardown drops that one before any join is written.
    const live = await driveHandshakes();
    expect(live).not.toBe(socket);
    const joins = live.frames('session.join');
    expect(joins).toHaveLength(1);
    expect(joins[0]?.d['sessionId']).toBe('sess_past');

    // Picking a row is `go('conversation')` — Messages is left behind, not
    // stacked under it.
    expect(visible(messagesPane())).toBe(false);
    expect(visible(query<HTMLElement>('.dh-log'))).toBe(true);
    expect(query<HTMLElement>('.dh-composer').hidden).toBe(false);
  });

  it('does not optimistically flip a terminal session to open', async () => {
    sessionRows = [summaryRow({ id: 'sess_past', status: 'CLOSED' })];
    const { widget } = await openedWidget();
    await goToMessages();

    const before = widget.store.getState().session;
    const row = messagesRows()[0];
    if (row === undefined) throw new Error('no row rendered');
    row.click();
    await settle();

    // The server reactivates on the customer's next message, behind a flag
    // that defaults to OFF. Guessing locally would show a live conversation
    // on a deployment where reactivation never happens.
    expect(widget.store.getState().session).toBe(before);
  });

  it('marks the current conversation in Messages', async () => {
    sessionRows = [summaryRow({ id: 'sess_current', status: 'ASSIGNED', closedAt: null }), summaryRow({ id: 'other' })];
    await openedWidget();
    await goToMessages();

    const current = messagesRows().find((row) => row.getAttribute('aria-current') === 'true');
    expect(current).toBeDefined();
    expect(current?.getAttribute('aria-label')).toContain('current conversation');
  });
});

describe('starting a new conversation', () => {
  /** Opens the new-conversation surface from Messages and fills in the one required field. */
  async function reachStartSurface(): Promise<void> {
    await goToMessages();
    query<HTMLButtonElement>('.dh-messages-new').click();
    await settle();
    query<HTMLTextAreaElement>('.dh-newconvo-message').value = 'Hello';
  }

  it('mints a session rather than joining one', async () => {
    sessionRows = [summaryRow()];
    const { widget, socket } = await openedWidget();

    const startNew = vi.spyOn(widget.store.client, 'startNewSession').mockResolvedValue();
    const switchTo = vi.spyOn(widget.store.client, 'switchSession');

    await reachStartSurface();
    query<HTMLButtonElement>('.dh-newconvo-form .dh-form-submit').click();
    await settle();

    expect(startNew).toHaveBeenCalledTimes(1);
    // The distinction that matters: `switchSession` is `session.join` and
    // deliberately does not mint a session.
    expect(switchTo).not.toHaveBeenCalled();
    expect(socket.frames('session.join')).toHaveLength(0);
  });

  it('leaves the new-conversation surface for the conversation once the session lands', async () => {
    sessionRows = [summaryRow()];
    const { widget } = await openedWidget();
    vi.spyOn(widget.store.client, 'startNewSession').mockResolvedValue();

    await reachStartSurface();
    query<HTMLButtonElement>('.dh-newconvo-form .dh-form-submit').click();
    await settle();

    // `query` throws rather than returning null, so absence is asserted with
    // `find` instead — see this file's own note on the two helpers.
    expect(find('.dh-newconvo-form')).toBeNull();
    expect(query<HTMLElement>('.dh-composer').hidden).toBe(false);
  });

  it('goes busy on the Start button so one round trip cannot mint two sessions', async () => {
    sessionRows = [summaryRow()];
    const { widget } = await openedWidget();

    let release = (): void => undefined;
    vi.spyOn(widget.store.client, 'startNewSession').mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    await reachStartSurface();
    const start = query<HTMLButtonElement>('.dh-newconvo-form .dh-form-submit');
    start.click();
    await settle();

    expect(start.disabled).toBe(true);

    // Once `startNewSession` resolves, `startNewConversation` also sends the
    // typed message and closes the surface — so the button that was "busy"
    // is gone by now, replaced by the live conversation. What matters is
    // that exactly one mint happened and the composer is what is left.
    release();
    await settle();
    expect(find('.dh-newconvo-form')).toBeNull();
    expect(query<HTMLElement>('.dh-composer').hidden).toBe(false);
    expect(widget.store.client.startNewSession).toHaveBeenCalledTimes(1);
  });

  it('stays on the surface when the new session could not be opened', async () => {
    sessionRows = [summaryRow()];
    const { widget } = await openedWidget();
    vi.spyOn(widget.store.client, 'startNewSession').mockRejectedValue(new Error('nope'));

    await reachStartSurface();
    query<HTMLButtonElement>('.dh-newconvo-form .dh-form-submit').click();
    await settle();

    // Dropping the customer onto an empty transcript would hide the fact that
    // nothing actually happened, and the typed message would be lost with it.
    expect(find('.dh-newconvo-form')).not.toBeNull();
    expect(query<HTMLTextAreaElement>('.dh-newconvo-message').value).toBe('Hello');
  });
});

describe('the SWITCHED-close pairing', () => {
  it('does not close the conversation the customer just switched INTO', async () => {
    sessionRows = [summaryRow({ id: 'sess_past', status: 'CLOSED' })];
    const { widget, socket } = await openedWidget();
    await goToMessages();

    const row = messagesRows()[0];
    if (row === undefined) throw new Error('no row rendered');
    row.click();
    await settle();

    const live = await driveHandshakes();
    const join = live.frames('session.join')[0];
    if (join === undefined) throw new Error('no session.join frame was sent');
    live.onmessage?.({
      data: JSON.stringify({ v: 1, t: 'ack', id: frameId(), ref: join.id, ts: Date.now(), d: { ok: true } }),
    });
    await settle();

    // The server acks the switch...
    live.push('session.updated', {
      session: {
        sessionId: 'sess_past',
        status: 'WAITING_FOR_AGENT',
        mode: 'HUMAN',
        participants: [{ participantId: 'cus_1', type: 'CUSTOMER' }],
        createdAt: '2026-08-19T09:00:00.000Z',
      },
    });
    await settle();

    // ...and, in either order, closes the OTHER session the customer left
    // behind. One customer, one live conversation.
    live.push('session.closed', { sessionId: 'sess_current', closeReason: 'SWITCHED' });
    await settle();

    // The session just switched into must survive both halves of that pair.
    expect(widget.store.getState().session?.id).toBe('sess_past');
    expect(query<HTMLElement>('.dh-system').hidden).toBe(true);
    expect(query<HTMLTextAreaElement>('.dh-input').disabled).toBe(false);
  });
});

describe('an embed whose client has no session summary source', () => {
  it('mounts, connects and chats exactly as before — with no rows and no error', async () => {
    const errors: unknown[] = [];
    const widget = mount(config({ onError: (error) => errors.push(error) }));
    await settle();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error('no socket');
    socket.open();
    socket.ack();
    await settle();

    vi.spyOn(widget.store.client, 'listSessions').mockRejectedValue(
      new ChatClientConfigError('listSessions() requires config.sessionSummarySource'),
    );

    widget.open();
    await settle();

    expect(homeShowsRecentRow()).toBe(false);
    await goToMessages();
    expect(messagesRows()).toHaveLength(0);

    // A configuration fact, not a fault: reporting it would fire on every page
    // load of an embed that simply has no session list.
    expect(errors).toHaveLength(0);
  });

  it('still reports a genuine failure to load the list', async () => {
    const errors: unknown[] = [];
    const widget = mount(config({ onError: (error) => errors.push(error) }));
    await settle();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error('no socket');
    socket.open();
    socket.ack();
    await settle();
    errors.length = 0;

    vi.spyOn(widget.store.client, 'listSessions').mockRejectedValue(new Error('503'));

    widget.open();
    await settle();

    expect(errors).toHaveLength(1);
    expect(homeShowsRecentRow()).toBe(false);
  });
});

describe('a host that named the session it wants', () => {
  it('opens directly onto the conversation, with Messages still reachable', async () => {
    sessionRows = [summaryRow()];
    await openedWidget({ sessionId: 'sess_named' });

    // Being pointed at one conversation is not the same as being locked into
    // it: the launcher opens straight onto it (skipping Home, which a host
    // that named a session has effectively overridden), but the nav bar
    // still gets there and Messages still renders the full list.
    expect(query<HTMLElement>('.dh-composer').hidden).toBe(false);
    expect(visible(homePane())).toBe(false);

    await goToMessages();
    expect(messagesRows()).toHaveLength(1);
  });
});
