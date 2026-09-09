// @vitest-environment jsdom
//
// The brand band — the header row, the offline banner and the hero header as
// ONE painted element (`.dh-brand-band`) rather than three that each paint
// their own copy of the merchant's gradient.
//
// ── What this file can and cannot prove ───────────────────────────────────
//
// jsdom computes NO cascade and NO layout. Nothing here can show that the
// gradient is continuous across the seam, that the band paints past the space
// it occupies, or that Home's CTA card straddles the band's bottom edge —
// those are rendered-pixel claims, and NOTHING IN THIS REPO GATES THEM TODAY.
// `packages/widget/scripts/verify-appearance.mjs` is the real-Chrome harness
// that could, but as written it asserts the launcher, the panel, the thread
// backdrop, the avatar and the branding row, and contains no assertion that
// names the band, the straddle or gradient continuity at all. Treat every
// rendered claim below as UNVERIFIED until a browser check exists.
//
// What such a check would have to measure, precisely:
//
//   * ONE PAINT. `getComputedStyle('.dh-brand-band').backgroundImage` is a
//     single gradient, while `.dh-header` and `.dh-hero` both report `none` —
//     that is the seam being gone rather than merely undeclared.
//   * THE OVERHANG. `.dh-brand-band`'s bottom border-edge sits BELOW
//     `.dh-home`'s top edge by the straddle distance, and `.dh-home-cta`'s
//     `getBoundingClientRect().top` is above that border edge.
//   * NET ZERO. `.dh-brand-band.offsetHeight` minus its computed
//     `marginBottom` equals the sum of its three children's `offsetHeight`s,
//     which is the "the two cancel, nothing else moves" claim (D6 on the
//     classic design is the same measurement with the rule not applying).
//   * THE COLLAPSE ARITHMETIC. Record `.dh-hero.offsetHeight` and
//     `.dh-home.getBoundingClientRect().top`, force `data-collapsed="true"`,
//     and assert Home's top rose by exactly the recorded hero height — the
//     claim ui/styles.ts's straddle comment marks as expected-not-measured.
//   * D2 LIVE. With `data-collapsed="true"` set,
//     `getComputedStyle('.dh-brand-band').paddingBottom` is `0px`; with it
//     cleared, it is the straddle distance. `:has()` cannot be evaluated in
//     jsdom (nwsapi throws on it), so this half is only ever browser-checkable.
//
// What jsdom CAN settle is the two things the fix is built out of:
//
//   1. the SHADOW TREE — one wrapper, the right three children, in the right
//      order, and the three ATTRIBUTES the straddle's `:has()` matches on
//      actually being produced by the runtime. Those are real behavioural
//      assertions about what `mount()` builds and what it does next.
//   2. the STYLESHEET TEXT — a STATIC-ASSET check, not a behavioural one.
//      Asserting that `background-image: var(--dh-header-layers)` is declared
//      exactly once, on `.dh-brand-band`, proves the sheet no longer asks two
//      elements to paint the same gradient twice. It does NOT prove what any
//      pixel ended up being. Every assertion in `the brand paint, as written
//      in the stylesheet` below is of that second kind and is labelled again
//      where it sits.

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

/**
 * jsdom implements no `IntersectionObserver`, and `watchScroll` feature-detects
 * it and returns early without one — so the collapse path is unreachable in a
 * mounted widget unless a test supplies this. Records the instance so a test
 * can fire the callback the way a real scroll would.
 */
class FakeIntersectionObserver implements IntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [0];
  private readonly callback: IntersectionObserverCallback;
  private readonly observed = new Set<Element>();

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = (options?.root as Element | Document | null | undefined) ?? null;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }
  unobserve(target: Element): void {
    this.observed.delete(target);
  }
  disconnect(): void {
    this.observed.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Fires the callback as the browser would for the one observed marker. */
  fire(isIntersecting: boolean): void {
    if (this.observed.size === 0) throw new Error('nothing observed yet');
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this);
  }
}

/**
 * Layout numbers jsdom never computes.
 *
 * The collapse guard reads `offsetHeight`/`scrollHeight`/`clientHeight` at the
 * moment it decides; all three are 0 here, which the guard correctly reads as
 * "nothing to free and nothing scrolled" and refuses. A test that wants to
 * reach the collapse has to stand in for the layout that would have allowed it.
 */
function stubGeometry(
  node: HTMLElement,
  dims: { scrollHeight?: number; clientHeight?: number; offsetHeight?: number },
): void {
  for (const [key, value] of Object.entries(dims)) {
    Object.defineProperty(node, key, { configurable: true, value });
  }
}

function config(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    auth: { publishableKey: PUBLISHABLE, tokenEndpoint: '/api/chat-token' },
    identity: { userId: 'cus_1' },
    apiUrl: 'https://chat.example.com',
    wsUrl: 'wss://chat.example.com',
    // Swallowed rather than printed: connect() rejects in this environment by
    // design, and a red wall of expected failures hides a real one.
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

/** The bottom tab bar's Messages tab — the one way off Home that keeps a tab. */
function messagesTab(): HTMLButtonElement {
  const tab = [...shadow().querySelectorAll<HTMLButtonElement>('.dh-nav-tab')].find((button) =>
    button.textContent?.includes('Messages'),
  );
  if (tab === undefined) throw new Error('no Messages tab');
  return tab;
}

/**
 * The stylesheet, as a list of `{ selector, body }` pairs.
 *
 * A crude flat split rather than jsdom's CSSOM on purpose: jsdom's parser
 * silently DROPS rules whose syntax it does not know (`:has()` among them,
 * which is exactly the selector the straddle is gated on), so a rule that
 * vanished from `cssRules` would read here as a rule that was never written.
 * Splitting the text keeps the assertion honest about what the file SAYS.
 *
 * Comments come out first — this sheet's comments quote CSS at length, and a
 * brace inside one would otherwise land in a selector.
 *
 * ── The limitation ────────────────────────────────────────────────────────
 *
 * It FLATTENS at-rules. The pattern matches one `selector { body }` pair with
 * no nesting, so an `@media`/`@supports`/`@keyframes` block is not recognised
 * as a container: its opening line is skipped and each rule inside it is
 * emitted as though it were top-level, with its condition thrown away. This
 * sheet has several (`prefers-color-scheme`, `prefers-reduced-motion`,
 * `pointer: fine`, `hover: none`, `@keyframes dh-bounce`). So `bodyOf` and
 * `selectorsDeclaring` answer "is this declared ANYWHERE in the file",
 * never "is this declared unconditionally" — and a selector that appears both
 * at top level and inside a media query would make `bodyOf` throw on its own
 * uniqueness check rather than pick one. Nothing the band needs is inside an
 * at-rule today; a check that grows to need at-rule awareness should reach for
 * a real CSS parser rather than deepen this regex.
 */
function cssRules(css: string): ReadonlyArray<{ selector: string; body: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    rules.push({
      selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
      body: (match[2] ?? '').trim().replace(/\s+/g, ' '),
    });
  }
  return rules;
}

/** Every selector whose block declares something matching `declaration`. */
function selectorsDeclaring(declaration: RegExp): readonly string[] {
  return cssRules(STYLES)
    .filter((rule) => declaration.test(rule.body))
    .map((rule) => rule.selector);
}

/** The one block written for exactly this selector. */
function bodyOf(selector: string): string {
  const found = cssRules(STYLES).filter((rule) => rule.selector === selector);
  if (found.length !== 1) {
    throw new Error(`expected exactly one rule for "${selector}", found ${found.length}`);
  }
  return found[0]?.body ?? '';
}

/**
 * The one rule that makes the band overhang Home.
 *
 * Found by what it DOES — it is the only rule in the sheet that names the
 * straddle distance — rather than by pinning its ~130-character selector as a
 * literal. A literal would fail on any benign edit to the selector (a reordered
 * `:not()`, a fourth guard, a whitespace change) while proving nothing about
 * the invariants that actually matter; those are asserted one at a time below.
 */
function straddleRule(): { selector: string; body: string } {
  const found = cssRules(STYLES).filter((rule) => rule.body.includes('--dh-band-straddle:'));
  if (found.length !== 1) {
    throw new Error(`expected exactly one rule declaring --dh-band-straddle, found ${found.length}`);
  }
  return found[0]!;
}

beforeEach(() => {
  localStorage.clear();
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('WebSocket', SilentSocket);
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
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

describe('the brand band, in the shadow tree', () => {
  // The behavioural half: what `mount()` actually builds. One wrapper is the
  // whole premise — two would mean two painted bands again, and none means
  // the header row and the hero are still separate paints.
  it('wraps the header row, the offline banner and the hero in one element', () => {
    mount(config({ design: 'hero' }));

    expect(shadow().querySelectorAll('.dh-brand-band')).toHaveLength(1);

    const band = query('.dh-brand-band');
    expect([...band.children].map((child) => child.className)).toEqual([
      'dh-header',
      'dh-offline-banner',
      'dh-hero',
    ]);
  });

  // The band is a wrapper and nothing else. D7: it adds no role, no label and
  // no tab stop, so the a11y tree and the focus order are exactly what they
  // were before it existed — and the hero inside it keeps its own
  // `aria-hidden`, which is the one a11y promise this area already made.
  it('adds no role, no label and no tab stop of its own', () => {
    mount(config({ design: 'hero' }));

    const band = query('.dh-brand-band');
    expect(band.tagName).toBe('DIV');
    expect(band.getAttribute('role')).toBeNull();
    expect(band.getAttribute('aria-label')).toBeNull();
    expect(band.getAttribute('aria-hidden')).toBeNull();
    expect(band.getAttribute('tabindex')).toBeNull();
    expect(query('.dh-hero').getAttribute('aria-hidden')).toBe('true');
  });

  // The straddle works by the band overhanging the element that follows it,
  // so "what follows it" is load-bearing rather than incidental: the panel's
  // grab handle stays in front, Home stays immediately behind.
  it('sits between the sheet grip and the Home screen', () => {
    mount(config({ design: 'hero' }));

    const band = query('.dh-brand-band');
    expect(band.previousElementSibling?.className).toBe('dh-grip');
    expect(band.nextElementSibling?.className).toBe('dh-home');
  });

  // The classic design gets the same wrapper — it is structural, and gating
  // the MARKUP on a design would give the two designs two different trees to
  // reason about. Only the paint is gated (see the stylesheet checks below).
  it('is present under the classic design too, with the hero still hidden', () => {
    mount(config());

    expect(shadow().querySelectorAll('.dh-brand-band')).toHaveLength(1);
    expect(query<HTMLElement>('.dh-hero').hidden).toBe(true);
  });
});

// ── D2's untestable half, and its testable one ────────────────────────────
//
// The straddle retracts via
// `.dh-brand-band:has(.dh-hero:not([hidden]):not([data-empty="true"])
// :not([data-collapsed="true"]))`. That selector has two halves, and they fail
// in different places:
//
//   * the SELECTOR cannot be evaluated here at all. jsdom delegates to nwsapi,
//     which throws on `:has()`, so no amount of jsdom work will show the
//     overhang retracting. Only a browser can (see this file's header).
//   * the ATTRIBUTES it matches on are pure runtime behaviour, and those ARE
//     testable — nothing asserted them before this block existed.
//
// The realistic future break is someone reaching for a class, or for
// `visibility: hidden`, or for `style.display` alone, to express one of these
// three states. The selector would silently stop matching and the overhang
// would stop retracting; a stylesheet-text assertion sails straight past it,
// because the sheet would still read exactly as it does today. These
// assertions read ATTRIBUTES for that reason, not properties or classes.
describe('the three states the straddle retracts on, as the runtime produces them', () => {
  it('leaves all three guards satisfied while the hero is really showing on Home', () => {
    mount(config({ design: 'hero', header: { greeting: 'Hello there' } }));

    const hero = query<HTMLElement>('.dh-hero');
    expect(hero.hasAttribute('hidden')).toBe(false);
    expect(hero.getAttribute('data-empty')).toBe('false');
    expect(hero.getAttribute('data-collapsed')).not.toBe('true');
  });

  // `setPaneVisible` — the one place the widget shows and hides a screen's
  // furniture. It must set the `hidden` ATTRIBUTE, because that is what the
  // `:not([hidden])` guard reads; an inline `display: none` on its own would
  // hide the hero and leave the band overhanging Home by the straddle
  // distance with nothing under it.
  it('sets the hidden ATTRIBUTE on the hero when the visitor leaves Home', () => {
    mount(config({ design: 'hero', header: { greeting: 'Hello there' } }));
    expect(query<HTMLElement>('.dh-hero').hasAttribute('hidden')).toBe(false);

    messagesTab().click();

    expect(query<HTMLElement>('.dh-hero').hasAttribute('hidden')).toBe(true);
  });

  // `render()`'s own emptiness rule, reached through a real publish rather
  // than through the component: a merchant with no greeting, no logo, no
  // faces and no sub-line has turned the hero off, and the band must not go
  // on overhanging Home for a block with nothing in it.
  it('sets data-empty="true" on a hero the merchant left nothing in', () => {
    mount(config({ design: 'hero' }));

    expect(query<HTMLElement>('.dh-hero').getAttribute('data-empty')).toBe('true');
  });

  // The collapse, driven through the observer the way a scroll would. The
  // guard is satisfied by the stubbed geometry: 600 - 300 = 300px of overflow
  // against a 120px hero leaves 180px, comfortably past the 32px slack.
  it('sets data-collapsed="true" on the hero when the scroll watch fires', () => {
    mount(config({ design: 'hero', header: { greeting: 'Hello there' } }));

    stubGeometry(query<HTMLElement>('.dh-home'), { scrollHeight: 600, clientHeight: 300 });
    stubGeometry(query<HTMLElement>('.dh-hero'), { offsetHeight: 120 });

    const observer = FakeIntersectionObserver.instances[0];
    if (observer === undefined) throw new Error('the hero never started watching Home');

    observer.fire(false);
    expect(query<HTMLElement>('.dh-hero').getAttribute('data-collapsed')).toBe('true');

    observer.fire(true);
    expect(query<HTMLElement>('.dh-hero').getAttribute('data-collapsed')).toBe('false');
  });
});

describe('the brand paint, as written in the stylesheet', () => {
  // ── STATIC-ASSET CHECKS ─────────────────────────────────────────────────
  //
  // Everything below reads the exported STYLES string. It proves what the
  // sheet DECLARES, never what was painted: jsdom applies no cascade, so a
  // rule that is present here and overridden in a real browser would still
  // pass. The continuity of the gradient across the seam, and the card's
  // overlap of the band, are real-browser claims and are NOT tested here.

  it('declares the merchant gradient exactly once, on the band', () => {
    // Defect (A): the gradient was declared twice — on `.dh-header` and again
    // on `.dh-hero` — so a top-to-bottom fade restarted at the seam and
    // painted two visibly distinct bands.
    expect(selectorsDeclaring(/background-image:\s*var\(--dh-header-layers\)/)).toEqual([
      ':host([data-design="hero"]) .dh-brand-band',
    ]);
    expect(selectorsDeclaring(/background-color:\s*var\(--dh-header-bg\)/)).toEqual([
      ':host([data-design="hero"]) .dh-brand-band',
    ]);
  });

  it('leaves the hero and the header row with no background of their own', () => {
    expect(bodyOf('.dh-hero')).not.toMatch(/background/);
    expect(bodyOf('.dh-hero')).toContain('flex: none');

    // The header row keeps the one declaration that was never about paint:
    // the hairline it must NOT draw on top of the brand colour. Asserted as a
    // presence plus an absence rather than as the whole block verbatim — a
    // benign extra declaration here is not a regression, a background is.
    const headerRow = bodyOf(':host([data-design="hero"]) .dh-header');
    expect(headerRow).toContain('border-bottom-color: transparent');
    expect(headerRow).not.toMatch(/background/);
  });

  // Defect (B): Home's CTA card sat entirely below the band. The band now
  // overhangs Home by the straddle distance — declared as ONE named value,
  // used twice in the one rule that owns it.
  it('extends the band past the seam by one named distance, and pulls Home back up by it', () => {
    const straddle = straddleRule().body;

    // Off the spacing token, never a bare pixel count: the two uses must stay
    // equal, and a literal in either is a literal that can drift alone.
    expect(straddle).toMatch(/--dh-band-straddle:\s*calc\(var\(--dh-space\) \* 12\)/);
    expect(straddle).toContain('padding-bottom: var(--dh-band-straddle)');
    expect(straddle).toContain('margin-bottom: calc(var(--dh-band-straddle) * -1)');
    expect(straddle).not.toMatch(/padding-bottom:\s*-?[\d.]/);
    expect(straddle).not.toMatch(/margin-bottom:\s*-?[\d.]/);

    // A stacking context on the band would trap the header menu (z-index 3)
    // inside it and let Home's card paint over an OPEN menu.
    expect(straddle).not.toMatch(/z-index|transform|filter|isolation|contain/);
  });

  // D2's second half. The overhang must exist ONLY while the hero is really
  // showing: a stale one would pull Home up under the header row the moment
  // the hero collapses on scroll, or on Messages, where the hero is hidden
  // outright — the card would paint over the header row. Each `:not()` here
  // mirrors one of the rules that takes the hero out of the layout, and the
  // block above proves the runtime actually sets what they match on.
  it('applies the overhang only while the hero is expanded and showing', () => {
    const rule = straddleRule();

    const applied = selectorsDeclaring(/margin-bottom: calc\(var\(--dh-band-straddle\) \* -1\)/);
    expect(applied).toEqual([rule.selector]);

    // D6, on the selector rather than on the body: the overhang moves nothing
    // for a merchant who never asked for the hero design.
    expect(rule.selector).toContain(':host([data-design="hero"])');
    expect(rule.selector).toContain('.dh-brand-band:has(');

    // `[hidden]` and `[data-empty="true"]` are the two `display: none` rules
    // on `.dh-hero`; `[data-collapsed="true"]` is the height-0 one.
    expect(bodyOf('.dh-hero[hidden], .dh-hero[data-empty="true"]')).toContain('display: none');
    expect(bodyOf('.dh-hero[data-collapsed="true"]')).toContain('height: 0');
    for (const guard of [':not([hidden])', ':not([data-empty="true"])', ':not([data-collapsed="true"])']) {
      expect(rule.selector).toContain(guard);
    }
  });

  // D6: nothing the classic design renders may move. The band's only ungated
  // rule is layout — a column that stacks the same three children it already
  // stacked — and every declaration that PAINTS is behind the host attribute.
  it('gates every painted band rule on the hero design', () => {
    const bandRules = cssRules(STYLES).filter((rule) => /\.dh-brand-band\b/.test(rule.selector));
    const ungated = bandRules.filter((rule) => !rule.selector.includes('[data-design="hero"]'));

    expect(ungated.map((rule) => rule.selector)).toEqual(['.dh-brand-band']);

    // The load-bearing declarations, plus the thing that must never appear:
    // anything that paints, spaces or offsets, because on the classic design
    // this box has to be exactly as tall as the children it wraps.
    const structural = ungated[0]?.body ?? '';
    expect(structural).toContain('flex: none');
    expect(structural).toContain('display: flex');
    expect(structural).toContain('flex-direction: column');
    expect(structural).not.toMatch(/background|border|box-shadow|padding|margin|z-index/);
  });
});
