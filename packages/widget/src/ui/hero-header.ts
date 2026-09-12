// The tall branded header — the console's `design: 'hero'`.
//
// ── What "hero" means HERE, which is not quite what it means in the console ─
//
// In `chatsupport_react` the hero is a HOME SCREEN: a tall panel with a
// greeting and a "send us a message" card, and picking that card is what opens
// a conversation. It collapses once the visitor scrolls into one.
//
// This widget NOW has that home/conversation split (`ui/screens.ts`,
// `ui/home-screen.ts`), and the hero is mounted as the Home screen's own
// banner — `widget.ts` shows it exactly while `screens.current() === 'home'`
// and `design === 'hero'`. Before that wiring landed, this widget's panel WAS
// the conversation, and the hero stood in for a home screen by keying off
// "the transcript is EMPTY" instead; that is no longer how any of it works,
// but it is worth naming here because the trigger below reads similarly and
// is a different thing:  `.dh-hero[data-empty="true"]` — "this hero has
// nothing to draw" — is unrelated to which SCREEN is showing.
//
// ── The hero has no call to action, and this is decided ───────────────────
//
// It used to build a `.dh-hero-cta` from `header.ctaEnabled`/`ctaTitle`/
// `ctaSubtitle`, calling back into the same "open the new-conversation
// surface" flow that Home's own card and the Messages screen's "New
// conversation" button open. This file used to describe that overlap as an
// open console/design question. It is not open any more: the answer is that
// the hero renders no CTA at all.
//
// What settled it is that the overlap is not conditional. The hero shows only
// while the Home screen is showing — `widget.ts`'s `syncScreens` gates it on
// `onHome && design === 'hero'`, a strict subset of the times Home is up — and
// `ui/home-screen.ts` builds `.dh-home-cta` on Home unconditionally, so an
// enabled hero CTA is never an alternative to Home's card, it is always a
// SECOND card, directly above it, making the identical offer and leading to
// the identical destination. Two of them is one more than the screen is
// asking for, and the hero's was the weaker of the two: it is inside this
// block's `aria-hidden`, so it carried `tabindex="-1"`, and `ui/focus.ts`'s
// `isHidden` walks up to that same `aria-hidden` and kept it out of the focus
// trap as well. No keyboard user and no screen reader could reach it.
//
// It was still PAINTED and still clickable, so a sighted pointer user does
// lose an affordance here — that is the honest cost and it is not nothing.
// What no user loses is a DESTINATION: Home's own card sits one gap below,
// makes the identical offer and opens the identical flow.
//
// And the removal is a REPAIR, not only a tidy-up. A control the widget drew,
// styled as a button and invited a click on, that keyboard and screen-reader
// users could not operate at all, is a defect on its own terms — it had been
// shipping as one. Deleting it closes that, and leaves one affordance on Home
// which every user can actually reach.
//
// The three console fields still parse and still round-trip (`src/config.ts`,
// `src/remote-config.ts` — they are the published wire schema). They simply
// no longer reach a rendered button; see `heroContentFrom` at the bottom of
// this file for what a merchant who set them sees instead.
//
// ── The collapse: expanded or gone, nothing in between ─────────────────────
//
// The first cut of this feature kept an Intercom-style 66px compact bar
// (logo + faces) pinned behind the tall hero. The product owner rejected it
// against a live tenant — on a hero with no logo and no faces the bar is an
// EMPTY 66px strip of dead colour covering content — and re-specced the
// behaviour: scrolled away from the top, the hero must occupy NO space at
// all, so "Recent conversation"/"Common Questions" slide up directly under
// the panel's standard header row; scrolled back to the top, it returns.
// There is no compact layer any more. One state machine: expanded, or gone.
//
// `.dh-hero` is a `flex: none` band ABOVE `ui/home-screen.ts`'s own scroll
// container (`.dh-home`, `overflow-y: auto`) — nothing about the hero itself
// ever scrolls, so "gone" is a straight `height: 0; overflow: hidden` snap on
// `[data-collapsed="true"]` (ui/styles.ts). Snapping the height rather than
// animating it is what actually returns the freed space to `.dh-home` (a
// `flex: none` sibling shrinking is the only way its `flex: 1` neighbour gets
// more room) without a second, competing animation. The content's own 180ms
// opacity fade (`.dh-hero-full` in ui/styles.ts) is the only thing that
// animates, and it matters on the way BACK: the band's height returns in one
// frame and the content fades in over it instead of popping. A snap is not
// motion in the vestibular sense a slide or a transform is, so it gets no
// `prefers-reduced-motion` carve-out — same stance as `.dh-msg-more`.
//
// ── The trigger: a zero-space marker at the top of `.dh-home` ──────────────
//
// `watchScroll(scrollHost)` is how `widget.ts` tells this component where
// "the top of Home's content" actually is — `ui/home-screen.ts` owns
// `.dh-home`'s markup and this file has no reason to reach past that
// boundary, so rather than have `home-screen.ts` grow a bespoke sentinel slot
// for one caller, this inserts its own marker into the element it is handed,
// the same "caller supplies the mount point, callee owns what goes in it"
// shape `widget.ts` already uses for `homeQuestionsSlot`.
//
// The marker (`.dh-hero-sentinel`) is `position: absolute; height: 1px`, not
// a normal flow child — `.dh-home` lays its children out with `gap`, and gap
// applies to every flex item regardless of that item's own margins, so a real
// flow child would permanently widen the space above the CTA card by one
// gap's worth for a pixel nobody is meant to see. Absolute costs nothing.
//
// An `IntersectionObserver` rooted at `scrollHost` watching that marker is
// simpler and cheaper than a `scroll` listener doing the same arithmetic on
// every frame: the browser only calls back on the two edges this component
// actually cares about (crossed into view / crossed out of view), and it
// keeps working correctly through anything that moves `.dh-home`'s scroll
// position without firing a `scroll` event on it directly (programmatic
// `scrollTo`, `scrollIntoView` from elsewhere in the tree).
//
// ── The oscillation trap, which full removal makes WORSE, not better ───────
//
// Collapsing hands the hero's height back to `.dh-home`, which can un-scroll
// the very scroll that caused the collapse: the container grows, the browser
// clamps `scrollTop` back toward 0, the marker re-enters view, the hero
// re-expands, the overflow comes back, and it repeats. A real-Chrome run of
// the 66px version surfaced exactly this loop on a near-empty Home, and the
// fix was a positive `rootMargin` (below). Removing the hero ENTIRELY frees
// its full height rather than height-minus-66px, so the band of content
// heights that can bounce is wider now — the static 32px margin alone no
// longer covers it, and `watchScroll` adds a layout check at collapse time:
// it refuses to collapse unless the container will STILL be scrolled past
// the margin after the hero's height is handed back. See the guard inline.

import type { HeaderAppearance } from '../config.js';

import { DEFAULT_AVATAR_IMAGE, DEFAULT_LOGO_IMAGE, el, safeImageUrl } from './dom.js';

/**
 * A logo/avatar `<img>` that swaps to `fallback` instead of sitting as a
 * broken-image glyph when the browser cannot actually load `src` — see
 * DEFAULT_AVATAR_IMAGE/DEFAULT_LOGO_IMAGE's own docs in dom.ts for why this
 * can happen even though `src` already passed `safeImageUrl`. Callers pass
 * the agent silhouette for a person's photo and the Dhaam AI wordmark for a
 * brand logo — the two 404 cases read very differently.
 */
function imgWithFallback(
  attrs: Record<string, string | number | boolean | null | undefined>,
  fallback: string = DEFAULT_AVATAR_IMAGE,
): HTMLImageElement {
  const img = el('img', { attrs });
  img.addEventListener('error', () => { img.src = fallback; }, { once: true });
  return img;
}

export interface HeroContent {
  readonly showLogo: boolean;
  readonly logoUrl: string;
  readonly showAvatars: boolean;
  readonly showPresence: boolean;
  readonly avatars: readonly string[];
  readonly greeting: string;
  readonly subGreeting: string;
}

export interface HeroHeaderView {
  readonly node: HTMLElement;
  /** Avatars displayed inside the top header row when the hero is collapsed on scroll. */
  readonly headerAvatars: HTMLElement;
  /** Rebuilds the hero from a new appearance. Cheap; runs at most once per publish. */
  render(content: HeroContent): void;
  /**
   * Starts removing this hero (height 0, nothing left behind) once
   * `scrollHost` — Home's own scroll container (`ui/home-screen.ts`'s
   * `.dh-home`) — has been scrolled away from the top, and restoring it once
   * the visitor returns there. See the module header for why this, and not a
   * `scroll` listener, is what drives it.
   *
   * Meant to be called once, after the Home screen exists. A second call is
   * a no-op rather than a second observer — nothing in `widget.ts` recreates
   * the Home screen mid-lifetime, so stacking observers would only ever be a
   * bug, never a legitimate re-target.
   */
  watchScroll(scrollHost: HTMLElement): void;
  /** Disconnects the scroll watch and removes its marker. Safe to call twice. */
  destroy(): void;
}

/**
 * How many faces the row shows.
 *
 * Three, the console's own cap, enforced again here rather than trusted: the
 * field is a plain array on an opaque blob, and a fourth avatar would overflow
 * the row rather than being ignored the way an older console version's
 * validation would have.
 */
const MAX_AVATARS = 3;

/**
 * How far past the sentinel the visitor must scroll before the hero goes —
 * the `rootMargin` on the observer below, and the slack the collapse guard
 * requires to SURVIVE the collapse. One number, used twice, because the two
 * checks describe the same edge: "is the marker meaningfully out of view".
 */
const COLLAPSE_SLACK_PX = 32;

/**
 * The face row.
 *
 * Takes already-filtered, already-capped URLs rather than the raw
 * `HeroContent.avatars` — `render()` below does that filtering exactly once
 * per publish, so which faces survived the allowlist (`safeImageUrl`) and the
 * cap (`MAX_AVATARS`) is decided in one place.
 */
function buildAvatarRow(faces: readonly string[], showPresence: boolean): HTMLElement | null {
  if (faces.length === 0) return null;
  return el('div', {
    attrs: { class: 'dh-hero-avatars' },
    children: faces.map((src, index) =>
      el('span', {
        attrs: { class: 'dh-hero-avatar' },
        children: [
          imgWithFallback({ src, alt: '' }),
          // The presence dot rides the LAST face only — it says "someone
          // is here", not "this particular person is", so one is the
          // honest number regardless of how many faces are shown.
          ...(showPresence && index === faces.length - 1
            ? [el('span', { attrs: { class: 'dh-hero-presence' } })]
            : []),
        ],
      }),
    ),
  });
}

// Takes no callbacks. It had exactly one — the CTA's — and the CTA is gone
// (see the module header); everything left in this block is decoration that
// nothing can press.
export function createHeroHeader(): HeroHeaderView {
  const full = el('div', { attrs: { class: 'dh-hero-full' } });
  const headerAvatars = el('div', { attrs: { class: 'dh-header-hero-avatars', 'aria-hidden': 'true' } });

  // `aria-hidden` on the whole block, and this is deliberate rather than
  // careless. Every string in it is decoration that the panel already conveys:
  // the greeting repeats what the composer's placeholder asks for, and the
  // logo and faces are branding. Announcing all of it before the conversation
  // would put several lines of marketing in front of a screen reader user
  // every time they open the chat. Nothing in here is interactive any more
  // either — the CTA was the only control this block ever had, and the reason
  // it needed an explicit `tabindex="-1"` (a focusable control inside an
  // aria-hidden subtree is the one combination that genuinely breaks
  // assistive tech). With it gone, the promise this attribute makes is
  // structurally true rather than maintained by hand.
  const node = el('div', {
    attrs: { class: 'dh-hero', hidden: true, 'aria-hidden': 'true' },
    children: [full],
  });

  function render(content: HeroContent): void {
    const logo = content.showLogo ? safeImageUrl(content.logoUrl) : null;
    const faces = content.showAvatars
      ? content.avatars
          .map((url) => safeImageUrl(url))
          .filter((url): url is string => url !== null)
          .slice(0, MAX_AVATARS)
      : [];

    const fullChildren: Node[] = [];

    if (logo !== null) {
      fullChildren.push(imgWithFallback({ class: 'dh-hero-logo', src: logo, alt: '' }, DEFAULT_LOGO_IMAGE));
    }

    const avatars = buildAvatarRow(faces, content.showPresence);
    if (avatars !== null) fullChildren.push(avatars);

    // Also populate the compact header avatars row for collapsed state
    const headerAvatarRow = buildAvatarRow(faces, content.showPresence);
    headerAvatars.replaceChildren(...(headerAvatarRow !== null ? [headerAvatarRow] : []));

    if (content.greeting !== '') {
      fullChildren.push(el('p', { attrs: { class: 'dh-hero-greeting' }, text: content.greeting }));
    }
    if (content.subGreeting !== '') {
      fullChildren.push(el('p', { attrs: { class: 'dh-hero-sub' }, text: content.subGreeting }));
    }

    // No CTA. `header.ctaEnabled`/`ctaTitle`/`ctaSubtitle` are not read here
    // at all — see the module header for why Home's card is the one that
    // survived, and `heroContentFrom` for what those fields still do.

    full.replaceChildren(...fullChildren);

    // An empty hero is not a short hero — a merchant who turned off every
    // piece of it has turned the block off, and a bare coloured slab above the
    // transcript would read as a rendering failure rather than as their
    // choice. The caller's own visibility rule still applies on top of this.
    node.dataset['empty'] = fullChildren.length === 0 ? 'true' : 'false';
  }

  let observer: IntersectionObserver | null = null;
  let sentinel: HTMLElement | null = null;

  function watchScroll(scrollHost: HTMLElement): void {
    if (observer !== null) return;
    // No polyfill, no crash — the same "feature-detect a browser global"
    // shape `ui/chime.ts` uses for `AudioContext`. Every browser this widget
    // otherwise supports has had `IntersectionObserver` for years, so this is
    // not really about legacy support; it is about every environment that
    // constructs a widget WITHOUT being a real browser tab — a test harness,
    // a server-side render pass a host wraps this in — none of which has any
    // scrolling for this feature to watch anyway. Collapsing never happening
    // there is correct, not degraded: the merchant's hero still renders,
    // expanded, exactly as it did before this feature existed.
    if (typeof IntersectionObserver === 'undefined') return;

    sentinel = el('div', { attrs: { class: 'dh-hero-sentinel', 'aria-hidden': 'true' } });
    scrollHost.prepend(sentinel);

    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        // Intersecting the scroll host's own viewport = at (or near) the
        // top = expanded. Anything else = the visitor has scrolled away.
        if (entry.isIntersecting) {
          node.dataset['collapsed'] = 'false';
          return;
        }
        // ── The collapse guard — see the module header's oscillation note ──
        //
        // Removing the hero hands its FULL height back to `.dh-home`. If the
        // content's current overflow is not comfortably larger than that, the
        // browser clamps `scrollTop` back into the marker's expand zone the
        // instant the space arrives, and the two states re-trigger each other
        // every frame. So: collapse only when, AFTER the hero's height is
        // returned, the container will still be scrolled at least the same
        // slack past the marker that `rootMargin` demanded to get here.
        // Refusing to collapse on a too-short Home is the correct behaviour,
        // not a degraded one — there is nowhere for the freed space to go.
        //
        // `offsetHeight` is read here, at the moment of the decision, rather
        // than cached at render: config publishes and image loads change the
        // hero's height, and a stale number re-opens the loop this closes.
        const freed = node.offsetHeight;
        const overflow = scrollHost.scrollHeight - scrollHost.clientHeight;
        if (overflow - freed <= COLLAPSE_SLACK_PX) return;
        node.dataset['collapsed'] = 'true';
      },
      // `root`, not the default (the browser viewport) — `.dh-home` scrolls
      // internally inside a fixed-size panel; the panel itself never moves
      // relative to the page, so watching the page's viewport would never
      // fire at all. `threshold: 0` (the default, spelled out because a
      // future edit reaching for "a little debounce" should have to change
      // an explicit value rather than discover an implicit one): the marker
      // is 1px tall, so "any of it visible" and "all of it visible" are the
      // same question anyway.
      //
      // `rootMargin`'s top value is NOT decorative — a real-Chrome run of
      // the 66px-bar version of this code surfaced the feedback loop the
      // module header describes on a Home that only overflowed by a few
      // pixels. A POSITIVE top margin grows the effective root upward, so
      // the marker still counts as "in view" (expanded) until the visitor
      // has scrolled more than 32px past it — not the instant it crosses 0 —
      // which makes the collapse unreachable when the whole overflow is
      // smaller than the slack. The layout guard in the callback above
      // handles the wider band of heights that full removal exposes; this
      // margin still earns its place by never waking the callback at all
      // for sub-slack scrolls.
      {
        root: scrollHost,
        threshold: 0,
        rootMargin: `${COLLAPSE_SLACK_PX}px 0px 0px 0px`,
      },
    );
    observer.observe(sentinel);
  }

  function destroy(): void {
    observer?.disconnect();
    observer = null;
    sentinel?.remove();
    sentinel = null;
  }

  return { node, headerAvatars, render, watchScroll, destroy };
}

/**
 * The hero's content, assembled from the two places the console keeps it.
 *
 * `header.logoUrl` is the hero's own logo; `appearance.logoUrl` is the brand
 * mark the console writes when `avatarMode` is `'logo'`. A merchant who
 * uploaded one and not the other means the same thing by either, so the
 * header's own wins and the top-level one stands behind it — which is the
 * difference between `showLogo: true` rendering something and rendering
 * nothing at all.
 *
 * ── Where `ctaEnabled` / `ctaTitle` / `ctaSubtitle` stop ──────────────────
 *
 * Here. They are on `HeaderAppearance` and they stay there — `src/config.ts`
 * and `src/remote-config.ts` are the published wire schema, a console that
 * writes them must keep round-tripping, and dropping a field a merchant has
 * saved is a different and much larger decision than not drawing a button.
 * They are simply never copied onto `HeroContent`, so nothing downstream can
 * read them.
 *
 * What a merchant who set them sees: the hero draws their logo, faces,
 * greeting and sub-line, and no button — and Home's own card, one gap below
 * where theirs would have been, carries the "send us a message" offer with
 * ITS OWN copy (`ui/home-screen.ts`'s `ctaCopy`), not the `ctaTitle` they
 * typed. So a merchant who wrote a custom hero CTA title loses that wording;
 * the affordance itself is not lost, and their title never appears twice.
 */
export function heroContentFrom(
  header: HeaderAppearance,
  fallbackLogoUrl: string,
): HeroContent {
  return {
    showLogo: header.showLogo,
    logoUrl: header.logoUrl.trim() === '' ? fallbackLogoUrl : header.logoUrl,
    showAvatars: header.showAvatars,
    showPresence: header.showPresence,
    avatars: header.avatars,
    greeting: header.greeting,
    subGreeting: header.subGreeting,
  };
}
