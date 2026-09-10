// What a host page is allowed to configure, and the one place a script tag's
// `data-*` attributes become that shape.
//
// ── The shape of this type IS the §14 key split ──────────────────────────
//
// There is no `secretKey` field here, and there is no field that could carry
// one by another name. That is deliberate and it is the primary defence: a
// browser bundle cannot send a credential it has no slot for. The runtime
// checks in auth.ts are the second line, for the case someone puts a secret
// in the *publishable* slot by mistake.

import type { IdentityProfile } from '@dhaam-ccrm/core';

import type { PresentationMode } from './ui/presentation.js';

// ── Appearance vocabulary ───────────────────────────────────────────────
//
// The console's Appearance tab (Settings → Chatbot) writes exactly these
// value sets, and `remote-config.ts` parses the published blob into them.
// They are declared HERE rather than there because this file is the layer a
// host page can state a value at, and remote-config already imports from this
// one — putting them the other way round would reverse that dependency.

/** Follows the OS (`auto`) or pins one scheme. */
export type WidgetTheme = 'light' | 'dark' | 'auto';

/** Which bottom corner the launcher — and the bubble panel above it — sits in. */
export type WidgetPosition = 'bottom-right' | 'bottom-left';

/**
 * The launcher's shape. `bubble` is the bare circle, `bubble-label` puts the
 * label beside it, and `tab` is a pill flush against the viewport edge.
 */
export type LauncherStyle = 'bubble' | 'bubble-label' | 'tab';

/**
 * Which home layout the merchant chose. `classic` is the compact header this
 * widget has always drawn; `hero` is the tall branded one — a painted
 * background, the team's faces, a greeting and a call to action.
 */
export type WidgetDesign = 'classic' | 'hero';

/** What the classic header's avatar draws. */
export type AvatarMode = 'initials' | 'logo';

/** How the hero header's background is painted. */
export type HeaderBackground = 'solid' | 'gradient' | 'image';

/**
 * Where the header's colour comes from when no explicit one is set.
 *
 * `accent` uses the configured brand colour. `platform` samples the page the
 * widget is installed on, so the widget takes the host site's look without the
 * merchant re-entering a hex code — and falls back to the accent when there is
 * nothing usable to sample, because a header with no colour is not an option.
 */
export type HeaderColorSource = 'accent' | 'platform';

/** The hero header, field for field as the console writes it. */
export interface HeaderAppearance {
  readonly background: HeaderBackground;
  /** Empty means "follow {@link colorSource}". */
  readonly backgroundColor: string;
  readonly colorSource: HeaderColorSource;
  /** 0–100. Strength of the black wash falling from the top edge. */
  readonly gradientStrength: number;
  readonly backgroundImageUrl: string;
  /** 0–100. Dark scrim over the image, so the greeting stays readable. */
  readonly imageOverlay: number;

  readonly showLogo: boolean;
  /** The hero's own logo. Empty falls back to {@link WidgetConfig.logoUrl}. */
  readonly logoUrl: string;
  readonly showAvatars: boolean;
  /** Up to three, rendered overlapping in order. Beyond that they are dropped. */
  readonly avatars: readonly string[];
  /** The online dot, on the last avatar only. */
  readonly showPresence: boolean;
  readonly greeting: string;
  readonly subGreeting: string;
  readonly ctaEnabled: boolean;
  readonly ctaTitle: string;
  readonly ctaSubtitle: string;
}

/** How the conversation's backdrop is painted. */
export type ThreadBackground = 'mesh' | 'solid' | 'image' | 'pattern';

/** The built-in textures, drawn in CSS and tinted from the accent. */
export type ThreadPattern = 'dots' | 'grid' | 'diagonal' | 'crosshatch';

/**
 * The conversation's backdrop.
 *
 * `mesh` is the console's own default — a four-corner pastel wash. The rest
 * let a merchant put their own colour, artwork or texture behind the messages.
 * Bubbles keep their own opaque surfaces in every mode, so nothing here can
 * make a message unreadable.
 */
export interface ThreadAppearance {
  readonly background: ThreadBackground;
  /** Used by `solid`, and as the base tint behind `pattern`. Empty keeps the panel's own surface. */
  readonly color: string;
  readonly pattern: ThreadPattern;
  /** 0–100. How strongly the texture reads against its base. */
  readonly patternOpacity: number;
  readonly imageUrl: string;
  /**
   * Which way the scrim washes the artwork. Light artwork needs a white veil
   * to keep dark bubble text readable; dark artwork needs a black one.
   */
  readonly imageFade: 'light' | 'dark';
  /** 0–100. Scrim over the image, so the bubbles stay readable on it. */
  readonly imageOverlay: number;
}

/** Where the launcher's glyph comes from. */
export type LauncherIconSource = 'library' | 'emoji' | 'image';

/**
 * The launcher's glyph.
 *
 * Only the field matching `source` is read, and the console keeps the other
 * two populated on purpose — switching back and forth must not lose the
 * choices already made. Mirrored here rather than collapsed to one
 * `icon: string`, because collapsing it would make "an emoji" and "a
 * one-character image URL" the same input.
 */
export interface LauncherIcon {
  readonly source: LauncherIconSource;
  /** An id from the built-in set — see `ui/dom.ts`'s `LAUNCHER_ICONS`. */
  readonly library: string;
  readonly emoji: string;
  /** `https:` or `data:image/…`. Anything else is refused rather than rendered. */
  readonly imageUrl: string;
}

/**
 * The drop shadow under the launcher.
 *
 * One `intensity` drives blur, offset, spread and alpha together, so the
 * control reads as "how lifted" rather than asking a merchant to tune four
 * numbers that only look right in certain combinations.
 */
export interface LauncherShadow {
  readonly enabled: boolean;
  /** 0–100, clamped. */
  readonly intensity: number;
}

/** How the host tells us who the end user is, without ever holding a secret. */
export interface WidgetAuth {
  /**
   * `dhp_live_…` / `dhp_test_…`. Identifies the tenant and grants nothing on
   * its own (§10.1). Validated through core's `parsePublishableKey`, so a
   * `dhk_` secret throws `SecretKeyInClientError` at boot instead of reaching
   * the wire.
   */
  readonly publishableKey: string;

  /**
   * The HOST APP's own endpoint that mints a short-lived access token. The
   * host's server holds the secret key and this browser never sees it — that
   * is the whole point of the split (§10.3, §14).
   *
   * Same-origin path (`/api/chat-token`) or absolute URL. Called with
   * `credentials: 'same-origin'` so the host's existing session cookie
   * authenticates the user; nothing about the end user's identity is passed
   * from here, because anything this bundle could pass, an attacker could
   * forge.
   */
  readonly tokenEndpoint?: string;

  /**
   * The JS-API alternative to {@link tokenEndpoint}, for a host that already
   * has a token in memory. Exactly the contract core documents for
   * `ChatClientConfig.getToken`, passed straight through.
   *
   * Not reachable from a `data-*` attribute for the obvious reason: an
   * attribute is a string, and turning a host-supplied string into a function
   * is `eval`.
   */
  readonly getToken?: () => Promise<string | { accessToken: string; expiresIn?: number }>;
}

export interface WidgetIdentity {
  /** The end user's participant id, as the host's own backend knows them. */
  readonly userId: string;
  /** Optional display name, used only for the local optimistic echo. */
  readonly displayName?: string;
  /** Role of the user ('admin' | 'merchant' | 'customer'). */
  readonly role?: string;

  /**
   * The LOGGED-IN user's CRM profile. Supplying it — and only supplying it —
   * is what makes the widget upsert that user as a Contact via
   * `POST /identify`. `userId` alone does not and must not, because every
   * guest has one of those too.
   *
   * Omit it for a guest. There is no "empty profile" to pass: the key's
   * ABSENCE is the signal, and client.ts spreads it conditionally so a guest's
   * `ChatClientConfig` carries no identity fields at all rather than carrying
   * them present-and-undefined.
   *
   * Nothing here is validated or logged by this package — `resolveConfig`
   * carries it through untouched and the server owns every rule about it.
   *
   * Not reachable from a `data-*` attribute. See attributes.ts.
   */
  readonly profile?: IdentityProfile;
}

export interface WidgetConfig {
  readonly auth: WidgetAuth;
  readonly identity: WidgetIdentity;

  /** Origin only — `https://chat.example.com`, no path. */
  readonly apiUrl: string;
  /** `wss://chat.example.com`. Core refuses to guess this (§12.7). */
  readonly wsUrl: string;

  /**
   * Which presentation to mount. Defaults to `'auto'`: `bubble` on a pointer-
   * and-space desktop, `sheet` below {@link sheetBreakpointPx}. See
   * ui/presentation.ts for why a third mode exists at all.
   */
  readonly mode?: PresentationMode;

  /** Viewport width at or below which `'auto'` resolves to `'sheet'`. Defaults to 640. */
  readonly sheetBreakpointPx?: number;

  /** Which edge `sidebar` slides in from. Defaults to `'right'`. */
  readonly side?: 'left' | 'right';

  /** Opens the panel as soon as it mounts. Defaults to `false`. */
  readonly openOnLoad?: boolean;

  /**
   * Opens the panel when an agent starts a conversation with this customer —
   * core's `conversationStarted` (§6.5). Defaults to `false`.
   *
   * Default-off is a deliberate product decision, not caution about the
   * implementation. A chat panel that opens itself covers the page the
   * customer is actually using, moves focus into a composer they did not ask
   * for, and on a `sheet` presentation takes the whole viewport — so it is the
   * host's call to make, per site, and never ours to make for them.
   *
   * Left off, the conversation is still surfaced, passively: the launcher
   * shows its unread indicator and says so in its accessible name, exactly as
   * it would for any other message arriving on a closed panel. Nothing is
   * silently dropped either way — the difference is only whether the panel
   * takes the screen on its own.
   */
  readonly openOnAgentInitiated?: boolean;

  /** Header title. Defaults to `'Chat with us'`. */
  readonly title?: string;

  /** Initial conversation subject / store name, if any. */
  readonly subject?: string;

  /** Target counterparty (e.g. merchant or store), if any. */
  readonly target?: { readonly role: string; readonly id: string };

  /** The current user's role in the portal ('admin' | 'merchant' | 'customer'). */
  readonly userRole?: 'admin' | 'merchant' | 'customer' | string;

  /**
   * The line under the title — a response-time promise, typically. Defaults to
   * `''`, which leaves the connection status alone.
   *
   * Set, it replaces the status line's `'Online'` AND NOTHING ELSE. Every
   * other connection label is diagnostic — "Connecting…", "Not connected —
   * use Reconnect to try again" — and a merchant's reassurance rendered over
   * one of those would tell a customer their message is on its way to someone
   * while it is in fact going nowhere. There is one line under the title, so
   * the two have to share it, and the rule for sharing it is that a working
   * connection has nothing to report and a broken one always wins.
   */
  readonly subtitle?: string;

  /** Accent colour, any CSS colour. Defaults to a neutral slate. */
  readonly accent?: string;

  /**
   * Colour scheme. Defaults to `'auto'`, which is what this widget has always
   * done: follow the host page's `prefers-color-scheme` rather than impose a
   * scheme on it (see ui/styles.ts). `'light'`/`'dark'` pin one regardless of
   * the OS, for a host — or a merchant — whose own page does not follow it
   * either.
   *
   * Deliberately NOT defaulted to the console's own default (`'light'`):
   * changing the built-in would repaint every host already relying on the
   * media query, and none of them asked for that.
   */
  readonly theme?: WidgetTheme;

  /**
   * Which bottom corner the launcher sits in. Defaults to `'bottom-right'`.
   *
   * PHYSICAL, not logical — a merchant who picked "bottom right" in a console
   * showing a right-anchored preview means the right of the screen, and an
   * RTL storefront must not silently render it in the other corner. That is
   * a change from the pre-config behaviour, which used `inset-inline-end` and
   * therefore flipped with the host page's `direction`; the flip was
   * incidental rather than chosen, and it is unreachable as a setting now
   * that the corner is nameable.
   *
   * Distinct from {@link side}, which is the SIDEBAR presentation's edge.
   * A sidebar is a full-height tab rather than a floating launcher, so it has
   * no bottom corner to sit in and keeps following `side`.
   */
  readonly position?: WidgetPosition;

  /**
   * Distance from the viewport's side edge, in CSS pixels. Defaults to 20.
   *
   * The gap a merchant reaches for when the launcher covers their own fixed
   * furniture — a cookie banner, a sticky "add to cart" bar.
   */
  readonly offsetX?: number;

  /** Distance from the viewport's bottom edge, in CSS pixels. Defaults to 20. */
  readonly offsetY?: number;

  /**
   * The launcher's shape. Defaults to `'bubble'` — the bare circle this
   * widget has always rendered.
   *
   * Ignored under the `sidebar` presentation, which is an edge tab by
   * definition: a full-height vertical rail has no circular form to take, and
   * letting a cosmetic setting reshape a structural one would put the tab and
   * the panel it opens on different edges.
   */
  readonly launcher?: LauncherStyle;

  /**
   * The words on the launcher, for the shapes that show any —
   * `'bubble-label'`, `'tab'`, and the `sidebar` presentation's edge tab.
   *
   * Defaults to {@link title}, which is what the sidebar tab has always
   * shown: a host that renamed the widget once should not have to say it
   * twice. Set it separately when the header title and the launcher want
   * different lengths — "Dhaam Support" reads fine in a header and overflows a
   * pill.
   */
  readonly launcherLabel?: string;

  /**
   * The launcher's glyph. Defaults to the built-in chat bubble.
   *
   * `Partial`, so a host naming an emoji does not also have to state a library
   * id and an image URL it will never use. Missing fields fall through to the
   * built-in defaults, and — because precedence is per FIELD — to published
   * config before that.
   */
  readonly launcherIcon?: Partial<LauncherIcon>;

  /** The launcher's drop shadow. Defaults to enabled at intensity 45. */
  readonly launcherShadow?: Partial<LauncherShadow>;

  /**
   * Which home layout to draw. Defaults to `'classic'`.
   *
   * NOT the console's own default of `'hero'`, and this one is load-bearing:
   * `hero` paints the header in the brand colour, and defaulting to it would
   * repaint the header of every widget already embedded — including hosts who
   * never opened the console at all. A merchant who publishes gets `hero`
   * because that is what their console says; nobody else gets a redesign they
   * did not ask for.
   */
  readonly design?: WidgetDesign;

  /**
   * The hero header's background. Read only under {@link design} `'hero'` —
   * the classic header is transparent over the panel's own surface and has
   * nothing to paint.
   */
  readonly header?: Partial<HeaderAppearance>;

  /**
   * The brand mark, as an `https:` or `data:image/…` URL. Empty by default —
   * there is no logo to guess at.
   *
   * Used by the hero header when its own `header.logoUrl` is unset. A relative
   * path is refused rather than loaded: it would resolve against the HOST
   * page's origin, not ours, so a merchant's `/assets/logo.svg` would fetch a
   * path off a storefront nobody involved controls.
   */
  readonly logoUrl?: string;

  /**
   * Whether the classic header's avatar draws {@link avatarInitials} or
   * {@link logoUrl}. Defaults to `'initials'`.
   *
   * Inert on its own: with no initials and no logo there is nothing to draw,
   * which is why this can carry the console's default without repainting a
   * widget nobody has configured. The hero header has its own, richer
   * `header.showLogo`/`header.avatars` and never reads this.
   */
  readonly avatarMode?: AvatarMode;

  /**
   * One or two letters for the classic header's avatar. Empty by default, and
   * empty means NO AVATAR — not a blank circle.
   *
   * The console defaults this to the workspace's initial, but the built-in
   * default here is the pre-config behaviour: a header with a title and no
   * avatar beside it. A merchant who wants one has said so.
   */
  readonly avatarInitials?: string;

  /**
   * Whether to credit the platform under the composer. Defaults to `false` —
   * this widget has never drawn a footer, and turning one on for every
   * existing host would be a visible change none of them asked for.
   *
   * The console defaults it to `true`, so a merchant whose config this widget
   * can actually read gets the credit; a host embedding without one does not
   * sprout a footer on upgrade.
   */
  readonly showBranding?: boolean;

  /** The credit line itself. Defaults to `'Powered by Dhaam'`. */
  readonly brandingText?: string;

  /**
   * Makes the credit a link. Empty — the default — renders it as plain text.
   *
   * Refused unless `https:`/`http:` for the same reason {@link logoUrl} is:
   * this is merchant-supplied and lands in an `href`, so `javascript:` has to
   * be unreachable rather than merely unlikely.
   */
  readonly brandingUrl?: string;

  /**
   * The conversation's backdrop. Defaults to a plain `solid` with no colour —
   * which is the panel's own surface, i.e. exactly what this widget has always
   * drawn.
   *
   * NOT the console's default of `mesh`, for the same reason `design` is not
   * `hero`: a pastel wash behind the transcript is a redesign, and it belongs
   * only to merchants who chose it. Unlike `design` this is read under BOTH
   * layouts — a merchant on the classic header can still want artwork behind
   * their messages, and the console lets them have it.
   */
  readonly thread?: Partial<ThreadAppearance>;

  /**
   * Corner radius in CSS pixels, applied to the panel, the message bubbles and
   * every card inside them. Defaults to 12.
   *
   * One number for all of them rather than a per-element scale: the console
   * offers one slider, and a widget whose panel and bubbles disagree about how
   * round they are reads as a rendering bug rather than as a choice.
   */
  readonly cornerRadius?: number;

  /**
   * Typeface, named the way the console names it — `'Inter'`, `'Roboto'`,
   * `'Georgia'`, `'DM Sans'`, or `'System default'` (the default). An
   * unrecognised name falls back to the system stack rather than to nothing.
   *
   * Distinct from {@link font}, which answers a different question: `font`
   * decides whether the host page's typography reaches us AT ALL, and
   * `fontFamily` picks which face we use when it does not. `font: 'inherit'`
   * therefore wins — a host that asked for their own typography did so about
   * their own page, and a merchant picking a face in a console tab cannot see
   * that decision to overrule it.
   */
  readonly fontFamily?: string;

  /**
   * `'isolate'` (default) pins our own font stack so the host page's typography
   * cannot distort the widget; `'inherit'` adopts the host's. See ui/styles.ts
   * — inheritable properties DO cross a shadow boundary, so this is a real
   * choice and not a no-op.
   */
  readonly font?: 'isolate' | 'inherit';

  /** Existing session to join on connect, if the host already knows one. */
  readonly sessionId?: string;

  /** Where widget-internal failures go. Defaults to a namespaced `console.warn`. */
  readonly onError?: (error: unknown) => void;
}

/** Everything resolved — no optionals left for the UI layer to re-default. */
export interface ResolvedConfig extends WidgetConfig {
  readonly mode: PresentationMode;
  readonly sheetBreakpointPx: number;
  readonly side: 'left' | 'right';
  readonly openOnLoad: boolean;
  readonly openOnAgentInitiated: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly accent: string;
  readonly theme: WidgetTheme;
  readonly position: WidgetPosition;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly launcher: LauncherStyle;
  readonly launcherLabel: string;
  readonly launcherIcon: LauncherIcon;
  readonly launcherShadow: LauncherShadow;
  readonly design: WidgetDesign;
  readonly header: HeaderAppearance;
  readonly logoUrl: string;
  readonly avatarMode: AvatarMode;
  readonly avatarInitials: string;
  readonly showBranding: boolean;
  readonly brandingText: string;
  readonly brandingUrl: string;
  readonly thread: ThreadAppearance;
  readonly cornerRadius: number;
  readonly fontFamily: string;
  readonly font: 'isolate' | 'inherit';
  readonly onError: (error: unknown) => void;
}

export class WidgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WidgetConfigError';
  }
}

/** What the launcher renders when nobody has said otherwise: today's glyph. */
const DEFAULT_LAUNCHER_ICON: LauncherIcon = {
  source: 'library',
  library: 'chat',
  emoji: '\u{1F4AC}',
  imageUrl: '',
};

/** Matches the console's own default, which is the shipped look. */
const DEFAULT_LAUNCHER_SHADOW: LauncherShadow = { enabled: true, intensity: 45 };

/**
 * The console's own header defaults, with one change: `backgroundColor` is
 * empty, which means "follow `colorSource`" and therefore the accent. There is
 * no colour to hardcode here that would not be a brand guess.
 */
const DEFAULT_HEADER: HeaderAppearance = {
  background: 'gradient',
  backgroundColor: '',
  colorSource: 'accent',
  gradientStrength: 100,
  backgroundImageUrl: '',
  imageOverlay: 45,
  // Every piece of CONTENT is off, where the console ships them on with its
  // own sample copy and stock faces. This package has no sample copy to ship:
  // a greeting nobody wrote and three stock agent portraits on a merchant's
  // storefront would be worse than no hero at all. A publish turns them on
  // along with the merchant's own words.
  showLogo: false,
  logoUrl: '',
  showAvatars: false,
  avatars: [],
  showPresence: false,
  greeting: '',
  subGreeting: '',
  ctaEnabled: false,
  ctaTitle: '',
  ctaSubtitle: '',
};

/**
 * A plain backdrop, where the console's own default is `mesh`.
 *
 * `solid` with an empty `color` resolves to the panel's own surface, so a
 * widget nobody has configured looks exactly as it always has. The other
 * fields carry the console's defaults, so a merchant who switches the KIND
 * without touching anything else gets what the console showed them.
 */
const DEFAULT_THREAD: ThreadAppearance = {
  background: 'solid',
  color: '',
  pattern: 'dots',
  patternOpacity: 35,
  imageUrl: '',
  imageFade: 'light',
  imageOverlay: 55,
};

const PRESENTATION_MODES = new Set<string>(['auto', 'bubble', 'sidebar', 'sheet']);

/**
 * `panel`, `side`, and `drawer` all mean `sidebar`.
 *
 * The product brief calls it "panel/sidebar", v1's docs called it a "side
 * tab", and every integrator who types one of those is describing the same
 * thing. Accepting the synonyms costs four map entries; rejecting them costs
 * a support ticket where the widget silently fell back to a bubble.
 */
const MODE_ALIASES: Record<string, PresentationMode> = {
  panel: 'sidebar',
  side: 'sidebar',
  drawer: 'sidebar',
  tab: 'sidebar',
  bottomsheet: 'sheet',
  'bottom-sheet': 'sheet',
};

export function parseMode(raw: string | null | undefined): PresentationMode | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  const aliased = MODE_ALIASES[value];
  if (aliased !== undefined) return aliased;
  if (PRESENTATION_MODES.has(value)) return value as PresentationMode;
  throw new WidgetConfigError(
    `unknown mode ${JSON.stringify(raw)} — expected one of auto, bubble, sidebar, sheet`,
  );
}

/**
 * Where a widget-internal failure goes when the host named no sink.
 *
 * Exported because `mount()` needs it before a `ResolvedConfig` exists: the
 * duplicate-mount path reports and returns without ever resolving a config,
 * and reaching for `config.onError` alone made a duplicate SCRIPT TAG — the
 * exact case the guard exists for — completely silent, because an
 * attribute-built config has no `onError` to reach.
 */
export function defaultOnError(error: unknown): void {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn('[@dhaam-ccrm/widget]', error);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    // The field NAME, never the value: this function guards `publishableKey`
    // among others, so echoing the input here would be the credential-leak
    // path core/auth/keys.ts exists to close.
    throw new WidgetConfigError(`${field} is required`);
  }
  return value.trim();
}

/** Fills every default so the UI layer never re-decides one. */
export function resolveConfig(config: WidgetConfig): ResolvedConfig {
  const apiUrl = requireString(config.apiUrl, 'apiUrl').replace(/\/+$/, '');
  const wsUrl = requireString(config.wsUrl, 'wsUrl').replace(/\/+$/, '');
  const userId = requireString(config.identity?.userId, 'identity.userId');
  requireString(config.auth?.publishableKey, 'auth.publishableKey');

  if (config.auth.tokenEndpoint === undefined && config.auth.getToken === undefined) {
    throw new WidgetConfigError(
      'auth needs either a tokenEndpoint (data-token-endpoint) or a getToken function — ' +
        'the browser is never given a secret key, so a token has to come from your own backend',
    );
  }

  const sheetBreakpointPx = config.sheetBreakpointPx ?? 640;
  if (!Number.isFinite(sheetBreakpointPx) || sheetBreakpointPx <= 0) {
    throw new WidgetConfigError('sheetBreakpointPx must be a positive number');
  }

  // Resolved before the literal below because `launcherLabel` falls back to it
  // — the sidebar tab has always shown the configured title, and a host that
  // renamed the widget once should not have to say it twice.
  const title = config.title ?? 'Chat with us';
  const isGeneric =
    title === 'Chat with us' ||
    title === 'Admin Support Chat' ||
    title === 'Store Support & Chat' ||
    title === 'Dhaam AI';
  const subject = config.subject ?? (!isGeneric ? title : undefined);
  const userRole =
    config.userRole ??
    config.identity.role ??
    (title === 'Admin Support Chat' ? 'admin' : (title === 'Store Support & Chat' ? 'merchant' : undefined));

  return {
    ...config,
    apiUrl,
    wsUrl,
    identity: { ...config.identity, userId },
    ...(userRole !== undefined ? { userRole } : {}),
    mode: config.mode ?? 'auto',
    sheetBreakpointPx,
    side: config.side ?? 'right',
    openOnLoad: config.openOnLoad ?? false,
    openOnAgentInitiated: config.openOnAgentInitiated ?? false,
    title,
    subtitle: config.subtitle ?? '',
    ...(subject !== undefined ? { subject } : {}),
    accent: config.accent ?? '#1f2937',
    theme: config.theme ?? 'auto',
    position: config.position ?? 'bottom-right',
    launcher: config.launcher ?? 'bubble',
    launcherLabel: config.launcherLabel ?? title,
    // Spread, so a host stating only `{ source: 'emoji', emoji: '👋' }` keeps
    // the built-in library id behind it rather than having to restate every
    // branch it is not using.
    launcherIcon: { ...DEFAULT_LAUNCHER_ICON, ...config.launcherIcon },
    launcherShadow: { ...DEFAULT_LAUNCHER_SHADOW, ...config.launcherShadow },
    design: config.design ?? 'classic',
    header: { ...DEFAULT_HEADER, ...config.header },
    logoUrl: config.logoUrl ?? '',
    avatarMode: config.avatarMode ?? 'initials',
    avatarInitials: config.avatarInitials ?? '',
    showBranding: config.showBranding ?? false,
    brandingText: config.brandingText ?? 'Powered by Dhaam',
    brandingUrl: config.brandingUrl ?? '',
    thread: { ...DEFAULT_THREAD, ...config.thread },
    // 20px each: exactly `calc(var(--dh-space) * 5)`, which is where the
    // launcher and the bubble panel have always sat.
    offsetX: config.offsetX ?? 20,
    offsetY: config.offsetY ?? 20,
    // 12, not the console's own default of 20: this is what `--dh-radius` has
    // always been, and a built-in that reshaped every unpublished widget would
    // be a change nobody asked for. A merchant who publishes gets theirs.
    cornerRadius: config.cornerRadius ?? 12,
    fontFamily: config.fontFamily ?? 'System default',
    font: config.font ?? 'isolate',
    onError: config.onError ?? defaultOnError,
  };
}
