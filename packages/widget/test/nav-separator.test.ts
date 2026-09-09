// @vitest-environment jsdom
//
// The divider between the two bottom-nav tabs (`ui/nav.ts`, `ui/styles.ts`).
//
// `.dh-nav` carried a `border-top` and nothing else, so Home and Messages ran
// together as one undifferentiated strip: two equal-width `flex: 1` columns
// with no edge between them, which reads as one wide control rather than as a
// choice of two.
//
// ── What this file can and cannot prove ───────────────────────────────────
//
// jsdom computes no cascade and no layout, so it cannot show a line on a
// screen. The stylesheet assertion below is a STATIC-ASSET check: it proves
// the sheet declares the border on the adjacent-sibling pair, never that a
// pixel was painted. Only a browser can settle the second thing.
//
// The other half IS behavioural and is the half worth guarding: this is
// decoration, so `ui/nav.ts` must be untouched by it. Two tabs, one
// `role="tablist"`, `role="tab"` on each, a roving tabindex, and no extra
// element or text node between them — a separator drawn as a border adds
// nothing to the accessibility tree, and one drawn as an element would.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount, unmount } from '../src/index.js';
import { STYLES } from '../src/ui/styles.js';
import type { WidgetConfig } from '../src/config.js';

// Assembled at runtime, never a contiguous literal — a literal here blocks the
// push on secret scanning and trips a customer's scanner if they copy a test.
const PUBLISHABLE = 'dhp_' + 'test_' + '0123456789abcdefghijklmn';

/** Opens nothing and reports nothing. The widget must mount regardless. */
class SilentSocket {
  static readonly CONNECTING = 0;
  readonly readyState = 0;
  close = vi.fn();
  send = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
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

/** The declaration block written for exactly this selector, comments removed. */
function bodyOf(selector: string): string {
  const stripped = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    if ((match[1] ?? '').trim().replace(/\s+/g, ' ') === selector) {
      bodies.push((match[2] ?? '').trim().replace(/\s+/g, ' '));
    }
  }
  if (bodies.length !== 1) {
    throw new Error(`expected exactly one rule for "${selector}", found ${bodies.length}`);
  }
  return bodies[0] ?? '';
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('WebSocket', SilentSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ accessToken: 'tok', expiresIn: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  document.body.innerHTML = '';
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe('the nav tab separator, as written in the stylesheet', () => {
  // STATIC-ASSET CHECK. Proves what the sheet declares, not what was painted.
  it('draws a hairline between adjacent tabs, and only between them', () => {
    // The adjacent-sibling pair, so the FIRST tab gets no leading edge — a
    // border on `.dh-nav-tab` itself would draw one against the panel's own
    // left wall as well as between the two.
    const rule = bodyOf('.dh-nav-tab + .dh-nav-tab');
    expect(rule).toMatch(/border-inline-start:\s*1px solid var\(--dh-border\)/);
  });

  // This sheet is RTL-aware — see its existing `margin-inline-start` and
  // `inset-inline-end` — so the divider is a LOGICAL edge. `border-left`
  // would put the line on the same physical side in Arabic or Hebrew, where
  // Messages is the tab on the left and the line belongs on its other side.
  it('uses the logical edge, never a physical one', () => {
    expect(bodyOf('.dh-nav-tab + .dh-nav-tab')).not.toMatch(/border-left|border-right/);
  });

  // D5 is the one visual change in this pass NOT gated on the hero design:
  // the tabs run together on every design, so the fix applies to every design.
  it('is not gated on the hero design', () => {
    const stripped = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
    const pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)) !== null) {
      const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ');
      if (!selector.includes('.dh-nav-tab + .dh-nav-tab')) continue;
      expect(selector).not.toContain('data-design');
    }
  });
});

describe('the separator changes nothing about the tablist', () => {
  // D7. A border is not content: it adds no element, no text node and no
  // accessible node between the two tabs. A `<span>` or a `role="separator"`
  // would have; that is the whole reason this is a border.
  it('leaves the two tabs adjacent, with nothing between them', () => {
    mount(config());

    const nav = query<HTMLElement>('.dh-nav');
    const tabs = [...nav.querySelectorAll('.dh-nav-tab')];
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.nextElementSibling).toBe(tabs[1]);
    // No stray text node either — `childNodes`, not `children`.
    expect(nav.childNodes).toHaveLength(2);
  });

  it('keeps the tablist role, the tab roles and the roving tabindex', () => {
    mount(config());

    const nav = query<HTMLElement>('.dh-nav');
    expect(nav.getAttribute('role')).toBe('tablist');
    expect(nav.getAttribute('aria-label')).toBe('Chat sections');

    const tabs = [...nav.querySelectorAll<HTMLElement>('.dh-nav-tab')];
    expect(tabs.map((tab) => tab.getAttribute('role'))).toEqual(['tab', 'tab']);
    // Home is selected at rest, so exactly one tab is in the tab order.
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1']);
  });
});
