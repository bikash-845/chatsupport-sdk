// The published widget configuration, fetched from chat-service.
//
// Until now this package was 100% local: every knob came from a `data-*`
// attribute or a `mount()` argument, and the only `fetch()` in it was the token
// mint. That made the console's "Save" button a lie — a merchant could edit
// their greeting, their pre-chat fields, their offline message, and nothing
// downstream ever read them.
//
// ── Precedence: HOST > REMOTE > built-in default ─────────────────────────
//
// A value the host page stated explicitly always wins. Remote config fills in
// only what the host left unsaid, and the built-in defaults fill what is left.
//
// This is deliberately the OPPOSITE of the React widget, where a successful
// fetch clobbers every field of the props (ChatWidget.tsx merges
// `{ ...config, ...published }`). That direction is wrong for an embedded
// script tag. A host that hardcoded `data-accent="#0f172a"` to match its
// checkout page has made a statement about ITS OWN page that a merchant
// clicking Save in a console tab cannot see and should not be able to
// overrule mid-session. Inverting it also makes the failure mode benign:
// when the fetch fails the widget renders exactly what the host asked for,
// rather than snapping between two different appearances depending on
// whether a network call landed.
//
// The consequence to keep in mind: a field the host sets is permanently
// un-remote-configurable for that host. That is the intended trade — it is
// the host's page.
//
// ── What is NOT read from here ───────────────────────────────────────────
//
// `auth`, `identity`, `apiUrl`, `wsUrl`, `sessionId`, `getToken`, `onError`.
// Credentials and endpoints are the host's to state and are needed BEFORE
// this call can be made at all. There is no `secretKey` field on the
// response type and no field that could carry one, for the same reason
// config.ts has none: a shape with no slot for a credential cannot leak one.

import type {
  AvatarMode,
  HeaderAppearance,
  LauncherIcon,
  LauncherShadow,
  LauncherStyle,
  ResolvedConfig,
  WidgetConfig,
  ThreadAppearance,
  WidgetDesign,
  WidgetPosition,
  WidgetTheme,
} from './config.js';

/** One console-defined field on the pre-chat form. */
export interface PreChatField {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'email' | 'phone';
  readonly required: boolean;
}

/** How the post-resolution rating is presented. The backend knows only these two. */
export type CsatStyle = 'stars' | 'emoji';

/**
 * Whether the panel opens itself, and on what.
 *
 * `'exit-intent'` is the pointer leaving for the browser chrome — a desktop-only
 * signal by nature, and one this package treats as `'never'` on a touch device
 * rather than approximating it with something a merchant did not choose.
 */
export type AutoOpen = 'never' | 'delay' | 'exit-intent';

/**
 * One console-defined quick question — `behaviour.commonQuestions[]`
 * (Chatbot → Behaviour → Common Questions). Declared here, alongside
 * {@link PreChatField}, rather than in `ui/common-questions.ts`: that module
 * is presentation and imports FROM this one (see this file's closing note on
 * "keeps imports one-way"), so the wire-shaped type belongs on this side.
 */
export interface CommonQuestion {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

/**
 * One merchant-configured topic chip — `behaviour.conversationTopics[]`
 * (Chatbot → Behaviour → Conversation topics). Offered on the widget's "New
 * conversation" screen so a customer's pick becomes a real string
 * (`ChatSessionSummary.topic`) the widget, the console and tickets all agree
 * on, rather than something inferred after the fact from a first message.
 *
 * No `prompt` field, unlike {@link CommonQuestion}: picking a topic does not
 * send a message on its own — it rides along on `startNewSession`'s payload
 * once the customer also writes something in the textarea below the chips.
 */
export interface ConversationTopic {
  readonly id: string;
  readonly label: string;
}

/**
 * What the widget does when the team is closed.
 *
 * Integers, not strings, because that is what the wire carries
 * (`WidgetOfflineMode` in chat-service's schema). Named here so the rest of
 * this package never compares a bare `2`.
 */
export const OFFLINE_MODE = {
  /** Say we are closed; the composer stays available. */
  SHOW_MESSAGE: 1,
  /** Replace the composer with a leave-a-message form. */
  COLLECT_MESSAGE: 2,
  /** Do not render the launcher at all. */
  HIDE_WIDGET: 3,
} as const;

export type OfflineMode = (typeof OFFLINE_MODE)[keyof typeof OFFLINE_MODE];

/** A published bot flow, projected down to what a widget can act on. */
export interface PublishedFlow {
  readonly id: string;
  readonly name: string;
  /** 1 WELCOME | 2 KEYWORD | 3 PAGE | 4 OFFLINE. */
  readonly trigger: number;
  readonly keywords: readonly string[];
  readonly pagePattern: string;
  /** Left opaque on purpose — step shapes are the console's to evolve. */
  readonly steps: readonly unknown[];
}

/**
 * chat-service's rendering instruction for this tenant's support entry
 * point, at this instant — field-for-field the sibling design's
 * `PublicSupportEntry` (`docs/design/chat-service-webform-endpoint.md` §7.2,
 * `docs/design/DECISIONS.md` D11). Six rows, resolved server-side by
 * `decideWebformOutcome`; this package reads the answer and never re-derives
 * the table — see {@link entryFor}.
 */
export interface SupportEntry {
  /** What the widget offers first. */
  readonly primary: 'chat' | 'ticket' | 'offline' | 'none';
  /** The other option, when the row offers one; `null` when it does not. */
  readonly secondary: 'chat' | 'ticket' | null;
  readonly hours: 'OPEN' | 'CLOSED' | 'NO_CALENDAR';
}

/**
 * The published config, after parsing — every field already defaulted, so no
 * consumer re-decides one.
 *
 * Flat rather than mirroring the wire's `appearance`/`behaviour` split: those
 * two are opaque `Record<string, unknown>` blobs on the server, which stores
 * and re-serves whatever the console wrote without a field list of its own.
 * Flattening here is where that untyped soup becomes something typed exactly
 * once.
 */
export interface RemoteConfig {
  readonly enabled: boolean;
  readonly accent: string | undefined;
  readonly title: string | undefined;
  /**
   * `appearance.theme`. `undefined` — not `'auto'` — when the publish said
   * nothing, because {@link mergeRemoteConfig} has to be able to tell "the
   * merchant chose auto" from "the merchant chose nothing"; only the latter
   * may be overwritten by a later default.
   */
  readonly theme: WidgetTheme | undefined;
  /** `appearance.position` — which bottom corner the launcher sits in. */
  readonly position: WidgetPosition | undefined;
  /** `appearance.offsetX`/`offsetY`, in CSS pixels from the viewport edges. */
  readonly offsetX: number | undefined;
  readonly offsetY: number | undefined;
  /** `appearance.launcher` — the launcher's shape. */
  readonly launcher: LauncherStyle | undefined;
  /** `appearance.launcherLabel` — the words on the shapes that show any. */
  readonly launcherLabel: string | undefined;
  /**
   * `appearance.launcherIcon` / `appearance.launcherShadow`.
   *
   * `Partial`, and `{}` for a publish that named neither — the same
   * "the merchant said nothing" signal the scalars carry as `undefined`, one
   * level down. Precedence is per FIELD rather than per object (see
   * {@link mergeRemoteConfig}), so an all-or-nothing object here would make a
   * host that named only an emoji unable to inherit anything else.
   */
  readonly launcherIcon: Partial<LauncherIcon>;
  readonly launcherShadow: Partial<LauncherShadow>;
  /** `appearance.design` — which home layout the merchant chose. */
  readonly design: WidgetDesign | undefined;
  /** `appearance.header`, read only under the `hero` design. Same `{}`-means-unset rule. */
  readonly header: Partial<HeaderAppearance>;
  /** `appearance.logoUrl` — the brand mark, behind the header's own. */
  readonly logoUrl: string | undefined;
  /** `appearance.subtitle` — stands in for the status line's `'Online'` only. */
  readonly subtitle: string | undefined;
  /** `appearance.avatarMode` — whether the classic header's avatar is letters or the logo. */
  readonly avatarMode: AvatarMode | undefined;
  /** `appearance.avatarInitials`. Absent means no avatar, not a blank one. */
  readonly avatarInitials: string | undefined;
  /** `appearance.showBranding` — whether to credit the platform under the composer. */
  readonly showBranding: boolean | undefined;
  readonly brandingText: string | undefined;
  readonly brandingUrl: string | undefined;
  /** `appearance.thread` — the conversation's backdrop. Same `{}`-means-unset rule. */
  readonly thread: Partial<ThreadAppearance>;
  /** `appearance.cornerRadius`, in CSS pixels. */
  readonly cornerRadius: number | undefined;
  /** `appearance.fontFamily` — a console font NAME, not a CSS stack. */
  readonly fontFamily: string | undefined;
  readonly greeting: string | undefined;
  /**
   * `behaviour.greetingDelaySec` — how long the widget waits before the
   * greeting appears. Seconds, because that is the unit the console's own
   * control is labelled in.
   */
  readonly greetingDelaySec: number;
  /** `behaviour.autoOpen` — whether the panel opens itself, and on what. */
  readonly autoOpen: AutoOpen;
  /** `behaviour.autoOpenDelaySec`, read only under {@link autoOpen} `'delay'`. */
  readonly autoOpenDelaySec: number;
  /** `behaviour.typingIndicator` — whether the three dots are shown at all. */
  readonly typingIndicator: boolean;
  /** `behaviour.sound` — a chime on the visitor's side when a reply lands. */
  readonly sound: boolean;
  /** `behaviour.transcriptEmail` — offer to email the conversation when it ends. */
  readonly transcriptEmail: boolean;
  /** `behaviour.consentRequired` — gate the composer until the visitor agrees. */
  readonly consentRequired: boolean;
  readonly consentText: string | undefined;
  /**
   * `behaviour.privacyUrl` — the merchant's policy, linked from the widget's
   * own menu. Absent hides that item rather than linking nowhere.
   */
  readonly privacyUrl: string | undefined;
  /**
   * `behaviour.supportEmail` — where a visitor goes when the chat service
   * cannot be reached at all. Absent shows no fallback rather than a guess.
   */
  readonly supportEmail: string | undefined;
  /**
   * `behaviour.handoffKeywords[]` — words that take a visitor to a person.
   *
   * Lower-cased on the way in, because the console lower-cases them on the way
   * out and a visitor types however they like. `[]` for a merchant who has set
   * none, which disables the whole check rather than matching everything.
   */
  readonly handoffKeywords: readonly string[];
  /**
   * `behaviour.reportIssue` — whether the widget offers the report-a-problem
   * form, which files a ticket without a conversation.
   */
  readonly reportIssue: boolean;
  readonly preChatEnabled: boolean;
  readonly preChatFields: readonly PreChatField[];
  /** `behaviour.commonQuestions[]`. `[]` for a merchant who has configured
   *  none — see `ui/common-questions.ts`'s header for why that renders
   *  nothing rather than a built-in fallback list. */
  readonly commonQuestions: readonly CommonQuestion[];
  /** `behaviour.conversationTopics[]`. `[]` skips the chip chooser entirely —
   *  see `ui/new-conversation.ts` for why that is the same screen the widget
   *  showed before this setting existed, not an empty row of chips. */
  readonly conversationTopics: readonly ConversationTopic[];
  readonly csatStyle: CsatStyle;
  readonly offlineMode: OfflineMode;
  readonly offlineMessage: string | undefined;
  readonly fileUploads: boolean;
  /** `null` when the tenant does not follow business hours — NOT "closed". */
  readonly isOpenNow: boolean | null;
  readonly flows: readonly PublishedFlow[];
  readonly botDisplayName: string | undefined;
  readonly publishedVersion: number;
  /**
   * chat-service's own resolution of the visitor's support entry point —
   * `data.support`, field-for-field the sibling `PublicSupportEntry` contract.
   * `null` means "the fetch never told us" (an older chat-service, an absent
   * key, or the whole fetch failing) — see {@link entryFor} for how that
   * degrades, and DO NOT read this field directly; go through {@link entryFor}.
   */
  readonly support: SupportEntry | null;
}

/** What a widget renders when the config could not be read at all. */
export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
  enabled: true,
  accent: undefined,
  title: undefined,
  theme: undefined,
  position: undefined,
  offsetX: undefined,
  offsetY: undefined,
  launcher: undefined,
  launcherLabel: undefined,
  launcherIcon: {},
  launcherShadow: {},
  design: undefined,
  header: {},
  logoUrl: undefined,
  subtitle: undefined,
  avatarMode: undefined,
  avatarInitials: undefined,
  showBranding: undefined,
  brandingText: undefined,
  brandingUrl: undefined,
  thread: {},
  cornerRadius: undefined,
  fontFamily: undefined,
  greeting: undefined,
  greetingDelaySec: 0,
  // Never opens itself. The console's own default is `'delay'`, and this is
  // deliberately not that: a panel that takes the screen on a page the visitor
  // is actually using is the single most intrusive thing this widget can do,
  // and it is not something to start doing because a config fetch failed.
  // Same reasoning `openOnAgentInitiated` gives for defaulting off.
  autoOpen: 'never',
  autoOpenDelaySec: 12,
  typingIndicator: true,
  // Silent. A page that makes noise nobody asked for is a page people close,
  // and an unreadable config is not consent to play a sound.
  sound: false,
  transcriptEmail: false,
  consentRequired: false,
  consentText: undefined,
  privacyUrl: undefined,
  supportEmail: undefined,
  handoffKeywords: [],
  // Off, like every other surface this pass added: a widget whose config never
  // landed must look exactly as it did before, and a form that files tickets
  // is not something to start offering because a fetch failed.
  reportIssue: false,
  preChatEnabled: false,
  preChatFields: [],
  commonQuestions: [],
  conversationTopics: [],
  csatStyle: 'stars',
  offlineMode: OFFLINE_MODE.SHOW_MESSAGE,
  offlineMessage: undefined,
  fileUploads: true,
  // `null`, not `false`. "We could not ask" and "the team is closed" are
  // different facts, and rendering an out-of-hours form because a network call
  // failed would be the worst possible reading of a missing answer.
  isOpenNow: null,
  flows: [],
  botDisplayName: undefined,
  publishedVersion: 0,
  // "we could not ask" ≠ "there is nothing" — the same argument the
  // `isOpenNow` default already makes above. `entryFor` reads this and
  // answers a chat entry point, never a guessed ticket or a hidden launcher.
  support: null,
};

/** Path is fixed by chat-service; only the origin is the host's to state. */
const CONFIG_PATH = '/chat-services/api/v1/widget/config';

/**
 * How long the widget waits before rendering without published config.
 *
 * A bounded wait is not optional. `WIDGET_ALLOWED_ORIGINS` is fleet-wide
 * rather than per-tenant, so a storefront on an unlisted origin gets a
 * response the browser then refuses to hand us — and an unbounded wait would
 * turn that misconfiguration into a widget that never appears at all. Short
 * enough that a customer clicking the launcher immediately does not sit on a
 * blank panel; long enough that an ordinary cold call lands inside it.
 */
export const CONFIG_TIMEOUT_MS = 2_000;

export interface FetchRemoteConfigOptions {
  readonly apiUrl: string;
  readonly publishableKey: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Reads the published config, or returns `null` if it could not be read.
 *
 * Never throws and never rejects: every failure class — network, CORS, 401,
 * 429, timeout, malformed body — collapses to `null`, because the caller's
 * response to all of them is identical (render the host's own config) and a
 * widget that throws during boot takes the host's page down with it.
 *
 * `null` is not silent, though. The caller reports it through
 * `config.onError`, which is what makes the degradation VISIBLE rather than a
 * widget that mysteriously ignores the console.
 */
export async function fetchRemoteConfig(
  options: FetchRemoteConfigOptions,
): Promise<RemoteConfig | null> {
  const { apiUrl, publishableKey, signal, timeoutMs = CONFIG_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, '')}${CONFIG_PATH}`, {
      method: 'GET',
      // The key identifies the tenant and grants nothing on its own (§10.1).
      // It is the ONLY credential this request carries, and it goes in a
      // header rather than a query string so it stays out of access logs,
      // Referer headers and browser history.
      headers: { Accept: 'application/json', 'X-Publishable-Key': publishableKey },
      // No cookies. This is a cross-origin public read that authenticates
      // itself; sending the merchant's session along would be both useless
      // and a CSRF surface.
      credentials: 'omit',
      // Deliberately NOT 'no-store'. chat-service serves this with
      // `max-age=30, stale-while-revalidate=300` and a `Vary` on the key, and
      // the browser's HTTP cache is the intended consumer of that. Revalidation
      // by hand is not even possible here: `ETag` is absent from the route's
      // CORS `exposedHeaders`, so cross-origin JS cannot read the tag it would
      // need to send back in `If-None-Match`. Letting the browser do it
      // transparently is both cheaper and the only thing that actually works.
      cache: 'default',
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const body: unknown = await response.json();
    return parseRemoteConfig(body);
  } catch {
    // Includes the CORS case, which surfaces as a TypeError with no detail:
    // the browser refuses to tell a page why a cross-origin read failed, so
    // there is nothing here to distinguish "origin not allowlisted" from
    // "server down". The caller's message says so rather than guessing.
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────
//
// Every leaf below is read defensively. `appearance` and `behaviour` are
// opaque blobs the server stores and re-serves without validating their
// contents, and the console writes them by WHOLE-OBJECT REPLACEMENT — so a
// field can be absent entirely because an older console version never wrote
// it. Treat every leaf as possibly-missing and possibly the wrong type.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  // Empty strings become `undefined`, not `''`: the console writes `''` for
  // "not set" on several fields, and an empty accent colour or title must fall
  // through to the default rather than render as blank.
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function bool(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * The three-way sibling of {@link bool}, for the appearance fields.
 *
 * `bool` collapses "absent" into a fallback, which is right for the behaviour
 * flags that have one settled answer. Appearance fields cannot: the merge has
 * to know whether the merchant CHOSE `false` or said nothing, or a host's own
 * `true` could be overwritten by a default nobody picked.
 */
function flag(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * A numeric leaf, refused unless it is a real, finite number.
 *
 * `typeof value === 'number'` is not enough on its own: `NaN` and `Infinity`
 * both pass it, both survive `String()`, and both reach a stylesheet as a
 * declaration the engine drops — silently taking the whole rule with it. The
 * console writes these from range inputs, so a string `"20"` is also a
 * plausible shape from an older publish and is deliberately NOT coerced:
 * accepting one wire type keeps the parse a decision rather than a guess.
 */
function num(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A string leaf constrained to a known value set — `theme`, `position`,
 * `launcher`, the header/thread background kinds, and every other enum the
 * console writes.
 *
 * Returns `undefined` rather than a fallback for anything unrecognised, which
 * is the same three-way answer {@link str} gives: absent, malformed, and "the
 * merchant deliberately chose the value that happens to be our default" all
 * have to stay distinguishable until {@link mergeRemoteConfig} has run, or a
 * host's own explicit choice could be overwritten by a console default nobody
 * actually picked.
 *
 * The `allowed` list is the widget's, not the wire's: a value a newer console
 * writes and this bundle has never heard of degrades to the default rather
 * than reaching a stylesheet or an attribute selector as an unknown string.
 */
function oneOf<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = source[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Assembles a `Partial<T>` from possibly-unreadable leaves, OMITTING every key
 * that could not be read rather than setting it to `undefined`.
 *
 * That distinction is the whole reason this exists instead of an object
 * literal. `exactOptionalPropertyTypes` is on, and both the merge and
 * `resolveConfig` build these objects by spreading — so a key present and
 * holding `undefined` would stamp itself over the very default it was
 * supposed to fall through to.
 */
function partial<T extends object>(entries: { [K in keyof T]?: T[K] | undefined }): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

const THEMES = ['light', 'dark', 'auto'] as const;
const POSITIONS = ['bottom-right', 'bottom-left'] as const;
const LAUNCHER_STYLES = ['bubble', 'bubble-label', 'tab'] as const;
const ICON_SOURCES = ['library', 'emoji', 'image'] as const;

/**
 * `appearance.launcherIcon` — the glyph on the launcher.
 *
 * Every branch is read, not just the one `source` names: the console keeps the
 * unused ones populated so switching back and forth does not lose them, and
 * dropping them here would make a later switch in the console publish a blank
 * icon to anyone whose bundle had already thrown the value away.
 */
function parseLauncherIcon(value: unknown): Partial<LauncherIcon> {
  if (!isRecord(value)) return {};
  return partial<LauncherIcon>({
    source: oneOf(value, 'source', ICON_SOURCES),
    library: str(value, 'library'),
    emoji: str(value, 'emoji'),
    imageUrl: str(value, 'imageUrl'),
  });
}

/** `appearance.launcherShadow` — one enable flag and one 0–100 intensity. */
function parseLauncherShadow(value: unknown): Partial<LauncherShadow> {
  if (!isRecord(value)) return {};
  return partial<LauncherShadow>({
    enabled: flag(value, 'enabled'),
    intensity: num(value, 'intensity'),
  });
}

const DESIGNS = ['classic', 'hero'] as const;
const AVATAR_MODES = ['initials', 'logo'] as const;
const AUTO_OPENS = ['never', 'delay', 'exit-intent'] as const;

/**
 * A delay in seconds, clamped to something a page can survive.
 *
 * Unlike the appearance numbers, these are turned into `setTimeout` calls, so
 * a bad value is not a dropped CSS declaration but a timer that never fires or
 * fires forever. Negative is refused outright; the upper bound is an hour,
 * which is far past any delay a merchant means and far short of the 32-bit
 * overflow that makes `setTimeout` fire IMMEDIATELY — the failure mode where
 * "open after a very long time" becomes "open at once", which is the exact
 * opposite of what was configured.
 */
const MAX_DELAY_SEC = 3600;

function seconds(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = num(source, key);
  if (value === undefined || value < 0) return fallback;
  return Math.min(value, MAX_DELAY_SEC);
}

/**
 * `behaviour.handoffKeywords` — the words that take a visitor to a person.
 *
 * Lower-cased and de-duplicated here so the matcher can stay a plain
 * comparison, and blanks dropped: a stray empty string in the array would
 * otherwise match EVERY message and escalate every conversation on its first
 * word. That is the one failure mode of this feature worth spending a line on.
 */
function parseHandoffKeywords(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const word = entry.trim().toLowerCase();
    if (word !== '') seen.add(word);
  }
  return [...seen];
}
const THREAD_BACKGROUNDS = ['mesh', 'solid', 'image', 'pattern'] as const;
const THREAD_PATTERNS = ['dots', 'grid', 'diagonal', 'crosshatch'] as const;
const IMAGE_FADES = ['light', 'dark'] as const;

/** `appearance.thread` — how the conversation's backdrop is painted. */
function parseThread(value: unknown): Partial<ThreadAppearance> {
  if (!isRecord(value)) return {};
  return partial<ThreadAppearance>({
    background: oneOf(value, 'background', THREAD_BACKGROUNDS),
    color: str(value, 'color'),
    pattern: oneOf(value, 'pattern', THREAD_PATTERNS),
    patternOpacity: num(value, 'patternOpacity'),
    imageUrl: str(value, 'imageUrl'),
    imageFade: oneOf(value, 'imageFade', IMAGE_FADES),
    imageOverlay: num(value, 'imageOverlay'),
  });
}

const HEADER_BACKGROUNDS = ['solid', 'gradient', 'image'] as const;
const HEADER_COLOR_SOURCES = ['accent', 'platform'] as const;

/**
 * `appearance.header` — how the hero header is painted.
 *
 * Same whole-object read as the launcher's two: every branch survives, so a
 * merchant switching from `image` back to `gradient` in the console does not
 * publish a blank background to a bundle that had already discarded the
 * gradient's strength.
 */
function parseHeader(value: unknown): Partial<HeaderAppearance> {
  if (!isRecord(value)) return {};
  return partial<HeaderAppearance>({
    background: oneOf(value, 'background', HEADER_BACKGROUNDS),
    backgroundColor: str(value, 'backgroundColor'),
    colorSource: oneOf(value, 'colorSource', HEADER_COLOR_SOURCES),
    gradientStrength: num(value, 'gradientStrength'),
    backgroundImageUrl: str(value, 'backgroundImageUrl'),
    imageOverlay: num(value, 'imageOverlay'),
    showLogo: flag(value, 'showLogo'),
    logoUrl: str(value, 'logoUrl'),
    showAvatars: flag(value, 'showAvatars'),
    // An ABSENT array stays absent so the default can apply; a present one
    // that contains non-strings is filtered rather than rejected, because a
    // merchant with one broken avatar among three should still get the other
    // two. Same reasoning as `parseFlows`'s `keywords`.
    avatars: Array.isArray(value['avatars'])
      ? value['avatars'].filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    showPresence: flag(value, 'showPresence'),
    greeting: str(value, 'greeting'),
    subGreeting: str(value, 'subGreeting'),
    ctaEnabled: flag(value, 'ctaEnabled'),
    ctaTitle: str(value, 'ctaTitle'),
    ctaSubtitle: str(value, 'ctaSubtitle'),
  });
}

function isOfflineMode(value: unknown): value is OfflineMode {
  return value === 1 || value === 2 || value === 3;
}

function parsePreChatFields(value: unknown): readonly PreChatField[] {
  if (!Array.isArray(value)) return [];
  const fields: PreChatField[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = str(entry, 'id');
    const label = str(entry, 'label');
    // A field with no id has nowhere to store its answer and a field with no
    // label cannot be asked for. Skip it rather than rendering an unlabelled
    // box the customer cannot interpret.
    if (id === undefined || label === undefined) continue;
    const rawType = entry['type'];
    const type = rawType === 'email' || rawType === 'phone' ? rawType : 'text';
    fields.push({ id, label, type, required: bool(entry, 'required', false) });
  }
  return fields;
}

/**
 * `behaviour.commonQuestions` → the widget's own {@link CommonQuestion} list.
 *
 * Same defensive read as {@link parsePreChatFields}: `behaviour` is an opaque
 * blob the console writes by whole-object replacement, so an older publish
 * can be missing this key entirely and any entry can be malformed. A
 * question with no `id` has nowhere to key its chip, and one with no
 * `label` or `prompt` has nothing to show or nothing to send — skipped
 * rather than rendered broken.
 */
function parseCommonQuestions(value: unknown): readonly CommonQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: CommonQuestion[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = str(entry, 'id');
    const label = str(entry, 'label');
    const prompt = str(entry, 'prompt');
    if (id === undefined || label === undefined || prompt === undefined) continue;
    questions.push({ id, label, prompt });
  }
  return questions;
}

/**
 * `behaviour.conversationTopics` → the widget's own {@link ConversationTopic}
 * list.
 *
 * Same defensive read as {@link parseCommonQuestions}, one field narrower: no
 * `prompt` to require, since a topic is a label a customer picks, not text
 * that gets sent on its own. A topic with no `id` has nowhere to key its chip
 * and nothing to send as `startNewSession`'s `topic`; one with no `label` has
 * nothing to show. Either drops the entry rather than rendering it broken.
 */
function parseConversationTopics(value: unknown): readonly ConversationTopic[] {
  if (!Array.isArray(value)) return [];
  const topics: ConversationTopic[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = str(entry, 'id');
    const label = str(entry, 'label');
    if (id === undefined || label === undefined) continue;
    topics.push({ id, label });
  }
  return topics;
}

function parseFlows(value: unknown): readonly PublishedFlow[] {
  if (!Array.isArray(value)) return [];
  const flows: PublishedFlow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = str(entry, 'id');
    const name = str(entry, 'name');
    const trigger = entry['trigger'];
    if (id === undefined || name === undefined || typeof trigger !== 'number') continue;
    flows.push({
      id,
      name,
      trigger,
      keywords: Array.isArray(entry['keywords'])
        ? entry['keywords'].filter((k): k is string => typeof k === 'string')
        : [],
      pagePattern: str(entry, 'pagePattern') ?? '',
      steps: Array.isArray(entry['steps']) ? entry['steps'] : [],
    });
  }
  return flows;
}

const ENTRY_PRIMARY = ['chat', 'ticket', 'offline', 'none'] as const;
const ENTRY_SECONDARY = ['chat', 'ticket'] as const;
const ENTRY_HOURS = ['OPEN', 'CLOSED', 'NO_CALENDAR'] as const;

/**
 * Reads `data.support`, or `null` for anything this bundle does not
 * recognise.
 *
 * Refuses rather than defaults, exactly like {@link oneOf} (which answers
 * `undefined` for an unrecognised value): a `primary` a newer console
 * publishes and this bundle has never heard of must degrade to "we could not
 * ask" (which renders a chat entry — see {@link entryFor}) rather than to a
 * member of this union it merely happens to sort next to.
 */
export function parseSupport(value: unknown): SupportEntry | null {
  if (!isRecord(value)) return null;
  const primary = oneOf(value, 'primary', ENTRY_PRIMARY);
  const hours = oneOf(value, 'hours', ENTRY_HOURS);
  if (primary === undefined || hours === undefined) return null;
  return { primary, secondary: oneOf(value, 'secondary', ENTRY_SECONDARY) ?? null, hours };
}

/**
 * Turns a wire body into a {@link RemoteConfig}, or `null` if it is not one.
 *
 * Exported for tests: this is the half of the fetch worth asserting against
 * exhaustively, and it is a pure function of the parsed body.
 */
export function parseRemoteConfig(body: unknown): RemoteConfig | null {
  if (!isRecord(body)) return null;
  const data = body['data'];
  if (!isRecord(data)) return null;

  const appearance = isRecord(data['appearance']) ? data['appearance'] : {};
  const behaviour = isRecord(data['behaviour']) ? data['behaviour'] : {};
  const rawOfflineMode = data['offlineMode'];
  const rawCsat = behaviour['csatStyle'];
  const rawIsOpen = data['isOpenNow'];
  const rawVersion = data['publishedVersion'];

  return {
    enabled: bool(data, 'enabled', DEFAULT_REMOTE_CONFIG.enabled),
    accent: str(appearance, 'accent'),
    title: str(appearance, 'title'),
    theme: oneOf(appearance, 'theme', THEMES),
    position: oneOf(appearance, 'position', POSITIONS),
    offsetX: num(appearance, 'offsetX'),
    offsetY: num(appearance, 'offsetY'),
    launcher: oneOf(appearance, 'launcher', LAUNCHER_STYLES),
    launcherLabel: str(appearance, 'launcherLabel'),
    launcherIcon: parseLauncherIcon(appearance['launcherIcon']),
    launcherShadow: parseLauncherShadow(appearance['launcherShadow']),
    design: oneOf(appearance, 'design', DESIGNS),
    header: parseHeader(appearance['header']),
    logoUrl: str(appearance, 'logoUrl'),
    subtitle: str(appearance, 'subtitle'),
    avatarMode: oneOf(appearance, 'avatarMode', AVATAR_MODES),
    avatarInitials: str(appearance, 'avatarInitials'),
    showBranding: flag(appearance, 'showBranding'),
    brandingText: str(appearance, 'brandingText'),
    brandingUrl: str(appearance, 'brandingUrl'),
    thread: parseThread(appearance['thread']),
    cornerRadius: num(appearance, 'cornerRadius'),
    fontFamily: str(appearance, 'fontFamily'),
    greeting: str(behaviour, 'greeting'),
    greetingDelaySec: seconds(behaviour, 'greetingDelaySec', DEFAULT_REMOTE_CONFIG.greetingDelaySec),
    autoOpen: oneOf(behaviour, 'autoOpen', AUTO_OPENS) ?? DEFAULT_REMOTE_CONFIG.autoOpen,
    autoOpenDelaySec: seconds(behaviour, 'autoOpenDelaySec', DEFAULT_REMOTE_CONFIG.autoOpenDelaySec),
    typingIndicator: bool(behaviour, 'typingIndicator', DEFAULT_REMOTE_CONFIG.typingIndicator),
    sound: bool(behaviour, 'sound', DEFAULT_REMOTE_CONFIG.sound),
    transcriptEmail: bool(behaviour, 'transcriptEmail', DEFAULT_REMOTE_CONFIG.transcriptEmail),
    consentRequired: bool(behaviour, 'consentRequired', DEFAULT_REMOTE_CONFIG.consentRequired),
    consentText: str(behaviour, 'consentText'),
    privacyUrl: str(behaviour, 'privacyUrl'),
    supportEmail: str(behaviour, 'supportEmail'),
    handoffKeywords: parseHandoffKeywords(behaviour['handoffKeywords']),
    reportIssue: bool(behaviour, 'reportIssue', DEFAULT_REMOTE_CONFIG.reportIssue),
    preChatEnabled: bool(behaviour, 'preChatEnabled', false),
    preChatFields: parsePreChatFields(behaviour['preChatFields']),
    commonQuestions: parseCommonQuestions(behaviour['commonQuestions']),
    conversationTopics: parseConversationTopics(behaviour['conversationTopics']),
    csatStyle: rawCsat === 'emoji' || rawCsat === 'stars' ? rawCsat : 'stars',
    offlineMode: isOfflineMode(rawOfflineMode) ? rawOfflineMode : OFFLINE_MODE.SHOW_MESSAGE,
    offlineMessage: str(behaviour, 'offlineMessage'),
    fileUploads: bool(behaviour, 'fileUploads', true),
    // Three-valued and kept that way. `null` means "this tenant does not
    // follow business hours", which is not the same as closed.
    isOpenNow: typeof rawIsOpen === 'boolean' ? rawIsOpen : null,
    flows: parseFlows(data['flows']),
    botDisplayName: str(data, 'botDisplayName'),
    publishedVersion: typeof rawVersion === 'number' ? rawVersion : 0,
    support: parseSupport(data['support']),
  };
}

// ── Merge ─────────────────────────────────────────────────────────────────

/**
 * Fills the gaps in a host-supplied config from published config.
 *
 * Only ever ADDS keys the host omitted — see the precedence note at the top
 * of this file. Returns a new object; the input is not mutated.
 *
 * Runs BEFORE `resolveConfig`, which is what makes "the host did not say" a
 * knowable thing at all: once `resolveConfig` has applied its `??` defaults,
 * a host-chosen `'#1f2937'` and a defaulted `'#1f2937'` are the same value
 * and remote config could no longer tell which fields it is allowed to fill.
 */
export function mergeRemoteConfig(host: WidgetConfig, remote: RemoteConfig | null): WidgetConfig {
  if (remote === null) return host;

  const filled: Record<string, unknown> = { ...host };

  // A table rather than a line per field, same shape as `attributes.ts`'s
  // `optionals`: the list is the ONLY thing that changes when the console
  // grows another appearance knob, and a table makes a forgotten field a
  // missing row rather than a missing `if` that still compiles.
  //
  // Keys are `WidgetConfig`'s, and every one here is deliberately spelled the
  // same on both sides — a `RemoteConfig` field whose name drifts from its
  // `WidgetConfig` twin would silently stop being fillable.
  const fromRemote: Partial<Record<keyof WidgetConfig, unknown>> = {
    accent: remote.accent,
    title: remote.title,
    theme: remote.theme,
    position: remote.position,
    offsetX: remote.offsetX,
    offsetY: remote.offsetY,
    launcher: remote.launcher,
    launcherLabel: remote.launcherLabel,
    design: remote.design,
    logoUrl: remote.logoUrl,
    subtitle: remote.subtitle,
    avatarMode: remote.avatarMode,
    avatarInitials: remote.avatarInitials,
    showBranding: remote.showBranding,
    brandingText: remote.brandingText,
    brandingUrl: remote.brandingUrl,
    cornerRadius: remote.cornerRadius,
    fontFamily: remote.fontFamily,
  };

  for (const [key, value] of Object.entries(fromRemote)) {
    // `exactOptionalPropertyTypes` is on, so a key holding `undefined` is not
    // the same as an absent key — assign conditionally rather than spreading
    // possibly-undefined values in.
    if (value === undefined) continue;
    if (host[key as keyof WidgetConfig] !== undefined) continue;
    filled[key] = value;
  }

  // The same rule one level down, for the fields the console writes as whole
  // OBJECTS. Precedence stays per FIELD — a host that named an emoji has said
  // nothing about which library glyph sits behind it — so these are overlaid
  // key by key rather than replaced wholesale, host last.
  //
  // An empty result adds no key at all, exactly like the scalars above: an
  // `{}` here would read downstream as "the host stated an object", and
  // `resolveConfig` spreads it over the built-in defaults either way, so the
  // distinction costs nothing to keep and is one less way to be surprised.
  for (const key of ['launcherIcon', 'launcherShadow', 'header', 'thread'] as const) {
    const merged = { ...remote[key], ...host[key] };
    if (Object.keys(merged).length > 0) filled[key] = merged;
  }

  return filled as unknown as WidgetConfig;
}

/**
 * Never `null`. What the UI actually renders from — the chooser's one read of
 * published config, resolved once here rather than re-derived at every call
 * site.
 */
export interface ResolvedEntry {
  readonly primary: 'chat' | 'ticket' | 'offline' | 'none';
  readonly secondary: 'chat' | 'ticket' | null;
  readonly hours: 'OPEN' | 'CLOSED' | 'NO_CALENDAR' | 'UNKNOWN';
  /**
   * `'published'` when the server stated this; `'assumed'` when it did not.
   *
   * Load-bearing, not diagnostic. It is what {@link shouldMount} reads to
   * know it must fall through to the pre-`support` rule, and it is what every
   * UI consumer must check before rendering a sentence that claims knowledge
   * — no "we're closed", no "we'll reply by email" — over an entry this
   * bundle merely assumed rather than one chat-service actually published.
   */
  readonly source: 'published' | 'assumed';
}

/**
 * The tenant's support entry point, resolved.
 *
 * Lives here beside `shouldMount`/`shouldCollectOffline`/`isOutOfHours`
 * rather than in a module of its own: it is the fourth question of exactly
 * the same kind, asked of exactly the same object.
 *
 * It does NOT re-derive the six-row decision table. chat-service resolves it
 * authoritatively (`decideWebformOutcome`, `docs/design/
 * chat-service-webform-endpoint.md` §7.2) and this reads the answer — a
 * second derivation is a second thing to keep in sync, and this widget
 * cannot see the channel-enablement flags and must not compute hours on a
 * clock the visitor controls (see `ui/offline-form.ts`'s own header).
 */
export function entryFor(remote: RemoteConfig): ResolvedEntry {
  if (remote.support === null) {
    // The pre-`support` world, verbatim: chat is the entry point, and
    // offlineMode/isOpenNow decide the rest (see `shouldMount` below).
    return { primary: 'chat', secondary: null, hours: 'UNKNOWN', source: 'assumed' };
  }
  return { ...remote.support, source: 'published' };
}

/** Today's `shouldMount` rule, lifted out so both callers below share it. */
function hoursHideRule(remote: RemoteConfig): boolean {
  return !(remote.offlineMode === OFFLINE_MODE.HIDE_WIDGET && remote.isOpenNow === false);
}

/**
 * Whether the widget should mount a launcher at all. EXTENDED, not replaced.
 *
 * ORDER MATTERS. `source` is tested FIRST: with no published entry,
 * {@link entryFor} answers `primary: 'chat'`, so a `primary !== 'offline'`
 * check placed above it would return `true` unconditionally and silently
 * delete today's `HIDE_WIDGET` behaviour for every deployment that has not
 * yet got a `support` block — which is every deployment, on the day this
 * ships. With `support === null` every call reaches {@link hoursHideRule}
 * after the `enabled` check, which is BYTE-IDENTICAL to this function's
 * pre-chooser behaviour — the property that lets the chooser ship before
 * chat-service does (see the exhaustive compatibility test in
 * `test/support-entry.test.ts`).
 *
 * The published-`'offline'` clause is narrow on purpose: `offlineMode` is a
 * LIVE CHAT setting, and a tenant who chose "hide the widget outside hours"
 * was answering a question about chat. On row 5 (chat off, ticket on) hours
 * are irrelevant and that answer has nothing to say — so a tenant who turns
 * webform on is shown a launcher even under `HIDE_WIDGET`, and no existing
 * tenant's behaviour changes until they opt into webform.
 */
export function shouldMount(remote: RemoteConfig): boolean {
  if (!remote.enabled) return false;
  const entry = entryFor(remote);
  if (entry.source === 'assumed') return hoursHideRule(remote);
  if (entry.primary === 'none') return false;
  if (entry.primary === 'offline') return hoursHideRule(remote);
  return true;
}

/**
 * Whether the out-of-hours form replaces the composer.
 *
 * Only `COLLECT_MESSAGE` does. `SHOW_MESSAGE` says we are closed but leaves
 * the composer alone, and `HIDE_WIDGET` never got this far ({@link shouldMount}).
 */
export function shouldCollectOffline(remote: RemoteConfig): boolean {
  return remote.isOpenNow === false && remote.offlineMode === OFFLINE_MODE.COLLECT_MESSAGE;
}

// A KNOWN, DELIBERATE DIVERGENCE FROM THE CONSOLE CONTRACT.
//
// The console specifies COLLECT_MESSAGE as "run the tenant's OFFLINE-trigger
// bot flow, falling back to SHOW_MESSAGE when no published+enabled one
// exists". This widget does not implement the bot-flow step machine at all —
// that is a separate feature — so it renders a built-in offline form and does
// NOT consult `flows` first.
//
// Chosen knowingly rather than by omission. Implementing only the fallback
// half would leave a merchant who set COLLECT_MESSAGE without authoring an
// OFFLINE flow with no form at all, which is strictly worse than the built-in
// one: it collects the same name/contact/message an offline flow would. The
// payload carries no flag saying the fallback happened, so nothing here could
// distinguish the two cases even if it wanted to.
//
// What it costs: a merchant who DID author an OFFLINE flow gets the generic
// form rather than their scripted one. Closing that needs the step machine.
// `PublishedFlow.trigger === 4` is parsed and carried for exactly that.

/** Convenience for the UI layer: is the team closed right now? */
export function isOutOfHours(remote: RemoteConfig): boolean {
  return remote.isOpenNow === false;
}

/** Narrow view of the resolved config the UI needs. Keeps imports one-way. */
export type ConfiguredWidget = ResolvedConfig & { readonly remote: RemoteConfig };
