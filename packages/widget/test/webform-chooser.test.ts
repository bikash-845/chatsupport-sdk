// @vitest-environment jsdom
//
// The visitor-facing chooser, end to end through a real mounted widget.
// support-entry.test.ts already proves entryFor/shouldMount in isolation, and
// webform-client.test.ts already proves the submit client in isolation.
// Neither would catch the failure that matters most here — the right entry
// resolved and then wired to nothing on screen — so this file exercises the
// seam, the same reason remote-config-gating.test.ts exists for the rest of
// published config. Reuses that file's harness shape (`published`,
// `stubFetch`, `shadow`/`find`, `settle`) rather than importing it — test
// files are not modules other suites import from in this package.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount, unmount } from '../src/index.js';
import { OFFLINE_MODE } from '../src/remote-config.js';
import { tabbableWithin } from '../src/ui/focus.js';
import type { WidgetConfig } from '../src/config.js';

const PUBLISHABLE = 'dhp_' + 'test_' + '0123456789abcdefghijklmn';

class SilentSocket {
  static readonly CONNECTING = 0;
  readonly readyState = 0;
  close = vi.fn();
  send = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

/**
 * A socket that can ack a session and later push a status change — the
 * "store tick" the gate-1 carve-out test needs. Shaped like
 * pre-chat-preemption.test.ts's own `FakeWebSocket`, trimmed to the two
 * frames this file drives by hand.
 */
class TickingSocket {
  static instances: TickingSocket[] = [];
  static readonly CONNECTING = 0;
  readonly readyState = 1;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

  constructor(readonly url: string) {
    TickingSocket.instances.push(this);
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
  ack(sessionId: string, status = 'ASSIGNED'): void {
    this.onmessage?.({
      data: JSON.stringify({
        v: 1,
        t: 'connection.ack',
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        ts: Date.now(),
        d: {
          protocolVersion: 1,
          seq: 0,
          session: {
            sessionId,
            status,
            mode: 'HUMAN',
            participants: [{ participantId: 'cus_1', type: 'CUSTOMER' }],
            createdAt: new Date().toISOString(),
          },
        },
      }),
    });
  }
  updateStatus(sessionId: string, status: string): void {
    this.onmessage?.({
      data: JSON.stringify({
        v: 1,
        t: 'session.updated',
        id: '01ARZ3NDEKTSV4RRFFQ69G5FBV',
        ts: Date.now(),
        d: {
          session: {
            sessionId,
            status,
            mode: 'HUMAN',
            participants: [{ participantId: 'cus_1', type: 'CUSTOMER' }],
            createdAt: new Date().toISOString(),
          },
        },
      }),
    });
  }
}

function config(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    auth: { publishableKey: PUBLISHABLE, tokenEndpoint: '/api/chat-token' },
    identity: { userId: 'cus_1' },
    apiUrl: 'https://chat.example.com',
    wsUrl: 'wss://chat.example.com',
    onError: () => undefined,
    ...overrides,
  };
}

/** The published-config body, with only what a test cares about overridden. */
function published(data: Record<string, unknown> = {}): unknown {
  return {
    success: true,
    data: {
      enabled: true,
      appearance: {},
      behaviour: {},
      offlineMode: OFFLINE_MODE.SHOW_MESSAGE,
      isOpenNow: null,
      flows: [],
      publishedVersion: 1,
      ...data,
    },
  };
}

let webformPost: ReturnType<typeof vi.fn>;

/**
 * Serves the token mint, the sessions list and history pages statelessly, and
 * routes `GET /widget/config` through `configBody` — a getter, so a test can
 * swap what the NEXT fetch answers with (the stale-refresh and
 * `CHANNEL_DISABLED` recovery tests both re-fetch mid-test). `POST
 * /widget/webform` goes through the shared `webformPost` mock so a test can
 * assert on exactly what was sent and control what comes back.
 */
function stubFetch(configBody: () => unknown, { failConfig = false } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/widget/webform')) return webformPost(url, init);
      if (url.includes('/widget/config')) {
        if (failConfig) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify(configBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/chat/sessions/customer')) {
        return new Response(JSON.stringify({ success: true, data: { sessions: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/chat/sessions/')) {
        return new Response(JSON.stringify({ success: true, data: { messages: [], hasMore: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ accessToken: 'tok', expiresIn: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function shadow(): ShadowRoot {
  const element = document.querySelector<HTMLElement>('dh-chat-widget');
  if (element?.shadowRoot == null) throw new Error('widget not mounted');
  return element.shadowRoot;
}

const find = <T extends Element>(selector: string): T | null => shadow().querySelector<T>(selector);

/** Lets a fetch's promise chain, and everything chained off it, land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('WebSocket', SilentSocket);
  webformPost = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ outcome: 'ticket', receiptId: 'r1', duplicate: false }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
  );
  document.body.innerHTML = '';
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

async function mountHome(configBody: unknown): Promise<ReturnType<typeof mount>> {
  stubFetch(() => configBody);
  const widget = mount(config());
  await settle();
  widget.open();
  await settle();
  return widget;
}

describe('the six PRD rows, as Home affordances', () => {
  it('row 1 — chat + ticket, open: "Chat now" is the CTA, with an alt to leave a message', async () => {
    await mountHome(published({ support: { primary: 'chat', secondary: 'ticket', hours: 'OPEN' } }));

    expect(find('.dh-home-cta-title')?.textContent).toBe('Chat now');
    const alt = find<HTMLButtonElement>('.dh-home-alt');
    expect(alt?.hidden).toBe(false);
    expect(alt?.textContent).toBe('Leave a message instead');
  });

  it('row 2 — ticket + chat, closed: "Leave a message" is the CTA, with an alt to try chat anyway', async () => {
    await mountHome(published({ support: { primary: 'ticket', secondary: 'chat', hours: 'CLOSED' } }));

    expect(find('.dh-home-cta-title')?.textContent).toBe('Leave a message');
    expect(find('.dh-home-cta-sub')?.textContent).toBe("We're closed — we'll reply by email.");
    const alt = find<HTMLButtonElement>('.dh-home-alt');
    expect(alt?.hidden).toBe(false);
    expect(alt?.textContent).toBe('Try live chat anyway');
  });

  it('row 2\'s CTA opens the webform surface directly, not a chooser screen', async () => {
    await mountHome(published({ support: { primary: 'ticket', secondary: 'chat', hours: 'CLOSED' } }));

    find<HTMLButtonElement>('.dh-home-cta')!.click();
    await settle();
    expect(find('.dh-webform-form')).not.toBeNull();
  });

  it('row 3 — chat only, open: "Chat now", no alt', async () => {
    await mountHome(published({ support: { primary: 'chat', secondary: null, hours: 'OPEN' } }));

    expect(find('.dh-home-cta-title')?.textContent).toBe('Chat now');
    expect(find<HTMLButtonElement>('.dh-home-alt')?.hidden).toBe(true);
  });

  it('row 4 — offline, closed, SHOW_MESSAGE: byte-identical to today (no alt, default CTA)', async () => {
    await mountHome(
      published({
        offlineMode: OFFLINE_MODE.SHOW_MESSAGE,
        isOpenNow: false,
        support: { primary: 'offline', secondary: null, hours: 'CLOSED' },
      }),
    );

    expect(find('.dh-home-cta-title')?.textContent).toBe('Send us a message');
    expect(find<HTMLButtonElement>('.dh-home-alt')?.hidden).toBe(true);
  });

  it('row 5 — ticket only: "Leave a message", no alt, and the launcher survives HIDE_WIDGET', async () => {
    await mountHome(
      published({
        offlineMode: OFFLINE_MODE.HIDE_WIDGET,
        isOpenNow: false,
        support: { primary: 'ticket', secondary: null, hours: 'CLOSED' },
      }),
    );

    expect(find('.dh-launcher')).not.toBeNull();
    expect(find('.dh-home-cta-title')?.textContent).toBe('Leave a message');
    expect(find('.dh-home-cta-sub')?.textContent).toBe("We'll reply by email.");
    expect(find<HTMLButtonElement>('.dh-home-alt')?.hidden).toBe(true);
  });

  it('row 6 — none: no launcher at all', async () => {
    stubFetch(() => published({ support: { primary: 'none', secondary: null, hours: 'OPEN' } }));
    const widget = mount(config());
    await settle();
    void widget;

    expect(find<HTMLElement>('.dh-launcher')?.hidden).toBe(true);
  });
});

describe('offline reuses the existing path rather than a new one', () => {
  it('row 4 (chat only, closed) under COLLECT_MESSAGE still renders the built-in offline form, not a webform', async () => {
    await mountHome(
      published({
        offlineMode: OFFLINE_MODE.COLLECT_MESSAGE,
        isOpenNow: false,
        support: { primary: 'offline', secondary: null, hours: 'CLOSED' },
      }),
    );

    expect(find('.dh-offline-form')).not.toBeNull();
    expect(find('.dh-webform-form')).toBeNull();
  });

  it('a Row-2 tenant (ticket + chat, closed) under COLLECT_MESSAGE gets the webform in the SAME "offline" gate, not a second one', async () => {
    await mountHome(
      published({
        offlineMode: OFFLINE_MODE.COLLECT_MESSAGE,
        isOpenNow: false,
        support: { primary: 'ticket', secondary: 'chat', hours: 'CLOSED' },
      }),
    );

    // The gate builds a webform-shaped form (POSTs and files a ticket) rather
    // than the built-in offline form (which only sends a chat message) —
    // §6's "upgrade in place" — but the automatic form has no Cancel: it is
    // standing in for the composer, not a detour.
    expect(find('.dh-webform-form')).not.toBeNull();
    expect(find('.dh-offline-form')).toBeNull();
    expect(find('.dh-webform-form .dh-form-skip')).toBeNull();
  });
});

describe('boot-fetch failure degrades safely', () => {
  it('renders the pre-chooser default: a chat CTA that opens a real conversation, never a dead end', async () => {
    stubFetch(() => published(), { failConfig: true });
    const widget = mount(config());
    await settle();
    widget.open();
    await settle();

    expect(find('.dh-launcher')).not.toBeNull();
    expect(find('.dh-home-cta-title')?.textContent).toBe('Send us a message');
    expect(find<HTMLButtonElement>('.dh-home-alt')?.hidden).toBe(true);

    find<HTMLButtonElement>('.dh-home-cta')!.click();
    await settle();
    // composingNew, never a webform this bundle cannot fulfil.
    expect(find('.dh-newconvo-form, .dh-newconvo')).not.toBeNull();
    expect(find('.dh-webform-form')).toBeNull();
  });

  it('a 200 with no support key at all degrades identically', async () => {
    await mountHome(published());
    expect(find('.dh-home-cta-title')?.textContent).toBe('Send us a message');
    expect(find('.dh-launcher')).not.toBeNull();
  });
});

describe('a malformed/unknown primary from a future server', () => {
  it('does not crash the widget, and degrades to the same chat default', async () => {
    await expect(
      mountHome(published({ support: { primary: 'callback', secondary: null, hours: 'OPEN' } })),
    ).resolves.toBeDefined();

    expect(find('.dh-home-cta-title')?.textContent).toBe('Send us a message');
    expect(find('.dh-launcher')).not.toBeNull();
  });

  it('an unknown hours value degrades the same way', async () => {
    await expect(
      mountHome(published({ support: { primary: 'chat', secondary: 'ticket', hours: 'LUNCHTIME' } })),
    ).resolves.toBeDefined();

    expect(find('.dh-home-cta-title')?.textContent).toBe('Send us a message');
  });
});

describe('the submit path sends what the endpoint expects', () => {
  it('POSTs prefer: ticket, the honeypot, a submissionId and a positive fillMs', async () => {
    await mountHome(published({ support: { primary: 'chat', secondary: 'ticket', hours: 'OPEN' } }));

    find<HTMLButtonElement>('.dh-home-alt')!.click();
    await settle();
    expect(find('.dh-webform-form')).not.toBeNull();

    find<HTMLInputElement>('#dh-webform-email')!.value = 'ada@example.com';
    find<HTMLTextAreaElement>('#dh-webform-message')!.value = 'Where is my order?';
    find<HTMLFormElement>('.dh-webform-form')!.requestSubmit();
    await settle();

    expect(webformPost).toHaveBeenCalledTimes(1);
    const [url, init] = webformPost.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/widget/webform');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Publishable-Key']).toBe(PUBLISHABLE);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['prefer']).toBe('ticket');
    expect(body['company_website']).toBe('');
    expect(body['email']).toBe('ada@example.com');
    expect(body['message']).toBe('Where is my order?');
    expect(typeof body['submissionId']).toBe('string');
    expect((body['submissionId'] as string).length).toBeGreaterThanOrEqual(8);
    expect(body['fillMs']).toBeGreaterThanOrEqual(0);

    // Success replaces the form with a confirmation naming the email.
    expect(find('.dh-webform .dh-offline-sent')?.textContent).toContain('ada@example.com');
  });

  it('the honeypot is never a tab stop and never in the accessibility tree', async () => {
    await mountHome(published({ support: { primary: 'ticket', secondary: null, hours: 'OPEN' } }));
    find<HTMLButtonElement>('.dh-home-cta')!.click();
    await settle();

    const wrap = find<HTMLElement>('.dh-webform-form .dh-sr');
    const honeypot = find<HTMLInputElement>('#dh-webform-company-website');
    expect(wrap?.getAttribute('aria-hidden')).toBe('true');
    expect(honeypot?.getAttribute('tabindex')).toBe('-1');

    const panel = find<HTMLElement>('.dh-panel')!;
    expect(honeypot).not.toBeNull();
    expect(tabbableWithin(panel)).not.toContain(honeypot);
  });

  it('a 429 leaves the typed message on screen and the button re-enabled', async () => {
    await mountHome(published({ support: { primary: 'ticket', secondary: null, hours: 'OPEN' } }));
    find<HTMLButtonElement>('.dh-home-cta')!.click();
    await settle();
    webformPost.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '30' },
      }),
    );

    find<HTMLInputElement>('#dh-webform-email')!.value = 'ada@example.com';
    find<HTMLTextAreaElement>('#dh-webform-message')!.value = 'Still there?';
    find<HTMLFormElement>('.dh-webform-form')!.requestSubmit();
    await settle();

    expect(find<HTMLTextAreaElement>('#dh-webform-message')?.value).toBe('Still there?');
    const submit = find<HTMLButtonElement>('.dh-webform-form .dh-form-submit')!;
    expect(submit.disabled).toBe(false);
    expect(find('.dh-webform-form .dh-form-error')?.textContent).toContain('Too many messages');
  });
});

describe('CHANNEL_DISABLED — a stale-cache signal, not a plain error', () => {
  it('when the refresh agrees the channel is gone, tells the visitor and hands the slot back', async () => {
    let body: unknown = published({ support: { primary: 'ticket', secondary: null, hours: 'OPEN' } });
    stubFetch(() => body);
    webformPost.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CHANNEL_DISABLED', message: 'off', retryable: false } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const widget = mount(config());
    await settle();
    widget.open();
    await settle();
    expect(find('.dh-home-cta')).not.toBeNull();

    find<HTMLButtonElement>('.dh-home-cta')!.click();
    await settle();
    find<HTMLInputElement>('#dh-webform-email')!.value = 'ada@example.com';
    find<HTMLTextAreaElement>('#dh-webform-message')!.value = 'Hello?';

    // The tenant switched the channel off between render and submit.
    body = published({ support: { primary: 'none', secondary: null, hours: 'OPEN' } });
    find<HTMLFormElement>('.dh-webform-form')!.requestSubmit();
    await settle();

    expect(find('.dh-webform-form')).toBeNull();
    expect(find<HTMLElement>('.dh-launcher')?.hidden).toBe(true);
  });

  it('when the refresh disagrees with the 403, treats it as transient and keeps the visitor\'s text', async () => {
    const body = published({ support: { primary: 'ticket', secondary: null, hours: 'OPEN' } });
    stubFetch(() => body);
    webformPost.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CHANNEL_DISABLED', message: 'off', retryable: false } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const widget = mount(config());
    await settle();
    widget.open();
    await settle();
    find<HTMLButtonElement>('.dh-home-cta')!.click();
    await settle();
    find<HTMLInputElement>('#dh-webform-email')!.value = 'ada@example.com';
    find<HTMLTextAreaElement>('#dh-webform-message')!.value = 'Hello?';
    find<HTMLFormElement>('.dh-webform-form')!.requestSubmit();
    await settle();

    // The refresh still says a ticket destination exists — the 403 does not
    // get to overrule what the config re-fetch just confirmed.
    expect(find('.dh-webform-form')).not.toBeNull();
    expect(find<HTMLTextAreaElement>('#dh-webform-message')?.value).toBe('Hello?');
    expect(find('.dh-webform-form .dh-form-error')?.textContent).toMatch(/try again/i);
  });
});

describe('the gate-1 carve-out', () => {
  it('a store tick does not rebuild a webform surface the visitor opened by hand, under COLLECT_MESSAGE while closed', async () => {
    stubFetch(() =>
      published({
        offlineMode: OFFLINE_MODE.COLLECT_MESSAGE,
        isOpenNow: false,
        support: { primary: 'ticket', secondary: 'chat', hours: 'CLOSED' },
      }),
    );
    vi.stubGlobal('WebSocket', TickingSocket);
    TickingSocket.instances = [];

    const widget = mount(config());
    await settle();
    const socket = TickingSocket.instances[0];
    if (socket === undefined) throw new Error('no socket was opened');
    socket.open();
    socket.ack('sess_1');
    await settle();
    widget.open();
    await settle();

    // Gate 1 has already auto-claimed the slot with a webform-shaped
    // AUTOMATIC form (kind 'offline', §6's "upgrade in place") — the panel
    // landed on the conversation screen rather than Home, and Back is
    // offered because `openSurface` pushed 'home' onto the stack on its way
    // there.
    expect(find('.dh-webform-form')).not.toBeNull();
    expect(find('.dh-webform-form .dh-form-skip')).toBeNull(); // no Cancel — this one is automatic.
    expect(find<HTMLElement>('.dh-back')?.hidden).toBe(false);

    // The visitor backs out to Home and presses the CTA themselves. Row 2's
    // CTA opens the webform surface DIRECTLY (§2), replacing the automatic
    // 'offline'-kind form with a genuine, USER-INITIATED 'webform'-kind one.
    find<HTMLButtonElement>('.dh-back')!.click();
    await settle();
    expect(find<HTMLElement>('.dh-home')?.hidden).toBe(false);
    find<HTMLButtonElement>('.dh-home-cta')!.click();
    await settle();
    // Proof this is now the user-initiated surface, not the automatic one.
    expect(find('.dh-webform-form .dh-form-skip')).not.toBeNull();

    find<HTMLTextAreaElement>('#dh-webform-message')!.value = 'Half-typed message';

    // A store tick — an agent-side status change is enough, per gate 1's own
    // subscription to the session's id:status. Without the carve-out this
    // would rebuild the gate-1 form and wipe what the visitor was typing.
    socket.updateStatus('sess_1', 'WAITING_FOR_AGENT');
    await settle();

    expect(find('.dh-webform-form')).not.toBeNull();
    expect(find<HTMLTextAreaElement>('#dh-webform-message')?.value).toBe('Half-typed message');
  });
});
