// Every style this widget has, as one string injected into the shadow root.
//
// ── Font inheritance, which is the opposite of the usual claim ───────────
//
// It is widely repeated that a shadow root "does not inherit fonts". That is
// not what the cascade does. INHERITED properties — `font-family`, `font-size`,
// `line-height`, `color`, `letter-spacing`, `direction` — cross the shadow
// boundary perfectly well, because the shadow tree's root inherits from its
// HOST element, and the host element is an ordinary node in the light DOM
// inheriting from the page. What does NOT cross is anything that requires a
// SELECTOR to match: `body { font-family: X }` reaches us (through
// inheritance), while `.chat p { font-family: X }` never does.
//
// So the real hazard is the reverse of the folklore: left alone we silently
// adopt the host's typography, including a 20px base size from a marketing
// site, a display face with no lowercase, or a webfont that has not loaded and
// renders as invisible text. `:host` therefore sets the inherited properties
// explicitly — that is what actually isolates them.
//
// `font: inherit` is offered as `WidgetConfig.font: 'inherit'` for hosts that
// want brand continuity, which is a legitimate thing to want and is why this
// is a setting rather than a hardcode. `all: initial` on `:host` was rejected:
// it would also reset the custom properties the theme is built from, and it
// resets `direction`, which would break every RTL host.
//
// ── Stacking ────────────────────────────────────────────────────────────
//
// The shadow root solves style leakage in both directions. It does NOT solve
// stacking: a shadow host is an ordinary element in the host's z-order, so v1's
// `z-index: 999999` still loses to any host that bids higher. See ui/root.ts —
// the container is promoted to the TOP LAYER via the popover API where that
// exists, which no z-index can outrank, and falls back to the real maximum
// (2147483647) rather than v1's arbitrary six digits.

import { safeImageUrl } from './dom.js';

import type {
  HeaderAppearance,
  LauncherShadow,
  ResolvedConfig,
  ThreadAppearance,
} from '../config.js';

const SYSTEM_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * The console's font NAMES → real CSS stacks.
 *
 * Deliberately not the console's own table. `chatsupport_react` maps these to
 * `var(--font-inter)` and friends — Next.js font-loader variables that exist
 * only on a page Next rendered. This bundle runs on any merchant's storefront,
 * where those variables resolve to nothing and the declaration is dropped, so
 * the named family goes in literally with a system fallback behind it.
 *
 * The consequence, stated because it is a real limitation rather than an
 * oversight: nothing here LOADS a webfont. A merchant who picks Inter gets
 * Inter if their page already serves it and the system stack if not, because
 * injecting a `@font-face` from a third-party script would add a render-
 * blocking download to someone else's page without asking.
 */
const FONT_STACKS: Readonly<Record<string, string>> = {
  'System default': SYSTEM_FONT_STACK,
  Inter: `Inter, ${SYSTEM_FONT_STACK}`,
  'DM Sans': `'DM Sans', ${SYSTEM_FONT_STACK}`,
  Roboto: `Roboto, ${SYSTEM_FONT_STACK}`,
  Georgia: 'Georgia, "Times New Roman", serif',
};

/**
 * A console font name → the stack that renders it. An unknown name — a face a
 * newer console offers and this bundle has never heard of — falls back to the
 * system stack rather than to an invalid declaration.
 *
 * Exported because the live-config path in widget.ts needs the same mapping:
 * a published `fontFamily` arriving after mount is applied as an inline
 * `--dh-font`, and computing the stack a second time there is how the two
 * would drift.
 */
export function fontStackFor(name: string): string {
  return FONT_STACKS[name] ?? SYSTEM_FONT_STACK;
}

/**
 * Tokens only. Kept separate from {@link STYLES} because these are the only
 * declarations that depend on runtime config, so the ~9KB of static CSS below
 * stays a module-scope constant that the engine parses once.
 */
export function themeCss(config: ResolvedConfig): string {
  // CUSTOM PROPERTIES ONLY. Not `font-family` itself — see the header: a host
  // rule that matches the shadow HOST element beats a `:host` rule, and an
  // `!important` one beats it unconditionally. A custom property is immune,
  // because no host page sets `--dh-font` by accident.
  //
  // `inherit` is expressible in the same mechanism: the value flows into
  // `font-family: var(--dh-font)` on the subtree roots below, and
  // `font-family: inherit` there means "adopt the host element's font", which
  // is exactly what a host asking for brand continuity wants.
  //
  // It also OUTRANKS `fontFamily`, and that ordering is the whole point of the
  // two settings being separate — see config.ts's `fontFamily` doc.
  const font = config.font === 'inherit' ? 'inherit' : fontStackFor(config.fontFamily);

  return `:host{
    --dh-font: ${font};
    --dh-accent: ${cssColor(config.accent)};
    --dh-radius: ${cssPx(config.cornerRadius, 12)};
    --dh-offset-x: ${cssPx(config.offsetX, 20)};
    --dh-offset-y: ${cssPx(config.offsetY, 20)};
    --dh-launcher-shadow: ${launcherShadowCss(config.launcherShadow, 'resting')};
    --dh-launcher-shadow-lift: ${launcherShadowCss(config.launcherShadow, 'lifted')};
    --dh-header-bg: ${headerBaseColor(config.header)};
    --dh-header-fg: ${headerForeground(config.header, config.accent)};
    --dh-header-layers: ${headerLayers(config.header)};
    ${threadTokensCss(config.thread)}
  }`;
}

/**
 * A config-supplied length, as a CSS pixel value.
 *
 * The same containment job {@link cssColor} does, for the other kind of value
 * that reaches a stylesheet. `NaN` and `Infinity` both survive `String()` and
 * both produce a declaration the engine drops — which takes the WHOLE `:host`
 * rule's remaining declarations with it in some engines, so one bad number
 * from a hand-written `mount()` call could cost the accent and the font too.
 * Negative lengths are refused for the same reason `border-radius: -4px` is:
 * there is no reading of one that renders.
 *
 * Clamped rather than thrown on, unlike `sheetBreakpointPx`: this value also
 * arrives from published config, and a merchant dragging a slider must never
 * be able to stop a widget booting on someone else's checkout page.
 */
export function cssPx(value: number, fallback: number): string {
  return `${Number.isFinite(value) && value >= 0 ? value : fallback}px`;
}

/**
 * The header's flat base colour.
 *
 * An empty `backgroundColor` means "follow `colorSource`", and both of its
 * values resolve to the accent here: `platform` is decided at runtime against
 * the host document (see `ui/platform-color.ts`) and lands as an inline
 * override, so the accent is what it falls back to when nothing usable was
 * found. There is no input for which the header ends up with no colour.
 *
 * `var(--dh-accent)` rather than the accent's literal value, so a published
 * accent arriving after mount repaints the header along with everything else
 * instead of stranding it on the boot-time colour.
 */
export function headerBaseColor(header: HeaderAppearance): string {
  const explicit = header.backgroundColor.trim();
  return explicit === '' ? 'var(--dh-accent)' : cssColor(explicit);
}

/**
 * The header's text colour, measured against whatever it is painted on.
 *
 * Takes `accent` explicitly because {@link headerBaseColor} may have deferred
 * to `var(--dh-accent)`, and a CSS variable is not a colour anything can
 * measure — the caller knows the value the variable currently holds, and this
 * function cannot.
 */
export function headerForeground(header: HeaderAppearance, accent: string): string {
  const explicit = header.backgroundColor.trim();
  return readableOn(explicit === '' ? accent : explicit);
}

/**
 * The gradient/image layers painted over {@link headerBaseColor}.
 *
 * Coefficients lifted verbatim from `chatsupport_react`'s `WidgetHeader`, for
 * the same reason as the launcher shadow: `gradientStrength` and
 * `imageOverlay` are numbers a merchant set while watching that preview.
 *
 * `none` for `solid`, and `none` for an `image` whose URL the allowlist
 * refused — an unpainted header over the base colour is the graceful version
 * of a missing image, where a `url()` that 404s would flash the browser's
 * broken-image behaviour on someone else's page.
 */
export function headerLayers(header: HeaderAppearance): string {
  if (header.background === 'gradient') {
    const a = percent(header.gradientStrength, 100);
    return `linear-gradient(180deg, rgba(0,0,0,${a}) 0%, rgba(0,0,0,${(a * 0.3).toFixed(3)}) 50%, rgba(0,0,0,0) 100%)`;
  }

  if (header.background === 'image') {
    const url = cssUrl(header.backgroundImageUrl);
    if (url === null) return 'none';
    const o = percent(header.imageOverlay, 45);
    return `linear-gradient(180deg, rgba(0,0,0,${o}) 0%, rgba(0,0,0,${o}) 100%), ${url}`;
  }

  return 'none';
}

/** A console 0–100 slider as a 0–1 alpha, clamped and NaN-proofed. */
function percent(value: number, fallback: number): number {
  const raw = Number.isFinite(value) ? value : fallback;
  return Math.min(100, Math.max(0, raw)) / 100;
}

/**
 * A config-supplied image URL as a CSS `url()`, or `null` if it is not one.
 *
 * Two gates, and both are needed. {@link safeImageUrl} decides whether we are
 * willing to LOAD it at all; this then decides whether it can be written into
 * a stylesheet, which `safeImageUrl` says nothing about — `https://x/");
 * background: red; --a: ("` passes the scheme check and would still break out
 * of the declaration and rewrite the rest of the rule. Anything with a quote,
 * paren, backslash, semicolon or whitespace is refused outright rather than
 * escaped, because no URL that reaches a `<img src>` cleanly needs one here.
 */
export function cssUrl(value: string): string | null {
  const url = safeImageUrl(value);
  if (url === null) return null;
  return /["'()\\;\s]/.test(url) ? null : `url("${url}")`;
}

/**
 * Relative luminance per WCAG 2.x, for a hex colour. `null` for anything else.
 *
 * Hex only, deliberately. `accent` is any CSS colour — `rebeccapurple`,
 * `color-mix(...)`, `rgb(...)` — and resolving those needs the engine rather
 * than arithmetic. The caller treats `null` as "assume dark", which is what
 * this widget has always assumed.
 */
export function luminance(color: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (match === null) return null;
  const hex = match[1] as string;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const channel = (index: number): number => {
    const srgb = parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * A foreground that stays readable on `color` — white unless it is light.
 *
 * The hero header paints its own text directly onto a merchant-chosen colour,
 * so this is the difference between legible and invisible: a pastel brand
 * with hardcoded white text is a header nobody can read, and nothing in the
 * console warns them.
 *
 * Falls back to white for a colour it cannot measure, which is what the widget
 * has always used and is right for the dark accents that are the common case.
 */
export function readableOn(color: string): string {
  const light = luminance(color);
  return light !== null && light > 0.55 ? '#1a1a1a' : '#ffffff';
}

/**
 * The three declarations that paint the conversation's backdrop, as an object
 * so the boot path can write them into a rule and the live-config path can set
 * them as inline properties from the same source.
 *
 * Split across three properties rather than one `background` shorthand because
 * `mesh` has to defer to a THEME token pair (light and dark meshes are
 * different artwork, and only CSS knows which is in force), while `pattern`
 * needs an explicit tile size and `image` needs `cover`. A shorthand cannot
 * express "take these two from a variable and that one from here".
 */
export interface ThreadTokens {
  readonly bg: string;
  readonly layers: string;
  readonly size: string;
  readonly repeat: string;
}

/**
 * `thread` → the backdrop tokens.
 *
 * Every formula is lifted from `chatsupport_react`'s `threadBackgroundStyle`,
 * for the third time and the same reason: `patternOpacity` and `imageOverlay`
 * are numbers a merchant set against that renderer's preview.
 *
 * The one structural difference is `mesh`. There it is a CSS class with a
 * `[data-theme="dark"]` variant, because a pastel wash that works on white is
 * mud on near-black. Here it resolves to `var(--dh-mesh-*)`, which the palette
 * defines twice — so the mesh follows the scheme through exactly the mechanism
 * every other colour in this sheet does, rather than through a second
 * theme-detection path that could disagree with the first.
 */
export function threadTokens(thread: ThreadAppearance): ThreadTokens {
  const base = thread.color.trim() === '' ? 'var(--dh-surface)' : cssColor(thread.color);

  if (thread.background === 'solid') {
    return { bg: base, layers: 'none', size: 'auto', repeat: 'repeat' };
  }

  if (thread.background === 'image') {
    const url = cssUrl(thread.imageUrl);
    // Same graceful miss as the header's: the base colour alone, rather than a
    // `url()` that 404s into the browser's broken-image behaviour.
    if (url === null) return { bg: base, layers: 'none', size: 'auto', repeat: 'repeat' };
    const scrim = percent(thread.imageOverlay, 55);
    const veil = thread.imageFade === 'dark' ? '0,0,0' : '255,255,255';
    return {
      bg: base,
      layers: `linear-gradient(rgba(${veil},${scrim}), rgba(${veil},${scrim})), ${url}`,
      size: 'cover',
      // Pinned to the scroll container rather than tiled: the artwork is the
      // panel's backdrop and must stay put while messages move over it.
      repeat: 'no-repeat',
    };
  }

  if (thread.background === 'pattern') {
    // 0.18 is the ceiling, not the value. The slider is "how strongly does
    // this read", and a texture behind a conversation that reaches full
    // opacity competes with the messages rather than sitting behind them.
    const alpha = percent(thread.patternOpacity, 35) * 0.18;
    const ink = 'color-mix(in srgb, var(--dh-accent) 55%, #000)';
    const dot = `color-mix(in srgb, ${ink} ${Math.round(alpha * 100)}%, transparent)`;
    return { bg: base, ...PATTERNS[thread.pattern](dot), repeat: 'repeat' };
  }

  return { bg: 'var(--dh-mesh-bg)', layers: 'var(--dh-mesh-layers)', size: 'auto', repeat: 'no-repeat' };
}

/** Each texture, as the `background-image` and tile size that draw it. */
const PATTERNS: Readonly<
  Record<ThreadAppearance['pattern'], (dot: string) => { layers: string; size: string }>
> = {
  dots: (dot) => ({
    layers: `radial-gradient(${dot} 1.5px, transparent 1.5px)`,
    size: '16px 16px',
  }),
  grid: (dot) => ({
    layers: `linear-gradient(${dot} 1px, transparent 1px), linear-gradient(90deg, ${dot} 1px, transparent 1px)`,
    size: '22px 22px',
  }),
  diagonal: (dot) => ({
    layers: `repeating-linear-gradient(45deg, ${dot} 0 2px, transparent 2px 10px)`,
    size: 'auto',
  }),
  crosshatch: (dot) => ({
    layers: `repeating-linear-gradient(45deg, ${dot} 0 1px, transparent 1px 9px), repeating-linear-gradient(-45deg, ${dot} 0 1px, transparent 1px 9px)`,
    size: 'auto',
  }),
};

/** {@link threadTokens} as the custom-property declarations themeCss emits. */
function threadTokensCss(thread: ThreadAppearance): string {
  const { bg, layers, size, repeat } = threadTokens(thread);
  return `--dh-thread-bg: ${bg};
    --dh-thread-layers: ${layers};
    --dh-thread-size: ${size};
    --dh-thread-repeat: ${repeat};`;
}

/**
 * `launcherShadow` → a `box-shadow` value.
 *
 * The coefficients are lifted verbatim from `chatsupport_react`'s
 * `ChatLauncher` rather than re-derived, and that is the point: `intensity` is
 * a number a merchant set while watching the console's live preview, so the
 * only definition of what 45 LOOKS like is the one that preview used. A
 * plausible-looking second curve here would render their slider differently
 * from the thing they set it against.
 *
 * Two states, because the launcher lifts on hover and a shadow that does not
 * grow with it reads as the button sliding out from under its own shadow.
 *
 * @param state `resting` for the ambient shadow, `lifted` for `:hover`.
 */
export function launcherShadowCss(shadow: LauncherShadow, state: 'resting' | 'lifted'): string {
  if (!shadow.enabled) return 'none';
  // Clamped, not trusted: this is a 0–100 slider in the console, but it
  // reaches here through a public endpoint and a host-supplied object, and a
  // NaN would take the whole `:host` rule's remaining declarations with it.
  const raw = Number.isFinite(shadow.intensity) ? shadow.intensity : 45;
  const strength = Math.min(100, Math.max(0, raw)) / 100;
  const [offset, blur, alpha] =
    state === 'lifted'
      ? [10 + strength * 18, 20 + strength * 36, 0.16 + strength * 0.36]
      : [6 + strength * 14, 14 + strength * 30, 0.12 + strength * 0.33];
  const spread = 6 + strength * 6;
  return `0 ${offset.toFixed(0)}px ${blur.toFixed(0)}px -${spread.toFixed(0)}px rgba(0,0,0,${alpha.toFixed(2)})`;
}

/**
 * Neutralises a config-supplied colour before it reaches a stylesheet.
 *
 * `accent` is host config rather than end-user input, so this is not the XSS
 * boundary — but a stray `;` would still let a typo silently rewrite unrelated
 * declarations, and a `}` would end the rule block and leave the rest of the
 * sheet as garbage. Anything with a brace, semicolon, or comment marker is
 * refused in favour of the default rather than escaped, because there is no
 * legitimate CSS colour containing one.
 */
export function cssColor(value: string): string {
  return /[;{}()<>\\]|\/\*/.test(value) ? '#1f2937' : value.trim();
}

/**
 * The dark half of the palette, interpolated into {@link STYLES} twice.
 *
 * Twice because there are two independent ways to be in dark mode and they
 * cannot be expressed as one selector: the host page's OS preference (a media
 * query) and an explicit `theme: 'dark'` (an attribute). Declaring the tokens
 * once here is what stops the two copies drifting — the bug this shape exists
 * to prevent is a token added to the media query and forgotten in the
 * attribute rule, which renders a half-dark widget only for the merchants who
 * pinned the scheme.
 *
 * Still module scope, so {@link STYLES} is still a constant the engine parses
 * once — the interpolation happens at module evaluation, not per mount.
 */
const DARK_TOKENS = `
  --dh-surface: #191c21;
  --dh-surface-sunken: #131519;
  --dh-text: #f2f4f7;
  --dh-text-muted: #9aa3b0;
  --dh-border: #2c3039;
  --dh-bubble-in: #252a32;
  --dh-focus: #7aa5ff;
  --dh-danger: #f97066;
  --dh-shadow: 0 6px 24px -4px rgb(0 0 0 / 0.55), 0 2px 6px -2px rgb(0 0 0 / 0.4);
  /* The offline banner's band. See '.dh-offline-banner' for why these are a
     fixed pair rather than derived from the merchant's accent. */
  --dh-warn-bg: #3a2c12;
  --dh-warn-fg: #fbdca6;
  --dh-warn-border: #55411b;
  --dh-alarm-bg: #3d201a;
  --dh-alarm-fg: #f9c8bd;
  --dh-alarm-border: #5a2f26;
  /* A pastel wash that works on white is mud on near-black, so the mesh gets
     its own dark artwork rather than an opacity applied to the light one. */
  --dh-mesh-bg: #1c1a24;
  --dh-mesh-layers:
    radial-gradient(88% 68% at 0% 0%, rgb(237 100 140 / 0.14) 0%, rgb(237 100 140 / 0) 72%),
    radial-gradient(88% 68% at 100% 0%, rgb(240 190 90 / 0.12) 0%, rgb(240 190 90 / 0) 72%),
    radial-gradient(88% 70% at 0% 100%, rgb(60 200 165 / 0.12) 0%, rgb(60 200 165 / 0) 72%),
    radial-gradient(95% 76% at 100% 100%, rgb(90 170 210 / 0.14) 0%, rgb(90 170 210 / 0) 74%);
`;

export const STYLES = `
*, *::before, *::after { box-sizing: border-box; }

/* ONE rule, so the hidden attribute cannot be defeated again.
 *
 * The UA's own [hidden] { display: none } has specificity (0,1,0), and so does
 * any class rule — so a later '.dh-consent { display: flex }' in this sheet
 * silently WINS, and an element built with hidden:true renders anyway. This
 * sheet used to answer that one class at a time ('.dh-system[hidden]',
 * '.dh-reconnect[hidden]', and six more), which works only for as long as whoever
 * adds the next flex container remembers to add a ninth — and the surfaces
 * added in this pass all forgot, which put an open action menu on every
 * message at once and a permanent "Replying to" chip above the composer.
 *
 * '!important' deliberately: the whole point is that no later declaration in
 * this file can beat it. It is scoped to the shadow root, so it cannot reach
 * the host page. The per-class rules below are now redundant and harmless;
 * they are left where they are rather than swept up in this change. */
[hidden] { display: none !important; }

:host {
  /* Neutral by default. The AI-purple gradient is not a brand, and this ships
     onto someone else's page where it would clash with an actual one. */
  --dh-surface: #ffffff;
  --dh-surface-sunken: #f6f7f9;
  --dh-text: #16181d;
  --dh-text-muted: #5f6672;
  --dh-border: #e3e6ea;
  --dh-accent-text: #ffffff;
  --dh-danger: #b42318;
  --dh-focus: #2563eb;
  --dh-bubble-in: #f1f3f5;
  --dh-shadow: 0 6px 24px -4px rgb(16 18 24 / 0.18), 0 2px 6px -2px rgb(16 18 24 / 0.12);

  /* The offline banner's band — amber for "your network", a warmer red for
     "our service". Both checked against their own background rather than
     against '--dh-surface': the band paints its own. */
  --dh-warn-bg: #fef4e6;
  --dh-warn-fg: #7a4a02;
  --dh-warn-border: #f3ddb8;
  --dh-alarm-bg: #fdece9;
  --dh-alarm-fg: #8a2c1c;
  --dh-alarm-border: #f6cfc7;

  /* The console's 'thread.background: mesh' — a four-corner pastel wash.
     CSS has no mesh gradient, so this is one radial per corner over a lilac
     base. It lives in the PALETTE rather than in themeCss because it is the
     one backdrop with a dark variant, and the palette is already the thing
     that knows which scheme is in force. */
  --dh-mesh-bg: #dcdcea;
  --dh-mesh-layers:
    radial-gradient(88% 68% at 0% 0%, #ffdcdc 0%, rgb(255 220 220 / 0) 72%),
    radial-gradient(88% 68% at 100% 0%, #fff4da 0%, rgb(255 244 218 / 0) 72%),
    radial-gradient(88% 70% at 0% 100%, #c4f5e8 0%, rgb(196 245 232 / 0) 72%),
    radial-gradient(95% 76% at 100% 100%, #c6e3ed 0%, rgb(198 227 237 / 0) 74%);

  /* '--dh-radius' is NOT declared here. It is config-driven and belongs to
     themeCss(), which is appended after this sheet — declaring a second copy
     here would be dead the moment it disagreed, and the disagreement is the
     kind nobody notices until a merchant's corners are the wrong shape. */
  --dh-space: 4px;

  all: revert;
  display: block;
}

/* The typographic reset, applied to the two SHADOW-TREE roots rather than to
   ':host'.

   This placement is the whole point and it was arrived at empirically: with the
   reset on ':host', a host page carrying '* { font-family: X !important }'
   rendered the entire widget in its own display face. ':host' rules lose to any
   outer-document rule that matches the host element, and '*' matches it — the
   host element is an ordinary light-DOM node. Everything NOT inherited
   (background, border, radius, text-transform) was correctly blocked by the
   shadow boundary the whole time; only inherited properties ever got through,
   and they got through by inheritance rather than by selector.

   No host selector can reach '.dh-launcher' or '.dh-panel', so declarations
   here are final. */
.dh-launcher, .dh-panel {
  font-family: var(--dh-font);
  font-size: 15px;
  font-weight: 400;
  font-style: normal;
  font-variant: normal;
  line-height: 1.45;
  letter-spacing: normal;
  word-spacing: normal;
  text-transform: none;
  text-indent: 0;
  text-align: start;
  text-shadow: none;
  white-space: normal;
  color: var(--dh-text);
}

/* ── Colour scheme ────────────────────────────────────────────────────────

   'theme: auto' (the default) follows the host page's scheme rather than
   imposing one — a dark-mode food ordering app should not get a white slab
   bolted to its corner. 'light'/'dark' pin one, for a merchant whose brand
   only works in one of them.

   The OS rule is an override ON TOP OF the light tokens on ':host', so the
   explicit LIGHT case needs no rule of its own: excluding it from the media
   query is enough, and one rule that opts out beats two rules that
   re-declare the same palette and drift apart. ':host(:not([data-theme=
   "light"]))' also covers the attribute being ABSENT entirely, which is what
   a widget mounted before its published config lands looks like. */
@media (prefers-color-scheme: dark) {
  :host(:not([data-theme="light"])) {${DARK_TOKENS}}
}

/* Last, and higher-specificity than the base ':host', so a pinned dark theme
   wins on a light OS. Where both this and the media query match they set
   identical tokens, so which one wins does not matter. */
:host([data-theme="dark"]) {${DARK_TOKENS}}

/* Screen-reader-only. Every tick, every unread count, and every connection
   state has one of these, because the brief's "ticks need text equivalents,
   not colour alone" is the same requirement as WCAG 1.4.1. */
.dh-sr {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  margin: 0;
  cursor: pointer;
}

/* ':focus-visible' only, so a pointer user does not get a ring on every click,
   but every keyboard user gets one on every control. Never removed without a
   replacement. */
:focus { outline: none; }
:focus-visible {
  outline: 2px solid var(--dh-focus);
  outline-offset: 2px;
  border-radius: 6px;
}

/* ── Launcher ─────────────────────────────────────────────────────────── */

/* 'right'/'bottom', not 'inset-inline-*'. A merchant picking "bottom right"
   in a console showing a right-anchored preview means the right of the
   screen; a logical property would put it in the other corner on an RTL
   storefront, which is a setting silently doing the opposite of what it says.
   Everything INSIDE the widget stays logical — only the viewport anchor is
   physical, because only the anchor is what the merchant named. */
.dh-launcher {
  position: fixed;
  bottom: var(--dh-offset-y);
  right: var(--dh-offset-x);
  width: 56px; height: 56px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--dh-accent);
  color: var(--dh-accent-text);
  /* Its own shadow, not the panel's '--dh-shadow': this one is merchant-
     configurable and the panel's is not, and a lifted launcher over a page we
     do not control is a different judgement from a panel that sits on its own
     surface. */
  box-shadow: var(--dh-launcher-shadow);
  transition: transform 160ms ease, opacity 160ms ease, box-shadow 160ms ease;
  /* The container is 'pointer-events: none' so it cannot swallow clicks on the
     host page while it spans the viewport in the top layer (ui/root.ts). Every
     element that must actually be clickable turns them back on here. */
  pointer-events: auto;
}
.dh-launcher:hover { transform: scale(1.04); box-shadow: var(--dh-launcher-shadow-lift); }
.dh-launcher:active { transform: scale(0.97); }
.dh-launcher[hidden] { display: none; }

/* The three glyph sources, sized to one 24px box so the shape does not shift
   when a merchant switches between them. */
.dh-launcher-glyph {
  display: grid;
  place-items: center;
  width: 24px; height: 24px;
  flex: none;
}
.dh-launcher-emoji {
  font-size: 21px;
  line-height: 1;
}
.dh-launcher-image {
  width: 24px; height: 24px;
  border-radius: 4px;
  object-fit: contain;
}

:host([data-position="bottom-left"]) .dh-launcher {
  right: auto;
  left: var(--dh-offset-x);
}

/* ── Launcher shapes ──────────────────────────────────────────────────────

   'bubble' is the base rule above and needs no variant. The other two grow
   sideways to fit a label, so they trade the fixed 56px square for auto width
   and lay their two children out in a row — 'place-items: center' on the base
   rule keeps both centred either way. */
:host([data-launcher="bubble-label"]) .dh-launcher,
:host([data-launcher="tab"]) .dh-launcher {
  width: auto;
  grid-auto-flow: column;
  gap: calc(var(--dh-space) * 2.5);
  white-space: nowrap;
}
:host([data-launcher="bubble-label"]) .dh-launcher {
  padding: 0 calc(var(--dh-space) * 5) 0 calc(var(--dh-space) * 4);
}

/* A tab hugs the wall, so it drops the two corners facing it and gives up its
   horizontal offset — an offset gap behind a shape whose whole idea is being
   flush against the edge is the one thing it must not have. The VERTICAL
   offset still applies: that is how far up from the bottom it sits. */
:host([data-launcher="tab"]) .dh-launcher {
  height: 48px;
  padding: 0 calc(var(--dh-space) * 4);
  right: 0;
  border-radius: 999px 0 0 999px;
}
:host([data-launcher="tab"][data-position="bottom-left"]) .dh-launcher {
  right: auto;
  left: 0;
  border-radius: 0 999px 999px 0;
}

/* The sidebar's launcher is an edge tab, not a circle — the brief's "side tab
   that slides in". Vertical text keeps it narrow enough not to eat content.

   It also takes back the horizontal anchor, and must come AFTER the
   'data-position' rule above to do it: a sidebar is a full-height tab with no
   bottom corner to sit in, so its edge is 'data-side' (which also decides
   which way the panel slides) rather than the launcher's own corner setting.
   Letting both apply would let a merchant park the tab on the opposite edge
   from the panel it opens. */
:host([data-presentation="sidebar"]) .dh-launcher {
  right: var(--dh-offset-x);
  left: auto;
  bottom: auto;
  top: 50%;
  translate: 0 -50%;
  width: 40px;
  height: auto;
  padding: calc(var(--dh-space) * 4) calc(var(--dh-space) * 2);
  border-radius: var(--dh-radius) 0 0 var(--dh-radius);
  gap: calc(var(--dh-space) * 2);
  /* Stacked, not side by side. Restated rather than left to the grid default
     because 'data-launcher="tab"' above sets 'column' and this rule has to be
     able to take it back — a vertical rail 40px wide cannot lay an icon and a
     rotated label out in a row. Every other property this block needs from
     that rule is already re-declared here for the same reason. */
  grid-auto-flow: row;
}
:host([data-presentation="sidebar"][data-side="left"]) .dh-launcher {
  left: var(--dh-offset-x);
  right: auto;
  border-radius: 0 var(--dh-radius) var(--dh-radius) 0;
}
/* Hidden by default and shown by whichever shape has room for it. Three
   selectors rather than one, because the sidebar's edge tab shows a label for
   a reason of its own — it is a structural presentation, not the 'tab'
   launcher STYLE — and collapsing them would tie the two together. */
.dh-launcher-label { display: none; }
:host([data-launcher="bubble-label"]) .dh-launcher-label,
:host([data-launcher="tab"]) .dh-launcher-label,
:host([data-presentation="sidebar"]) .dh-launcher-label { display: block; }

:host([data-launcher="bubble-label"]) .dh-launcher-label,
:host([data-launcher="tab"]) .dh-launcher-label {
  font-size: 14px;
  font-weight: 600;
  /* A merchant's label is free text and the launcher sits over their own
     page, so it is capped rather than allowed to span the viewport. */
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* LAST, so it wins the tie against the launcher-style typography above when
   both match — a merchant's 'tab' style on a host's sidebar presentation. The
   rail owns its own type: rotated, narrower, and with no horizontal cap,
   which is the wrong axis to clamp on vertical text. */
:host([data-presentation="sidebar"]) .dh-launcher-label {
  writing-mode: vertical-rl;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  max-width: none;
}
:host([data-presentation="sidebar"]) .dh-launcher:hover { transform: none; }

/* The unread badge. Its number is decoration: the count is also in the
   launcher's accessible name, so a screen reader hears "Open chat, 3 unread
   messages" rather than an unannounced red dot. */
.dh-badge {
  position: absolute;
  top: -2px; inset-inline-end: -2px;
  min-width: 20px; height: 20px;
  padding: 0 5px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--dh-danger);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  border: 2px solid var(--dh-surface);
}
.dh-badge[hidden] { display: none; }

/* ── Panel ────────────────────────────────────────────────────────────── */

.dh-panel {
  position: fixed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dh-surface);
  color: var(--dh-text);
  border: 1px solid var(--dh-border);
  box-shadow: var(--dh-shadow);
  opacity: 0;
  visibility: hidden;
  pointer-events: auto;
  transition: opacity 180ms ease, translate 220ms cubic-bezier(0.32, 0.72, 0, 1), visibility 0s linear 220ms;
}
.dh-panel[data-open="true"] {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}

/* The off-screen offsets belong to the CLOSED state, never to the open one.

   Written the other way round first — a per-presentation 'translate' plus a
   ':host(...) .dh-panel' selector — and every presentation stayed off screen.
   ':host([data-presentation="sidebar"]) .dh-panel' scores (0,2,1) against
   '.dh-panel[data-open="true"]'s (0,2,0), so the open rule's 'translate: none'
   silently lost and the sidebar rendered at left:1280 on a 1280px viewport.
   Putting each offset behind '[data-open="false"]' removes the competing
   declaration instead of trying to out-specify it, which is the version that
   cannot regress when a fourth presentation is added. */

/* bubble: a floating card anchored above the launcher — so it takes the same
   physical corner and the same offsets, for the same reason. */
:host([data-presentation="bubble"]) .dh-panel {
  bottom: calc(var(--dh-offset-y) + 56px + var(--dh-space) * 3);
  right: var(--dh-offset-x);
  width: min(384px, calc(100vw - var(--dh-space) * 8));
  height: min(560px, calc(100dvh - 140px));
  border-radius: var(--dh-radius);
}
:host([data-position="bottom-left"][data-presentation="bubble"]) .dh-panel {
  right: auto;
  left: var(--dh-offset-x);
}
:host([data-presentation="bubble"]) .dh-panel[data-open="false"] { translate: 0 8px; }

/* sidebar: full-height, edge-anchored, slides in horizontally. */
:host([data-presentation="sidebar"]) .dh-panel {
  top: 0; bottom: 0;
  inset-inline-end: 0;
  /* Pinned rather than inherited: 'inset-inline-end' and the translate above
     both resolve against 'direction', which crosses the shadow boundary, so an
     RTL host page would otherwise slide the panel in from the side opposite
     the one 'data-side' names. */
  direction: ltr;
  width: min(420px, 100vw);
  border-radius: 0;
  border-block: 0;
}
:host([data-presentation="sidebar"]) .dh-panel[data-open="false"] { translate: 100% 0; }
:host([data-presentation="sidebar"][data-side="left"]) .dh-panel[data-open="false"] { translate: -100% 0; }

/* sheet: bottom-anchored, full width. 'dvh' is the whole reason this mode
   exists — with 'vh', iOS Safari's URL bar makes the composer sit under the
   fold, and the on-screen keyboard pushes it off entirely. */
:host([data-presentation="sheet"]) .dh-panel {
  left: 0; right: 0; bottom: 0;
  width: 100%;
  height: min(88dvh, 720px);
  max-height: 100dvh;
  border-radius: var(--dh-radius) var(--dh-radius) 0 0;
  border-bottom: 0;
}
:host([data-presentation="sheet"]) .dh-panel[data-open="false"] { translate: 0 100%; }

/* A grab handle, on the sheet only — it is the affordance that says "this
   panel came from the bottom edge and goes back there". */
.dh-grip { display: none; }
:host([data-presentation="sheet"]) .dh-grip {
  display: block;
  width: 36px; height: 4px;
  margin: calc(var(--dh-space) * 2) auto 0;
  border-radius: 999px;
  background: var(--dh-border);
  flex: none;
}

@media (prefers-reduced-motion: reduce) {
  .dh-panel, .dh-launcher { transition-duration: 1ms; }
  .dh-typing-dot { animation: none; }
}

/* ── Header ───────────────────────────────────────────────────────────── */

/* The brand band: the header row, the offline banner and the hero as one box
   (widget.ts's panel children). Structural, and deliberately NOT gated on a
   design — both designs get the same tree, and only the PAINT below is gated,
   because two markup shapes for one panel is two shapes to reason about.

   A column of the same three 'flex: none' children the panel column already
   stacked, so on the classic design this box is exactly as tall as the space
   its children used to take and nothing moves. 'flex: none' on the wrapper
   itself for the reason each of them had it: the transcript, and Home, are
   the only things in the panel column allowed to absorb spare height.

   ── The one thing this box must never grow (stated here, referred to from
      widget.ts and from the straddle below rather than restated) ──────────

   NO 'z-index', 'transform', 'filter', 'isolation' or 'contain' on this
   element, ever. Every one of those opens a stacking context, and '.dh-hmenu'
   — the header menu's dropdown, 'z-index: 3' — lives INSIDE this box.
   Confined to a band-local context, an OPEN menu would be trapped underneath
   the very thing it must paint over: Home's CTA card, which the straddle
   below deliberately overlaps this band's bottom edge with. */
.dh-brand-band {
  flex: none;
  display: flex;
  flex-direction: column;
}

.dh-header {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 3);
  padding: calc(var(--dh-space) * 3) calc(var(--dh-space) * 4);
  border-bottom: 1px solid var(--dh-border);
  flex: none;
}
.dh-title { font-size: 15px; font-weight: 600; margin: 0; }
/* The header's avatar — the merchant's brand face (logo or initials) until an
   agent is on the chat, then that agent's single letter, and nothing at all
   while the out-of-hours surface is up; widget.ts's 'syncHeaderAvatar' owns
   that state machine. Painted off the accent rather than a neutral so an
   initials disc reads as the merchant's brand and not as a placeholder;
   'readableOn' picks the letter colour, so a pale accent still has legible
   text on it. Hidden entirely when there is nothing to draw — see
   'buildHeaderAvatar'. */
.dh-avatar-host { display: flex; align-items: center; flex: none; }
.dh-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px; height: 32px;
  border-radius: 999px;
  background: var(--dh-accent);
  color: var(--dh-on-accent, #fff);
  font-size: 13px;
  font-weight: 600;
  /* Uppercase in CSS rather than in the string, so what a merchant typed is
     what a screen reader would get if this ever stopped being decoration. */
  text-transform: uppercase;
  flex: none;
  overflow: hidden;
}
.dh-avatar-image { object-fit: cover; background: none; }
/* The agent's letter shares the brand disc wholesale — a second palette for
   "person" vs "brand" is a distinction the 32px circle cannot carry; the class
   exists as the styling/testing hook for WHICH identity is drawn, same job as
   '#dh-title's 'data-handled-by'. */
/* Under the hero design the header row is painted in the brand colour, and an
   accent disc can vanish into it (accent IS the usual header colour). The same
   '--dh-header-fg' ring '.dh-hero-avatar' already wears keeps it separable
   over a flat colour, a gradient and an image alike; border-box sizing keeps
   the disc 32px. */
:host([data-design="hero"]) .dh-avatar { border: 2px solid var(--dh-header-fg); }
.dh-status {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 1.5);
  font-size: 12px;
  color: var(--dh-text-muted);
}
/* The dot is decoration; '.dh-status' carries the words. Never colour alone. */
.dh-status-dot {
  width: 7px; height: 7px;
  border-radius: 999px;
  background: currentColor;
  flex: none;
}
.dh-header-spacer { flex: 1; }

/* ── The offline banner ───────────────────────────────────────────────────

   Directly under the header row and painted as its own band, because it is a
   statement about the whole panel rather than about any one screen: it stays
   put while the customer moves between Home, Messages and a conversation, and
   'flex: none' keeps it out of the space the transcript scrolls in.

   Amber, not red — see ui/offline-banner.ts. Nothing has failed; every message
   is held and the connection is retrying. The two tones differ only in how
   warm they are: 'offline' is the customer's own network and reads as
   information, 'unreachable' is our service and is a shade more insistent.

   The two colour pairs are palette TOKENS ('--dh-warn-*', '--dh-alarm-*') so
   they follow the same three-way light/dark/pinned switch as everything else,
   but they are deliberately NOT derived from the merchant's accent the way the
   header and bubbles are. A status band tinted with the brand colour goes
   invisible on the merchant whose brand IS amber, and this is the one surface
   whose whole job is to be noticed.

   'position: sticky' with 'top: 0' costs nothing where the banner is already
   in flow, and holds it in place if a future layout ever scrolls the column
   it sits in. That column is now '.dh-brand-band' (widget.ts), not
   '.dh-panel' — the band became this banner's sticky containing block when it
   became its parent — so the intent is scoped accordingly: inert today,
   because neither box scrolls, and it would come alive only for a layout that
   made the BAND itself a scroll container. Nothing about the banner's
   position under the header row, or about its live region, changed with it.
*/
.dh-offline-banner {
  flex: none;
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 4);
  background: var(--dh-warn-bg);
  color: var(--dh-warn-fg);
  border-bottom: 1px solid var(--dh-warn-border);
  font-size: 12.5px;
  line-height: 1.4;
  position: sticky;
  top: 0;
  z-index: 2;
}
.dh-offline-banner[data-tone="unreachable"] {
  background: var(--dh-alarm-bg);
  color: var(--dh-alarm-fg);
  border-bottom-color: var(--dh-alarm-border);
}
.dh-offline-banner svg { flex: none; }
.dh-offline-text { overflow-wrap: anywhere; }

/* ── The hero header ──────────────────────────────────────────────────────

   Gated on 'data-design="hero"', and that gate is the whole reason the
   default is 'classic'. Painting the header in the brand colour is a
   redesign, and it must reach only the merchants who asked for one in the
   console — never a host who embedded a script tag and never opened it.

   The background is two layers: a flat colour, and a gradient or image over
   it ('--dh-header-layers', 'none' when neither applies). The foreground is
   computed from the colour's luminance rather than hardcoded white, because
   a pastel brand with white text is a header nobody can read.

   ── One paint, on the BAND, not two on its parts ────────────────────────

   This used to be declared twice: here, and again on '.dh-hero' below, each
   with its own 'background-size: cover'. Both are honest readings of "paint
   this brand colour", and together they are a bug you can see:
   '--dh-header-layers' is a 'linear-gradient(180deg, …)' top-to-bottom fade,
   and 'cover' sizes it to the BOX it is painted on, so the fade ran out over
   the header row's own height and then STARTED OVER at the top of the hero.
   Two distinct bands with a hard edge between them, on a surface whose whole
   purpose is to read as one tall header. A background image had the same
   fault in a louder form — the merchant's photo, cropped twice, at two
   different scales.

   So it is painted ONCE, on '.dh-brand-band' (widget.ts), the element that
   contains all three parts; the parts themselves paint nothing and inherit
   '--dh-header-fg' from it. There is no seam left to restart at.

   'background-size: cover' survives the move, and moving it up here did not
   retire what 'cover' costs on a box whose height changes — it relocated and
   widened it. That is a KNOWN, accepted consequence, written out under
   '.dh-hero' below; read it before reaching for a different 'background-size'
   here. */
:host([data-design="hero"]) .dh-brand-band {
  background-color: var(--dh-header-bg);
  background-image: var(--dh-header-layers);
  background-size: cover;
  background-position: center;
  color: var(--dh-header-fg);
}
:host([data-design="hero"]) .dh-header {
  /* The paint IS the separation — a hairline on top of it reads as a seam. */
  border-bottom-color: transparent;
}

/* Everything in the header that had its own muted colour now inherits, or it
   would be painting grey-on-brand. Opacity rather than a second colour token:
   it holds up over a gradient, an image and a flat colour alike, where any
   fixed grey only works over one of them. */
:host([data-design="hero"]) .dh-status,
:host([data-design="hero"]) .dh-icon-button {
  color: inherit;
  opacity: 0.85;
}
:host([data-design="hero"]) .dh-icon-button:hover {
  background: rgb(255 255 255 / 0.16);
  color: inherit;
  opacity: 1;
}
:host([data-design="hero"]) .dh-reconnect {
  color: inherit;
  border-color: currentColor;
}
:host([data-design="hero"]) .dh-reconnect:hover { background: rgb(255 255 255 / 0.16); }

/* The hero's content block. It paints NOTHING of its own: the brand colour,
   the gradient and the foreground all belong to '.dh-brand-band' above, which is
   the box that spans the header row, the offline banner and this — see that
   rule for why one paint on the parent is not the same thing as the same
   paint on each child.

   'flex: none' for the same reason .dh-composer has it: the transcript is the
   only element in the panel column allowed to absorb spare height. The hero
   only ever renders while that transcript is EMPTY (see widget.ts), so what
   it takes costs nothing that was being used.

   Collapsed means GONE, not shorter: '[data-collapsed="true"]' snaps the
   band to zero height (the product owner rejected the earlier 66px compact
   bar — an empty dead strip on tenants with no logo/faces — see
   ui/hero-header.ts's module header). A HEIGHT snap, not an animation, is
   what actually gives that space back to '.dh-home'; 'overflow: hidden' is
   what keeps the still-present '.dh-hero-full' content from painting out of
   a zero-height box while it fades. Nothing else is needed — at height 0 this
   box adds no height to '.dh-brand-band', so the brand paint simply ends under the
   header row, exactly as it does on a screen that never had a hero.

   ── The re-stretched gradient: RELOCATED and widened, not retired ────────

   The 66px compact bar needed a 'background-image: none' carve-out because a
   painted box whose height changes re-stretches the gradient painted on it.
   It is tempting to read the rules above as having killed that regression,
   and this comment used to say so. It has not. This element has no background
   left to stretch, but '.dh-brand-band' has one, and 'background-size: cover'
   sizes it to the BAND's box — so the fault moved up one level, and up there
   it has MORE ways to fire than the 66px bar ever gave it. Every change to
   the band's height re-scales the merchant's gradient (or re-crops their
   background image). There are three:

     1. this hero collapsing to 0 and expanding back — the rules below, on
        every scroll away from the top of Home and back;
     2. the offline banner appearing and disappearing — widget.ts stacks it
        inside this same band, so losing signal re-scales the brand paint;
     3. leaving Home for Messages or a conversation — 'setPaneVisible' hides
        this hero outright and the band shrinks to the header row.

   None of that is fixed here, and none of it should be. It is the accepted
   price of painting the header row and the hero as ONE box (D1): a single
   band that re-scales when its height changes beats two permanently
   mismatched bands that never do. Anyone who wants it gone is not tuning
   'background-size' — they are reopening D1. */
.dh-hero {
  flex: none;
}
.dh-hero[hidden], .dh-hero[data-empty="true"] { display: none; }
.dh-hero[data-collapsed="true"] { height: 0; overflow: hidden; }

/* ── The straddle: Home's first card sits ON the band's bottom edge ───────

   Home's primary call to action ('.dh-home-cta', ui/home-screen.ts) sat
   entirely below the brand paint, which read as the first row of a list
   rather than as the one thing the screen is asking for. It now overlaps the
   band's bottom edge — roughly its top half over the brand colour, its bottom
   half over the panel's own surface.

   The mechanism is: grow the painted box, then take the same distance back
   off its outer edge. 'padding-bottom' extends the paint past where the band
   ends, and the equal, opposite 'margin-bottom' pulls '.dh-home' — the very
   next sibling, see widget.ts — back up by exactly as much. The two cancel,
   so the panel's total layout is IDENTICAL to what it was before this rule
   existed; the only difference is a strip of brand paint behind the top of
   Home's first card.

   ── Why that distance ────────────────────────────────────────────────────

   It IS a step on the spacing scale — 'calc(var(--dh-space) * 12)', and this
   sheet already steps in '* 3', '* 4', '* 5' and '* 6' off the same 4px
   token. Written against the token rather than as a bare '48px' so it cannot
   silently stop being a step the day '--dh-space' moves.

   Twelve steps because that is '.dh-home's own 16px of top padding (4 steps)
   plus 32px (8) of the card below it — roughly HALF the card, which is the
   honest framing; there is no exact card height to be half of. '.dh-home-cta'
   is 'align-items: center', so its height is whichever is taller of the 36px
   icon and the text column, plus 12px padding twice and 1px border twice.
   With no sub-line the icon wins and the card is 62px. With one, the text
   column wins — a 14px title and a 12px sub-line at the panel's 1.45
   line-height, 2px apart, so about 40px — and the card is about 66px. Half is
   therefore 31–33px depending on what the merchant configured, which is why
   the value is a rounded 32 and the description is "roughly half".

   (That arithmetic is read off the declarations in this file, not measured in
   a browser. It decides only how much of the card the strip covers, so being
   a pixel or two out is a cosmetic difference, not a layout one.)

   Named once and used twice, because the two uses must stay EQUAL — the day
   they drift is the day the panel's whole layout shifts by the difference,
   which is not a bug anyone would look for in a padding value.

   No 'z-index', and none is needed: '.dh-home' is a LATER sibling than the
   band, so ordinary in-flow paint order already puts the card (and Home's
   whole subtree) above the brand paint. The overhanging strip does not steal
   clicks or scrolls from Home for the same reason — hit-testing follows paint
   order. Adding a z-index here would be actively wrong, for the reason stated
   in full on '.dh-brand-band' in the header section.

   The ':has()' is what keeps the overhang honest, and each ':not()' in it
   mirrors one of the two rules directly above: a collapsed hero (height 0) or
   one that is hidden/empty (display: none) takes the hero out of the layout,
   and the overhang has to leave with it. Without them the band would go on
   overhanging Home by the straddle distance with no hero under it — the card
   would ride up over the HEADER ROW the moment a scroll collapsed the hero,
   and on Messages and in a conversation, where there is no hero at all
   either. ':has()' is live: it
   is re-evaluated on the same frame 'data-collapsed' flips, which is the
   frame the height snaps on.

   Both halves living HERE, on the band, is also what keeps ui/hero-header.ts's
   collapse guard honest. That guard refuses to collapse unless the container
   will still be scrolled past its slack once the hero's height comes back, and
   it measures that height as the hero's own 'offsetHeight'. Because the
   padding and the margin below cancel — and leave together — a collapse is
   EXPECTED to return exactly the hero's height to '.dh-home' and not a pixel
   more. Expected, not measured: that follows from the two declarations below
   being equal and opposite, and nothing in this repo has yet watched it
   happen (see test/brand-band.test.ts's header for what a browser check would
   have to measure). Move either declaration onto '.dh-hero' itself and it
   stops being true even in principle: the guard would then over-count the
   freed space by the straddle distance and re-open the oscillation loop that
   guard exists to close.

   ── A known artifact, accepted, deliberately NOT fixed ───────────────────

   Precondition: the collapse guard refuses while 'overflow - freed <= 32px'.
   Inside that window a visitor can scroll '.dh-home' with the hero still
   expanded and this strip still in place, which slides Home's own content up
   underneath the brand paint. Home's later children have transparent
   backgrounds — '.dh-home-section-title' and '.dh-entry-note' are muted grey
   text on nothing — so for the length of that scroll they can pass over the
   merchant's brand colour and lose their contrast against it.

   Accepted as-is. The obvious repair, a background on '.dh-home', would paint
   over the band and destroy the straddle outright — the straddle works only
   because Home's surface is transparent where it overlaps. The window is
   narrow (a Home short enough that the guard refuses, yet long enough to
   scroll), the effect is transient and affects decoration rather than any
   control's label. Anything better than accepting it is a redesign of this
   rule, not a tweak to it. */
:host([data-design="hero"]) .dh-brand-band:has(.dh-hero:not([hidden]):not([data-empty="true"]):not([data-collapsed="true"])) {
  --dh-band-straddle: calc(var(--dh-space) * 12);
  padding-bottom: var(--dh-band-straddle);
  margin-bottom: calc(var(--dh-band-straddle) * -1);
}

/* The hero's content block — everything the band draws. Its own opacity
   transition (not the hero's) is the entire animation: no width, height or
   position on THIS rule ever animates, which is what keeps a customer's
   scroll from paying for a layout recalculation on every frame. The fade
   only ever shows on RE-EXPAND — collapsed, the parent's zero-height clip
   hides this layer before any fade could finish — and that is the point:
   the returning hero fades in over one 180ms beat instead of popping. */
.dh-hero-full {
  display: flex;
  flex-direction: column;
  /* Widened one step (space*3 -> space*4) so the logo, the avatar stack and
     the greeting read as distinct sections rather than a cramped stack —
     the bigger avatars and larger greeting below need the extra air, or
     they crowd the row above them. Top padding stays 0: this block is
     painted as the header's own continuation (see the comment above), and
     that seam is the one edge this reconciliation pass does not touch. */
  gap: calc(var(--dh-space) * 4);
  padding: 0 calc(var(--dh-space) * 4) calc(var(--dh-space) * 6);
  opacity: 1;
  transition: opacity 180ms ease;
}
.dh-hero[data-collapsed="true"] .dh-hero-full { opacity: 0; pointer-events: none; }

.dh-hero-logo {
  height: 40px;
  max-width: 150px;
  align-self: flex-start;
  object-fit: contain;
  object-position: left;
}

/* Overlapped by a negative margin, in order, so they read as a team rather
   than as a list. The last one carries the presence dot. Sized to match
   .dh-avatar (the classic header's own face, 32px) rather than the smaller
   26px this stack drew before — two different avatar sizes in one product
   for no reason other than which header design is on is not a size worth
   keeping. */
.dh-hero-avatars { display: flex; align-items: center; }
.dh-hero-avatar {
  position: relative;
  display: block;
  width: 32px; height: 32px;
  flex: none;
  border-radius: 999px;
  border: 2px solid var(--dh-header-fg);
  background: var(--dh-header-fg);
}
.dh-hero-avatar + .dh-hero-avatar { margin-inline-start: -10px; }
.dh-hero-avatar img { width: 100%; height: 100%; border-radius: 999px; object-fit: cover; }
.dh-hero-presence {
  position: absolute;
  bottom: -2px; inset-inline-end: -2px;
  width: 10px; height: 10px;
  border-radius: 999px;
  border: 2px solid var(--dh-header-fg);
  background: #118d57;
}

/* The IntersectionObserver marker ui/hero-header.ts's 'watchScroll' inserts
   at the top of '.dh-home' (above). Absolutely positioned against that
   element's new 'position: relative' so it never becomes a real flow child —
   '.dh-home' lays its children out with 'gap', which would otherwise widen
   the space above the CTA card by one gap's worth for a pixel nobody sees. */
.dh-hero-sentinel {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  pointer-events: none;
}

/* One step up (22px -> 24px) and tightened (1.25 -> 1.2): this is the one
   headline the hero has, playing the part the reference's home screen
   greeting plays, and it read closer to a subtitle than a headline at the
   old scale next to a 40px logo and a 32px avatar stack. */
.dh-hero-greeting {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
}
.dh-hero-sub {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.35;
  opacity: 0.92;
}

/* No '.dh-hero-cta' rules, and that is the point rather than an omission. The
   hero drew a "send us a message" card of its own until this sheet's own
   comment here admitted the problem out loud: it sat directly above
   '.dh-home-cta' (ui/home-screen.ts), which Home draws unconditionally, so
   the two were never alternatives — every hero with an enabled CTA showed two
   cards making the same offer. The straddle above is the fidelity that
   overhang was reaching for, and Home's card is the one that keeps it.
   ui/hero-header.ts's module header records the decision. */

.dh-icon-button {
  width: 32px; height: 32px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--dh-text-muted);
}
.dh-icon-button:hover { background: var(--dh-surface-sunken); color: var(--dh-text); }
.dh-icon-button[disabled] { opacity: 0.45; cursor: not-allowed; }

/* Shown only in a state core has stopped retrying out of, so it reads as the
   one thing left to do rather than as permanent header furniture. */
.dh-reconnect {
  padding: calc(var(--dh-space) * 1.5) calc(var(--dh-space) * 3);
  border-radius: 999px;
  border: 1px solid var(--dh-border);
  font-size: 12px;
  font-weight: 600;
  color: var(--dh-text);
  white-space: nowrap;
}
.dh-reconnect:hover { background: var(--dh-surface-sunken); }
.dh-reconnect[hidden] { display: none; }
.dh-reconnect[disabled] { opacity: 0.45; cursor: not-allowed; }

/* ── Report an issue ──────────────────────────────────────────────────── */

/*
 * Was '.dh-handoff', shared with a visible "Talk to a human" button that no
 * longer exists — escalation is handoff-keyword-only now (widget.ts). The
 * outline treatment stays for the report button, which still earns it.
 *
 * Sits on the seam between the transcript and the composer. flex: none for
 * the same reason .dh-composer has it: the log is the only element in the
 * panel column allowed to absorb the spare height, and a growable strip here
 * would take it from the conversation.
 */
.dh-report-open {
  flex: none;
  align-self: stretch;
  margin: 0 calc(var(--dh-space) * 3) calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  border-radius: 999px;
  border: 1px solid var(--dh-accent);
  font-size: 13px;
  font-weight: 600;
  color: var(--dh-accent);
  background: transparent;
}
.dh-report-open:hover { background: var(--dh-surface-sunken); }
/* An explicit rule, not the UA default: display here is set by this sheet,
 * and a stylesheet declaration beats the UA's [hidden] rule. */
.dh-report-open[hidden] { display: none; }
.dh-report-open[disabled] { opacity: 0.45; cursor: not-allowed; }

/* ── Common Questions ─────────────────────────────────────────────────── */

/*
 * Same seam as .dh-report-open above (flex: none, same rationale) — it sits in
 * the same "between the log and the composer" position, just shown at the
 * opposite moment: before the first message rather than mid-conversation.
 */
.dh-common-questions-host {
  flex: none;
  margin: 0 calc(var(--dh-space) * 3) calc(var(--dh-space) * 2);
}
.dh-common-questions-host[hidden] { display: none; }

/*
 * A single bordered box (borrowing '.dh-messages-row's radius/border
 * tokens), not a wrapped row of independent pills — see this file's own
 * header comment for why the pill shape shipped once and was wrong: it read
 * as tags, not as a list of tappable questions, and gave no "this opens
 * something" affordance at all. 'list-style'/'margin'/'padding' reset because
 * the node is a '<ul>' now (see 'role="list"' in common-questions.ts for why
 * that tag survives the reset instead of switching to a '<div>').
 */
.dh-common-questions {
  display: flex;
  flex-direction: column;
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  overflow: hidden;
  background: var(--dh-surface);
}

/* Hairline between rows, not around each one — the border above is the
   list's own edge. '+' rather than ':not(:first-child)' for the same
   "read the relationship, not an exclusion" reason this package's other
   adjacent-sibling rules (e.g. '.dh-hero-avatar + .dh-hero-avatar') are
   written that way. */
.dh-common-question-item + .dh-common-question-item { border-top: 1px solid var(--dh-border); }

.dh-common-question-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--dh-space) * 2);
  width: 100%;
  padding: calc(var(--dh-space) * 3);
  border: 0;
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  color: var(--dh-text);
  text-align: left;
  cursor: pointer;
}
.dh-common-question-row:hover { background: var(--dh-surface-sunken); }
.dh-common-question-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Message list ─────────────────────────────────────────────────────── */

.dh-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;      /* the host page must not scroll behind us */
  -webkit-overflow-scrolling: touch;
  padding: calc(var(--dh-space) * 4);
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 2);
  /* The merchant-configurable backdrop. Defaults to '--dh-surface' through
     themeCss, so a widget nobody has configured is unchanged.

     Only the transcript takes it, not the composer or the pre-chat screen:
     artwork behind a text field is a legibility problem, and the console's own
     preview puts it behind the messages alone. Bubbles keep their opaque
     surfaces on top of it in every mode. */
  background-color: var(--dh-thread-bg);
  background-image: var(--dh-thread-layers);
  background-size: var(--dh-thread-size);
  background-repeat: var(--dh-thread-repeat);
  background-position: center;
  /* Pinned to the scroll container rather than the content, so artwork stays
     put while messages move over it. */
  background-attachment: scroll;
}
.dh-log:focus-visible { outline-offset: -2px; }

.dh-more {
  align-self: center;
  padding: calc(var(--dh-space) * 1.5) calc(var(--dh-space) * 3);
  border-radius: 999px;
  border: 1px solid var(--dh-border);
  font-size: 13px;
  color: var(--dh-text-muted);
}
.dh-more[hidden] { display: none; }

/* '.dh-msg' is the ROW — it holds the sender's avatar beside the bubble, not
   the bubble's own look. That look (background, padding, shape) lives on
   '.dh-msg-bubble' instead, so an avatar sitting next to it is never painted
   into the bubble's own coloured background. */
.dh-msg {
  display: flex;
  align-items: flex-start;
  gap: calc(var(--dh-space) * 2);
  max-width: 82%;
}
.dh-msg[data-mine="false"] { align-self: flex-start; }
.dh-msg[data-mine="true"] { align-self: flex-end; }

.dh-msg-bubble {
  /* Without this, a flex item's default 'min-width: auto' refuses to shrink
     below its content's intrinsic width, and 'overflow-wrap' below never
     gets the chance to fire — the exact "pasted URL widens the panel" bug
     that rule exists to prevent. */
  min-width: 0;
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  border-radius: var(--dh-radius);
  overflow-wrap: anywhere;           /* a pasted URL must not widen the panel */
  white-space: pre-wrap;             /* newlines the user typed are content */
}
.dh-msg[data-mine="false"] .dh-msg-bubble {
  background: var(--dh-bubble-in);
  border-bottom-left-radius: 4px;
}

/* Who is speaking. Only the first bubble of a run carries one, so this is a
   heading for the run rather than a label repeated on every line. */
.dh-msg-author {
  font-size: 12px;
  font-weight: 600;
  color: var(--dh-text-muted);
  margin-bottom: calc(var(--dh-space) * 0.5);
}
.dh-msg-author[hidden] { display: none; }
.dh-msg[data-mine="true"] .dh-msg-bubble {
  background: var(--dh-accent);
  color: var(--dh-accent-text);
  border-bottom-right-radius: 4px;
}
.dh-msg[data-failed="true"] .dh-msg-bubble {
  border: 1px solid var(--dh-danger);
}

/* The sender's avatar — see message-list.ts's construction comment for why
   it exists and why it always draws from the SENDER's own resolved name,
   never the merchant's header initial. Same disc as '.dh-avatar' above
   (inherits its accent background, '--dh-on-accent' text and uppercase
   transform); only its size is its own, scaled down from the header's 32px
   because this one sits beside a line of chat text, not a page title. */
.dh-msg-avatar {
  width: calc(var(--dh-space) * 6);
  height: calc(var(--dh-space) * 6);
  font-size: 11px;
  flex: none;
}
.dh-msg-avatar[hidden] { display: none; }
.dh-msg-sender {
  font-size: 12px;
  font-weight: 600;
  color: var(--dh-text-muted);
  margin-bottom: calc(var(--dh-space) * 0.5);
}
.dh-msg-meta {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 1.5);
  margin-top: calc(var(--dh-space) * 1);
  font-size: 11px;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
.dh-msg[data-mine="true"] .dh-msg-meta { justify-content: flex-end; }

/* Ticks. The glyph is a visual shorthand and carries no information of its
   own — every one is paired with a '.dh-sr' phrase, so "read" is announced,
   not inferred from two blue check marks. */
.dh-tick { font-size: 12px; letter-spacing: -0.08em; }
.dh-tick[data-state="read"] { color: #53a3ff; opacity: 1; }
.dh-msg[data-mine="true"] .dh-tick[data-state="read"] { color: #9ecbff; }

.dh-attachment {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  margin-top: calc(var(--dh-space) * 1);
  font-size: 13px;
  text-decoration: underline;
  color: inherit;
}
.dh-attachment-image {
  display: block;
  max-width: 100%;
  max-height: 220px;
  border-radius: 8px;
  margin-top: calc(var(--dh-space) * 1);
}
.dh-audio { margin-top: calc(var(--dh-space) * 1); max-width: 100%; }

.dh-empty {
  margin: auto;
  text-align: center;
  color: var(--dh-text-muted);
  font-size: 13px;
  padding: calc(var(--dh-space) * 6);
}

/* The end-of-conversation line and its way out. Centred and full-width so it
   reads as chrome about the whole transcript rather than as another message
   in it — no bubble, no sender, no timestamp. */
.dh-system {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  align-self: stretch;
  padding: calc(var(--dh-space) * 3) 0 calc(var(--dh-space) * 1);
  border-top: 1px solid var(--dh-border);
  margin-top: calc(var(--dh-space) * 2);
}
.dh-system[hidden] { display: none; }

.dh-system-text {
  margin: 0;
  text-align: center;
  color: var(--dh-text-muted);
  font-size: 13px;
}

.dh-system-action {
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 4);
  border-radius: 999px;
  border: 1px solid var(--dh-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--dh-accent, inherit);
}

/* The reason a failed send did not go through — shown whether or not a
   Retry button accompanies it, so a permanently-refused send still tells the
   customer why instead of just silently withholding the button. */
.dh-failure {
  font-size: 12px;
  color: var(--dh-danger);
}
.dh-failure[hidden] { display: none; }
.dh-msg[data-mine="true"] .dh-failure { color: #ffd7d3; }

.dh-retry {
  font-size: 12px;
  color: var(--dh-danger);
  text-decoration: underline;
  padding: 0;
}

/* Retrying into a session that has ended is the dead end this UI removes.
   The "start a new conversation" button is the way forward instead. */
.dh-log[data-closed="true"] .dh-retry { display: none; }
.dh-msg[data-mine="true"] .dh-retry { color: #ffd7d3; }

/* ── Session picker: pre-chat screen + in-chat switcher ──────────────────
   One row style (.dh-session-row and its children) shared by both
   surfaces (ui/session-picker.ts) — the "one component family" the two
   screens are built from. */

.dh-prechat {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: calc(var(--dh-space) * 4);
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 3);
  background: var(--dh-surface);
}
.dh-prechat-heading {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--dh-text-muted);
}

.dh-session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 2);
}
.dh-session-empty {
  text-align: center;
  color: var(--dh-text-muted);
  font-size: 13px;
  padding: calc(var(--dh-space) * 4) 0;
}
.dh-session-empty[hidden] { display: none; }

.dh-session-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: calc(var(--dh-space) * 1);
  padding: calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface);
  text-align: start;
}
.dh-session-row:hover { background: var(--dh-surface-sunken); }
.dh-session-row[aria-current="true"] { border-color: var(--dh-accent); }

.dh-session-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--dh-space) * 2);
}
.dh-session-status {
  font-size: 11px;
  font-weight: 600;
  padding: 2px calc(var(--dh-space) * 2);
  border-radius: 999px;
  background: var(--dh-surface-sunken);
  color: var(--dh-text-muted);
}
/* A terminal status is information, not an archive marker — no dimming, no
   disabled affordance. Picking this row reactivates it server-side. */
.dh-session-row[data-status="ON_HOLD"] .dh-session-status { color: #c98a00; }

.dh-session-time {
  font-size: 11px;
  color: var(--dh-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dh-session-preview {
  font-size: 13px;
  color: var(--dh-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dh-session-preview[hidden] { display: none; }

.dh-session-handler {
  font-size: 12px;
  color: var(--dh-text-muted);
}
.dh-session-handler[hidden] { display: none; }

.dh-session-unread {
  align-self: flex-start;
  font-size: 11px;
  font-weight: 700;
  padding: 1px calc(var(--dh-space) * 2);
  border-radius: 999px;
  background: var(--dh-danger);
  color: #fff;
}
.dh-session-unread[hidden] { display: none; }

.dh-prechat-start, .dh-switcher-start {
  padding: calc(var(--dh-space) * 3);
  border-radius: 10px;
  background: var(--dh-accent);
  color: var(--dh-accent-text);
  font-size: 14px;
  font-weight: 600;
  text-align: center;
}
.dh-prechat-start[disabled], .dh-switcher-start[disabled] { opacity: 0.6; cursor: not-allowed; }

/* The in-chat switcher: a disclosure button plus a self-contained popover —
   position: relative lives on .dh-switcher itself so this renders correctly
   wherever the header mounts it, with no dependency on an ancestor's
   positioning context. */
.dh-switcher { position: relative; display: inline-flex; }
.dh-switcher-toggle[aria-expanded="true"] { background: var(--dh-surface-sunken); color: var(--dh-text); }

.dh-switcher-panel {
  position: absolute;
  top: calc(100% + var(--dh-space) * 2);
  inset-inline-end: 0;
  z-index: 2;
  width: min(300px, 80vw);
  max-height: 360px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 3);
  padding: calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface);
  box-shadow: var(--dh-shadow);
}
.dh-switcher-panel[hidden] { display: none; }

/* ── Typing indicator ─────────────────────────────────────────────────── */

.dh-typing {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 1);
  align-self: flex-start;
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  border-radius: var(--dh-radius);
  background: var(--dh-bubble-in);
}
/* 'behaviour.consentRequired' — the notice above the composer it gates.
   Bordered off rather than tinted as a warning: this is a routine notice on
   most storefronts, and painting it as an alert would make an ordinary privacy
   line look like something went wrong. */
.dh-consent {
  flex: none;
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  border-top: 1px solid var(--dh-border);
  background: var(--dh-surface);
}
.dh-consent-text {
  margin: 0;
  flex: 1;
  font-size: 12px;
  line-height: 1.45;
  color: var(--dh-text-muted);
  overflow-wrap: anywhere;
}
.dh-consent-agree {
  flex: none;
  padding: calc(var(--dh-space) * 1.5) calc(var(--dh-space) * 3);
  border: 0;
  border-radius: var(--dh-radius);
  background: var(--dh-accent);
  color: var(--dh-on-accent, #fff);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.dh-consent-agree:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: 2px; }

/* 'behaviour.greeting' — the merchant's opening line, shown while the
   transcript is still empty. Painted as an INBOUND bubble because that is what
   the console calls it ("The first message"), so it has to read as something
   said to the customer rather than as chrome around the conversation. It
   shares '--dh-bubble-in' and the radius with real inbound messages for
   exactly that reason. */
.dh-greeting {
  align-self: flex-start;
  max-width: 85%;
  margin: 0 calc(var(--dh-space) * 3) calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  border-radius: var(--dh-radius);
  background: var(--dh-bubble-in);
  color: var(--dh-text);
  font-size: 14px;
  line-height: 1.5;
  /* Merchant free text, so a long unbroken string must not widen the panel. */
  overflow-wrap: anywhere;
}
/* The report-an-issue form. Reuses '.dh-form*' wholesale — it is the fourth
   form in the same surface slot, so it should look like the other three
   rather than like a new screen. Only the multi-line field needs anything of
   its own. */
.dh-report-details { min-height: 84px; resize: vertical; font: inherit; }
.dh-form-done { padding: calc(var(--dh-space) * 2) 0; }

/* The whole-panel "chat is unavailable" state. Centred and generous because
   it replaces the conversation rather than annotating it — a dense error box
   in the corner of an otherwise-normal panel reads as a warning somebody can
   ignore, and the point here is that there is nothing else to do. */
.dh-unavail {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 6) calc(var(--dh-space) * 5);
  text-align: center;
  background: var(--dh-surface);
}
.dh-unavail-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px; height: 56px;
  border-radius: 999px;
  /* Tinted from the danger colour rather than a fixed pink, so it still reads
     as a warning under a merchant's dark theme. */
  background: color-mix(in srgb, var(--dh-danger) 12%, transparent);
  color: var(--dh-danger);
}
.dh-unavail-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dh-text); }
.dh-unavail-body {
  margin: 0;
  max-width: 34ch;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--dh-text-muted);
}
.dh-unavail-retry {
  margin-top: calc(var(--dh-space) * 1);
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 5);
  border: 0;
  border-radius: var(--dh-radius);
  background: var(--dh-accent);
  color: var(--dh-on-accent, #fff);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.dh-unavail-retry:disabled { opacity: 0.6; cursor: default; }
.dh-unavail-retry:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: 2px; }
.dh-unavail-email {
  color: var(--dh-accent);
  font-size: 13.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}
.dh-unavail-email:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: 2px; }

/* The conversation header's overflow menu. Anchored to its own toggle rather
   than to the header, so it stays put when the title beside it changes length. */
.dh-hmenu-wrap { position: relative; flex: none; }
.dh-hmenu {
  position: absolute;
  top: calc(100% + 6px);
  inset-inline-end: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  min-width: 216px;
  padding: calc(var(--dh-space) * 0.75);
  border: 1px solid var(--dh-border);
  border-radius: 14px;
  background: var(--dh-surface);
  box-shadow: var(--dh-shadow);
}
.dh-hmenu-item {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 1.75) calc(var(--dh-space) * 2);
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dh-text);
  font: inherit;
  font-size: 14px;
  text-align: start;
  text-decoration: none;
  cursor: pointer;
}
.dh-hmenu-item:hover { background: var(--dh-surface-sunken); }
.dh-hmenu-item:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: -2px; }
.dh-hmenu-glyph { display: flex; }
/* The one item with a consequence the customer cannot undo. Colour is not the
   only signal — it also confirms before acting — but it is the one that lands
   before the tap rather than after. */
.dh-hmenu-danger { color: var(--dh-danger); }
.dh-hmenu-danger:hover { background: color-mix(in srgb, var(--dh-danger) 10%, transparent); }
/* The header sits on the accent under the hero design, where the panel's own
   text colours would vanish. The menu is a surface in its own right, so it
   keeps them — but the TOGGLE belongs to the header and inherits from it. */
:host([data-design="hero"]) .dh-hmenu-toggle { color: inherit; opacity: 0.85; }

/* Per-message actions. Hidden until the row is hovered or something inside it
   has focus, so a transcript at rest is text rather than a column of buttons —
   but ALWAYS present for keyboard and touch, which have no hover: 'opacity' is
   what is animated, never 'display', so the control stays in the tab order and
   in the accessibility tree at all times. */
.dh-msg { position: relative; }
.dh-msg-actions { position: absolute; top: 2px; inset-inline-end: 2px; }
.dh-msg-more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px; height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dh-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease;
}
.dh-msg:hover .dh-msg-more,
.dh-msg-more:focus-visible,
.dh-msg-actions:focus-within .dh-msg-more,
.dh-msg-more[aria-expanded="true"] { opacity: 1; }
/* Coarse pointers get no hover event at all, so the control would be
   permanently invisible and permanently tappable — the worst combination. */
@media (hover: none) { .dh-msg-more { opacity: 1; } }
.dh-msg-more:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: 1px; }

.dh-msg-menu {
  position: absolute;
  top: 26px;
  inset-inline-end: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-width: 132px;
  padding: calc(var(--dh-space) * 0.75);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface);
  box-shadow: var(--dh-shadow);
}
.dh-msg-action {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 1.5);
  padding: calc(var(--dh-space) * 1.25) calc(var(--dh-space) * 1.5);
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dh-text);
  font: inherit;
  font-size: 13px;
  text-align: start;
  cursor: pointer;
}
.dh-msg-action:hover { background: var(--dh-bubble-in); }
.dh-msg-action:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: -2px; }
/* Copy's in-place confirmation (message-actions.ts): the label swaps to the
   outcome and the menu lingers just long enough to show it. Colour says which
   outcome at a glance; the swapped word is what a screen reader gets. */
.dh-msg-action[data-outcome="ok"] { color: var(--dh-accent); font-weight: 600; }
.dh-msg-action[data-outcome="failed"] { color: var(--dh-danger); }
.dh-msg-action:disabled { cursor: default; }

/* The quoted message above the composer while a reply is being written. */
.dh-reply-chip {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 1.5);
  margin-bottom: calc(var(--dh-space) * 1.5);
  padding: calc(var(--dh-space) * 1.25) calc(var(--dh-space) * 2);
  border-inline-start: 3px solid var(--dh-accent);
  border-radius: 6px;
  background: var(--dh-bubble-in);
  font-size: 12px;
}
/* Two stacked lines: WHO on top in the accent (it is the reply mechanism's
   own colour — the quote block in the bubbles uses the same cue), their words
   below, one line, ellipsised. */
.dh-reply-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dh-reply-name { font-weight: 600; color: var(--dh-accent); }
.dh-reply-excerpt {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dh-text-muted);
}
.dh-reply-clear {
  flex: none;
  display: flex;
  padding: 2px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dh-text-muted);
  cursor: pointer;
}
.dh-reply-clear:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: 1px; }

/* The quoted message inside a bubble that replies to another — both
   directions. Quiet on purpose: smaller than the message's own words, a thin
   accent bar instead of a boxed panel, two lines at most. On the customer's
   own bubble the ground is the accent itself, so the bar and text shift to
   translucent '--dh-accent-text' — the same trick '.dh-failure' uses for its
   own on-accent legibility. */
.dh-msg-quote {
  display: block;
  margin-bottom: calc(var(--dh-space) * 1);
  padding-inline-start: calc(var(--dh-space) * 1.5);
  border-inline-start: 2px solid var(--dh-accent);
  font-size: 12px;
  line-height: 1.35;
  color: var(--dh-text-muted);
}
.dh-quote-name { display: block; font-weight: 600; }
.dh-quote-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.dh-msg[data-mine="true"] .dh-msg-quote {
  border-inline-start-color: color-mix(in srgb, var(--dh-accent-text) 55%, transparent);
  color: color-mix(in srgb, var(--dh-accent-text) 85%, transparent);
}

/* Links inside message text. Underlined, not colour-only: WCAG 1.4.1, and on
   a merchant accent that happens to sit close to the bubble's own text colour
   a colour-only link is invisible. Inherits the bubble's colour so it reads
   correctly on both the inbound and outbound surfaces. */
.dh-link {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}
.dh-link:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: 2px; }

/* The bot's own suggested follow-ups (metadata.options). Outlined rather
   than filled: they sit directly under the bot's last bubble, and solid chips
   there read as the bot having sent four more messages. Wraps rather than
   scrolls horizontally — a suggestion off the edge of a phone screen is one
   nobody takes. */
.dh-quick-replies {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--dh-space) * 1.5);
  align-self: flex-start;
  max-width: 100%;
  padding: 0 calc(var(--dh-space) * 3) calc(var(--dh-space) * 2);
}
.dh-quick-reply {
  padding: calc(var(--dh-space) * 1.25) calc(var(--dh-space) * 2.5);
  border: 1px solid var(--dh-accent);
  border-radius: 999px;
  background: transparent;
  color: var(--dh-accent);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.dh-quick-reply:hover { background: color-mix(in srgb, var(--dh-accent) 10%, transparent); }
.dh-quick-reply:focus-visible { outline: 2px solid var(--dh-focus); outline-offset: 2px; }

/* 'behaviour.typingIndicator: false'. 'display: none' rather than
   'visibility: hidden' on purpose — it takes the screen-reader label out of
   the accessibility tree along with the dots, and a merchant who turned the
   indicator off did not mean "keep announcing it to some people". */
:host([data-typing="off"]) .dh-typing { display: none; }
.dh-typing[hidden] { display: none; }
.dh-typing-dot {
  width: 6px; height: 6px;
  border-radius: 999px;
  background: var(--dh-text-muted);
  animation: dh-bounce 1.2s infinite ease-in-out;
}
.dh-typing-dot:nth-child(2) { animation-delay: 0.15s; }
.dh-typing-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes dh-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-3px); opacity: 1; }
}

/* ── Composer ─────────────────────────────────────────────────────────── */

.dh-composer {
  flex: none;
  border-top: 1px solid var(--dh-border);
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  /* Keeps the composer clear of the iOS home indicator in sheet mode. */
  padding-bottom: max(calc(var(--dh-space) * 2), env(safe-area-inset-bottom));
  background: var(--dh-surface);
}
/* The bordered box the reference nests image/emoji/attach/link inside of —
   see composer.ts's own comment at the call site. The border and background
   that .dh-input used to carry itself now live here, one level up, so the
   textarea and the icon row read as one control rather than a text field
   with buttons floating beside it. */
.dh-composer-box {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dh-border);
  border-radius: 14px;
  background: var(--dh-surface-sunken);
}
.dh-composer-box:focus-within { border-color: var(--dh-accent); }

.dh-composer-row {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space));
  padding: 0 calc(var(--dh-space) * 1.5) calc(var(--dh-space) * 1.5);
}
/* The platform credit. Muted and small on purpose: it is the least important
   thing in the panel, and a footer that competes with the composer above it
   has misunderstood its job. */
.dh-branding {
  flex: none;
  padding: calc(var(--dh-space)) calc(var(--dh-space) * 3);
  padding-bottom: max(var(--dh-space), env(safe-area-inset-bottom));
  background: var(--dh-surface);
  font-size: 11px;
  text-align: center;
  color: var(--dh-text-muted);
}
/* The safe-area clearance belongs to whichever element is actually last. With
   a credit below it the composer would otherwise reserve room for the iOS
   home indicator that the credit then reserves again, leaving a visible gap
   between the two.

   The second selector in each pair exists only because '.dh-ended-footer'
   now sits between the composer and the credit in the DOM (see widget.ts) —
   ':has(+ …)' matches the immediate next sibling regardless of '[hidden]',
   so without it a HIDDEN ended-footer would still break the adjacency the
   first selector relies on, and the composer would double up on safe-area
   padding with the credit every time both happen to be mounted. */
.dh-composer:has(+ .dh-branding:not([hidden])),
.dh-composer:has(+ .dh-ended-footer + .dh-branding:not([hidden])) {
  padding-bottom: calc(var(--dh-space) * 2);
}
.dh-ended-footer:has(+ .dh-branding:not([hidden])) {
  padding-bottom: calc(var(--dh-space) * 2);
}
.dh-branding-link {
  color: inherit;
  text-decoration: none;
}
.dh-branding-link:hover { text-decoration: underline; }
.dh-branding-link:focus-visible {
  outline: 2px solid var(--dh-focus);
  outline-offset: 2px;
  border-radius: 2px;
}

/* ── Ended-conversation footer (ui/ended-footer.ts) ───────────────────────

   Trades places with .dh-composer directly above it — same seam, same
   'flex: none' rationale that comment states, and the same safe-area
   handling (see the ':has()' pair above .dh-branding-link). widget.ts's
   syncScreens is the one place that decides which of the two is visible;
   this file only has to make sure hiding it actually hides it, which
   'display: flex' below requires spelling out for '[hidden]' explicitly —
   same reason .dh-report-open[hidden] and .dh-topics[hidden] both exist. */
.dh-ended-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 2);
  border-top: 1px solid var(--dh-border);
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  padding-bottom: max(calc(var(--dh-space) * 2), env(safe-area-inset-bottom));
  background: var(--dh-surface);
}
.dh-ended-footer[hidden] { display: none; }
.dh-ended-actions {
  display: flex;
  gap: calc(var(--dh-space) * 2);
}
/* The primary action reuses .dh-form-submit itself (see ui/ended-footer.ts) —
   same accent-filled button the three data-collecting surfaces already use
   for their one commit action, just placed two-up in a row instead of full
   width. Only the secondary action is new, and it borrows .dh-report-open's own
   outline treatment (accent border, transparent fill) rather than inventing
   a second "secondary button" look. */
.dh-ended-footer .dh-form-submit { flex: 1; }
.dh-ended-secondary {
  flex: 1;
  min-height: 44px;
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  border-radius: 10px;
  border: 1px solid var(--dh-accent);
  background: transparent;
  color: var(--dh-accent);
  font: inherit;
  font-weight: 600;
  font-size: 14px;
}
.dh-ended-secondary:hover { background: var(--dh-surface-sunken); }
.dh-ended-secondary[disabled] { opacity: 0.6; cursor: not-allowed; }

/* The slot a product surface occupies — same "stands in for the conversation"
   role as .dh-prechat, so it takes the same remaining height. */
.dh-surface-host { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow-y: auto; }

/* ── Data-collecting surfaces: pre-chat, out-of-hours, CSAT ────────────── */
.dh-form {
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 4);
  overflow-y: auto;
}
.dh-form-heading { font-size: 15px; font-weight: 600; color: var(--dh-text); margin: 0; }
.dh-form-subtitle { font-size: 13px; line-height: 1.5; color: var(--dh-text-muted); margin: 0; }
.dh-field { display: flex; flex-direction: column; gap: calc(var(--dh-space)); }
.dh-field-label { font-size: 12px; font-weight: 500; color: var(--dh-text-muted); }
.dh-field-optional { font-weight: 400; opacity: 0.75; }
.dh-field-input {
  width: 100%;
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: 10px;
  background: var(--dh-surface-sunken);
  color: var(--dh-text);
  font: inherit;
  /* 16px on touch, same reason as .dh-input: anything smaller makes iOS
     Safari zoom the whole page on focus. */
  font-size: 16px;
}
.dh-field-input:focus-visible { border-color: var(--dh-accent); }
.dh-offline-message { resize: none; }
.dh-form-error { font-size: 12.5px; color: var(--dh-danger, #b91c1c); margin: 0; }
.dh-form-error[hidden] { display: none; }
.dh-form-submit {
  min-height: 44px;
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 4);
  border-radius: 10px;
  background: var(--dh-accent);
  color: var(--dh-on-accent, #fff);
  font: inherit;
  font-weight: 600;
}
.dh-form-submit[disabled] { opacity: 0.6; cursor: not-allowed; }
.dh-form-skip {
  min-height: 36px;
  color: var(--dh-text-muted);
  font: inherit;
  font-size: 12.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.dh-offline, .dh-webform { display: flex; flex-direction: column; min-height: 0; flex: 1; }

/* Row 2's "Try live chat anyway", inside the web-form surface. Matches
   .dh-form-skip's look without sharing its class — the Cancel button beside
   it also carries .dh-form-skip, and the two can be on screen together (see
   ui/webform-form.ts's own comment), so sharing a class here would break
   .dh-form-skip's "the one Cancel/Skip control" meaning within this form. */
.dh-webform-alt {
  min-height: 36px;
  color: var(--dh-text-muted);
  font: inherit;
  font-size: 12.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.dh-offline-banner {
  display: flex;
  flex-direction: column;
  gap: var(--dh-space);
  padding: calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface-sunken);
}
.dh-offline-sent {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--dh-space);
  padding: calc(var(--dh-space) * 8);
  text-align: center;
}
.dh-offline-sent[hidden], .dh-csat-thanks[hidden], .dh-csat-comment[hidden] { display: none; }
.dh-csat-your-comment[hidden] { display: none; }

.dh-csat-card { padding: calc(var(--dh-space) * 2); }
.dh-csat-scale { display: flex; justify-content: center; gap: var(--dh-space); }
.dh-csat-option {
  /* 44px: the same touch target every other control in this widget uses. */
  width: 44px; height: 44px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  font-size: 22px;
  line-height: 1;
}
.dh-csat-option:hover { background: var(--dh-surface-sunken); }
.dh-csat-stars .dh-csat-option { color: var(--dh-border); }
.dh-csat-stars .dh-csat-lit { color: var(--dh-accent); }
/* Emoji cannot be recoloured, so the unchosen faces recede by desaturating
   rather than by changing colour. */
.dh-csat-emoji .dh-csat-option { filter: grayscale(1); opacity: 0.45; }
.dh-csat-emoji .dh-csat-lit { filter: none; opacity: 1; }
.dh-csat-label {
  min-height: 16px;
  margin: 0;
  text-align: center;
  font-size: 11.5px;
  color: var(--dh-text-muted);
}
.dh-csat-comment { display: flex; flex-direction: column; gap: calc(var(--dh-space) * 2); }
/* The comment on an already-rated session, as text rather than in a field —
   see ui/csat.ts's locked card. Quoted so it reads as something the customer
   said, not as a prompt asking them to say it again. */
.dh-csat-your-comment {
  margin: 0;
  padding: calc(var(--dh-space) * 2);
  border-radius: var(--dh-radius);
  background: var(--dh-surface-sunken);
  color: var(--dh-text-muted);
  font-size: 12.5px;
  font-style: italic;
}
/* Locked: the scale is a read-out, so nothing under the pointer should promise
   it can be changed. */
.dh-csat-card[data-locked] .dh-csat-option { cursor: default; }
.dh-csat-thanks {
  margin: 0;
  padding: calc(var(--dh-space) * 4);
  border-radius: var(--dh-radius);
  text-align: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--dh-text);
  background: var(--dh-surface-sunken);
}

/* The emoji picker: same self-contained wrapper shape as .dh-switcher —
   position: relative on the wrapper, so the popover anchors to the trigger
   wherever the composer row places it. Opens UPWARD (bottom: 100%) because the
   composer already sits at the bottom of the panel. */
.dh-emoji { position: relative; display: inline-flex; }
.dh-emoji-glyph { font-size: 18px; line-height: 1; }
.dh-emoji-popover {
  position: absolute;
  bottom: calc(100% + var(--dh-space) * 2);
  inset-inline-start: 0;
  z-index: 3;
  padding: calc(var(--dh-space) * 2);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface);
  box-shadow: var(--dh-shadow);
}
.dh-emoji-popover[hidden] { display: none; }
.dh-emoji-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}
.dh-emoji-cell {
  width: 30px; height: 30px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  font-size: 17px;
  line-height: 1;
}
.dh-emoji-cell:hover { background: var(--dh-surface-sunken); }

/* Border and background now belong to .dh-composer-box, one level up — see
   that rule's own comment. This is the plain text surface inside it. */
.dh-input {
  width: 100%;
  min-height: 38px;
  max-height: 120px;
  resize: none;
  border: 0;
  background: transparent;
  padding: calc(var(--dh-space) * 2.5) calc(var(--dh-space) * 3) calc(var(--dh-space) * 1);
  color: var(--dh-text);
  font: inherit;
  /* 16px on touch: anything smaller makes iOS Safari zoom the whole page on
     focus, which on a food-ordering checkout is actively destructive. */
  font-size: 16px;
}
@media (pointer: fine) { .dh-input { font-size: 14px; } }
.dh-input::placeholder { color: var(--dh-text-muted); opacity: 1; }
.dh-input:disabled { opacity: 0.6; cursor: not-allowed; }
/* The box already shows focus via :focus-within; a second ring on the
   textarea itself would double it up. */
.dh-input:focus { outline: none; }

.dh-send {
  width: 38px; height: 38px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--dh-accent);
  color: var(--dh-accent-text);
  /* Attach/emoji/mic/link read as one cluster on the left of the icon row;
     this pushes Send alone to the right, the same grouping the reference
     draws. */
  margin-inline-start: auto;
}
.dh-send[disabled] { opacity: 0.4; cursor: not-allowed; }

.dh-preview {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  margin-bottom: calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 2);
  border: 1px solid var(--dh-border);
  border-radius: 10px;
  background: var(--dh-surface-sunken);
  font-size: 13px;
}
.dh-preview[hidden] { display: none; }
.dh-preview-thumb {
  width: 40px; height: 40px;
  border-radius: 6px;
  object-fit: cover;
  flex: none;
}
.dh-preview-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dh-preview-size { color: var(--dh-text-muted); font-size: 12px; flex: none; }

.dh-recording {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.dh-recording[hidden] { display: none; }
.dh-level {
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: var(--dh-border);
  overflow: hidden;
}
.dh-level-fill {
  height: 100%;
  width: 0%;
  background: var(--dh-danger);
  transition: width 80ms linear;
}

.dh-error {
  margin-bottom: calc(var(--dh-space) * 2);
  padding: calc(var(--dh-space) * 2);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dh-danger) 12%, transparent);
  color: var(--dh-danger);
  font-size: 12px;
}
.dh-error[hidden] { display: none; }

.dh-file { display: none; }

/* ── Bottom navigation: Home / Messages (ui/nav.ts) ──────────────────────

   flex: none for the same reason .dh-composer has it: exactly one element in
   the panel column is allowed to absorb spare height, and this bar is never
   it. Sits below whichever screen is showing, same physical position the
   composer used to be the last word on. */
.dh-nav {
  flex: none;
  display: flex;
  border-top: 1px solid var(--dh-border);
  background: var(--dh-surface);
  padding-bottom: env(safe-area-inset-bottom);
}
.dh-nav-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: calc(var(--dh-space) * 2) 0;
  color: var(--dh-text-muted);
}
.dh-nav-tab[aria-selected="true"] { color: var(--dh-accent); }
/* The divider between the two tabs. Without it, two equal-width 'flex: 1'
   columns under one 'border-top' read as a single wide control rather than as
   a choice of two — the accented colour on the selected one is the only thing
   saying otherwise, and colour alone is not a boundary.

   'border-inline-start' rather than 'border-left': this sheet is RTL-aware
   (see '.dh-hero-avatar's 'margin-inline-start' and '.dh-nav-badge's
   'inset-inline-end'), and in an RTL locale Messages is the tab on the left,
   so the line belongs on its other physical side.

   On the ADJACENT-SIBLING pair, so only the inner edge is drawn — the same
   declaration on '.dh-nav-tab' itself would put a second line down the
   panel's own left wall. And ungated by 'data-design', unlike the brand band
   above: the tabs run together on every design, so the fix belongs to every
   design. It is decoration only — 'ui/nav.ts' draws no element and no text
   node between the tabs, because a border adds nothing to the accessibility
   tree and a spacer element would. */
.dh-nav-tab + .dh-nav-tab { border-inline-start: 1px solid var(--dh-border); }
.dh-nav-icon { position: relative; display: inline-flex; }
.dh-nav-label { font-size: 11px; font-weight: 500; }
/* Same red-pill treatment as .dh-session-unread and .dh-messages-unread --
   one "you have not seen this" language across the whole widget. */
.dh-nav-badge {
  position: absolute;
  top: -4px;
  inset-inline-end: -8px;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--dh-danger);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

/* ── Home screen (ui/home-screen.ts) ──────────────────────────────────────

   flex: 1 + overflow-y: auto — the one child of .dh-panel's column allowed
   to grow and scroll while this screen is showing, same role .dh-prechat and
   .dh-surface-host already play for the screens they stand in for. */
.dh-home {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 5);
  padding: calc(var(--dh-space) * 4);
  /* The containing block '.dh-hero-sentinel' (ui/styles.ts, further down)
     positions itself against — see ui/hero-header.ts's 'watchScroll' for why
     that marker has to be a zero-space absolute child of THIS element rather
     than a normal flow one. */
  position: relative;
}

.dh-home-cta {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 3);
  width: 100%;
  padding: calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface);
  color: var(--dh-text);
  text-align: start;
  box-shadow: var(--dh-shadow);
}
.dh-home-cta:hover { background: var(--dh-surface-sunken); }
.dh-home-cta-icon {
  width: 36px;
  height: 36px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--dh-accent);
  color: var(--dh-accent-text);
}
.dh-home-cta-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dh-home-cta-title { font-size: 14px; font-weight: 600; }
.dh-home-cta-sub { font-size: 12px; color: var(--dh-text-muted); }
.dh-home-cta-sub[hidden] { display: none; }
.dh-home-chevron { flex: none; font-size: 20px; line-height: 1; color: var(--dh-text-muted); }

/* The chooser's alt affordance — Row 1's "Leave a message instead" or Row
   2's "Try live chat anyway". Matches .dh-form-skip's LOOK (same rule, same
   values) without sharing its class — see ui/home-screen.ts's own comment on
   why: this button lives on Home, permanently in the DOM, so sharing a class
   that every form's Skip/Cancel button also uses broke that class's
   uniqueness within whichever surface was actually open. */
.dh-home-alt {
  align-self: flex-start;
  margin-top: calc(var(--dh-space) * -3);
  min-height: 36px;
  color: var(--dh-text-muted);
  font: inherit;
  font-size: 12.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.dh-home-alt[hidden] { display: none; }

/* The mid-visit chat→ticket announcement, above the CTA. role="status", not
   alert — see ui/home-screen.ts's own comment on why. */
.dh-entry-note { margin: 0; font-size: 12.5px; color: var(--dh-text-muted); }
.dh-entry-note[hidden] { display: none; }

.dh-home-section { display: flex; flex-direction: column; gap: calc(var(--dh-space) * 2); }
.dh-home-section-head { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--dh-space) * 2); }
.dh-home-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--dh-text-muted);
}
.dh-home-seeall { font-size: 12.5px; font-weight: 600; color: var(--dh-accent); }
.dh-home-seeall:hover { text-decoration: underline; }

.dh-home-recent-row {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  width: 100%;
  padding: calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface);
  text-align: start;
}
.dh-home-recent-row:hover { background: var(--dh-surface-sunken); }
.dh-home-recent-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dh-home-recent-head { display: flex; align-items: center; gap: calc(var(--dh-space) * 2); }
.dh-home-recent-title {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Same neutral pill as .dh-session-status, ON_HOLD's amber included --
   see that rule's own comment on why a terminal status is not dimmed. */
.dh-home-recent-status {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  padding: 2px calc(var(--dh-space) * 2);
  border-radius: 999px;
  background: var(--dh-surface-sunken);
  color: var(--dh-text-muted);
}
.dh-home-recent-status[data-status="ON_HOLD"] { color: #c98a00; }
.dh-home-recent-preview {
  font-size: 12.5px;
  color: var(--dh-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dh-home-recent-preview[hidden] { display: none; }
.dh-home-recent-time { font-size: 11px; color: var(--dh-text-muted); font-variant-numeric: tabular-nums; }

/* ── Messages screen (ui/messages-screen.ts) ──────────────────────────────

   Row styling deliberately mirrors .dh-session-row rather than sharing its
   selector — see messages-screen.ts's own header on why this is a fresh
   component rather than session-picker.ts's row factory reused, and why
   duplicating a few small rules here is the safer trade against editing an
   already-shipped block those tests already pin.

   ── Why the scroll boundary is NOT here any more ─────────────────────────

   This element used to carry 'overflow-y: auto' directly, with the search
   box, the row list AND the "New conversation" button all as its normal-flow
   children. That made the button "flex: none" — which stops it from being
   squished, and nothing else — but it was still an ordinary child of the one
   box that scrolled, so it scrolled away with the rows exactly like every
   row above it. Confirmed live: scrolling the row list carried the button
   off the bottom of the panel with it, which is the reported bug ("has to
   scroll to find it").
   'flex: none' only ever meant "don't grow or shrink"; it was never a
   pinning declaration, and nothing else in this rule made it one.

   The fix moves the scrollable region down one level, onto
   '.dh-messages-list' alone (below) — search and the button stay here, in
   this NON-scrolling flex column, so they never move regardless of how long
   the row list gets. This element keeps 'flex: 1; min-height: 0' because it
   is still the one child of '.dh-panel's screen column allowed to grow into
   the space Home/the transcript would otherwise use — see '.dh-home's
   identical pair, just above, for the same contract with the SAME ancestor. */
.dh-messages {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 3);
  padding: calc(var(--dh-space) * 4);
}

.dh-messages-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  padding: 0 calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: 10px;
  background: var(--dh-surface-sunken);
}
.dh-messages-search-icon { flex: none; display: flex; color: var(--dh-text-muted); }
.dh-messages-search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: calc(var(--dh-space) * 2.5) 0;
  color: var(--dh-text);
  font: inherit;
  /* 16px on touch, same reason .dh-input has it: anything smaller makes iOS
     Safari zoom the page on focus. */
  font-size: 16px;
}
@media (pointer: fine) { .dh-messages-search-input { font-size: 14px; } }
.dh-messages-search-input:focus { outline: none; }
.dh-messages-search-input::placeholder { color: var(--dh-text-muted); opacity: 1; }
/* The browser's own search decorations (a native clear button in Chrome, an
   extra icon slot in Safari) would sit beside this widget's own icon and
   disagree with it about where "clear" lives. Removed so there is exactly
   one affordance. */
.dh-messages-search-input::-webkit-search-cancel-button,
.dh-messages-search-input::-webkit-search-decoration {
  -webkit-appearance: none;
  appearance: none;
}

/* The ACTUAL scroll region, moved here from '.dh-messages' above (see that
   rule's comment for why). 'flex: 1; min-height: 0' claims whatever height
   '.dh-messages-search' and '.dh-messages-new' — both 'flex: none' — leave
   behind in the parent's column, and 'overflow-y: auto' scrolls exactly that
   claimed space. Search stays above it and the button stays below it as
   plain siblings, so neither one is ever a child of the box that scrolls and
   neither can be carried off screen by it. */
.dh-messages-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 2);
}
.dh-messages-empty {
  text-align: center;
  color: var(--dh-text-muted);
  font-size: 13px;
  padding: calc(var(--dh-space) * 6) 0;
}
.dh-messages-empty[hidden] { display: none; }

.dh-messages-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: calc(var(--dh-space));
  padding: calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface);
  text-align: start;
}
.dh-messages-row:hover { background: var(--dh-surface-sunken); }
.dh-messages-row[aria-current="true"] { border-color: var(--dh-accent); }
.dh-messages-row-top { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--dh-space) * 2); }
.dh-messages-status {
  font-size: 11px;
  font-weight: 600;
  padding: 2px calc(var(--dh-space) * 2);
  border-radius: 999px;
  background: var(--dh-surface-sunken);
  color: var(--dh-text-muted);
}
.dh-messages-item[data-status="ON_HOLD"] .dh-messages-status { color: #c98a00; }
.dh-messages-time {
  font-size: 11px;
  color: var(--dh-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dh-messages-preview {
  font-size: 13px;
  color: var(--dh-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dh-messages-preview[hidden] { display: none; }
.dh-messages-unread {
  align-self: flex-start;
  min-width: 16px;
  padding: 1px calc(var(--dh-space) * 1.5);
  border-radius: 999px;
  background: var(--dh-danger);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
}
.dh-messages-unread[hidden] { display: none; }

.dh-messages-new {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: calc(var(--dh-space) * 2);
  min-height: 44px;
  padding: calc(var(--dh-space) * 3);
  border-radius: 10px;
  background: var(--dh-accent);
  color: var(--dh-accent-text);
  font-size: 14px;
  font-weight: 600;
}
.dh-messages-new[disabled] { opacity: 0.6; cursor: not-allowed; }

/* ── New conversation (ui/new-conversation.ts) ────────────────────────────

   Mounted as a product surface inside .dh-surface-host, so it inherits that
   host's flex: 1 and scroll — see .dh-surface-host's own rule above. Only
   the two pieces this screen adds beyond the shared .dh-form/.dh-field
   primitives (already styled under "Data-collecting surfaces") need rules
   of their own. */
.dh-topics { display: flex; flex-wrap: wrap; gap: calc(var(--dh-space) * 1.5); }
.dh-topics[hidden] { display: none; }
.dh-topic-chip {
  flex: none;
  padding: calc(var(--dh-space) * 1.5) calc(var(--dh-space) * 3);
  border-radius: 999px;
  border: 1px solid var(--dh-border);
  background: var(--dh-surface);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--dh-text);
}
.dh-topic-chip:hover { background: var(--dh-surface-sunken); }
/* The selected chip -- aria-pressed carries the same state to a screen
   reader, so this is decoration layered on top of an already-accessible
   fact rather than the only place the state lives. */
.dh-topic-chip[aria-pressed="true"] {
  border-color: var(--dh-accent);
  background: color-mix(in srgb, var(--dh-accent) 12%, transparent);
  color: var(--dh-accent);
  font-weight: 600;
}
.dh-newconvo-message { min-height: 84px; resize: vertical; font: inherit; }
/* ── New conversation, pre-chat fields folded in (ui/new-conversation.ts) ──

   The console's pre-chat fields render on this screen through the shared
   .dh-field primitives above, so nothing new is needed for them. The one
   addition is the row the two actions share: .dh-form-actions had no rule of
   its own and stacked as a plain block, which put Cancel on its own line under
   a full-width Start with nothing aligning the two. */
.dh-form-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--dh-space) * 2);
}
.dh-form-actions .dh-form-submit { flex: 1; }

/* ── End-conversation confirm (ui/end-conversation.ts) ──────────────────────

   Mounted as a product surface inside .dh-surface-host like the forms above.
   The destructive button keeps .dh-form-submit's size and busy treatment and
   swaps only its colour for the same --dh-danger token .dh-hmenu-danger (the
   menu item that opened this) already uses, so the tap that asked and the tap
   that commits read as one act. "Keep chatting" borrows .dh-ended-secondary's
   outline look rather than inventing a third secondary style — but in the
   surface's own text colour, not the accent: beside a red button, an
   accent-coloured outline reads as "the other thing you might want" when it
   is in fact the way out. */
.dh-confirm-end-actions {
  display: flex;
  gap: calc(var(--dh-space) * 2);
}
.dh-confirm-end-actions .dh-form-submit { flex: 1; }
.dh-confirm-end-danger { background: var(--dh-danger); color: #fff; }
.dh-confirm-end-danger:hover:not([disabled]) {
  background: color-mix(in srgb, var(--dh-danger) 88%, #000);
}
.dh-confirm-end-keep {
  flex: 1;
  min-height: 44px;
  padding: calc(var(--dh-space) * 2) calc(var(--dh-space) * 3);
  border-radius: 10px;
  border: 1px solid var(--dh-border);
  background: transparent;
  color: var(--dh-text);
  font: inherit;
  font-weight: 600;
  font-size: 14px;
}
.dh-confirm-end-keep:hover { background: var(--dh-surface-sunken); }
.dh-confirm-end-keep[disabled] { opacity: 0.6; cursor: not-allowed; }

/* ── Link popover (ui/composer.ts) ─────────────────────────────────────────

   The in-widget replacement for the window.prompt the link button used to
   open. Anchored to .dh-composer-box rather than to its trigger the way
   .dh-emoji-popover is: a field plus two buttons is far wider than an icon
   grid, and pinned to the fourth icon in the row it would run off one edge
   or the other of a 384px panel. Spanning the box's own width keeps it inside
   the widget at every size. Opens UPWARD for the same reason the emoji
   popover does — the composer already sits at the bottom of the panel. The
   box gets its positioning context here, beside the one rule that needs it. */
.dh-composer-box { position: relative; }
.dh-link-popover {
  position: absolute;
  bottom: calc(100% + var(--dh-space) * 2);
  inset-inline: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 2);
  margin: 0;
  padding: calc(var(--dh-space) * 3);
  border: 1px solid var(--dh-border);
  border-radius: var(--dh-radius);
  background: var(--dh-surface);
  box-shadow: var(--dh-shadow);
}
.dh-link-popover[hidden] { display: none; }
/* The field and its error line reuse .dh-field-input / .dh-form-error from
   the data-collecting surfaces above; only the label wrapper and the two
   actions are new. The field follows .dh-input's pointer-driven size so it
   matches the textarea it floats over. */
.dh-link-label {
  display: flex;
  flex-direction: column;
  gap: var(--dh-space);
  font-size: 12px;
  font-weight: 500;
  color: var(--dh-text-muted);
}
@media (pointer: fine) { .dh-link-input { font-size: 14px; } }
.dh-link-input[aria-invalid="true"] { border-color: var(--dh-danger); }
.dh-link-actions {
  display: flex;
  justify-content: flex-end;
  gap: calc(var(--dh-space) * 2);
}
/* Two-up in a popover, so both actions drop from the form surfaces' 44px to
   36px — the same height .dh-form-skip uses for a secondary action. */
.dh-link-actions .dh-form-submit {
  min-height: 36px;
  padding: calc(var(--dh-space) * 1.5) calc(var(--dh-space) * 3);
  font-size: 13px;
}
.dh-link-cancel {
  min-height: 36px;
  padding: calc(var(--dh-space) * 1.5) calc(var(--dh-space) * 3);
  border-radius: 10px;
  border: 1px solid var(--dh-border);
  background: transparent;
  color: var(--dh-text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
}
.dh-link-cancel:hover { background: var(--dh-surface-sunken); }

/* ── Dhaam UI: Messages Screen Redesign ────────────────────────────────────
   New design: Customers/Merchants tabs + new conversation card layout
   (avatar circle · name · status pill · unread badge · preview · timestamp · chevron)
   ───────────────────────────────────────────────────────────────────────── */

/* Tab bar */
.dh-mtab-bar {
  flex: none;
  display: flex;
  border-bottom: 1.5px solid var(--dh-border);
  margin-bottom: calc(var(--dh-space) * -1);
}
.dh-mtab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: calc(var(--dh-space) * 1.5);
  padding: calc(var(--dh-space) * 3) 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--dh-text-muted);
  border: 0;
  background: transparent;
  border-bottom: 2px solid transparent;
  margin-bottom: -1.5px;
  transition: color 120ms ease, border-color 120ms ease;
  cursor: pointer;
}
.dh-mtab--active {
  color: var(--dh-accent);
  border-bottom-color: var(--dh-accent);
  font-weight: 600;
}
.dh-mtab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  background: var(--dh-surface-sunken);
  color: var(--dh-text-muted);
}
.dh-mtab-count--active {
  background: var(--dh-accent);
  color: #fff;
}

/* Conversation row — new design */
.dh-mrow-item {
  list-style: none;
}
.dh-mrow-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 3);
  padding: calc(var(--dh-space) * 3) calc(var(--dh-space) * 2);
  border: 0;
  border-bottom: 1px solid var(--dh-border);
  background: transparent;
  text-align: start;
  cursor: pointer;
  transition: background 100ms ease;
}
.dh-mrow-btn:hover { background: var(--dh-surface-sunken); }
.dh-mrow-btn[aria-current="true"] { background: color-mix(in srgb, var(--dh-accent) 6%, transparent); }

/* Avatar circle */
.dh-mrow-avatar {
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  background: var(--dh-accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 700;
  text-transform: uppercase;
}

/* Body layout */
.dh-mrow-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: calc(var(--dh-space) * 0.5);
}
.dh-mrow-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--dh-space) * 2);
}
.dh-mrow-name-row {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 2);
  min-width: 0;
  flex: 1;
}
.dh-mrow-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--dh-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Status pill — Open = purple/accent tinted, Closed/Resolved = neutral */
.dh-mrow-status-pill {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  padding: 2px calc(var(--dh-space) * 2);
  border-radius: 999px;
  background: color-mix(in srgb, var(--dh-accent) 14%, transparent);
  color: var(--dh-accent);
}
.dh-mrow-status-pill[data-status="CLOSED"],
.dh-mrow-status-pill[data-status="RESOLVED"] {
  background: var(--dh-surface-sunken);
  color: var(--dh-text-muted);
}
.dh-mrow-status-pill[data-status="ON_HOLD"] {
  background: color-mix(in srgb, #f59e0b 14%, transparent);
  color: #b45309;
}

/* Right column: unread badge + chevron */
.dh-mrow-right {
  display: flex;
  align-items: center;
  gap: calc(var(--dh-space) * 1.5);
  flex: none;
}
/* Unread badge — filled circle like the screenshot */
.dh-mrow-unread-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dh-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}
.dh-mrow-chevron {
  color: var(--dh-text-muted);
  display: flex;
}
/* Preview text */
.dh-mrow-preview {
  font-size: 13px;
  color: var(--dh-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Timestamp */
.dh-mrow-time {
  font-size: 11px;
  color: var(--dh-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ── Dhaam UI: Chat Header Redesign ────────────────────────────────────────
   Purple gradient header: back arrow, avatar circle with initials, name ·
   agent, green online dot, ⋮ menu, × close button.
   Applied when data-design="dhaam-chat" on :host, OR we patch the existing
   hero header rules to show the gradient on the conversation screen too.
/* ── Dhaam UI: Header & Screen Redesigns ─────────────────────────────────────
   Matches exact user designs for both:
   1. Messages screen (Customers/Merchants tabs, Dhaam AI logo, Close button)
   2. Conversation screen (Purple gradient header, online dot, pastel chat background, purple bubbles)
   ───────────────────────────────────────────────────────────────────────── */

/* 1. Header gradient for BOTH conversation and messages screens */
:host([data-screen="conversation"]) .dh-brand-band,
:host([data-screen="conversation"]) .dh-header,
:host([data-screen="messages"]) .dh-brand-band,
:host([data-screen="messages"]) .dh-header {
  background: linear-gradient(135deg, #6d28d9 0%, #7c3aed 50%, #5b21b6 100%) !important;
  color: #fff !important;
  border-bottom-color: transparent !important;
}

/* 2. Messages Screen Header */
:host([data-screen="messages"]) .dh-back,
:host([data-screen="messages"]) .dh-avatar-host,
:host([data-screen="messages"]) .dh-status,
:host([data-screen="messages"]) .dh-reconnect,
:host([data-screen="messages"]) .dh-menu {
  display: none !important;
}
:host([data-screen="messages"]) .dh-title {
  display: flex !important;
  flex-direction: column !important;
  gap: 2px !important;
  color: #fff !important;
  font-size: 0 !important;
  line-height: 1.1 !important;
}
:host([data-screen="messages"]) .dh-title::before {
  content: "Dhaam AI" !important;
  font-size: 18px !important;
  font-weight: 700 !important;
  letter-spacing: -0.01em !important;
  color: #fff !important;
}
:host([data-screen="messages"]) .dh-title::after {
  content: "Lead The Pace With AI Grace" !important;
  font-size: 10px !important;
  font-weight: 400 !important;
  opacity: 0.85 !important;
  color: rgba(255, 255, 255, 0.9) !important;
}
:host([data-screen="messages"]) .dh-icon-button,
:host([data-screen="conversation"]) .dh-icon-button {
  color: #fff !important;
  opacity: 0.95 !important;
}
:host([data-screen="messages"]) .dh-icon-button:hover,
:host([data-screen="conversation"]) .dh-icon-button:hover {
  background: rgba(255, 255, 255, 0.18) !important;
  color: #fff !important;
}

/* 3. Hide bottom navigation bar completely (screens navigate directly) */
.dh-nav {
  display: none !important;
}

/* 4. Conversation Header */
:host([data-screen="conversation"]) .dh-title {
  color: #fff !important;
  font-weight: 600 !important;
}
:host([data-screen="conversation"]) .dh-status {
  color: rgba(255, 255, 255, 0.9) !important;
}
:host([data-screen="conversation"]) .dh-status-dot {
  background: #10b981 !important;
}
:host([data-screen="conversation"]) .dh-avatar {
  border: 2px solid rgba(255, 255, 255, 0.7) !important;
  background: #f59e0b !important;
  color: #78350f !important;
  font-weight: 700 !important;
}

/* 5. Chat thread background: pastel pink-teal gradient (matches screenshot) */
:host([data-screen="conversation"]) .dh-log {
  background-color: #fbf7ff !important;
  background-image:
    radial-gradient(ellipse 85% 65% at 0% 0%, rgba(255, 205, 225, 0.5) 0%, transparent 65%),
    radial-gradient(ellipse 85% 65% at 100% 0%, rgba(255, 235, 200, 0.4) 0%, transparent 65%),
    radial-gradient(ellipse 85% 70% at 0% 100%, rgba(160, 245, 220, 0.45) 0%, transparent 65%),
    radial-gradient(ellipse 90% 75% at 100% 100%, rgba(190, 225, 250, 0.5) 0%, transparent 70%) !important;
  background-size: 100% 100% !important;
  background-repeat: no-repeat !important;
}

/* 6. Outbound message bubble: solid purple */
:host([data-screen="conversation"]) .dh-msg[data-mine="true"] .dh-msg-bubble {
  background: #7c3aed !important;
  color: #fff !important;
  border-radius: 16px 16px 4px 16px !important;
}
:host([data-screen="conversation"]) .dh-msg[data-mine="true"] .dh-msg-time {
  color: rgba(255, 255, 255, 0.8) !important;
}
:host([data-screen="conversation"]) .dh-msg[data-mine="true"] .dh-tick {
  color: #34d399 !important;
}

/* 7. Inbound message bubble: crisp white card */
:host([data-screen="conversation"]) .dh-msg[data-mine="false"] .dh-msg-bubble {
  background: #ffffff !important;
  color: #0f172a !important;
  border-radius: 16px 16px 16px 4px !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.04) !important;
}
:host([data-screen="conversation"]) .dh-msg-avatar {
  background: #f59e0b !important;
  color: #78350f !important;
  font-weight: 700 !important;
}
`;

