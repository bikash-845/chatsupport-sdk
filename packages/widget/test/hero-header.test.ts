// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHeroHeader, heroContentFrom, type HeroContent } from '../src/ui/hero-header.js';
import { STYLES } from '../src/ui/styles.js';
import type { HeaderAppearance } from '../src/config.js';

function content(overrides: Partial<HeroContent> = {}): HeroContent {
  return {
    showLogo: true,
    logoUrl: 'https://cdn.acme.test/logo.png',
    showAvatars: true,
    showPresence: true,
    avatars: ['https://cdn.acme.test/a.png', 'https://cdn.acme.test/b.png'],
    greeting: 'Hello there',
    subGreeting: 'Ask us anything',
    ...overrides,
  };
}

/**
 * A published `HeaderAppearance`, field for field as the console writes it.
 *
 * Needed as its own helper because `ctaEnabled`/`ctaTitle`/`ctaSubtitle` no
 * longer exist on `HeroContent` — they are wire schema and stop at
 * `heroContentFrom`. Asserting "an enabled CTA renders nothing" therefore has
 * to start from the shape that still HAS them, or it asserts nothing at all.
 */
function appearance(overrides: Partial<HeaderAppearance> = {}): HeaderAppearance {
  return {
    background: 'gradient',
    backgroundColor: '',
    colorSource: 'accent',
    gradientStrength: 100,
    backgroundImageUrl: '',
    imageOverlay: 45,
    showLogo: true,
    logoUrl: 'https://cdn.acme.test/logo.png',
    showAvatars: true,
    avatars: ['https://cdn.acme.test/a.png', 'https://cdn.acme.test/b.png'],
    showPresence: true,
    greeting: 'Hello there',
    subGreeting: 'Ask us anything',
    ctaEnabled: true,
    ctaTitle: 'Send us a message',
    ctaSubtitle: 'We usually reply instantly',
    ...overrides,
  };
}

/**
 * jsdom does not implement `IntersectionObserver` at all, so every test that
 * exercises `watchScroll` needs a stand-in. This one records every instance
 * it hands out — `watchScroll`'s own "second call is a no-op" guarantee
 * (see hero-header.ts) is only provable if a test can tell whether a SECOND
 * observer ever got constructed, not just whether the first one still works.
 */
class FakeIntersectionObserver implements IntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [0];
  private readonly callback: IntersectionObserverCallback;
  private readonly observed = new Set<Element>();
  disconnected = false;

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
    this.disconnected = true;
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Fires the callback as the browser would, for the one target this component observes. */
  fire(isIntersecting: boolean): void {
    const [target] = this.observed;
    if (target === undefined) throw new Error('nothing observed yet');
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this,
    );
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

function build() {
  const hero = createHeroHeader();
  document.body.appendChild(hero.node);
  return { hero };
}

/**
 * jsdom computes no layout, so `offsetHeight`/`scrollHeight`/`clientHeight`
 * are always 0 — which the collapse guard reads as "collapsing frees nothing
 * but there is also nothing scrolled", i.e. never collapse. Tests that walk
 * the collapse path must therefore stub the geometry the guard consults,
 * exactly as a real layout would have produced it.
 */
function stubGeometry(el: HTMLElement, dims: { scrollHeight?: number; clientHeight?: number; offsetHeight?: number }): void {
  for (const [key, value] of Object.entries(dims)) {
    Object.defineProperty(el, key, { configurable: true, value });
  }
}

/**
 * A scroll host whose content overflows generously — far past the hero's own
 * height — so the guard allows collapse and the test exercises the state
 * flips themselves.
 */
function tallScrollHost(hero: { node: HTMLElement }): HTMLElement {
  const scrollHost = document.createElement('div');
  document.body.appendChild(scrollHost);
  stubGeometry(scrollHost, { scrollHeight: 900, clientHeight: 300 });
  stubGeometry(hero.node, { offsetHeight: 200 });
  return scrollHost;
}

describe('createHeroHeader — render', () => {
  it('draws the logo, faces and greeting into the content layer', () => {
    const { hero } = build();
    hero.render(content());

    expect(hero.node.querySelector('.dh-hero-full .dh-hero-greeting')?.textContent).toBe('Hello there');
    expect(hero.node.querySelector('.dh-hero-full .dh-hero-sub')?.textContent).toBe('Ask us anything');
    expect(hero.node.querySelectorAll('.dh-hero-full .dh-hero-avatar')).toHaveLength(2);
  });

  // D3: exactly ONE "send us a message" affordance on Home. The hero only
  // ever shows on Home, and `ui/home-screen.ts` builds `.dh-home-cta` there
  // unconditionally, so a hero CTA is always a SECOND button leading to the
  // identical destination — two visually different cards making the same
  // offer, one of them not even reachable by keyboard. Home's card won.
  //
  // `header.ctaEnabled`/`ctaTitle`/`ctaSubtitle` still PARSE (they are the
  // published wire schema — see src/config.ts and src/remote-config.ts); they
  // simply no longer reach a rendered button.
  it('renders no CTA of its own, even when the merchant enabled and titled one', () => {
    const { hero } = build();
    hero.render(heroContentFrom(appearance({ ctaEnabled: true, ctaTitle: 'Send us a message' }), ''));

    expect(hero.node.querySelector('.dh-hero-cta')).toBeNull();
    expect(hero.node.querySelector('.dh-hero-cta-title')).toBeNull();
    expect(hero.node.querySelector('.dh-hero-cta-sub')).toBeNull();
    // Nothing pressable is left in the block at all, which is what makes its
    // `aria-hidden` structurally safe rather than maintained by hand.
    expect(hero.node.querySelector('button')).toBeNull();
    // The greeting still arrives — this is the CTA being dropped, not the
    // whole publish being ignored.
    expect(hero.node.querySelector('.dh-hero-greeting')?.textContent).toBe('Hello there');
  });

  // The interaction between D3 and D2. A merchant whose ONLY enabled hero
  // element was the CTA now has a hero with zero children — which is exactly
  // what `data-empty="true"` means, so the hero hides itself and the band's
  // straddle guard (`:not([data-empty="true"])`, ui/styles.ts) retracts the
  // overhang with it. Nothing is left half-painted.
  it('marks a CTA-only hero empty, now that the CTA is gone', () => {
    const { hero } = build();
    hero.render(
      heroContentFrom(
        appearance({
          showLogo: false,
          showAvatars: false,
          greeting: '',
          subGreeting: '',
          ctaEnabled: true,
          ctaTitle: 'Send us a message',
          ctaSubtitle: 'We usually reply instantly',
        }),
        '',
      ),
    );

    expect(hero.node.querySelector('.dh-hero-full')?.children).toHaveLength(0);
    expect(hero.node.dataset['empty']).toBe('true');
  });

  it('has no compact layer — collapsed means gone, not a 66px bar', () => {
    const { hero } = build();
    hero.render(content());

    // The product owner rejected the compact bar live (an empty dead strip on
    // tenants with nothing to draw in it); the concept was removed outright.
    expect(hero.node.querySelector('.dh-hero-compact')).toBeNull();
  });

  it('applies the allowlist and the cap to the avatar row', () => {
    const { hero } = build();
    hero.render(
      content({
        avatars: [
          'https://cdn.acme.test/a.png',
          'https://cdn.acme.test/b.png',
          'https://cdn.acme.test/c.png',
          'javascript:alert(1)', // refused by safeImageUrl
          'https://cdn.acme.test/d.png', // past MAX_AVATARS
        ],
      }),
    );

    expect(hero.node.querySelectorAll('.dh-hero-full .dh-hero-avatar')).toHaveLength(3);
  });

  it('marks the hero empty when the merchant turned every piece of it off', () => {
    const { hero } = build();
    hero.render(
      content({
        showLogo: false,
        showAvatars: false,
        greeting: '',
        subGreeting: '',
      }),
    );

    expect(hero.node.dataset['empty']).toBe('true');
  });
});

describe('createHeroHeader — watchScroll', () => {
  it('inserts a zero-content marker at the top of the given scroll host and observes it there', () => {
    const { hero } = build();
    const scrollHost = document.createElement('div');
    document.body.appendChild(scrollHost);

    hero.watchScroll(scrollHost);

    const sentinel = scrollHost.querySelector('.dh-hero-sentinel');
    expect(sentinel).not.toBeNull();
    expect(scrollHost.firstElementChild).toBe(sentinel);

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(FakeIntersectionObserver.instances[0]?.root).toBe(scrollHost);
  });

  it('collapses once the sentinel scrolls out of the root, and expands once it scrolls back', () => {
    const { hero } = build();
    hero.render(content());
    const scrollHost = tallScrollHost(hero);
    hero.watchScroll(scrollHost);

    const observer = FakeIntersectionObserver.instances[0]!;

    // At rest, at the top of Home's content.
    observer.fire(true);
    expect(hero.node.dataset['collapsed']).toBe('false');

    // The visitor scrolled the sentinel away.
    observer.fire(false);
    expect(hero.node.dataset['collapsed']).toBe('true');

    // ...and back.
    observer.fire(true);
    expect(hero.node.dataset['collapsed']).toBe('false');
  });

  it('refuses to collapse when handing the hero height back would un-scroll the container', () => {
    const { hero } = build();
    hero.render(content());
    const scrollHost = document.createElement('div');
    document.body.appendChild(scrollHost);
    // Content overflows by 100px while the hero stands 200px tall: collapsing
    // would free 200px, the browser would clamp scrollTop back to 0, the
    // marker would re-enter view, and the two states would re-trigger each
    // other every frame. The guard must keep the hero expanded instead.
    stubGeometry(scrollHost, { scrollHeight: 400, clientHeight: 300 });
    stubGeometry(hero.node, { offsetHeight: 200 });
    hero.watchScroll(scrollHost);

    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire(false);
    expect(hero.node.dataset['collapsed']).toBeUndefined();
  });

  it('collapses once the overflow clears the freed height plus the slack', () => {
    const { hero } = build();
    hero.render(content());
    const scrollHost = document.createElement('div');
    document.body.appendChild(scrollHost);
    // 300px of overflow against a 200px hero: 100px survives the collapse,
    // comfortably past the 32px slack — this one must go.
    stubGeometry(scrollHost, { scrollHeight: 600, clientHeight: 300 });
    stubGeometry(hero.node, { offsetHeight: 200 });
    hero.watchScroll(scrollHost);

    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire(false);
    expect(hero.node.dataset['collapsed']).toBe('true');
  });

  it('does not stack a second observer or a second marker on a repeated call', () => {
    const { hero } = build();
    const scrollHost = document.createElement('div');
    document.body.appendChild(scrollHost);

    hero.watchScroll(scrollHost);
    hero.watchScroll(scrollHost);

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(scrollHost.querySelectorAll('.dh-hero-sentinel')).toHaveLength(1);
  });

  it('destroy disconnects the observer and removes the marker', () => {
    const { hero } = build();
    const scrollHost = document.createElement('div');
    document.body.appendChild(scrollHost);
    hero.watchScroll(scrollHost);
    const observer = FakeIntersectionObserver.instances[0]!;

    hero.destroy();

    expect(observer.disconnected).toBe(true);
    expect(scrollHost.querySelector('.dh-hero-sentinel')).toBeNull();
  });

  it('destroy is safe to call twice', () => {
    const { hero } = build();
    const scrollHost = document.createElement('div');
    document.body.appendChild(scrollHost);
    hero.watchScroll(scrollHost);

    expect(() => {
      hero.destroy();
      hero.destroy();
    }).not.toThrow();
  });
});

describe('collapsed styles — the hero must occupy no space at all', () => {
  // jsdom computes no layout, so it cannot measure the band disappearing the
  // way a real browser would. What it CAN prove is the mechanism itself: the
  // collapsed rule zeroes the height and clips the (still-fading) content,
  // and no trace of the rejected 66px compact bar survives in the stylesheet.
  it('snaps the collapsed hero to zero height and clips its content', () => {
    const collapsedRule = /\.dh-hero\[data-collapsed="true"\]\s*\{([^}]*)\}/.exec(STYLES)?.[1] ?? '';
    expect(collapsedRule).toMatch(/height:\s*0/);
    expect(collapsedRule).toMatch(/overflow:\s*hidden/);
  });

  it('ships no compact-bar CSS', () => {
    expect(STYLES).not.toContain('dh-hero-compact');
  });
});
