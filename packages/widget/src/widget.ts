// The widget itself: launcher, panel, and the wiring between core's state and
// the DOM.
//
// Reads state through `@dhaam-ccrm/js`'s `select`, never through a raw
// `client.subscribe`. Core notifies on EVERY state change — a keystroke of a
// typing indicator, a presence heartbeat, a watermark advancing — and a single
// subscription that re-rendered everything would rebuild the message list on
// each one. Each `select` below re-runs only when its own slice changes, which
// is the entire reason that package was built as this one's substrate.

import {
  MemoryStorageAdapter,
  createBrowserStorageAdapter,
  isHandledByCurrent,
  isParkedCloseReason,
} from '@dhaam-ccrm/core';
import type { CloseReason } from '@dhaam-ccrm/core';
import { ChatClientConfigError } from '@dhaam-ccrm/js';
import type { ChatStore } from '@dhaam-ccrm/js';
import type { ChatMessage, ChatSessionSummary, ChatState, ConnectionState } from '@dhaam-ccrm/js';

import {
  countQueuedSends,
  createNetworkStatus,
  createReconnectPump,
  isNavigatorOnline,
  OUTAGE_ATTEMPT_THRESHOLD,
  resolveOfflineBanner,
} from '@dhaam-ccrm/browser';

import { createWidgetStore } from './client.js';
import { resolveConfig } from './config.js';
import type {
  AvatarMode,
  HeaderAppearance,
  LauncherIcon,
  LauncherStyle,
  ResolvedConfig,
  ThreadAppearance,
  WidgetConfig,
  WidgetDesign,
} from './config.js';
import { asksForAHuman } from './handoff-keywords.js';
import { createChime } from './ui/chime.js';
import { createConsentGate } from './ui/consent.js';
import { createHeaderMenu } from './ui/header-menu.js';
import { createUnavailable } from './ui/unavailable.js';
import { createReportIssueForm } from './ui/report-issue.js';
import type { IssueReport } from './ui/report-issue.js';
import { createComposer } from './ui/composer.js';
import {
  ICONS,
  LAUNCHER_ICONS,
  SOLID_LAUNCHER_ICONS,
  el,
  icon,
  safeImageUrl,
  safeLinkUrl,
  solidIcon,
} from './ui/dom.js';
import { captureFocus, trapFocus } from './ui/focus.js';
import type { FocusTrap } from './ui/focus.js';
import { createHeroHeader, heroContentFrom } from './ui/hero-header.js';
import { createHomeScreen, homeQuestionsSlot } from './ui/home-screen.js';
import { createIdentityHeader } from './ui/identity-header.js';
import { createMessageList } from './ui/message-list.js';
import { createMessagesScreen } from './ui/messages-screen.js';
import { createNav } from './ui/nav.js';
import type { NavTab } from './ui/nav.js';
import { createNewConversationScreen } from './ui/new-conversation.js';
import type { NewConversationInput } from './ui/new-conversation.js';
import { resolvePresentation } from './ui/presentation.js';
import type { ResolvedPresentation } from './ui/presentation.js';
import { samplePlatformColor } from './ui/platform-color.js';
import { createWidgetRoot } from './ui/root.js';
import { createScreens } from './ui/screens.js';
import type { ScreenName } from './ui/screens.js';
import {
  STYLES,
  cssColor,
  cssPx,
  fontStackFor,
  headerBaseColor,
  headerForeground,
  headerLayers,
  launcherShadowCss,
  readableOn,
  themeCss,
  threadTokens,
} from './ui/styles.js';
import { createCsatSurvey } from './ui/csat.js';
import type { CsatExistingRating } from './ui/csat.js';
import { createEndConversationConfirm } from './ui/end-conversation.js';
import { createEndedFooter } from './ui/ended-footer.js';
import { createOfflineBanner } from './ui/offline-banner.js';
import { createOfflineForm } from './ui/offline-form.js';
import { createPreChatForm } from './ui/pre-chat-form.js';
import type { PreChatAnswers } from './ui/pre-chat-form.js';
import { createCommonQuestions } from './ui/common-questions.js';
import type { CommonQuestion } from './ui/common-questions.js';
import {
  DEFAULT_REMOTE_CONFIG,
  entryFor,
  fetchRemoteConfig,
  shouldCollectOffline,
  shouldMount,
} from './remote-config.js';
import type { AutoOpen, RemoteConfig, ResolvedEntry } from './remote-config.js';
import { captureContactInfo } from './contact-info.js';
import { createWebformForm } from './ui/webform-form.js';
import { submitWebform, WebformError } from './webform.js';
import type { WebformDraft, WebformReceipt } from './webform.js';

/** How the host drives the widget after mounting it. */
export interface ChatWidget {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** The underlying store, for a host that wants to send programmatically. */
  readonly store: ChatStore;
  /** Removes every node, listener, timer, and the socket. Idempotent. */
  destroy(): void;
}

/**
 * The two connection states core deliberately does NOT retry out of (§8.1).
 *
 * `suspended` means core stopped on purpose because something outside its
 * control is broken — an unsupported protocol version, or credentials that
 * failed three times running — and `closed` follows a `disconnect()`. Core
 * documents `connect()` as the only way out of either, which makes recovering
 * from them the host's job.
 *
 * These are the only two states in which the Reconnect button is PRESSABLE.
 * See {@link WorkingConnectionState} for why it is deliberately inert
 * everywhere else, even though it is no longer invisible there.
 */
const TERMINAL_CONNECTION_STATES: ReadonlySet<ConnectionState> = new Set(['suspended', 'closed']);

/**
 * How long a session switch waits for core's connect-time history work before
 * going ahead without it.
 *
 * A deadline is not optional here. {@link createWidget}'s `whenHistorySettles`
 * resolves on a `pagination` transition, and `pagination` only ever moves
 * because a connection reached `connected` and core seeded page one. A socket
 * that never gets there — a connect that keeps failing, or a `suspended`
 * client core has deliberately stopped retrying — produces no transition at
 * all, so an unbounded wait turns every row in the picker into a click that
 * navigates nowhere, reports nothing, and leaves one live subscription behind
 * per press on a widget that lives as long as the tab does.
 *
 * Shorter than core's own `SESSION_SNAPSHOT_TIMEOUT_MS` (10s) on purpose. This
 * wait is an optimisation in front of the real operation, not a step of it,
 * so it must not be the larger half of the customer's worst case.
 */
export const HISTORY_SETTLE_TIMEOUT_MS = 5_000;

/** Words for the states in which nothing is being attempted. */
const SETTLED_CONNECTION_LABEL = {
  idle: 'Not connected',
  connected: 'Online',
  // Both terminal states name the control that fixes them. `suspended` once
  // read "Offline — messages will send when you reconnect", which promised an
  // automatic recovery that by definition never comes in that state: core has
  // stopped retrying, so the sentence was waiting on an event that required the
  // customer to act and never told them so.
  suspended: 'Not connected — use Reconnect to try again',
  closed: 'Disconnected — use Reconnect to try again',
} as const satisfies Partial<Record<ConnectionState, string>>;

type SettledConnectionState = keyof typeof SETTLED_CONNECTION_LABEL;

/**
 * The states in which core is still working on the connection by itself.
 *
 * ── Why "Reconnect" is inert here, and does not force an attempt ──────────
 *
 * The bug this set exists to fix was that `connecting` belonged to NEITHER
 * list: the Reconnect button and the `online` listener were both gated on
 * `TERMINAL_CONNECTION_STATES`, so in the one state a client actually parks in
 * when the server is down, both silently did nothing and the customer got an
 * indefinite "Connecting…" with no further signal.
 *
 * The answer is not to let them call `connect()` here. Two independent reasons,
 * both readable in core's connection/controller.ts:
 *
 *   1. It cannot work. `connect()` returns the in-flight promise whenever one
 *      is pending, and that promise settles only on `connection.ack`,
 *      `disconnect()`, or `#suspend` — never on a retryable close. In exactly
 *      the reported scenario (server unreachable from the first load) it stays
 *      pending for the whole retry loop, so every `connect()` returns the same
 *      promise and opens no socket. A button wired to it would be a no-op by
 *      construction; enabling it only makes the no-op loud.
 *
 *   2. Where it could work, it would compete. After a successful connect and a
 *      later drop the promise is settled, so `connect()` runs `#cancelTimers()`
 *      and resets `#attempt` to 0 — cancelling core's armed backoff timer AND
 *      restarting its exponential backoff from the bottom. A customer tapping
 *      the button would pin backoff at attempt 0 for as long as they kept
 *      tapping. That is the second, competing retry mechanism this widget must
 *      not become.
 *
 * Core also no longer needs the help: every attempt now produces a close
 * within `connectTimeoutMs` (10s by default) and routes into the existing
 * backoff, so `connecting` self-heals unaided. What was missing was never the
 * button — it was the SIGNAL. So the control becomes visible-but-disabled once
 * something has demonstrably gone wrong, the status line says which thing, and
 * the button becomes pressable the instant core actually parks.
 */
type WorkingConnectionState = Exclude<ConnectionState, SettledConnectionState>;

/**
 * `in`, not a cast.
 *
 * This is the one place the settled and working halves of
 * {@link ConnectionState} are separated, and the narrowing it produces is
 * checked by the compiler rather than asserted by us. The concrete payoff is
 * that {@link SETTLED_CONNECTION_LABEL} can only ever be indexed by a key it
 * actually has: an eighth connection state added to core would fall through to
 * {@link workingConnectionStatus}'s generic copy, which is wrong-but-harmless,
 * where the cast this replaced would have put a literal `undefined` in the
 * status line.
 */
function isSettledConnection(state: ConnectionState): state is SettledConnectionState {
  return state in SETTLED_CONNECTION_LABEL;
}

// `OUTAGE_ATTEMPT_THRESHOLD` — "how many consecutive failures before this stops
// being a blip" — used to be declared here. It now comes from
// @dhaam-ccrm/browser, alongside `resolveOfflineBanner`, which is the OTHER
// surface that has to answer the same question. Two copies of that number
// would put the status line and the banner on different sides of the same
// failure, and the reason for the value is unchanged: one failure is the
// commonest event the transport has (a wifi handover, a proxy recycling a
// socket) and core is usually back inside a second.

/**
 * More specific than "still trying", and it names something the customer can
 * act on. Reached from `navigator.onLine`, which is a fact the browser
 * volunteers rather than a guess this widget makes.
 */
const OFFLINE_LABEL = 'No internet connection — we\u2019ll reconnect when it\u2019s back';

/**
 * The copy the reported bug was missing.
 *
 * An indefinite "Connecting…" says an attempt is going fine. Once attempts
 * have failed twice running, that is false, and the true sentence has to say
 * both halves: we cannot reach it, AND we have not given up.
 */
const OUTAGE_LABEL = 'Can\u2019t reach chat \u2014 still trying';

/**
 * What the composer promises once anything typed will be held rather than sent.
 *
 * The composer stays ENABLED in every one of these states on purpose — core's
 * send queue is durable (§9.6), so a customer with no signal can still type
 * their question and have it go out on reconnect. Only the promise about what
 * happens to it changes.
 */
const QUEUEING_PLACEHOLDER = 'Type a message \u2014 we\u2019ll send it when you\u2019re back online';

const CONNECTION_COLOR: Record<ConnectionState, string> = {
  idle: 'var(--dh-text-muted)',
  connecting: '#c98a00',
  authenticating: '#c98a00',
  connected: '#118d57',
  reconnecting: '#c98a00',
  suspended: '#b42318',
  closed: 'var(--dh-text-muted)',
};

/**
 * How many past conversations the picker asks for.
 *
 * Five is the server's own default for `GET /chat/sessions/customer` and well
 * inside its cap of 20 (chat.validator.ts). A picker is a shortcut back to a
 * recent conversation, not an archive browser — a longer list would push the
 * "start a new conversation" action below the fold on a phone, which is the
 * one action every customer needs to be able to reach.
 */
const SESSION_PICKER_LIMIT = 5;

/** Everything the connection's state implies for the UI, decided in one place. */
interface ConnectionStatus {
  readonly label: string;
  readonly color: string;
  /**
   * `hidden` — no recovery control at all; nothing has gone wrong yet.
   * `inert` — shown and disabled: recovery is underway and pressing is not the
   *   missing step (see {@link WorkingConnectionState}).
   * `ready` — core has parked and only an explicit `connect()` revives it.
   */
  readonly control: 'hidden' | 'inert' | 'ready';
  /** Whether anything typed now will be held rather than sent immediately. */
  readonly queueing: boolean;
}

/**
 * The one function that decides what the customer is told about the connection.
 *
 * Pure, and the single source for all three surfaces it drives — the status
 * line, the Reconnect control, and the composer's prompt. They previously
 * disagreed because each was written separately: the composer stayed silent
 * while the status line said "Connecting…" forever, and the button's
 * visibility rule knew nothing about either. Any two of them contradicting
 * each other is now impossible by construction rather than by discipline.
 */
function resolveConnectionStatus(
  connectionState: ConnectionState,
  online: boolean,
  failedAttempts: number,
): ConnectionStatus {
  if (isSettledConnection(connectionState)) {
    return {
      label: SETTLED_CONNECTION_LABEL[connectionState],
      color: CONNECTION_COLOR[connectionState],
      control: TERMINAL_CONNECTION_STATES.has(connectionState) ? 'ready' : 'hidden',
      // `suspended` really does hold what is typed: core has stopped retrying,
      // but the durable send queue (§9.6) is untouched by that.
      queueing: connectionState === 'suspended',
    };
  }

  return workingConnectionStatus(connectionState, online, failedAttempts);
}

/**
 * The half of {@link resolveConnectionStatus} that runs while core is still
 * working on the connection by itself.
 *
 * Split out so the compiler, not a comment, guarantees the two halves cover
 * every {@link ConnectionState} exactly once — see {@link isSettledConnection}.
 */
function workingConnectionStatus(
  connectionState: WorkingConnectionState,
  online: boolean,
  failedAttempts: number,
): ConnectionStatus {
  const color = CONNECTION_COLOR[connectionState];
  const outage = failedAttempts >= OUTAGE_ATTEMPT_THRESHOLD;
  const control = outage ? 'inert' : 'hidden';

  // Checked before the attempt count: "there is no network" is both more
  // specific and more actionable than "we cannot reach the server", and it is
  // the reason the attempts are failing rather than a separate fact.
  if (!online) return { label: OFFLINE_LABEL, color, control, queueing: true };
  if (outage) return { label: OUTAGE_LABEL, color, control, queueing: true };

  return {
    // Zero failures is a first attempt genuinely in flight; one is a blip core
    // fixes on its own, which is what `reconnecting` has always meant here.
    label: failedAttempts === 0 ? 'Connecting\u2026' : 'Reconnecting\u2026',
    color,
    control,
    queueing: false,
  };
}

/**
 * The launcher's glyph, from whichever of the three sources is selected.
 *
 * Lives here rather than in `ui/dom.ts` so that module keeps its one-way
 * imports: it is the primitive layer and knows nothing about `WidgetConfig`,
 * while this file already holds both.
 *
 * Every branch falls back to the built-in chat bubble rather than to nothing.
 * An emoji field a merchant blanked, an image URL the allowlist refused, a
 * library id from a console newer than this bundle — all of them are cases
 * where a launcher with no glyph at all is strictly worse than the default
 * one, because a blank circle reads as a broken widget rather than as a
 * customised one.
 */
/**
 * Heroicons' `chevron-left` outline, lifted verbatim from the installed
 * package — `node_modules/@heroicons/react/24/outline/ChevronLeftIcon.js` in
 * `chatsupport_react` — the same sourcing `ui/composer.ts`'s link icon and
 * `ui/dom.ts`'s `LAUNCHER_ICONS` document for themselves.
 */
const BACK_ICON = ['M15.75 19.5 8.25 12l7.5-7.5'];

function buildLauncherIcon(spec: LauncherIcon): Node {
  if (spec.source === 'emoji' && spec.emoji.trim() !== '') {
    // `text`, so it goes through `textContent` — a merchant's "emoji" field is
    // free text and this is a shadow root on someone else's checkout page.
    return el('span', { attrs: { class: 'dh-launcher-emoji', 'aria-hidden': 'true' }, text: spec.emoji });
  }

  if (spec.source === 'image') {
    const src = safeImageUrl(spec.imageUrl);
    // `alt=""`, not the label: the launcher already carries an accessible name
    // (see `launcherName`), and naming the image too would make a screen
    // reader announce the button twice — the same rule `icon()` follows.
    if (src !== null) return el('img', { attrs: { class: 'dh-launcher-image', src, alt: '' } });
  }

  // `solidIcon` for the console's own glyphs, which are Heroicons SOLID
  // shapes — stroking a filled path produces a blot. The built-in `chat`
  // fallback is this package's own outline, so it keeps the outline renderer.
  const library = LAUNCHER_ICONS[spec.library];
  if (library !== undefined && SOLID_LAUNCHER_ICONS.has(spec.library)) {
    return solidIcon(library, 24);
  }
  return icon(library ?? ICONS.chat, 24);
}

/**
 * The header's BRAND avatar — the merchant's own face — or `null` when there
 * is nothing to draw.
 *
 * `null` rather than an empty circle is the whole contract: this widget has
 * never drawn an avatar, so a merchant who has set neither initials nor a logo
 * must get the header they already have rather than a grey disc where their
 * brand is supposed to be.
 *
 * `aria-hidden` throughout — the title beside it already names who the
 * customer is talking to, and a screen reader announcing "D" before it would
 * be reading out a decoration.
 */
function buildHeaderAvatar(mode: AvatarMode, initials: string, logoUrl: string): HTMLElement | null {
  if (mode === 'logo') {
    const src = safeImageUrl(logoUrl);
    return src === null
      ? null
      : el('img', { attrs: { class: 'dh-avatar dh-avatar-image', src, alt: '', 'aria-hidden': 'true' } });
  }

  // Two characters, because that is what fits: the console lets a merchant
  // type a whole word into a field rendered as a 32px disc, and three letters
  // overflow it. Sliced rather than refused — a merchant who typed their full
  // name meant the first letters of it.
  const letters = initials.trim().slice(0, 2);
  return letters === ''
    ? null
    : el('span', { attrs: { class: 'dh-avatar', 'aria-hidden': 'true' }, text: letters });
}

/**
 * The header's AGENT avatar: one letter, the handler's first initial.
 *
 * One letter rather than the brand avatar's two, because it stands for a
 * person's name and not a company's — the same reading the console's own
 * agent chips use. `null` for a blank display name (a degenerate record, not
 * a state the protocol promises), so the caller can fall back to the brand
 * face rather than mount an empty disc.
 *
 * `aria-hidden` for exactly `buildHeaderAvatar`'s reason: the title beside it
 * (identity-header.ts) already names this person.
 */
function buildAgentAvatar(displayName: string): HTMLElement | null {
  const letter = displayName.trim().slice(0, 1);
  return letter === ''
    ? null
    : el('span', {
        attrs: { class: 'dh-avatar dh-avatar-agent', 'aria-hidden': 'true' },
        text: letter,
      });
}

/** Which surface is standing in for the chat. */
type SurfaceKind = 'preChat' | 'offline' | 'csat' | 'report' | 'composingNew' | 'confirmEnd' | 'webform';

/** What is known about one session's CSAT rating — see `csatBySession`. */
type CsatLookup =
  | { readonly state: 'loading' }
  | { readonly state: 'unknown' }
  | { readonly state: 'unsupported' }
  | { readonly state: 'unrated' }
  | { readonly state: 'rated'; readonly rating: number; readonly comment: string | null };

/**
 * Whether `error` says the deployment has no CSAT READ route, as opposed to
 * saying no about this particular session.
 *
 * The two are distinguishable and must be distinguished. chat-service answers
 * an ownership failure with its own envelope, so `RestApiError.code` carries a
 * structured code (`SESSION_NOT_FOUND`); a framework route-not-found carries
 * no envelope at all, so `readErrorBody` finds nothing and the code falls back
 * to the literal `HTTP_<status>`. A widget bundle outlives any one backend
 * release — a staged rollout, a lagging tenant, a rollback — so treating "this
 * service is older than this bundle" as "something failed" would silently take
 * the survey away from every visitor on that deployment.
 *
 * Structural, not `instanceof RestApiError`: this file has no reason to import
 * the REST package's error classes for one branch, and the two fields it reads
 * are part of that class's documented public shape.
 */
function isMissingCsatRoute(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (status !== 404 && status !== 405) return false;
  return code === `HTTP_${String(status)}`;
}

/**
 * The surfaces a CUSTOMER opened, as opposed to the ones the widget raised on
 * its own from config or session state.
 *
 * The split is what `syncProductSurfaces`'s non-preemption rule runs on. The
 * automatic surfaces (`preChat`, `offline`, `csat`) are re-derived from state
 * on every store change and may replace each other freely — they are three
 * readings of the same facts. A user-initiated one is a task the customer is
 * in the middle of: a form half typed, a question half answered. Letting a
 * state tick (a connection ack, the session list landing, a message arriving)
 * swap it for the pre-chat gate or a rating is exactly the reported "New
 * conversation does nothing" — the form was replaced under the customer's
 * finger, and after Start the freshly minted, still-empty session re-armed
 * the gate before the opening line could land.
 */
const USER_INITIATED_SURFACES: ReadonlySet<SurfaceKind> = new Set([
  'composingNew',
  'report',
  'confirmEnd',
  // Holds a half-typed message, the identical reason the three above do —
  // see the gate-1 carve-out in syncProductSurfaces for the one place that
  // rule alone is not enough.
  'webform',
]);

function isUserInitiated(kind: SurfaceKind): boolean {
  return USER_INITIATED_SURFACES.has(kind);
}

/** The shape all three surfaces share, so one slot can hold any of them. */
interface ProductSurface {
  readonly node: HTMLElement;
  focus?(): void;
  destroy(): void;
}

export function createWidget(rawConfig: WidgetConfig): ChatWidget {
  const config = resolveConfig(rawConfig);
  const { store, rest } = createWidgetStore(config);
  const localParticipantId = config.identity.userId;

  /**
   * Whether this visitor is a GUEST — i.e. nobody the host page has vouched
   * for.
   *
   * A guest is "no host-asserted identity", NOT "no userId". Every visitor has
   * a `userId` (a guest's is an anonymous handle the host minted), so the
   * presence of one says nothing. The single discriminator in this SDK is
   * `identity.profile`: supplying it is the host asserting, under its own
   * publishable key, who this person is — and it is the same fact `client.ts`
   * keys `identityProfile`/`identitySync` off, so `POST /identify` fires for
   * exactly the visitors this is `false` for. Derived once, named, and passed
   * around, rather than re-deriving `config.identity.profile === undefined` at
   * each gate: two derivations of one fact is how the pre-chat form ended up
   * shown on one path and not the other.
   *
   * What it gates: the merchant's `preChatFields`, on all THREE surfaces that
   * render them — the standalone gate, the new-conversation form, and the
   * out-of-hours offline form. Three, because two of them once carried the
   * check and the third did not, and the one without it happened to be the
   * branch that outranks the other two. A logged-in visitor's details already
   * reach the contact record without being retyped — `POST /identify`
   * (name/email/phone/city/country/device, create-or-update) over
   * `createIdentitySync`, plus `captureContactInfo` below, which runs for
   * EVERY visitor and carries the watermarked IP, the raw user agent and
   * best-effort geolocation onto the session. Asking a signed-in customer to
   * type their name again is asking for something the server already has.
   *
   * What it deliberately does NOT gate: the offline form's own two built-in
   * fields (`ui/offline-form.ts`'s Name and "Email or phone"). Those are not
   * the merchant's pre-chat questions — they are the reply channel for a
   * message that will be answered hours later, by a human reading a flattened
   * body, out of band from any live session. The identity a host asserted on
   * this page view is not something that reply can be addressed to, and an
   * out-of-hours message with nowhere to send the answer is worse than one
   * redundant field. Narrowing that is a change to the offline path's own
   * contract, not to this flag's.
   */
  const isGuest = config.identity.profile === undefined;

  const root = createWidgetRoot(`${STYLES}\n${themeCss(config)}`);
  const { host, shadow } = root;
  host.setAttribute('data-side', config.side);
  // Stamped for every value including `auto`, which the CSS treats as "no
  // opinion" (see ui/styles.ts). Always writing it — rather than removing the
  // attribute for `auto` — keeps this a plain assignment with no branch, and
  // leaves the resolved scheme readable on the element for anyone debugging a
  // merchant's page.
  host.setAttribute('data-theme', config.theme);
  host.setAttribute('data-position', config.position);
  host.setAttribute('data-launcher', config.launcher);
  host.setAttribute('data-design', config.design);

  let presentation: ResolvedPresentation = 'bubble';
  /**
   * The launcher's current shape.
   *
   * Mirrored in a local rather than read back off the host attribute because
   * {@link syncLauncher} needs it on every unread change, and because published
   * config can replace it after mount — so `config.launcher` is only ever the
   * BOOT value, not the current one.
   */
  let launcherStyle: LauncherStyle = config.launcher;
  /** Mirrored for the same reason as {@link launcherStyle}: a publish can replace it. */
  let design: WidgetDesign = config.design;
  /**
   * The merchant's own line under the title, or `''` for none.
   *
   * Mirrored for the same reason as {@link design}, and read by
   * {@link syncConnection} rather than written into the DOM once: the slot it
   * occupies belongs to the connection status, which repaints on every
   * transport change, so a value written here directly would be overwritten
   * by the next reconnect.
   */
  let subtitle = config.subtitle;
  let open = false;
  let trap: FocusTrap | null = null;
  let restoreFocus: (() => void) | null = null;
  let destroyed = false;

  /**
   * Every {@link whenHistorySettles} wait still in flight, keyed by its own
   * cancel function.
   *
   * `destroy()` cannot reach into a pending promise, and the `store.select`
   * teardown the store does on its own way out settles nothing — the promise
   * would simply stay pending forever with the whole `selectSession` frame
   * behind it. So each wait registers the one call that releases it, and
   * teardown drains the set.
   */
  const pendingHistorySettles = new Set<() => void>();

  /**
   * The id of the session an agent closed, or `null` while the conversation
   * is live.
   *
   * Held here rather than read off `ChatState` because the close *reason* —
   * which decides both whether to say anything at all (`SWITCHED` parks the
   * session rather than ending it) and what to say — arrives only on the
   * §6.5 `sessionClosed` event. `ChatSession` carries `closedAt` but not the
   * reason.
   *
   * The id, not a boolean, so the session-id subscription below can tell "a
   * new conversation replaced the closed one" from "the same closed one is
   * still on screen".
   */
  let closedSessionId: string | null = null;
  /**
   * The id of a session THIS TAB watched get closed with a PARKED reason
   * (`SWITCHED` — §12.5: the customer, or another of their own tabs/devices,
   * started a different conversation; nobody ended this one) — or `null`.
   *
   * Exists for the same reason `closedSessionId` does, and is deliberately
   * its own variable rather than folded into it: `closedSessionId` is "tell
   * the customer their conversation ended" and must stay empty for a parked
   * close (`isParkedCloseReason` already gates it, below). This is the
   * opposite list — "a status of CLOSED/RESOLVED on THIS session must NOT be
   * read as genuinely over" — and it is consulted by `syncProductSurfaces`'s
   * CSAT-due check and `syncScreens`'s ended-footer check, neither of which
   * used to look past `session.status` at all. Before this exi​sted, a
   * session SWITCHED-closed while still on screen in this tab was
   * indistinguishable, to both of those, from one an agent had genuinely
   * resolved — the CSAT survey and "Reopen / Start new" footer would offer
   * to rate and re-litigate a conversation nobody actually ended.
   *
   * Same scoping limitation `closedSessionId` already accepts: only a LIVE
   * `sessionClosed` event can supply the reason (see that variable's own
   * doc), so a session reached cold — a reload, or picking a past
   * conversation from Messages — that happens to have been SWITCHED rather
   * than genuinely resolved is not caught here. Nothing on the wire or in
   * `ChatSession` carries a close reason for a session not live-witnessed
   * closing, so no purely client-side check can close that gap.
   *
   * ── It is no longer the everyday case ─────────────────────────────────
   *
   * Under the current chat-service contract `startNewSession` leaves the
   * previous conversation EXACTLY as it was — no close, no status change, no
   * system message, no `session.closed` frame — and a session becomes CLOSED
   * only when the customer or an agent ends it. So the routine source of a
   * SWITCHED close is gone, and a customer may now hold more than one
   * non-closed conversation at once.
   *
   * Nothing in this file may therefore assume that starting a conversation
   * ended the last one. Concretely, and each verified against the code that
   * reads it: this latch simply stays `null` (it only ever SUPPRESSES, so an
   * unset one shows more, never less); `closedSessionId` and
   * `messageList.setClosure` are driven by the event and stay silent with no
   * event to drive them; the CSAT card and the ended footer both key off
   * `endedSession`, which is `status`-driven and reads the still-open
   * predecessor as live, which it is. What DID break is the conversation
   * LIST — it was fetched once and never again, so the predecessor kept
   * rendering the status it had when the panel first opened; see
   * `refreshSessions`.
   *
   * ── Why it survives anyway ────────────────────────────────────────────
   *
   * Not dead state: `SWITCHED` is still a live close reason on the wire and
   * still reaches this handler. chat-service's reactivation path (a customer
   * typing into a terminal session reactivates it and SWITCHED-closes their
   * other open one) emits it, and so does an older deployment of the service
   * that has not taken the change above — a widget is embedded on pages that
   * outlive any one backend release, so "the current server no longer sends
   * this" is not something this file may assume. What it costs to keep is one
   * comparison; what removing it would cost is the difference between rating
   * a conversation and rating one nobody ended.
   */
  let parkedSessionId: string | null = null;
  /**
   * An agent opened a conversation while the panel was shut, and the customer
   * has not looked at it yet.
   *
   * A widget-local flag rather than anything in `ChatState`, because it
   * describes this UI's own "you have not seen this yet", not a fact about the
   * session — a second widget on another tab has its own answer. Cleared by
   * `openPanel`, which is the customer seeing it.
   */
  let agentInitiated = false;
  /** One escalation in flight at a time — see {@link requestHumanAgent}. */
  let requestingAgent = false;
  let reconnecting = false;
  let lastAutoReconnectAt = 0;

  /**
   * What the browser says about connectivity, mirrored so the status can be
   * recomputed from an event rather than polled.
   *
   * Guarded because this file is imported in environments without a
   * `navigator` (SSR bundling a host page), where "assume online" is the only
   * answer that does not put a false offline notice on a server render.
   */
  let online = isNavigatorOnline();

  /**
   * Consecutive failed connection attempts, reset on every successful connect.
   *
   * Counted from core's `reconnecting` event, which fires once per scheduled
   * retry, rather than derived from `connectionState` — the state cycles
   * `connecting → reconnecting → connecting` indefinitely, so it says whether
   * an attempt is in flight but never how many have already failed. That
   * missing number is precisely what separates "connecting normally" from the
   * indefinite "Connecting…" the customer reported.
   */
  let failedAttempts = 0;

  /**
   * The customer has opened the panel at least once, so the conversation list
   * is something this widget maintains.
   *
   * Not "has been fetched once" any more — see {@link refreshSessions}. It is
   * the arming latch: before the first open a widget nobody looked at costs
   * the host page nothing, and after it every fetch goes through the one
   * serialised path below.
   */
  let sessionsRequested = false;
  /**
   * A `listSessions` call is in flight.
   *
   * Every fetch of the list — the first one included — is serialised behind
   * this. `listSessions` writes `ChatState.pastSessions` by WHOLESALE REPLACE
   * (§9.4), so two overlapping GETs are two writers of one value with no
   * ordering guarantee between them: let the first-open fetch and a
   * close-driven refresh run concurrently and the older page can land last and
   * reinstate exactly the stale statuses defect 4 is about. One at a time is
   * the cheapest way to make "last write wins" mean "latest answer wins".
   */
  let sessionsInFlight = false;
  /**
   * Something asked for a refresh while one was in flight — re-issue once it
   * lands.
   *
   * COALESCED, not dropped and not queued N-deep. Dropping was wrong: end a
   * conversation and immediately start another and the second refresh was
   * discarded, so the list settled on a page fetched before the new
   * conversation existed and stayed that way. Queueing each caller would spend
   * a round trip per event in a burst to display the same final page. One
   * pending re-fetch answers every caller that arrived during the flight,
   * because they all want the same thing: the list as it is once this settles.
   */
  let sessionsRefreshQueued = false;
  /**
   * The screen a fresh panel opens on, and the one `close()` resets back to.
   *
   * `'home'` for almost everyone — see the routing rule "launcher opens ->
   * Home". The one exception is a host that passed `sessionId`: it has
   * already named the conversation it wants on screen, and landing on a
   * chooser-like Home instead would override an explicit instruction. This
   * is screen flow, not guest detection — the one guest-facing gate is
   * `sessions.length > 0` inside `ui/messages-screen.ts`'s and
   * `ui/home-screen.ts`'s own empty states, and there is no second one
   * anywhere in this package.
   */
  const initialScreenName: ScreenName =
    (config as any).initialScreen ??
    ((config as any).target !== undefined || config.sessionId !== undefined
      ? 'conversation'
      : 'messages');

  const report = (error: unknown): void => config.onError(error);

  // ── published config ──────────────────────────────────────────────────
  //
  // Fetched, never awaited. `mount()` is synchronous and stays that way: a
  // widget that waited for a network round trip before painting would be a
  // blank launcher on every cold load, and — because `WIDGET_ALLOWED_ORIGINS`
  // is fleet-wide rather than per-tenant — a PERMANENTLY blank one on any
  // storefront whose origin nobody remembered to add. So the widget renders
  // the host's own config immediately and upgrades in place if the fetch
  // lands.
  //
  // Everything below reads `remote` through this holder rather than
  // capturing it, because it is replaced once, asynchronously, after mount.
  let remote: RemoteConfig = DEFAULT_REMOTE_CONFIG;
  /**
   * The chooser's one read of `remote` — see `entryFor`. Re-derived
   * alongside `remote` itself (`applyRemoteConfig`), never independently:
   * two places deciding what the six rows mean is how they drift.
   */
  let entry: ResolvedEntry = entryFor(DEFAULT_REMOTE_CONFIG);
  /** When `entry` was last refreshed — the clock {@link SUPPORT_STALE_MS} reads. */
  let remoteFetchedAt = 0;

  /**
   * The last unread count seen, so the chime fires on a RISE and nothing else.
   * Seeded from the store rather than from 0 — see the selector that reads it.
   */
  /** One close in flight at a time — the round trip is long enough to double-tap. */
  let endingConversation = false;
  /**
   * How many conversation-opening exchanges are on their way: `startNewSession`
   * has been called and the first `sendMessage` into the new session has not
   * landed yet.
   *
   * Exists for the pre-chat gate. `startNewSession` resolves on the new
   * session's `connection.ack`, at which point `state.messages` is empty and
   * the session id has changed — so the id/status subscription re-runs
   * `syncProductSurfaces` in exactly the window where "pre-chat enabled, no
   * answer yet, no messages" is momentarily true, and the gate flashed (a
   * Common Questions tap) or took over outright (the new-conversation form).
   * While this is above zero the gate is skipped: the opening line IS the
   * first message, there is nothing to gate. Once it lands
   * `messages.length > 0` holds and the gate cannot fire for that session
   * anyway; on failure the `finally` releases it and the caller's own error
   * path stands.
   *
   * A COUNT rather than a boolean because two of these can overlap: a
   * customer who presses Back while `startNewSession` is still in flight and
   * then taps a Common Question has two opening exchanges alive at once, and
   * a shared boolean would let the second one's `finally` re-arm the gate on
   * an empty session while the first was still mid-exchange — precisely the
   * window the latch exists to cover.
   */
  let openingLinesInFlight = 0;
  let lastUnread = store.getState().unreadCount;
  const chime = createChime(config.onError);

  /**
   * This VISITOR's own preference about noise, remembered per browser.
   *
   * Not a merchant setting and not synced anywhere: `behaviour.sound` is the
   * merchant deciding whether a chime exists at all, and this is the person
   * in front of the screen deciding they have heard enough of it. Both have to
   * agree before anything plays — see the unread selector.
   *
   * Keyed per publishable key like the consent record, so two tenants on one
   * browser cannot mute each other. A read that fails is "not muted", which is
   * the same as a first visit.
   */
  const MUTE_KEY = `chatsdk:${config.auth.publishableKey}:muted`;
  let muted = false;
  try {
    muted = globalThis.localStorage?.getItem(MUTE_KEY) === 'true';
  } catch {
    // Site data blocked. The visitor is simply not muted, and can mute again.
  }

  const unavailable = createUnavailable({
    // The SAME path the Reconnect control uses. A second retry route would be
    // a second set of rules about when retrying is even allowed, and core
    // already parks deliberately in states where it must not be forced.
    onRetry: () => reconnect('manual'),
  });

  const headerMenu = createHeaderMenu({
    onStartNew: () => openNewConversationFlow(),
    onEndConversation: () => endConversation(),
    onReportIssue: () => openReportIssue(),
    onMuteChange: (next) => {
      muted = next;
      try {
        globalThis.localStorage?.setItem(MUTE_KEY, String(next));
      } catch {
        // Refused storage is not worth failing a mute over: it holds for this
        // page either way, and is simply forgotten on the next load.
      }
    },
  });

  /**
   * Releases whatever `behaviour.autoOpen` armed — a timer, a pointer
   * listener, or nothing. Replaced wholesale each time config lands, and run
   * on `destroy`.
   *
   * A no-op by default rather than `null`, so neither caller has to branch.
   */
  let releaseAutoOpen: () => void = () => undefined;

  /**
   * Arms the merchant's chosen self-opening behaviour.
   *
   * ── Why this fires at most once, and never after the visitor has acted ───
   *
   * Both triggers are one-shot. A panel that reopens itself after somebody
   * closed it is not a greeting, it is an argument — and the customer closing
   * it is the clearest possible statement that they did not want it. So the
   * arming is released the first time it fires AND the first time the panel is
   * opened by any other route, including by hand.
   */
  function armAutoOpen(mode: AutoOpen, delaySec: number): void {
    releaseAutoOpen();
    releaseAutoOpen = () => undefined;
    if (mode === 'never' || open) return;

    // Fires only while the panel is still shut and the widget is still alive.
    // Both are checked at FIRING time rather than at arming time: seconds pass
    // in between, and the visitor may have opened it themselves meanwhile.
    const fire = (): void => {
      releaseAutoOpen();
      releaseAutoOpen = () => undefined;
      if (!destroyed && !open) openPanel();
    };

    if (mode === 'delay') {
      const timer = setTimeout(fire, delaySec * 1000);
      releaseAutoOpen = () => clearTimeout(timer);
      return;
    }

    // 'exit-intent' — the pointer heading for the browser chrome.
    //
    // Bound to `document`, and gated on a mouse: `mouseout` toward the top of
    // the viewport is the conventional signal, and it is meaningless on a
    // touch device, where the pointer never leaves because there is no
    // pointer. Rather than approximate it with something a merchant did not
    // choose (a scroll depth, a back gesture), a touch visitor simply gets
    // nothing — the same answer `'never'` gives.
    const onMouseOut = (event: MouseEvent): void => {
      // `relatedTarget === null` means the pointer left the document itself
      // rather than moving between two elements inside it.
      if (event.relatedTarget !== null || event.clientY > 0) return;
      fire();
    };
    document.addEventListener('mouseout', onMouseOut);
    releaseAutoOpen = () => document.removeEventListener('mouseout', onMouseOut);
  }
  const remoteConfigAbort = new AbortController();

  /** Applies the parts of published config that are safe to change in place. */
  const applyRemoteConfig = (next: RemoteConfig): void => {
    remote = next;
    // The chooser's own read, refreshed in lockstep with `remote` — never
    // independently, or the two could disagree about which of the six rows
    // is current. `remoteFetchedAt` is what the open-panel staleness check
    // (`SUPPORT_STALE_MS`, below) reads.
    entry = entryFor(next);
    remoteFetchedAt = Date.now();

    // An attribute and a CSS rule rather than a flag threaded into
    // `message-list.ts`: that component owns WHEN the indicator shows (the
    // `typing.isTyping` state), and this setting is about whether it exists at
    // all — two different questions, and giving the component both would make
    // every one of its tests construct a config it does not otherwise need.
    // `display: none` also takes it out of the accessibility tree, so the
    // screen-reader label goes with it, which is what "turned off" has to mean.
    host.setAttribute('data-typing', next.typingIndicator ? 'on' : 'off');

    // Armed only now, never at mount: `autoOpen` is a merchant's setting and
    // arrives with the config, so arming before it lands could only ever use
    // the built-in default — and the built-in default is 'never'.
    //
    // `openOnLoad` is the host's own switch and is deliberately NOT consulted
    // here: a host that asked for an open panel has already got one, and a
    // console setting cannot un-ask for it.
    armAutoOpen(next.autoOpen, next.autoOpenDelaySec);
    armGreeting(next.greeting ?? '', next.greetingDelaySec);
    consent.update(next.consentRequired, next.consentText ?? '');
    messageList.setTranscriptEmail(next.transcriptEmail);
    reportButton.hidden = !next.reportIssue;
    syncHeaderMenu();
    // The gate may have just opened or closed under the composer.
    syncComposer();

    // Accent goes on the host's inline style rather than by rewriting the
    // `<style>` element: an inline custom property outranks the `:host` rule
    // themeCss wrote, so this upgrades the theme without reparsing a sheet or
    // racing anything already using the old value.
    //
    // Guarded on the host having said nothing, which is the precedence rule
    // from remote-config.ts applied to a value that already went through
    // `resolveConfig`'s defaults — by this point `config.accent` is populated
    // either way, so `rawConfig` is the only place the distinction survives.
    if (rawConfig.accent === undefined && next.accent !== undefined) {
      host.style.setProperty('--dh-accent', cssColor(next.accent));
    }

    // The accent as it stands AFTER that, because the header's own foreground
    // is computed from it — a published accent that changed the brand colour
    // has to be able to flip the header's text from white to near-black with
    // it, or a merchant switching to a pastel gets an unreadable header.
    const accent =
      rawConfig.accent === undefined && next.accent !== undefined ? next.accent : config.accent;

    if (rawConfig.title === undefined && next.title !== undefined) {
      identityHeader.setFallbackTitle(next.title);
    }
    if (rawConfig.launcher === undefined && next.launcher !== undefined) {
      launcherStyle = next.launcher;
      host.setAttribute('data-launcher', next.launcher);
    }
    if (rawConfig.launcherLabel === undefined) {
      // The launcher's label falls back to the TITLE (see config.ts), so a
      // publish that renames the widget renames the tab with it — but only
      // when the host has not named the title itself, or a console save would
      // reach a string the host explicitly set through the back door.
      const label =
        next.launcherLabel ?? (rawConfig.title === undefined ? next.title : undefined);
      if (label !== undefined) launcherLabel.textContent = label;
    }
    // Both of the above change what the launcher SHOWS, and its accessible
    // name has to quote that — see syncLauncher's WCAG 2.5.3 note.
    syncLauncher(store.getState());

    // Rebuilt rather than patched, for the same reason `applyRemoteConfig`
    // rebuilds the chip row: three unrelated element shapes (svg / span /
    // img) share this slot, so "patch the one that is there" would be three
    // branches of DOM surgery to save one `replaceChildren` on a config
    // change that happens at most once per publish.
    if (rawConfig.launcherIcon === undefined && Object.keys(next.launcherIcon).length > 0) {
      launcherGlyph.replaceChildren(
        buildLauncherIcon({ ...config.launcherIcon, ...next.launcherIcon }),
      );
    }
    if (rawConfig.launcherShadow === undefined && Object.keys(next.launcherShadow).length > 0) {
      const shadow = { ...config.launcherShadow, ...next.launcherShadow };
      host.style.setProperty('--dh-launcher-shadow', launcherShadowCss(shadow, 'resting'));
      host.style.setProperty('--dh-launcher-shadow-lift', launcherShadowCss(shadow, 'lifted'));
    }

    if (rawConfig.design === undefined && next.design !== undefined) {
      design = next.design;
      host.setAttribute('data-design', next.design);
    }
    // Unconditional, unlike the fields above: even a publish that says nothing
    // about the header can still have moved the ACCENT the header is painted
    // from, and the foreground has to be recomputed against it either way.
    applyHeaderAppearance(
      rawConfig.header === undefined ? { ...config.header, ...next.header } : config.header,
      accent,
      rawConfig.logoUrl === undefined ? (next.logoUrl ?? config.logoUrl) : config.logoUrl,
    );
    if (rawConfig.thread === undefined && Object.keys(next.thread).length > 0) {
      applyThreadAppearance({ ...config.thread, ...next.thread });
    }
    if (rawConfig.subtitle === undefined && next.subtitle !== undefined) {
      subtitle = next.subtitle;
      // Repainted through the connection sync rather than written straight to
      // the node: that function owns this slot and would overwrite anything
      // put there behind its back on the very next transport event.
      syncConnection();
    }
    // Unconditional for the same reason `applyHeaderAppearance` is: the avatar
    // reads `logoUrl`, which a publish can move without saying anything about
    // `avatarMode` — and its out-of-hours gate reads `remote`, which this
    // whole function just replaced.
    applyHeaderAvatar(
      rawConfig.avatarMode === undefined ? (next.avatarMode ?? config.avatarMode) : config.avatarMode,
      rawConfig.avatarInitials === undefined
        ? (next.avatarInitials ?? config.avatarInitials)
        : config.avatarInitials,
      rawConfig.logoUrl === undefined ? (next.logoUrl ?? config.logoUrl) : config.logoUrl,
    );
    applyBranding(
      rawConfig.showBranding === undefined
        ? (next.showBranding ?? config.showBranding)
        : config.showBranding,
      rawConfig.brandingText === undefined
        ? (next.brandingText ?? config.brandingText)
        : config.brandingText,
      rawConfig.brandingUrl === undefined
        ? (next.brandingUrl ?? config.brandingUrl)
        : config.brandingUrl,
    );
    // An attribute rather than a custom property, because the scheme selects a
    // whole palette rather than setting one value — the same `[data-*]`
    // attribute-selector mechanism the presentation variants use.
    if (rawConfig.theme === undefined && next.theme !== undefined) {
      host.setAttribute('data-theme', next.theme);
    }
    if (rawConfig.position === undefined && next.position !== undefined) {
      host.setAttribute('data-position', next.position);
    }
    if (rawConfig.offsetX === undefined && next.offsetX !== undefined) {
      host.style.setProperty('--dh-offset-x', cssPx(next.offsetX, config.offsetX));
    }
    if (rawConfig.offsetY === undefined && next.offsetY !== undefined) {
      host.style.setProperty('--dh-offset-y', cssPx(next.offsetY, config.offsetY));
    }
    if (rawConfig.cornerRadius === undefined && next.cornerRadius !== undefined) {
      host.style.setProperty('--dh-radius', cssPx(next.cornerRadius, config.cornerRadius));
    }
    // Only when the host left `font` alone as well: `font: 'inherit'` is a
    // statement about the HOST's typography, and a merchant's face published
    // later must not quietly cancel it. Same precedence rule, one level up.
    if (
      rawConfig.fontFamily === undefined &&
      config.font !== 'inherit' &&
      next.fontFamily !== undefined
    ) {
      host.style.setProperty('--dh-font', fontStackFor(next.fontFamily));
    }

    // Rebuilt whole, not patched: the chip list is short, changes at most
    // once per publish, and a chip mid-tap should not be re-keyed under the
    // customer's finger — the same "rebuild wholesale" choice `openSurface`
    // makes for `surfaceHost`, for the same reason.
    commonQuestionsHost.replaceChildren(
      createCommonQuestions(next.commonQuestions, {
        onSelect: (question) => void startCommonQuestion(question),
      }).node,
    );
    syncScreens();
    // A publish can move the subtitle Home's CTA card quotes, or (once
    // `pastSessions` has already landed) nothing about the recent row at
    // all — cheap and idempotent either way, so it is simplest to always
    // re-run rather than track which specific fields changed.
    syncSessionSurfaces();

    // Config is what decides whether a pre-chat gate or an out-of-hours form
    // exists at all, so it is also what first puts one on screen.
    syncProductSurfaces();

    // `enabled: false` and out-of-hours HIDE_WIDGET both mean "no launcher on
    // this page". Handled by hiding rather than by tearing the widget down:
    // the host still holds a `ChatWidget` handle and calling `open()` on a
    // destroyed one should not be the price of a merchant toggling a switch.
    launcher.hidden = !shouldMount(next);
  };

  /**
   * Paints the hero header from a resolved appearance and accent.
   *
   * Inline custom properties, for the same reason the accent uses them: they
   * outrank the `:host` rule `themeCss` wrote, so a publish landing after
   * mount repaints without reparsing a stylesheet.
   *
   * Nothing here checks `design`. The tokens are written either way and the
   * `classic` header simply never reads them (see ui/styles.ts) — which keeps
   * the "is the header painted at all" decision in exactly one place instead
   * of two that could disagree.
   */
  function applyHeaderAppearance(header: HeaderAppearance, accent: string, logoUrl: string): void {
    host.style.setProperty('--dh-header-bg', headerBaseColor(header));
    host.style.setProperty('--dh-header-fg', headerForeground(header, accent));
    host.style.setProperty('--dh-header-layers', headerLayers(header));
    heroHeader.render(heroContentFrom(header, logoUrl));

    // `platform` only means anything when no explicit colour was set —
    // "borrow the site's colour" and "use this hex" are not both answerable.
    if (header.colorSource === 'platform' && header.backgroundColor.trim() === '') {
      borrowPlatformColor();
    }
  }

  /**
   * The brand inputs the avatar draws from when no agent is on the chat.
   *
   * Recorded by {@link applyHeaderAvatar} (mount, then every publish) so that
   * {@link syncHeaderAvatar} can repaint on a SESSION change too — an agent
   * joining knows nothing about `avatarMode`, and asking it to carry these
   * three strings around would put config plumbing on a session subscription.
   */
  let brandAvatar = {
    mode: config.avatarMode,
    initials: config.avatarInitials,
    logoUrl: config.logoUrl,
  };

  /** Records the published brand inputs, then repaints. */
  function applyHeaderAvatar(mode: AvatarMode, initials: string, logoUrl: string): void {
    brandAvatar = { mode, initials, logoUrl };
    syncHeaderAvatar();
  }

  /**
   * The header avatar's whole state machine, in precedence order:
   *
   *   1. OUT OF HOURS (`shouldCollectOffline`) — no avatar at all. The panel
   *      is showing the "leave a message" surface, and a face implies someone
   *      is there to answer. The same predicate `syncProductSurfaces` raises
   *      that surface from, so the two cannot disagree.
   *   2. An agent is on the chat — that person's letter avatar. Gated on
   *      core's `isHandledByCurrent`, the exact gate identity-header.ts names
   *      the handler with, so the face and the name beside it always agree
   *      about whether an agent is present (an absent `handledBy` and a stale
   *      one on a reactivated session both fail it — see that file's header).
   *   3. Otherwise — the merchant's configured brand face (logo or initials),
   *      or nothing when they configured neither.
   *
   * Mounted under EVERY design now. This used to skip the hero design on the
   * theory that its face row answers "who am I talking to" — but that row
   * only renders on Home, so a hero-design conversation had no avatar at all
   * (reported issue 9). Rebuilt rather than patched — see
   * {@link buildHeaderAvatar} for why the slot holds several shapes.
   */
  let activeConversationTitle: string | null = null;

  function syncHeaderAvatar(): void {
    const session = store.getState().session;
    let avatar: HTMLElement | null = null;
    if (!shouldCollectOffline(remote)) {
      const activeTitle = activeConversationTitle || config.title;
      const isCustomTitle =
        activeTitle &&
        activeTitle !== 'Chat with us' &&
        activeTitle !== 'Admin Support Chat' &&
        activeTitle !== 'Store Support & Chat' &&
        activeTitle !== 'Dhaam AI';
      if (isCustomTitle) {
        avatar = buildAgentAvatar(activeTitle);
      } else {
        avatar =
          session !== null && isHandledByCurrent(session)
            ? (buildAgentAvatar(session.handledBy?.displayName ?? '') ??
              buildHeaderAvatar(brandAvatar.mode, brandAvatar.initials, brandAvatar.logoUrl))
            : buildHeaderAvatar(brandAvatar.mode, brandAvatar.initials, brandAvatar.logoUrl);
      }
    }
    avatarHost.hidden = avatar === null;
    avatarHost.replaceChildren(...(avatar === null ? [] : [avatar]));
  }

  /**
   * The message this reply is addressed to, or `null`.
   *
   * Held here rather than in the composer because it is the WIDGET that calls
   * `sendMessage`, and the reference only ever travels on that call. The
   * composer renders the quote and knows nothing else about it.
   *
   * The excerpt and name are captured NOW, not at send time: they are what
   * the chip showed the customer, and the sent quote must match it — and by
   * send time the quoted message may have been evicted from the loaded page.
   */
  let replyingTo: { messageId: string; excerpt: string; senderName: string } | null = null;

  /**
   * The wire cap on a reply excerpt — the shape agreed with the console team:
   * `metadata: { kind: 'reply', replyTo: { messageId, excerpt, senderName } }`
   * with the excerpt at most 120 characters, ellipsis included.
   */
  const MAX_REPLY_EXCERPT = 120;

  function startReply(message: ChatMessage, senderName: string): void {
    // The excerpt is the message's own text, trimmed to one line's worth. Long
    // enough to identify which message, short enough not to become a second
    // transcript above the composer. An attachment-only message has no words —
    // its `content` is the attachment URL placeholder (§12.10), which would
    // quote a signed storage URL at the customer — so the file stands in.
    const raw = (message.content ?? '').trim().replace(/\s+/g, ' ');
    const text = message.attachment?.url !== undefined && raw === message.attachment.url ? '' : raw;
    const excerpt =
      text === ''
        ? 'Attachment'
        : text.length > MAX_REPLY_EXCERPT
          ? `${text.slice(0, MAX_REPLY_EXCERPT - 1)}…`
          : text;

    replyingTo = { messageId: message.id, excerpt, senderName };
    composer.setReplyTo({ senderName, excerpt });
    composer.input.focus();
  }

  function cancelReply(): void {
    if (replyingTo === null) return;
    replyingTo = null;
    composer.setReplyTo(null);
  }

  /**
   * Puts a message's text on the clipboard.
   *
   * Rejects rather than reporting: the caller is a menu item that announces
   * its own outcome, and `report` would swallow the failure and leave it
   * silently claiming success. `navigator.clipboard` is genuinely absent in
   * some embedded webviews and refused outright in others, so the rejection
   * path is real rather than defensive.
   */
  async function copyMessage(message: ChatMessage): Promise<void> {
    const text = message.content ?? '';
    if (text === '') throw new Error('Nothing to copy');
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      throw new Error('Clipboard unavailable');
    }
    await navigator.clipboard.writeText(text);
  }

  /** The conversation's backdrop, through the same inline-property route. */
  function applyThreadAppearance(thread: ThreadAppearance): void {
    const tokens = threadTokens(thread);
    host.style.setProperty('--dh-thread-bg', tokens.bg);
    host.style.setProperty('--dh-thread-layers', tokens.layers);
    host.style.setProperty('--dh-thread-size', tokens.size);
    host.style.setProperty('--dh-thread-repeat', tokens.repeat);
  }

  /**
   * Repaints the header in the host page's own colour, once the page is
   * finished loading.
   *
   * Deferred to `load` rather than sampled now, and that wait is the whole
   * correctness of it: the host's stylesheets may still be arriving when the
   * widget mounts, so sampling immediately locks in whatever the UNSTYLED
   * document happened to be — usually white, on a site whose brand is not.
   *
   * A `null` sample changes nothing, deliberately. It means the page has no
   * opaque colour to borrow, which is a real answer rather than a failure, and
   * the accent already on the header is the right thing to leave there.
   */
  function borrowPlatformColor(): void {
    const sample = (): void => {
      if (destroyed) return;
      const color = samplePlatformColor();
      if (color === null) return;
      host.style.setProperty('--dh-header-bg', cssColor(color));
      host.style.setProperty('--dh-header-fg', readableOn(color));
    };

    if (typeof document === 'undefined' || document.readyState === 'complete') {
      sample();
      return;
    }
    // `once`, and never removed on teardown: a one-shot listener on `window`
    // is released by the browser after it fires, and the `destroyed` guard
    // above covers the case where teardown wins the race.
    window.addEventListener('load', sample, { once: true });
  }

  void fetchRemoteConfig({
    apiUrl: config.apiUrl,
    publishableKey: config.auth.publishableKey,
    signal: remoteConfigAbort.signal,
  })
    .then((fetched) => {
      if (destroyed) return;
      if (fetched === null) {
        // Visible, not silent. This is the WIDGET_ALLOWED_ORIGINS trap: the
        // browser refuses to say why a cross-origin read failed, so the
        // message names the likeliest cause rather than pretending to know.
        report(
          new Error(
            'widget config could not be read — rendering local defaults. ' +
              'If this page is cross-origin to the chat API, check that its origin is in WIDGET_ALLOWED_ORIGINS.',
          ),
        );
        return;
      }
      applyRemoteConfig(fetched);
    })
    .catch(report);

  /**
   * How stale a held `support` entry may get before the panel opening
   * re-asks. `support.primary` flips at a shift boundary, and config is
   * otherwise fetched once, at mount — a tab left open across that boundary
   * would otherwise show a "Chat now" default the server would no longer
   * choose.
   *
   * No timer, no poll: a background re-check on someone else's storefront is
   * a cost the merchant did not agree to, and it would run on every page for
   * every visitor whether or not the panel is ever opened. Opening the panel
   * is the only moment the answer is about to be used — see the check beside
   * `requestSessions()` in `openPanel`, which states this same argument for
   * the session list.
   */
  const SUPPORT_STALE_MS = 5 * 60_000;

  /**
   * Re-asks `GET /widget/config` and applies whatever comes back — the same
   * two functions the boot path above already composes, extracted so they
   * have one caller more. No new machinery, no new state beyond
   * `remoteFetchedAt`.
   *
   * Resolves `true` iff a fresh config actually landed and was applied,
   * `false` otherwise — never rejects. The boolean is load-bearing for
   * `sendWebform`'s `CHANNEL_DISABLED` recovery (§4.4), which must tell "the
   * refresh failed, so we know nothing new" apart from "the refresh landed
   * and still disagrees with the 403": `entry`/`remote` are left EXACTLY as
   * they were on a failed refresh (`fetchRemoteConfig` already reports
   * nothing to `report()` on a `null`), so a caller that inferred success
   * from `entry` alone would silently read a stale-but-unchanged entry as a
   * fresh one.
   */
  function refreshRemoteConfig(): Promise<boolean> {
    return fetchRemoteConfig({
      apiUrl: config.apiUrl,
      publishableKey: config.auth.publishableKey,
      signal: remoteConfigAbort.signal,
    }).then((fetched) => {
      if (destroyed || fetched === null) return false;
      applyRemoteConfig(fetched);
      return true;
    });
  }

  // ── launcher ──────────────────────────────────────────────────────────
  const badge = el('span', { attrs: { class: 'dh-badge', hidden: true, 'aria-hidden': 'true' } });
  // `launcherLabel`, not `title` — they default to the same string, so the
  // sidebar tab reads exactly as it always did, but a merchant who wants a
  // short pill and a long header now gets both.
  const launcherLabel = el('span', {
    attrs: { class: 'dh-launcher-label' },
    text: config.launcherLabel,
  });
  /**
   * The slot the glyph lives in, so published config can swap it without
   * rebuilding the button — which would drop the click listener and, if the
   * customer happened to be mid-press, take the control out from under them.
   */
  const launcherGlyph = el('span', {
    attrs: { class: 'dh-launcher-glyph' },
    children: [buildLauncherIcon(config.launcherIcon)],
  });

  const launcher = el('button', {
    attrs: {
      class: 'dh-launcher',
      type: 'button',
      // Both states are required by the brief and by APG's disclosure pattern:
      // `aria-expanded` says whether the panel is showing, `aria-controls`
      // says which element it refers to.
      'aria-expanded': 'false',
      'aria-controls': 'dh-panel',
      'aria-label': 'Open chat',
    },
    children: [launcherGlyph, launcherLabel, badge],
    on: { click: () => toggle() },
  });

  // ── panel ─────────────────────────────────────────────────────────────
  const statusDot = el('span', { attrs: { class: 'dh-status-dot', 'aria-hidden': 'true' } });
  const statusText = el('span', { attrs: { class: 'dh-status-text' } });
  const status = el('div', {
    attrs: { class: 'dh-status', role: 'status', 'aria-live': 'polite' },
    children: [statusDot, statusText],
  });

  // Deliberately a sibling of `status`, not a child of it: `status` is a
  // `role="status"` live region, and a control inside one gets its label read
  // out as part of every status announcement.
  const reconnectButton = el('button', {
    attrs: { class: 'dh-reconnect', type: 'button', hidden: true },
    text: 'Reconnect',
    on: { click: () => reconnect('manual') },
  });

  const closeButton = el('button', {
    attrs: { class: 'dh-icon-button', type: 'button', 'aria-label': 'Close chat' },
    children: [icon(ICONS.close, 18)],
    on: { click: () => close() },
  });

  // There is deliberately NO visible "Talk to a human" button here. One
  // shipped briefly and was removed on the owner's call: the only escalation
  // path is the customer's own words — `asksForAHuman` on every send (the
  // composer's `onSend` below), which fires {@link requestHumanAgent}. A
  // persistent button invited every conversation to skip the bot, which is
  // the opposite of what the bot is for.

  /**
   * The way to a ticket without a conversation.
   *
   * Hidden until published config turns it on — see `reportIssue` in
   * remote-config.ts. Lives on the seam between the transcript and the
   * composer: it is the customer deciding the bot is not the route to their
   * answer, so it sits where they are about to type.
   */
  const reportButton = el('button', {
    attrs: { class: 'dh-report-open', type: 'button', hidden: true },
    text: 'Report an issue',
    on: { click: () => openReportIssue() },
  });

  /**
   * Slot for the "Common Questions" chip row (`ui/common-questions.ts`).
   *
   * Rebuilt whenever remote config changes (`applyRemoteConfig` below) —
   * `remote.commonQuestions` is not known at mount, only after the config
   * fetch lands. Mounted onto the Home screen (`homeQuestionsSlot`, below)
   * and shown/hidden by {@link syncScreens}, the one place that decides
   * whether tapping a chip still makes sense right now.
   */
  const commonQuestionsHost = el('div', { attrs: { class: 'dh-common-questions-host', hidden: true } });

  /**
   * The hero header's content block — logo, faces, greeting, sub-line.
   *
   * Shown only on the Home screen and only under `design: 'hero'` — see
   * {@link syncScreens}. It takes no callbacks and contains nothing pressable:
   * it used to build a call-to-action button wired to
   * {@link openNewConversationFlow}, but the hero only ever shows on Home and
   * Home always draws its own CTA card, so that was always a second card
   * making the same offer. `ui/hero-header.ts`'s module header records why
   * Home's is the one that stayed.
   */
  const heroHeader = createHeroHeader();

  /**
   * The header's avatar slot.
   *
   * A wrapper rather than the avatar itself, for the reason the launcher's
   * glyph is one: several element shapes (brand img / brand initials / an
   * agent's letter / nothing at all) share this position, and a publish or a
   * session change can swap between them. `replaceChildren` on an empty
   * wrapper is one line where patching in place would be that many branches
   * of DOM surgery.
   *
   * Mounted under the hero design too — see {@link syncHeaderAvatar} for the
   * state machine and for why the old "hero has its own face row" skip left
   * every hero-design conversation with no avatar at all.
   */
  const avatarHost = el('div', { attrs: { class: 'dh-avatar-host' } });

  /**
   * `behaviour.greeting`, shown while the transcript is still empty.
   *
   * `text` rather than any markup path: this is merchant free text arriving
   * over a public endpoint and landing in a shadow root on someone else's
   * checkout page.
   */
  const greetingBubble = el('p', { attrs: { class: 'dh-greeting', hidden: true } });
  let greetingDue = false;
  let greetingTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The consent notice, and the record of whether it has been answered.
   *
   * Its own storage adapter rather than the store's: `createWidgetStore` hands
   * core an adapter and does not expose it, and reaching through the store to
   * borrow one would couple this to core's internals for the sake of avoiding
   * a second `localStorage` handle — which is not a resource worth conserving.
   * Both use the same factory and the same documented `MemoryStorageAdapter`
   * fallback, so a browser with site data blocked behaves consistently: core
   * forgets the session, this forgets the consent, and neither throws.
   */
  const consent = createConsentGate(
    createBrowserStorageAdapter() ?? new MemoryStorageAdapter(),
    config.auth.publishableKey,
    { onAgree: () => syncComposer() },
    report,
  );

  /**
   * The platform credit under the composer.
   *
   * An `<a>` only when the merchant gave a URL that survives
   * {@link safeLinkUrl}; otherwise the same text as a plain span. Hidden
   * entirely by default — see `showBranding` in config.ts for why a widget
   * nobody has configured does not sprout a footer.
   *
   * `rel="noreferrer"` alongside `noopener`: this sits on a merchant's
   * checkout page, and the referrer would leak the URL of whatever page the
   * customer was buying from to whoever the credit points at.
   */
  const brandingLink = el('a', {
    attrs: { class: 'dh-branding-link', target: '_blank', rel: 'noopener noreferrer' },
  });
  const brandingText = el('span', { attrs: { class: 'dh-branding-text' } });
  const branding = el('div', {
    attrs: { class: 'dh-branding', hidden: true },
    children: [brandingText, brandingLink],
  });

  /** Paints the credit, or leaves it hidden. Re-run when a publish lands. */
  function applyBranding(show: boolean, text: string, url: string): void {
    const label = text.trim();
    // A footer switched on with nothing to say is still nothing to say.
    branding.hidden = !show || label === '';
    if (branding.hidden) return;

    const href = safeLinkUrl(url);
    brandingLink.hidden = href === null;
    brandingText.hidden = href !== null;
    if (href === null) {
      brandingText.textContent = label;
      return;
    }
    brandingLink.textContent = label;
    brandingLink.setAttribute('href', href);
  }

  /**
   * Who the customer is talking to.
   *
   * Its `node` IS the `<h2 id="dh-title">` — mounted in place of the h2 this
   * file used to build by hand, so the panel's existing
   * `aria-labelledby="dh-title"` keeps working with nothing to change and,
   * more importantly, so there is exactly one title element rather than a
   * component and a hand-built rival for the same job.
   *
   * Nothing here interprets `handledBy`. The two rules that are easy to get
   * wrong — an ABSENT handler means "render the configured title", and a
   * PRESENT one can still be stale on a session reactivated from CLOSED —
   * both live inside the component behind core's own `isHandledByCurrent`.
   * Adding any identity logic on this side would be the second source of
   * truth that design exists to prevent.
   */
  const identityHeader = createIdentityHeader(config.title);

  const messageList = createMessageList({
    onRetry: (message) => retry(message),
    onStartNewConversation: () => openNewConversationFlow(),
    onEmailTranscript: () => emailTranscript(),
    // Sent as the customer's own message, exactly as if they had typed it —
    // the bot suggested the words, but the person chose them. Routed through
    // the composer's own send path so a suggestion is subject to every rule a
    // typed message is, the consent gate and handoff keywords included.
    onQuickReply: (text) => void composer.submit(text),
    onCopyMessage: (message) => copyMessage(message),
    onReplyToMessage: (message, senderName) => startReply(message, senderName),
    // Read through `remote` at call time, never captured: a config publish
    // replaces `remote` wholesale, and the suggestion filter must judge by
    // the same list the composer's own keyword trigger is using right now.
    handoffKeywords: () => remote.handoffKeywords,
    onLoadOlder: () => {
      // `.catch`, not `void`: an unhandled rejection here surfaces on the
      // HOST's window and lands in the host's error tracker as a bug in their
      // page. Nothing this widget does may escape into that.
      store.client.loadOlderMessages().catch(report);
    },
  });

  const composer = createComposer({
    onCancelReply: () => cancelReply(),
    onSend: async (text) => {
      // SEND FIRST, then escalate, and only once the send has actually
      // settled. The customer typed a sentence and expects it to arrive;
      // swallowing it because it matched a keyword would lose the question,
      // and an agent picking the conversation up would inherit a handoff with
      // no context for it. A send that REJECTS escalates nothing, for the same
      // reason: there would be nothing in the transcript for them to read.
      //
      // The reply target is read and CLEARED before the await, not after: a
      // send that takes a second must not leave the quote chip on screen
      // looking like it still applies to whatever they type next, and a
      // rejected send must not silently re-address the retry.
      const addressedTo = replyingTo;
      cancelReply();
      // Both halves of the reference travel: `replyToMessageId` is the
      // protocol-native field core has always had on the send frame, and the
      // `reply` metadata is the RENDERABLE half — the exact shape agreed with
      // the console team (see `MAX_REPLY_EXCERPT`), following the same
      // metadata-kind precedent as `pre_chat` and `offline_message` below.
      // The excerpt rides along because the quoted message may not be in the
      // reader's loaded page at all.
      await store.client.sendMessage(
        text,
        addressedTo === null
          ? undefined
          : {
              replyToMessageId: addressedTo.messageId,
              metadata: {
                kind: 'reply',
                replyTo: {
                  messageId: addressedTo.messageId,
                  excerpt: addressedTo.excerpt,
                  senderName: addressedTo.senderName,
                },
              },
            },
      );
      // Only while the BOT is driving a conversation that is still live —
      // `botHoldsLiveConversation` owns that rule. Read AFTER the send has
      // settled, from fresh state, which is what stops a keyword escalating
      // a conversation a human is already handling — that would ask the
      // agent to hand off to themselves.
      if (
        botHoldsLiveConversation(store.getState()) &&
        asksForAHuman(text, remote.handoffKeywords)
      ) {
        requestHumanAgent();
      }
    },
    onSendAttachment: (file) => store.client.sendAttachment(file, { fileName: file.name }),
    onTyping: () => {
      try {
        store.client.startTyping();
      } catch (error) {
        // A typing intent that fails must never block the keystroke that
        // triggered it.
        report(error);
      }
    },
    onError: report,
  });

  // Trades places with `composer` — never stacks with it — once the session
  // on screen is CLOSED/RESOLVED and the CSAT survey is done or not due. See
  // this module's own header for why it is a sibling of the composer rather
  // than a fourth `ProductSurface`, and `syncScreens` below for exactly when
  // it shows.
  const endedFooter = createEndedFooter({
    onReopen: () => reopenConversation(),
    onStartNew: () => openNewConversationFlow(),
    onError: report,
  });

  /** Slot for whichever product surface is standing in for the conversation. */
  const surfaceHost = el('div', { attrs: { class: 'dh-surface-host', hidden: true } });

  // Declared HERE, beside the node they drive, rather than next to the
  // functions that read them: `showConversation()` runs during mount, well
  // before those functions appear, and consults `activeSurface` — so a
  // declaration further down leaves it in the temporal dead zone and every
  // single mount throws.
  /**
   * The one surface currently standing in for the conversation, if any.
   *
   * `openedFrom` is the screen the customer was actually standing on when it
   * took the slot. Recorded because `openSurface` NAVIGATES to the
   * conversation screen on its way in, so by the time a Cancel arrives
   * `screens.current()` says 'conversation' for every surface and can no
   * longer tell "backed out of a form I opened from Home" apart from "backed
   * out of a form I opened on top of my chat". See `cancelUserSurface`.
   */
  let activeSurface: {
    readonly kind: SurfaceKind;
    readonly view: ProductSurface;
    readonly openedFrom: ScreenName;
    /**
     * What this surface was built FOR, when its kind alone does not say.
     *
     * `openSurface` is idempotent by kind so a store tick cannot rebuild a
     * half-typed form; a surface whose `build()` closes over a SESSION —
     * `confirmEnd` does, over the one it is asking about — needs that
     * idempotence to notice when the session changed underneath it, or the
     * second ask hands back the first ask's closure. See `openSurface`.
     */
    readonly key: string | undefined;
  } | null = null;
  /** The customer answered or skipped the pre-chat gate, for this widget's lifetime. */
  let preChatAnswered = false;
  /**
   * The session THIS widget instance rated, in this page view — the
   * same-session fast path in front of {@link csatBySession}.
   *
   * It is deliberately no longer the ONLY memory of "already rated". It lives
   * in a closure, so a reload, a second tab or another device starts with it
   * back at `null` — and because `POST /chat/sessions/{id}/csat` is an upsert
   * server-side, the survey re-armed over every already-rated conversation and
   * quietly overwrote the score the customer had given. That is defect 5. What
   * it still earns its place for is the window this render loop actually owns:
   * the answer is known synchronously the moment the POST resolves, so no
   * repaint can flash the survey back while a round trip re-learns it.
   */
  let ratedSessionId: string | null = null;
  /**
   * What the SERVER says about each session's rating, keyed by session id.
   *
   * Five states, and the three that are not answers matter as much as the two
   * that are:
   *   `loading` — the lookup is in flight. Show nothing; a survey that
   *               appears and then locks itself is a survey the customer may
   *               already have started answering.
   *   `unrated` — a real answer (`200 {rated: false}`). Offer the survey.
   *   `rated`   — a real answer. Show it filled and locked, never again
   *               offering a control that would overwrite it.
   *   `unknown` — the lookup FAILED. Also show nothing: see
   *               {@link csatFor} for why that is the only safe direction.
   *   `unsupported` — this chat-service has no CSAT read route at all. Offer
   *               the survey on the pre-change terms (once per session per
   *               page view, remembered by `ratedSessionId` alone) rather
   *               than withholding it: see {@link csatFor}.
   *
   * Per widget instance, not persisted: `localStorage` would be a third
   * memory to keep in step, and the server already holds the authoritative
   * one. The map exists so one lookup per session serves every repaint.
   */
  const csatBySession = new Map<string, CsatLookup>();
  /**
   * The customer has actually OPENED a conversation, rather than merely
   * having one on the server.
   *
   * chat-service mints or resumes a session on `connection.hello` (its
   * `handleHello` calls `createSession`, which reuses an active row or
   * creates one), so `state.session` is a live, zero-message session for a
   * brand-new visitor from the moment the socket acks — at mount, before the
   * panel has ever been opened. "A session exists" is therefore NOT the same
   * question as "this visitor is looking at a conversation", and the pre-chat
   * gate needs the second one: asked the first, it went up at mount and
   * `openSurface` navigated the panel off Home.
   *
   * Set only where the widget deliberately PUTS a conversation on screen —
   * `showConversation`, the one funnel `selectSession`, `startCommonQuestion`
   * and a closing surface all go through — plus at mount for a host that
   * named a `sessionId` and has therefore already said which conversation it
   * wants shown. A SURFACE taking the slot deliberately does not count even
   * though `openSurface` navigates: a new-conversation form opened from Home
   * is a detour, and a gate raised behind it once the customer backs out is
   * the same yank off Home in a different coat.
   */
  let conversationOpened = initialScreenName === 'conversation';

  /**
   * The screen stack — home / messages / conversation. See `ui/screens.ts`'s
   * own header for the back-history rules; `onChange` is the one place every
   * screen-driven repaint fans out from (`syncScreens`, defined below).
   */
  const screens = createScreens({
    initial: initialScreenName,
    onChange: (name) => {
      // Leaving the conversation screen abandons whatever the customer had
      // open in its surface slot — see `discardUserSurface` for why nothing
      // else would ever clear it.
      if (name !== 'conversation') discardUserSurface();
      syncScreens();
      // Focus follows navigation, same as any single-page app's route
      // change — but only while the panel is actually open and visible;
      // stealing focus into a closed/animating panel would pull it out of
      // whatever the host page was doing. `conversation` manages its own
      // focus at each of its own entry points (`selectSession`,
      // `openSurface`'s `view.focus?.()`) rather than here, because arriving
      // there means either an EXISTING conversation (focus the composer) or
      // a fresh surface (focus its own first field) — two different targets
      // this single callback cannot tell apart.
      // Everything below is about a screen the customer can actually SEE, so
      // it waits on the panel being open — `close()` calls `screens.reset`,
      // which lands here too, and neither refetching a list nor moving focus
      // is something a closing panel should do.
      if (!open) return;
      // Home and Messages are the two screens that RENDER a conversation's
      // status, and arriving on one is the moment that status has to be
      // right. Not belt-and-braces over the `sessionClosed` handler: core
      // emits that event only for the session currently in state, and a
      // customer may now hold several open conversations, so an agent closing
      // one they are not looking at reaches this widget through nothing else.
      // Bounded by a customer action, and collapsed by `refreshSessions`'s own
      // in-flight latch, so flipping between the two tabs cannot fan out.
      if (name === 'home' || name === 'messages') refreshSessions();
      if (name === 'messages') messagesScreen.focus();
      else if (name === 'home') panel.focus({ preventScroll: true });
    },
  });

  const nav = createNav((tab: NavTab) => screens.swap(tab));

  const homeScreen = createHomeScreen({
    onStartNew: () => openNewConversationFlow(),
    onOpenConversation: (sessionId) => void selectSession(sessionId),
    onSeeAll: () => screens.swap('messages'),
    onLeaveMessage: () => openWebform(),
    // Row 2's "Try live chat anyway": hand the visitor to a REAL,
    // authenticated socket session rather than the anonymous submit path —
    // discarding the CTA/alt's own slot first, since `openNewConversationFlow`
    // is about to claim it for a different surface entirely.
    onChooseChat: () => {
      discardUserSurface();
      openNewConversationFlow();
    },
  });
  // Moved onto Home rather than rebuilt — see home-screen.ts's own header on
  // why this screen arranges the shared component instead of owning a second
  // renderer for it. A one-time move, not a per-render one: `commonQuestions
  // Host`'s OWN visibility (set in `syncScreens`) is still what decides
  // whether anything inside this slot is ever seen, exactly as it did when
  // this node sat directly in the panel.
  homeQuestionsSlot(homeScreen).hidden = false;
  homeQuestionsSlot(homeScreen).appendChild(commonQuestionsHost);

  // Tells the hero where Home's own scroll container is, so it can collapse
  // into its pinned compact bar once the visitor scrolls it away from the
  // top — see ui/hero-header.ts's module header for the whole mechanism.
  // `homeScreen.node` (`.dh-home`) IS that container: `ui/styles.ts` gives it
  // `flex: 1; overflow-y: auto` as the one child of the panel's column
  // allowed to scroll while Home is showing, the same role `.dh-messages` and
  // `.dh-surface-host` play for the screens they stand in for.
  heroHeader.watchScroll(homeScreen.node);

  const messagesScreen = createMessagesScreen({
    onOpenConversation: (sessionId, displayName, subtitleText) => void selectSession(sessionId, displayName, subtitleText),
    onStartNew: () => openNewConversationFlow(),
    userRole: (config as any).userRole,
  });

  const backButton = el('button', {
    attrs: {
      class: 'dh-icon-button dh-back',
      type: 'button',
      'aria-label': 'Back',
      hidden: true,
    },
    children: [icon(BACK_ICON, 18)],
    on: { click: () => screens.back() },
  });

  /**
   * The composer's ordinary prompt, read from the component rather than
   * restated here. Restating it would put the same sentence in two files, and
   * the copy would drift the first time either one was edited alone.
   */
  const composerPlaceholder = composer.input.placeholder;

  /**
   * The bar that says the network is gone and the messages are safe.
   *
   * Built here, beside the panel it belongs to, rather than with the other
   * screens: it is not a screen. It survives every navigation between Home,
   * Messages and a conversation, because losing your signal is a fact about
   * the whole panel.
   */
  const offlineBanner = createOfflineBanner();

  const panel = el('div', {
    attrs: {
      class: 'dh-panel',
      id: 'dh-panel',
      'data-open': 'false',
      role: 'dialog',
      // True because focus really is trapped while open — see ui/focus.ts.
      // Claiming it without the trap would tell a screen-reader user the page
      // behind is inert when it is not.
      'aria-modal': 'true',
      'aria-labelledby': 'dh-title',
      // Removed from the tab order and the a11y tree while closed. Without
      // this a keyboard user tabs into an invisible panel, and a screen reader
      // reads a conversation that is not on screen.
      'aria-hidden': 'true',
      // Focusable ONLY programmatically (never by Tab) — the one thing this
      // enables is `panel.focus()` landing somewhere real when a navigation
      // lands on Home, which has no single "first field" the way Messages
      // (its search box) and a conversation (its composer) each do.
      tabindex: '-1',
    },
    children: [
      el('span', { attrs: { class: 'dh-grip', 'aria-hidden': 'true' } }),
      // ── The brand band ───────────────────────────────────────────────
      //
      // The header row, the offline banner and the hero, wrapped in ONE
      // element so that under `design: 'hero'` the merchant's colour and
      // gradient are ONE paint rather than three. Why one paint on the
      // parent is not the same thing as the same paint on each child — the
      // restarting fade, the seam it left, and what that costs in exchange —
      // is told once, in ui/styles.ts's
      // `:host([data-design="hero"]) .dh-brand-band` rule. This file owns
      // only the SHAPE.
      //
      // A plain `div` with no role, no label and no tabindex, deliberately:
      // it is a paint surface and a layout box, and it must be invisible to
      // the a11y tree and to the focus order. The `<header>` landmark stays
      // where it was, on the row that actually is one.
      //
      // Nothing here may gain a `z-index`, a `transform`, a `filter` or
      // anything else that opens a stacking context — see `.dh-brand-band`
      // in ui/styles.ts for the header menu that would be trapped by one.
      el('div', {
        attrs: { class: 'dh-brand-band' },
        children: [
          el('header', {
            attrs: { class: 'dh-header' },
            children: [
              // Shown only once there is somewhere to go back TO — see
              // `screens.ts`'s own back-stack rules and this file's `onChange`
              // above, which is the one place `backButton.hidden` is set.
              backButton,
              avatarHost,
              el('div', { children: [identityHeader.node, status] }),
              el('div', { attrs: { class: 'dh-header-spacer' } }),
              reconnectButton,
              headerMenu.node,
              closeButton,
            ],
          }),
          // Above the hero header and every screen, because it outranks all
          // of them: a customer with no signal needs to know that before they
          // read a greeting. Its own band rather than a line inside the
          // header — see ui/offline-banner.ts for why the status line under
          // the title was not enough on its own. Still directly under the
          // header row, which is the position its live region's usefulness
          // depends on; only its parent changed.
          offlineBanner.node,
          // Directly under the header row and painted as its continuation, so
          // the two read as one tall header rather than as a banner stacked
          // on a bar — which is now literally true rather than approximated,
          // because the paint belongs to the wrapper around both.
          // Shown only on Home — see `syncScreens`.
          heroHeader.node,
        ],
      }),
      // The three screens `ui/screens.ts` knows about. `conversation` has no
      // node of its own here: it is whichever of surfaceHost/messageList.log
      // is showing, exactly the same "stand in for the transcript" mechanism
      // the product surfaces already used before screens existed.
      homeScreen.node,
      messagesScreen.node,
      // A form or survey standing IN PLACE OF the conversation, never on top
      // of it — a chooser and the conversation it chooses between are
      // alternatives, not a stack.
      // Above every other pane, and replacing all of them: when the service
      // cannot be reached there is no conversation, no list and no form worth
      // showing behind it.
      unavailable.node,
      surfaceHost,
      messageList.log,
      // Above the chips and below the transcript: the greeting is the first
      // thing said, and the chips are the answers to it.
      greetingBubble,
      // Sits right where the transcript is still empty — it reads most
      // naturally right above where the customer is about to type, not
      // competing with the header or buried inside the (empty) log.
      reportButton,
      // Directly above the composer it gates, so the notice and the control it
      // disables are read as one thing rather than as an unrelated banner.
      consent.node,
      composer.node,
      // Same seam as the composer above it — `syncScreens` hides whichever
      // of the two does not apply, and only one of them is ever visible.
      endedFooter.node,
      // Under the composer, which is where a credit belongs: it is the least
      // important thing in the panel and must never sit between the customer
      // and the conversation.
      branding,
      // The bottom tab bar. Shown on Home/Messages, hidden while a
      // conversation is showing — same bottom-of-panel real estate the
      // composer needs there, and a customer typing does not also need a
      // tab bar competing for the same row. See `syncScreens`.
      nav.node,
      messageList.liveRegion,
      // Its own channel, deliberately not folded into `status` or the message
      // log's region: `status` re-announces on every connection change, and
      // the log's region is busy narrating ticks. See identity-header.ts.
      identityHeader.liveRegion,
    ],
    on: {
      keydown: (event) => {
        const key = event as KeyboardEvent;
        if (key.key !== 'Escape') return;
        // Stopped here so the host page's own Escape handler does not also
        // fire — closing their modal because the user dismissed our chat.
        key.stopPropagation();
        key.preventDefault();
        close();
      },
    },
  });

  shadow.append(launcher, panel);

  // Down HERE, not beside its own definition further up, and for the reason
  // `activeSurface` is declared where it is: this call reaches `heroHeader`,
  // which is built with the panel above, so running it any earlier puts that
  // const in the temporal dead zone and every single mount throws.
  applyHeaderAppearance(config.header, config.accent, config.logoUrl);
  applyHeaderAvatar(config.avatarMode, config.avatarInitials, config.logoUrl);
  applyBranding(config.showBranding, config.brandingText, config.brandingUrl);

  // Every pane needs an initial, correct visibility before anything else can
  // run — `screens.current()` is already `initialScreenName` at this point
  // (set at construction, above), so this is a plain repaint rather than a
  // navigation: `showConversation()` would call `screens.go('conversation')`
  // unconditionally and silently override "launcher opens -> Home" for
  // every visitor, on every mount, before a single click happened.
  syncScreens();

  // ── presentation ──────────────────────────────────────────────────────
  function applyPresentation(): void {
    const next = resolvePresentation(
      config.mode,
      { width: window.innerWidth },
      config.sheetBreakpointPx,
    );
    if (next === presentation) return;
    presentation = next;
    host.setAttribute('data-presentation', next);
    // `sidebar` is an edge tab whose accessible name is its visible label; the
    // other two are icon-only buttons that need one supplied.
    syncLauncher(store.getState());
  }

  host.setAttribute('data-presentation', presentation);
  applyPresentation();

  const onResize = (): void => {
    // Only `auto` reacts. A host that asked for `sidebar` gets a sidebar at
    // every width — they have a layout reason we cannot see.
    if (config.mode === 'auto') applyPresentation();
  };
  window.addEventListener('resize', onResize, { passive: true });

  /**
   * The browser's own connectivity signals — the one ambient source worth
   * acting on, because they fire on a real transition rather than on a timer.
   *
   * Both listeners now do something in EVERY state, which is the half of the
   * reported bug that lived here: `onOnline` used to be nothing but
   * `reconnect('auto')`, and `reconnect` returns immediately unless core has
   * parked — so in `connecting`, the state that actually matters, coming back
   * online was silently ignored and the customer was told nothing had changed.
   *
   * What it does now is recompute the status, not force an attempt: while core
   * is working, forcing one is either a provable no-op or a reset of core's own
   * backoff — see {@link WorkingConnectionState}. `reconnect('auto')` is
   * still called and still self-gates, so the terminal case is unchanged.
   */
  const network = createNetworkStatus();
  const unsubscribeNetwork = network.subscribe((isOnline) => {
    online = isOnline;
    syncConnection();
    // Still called, and still self-gating: `reconnect` returns immediately
    // unless core has PARKED (suspended/closed), which is the one case
    // `reconnectPump` below deliberately will not touch — §8.1 gives those two
    // states exactly one way out and it is an explicit `connect()`.
    if (isOnline) reconnect('auto');
  });

  /**
   * The other half of coming back online, and the one that fixes the reported
   * "it just says Connecting… forever".
   *
   * `reconnect('auto')` above only ever applies where core has stopped. The
   * common case is the opposite: core is still retrying, but its full-jitter
   * backoff (§8.2) has climbed to the 30-second cap while the customer was in
   * a tunnel, so the signal returns and nothing visible happens for another
   * half a minute. The pump collapses that wait — immediately on the network
   * event, and otherwise capping any armed backoff at three seconds.
   *
   * It cannot become a second retry loop competing with core's: it drives
   * `retryNow()`, which acts only while `connectionState === 'reconnecting'`
   * (no socket open, a timer counting down) and is a no-op everywhere else.
   * That is the property the Reconnect button could not have, and the reason
   * that button stays inert while core is working — see
   * {@link WorkingConnectionState}.
   */
  const reconnectPump = createReconnectPump({ target: store.client, network });

  // ── state → DOM ───────────────────────────────────────────────────────
  function syncLauncher(state: ChatState): void {
    const unread = state.unreadCount;
    // Two independent reasons to mark the launcher, and either is enough.
    // `agentInitiated` covers the conversation an agent opened while the panel
    // was shut: `session.updated` is not a message, so `unreadCount` need not
    // have moved at all, and without this the only signal of a waiting
    // conversation would be a launcher that looks exactly like an idle one.
    const showBadge = !open && (unread > 0 || agentInitiated);
    badge.hidden = !showBadge;
    // Deliberately blank for a count of zero rather than the literal "0" —
    // `.dh-badge`'s `min-width` renders an empty badge as a plain dot, which
    // is what "someone is waiting, we cannot say how many messages" looks
    // like. A "0" badge would read as a bug.
    badge.textContent = unread === 0 ? '' : unread > 99 ? '99+' : String(unread);

    // The count goes in the NAME, not only in the badge. A red dot a screen
    // reader never mentions is not an unread indicator. The panel is
    // `aria-hidden` while closed, so its live region cannot speak here — this
    // attribute is the only accessible surface a closed widget has.
    launcher.setAttribute(
      'aria-label',
      showBadge ? `${launcherName()}, ${unreadLabel(unread)}` : launcherName(),
    );
  }

  /**
   * The launcher's name, minus any unread clause.
   *
   * ── WCAG 2.5.3, Label in Name ────────────────────────────────────────────
   *
   * Where the launcher SHOWS words — the `bubble-label` and `tab` shapes, and
   * the sidebar presentation's edge tab — those words have to appear in its
   * accessible name, or voice-control software cannot address the control by
   * what its user can see: "click Chat with us" finds nothing on a button
   * whose name is "Open chat".
   *
   * The name then stops swapping Open/Close, which is the APG disclosure
   * pattern rather than a loss: `aria-expanded` already carries the state, and
   * a name that changes under a voice-control user mid-session is the thing
   * 2.5.3 exists to prevent. The bare `bubble` shape keeps the swap, because
   * it shows no words for the name to have to match.
   */
  function launcherName(): string {
    const showsLabel = launcherStyle !== 'bubble' || presentation === 'sidebar';
    const visible = showsLabel ? (launcherLabel.textContent ?? '') : '';
    if (visible !== '') return visible;
    return open ? 'Close chat' : 'Open chat';
  }

  /** The unread half of the launcher's accessible name. */
  function unreadLabel(unread: number): string {
    if (unread === 0) return 'a new conversation is waiting';
    return `${unread} unread ${unread === 1 ? 'message' : 'messages'}`;
  }

  const unsubscribers = [
    store.select(
      (state) => state.messages,
      () => messageList.render(store.getState(), localParticipantId),
      { immediate: true },
    ),
    store.select(
      (state) => state.typing.isTyping,
      () => messageList.render(store.getState(), localParticipantId),
    ),
    store.select(
      (state) => state.pagination,
      () => messageList.render(store.getState(), localParticipantId),
      // `pagination` is a fresh object on every notification, so identity
      // comparison would fire on all of them. Compared field-wise instead.
      { isEqual: (a, b) => a.hasMore === b.hasMore && a.loadingMore === b.loadingMore },
    ),
    store.select(
      (state) => state.unreadCount,
      (unread) => {
        // Strictly on the way UP, and never on the `immediate` first call:
        // `unreadCount` also falls (to zero, when the panel opens), and a
        // widget that chimed on a restored session's backlog would greet a
        // returning visitor with a noise about messages they have already
        // read. `lastUnread` starts at whatever the seeded state holds for
        // exactly that reason.
        // BOTH have to agree: the merchant enabled a chime, and this visitor
        // has not silenced it.
        if (remote.sound && !muted && unread > lastUnread) chime();
        lastUnread = unread;
        syncLauncher(store.getState());
      },
      { immediate: true },
    ),
    // The pre-chat gate lifts on the first message, and the rating appears
    // when a session ends — so both of those facts have to re-run the check.
    // Common Questions leaves for the same reason the pre-chat gate does: the
    // first message, whichever surface produced it, means the chips have done
    // their job.
    store.select((state) => state.messages.length, () => {
      syncProductSurfaces();
      syncScreens();
    }),
    store.select(
      (state) => (state.session === null ? null : `${state.session.id}:${state.session.status}`),
      () => syncProductSurfaces(),
    ),
    store.select(
      (state) => state.connectionState,
      (connectionState) => {
        // A completed handshake is the only proof the run of failures is over.
        if (connectionState === 'connected') failedAttempts = 0;
        syncConnection();
      },
      { immediate: true },
    ),
    // The banner names how many messages are waiting, and that number moves
    // on its own clock: a send made while offline joins the queue without any
    // connection transition, and a flush on reconnect empties it without one
    // either. Selected on the COUNT rather than on `messages`, so the
    // once-per-message churn of a live conversation does not repaint a banner
    // that is not even showing.
    store.select((state) => countQueuedSends(state.messages), () => syncConnection()),
    // The count core's state cannot supply. `#scheduleRetry` emits this once
    // per scheduled retry, immediately after moving to `reconnecting` — so the
    // selector above has already re-rendered with the OLD count by the time
    // this runs, and this second render is what applies the new one.
    store.on('reconnecting', () => {
      failedAttempts += 1;
      syncConnection();
    }),
    // An agent STARTING a conversation with a customer who had none open.
    // Core has already replaced the session and seeded its first page by the
    // time this runs; the only thing left is whether the customer finds out.
    //
    // Opening is opt-in and off by default — see `openOnAgentInitiated`. Left
    // off, the launcher carries it instead: `agentInitiated` makes the badge
    // show even before `unreadCount` moves, because the frame that starts the
    // conversation is not itself a message and the first agent message may
    // arrive on the seeded history page rather than as a `message.new`.
    store.on('conversationStarted', () => {
      if (config.openOnAgentInitiated) {
        openPanel();
        return;
      }
      // Already looking at it — the transcript swap is the notification.
      if (open) return;
      agentInitiated = true;
      syncLauncher(store.getState());
    }),
    // An agent ending the conversation. Core applies the close to session
    // state and emits this; before it was handled here, nothing in the widget
    // reacted at all — the transcript simply stopped accepting replies with
    // no explanation and no way forward.
    store.on('sessionClosed', ({ closeReason }) => {
      // Whoever ended it, a row in both lists just changed status — see
      // `refreshSessions`. Before the parked/ended split below, because a
      // parked session's status moved on the server too.
      refreshSessions();
      // §12.5: `SWITCHED` parks the session because the customer moved to a
      // different active one — it has not ended, and telling them their
      // conversation is over would be false. `isParkedCloseReason` is core's
      // own predicate for this, so the distinction cannot drift from the
      // protocol's.
      if (isParkedCloseReason(closeReason)) {
        // Recorded rather than merely ignored: `session.status` still moves
        // to CLOSED on the server for a SWITCHED close, and neither
        // `syncProductSurfaces`'s CSAT-due check nor `syncScreens`'s
        // ended-footer check used to know the difference between that and a
        // genuine resolution — see `parkedSessionId`'s own doc for the bug
        // this closes.
        parkedSessionId = store.getState().session?.id ?? null;
        return;
      }

      closedSessionId = store.getState().session?.id ?? null;
      messageList.setClosure(closeReason);
      syncComposer();
    }),
    store.select(
      (state) => state.session?.id ?? null,
      (sessionId) => {
        // Only a *different, real* session clears the close. `startNewSession`
        // blanks `session` before the new ack arrives, and treating that null
        // as "recovered" would drop the closing line — and the button on it —
        // in the exact window where a failed reconnect leaves the customer
        // needing both.
        if (sessionId !== null && sessionId !== parkedSessionId) parkedSessionId = null;
        if (sessionId === null || closedSessionId === null) return;
        if (sessionId === closedSessionId) return;
        closedSessionId = null;
        messageList.setClosure(null);
        syncComposer();
      },
    ),
    // Default `strictEqual` comparison, on purpose: `applyAgentJoined` and
    // `applyAgentLeft` both spread a NEW session object, so a reference change
    // is exactly the signal that something about the handler moved. A
    // field-wise comparison here would have to enumerate `status`/`handledBy`
    // and would silently stop firing the day a third field joins them.
    store.select(
      (state) => state.session,
      (session) => {
        identityHeader.update(session);
        // The avatar names the same identity the title does, so it rides the
        // SAME subscription — a second session listener for it would be two
        // places that could disagree about whether an agent is present.
        syncHeaderAvatar();
      },
      { immediate: true },
    ),
    // Same `state.session` reference trigger, its own subscription: the
    // header renders an identity and this maintains the escalation latch,
    // and folding two unrelated jobs into one listener is how the second one
    // gets forgotten the day the first is changed.
    store.select(
      (state) => state.session,
      () => {
        syncHandoff(store.getState());
        // The menu's "End conversation" depends on the same session state.
        syncHeaderMenu();
      },
      { immediate: true },
    ),
    store.select(
      (state) => state.pastSessions,
      () => syncSessionSurfaces(),
      { immediate: true },
    ),
    // Keeps `aria-current` on the Messages screen's rows (and Home's
    // "Recent conversation" row) honest after a switch, a `startNewSession`,
    // or a server-side reactivation moved which session is the current one.
    // Renders from `pastSessions`, which this does not read — one input, two
    // triggers.
    store.select(
      (state) => state.session?.id ?? null,
      () => syncSessionSurfaces(),
    ),
    store.select(
      (state) => state.uploading,
      (uploading) => composer.setUploading(uploading),
      { immediate: true },
    ),
  ];

  /**
   * The Retry button on a permanently-failed bubble.
   *
   * `retryMessage(message.id)`, NEVER `sendMessage(message.content)`. That
   * distinction is the whole of the reported bug: a message's envelope id IS
   * its permanent id (D1), the server dedupes sends on
   * `@@unique([chatSessionId, clientMessageId])`, and `sendMessage` mints a
   * fresh ULID. So the old call was not a retry at all — it was a second,
   * independent message that failed independently, which is why every press
   * left another failed bubble with its own Retry button behind it.
   * `retryMessage` replays the ORIGINAL envelope under its original id, which
   * the server therefore collapses into the one message the user thinks they
   * sent.
   */
  // ── session picker ────────────────────────────────────────────────────

  /**
   * Shows or hides one pane of the panel.
   *
   * The `hidden` attribute alone is not enough here and the reason is worth
   * stating: `.dh-log`, `.dh-home` and `.dh-messages` all carry an explicit
   * `display` in styles.ts, and a stylesheet `display` beats the UA's
   * `[hidden] { display: none }`. The attribute still does the job that
   * matters most — taking the pane out of the tab order and the accessibility
   * tree — and the inline style is what actually takes it off the screen.
   */
  // ── product surfaces: pre-chat, out-of-hours, CSAT ────────────────────
  //
  // All three stand IN PLACE OF the transcript and composer rather than
  // stacking above them, the same way the session chooser does: a form asking
  // the customer for something and the conversation it gates are alternatives,
  // not a pile. One at a time, in the order below, because they are mutually
  // exclusive states of the same conversation.
  //
  // Built lazily and torn down on every change rather than mounted once and
  // toggled: which fields a pre-chat form renders is a fact about the
  // PUBLISHED CONFIG, which arrives after mount and can be re-fetched, and a
  // long-lived form would keep rendering the field list it happened to be born
  // with.

  /** Empties the slot. Answers whether there was anything in it to empty. */
  function teardownSurface(): boolean {
    if (activeSurface === null) return false;
    activeSurface.view.destroy();
    surfaceHost.replaceChildren();
    activeSurface = null;
    return true;
  }

  function closeSurface(): void {
    if (!teardownSurface()) return;
    // Restores the transcript and composer the surface was standing in for.
    // Safe to call unconditionally: `showConversation` is idempotent and
    // re-syncs every pane either way.
    showConversation();
  }

  /**
   * Tears down a USER-INITIATED surface the customer has walked away from,
   * WITHOUT putting the conversation back on screen.
   *
   * Why it exists: `syncProductSurfaces`'s non-preemption rule means no store
   * tick will ever clear one of these — the slot is the customer's until they
   * hand it back. Before that rule the next tick's fall-through `closeSurface`
   * swept an abandoned form away; now the moments that mean "I am done with
   * this" have to be recognised as the hand-back they are, or the next
   * conversation the customer opens is rendered underneath a stale form (and
   * a second Start on that form mints a conversation nobody asked for). Those
   * moments are: leaving the conversation screen (`screens`' `onChange`), and
   * asking for a different conversation (`selectSession`,
   * `startCommonQuestion`).
   *
   * Not `closeSurface`, which ends in `showConversation`: every caller here is
   * either on its way OFF the conversation screen or about to put a different
   * conversation on it, and navigating straight back would undo the press
   * that got here. The automatic surfaces are left alone — they are
   * re-derived from state on the next sync, and a pre-chat gate parked behind
   * Home is exactly what must still be there when the customer returns to
   * that empty conversation.
   */
  function discardUserSurface(): void {
    if (activeSurface === null || !isUserInitiated(activeSurface.kind)) return;
    teardownSurface();
    syncScreens();
  }

  /**
   * Hands the slot back from `view`, a USER-INITIATED surface whose task is
   * done, and re-runs the automatic surfaces.
   *
   * Checked against the slot rather than closed blindly: the two callers with
   * a round trip in them (`endConversation`'s close, `startNewConversation`'s
   * mint-and-send) reach here after an await, and the panel stays live across
   * it — a customer who opened "Start new conversation" while "Ending…" was
   * still in flight has REPLACED the confirm with a form they are typing
   * into, and closing "whatever is active" would tear that form down with
   * their text in it. So only the view that started the operation gets to
   * close, and one already replaced or discarded (`discardUserSurface`) is
   * skipped.
   *
   * The sync runs either way. While the surface was up `syncProductSurfaces`
   * deliberately left it alone (its non-preemption rule), so a rating that
   * became due behind it — the confirm-end surface's own `closeSession` is
   * the obvious case — has not been raised yet, and would otherwise wait for
   * the next unrelated state change. Re-running the sync right after the
   * close is what puts it up at once. Harmless when nothing is due: the
   * sync's own fall-through is a no-op close plus an idempotent `syncScreens`.
   */
  function releaseSurface(view: ProductSurface): void {
    if (activeSurface?.view === view) closeSurface();
    syncProductSurfaces();
  }

  /**
   * Backs out of `view` — a user-initiated surface the customer CANCELLED —
   * and puts them back on the screen they opened it from.
   *
   * Why this is not just `releaseSurface`: that one ends in
   * `showConversation`, which is right for a surface whose task COMPLETED
   * (the conversation is what the customer just started, ended or reported
   * on) and wrong for one they abandoned. "Send us a message" on Home, or
   * "New conversation" on Messages, is a detour; finishing that detour on
   * the conversation screen strands the customer on an empty transcript with
   * the tab bar gone, having pressed Cancel — the reported bug.
   *
   * A surface opened while ALREADY on the conversation screen (the ⋯ menu
   * mid-chat, the ended footer, the inline "Report an issue") is the
   * opposite case: there the conversation IS where they came from, so those
   * keep the ordinary route — as does a view that no longer holds the slot,
   * for the reason `releaseSurface` states about its own identity check.
   *
   * `discardUserSurface`, not `closeSurface`, for the detour: see that
   * function's own doc. It empties the slot without navigating, and it
   * deliberately does NOT re-run `syncProductSurfaces` — an automatic
   * surface raised here would `screens.go('conversation')` and undo the very
   * navigation this is performing.
   */
  function cancelUserSurface(view: ProductSurface): void {
    const current = activeSurface;
    if (current === null || current.view !== view || current.openedFrom === 'conversation') {
      releaseSurface(view);
      return;
    }
    discardUserSurface();
    // `openSurface`'s own `screens.go('conversation')` pushed that origin, so
    // Back is exactly the way to it. The swap covers a stack emptied
    // underneath us (`screens.reset`, when the panel closes).
    if (!screens.back()) screens.swap(current.openedFrom);
  }

  /**
   * Puts focus inside the panel, on whatever is actually on screen.
   *
   * ── Why this is not just "focus the composer" any more ────────────────
   *
   * It used to be, and that was correct while the panel WAS the conversation.
   * With screens, the composer is hidden on Home and Messages, and
   * `HTMLElement.focus()` on a hidden element is a silent no-op — so focus
   * stayed on the host page's body. That is not a cosmetic problem: the
   * panel's Escape handler is a listener ON the panel, so with focus outside
   * it the key never arrives and Escape stops closing the widget. A keyboard
   * user could open the thing and not get out of it.
   *
   * A SURFACE wins over the screen underneath it, and that is the case the
   * previous version missed entirely: `openSurface` focuses its view only
   * when the panel is already open, and a surface can be raised long before
   * that — the pre-chat gate goes up on the connection's ack, which is
   * ordinarily while the panel is still closed. Opening then hit
   * `openSurface`'s idempotence guard, so nothing focused it and nothing
   * focused the screen it was covering either.
   *
   * `preventScroll` throughout: the panel is fixed-position, so any scroll the
   * browser performs to "reveal" it is always wrong.
   */
  function focusOnOpen(): void {
    if (activeSurface !== null) {
      // Surfaces that can take focus do; the rest fall through to the panel
      // rather than leaving focus outside it.
      if (activeSurface.view.focus !== undefined) {
        activeSurface.view.focus();
        return;
      }
      panel.focus({ preventScroll: true });
      return;
    }

    const openingOn = screens.current();
    if (openingOn === 'conversation' && !composer.node.hidden) {
      composer.input.focus({ preventScroll: true });
      return;
    }
    if (openingOn === 'messages') {
      messagesScreen.focus();
      return;
    }
    // Home has no single obvious first control, and this is also the honest
    // fallback for every case above that could not take focus: the ordinary
    // "focus the dialog" behaviour every other modal on the page uses.
    panel.focus({ preventScroll: true });
  }

  /**
   * Puts `kind` in the slot, building it only when it is not already there,
   * and answers with the surface now holding the slot — the handle a
   * user-initiated surface's own callbacks hand back to `releaseSurface`, so
   * a release that lands after a round trip can tell whether the slot is
   * still its to close.
   */
  function openSurface(kind: SurfaceKind, build: () => ProductSurface, key?: string): ProductSurface {
    // Idempotent by KIND, not by identity: `syncProductSurfaces` runs on every
    // message and every session change, and rebuilding the form under the
    // customer on each one would wipe what they were halfway through typing.
    //
    // `key` is the escape hatch for a surface whose `build()` closes over
    // something that can change — `confirmEnd` closes over the session it is
    // asking about — where answering the second ask with the first ask's view
    // hands back a closure aimed at a conversation that is no longer the
    // current one, and its destructive button then quietly closes nothing.
    // Surfaces carrying no such identity pass none and keep the plain
    // by-kind rule.
    if (activeSurface?.kind === kind && activeSurface.key === key) return activeSurface.view;
    // Read BEFORE anything below moves the screen — `closeSurface` and the
    // `screens.go` further down both land on 'conversation', and this is the
    // only moment the answer is still the screen the customer pressed from.
    //
    // …unless a USER-INITIATED surface is already in the slot, in which case
    // `screens.current()` says 'conversation' because THAT surface's own
    // `screens.go` put it there, not because the customer went. A second
    // detour opened on top of the first (⋯ -> "Start new conversation", then
    // ⋯ -> "Report an issue") is still a detour from wherever the first one
    // started, so the origin is inherited rather than re-read. An AUTOMATIC
    // surface is not inherited from: it is derived from state rather than
    // pressed for, and `screens.current()` is already right for it — the
    // screen it is showing on, or the one it is parked behind.
    const replacing = activeSurface;
    const openedFrom =
      replacing !== null && isUserInitiated(replacing.kind) ? replacing.openedFrom : screens.current();
    closeSurface();
    const view = build();
    activeSurface = { kind, view, openedFrom, key };
    // The surface stands IN PLACE OF the conversation — same rule every
    // caller of this function already relied on before screens existed, just
    // expressed as a screen transition now: an auto-triggered surface (the
    // pre-chat gate, an out-of-hours form, a just-ended session's CSAT
    // survey) is exactly as interruptive landing on Home or Messages as it
    // was landing on the old single-panel conversation, and a user-triggered
    // one (Report an issue, a fresh "new conversation") was always heading
    // there anyway.
    screens.go('conversation');
    syncScreens();
    surfaceHost.replaceChildren(view.node);
    if (open) view.focus?.();
    return view;
  }

  /**
   * The on-screen session that has genuinely ENDED, or `null`.
   *
   * One definition for the three readers that need it — the CSAT card, the
   * ended footer, and `csatCard` between them. It used to be written out twice
   * and kept "in lockstep" by comment alone, which is a promise a codebase
   * cannot keep.
   *
   * `session.id !== parkedSessionId` is the non-obvious half: a session THIS
   * TAB watched get SWITCHED-closed reads CLOSED/RESOLVED by status, but it
   * was PARKED, not ended (§12.5) — see `parkedSessionId`'s own doc. Under the
   * current chat-service contract starting a new conversation no longer closes
   * the previous one AT ALL, so nothing routine produces a SWITCHED close any
   * more and this guard is a compatibility path (an older service, or an
   * agent-side switch) rather than the everyday case it was written for. It
   * stays because it costs one comparison and it is the whole difference
   * between rating a conversation and rating one that nobody ended.
   */
  function endedSession(state: ChatState): ChatState['session'] {
    const session = state.session;
    if (session === null) return null;
    if (session.status !== 'CLOSED' && session.status !== 'RESOLVED') return null;
    return session.id === parkedSessionId ? null : session;
  }

  /**
   * What is known about `sessionId`'s rating — asked of the server once, then
   * answered from {@link csatBySession}.
   *
   * ── Why a failed lookup HIDES the survey ──────────────────────────────
   *
   * `POST /chat/sessions/{id}/csat` is an upsert: a second rating does not
   * fail, it replaces the first. So the two ways to be wrong are not
   * symmetric. Showing the survey when the answer is unknown risks a customer
   * silently overwriting a score they already gave — the exact defect — while
   * hiding it risks losing one rating the customer might have offered. Only
   * the first destroys data, so an unknown answer withholds the survey.
   *
   * Nobody is stranded by that: a session with no card falls through to
   * `ui/ended-footer.ts`'s "Reopen" / "New conversation" pair, which is the
   * whole point of that footer.
   *
   * A failure is remembered, not retried: `unknown` is written to the map, so
   * this widget instance asks once per session and then stops. Retrying on
   * every repaint would hammer a service that just failed, at a rate set by
   * how often the customer scrolls; the retry that matters is the next page
   * view, which starts with an empty map. The cost of getting this wrong is
   * one uncollected rating, which is the cheap side of the asymmetry above.
   *
   * A `ChatClientConfigError` (an embed whose client was built without
   * `sessionActions`) is not reported: that deployment has no `submitCsat`
   * either, so it never had a working survey to lose — same reasoning
   * `requestSessions` gives for swallowing exactly that error.
   *
   * ── The one failure that does NOT withhold it ─────────────────────────
   *
   * A service with no CSAT read route AT ALL is a different fact from a
   * lookup that failed, and the asymmetry above does not apply to it: there
   * is no rating to protect, because that deployment could never have shown
   * this widget one. A widget bundle is embedded on pages that outlive any
   * one backend release, so a staged rollout, a lagging tenant or a rollback
   * would otherwise make every visitor on that deployment stop being offered
   * the survey — silently, since the answer is cached — while reporting an
   * error to the host on every ended conversation. So `unsupported` falls
   * back to precisely the behaviour that shipped before this route existed:
   * offer the survey, once per session per page view, remembered by
   * `ratedSessionId` alone. See {@link isMissingCsatRoute} for why that case
   * is distinguishable from "not your session", which still withholds.
   */
  function csatFor(sessionId: string): CsatLookup {
    const known = csatBySession.get(sessionId);
    // The same-session fast path — see `ratedSessionId`. This instance
    // recorded the rating itself, so there is nothing to ask and, more to the
    // point, nothing that may put the survey back while a round trip agrees.
    if (sessionId === ratedSessionId) return known ?? { state: 'unknown' };
    if (known !== undefined) return known;

    csatBySession.set(sessionId, { state: 'loading' });
    store.client
      .getCsat(sessionId)
      .then(
        (status) => {
          csatBySession.set(
            sessionId,
            status.rated
              ? { state: 'rated', rating: status.rating, comment: status.comment }
              : { state: 'unrated' },
          );
        },
        (error: unknown) => {
          // A service that does not serve this route is not a failure to
          // report or to withhold the survey over — see the doc above.
          if (isMissingCsatRoute(error)) {
            csatBySession.set(sessionId, { state: 'unsupported' });
            return;
          }
          csatBySession.set(sessionId, { state: 'unknown' });
          if (error instanceof ChatClientConfigError) return;
          report(error);
        },
      )
      // The answer landing is a state change like any other: whatever the
      // repaint decided while this was `loading` has to be decided again.
      .then(() => {
        if (!destroyed) syncProductSurfaces();
      })
      .catch(report);
    return { state: 'loading' };
  }

  /**
   * Re-asks the server, at the moment of submit, whether `sessionId` is still
   * unrated — `false` means "somebody rated it already, do not write".
   *
   * ── Why the cached answer is not enough ───────────────────────────────
   *
   * {@link csatBySession} caches `unrated` for the widget's lifetime, and
   * there is nothing on the wire that would ever invalidate it: no CSAT frame,
   * no store event. So a second tab, or the same customer's phone, can rate
   * this conversation while this card sits on screen holding an answer that
   * was true when it was fetched. `POST …/csat` is an UPSERT, so submitting
   * then does not fail — it replaces the score they already gave, which is
   * defect 5 arriving by a different road. One GET on the button press cannot
   * close the window entirely (nothing can, short of the server refusing the
   * second write), but it narrows it from "however long this card has been
   * open" to the width of one request.
   *
   * ── A re-check that FAILS lets the submit through ─────────────────────
   *
   * The opposite of {@link csatFor}'s rule, and deliberately: there, no
   * evidence had been gathered and the safe direction was to withhold. Here a
   * definite `unrated` is already on file — that is why this card is an ASK
   * and not a locked read-out — and the customer has just chosen a score.
   * Refusing to send it loses a rating for certain, on the strength of a
   * transport blip that says nothing about whether a rating exists.
   *
   * Only meaningful for a session this instance believes is `unrated`.
   * `unsupported` (no read route on this deployment) has nothing to re-ask,
   * and re-asking would 404 again on every press.
   */
  async function confirmedUnrated(sessionId: string): Promise<boolean> {
    if (csatBySession.get(sessionId)?.state !== 'unrated') return true;
    let status: Awaited<ReturnType<typeof store.client.getCsat>>;
    try {
      status = await store.client.getCsat(sessionId);
    } catch {
      return true;
    }
    if (!status.rated) return true;

    csatBySession.set(sessionId, {
      state: 'rated',
      rating: status.rating,
      comment: status.comment,
    });
    // After this turn, not during it: the card's own `submitOnce` is still
    // awaiting `onSubmit`, and tearing its node out from under it mid-flight
    // is how a surface ends up half-destroyed. Repainting is what swaps the
    // ASK for the locked card showing the rating that actually stands — the
    // honest end state for a press that deliberately wrote nothing.
    void Promise.resolve().then(() => {
      if (!destroyed) syncProductSurfaces();
    });
    return false;
  }

  /**
   * The rating card this conversation is owed, or `null` for none —
   * `existing: null` means ASK, and a rating means show it filled and locked.
   *
   * Read by both `syncProductSurfaces` (which mounts it) and `syncScreens`
   * (which needs to know the ended footer is outranked), so the two can never
   * answer the question differently.
   */
  function csatCard(
    state: ChatState,
  ): { readonly sessionId: string; readonly existing: CsatExistingRating | null } | null {
    const session = endedSession(state);
    // An empty thread has nothing to rate — the same precedence note
    // `syncProductSurfaces` states for the pre-chat gate, from the other side.
    if (session === null || state.messages.length === 0) return null;

    const lookup = csatFor(session.id);
    // `unsupported` asks alongside `unrated`: a service with no read route
    // has no stored rating this card could overwrite, and `ratedSessionId`
    // (checked by `csatFor` before this is ever reached again) is what stops
    // it being offered twice in one page view. See `csatFor`.
    if (lookup.state === 'unrated' || lookup.state === 'unsupported') {
      return { sessionId: session.id, existing: null };
    }
    if (lookup.state === 'rated') {
      return { sessionId: session.id, existing: { rating: lookup.rating, comment: lookup.comment } };
    }
    // `loading` or `unknown` — no card either way, see `csatFor`.
    return null;
  }

  /**
   * Puts the right surface — or none — in front of the conversation.
   *
   * Ordered by precedence, and the order is the product decision: being CLOSED
   * outranks everything (there is no conversation to gate), a surface the
   * customer opened outranks the automatic ones (see the non-preemption rule
   * below), a pre-chat gate outranks a rating (a thread with no messages
   * cannot be rated), and the rating is what is left once a session has
   * ended.
   */
  function syncProductSurfaces(): void {
    if (destroyed) return;
    const state = store.getState();

    if (shouldCollectOffline(remote)) {
      // The one carve-out gate 1 needs. A Row-2 tenant on `COLLECT_MESSAGE`
      // has BOTH entry points live at once: the Home CTA opens kind
      // `'webform'` by hand, and the very next store tick would otherwise
      // run this gate and call `openSurface('offline', …)` — a DIFFERENT
      // kind, so `openSurface`'s by-kind idempotence does not save it, and
      // the visitor's half-typed message is rebuilt out from under them for
      // no change of outcome (this gate would send them to the identical
      // destination). Narrow on purpose: `'webform'` is the only kind whose
      // destination is already the one this gate would impose. Every other
      // surface still yields to it exactly as before.
      if (activeSurface?.kind === 'webform') {
        syncScreens();
        return;
      }

      const ticketDestinationExists = entry.primary === 'ticket' || entry.secondary === 'ticket';
      openSurface('offline', () =>
        ticketDestinationExists
          ? createWebformForm(
              {
                alternative: entry.secondary === 'chat' ? 'chat' : null,
                hours: entry.hours,
                source: entry.source,
                ...(remote.offlineMessage === undefined ? {} : { offlineMessage: remote.offlineMessage }),
                extraFields: remote.preChatEnabled && isGuest ? [...remote.preChatFields] : [],
              },
              // No `onCancel`, and no `onChooseChat`: this form is standing
              // in for the composer, not a detour a visitor can back out of,
              // and there is no live-chat alternative to offer them WHILE
              // the team is closed — that offer belongs to Row 2's CTA,
              // reached from Home, not to this automatic gate.
              { onSubmit: (draft) => sendWebform(draft), onError: report },
            )
          : createOfflineForm(
              // `isGuest` here too — this branch outranks BOTH gates below, so
              // without it an out-of-hours visit was the one path on which a
              // logged-in customer still met the merchant's pre-chat questions.
              // The form's own two built-in fields are a different thing and
              // stay; see `isGuest`'s doc for why.
              remote.preChatEnabled && isGuest ? [...remote.preChatFields] : [],
              {
                onSubmit: (message) =>
                  store.client.sendMessage(
                    `Offline message from ${message.name} (${message.contact}):\n\n${message.message}`,
                    { metadata: { kind: 'offline_message', name: message.name, contact: message.contact } },
                  ),
                onError: report,
              },
              remote.offlineMessage,
            ),
      );
      return;
    }

    // ── Non-preemption ─────────────────────────────────────────────────
    //
    // Only the offline gate above may replace a surface the customer opened,
    // because it means the conversation cannot happen at all. Everything
    // below is a reading of state that the customer's own task outranks: a
    // half-typed new-conversation form or issue report, or the "end this
    // conversation?" question, must not be swapped for the pre-chat gate or
    // a rating because a connection tick or a message happened to arrive.
    // The customer's surface hands the slot back through `releaseSurface`,
    // which re-runs this sync so anything that became due behind it shows
    // then — or is swept away by `discardUserSurface` when they walk off to
    // Home, Messages or a different conversation, since no tick here ever
    // will. `syncScreens` still runs so the panes stay consistent with
    // whatever the state change was, same as the fall-through at the end.
    if (activeSurface !== null && isUserInitiated(activeSurface.kind)) {
      syncScreens();
      return;
    }

    // ── Only ever in front of a conversation the customer OPENED ────────
    //
    // `conversationOpened`, NOT `state.session !== null`: chat-service mints
    // or resumes a session on `connection.hello`, so a brand-new visitor has
    // a live, zero-message session as soon as the socket acks — at mount,
    // before the panel has ever been opened. Gating on the session's mere
    // existence therefore put the gate up at MOUNT, and `openSurface` took
    // the panel straight to the conversation screen, so Home — "Send us a
    // message", Common Questions, the recent conversation — was reachable
    // only by pressing Back off a form nobody had asked for. See
    // `conversationOpened`'s own doc for exactly what sets it.
    //
    // A fresh visitor's details are collected by the new-conversation form
    // instead (`ui/new-conversation.ts`, folded in — see its own header),
    // which is where a conversation now actually starts. A Common Questions
    // tap deliberately skips them as well (`startCommonQuestion`): that is a
    // customer asking one specific question, not filling in a form.
    //
    // Kept for a conversation the customer DID open whose transcript is
    // empty — a recent row picked off Home, a host-supplied `sessionId`, a
    // minted-but-empty thread they navigated back into. That is a
    // conversation they are already looking at, and the merchant asked to be
    // told who they are before it gets going.
    //
    // `openingLinesInFlight`: see that counter's own doc — between a new
    // session's ack and its first message landing, the transcript is empty
    // for a reason that is not "the customer has not spoken yet".
    //
    // `isGuest`: the pre-chat questions exist to learn who an ANONYMOUS
    // visitor is. A logged-in one arrived with a host-asserted profile that
    // `POST /identify` has already written to their contact record, so asking
    // is at best redundant and at worst destructive — the answers are free
    // text that would arrive at the same contact from a lower-trust channel.
    // See `isGuest` for why that is the discriminator and not "has a userId".
    const gateOnPreChat =
      isGuest &&
      remote.preChatEnabled &&
      remote.preChatFields.length > 0 &&
      !preChatAnswered &&
      openingLinesInFlight === 0 &&
      conversationOpened &&
      state.session !== null &&
      state.messages.length === 0;
    if (gateOnPreChat) {
      openSurface('preChat', () =>
        createPreChatForm(
          [...remote.preChatFields],
          {
            onSubmit: async (answers) => {
              await sendPreChatDetails(answers);
              preChatAnswered = true;
              syncProductSurfaces();
            },
            onSkip: () => {
              preChatAnswered = true;
              syncProductSurfaces();
            },
            onError: report,
          },
          // Deliberately NOT `remote.greeting` any more.
          //
          // The console has these as two separate controls — "Opening →
          // Greeting" ("The first message") and "Before the chat starts →
          // Ask for details first" — and borrowing one for the other's
          // heading meant a merchant's opening line appeared as a form title
          // and never as a message. Now that the greeting has a surface of
          // its own (`armGreeting`), rendering it here too would show it
          // twice on the one screen where both are on display.
        ),
      );
      return;
    }

    // Server truth, not this instance's memory — see `csatFor`. `existing`
    // null asks; a rating shows that rating, locked, and offers no way to
    // send a second one.
    const card = csatCard(state);
    if (card !== null) {
      const { sessionId, existing } = card;
      openSurface(
        'csat',
        () =>
          createCsatSurvey(
            remote.csatStyle,
            {
              onSubmit: async (score, comment) => {
                // Asked AGAIN, immediately before writing — the cached
                // `unrated` that put this card on screen may be minutes or
                // hours old, and nothing on the wire announces a rating. A
                // second tab (or the customer's phone) can have rated this
                // conversation in that window, and the POST is an UPSERT: it
                // would replace their score with this one and say nothing.
                // One extra round trip, on a button press, narrows that to
                // the width of a single request. See `confirmedUnrated` for
                // what a failed re-check does.
                if (!(await confirmedUnrated(sessionId))) return;
                // `POST /chat/sessions/{id}/csat`, via core's `SessionActions`
                // seam — the same REST-only pattern
                // `reopenSession`/`closeSession` already use (see
                // `ui/csat.ts`'s own header: chat-service has a real endpoint,
                // and the rating stops travelling disguised as a chat
                // message). Records the rating against the SESSION itself
                // (and, server-side, rolls it up onto the session's linked
                // support ticket when it has one) rather than merely appending
                // a line to the transcript that nothing structured ever reads
                // back.
                await store.client.submitCsat(sessionId, score, comment);
                // BOTH memories, in that order: the latch this render loop
                // reads synchronously, and the cache that answers every later
                // repaint without another round trip. Writing only the first
                // is what made a reload re-offer the survey.
                ratedSessionId = sessionId;
                csatBySession.set(sessionId, {
                  state: 'rated',
                  rating: score,
                  comment: comment ?? null,
                });
              },
              onError: report,
            },
            existing ?? undefined,
          ),
        // Keyed, like `confirmEnd`: the card for ONE session changes shape
        // when the lookup lands or when the customer's own rating is recorded,
        // and `openSurface`'s by-kind idempotence would otherwise keep the ASK
        // on screen over a session that is now rated.
        `${sessionId}:${existing === null ? 'ask' : 'rated'}`,
      );
      return;
    }

    closeSurface();
    // `closeSurface` itself only repaints when it actually HAD a surface to
    // tear down (its own early `if (activeSurface === null) return`) — so a
    // session that reaches CLOSED/RESOLVED with no surface ever having been
    // open (an empty thread, or a rating already on file from a prior visit)
    // would otherwise leave `syncScreens` never re-run, and the composer
    // showing from whatever it was before the session ended. `syncScreens`
    // itself is idempotent, so calling it again on the ordinary path (where
    // `closeSurface` or `openSurface` above already called it) costs nothing.
    syncScreens();
  }

  /**
   * Sends the customer's pre-chat answers into the current session — the ONE
   * shape both askers (the gate in `syncProductSurfaces` and the fields folded
   * into `ui/new-conversation.ts`) produce, so chat-service sees the same
   * message whichever screen collected it.
   *
   * Sent as a MESSAGE, not as an identity upsert. The answers are free text a
   * customer typed on a storefront page, so nothing here may claim an
   * identity — that is the hole §14's key split exists to close. The agent
   * reads the lines; `metadata` is the structured copy, and chat-service
   * consumes it server-side (pre-chat-contact.service.ts) into a
   * CUSTOMER-ASSERTED contact on the session: fill-empty only, marked
   * `source: 'pre_chat'`, and a typed email/phone already owned by another
   * contact is dropped there rather than adopted, so typing an address still
   * grants nothing.
   *
   * Nothing answered, nothing sent: an all-optional form left blank has
   * nothing to tell the agent, and a message with empty content is not a
   * frame worth putting on the wire. The caller still records the gate as
   * answered — the customer was asked and declined, which is what Skip means.
   */
  async function sendPreChatDetails(answers: PreChatAnswers): Promise<void> {
    const answered = remote.preChatFields.filter((field) => answers[field.id] !== undefined);
    if (answered.length === 0) return;
    const lines = answered.map((field) => `${field.label}: ${answers[field.id] ?? ''}`).join('\n');
    await store.client.sendMessage(lines, { metadata: { kind: 'pre_chat', answers } });
  }

  function setPaneVisible(node: HTMLElement, visible: boolean): void {
    node.hidden = !visible;
    node.style.display = visible ? '' : 'none';
  }

  /**
   * Arms the conversation list and fetches it — the customer opened the panel.
   *
   * Asked here rather than at mount, so a widget nobody opens costs the host
   * page nothing. It no longer fetches only ONCE, though: it sets
   * {@link sessionsRequested} and then goes through the same serialised
   * {@link refreshSessions} everything else uses, so a re-open gets a current
   * page and can never race the fetch some other event started.
   */
  function requestSessions(): void {
    if (destroyed) return;
    sessionsRequested = true;
    refreshSessions();
  }

  /**
   * Fetches the customer's recent conversations — the ONE path to the list.
   *
   * ── Why it is not fetched once ────────────────────────────────────────
   *
   * The original latch was written when the list could only be wrong about
   * which conversations EXIST, and the answer to that really was "this file
   * starts them, so this file already knows". Status is different, and defect
   * 4 is exactly that difference: every row now shows where its conversation
   * stands, on both Home and Messages, and the list was fetched once — on the
   * first panel open — and never again. A conversation ended two minutes ago
   * went on reading "With an agent" until the visitor reloaded the page.
   *
   * ── Why the socket alone cannot keep it current ───────────────────────
   *
   * The obvious wiring — refresh on the `sessionClosed` event — is necessary
   * and NOT sufficient. Core emits that event only for the session currently
   * in state (a close naming any other session is a no-op there), and under
   * the current chat-service contract a customer may hold several non-closed
   * conversations at once, because starting one no longer closes the last. So
   * an agent closing a conversation the customer is not looking at produces
   * no client-side event at all, and no amount of listening will hear it.
   *
   * Hence the other callers: opening the panel, and arriving on either screen
   * that RENDERS a status (Home and Messages). Those bound the cost to a
   * customer action while covering the case no event can — the one where the
   * only thing that changed happened to somebody else's conversation. It is
   * still NOT wired to every store tick: the list is a page from a REST route,
   * not a live projection, and re-fetching it on message traffic would spend a
   * round trip per keystroke's worth of state changes.
   *
   * ── One at a time, and never a dropped refresh ────────────────────────
   *
   * See {@link sessionsInFlight} and {@link sessionsRefreshQueued}: a second
   * caller during a flight sets one flag and returns, and the flight re-issues
   * for it on the way out. That is what makes a burst (a close, its own
   * `sessionClosed`, and the new conversation that follows) settle on the page
   * fetched LAST rather than on whichever GET the network happened to finish
   * last.
   *
   * A no-op before the first open — see {@link sessionsRequested}.
   *
   * The result is not read from this promise. `listSessions` writes the page
   * to `ChatState.pastSessions` (§9.4-style wholesale replace) and the
   * `pastSessions` subscription below re-renders Home and Messages from there,
   * so the lists have one input rather than two that could disagree.
   */
  function refreshSessions(): void {
    if (!sessionsRequested || destroyed) return;
    if (sessionsInFlight) {
      sessionsRefreshQueued = true;
      return;
    }
    sessionsInFlight = true;
    store.client
      .listSessions({ limit: SESSION_PICKER_LIMIT })
      .catch((error: unknown) => {
        // An embed whose client has no `sessionSummarySource` is a
        // CONFIGURATION fact, not a fault: core is telling us this deployment
        // simply has no session list. Degrading to "no picker" is exactly
        // right, and it is what keeps this change invisible to an existing
        // embed built against an older client — so it is swallowed rather than
        // pushed at the host's error tracker on every page load.
        //
        // Every other failure — a 5xx, a network drop, a malformed page — IS
        // a fault and is reported. Distinguished by the error's type, not by
        // its message.
        if (error instanceof ChatClientConfigError) return;
        report(error);
      })
      .finally(() => {
        sessionsInFlight = false;
        if (!sessionsRefreshQueued) return;
        // Cleared BEFORE the re-issue, so this settles: the re-issued fetch
        // sets it again only if somebody asks again during ITS flight.
        sessionsRefreshQueued = false;
        refreshSessions();
      });
  }

  /**
   * The most recently active of `sessions`, or `null` — Home's "Recent
   * conversation" row. Computed rather than trusted to arrive pre-sorted:
   * nothing in this package's own contract with `listSessions` promises an
   * order, and getting this one wrong shows a customer the wrong
   * conversation under a label that says "Recent".
   */
  function mostRecentSession(sessions: readonly ChatSessionSummary[]): ChatSessionSummary | null {
    if (sessions.length === 0) return null;
    return sessions.reduce((latest, candidate) => {
      const latestWhen = new Date(latest.lastMessageAt ?? latest.createdAt).getTime();
      const candidateWhen = new Date(candidate.lastMessageAt ?? candidate.createdAt).getTime();
      return candidateWhen > latestWhen ? candidate : latest;
    });
  }

  /**
   * Feeds `pastSessions` to the two screens that render it. One function for
   * both, not two: they read the exact same array on the exact same two
   * triggers (the list arriving, the joined session changing), and separate
   * functions would be separate places for one of the two to be forgotten.
   */
  function syncSessionSurfaces(): void {
    if (destroyed) return;
    const state = store.getState();
    homeScreen.update(mostRecentSession(state.pastSessions), subtitle ?? '', entry);
    messagesScreen.render(state.pastSessions, state.session?.id ?? null);
  }

  /** Puts the conversation back on screen. Idempotent. */
  function showConversation(): void {
    // Deliberately putting a conversation on screen is exactly what makes
    // the pre-chat gate's precondition true — see `conversationOpened`.
    conversationOpened = true;
    // `go` is a no-op when already on 'conversation' (see screens.ts), which
    // is exactly the common case here — a session switch, a surface closing
    // — so the repaint cannot be left to `onChange` alone: it fires only on
    // an ACTUAL screen change, and every one of those callers still needs
    // messageList.log/composer/surfaceHost re-evaluated against the activeSurface
    // that just changed underneath them.
    screens.go('conversation');
    syncScreens();
  }

  /**
   * Take me back to that conversation.
   *
   * `switchSession` joins the chosen session, and the server accepts a
   * TERMINAL (`CLOSED`/`RESOLVED`) one there — picking a past conversation is
   * that ordinary path, not a special case. Nothing here
   * touches `status`: reactivation happens server-side on the customer's next
   * message, behind `FEATURE_SESSION_REACTIVATE_ON_CUSTOMER_MESSAGE` (default
   * OFF), and guessing at it locally would show a customer a live conversation
   * on a deployment where that flag is off.
   *
   * The conversation is shown immediately rather than on completion. The
   * switch is awaitable — it joins, waits for the snapshot, then seeds the
   * transcript — but holding the chooser up for a round trip would read as a
   * dead click, so the pane flips at once and the transcript fills in behind
   * it.
   *
   * The failure has to be caught, and caught around the `await`: a REJECTED
   * join or a snapshot that never arrives rejects the promise, and an
   * unhandled rejection here surfaces on the HOST's window and lands in the
   * host's error tracker as a bug in their page. `retry()` below documents the
   * same rule.
   *
   * No busy guard: core stamps each switch with an epoch and abandons a
   * superseded one, so a customer clicking two rows quickly lands on the
   * second. Guarding here would instead ignore their second click.
   */
  async function selectSession(sessionId: string, displayName?: string, subtitleText?: string): Promise<void> {
    // Asking for a different conversation ends whatever the customer had
    // open in the slot — a form abandoned on the way here must not be what
    // the picked conversation renders under.
    discardUserSurface();
    if (displayName) {
      activeConversationTitle = displayName;
      identityHeader.setTitle(displayName);
      syncHeaderAvatar();
    }
    if (subtitleText !== undefined) {
      subtitle = subtitleText;
      statusText.textContent = subtitle;
    }
    showConversation();
    if (open) composer.input.focus({ preventScroll: true });

    // Behind core's own connect-time page-one load, for the reason
    // `whenHistorySettles` documents — a switch that overlaps it silently
    // fetches nothing and leaves the previous conversation's messages under
    // the new conversation's header, which is the reported bug. Free in the
    // ordinary case: by the time a customer has opened the panel and picked a
    // row, page one landed long ago and this resolves without waiting.
    await whenHistorySettles();
    if (destroyed) return;

    try {
      await store.client.switchSession(sessionId);
    } catch (error) {
      report(error);
    }
  }

  /**
   * Resolves once core's own connect-time history work has finished.
   *
   * Every `connected` puts core to work: it re-joins whatever session the
   * customer last chose and seeds page one of the transcript. Both are async
   * and both are already in flight by the time `connect()`'s promise settles,
   * so a switch started off that promise does not queue behind them — it
   * races them, and loses in both directions. `MessageController.loadMore`
   * refuses to start while another page is in flight, and refuses again once
   * one has landed (`initialLoaded && !hasMore`), so the racing switch joins
   * the named session and then quietly fetches nothing: the customer ends up
   * in one conversation reading another's transcript, or reading nothing at
   * all, depending on which round trip won. Sequencing is the only lever this
   * package has — the alternative would be for a switch to invalidate loads
   * started before it, which is core's to decide, not ours.
   *
   * `pagination` carries the whole signal. `initialLoaded` means a page has
   * landed; a `loadingMore` that has gone true and back to false means one was
   * attempted and failed. Either way nothing is in flight any more and the
   * switch's own load is free to run.
   *
   * ── Why the deadline PROCEEDS rather than refuses ────────────────────────
   *
   * `pagination` only moves because a connection reached `connected`. It never
   * does on a socket that cannot get there, so without
   * {@link HISTORY_SETTLE_TIMEOUT_MS} this waits forever and the picker row
   * the customer pressed does nothing, says nothing, and leaves a live
   * subscription behind.
   *
   * When the deadline passes the switch goes AHEAD, and the timeout is
   * reported. Refusing was the other option and is now the worse one:
   *
   *   - Core epoch-stamps in-flight loads and abandons superseded ones, so
   *     an overlapping seed no longer corrupts a switch. This wait went from
   *     the correctness barrier it was written as to an optimisation that
   *     saves a duplicate fetch — and an optimisation must not be able to
   *     veto the operation it is optimising.
   *   - Proceeding is what produces the customer-visible answer. On a dead
   *     socket `switchSession` fails immediately and audibly — core's
   *     `joinSessionAwaited` answers `disconnected` with "session.join was not
   *     sent: the socket is not open" — and `selectSession` reports it. On a
   *     merely slow one the switch simply works. Refusing would have produced
   *     the same nothing the deadline exists to remove.
   */
  function whenHistorySettles(): Promise<void> {
    if (destroyed || store.getState().pagination.initialLoaded) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let attempted = false;
      let settled = false;
      let unsubscribe: (() => void) | null = null;

      /**
       * The one exit. Every path out of the wait goes through it, so the
       * timer, the subscription and the registry entry are released exactly
       * once no matter which of the three fires first.
       */
      const finish = (reason: 'seeded' | 'timeout' | 'destroyed'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingHistorySettles.delete(cancel);
        unsubscribe?.();

        // The switch goes ahead either way — see the deadline note above — but
        // a deadline that passed is still a fault, and the whole point of
        // bounding this was that the failure stops being invisible. `report`
        // is the only channel this package has to the host, and a host with no
        // `onError` gets config.ts's default, which writes to the console.
        if (reason === 'timeout') {
          report(
            new Error(
              `chat widget waited ${HISTORY_SETTLE_TIMEOUT_MS}ms for the connection to load history ` +
                `and gave up; the session switch is going ahead unsequenced ` +
                `(connection: ${store.getState().connectionState})`,
            ),
          );
        }

        resolve();
      };

      /** What {@link ChatWidget.destroy} calls to settle a wait mid-flight. */
      const cancel = (): void => finish('destroyed');

      const timer = setTimeout(() => finish('timeout'), HISTORY_SETTLE_TIMEOUT_MS);
      pendingHistorySettles.add(cancel);

      unsubscribe = store.select(
        (state) => state.pagination,
        (pagination) => {
          // Re-checked INSIDE the promise, not only at the top: teardown can
          // land between the two, and a wait that outlives the widget holding
          // it is the leak this registry exists to close.
          if (destroyed) {
            finish('destroyed');
            return;
          }
          attempted ||= pagination.loadingMore;
          if (pagination.loadingMore) return;
          if (!attempted && !pagination.initialLoaded) return;
          finish('seeded');
        },
      );

      // `store.select` does not fire synchronously without `immediate`, but
      // the state it reads can still have moved while this promise was being
      // built. Cheaper to re-read than to reason about it.
      if (destroyed) finish('destroyed');
      else if (store.getState().pagination.initialLoaded) finish('seeded');
    });
  }

  /**
   * Opens the conversation the HOST named in `config.sessionId`.
   *
   * `switchSession`, not `joinSession`: the host asked for a conversation to
   * be on screen, and only the former clears the one that is there and fetches
   * the one that was asked for.
   *
   * Deliberately last, behind {@link whenHistorySettles}, which is also what
   * makes it beat the customer's remembered choice when the two disagree: core
   * stamps every switch with an epoch and the last one to START wins, so
   * running after core's restore has finished is what turns "the host named a
   * session" into the instruction that actually holds.
   */
  async function openNamedSession(sessionId: string): Promise<void> {
    await whenHistorySettles();
    if (destroyed) return;
    await store.client.switchSession(sessionId);
  }

  function retry(message: ChatMessage): void {
    store.client
      .retryMessage(message.id)
      .then((outcome) => {
        if (outcome.status === 'retried') return;
        handleRetryRefusal(message, outcome.reason);
      })
      // `.catch`, not `void`: `retryMessage` resolves rather than throws for
      // the ordinary refusal, but a storage failure underneath it still
      // rejects, and an unhandled rejection here surfaces on the HOST's
      // window.
      .catch(report);
  }

  /**
   * What to show when core declines to replay an id.
   *
   * Rare by construction — message-list.ts gates the button's visibility on
   * `delivery.retryable`, which is core's own answer to "is this worth
   * offering" — but not impossible: the customer may have switched sessions
   * since the failure, and core refuses that case because `message.send`
   * carries no `sessionId` on the wire, so replaying the id now would
   * misattribute it to whichever session is current.
   *
   * Branched on `outcome.reason`, the discriminant, never on any message
   * text. The two reasons want opposite treatment and collapsing them would
   * get one of them wrong:
   *
   *   - `not-retryable` — this id will never reach the server. The customer's
   *     words are otherwise stranded in a dead bubble, so they are handed
   *     back to the composer where one keystroke sends them as a fresh
   *     message. Only into an EMPTY composer: silently overwriting something
   *     half-typed would lose more than it recovers.
   *   - `not-found` — nothing eligible under this id: already retried, already
   *     succeeded, or never failed. Offering the text back here would invite a
   *     genuine duplicate of a message that may well have landed, which is the
   *     exact failure this whole change removes. Report it and leave the UI
   *     alone; the re-render below already shows core's real state.
   */
  function handleRetryRefusal(message: ChatMessage, reason: 'not-found' | 'not-retryable'): void {
    report(new Error(`chat widget could not retry message ${message.id}: ${reason}`));

    // Re-read core rather than trust the affordance that was just pressed: a
    // refusal means the button's state and core's disagreed.
    messageList.render(store.getState(), localParticipantId);

    if (reason !== 'not-retryable') return;
    if (composer.input.value !== '') return;
    composer.input.value = message.content;
    composer.input.focus({ preventScroll: true });
  }

  /**
   * The one place that decides whether the customer can type.
   *
   * Two independent reasons to take the composer away, so one writer rather
   * than two: a connection that is terminally `closed`, and a conversation an
   * agent ended. When both were separate `setEnabled` calls, whichever fired
   * last won, and a connection-state change after a session close silently
   * re-enabled typing into a dead session.
   *
   * Deliberately NOT disabled merely because we are offline: core queues sends
   * durably (§9.6), so a user on a lift with no signal can still type their
   * question and have it go out on reconnect.
   */
  function syncComposer(): void {
    const connectionState = store.getState().connectionState;
    // Consent joins the existing two conditions rather than getting a gate of
    // its own: this is already the ONE place that decides whether the composer
    // is usable, and a second writer is how the status line and the composer
    // ended up disagreeing about the connection before `syncConnection` was
    // consolidated.
    composer.setEnabled(
      closedSessionId === null && connectionState !== 'closed' && consent.agreed(),
    );
  }

  /** How long before an *automatic* recovery attempt may fire again. */
  const AUTO_RECONNECT_MIN_INTERVAL_MS = 5_000;

  /**
   * Writes one {@link resolveConnectionStatus} answer out to all three
   * surfaces it governs.
   *
   * One writer, so the status line, the Reconnect control and the composer's
   * prompt cannot describe three different connections — the failure mode the
   * old code had, where the status said "Connecting…" indefinitely while the
   * button and the composer said nothing at all.
   */
  function syncConnection(): void {
    const state = store.getState();
    const connectionState = state.connectionState;
    const status = resolveConnectionStatus(connectionState, online, failedAttempts);

    // The banner, from the same three inputs the status line above is resolved
    // from — plus the one thing only the transcript knows: how many messages
    // the customer has already composed that are waiting on the connection.
    // That count is what turns "you're offline" from a warning into a promise,
    // and it is the half a status line could never carry.
    offlineBanner.update(
      resolveOfflineBanner({
        connectionState,
        online,
        failedAttempts,
        queuedCount: countQueuedSends(state.messages),
      }),
    );

    // The whole-panel "we cannot reach the service" state, shown only once
    // core has actually STOPPED — never over a reconnect it is still working
    // through, which would tell the customer the service is down while it is
    // coming back. See ui/unavailable.ts for why this is a screen and not
    // just the status line it sits above.
    const givenUp = TERMINAL_CONNECTION_STATES.has(connectionState);
    unavailable.update(remote.supportEmail ?? '', reconnecting);
    const wasUnreachable = !unavailable.node.hidden;
    setPaneVisible(unavailable.node, givenUp);
    // The screens below have to be told, or they keep painting a composer
    // underneath it. Only on a CHANGE — `syncConnection` runs on every
    // transport event, and a repaint per heartbeat is work nobody asked for.
    if (wasUnreachable !== givenUp) syncScreens();

    // The merchant's subtitle stands in for `'Online'` and for nothing else.
    // Every other label is diagnostic, and a response-time promise painted
    // over "Not connected — use Reconnect to try again" would tell a customer
    // their message is on its way to somebody while it is going nowhere. A
    // healthy connection is the one state with nothing of its own to report,
    // so it is the one the merchant's words can have.
    statusText.textContent =
      connectionState === 'connected' && subtitle !== '' ? subtitle : status.label;
    statusDot.style.color = status.color;

    reconnectButton.hidden = status.control === 'hidden';
    // `inert` and "a manual attempt is already running" are different reasons
    // for the same disabled state, and both must win over `ready`.
    reconnectButton.disabled = status.control === 'inert' || reconnecting;
    reconnectButton.textContent = reconnecting ? 'Reconnecting…' : 'Reconnect';

    // The composer stays ENABLED throughout — core queues sends durably (§9.6)
    // and a customer in a lift must still be able to type their question. What
    // changes is only the promise made about what happens to it.
    composer.input.placeholder = status.queueing ? QUEUEING_PLACEHOLDER : composerPlaceholder;

    syncComposer();
  }

  /**
   * Re-opens the connection after core has stopped trying.
   *
   * This is NOT a retry loop layered over core's. It only ever fires in a
   * state core has deliberately parked (`TERMINAL_CONNECTION_STATES`), so it
   * cannot race the transport backoff or the auth escalation — in every state
   * where core is still working, this returns immediately.
   *
   * `'auto'` triggers are the two signals that genuinely mean "the customer is
   * here and wants this now": opening the panel, and the browser reporting the
   * network came back. Both are human-paced rather than timer-paced, and the
   * interval floor bounds the pathological case — a customer opening and
   * closing the panel repeatedly against credentials that are simply broken,
   * where each attempt costs a token mint and a socket.
   *
   * `visibilitychange` is deliberately not one of them: it fires on every
   * alt-tab, which is frequent enough to be a poll rather than an intent.
   */
  function reconnect(trigger: 'manual' | 'auto'): void {
    if (destroyed || reconnecting) return;
    if (!TERMINAL_CONNECTION_STATES.has(store.getState().connectionState)) return;

    if (trigger === 'auto') {
      const now = Date.now();
      if (now - lastAutoReconnectAt < AUTO_RECONNECT_MIN_INTERVAL_MS) return;
      lastAutoReconnectAt = now;
    }

    reconnecting = true;
    syncConnection();
    store.client
      .connect()
      .catch(report)
      .finally(() => {
        reconnecting = false;
        syncConnection();
      });
  }

  /**
   * May a handoff keyword escalate right now? True only while the BOT holds
   * the conversation and it is still live:
   *
   *   - `mode: 'HUMAN'` already means the hand-off happened. Whether an agent
   *     has picked it up yet (`WAITING_FOR_AGENT`) or is already replying
   *     (`ASSIGNED`), asking again escalates nothing — the server would answer
   *     the same session snapshot back.
   *   - `CLOSED`/`RESOLVED` is not a conversation to escalate; the way out of
   *     one of those is "Start a new conversation", which the log already
   *     offers.
   *   - No session at all (pre-connect, or mid `startNewSession`) has nothing
   *     to escalate.
   *
   * Driven off `mode`/`status` rather than `handledBy` on purpose:
   * `handledBy` is presentation-only and documented as able to lag `status`
   * on a reactivated session (core's `isHandledByCurrent`), so gating a real
   * ACTION on it would escalate a conversation someone is already talking to
   * a person in.
   */
  function botHoldsLiveConversation(state: ChatState): boolean {
    const session = state.session;
    return (
      session !== null &&
      session.mode === 'BOT' &&
      session.status !== 'CLOSED' &&
      session.status !== 'RESOLVED'
    );
  }

  /**
   * What the header menu offers right now.
   *
   * "End conversation" is conditional on there BEING a live one — offering it
   * over a session that is already closed is a control that does nothing, and
   * the menu's whole contract is that every item does something.
   */
  function syncHeaderMenu(): void {
    const session = store.getState().session;
    const live =
      session !== null && session.status !== 'CLOSED' && session.status !== 'RESOLVED';
    headerMenu.update({
      canEnd: live,
      privacyUrl: remote.privacyUrl ?? '',
      reportIssue: remote.reportIssue,
      muted,
    });
  }

  /**
   * Re-arms the keyword escalation once the bot no longer holds a live
   * conversation. The visible "Talk to a human" button this used to
   * show/hide is gone — escalation is keyword-only now (see the composer's
   * `onSend`) — but the in-flight latch must still reset: a customer whose
   * escalated conversation was handed back to the bot, or who starts a fresh
   * one, must be able to escalate again.
   */
  function syncHandoff(state: ChatState): void {
    if (!botHoldsLiveConversation(state)) {
      // Reset, so a session that comes back round does not inherit the spent
      // latch from the last time it was escalated.
      requestingAgent = false;
    }
  }

  /**
   * The one place every screen- and surface-driven repaint fans out from.
   *
   * Runs on: a screen change (wired as `screens`'s own `onChange`), an
   * `activeSurface` mutation (`openSurface`/`closeSurface`, via
   * `showConversation`), a message arriving (the transcript's emptiness is
   * part of the condition below), and a config publish (`applyRemoteConfig`,
   * because `design` and `remote.commonQuestions` can both change under it).
   * One function rather than several called in pairs is what
   * `syncPreConversationPanes` — this function's single-panel-era ancestor —
   * already established: splitting related visibility rules across call
   * sites is how one of them ends up stale at a moment another is not.
   */
  function syncScreens(): void {
    if (destroyed) return;
    const current = screens.current();
    const state = store.getState();

    // Everything else is suppressed while the service is unreachable. This is
    // not decoration: leaving a composer that accepts text behind an "we
    // couldn't reach the support service" notice invites the customer to type
    // a message that has nowhere to go, which is the exact failure the whole
    // screen exists to prevent.
    const unreachable = !unavailable.node.hidden;

    const onHome = current === 'home' && !unreachable;
    const onMessages = current === 'messages' && !unreachable;
    const onConversation = current === 'conversation' && !unreachable;
    // The transcript and composer show only on the conversation screen, and
    // only while no product surface (an out-of-hours form, the pre-chat
    // gate, a CSAT survey, the new-conversation composer) is standing in for
    // them — the same "one at a time" rule `openSurface` always enforced,
    // now with a screen layered on top of it.
    const showingLog = onConversation && activeSurface === null;

    // A CLOSED/RESOLVED session with no surface standing in for it — the
    // CSAT survey already submitted, or never due — still leaves `showingLog`
    // true (`activeSurface` is null) with nothing useful for the composer to
    // do: `syncComposer`'s `closedSessionId` gate only fires for a session
    // this TAB watched get closed (the `sessionClosed` event, below), so a
    // terminal session reached any other way — a Messages-screen row, a
    // reload landing back on an old conversation, a rating that just landed —
    // left the composer fully visible and enabled with nowhere for a send to
    // go. `ui/ended-footer.ts`'s "Reopen" / "New conversation" pair replaces
    // it for exactly that span; see that module's own header for why this is
    // a footer beside the composer rather than a fourth `ProductSurface`.
    //
    // The rating card still outranks this footer, and this footer is what is
    // left once there is no card — one precedence step past the one
    // `syncProductSurfaces`'s own comment states for CSAT itself ("the rating
    // is what is left once a session has ended"). Both questions are asked of
    // the same two helpers rather than re-derived here, which is what stops
    // the footer and the card from both deciding they are on.
    const ended = endedSession(state) !== null;
    const csatDue = csatCard(state) !== null;
    const showingEndedFooter = showingLog && ended && !csatDue;

    setPaneVisible(homeScreen.node, onHome);
    setPaneVisible(messagesScreen.node, onMessages);
    setPaneVisible(surfaceHost, onConversation && activeSurface !== null);
    setPaneVisible(messageList.log, showingLog);
    composer.node.hidden = !showingLog || showingEndedFooter;
    endedFooter.node.hidden = !showingEndedFooter;
    // The tab bar and the composer trade the same bottom-of-panel row: a
    // customer typing does not also need two tabs competing for a glance,
    // and there is no tab for `conversation` to begin with (see nav.ts).
    setPaneVisible(nav.node, !onConversation);
    backButton.hidden = !screens.canGoBack();

    // Stamp the current screen onto the host element so CSS can target it:
    // `:host([data-screen="conversation"])` applies the purple gradient header
    // and the pink-teal thread background (ui/styles.ts Dhaam UI section).
    host.setAttribute('data-screen', current);

    // Common Questions and the hero banner are both Home furniture now —
    // see home-screen.ts's own header on why it arranges rather than owns
    // the shared Common Questions component, and hero-header.ts's on why the
    // hero draws no CTA of its own, leaving Home's card the only one.
    setPaneVisible(commonQuestionsHost, onHome && remote.commonQuestions.length > 0);
    setPaneVisible(heroHeader.node, onHome && design === 'hero');

    // The greeting stays conversation furniture — it is styled as the first
    // line of THIS chat, not a piece of Home, and disappears the moment
    // there is a real first message. `greetingDue` is the delay having
    // elapsed (see `armGreeting`); without it this pane would appear
    // instantly and the merchant's configured wait would be invisible.
    const beforeFirstMessage = showingLog && state.messages.length === 0;
    setPaneVisible(
      greetingBubble,
      beforeFirstMessage && greetingDue && greetingBubble.textContent !== '',
    );

    nav.update(current, state.unreadCount);
  }

  /**
   * The merchant's opening line, after `behaviour.greetingDelaySec`.
   *
   * ── Why this is not a message ────────────────────────────────────────────
   *
   * It never came from the server, it has no id, and it is not in anybody's
   * transcript — so putting it in the store would mean inventing a message
   * that core would then have to replay, deduplicate and reconcile against
   * history on every resume. It is presentation, and it lives where the other
   * pre-conversation panes live.
   *
   * It is styled as an inbound bubble because that is what it is FOR: the
   * console calls this field "The first message" and its help text is "Say
   * what you can help with, not just hello." Rendering it as a system notice
   * would tell the customer a different thing than the merchant wrote.
   */
  function armGreeting(text: string, delaySec: number): void {
    clearTimeout(greetingTimer);
    greetingBubble.textContent = text;
    greetingDue = delaySec <= 0;

    if (!greetingDue) {
      greetingTimer = setTimeout(() => {
        if (destroyed) return;
        greetingDue = true;
        syncScreens();
      }, delaySec * 1000);
    }
    syncScreens();
  }

  /**
   * Ask for a human. Reached only by the handoff-keyword match in the
   * composer's `onSend` — there is deliberately no visible control for it.
   *
   * `requestAgent` is fire-and-forget on the wire (core writes the frame and
   * returns), so there is no promise to await and no ack to hang the UI on.
   * What settles this is the server's own `session.updated` — the session
   * flips to `HUMAN`. Until then `requestingAgent` stays latched, because a
   * second keyword in the queue-wait would be a second escalation of a
   * session that is already queued.
   *
   * The throw path is real: core rejects a send with no session or no open
   * socket. Reported, and the latch released — leaving it set would strand
   * the customer with no way to ask again.
   */
  /**
   * Emails the customer their own conversation.
   *
   * `POST /chat/sessions/:id/transcript/email`, which takes NO body — the
   * recipient is resolved server-side from the session's own record and is
   * never accepted from a client. That is the endpoint's security model, not
   * an omission here: an address the browser could choose would make this a
   * way to mail any conversation anywhere.
   *
   * Rejects rather than reporting, because the caller is a button that has to
   * change its own label on failure. `report` would swallow the outcome and
   * leave it saying "Sending…" forever.
   */
  async function emailTranscript(): Promise<void> {
    const sessionId = store.getState().session?.id ?? closedSessionId;
    // The button only exists on a closed conversation, so this is close to
    // unreachable — but "no session" must not become a request to
    // `/sessions/undefined/transcript/email`.
    if (sessionId === null || sessionId === undefined) {
      throw new Error('No conversation to send');
    }
    await rest.request('POST', `/chat/sessions/${encodeURIComponent(sessionId)}/transcript/email`, {
      body: {},
    });
  }

  /**
   * Opens the report form in the surface slot the other three forms share.
   *
   * Not a modal, deliberately: this widget has one slot, `openSurface` already
   * owns which form is in it, and a fourth pattern for a fourth form would be
   * a pattern for its own sake. It also means the form cannot be opened on top
   * of the pre-chat gate or the rating.
   */
  function openReportIssue(): void {
    const view = openSurface('report', () =>
      createReportIssueForm({
        onSubmit: (report) => fileIssueReport(report),
        // Same Cancel rule as the new-conversation form — this one is
        // reachable from the ⋯ menu on Home too, and backing out of it must
        // not deposit the customer on a conversation screen either.
        onCancel: () => cancelUserSurface(view),
        onError: report,
      }),
    );
  }

  /**
   * Files the report.
   *
   * Rejects rather than reporting, so the form can show its own message and
   * keep what the customer typed — `submitOnce` in ui/forms.ts is built around
   * exactly that contract.
   *
   * The body carries no tenant and no session: the tenant comes from the
   * verified token server-side and the session is in the path, which is the
   * rule the route states in its own header. Sending either would be rejected
   * with a 400 that says so.
   */
  async function fileIssueReport(issue: IssueReport): Promise<void> {
    const sessionId = store.getState().session?.id ?? closedSessionId;
    if (sessionId === null || sessionId === undefined) {
      throw new Error('No conversation to report against');
    }
    await rest.request('POST', `/chat/sessions/${encodeURIComponent(sessionId)}/report-issue`, {
      body: issue,
    });
  }

  /**
   * Opens the web-form surface — the visitor-facing chooser's escape hatch
   * (Row 1's "Leave a message instead") or default (Row 2's CTA). Shaped
   * exactly like `openReportIssue` above: one slot, one opener, no modal.
   *
   * `entry.secondary === 'chat'` is read fresh at BUILD time rather than
   * closed over once — the same reason `remote.preChatFields` is spread
   * fresh into every other surface's options — so a config refresh that
   * lands while the visitor is elsewhere does not leave a stale escape hatch
   * baked into a form built before it.
   */
  function openWebform(): void {
    const view = openSurface('webform', () =>
      createWebformForm(
        {
          alternative: entry.secondary === 'chat' ? 'chat' : null,
          hours: entry.hours,
          source: entry.source,
          ...(remote.offlineMessage === undefined ? {} : { offlineMessage: remote.offlineMessage }),
          extraFields: remote.preChatEnabled && isGuest ? [...remote.preChatFields] : [],
        },
        {
          onSubmit: (draft) => sendWebform(draft),
          onChooseChat: () => {
            discardUserSurface();
            openNewConversationFlow();
          },
          onCancel: () => cancelUserSurface(view),
          onError: report,
        },
      ),
    );
  }

  /**
   * Submits a web-form draft, with the one recovery §4.4 of the design
   * requires: a `403 CHANNEL_DISABLED` means chat-service resolved a row
   * this widget's CACHED `support` no longer agrees with — the merchant
   * flipped a toggle, or the clock crossed a shift boundary after the
   * config was fetched. That is a stale-cache signal, not an ordinary
   * error, because it means the widget rendered a form it should not have.
   *
   * Rejects rather than swallowing either way, so the form's own
   * `submitOnce` keeps the visitor's typed text and shows a sentence —
   * `fileIssueReport` documents the identical contract for its own surface.
   */
  async function sendWebform(draft: WebformDraft): Promise<WebformReceipt> {
    try {
      return await submitWebform({ apiUrl: config.apiUrl, publishableKey: config.auth.publishableKey, draft });
    } catch (error) {
      if (!(error instanceof WebformError) || error.kind !== 'channel_off') throw error;

      // The cached entry disagreed with the server's live decision. Ask
      // again before deciding what to tell the visitor — never claim the
      // channel is off on the strength of a 403 alone.
      const refreshed = await refreshRemoteConfig();

      if (!refreshed || entry.primary === 'ticket' || entry.secondary === 'ticket') {
        // Either the refresh itself FAILED — `refreshed` says so explicitly,
        // rather than being inferred from `entry`, which a failed refresh
        // leaves untouched rather than resetting to 'assumed' (see
        // `refreshRemoteConfig`'s own doc) — or it landed and still says a
        // ticket destination exists (the refresh disagrees with the 403).
        // Either way: transient, so the visitor's text and the button both
        // come back rather than the "switched off" sentence.
        throw new WebformError('unavailable', 'webform channel_off: refresh did not confirm it', true);
      }

      // The refresh agrees: the channel has genuinely gone away since this
      // form was built. Say so, hand the slot back, and let the ordinary
      // render path show whatever the tenant now actually offers — possibly
      // nothing at all (Row 6 hides the launcher outright).
      discardUserSurface();
      syncScreens();
      launcher.hidden = !shouldMount(remote);
      throw error;
    }
  }

  /**
   * Ends the conversation, at the customer's request.
   *
   * `closeSession` goes through chat-service's own
   * `POST /chat/sessions/:id/close`, which is customer-owned — so this is the
   * customer closing THEIR session, not an agent action borrowed.
   *
   * Confirmed first, and it is the only control in this widget that asks. A
   * mis-tap here still costs something even though `reopenSession` (below)
   * exists now: it ends the conversation somebody was in the middle of, and
   * the reopen returns the SAME session but not the composer state — the
   * customer has to notice the "Reopen" button and press it before they can
   * carry on, rather than never having lost the thread at all.
   *
   * Asked INSIDE the widget (`ui/end-conversation.ts`), in the surface slot
   * every other form uses, not through the browser's `confirm()` — see that
   * module's header for why the host page's modal was the wrong place. Being
   * a user-initiated surface, `syncProductSurfaces` leaves it alone while it
   * is up; `releaseSurface` on confirm is what then lets the same sync raise
   * the CSAT survey (a thread with messages) or the ended footer (one
   * without) — the identical path an agent-side close already takes, so the
   * rating and comment reach the session and its linked ticket the way they
   * always did.
   *
   * `endingConversation` still guards the close itself: the confirm button
   * disables while busy, but the latch is what keeps a second `closeSession`
   * from being issued by any route while one is in flight.
   *
   * The question is about ONE conversation and stays about it. Unlike the
   * blocking `confirm()` it replaced, this surface is open-ended, so the
   * session can change underneath it before the customer answers — another
   * tab starting a conversation parks this one as SWITCHED, an agent-initiated
   * session lands. Core's `closeSession` closes the CURRENT session, so the
   * button fires only while that is still the one it asked about; otherwise
   * it closes nothing and simply stands down.
   *
   * `targetId` is also the surface's `key`, and that is not decoration: the
   * ⋯ menu stays reachable while this is up, so a customer whose session
   * changed underneath the question can press "End conversation" again
   * meaning the NEW one. Without the key, `openSurface`'s by-kind idempotence
   * would hand back the confirm built for the OLD session, and the
   * destructive button — pressed twice by then — would close nothing at all
   * and say nothing about it.
   */
  function endConversation(): void {
    if (endingConversation) return;
    const live = store.getState().session;
    if (live === null) return;
    const targetId = live.id;

    const view = openSurface(
      'confirmEnd',
      () =>
        createEndConversationConfirm({
          onConfirm: async () => {
            if (endingConversation) return;
            endingConversation = true;
            try {
              // IDENTITY only. Nothing to close when the session changed
              // underneath the question (see `targetId` above) — core's
              // `closeSession` closes whatever is CURRENT, so firing then
              // would end a conversation the customer never asked about.
              //
              // It deliberately does NOT also require a live status, and that
              // is a fix rather than an oversight. Core now moves `status` to
              // CLOSED off a `session.closed` frame (it used to stamp only
              // `closedAt`), so a SWITCHED close landing while this question
              // is on screen makes the session read terminal locally — and
              // the old status half of this guard turned the customer's press
              // into a silent no-op: no request, no message, dialog gone.
              // That is one of the literal "End conversation does nothing"
              // reports, and it also meant the row was never attributed as
              // closed BY THE CUSTOMER. chat-service's close is idempotent
              // for the session's owner (200 with the current state, no
              // second system message), so asking again for a session that is
              // already closed is the cheap, honest direction.
              const current = store.getState().session;
              if (current !== null && current.id === targetId) {
                await store.client.closeSession();
                // The customer ENDED this one. If it was also parked by a
                // SWITCHED close (see `parkedSessionId`), that suppression no
                // longer applies: parking says "nobody ended this", and
                // somebody just did. Left set, the rating card and the ended
                // footer would both stay hidden over a conversation the
                // customer had explicitly closed.
                if (parkedSessionId === targetId) parkedSessionId = null;
                // This conversation's row now reads CLOSED, and so may the
                // one the Home screen calls "Recent" — see
                // `refreshSessions`. The `sessionClosed` event does not fire
                // for a close the customer made from this tab, so this is the
                // only place that can ask.
                refreshSessions();
              }
            } finally {
              endingConversation = false;
            }
            // Only reached on success — a rejection stays with the surface,
            // whose own button shows the failure and re-arms (`submitOnce`).
            releaseSurface(view);
          },
          // `cancelUserSurface`, not `releaseSurface`: the ⋯ menu lives in the
          // always-visible header, so this question is reachable from Home and
          // from Messages, and "Keep chatting" pressed there must put the
          // customer back where they were rather than on a conversation screen
          // with the tab bar gone — the same rule the other two user-initiated
          // surfaces already follow.
          onCancel: () => cancelUserSurface(view),
          onError: report,
        }),
      targetId,
    );
  }

  /**
   * Reopens a CLOSED/RESOLVED conversation, at the customer's own request —
   * `ui/ended-footer.ts`'s "Reopen" button, which stands in for the composer
   * once a session has ended and CSAT is done or not due (see `syncScreens`).
   *
   * Goes through the real endpoint, not a client-side re-enable:
   * `store.client.reopenSession` is core's `ChatClient.reopenSession`, backed
   * by `POST /chat/sessions/{id}/reopen` (`@dhaam-ccrm/rest`'s adapter) — the
   * same customer-facing action the React/Vue/Angular bindings already
   * expose and this widget alone was missing. Faking it locally (just
   * flipping the composer back on) would leave the server still holding the
   * session CLOSED, so a reload — or any other client watching the same
   * session — would show it terminated again while this tab disagreed.
   *
   * No busy latch of its own, unlike `endConversation` above: the button that
   * calls this owns its own busy/error state via `submitOnce`
   * (`ui/ended-footer.ts`), which is also why this rejects rather than
   * catching — a swallowed rejection here would leave that button unable to
   * tell the difference between "worked" and "failed silently".
   *
   * Nothing else has to be re-synced on success. `reopenSession` commits the
   * resolved session through the same `commitSession` path `closeSession`
   * uses (core's `create-chat-client.ts`), and the `state.session` id/status
   * subscription already wired above (`syncProductSurfaces`) reacts to that
   * commit and repaints the panel — the identical reactive path that already
   * puts the composer back once a CSAT rating is submitted.
   */
  function reopenConversation(): Promise<void> {
    const session = store.getState().session;
    if (session === null) return Promise.reject(new Error('No conversation to reopen'));
    return store.client.reopenSession(session.id).then(() => undefined);
  }

  function requestHumanAgent(): void {
    if (requestingAgent) return;
    requestingAgent = true;

    try {
      store.client.requestAgent();
    } catch (error) {
      report(error);
      requestingAgent = false;
    }
  }

  /**
   * Opens the "new conversation" surface — topic chips (when the merchant
   * configured any) plus a message. Every entry point funnels through here:
   * Home's own CTA card, the hero's CTA, the Messages screen's "New
   * conversation" button, a closed conversation's own inline prompt
   * (`messageList`'s `onStartNewConversation`), and the ⋯ menu's "Start new
   * conversation". One destination rather than five, because this is the
   * only place a customer ever gets to set the topic/subject pair
   * `ui/new-conversation.ts` collects — see that module's own header.
   */
  function openNewConversationFlow(): void {
    // "Ask for details before chatting" rides along on this form rather than
    // gating it from a separate screen — the same condition the gate in
    // `syncProductSurfaces` uses, minus the "no messages yet" clause, which
    // is beside the point here: this form is about to START a session, so
    // the question is only whether the customer has already answered.
    // `isGuest` first, for the same reason the gate in `syncProductSurfaces`
    // carries it: these are the SAME questions on a different screen, and a
    // logged-in visitor must not meet them on either. Both read the one named
    // boolean rather than re-deriving "is this a guest", which is how the two
    // asks came to disagree in the first place.
    const askDetails =
      isGuest && remote.preChatEnabled && remote.preChatFields.length > 0 && !preChatAnswered;
    const view = openSurface('composingNew', () =>
      createNewConversationScreen(
        [...remote.conversationTopics],
        {
          // Start goes on to the conversation it just made (`releaseSurface`,
          // inside `startNewConversation`); Cancel goes back where the
          // customer pressed from — see `cancelUserSurface`.
          onStart: (input) => startNewConversation(input, view),
          onCancel: () => cancelUserSurface(view),
          onError: report,
        },
        askDetails ? [...remote.preChatFields] : [],
      ),
    );
  }

  /**
   * Mints a session carrying `input`'s topic/subject, then sends the typed
   * message as its opening line — the two-jobs-one-field design
   * `ui/new-conversation.ts`'s own header documents — with the pre-chat
   * details, when the form collected any, sent FIRST in the exact shape the
   * gate sends (`sendPreChatDetails`), so chat-service's pre-chat consumer
   * sees no difference between the two routes.
   *
   * Rejects rather than catching: the surface this runs as `onStart` for
   * already disables its own button and shows its own message on failure
   * (`submitOnce`, ui/forms.ts), and a second recovery path here would be a
   * second, possibly different, account of the same failure. That is also
   * why the surface stays up until the opening line has landed rather than
   * closing the moment the session is minted: a send that rejects needs the
   * form still there to say so and keep the customer's typing. No state tick
   * replaces it in the meantime — `syncProductSurfaces` does not preempt a
   * user-initiated surface, and `openingLinesInFlight` keeps the pre-chat
   * gate from arming on the new session's empty transcript. Only the
   * CUSTOMER can (Back, or another item from the ⋯ menu), which is why the
   * release at the end names `form`: whatever they put in the slot since is
   * theirs, not this function's to close — and why the exchange abandons
   * itself the moment the form stops holding the slot, rather than
   * addressing its sends to whatever conversation took its place.
   */
  async function startNewConversation(input: NewConversationInput, form: ProductSurface): Promise<void> {
    openingLinesInFlight += 1;
    try {
      // `startNewSession`, never `switchSession`: a switch joins a session
      // that already exists and deliberately mints nothing, so using it here
      // would drop the customer into whichever conversation the server
      // picked rather than the fresh one they asked for.
      //
      // `topic` spread conditionally, not passed as `undefined`:
      // `exactOptionalPropertyTypes` treats an explicit `undefined` as a
      // stated value, and core's own contract for this field is ABSENT means
      // "no topic chosen" (see `ui/new-conversation.ts`'s header).
      await store.client.startNewSession({
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        subject: input.message,
      });
      // A conversation the lists have never heard of now exists — and, under
      // the current chat-service contract, the PREVIOUS one is still open
      // beside it rather than having been closed to make room. Both facts are
      // only visible once the page is re-fetched; see `refreshSessions`.
      refreshSessions();
      // The mint is a full socket round trip, and the panel stays live across
      // it — Back is on screen, and so is the ⋯ menu. A customer who walks
      // away has abandoned THIS exchange, but core addresses every send to
      // whichever session is current when it is CALLED, so carrying on would
      // file this form's pre-chat answers and message against whatever
      // conversation they opened next (a Common Question mints its own). So
      // the flow stops here, with the session it minted left empty, rather
      // than speaking into someone else's thread; the `finally` still
      // releases the counter, and the form is already gone, so there is
      // nothing left to report into either.
      if (activeSurface?.view !== form) return;
      if (input.preChatAnswers !== undefined) await sendPreChatDetails(input.preChatAnswers);
      await store.client.sendMessage(input.message);
    } finally {
      openingLinesInFlight -= 1;
    }
    // Only reached on success. Recorded AFTER the whole opening exchange
    // landed, not when the details message did: a customer whose message
    // failed and who presses Start again mints a second session, and that
    // one must carry the details too — `input.preChatAnswers` still does.
    if (input.preChatAnswers !== undefined) preChatAnswered = true;
    releaseSurface(form);
    if (open) composer.input.focus({ preventScroll: true });
  }

  /**
   * A Common Questions row was tapped (`ui/common-questions.ts`).
   *
   * ── The real bug this replaces ────────────────────────────────────────
   *
   * The previous wiring called `store.client.sendMessage(question.prompt)`
   * directly. Common Questions render only while `ui/common-questions.ts`'s
   * own precondition holds — "before a conversation exists" — which means
   * `state.session` is `null` exactly when a customer can see a row to tap.
   * Core's `MessageController.sendMessage` throws `NoActiveSessionError` with
   * no session joined (see `packages/core/src/messages/controller.ts`), so
   * that call REJECTED on essentially every real tap, and `.catch(report)`
   * routed the failure straight to the console. Nothing the customer did was
   * wrong and nothing was visibly broken — the send simply never reached the
   * wire, which is indistinguishable from "tapping does nothing" from where
   * they were sitting. Confirmed live: a tap threw `NoActiveSessionError`
   * every time in the running widget.
   *
   * The fix mints a session first, exactly like `startNewConversation`
   * above — no topic/subject pair here, because a tapped question already
   * IS the subject — puts the resulting conversation on screen via
   * `showConversation` (the same call `selectSession` uses) the moment the
   * session exists, and only then sends the prompt as its opening line. The
   * navigation is the second half of the report: even a send that HAD
   * succeeded left the customer looking at whichever screen they tapped
   * from, with no visible sign anything happened. Navigating BEFORE the send
   * rather than after is what removes the blink: the transcript is on screen
   * for the send's round trip instead of Home, and `openingLinesInFlight`
   * keeps the pre-chat gate from filling that empty transcript first.
   *
   * ── Deliberately no pre-chat fields on this route ─────────────────────
   *
   * A Common Question is the merchant offering a direct route into a chat —
   * one tap, and the customer is talking. Putting the "ask for details
   * first" form between the tap and the conversation would turn the shortcut
   * back into the long way round, so this path skips the fields entirely
   * (and leaves `preChatAnswered` alone: the customer was never asked, so a
   * later new-conversation form still asks). The merchant who wants details
   * from everyone still gets them from every other entry point.
   */
  async function startCommonQuestion(question: CommonQuestion): Promise<void> {
    // Same rule as `selectSession`: a tapped question is a request for a
    // different conversation, so whatever the customer had open in the slot
    // is over before this one is minted.
    discardUserSurface();
    openingLinesInFlight += 1;
    try {
      await store.client.startNewSession({ subject: question.prompt });
      // Same as `startNewConversation`: a new row, and an old one that is
      // still open. See `refreshSessions`.
      refreshSessions();
      // A gate armed on the PREVIOUS (empty) session — parked behind Home
      // when the customer walked off it — may still hold the slot. The new
      // session's ack normally tears it down through the id/status
      // subscription, but that is a side effect of a store tick, not
      // something this function holds a promise for; re-running the sync
      // here, with the latch set, makes the release explicit. Idempotent
      // when the tick already did it.
      syncProductSurfaces();
      showConversation();
      if (open) composer.input.focus({ preventScroll: true });
      await store.client.sendMessage(question.prompt);
    } catch (error) {
      report(error);
    } finally {
      openingLinesInFlight -= 1;
    }
  }

  // ── open / close ──────────────────────────────────────────────────────
  function openPanel(): void {
    if (open || destroyed) return;
    open = true;
    // Whatever route opened it, the self-opening behaviour has no further job:
    // a delay that fires into an already-open panel is a no-op, and an
    // exit-intent listener left bound would reopen it after the visitor closes
    // it — the "argument, not a greeting" case armAutoOpen exists to avoid.
    releaseAutoOpen();
    releaseAutoOpen = () => undefined;
    // Seeing the conversation is what clears the mark. Before `syncLauncher`
    // runs below, so the badge cannot survive the open that answered it.
    agentInitiated = false;

    restoreFocus = captureFocus();
    panel.setAttribute('data-open', 'true');
    panel.removeAttribute('aria-hidden');
    launcher.setAttribute('aria-expanded', 'true');
    // In `bubble` the launcher stays visible as the close affordance; the
    // other two cover it entirely, so leaving it in the tab order would strand
    // a keyboard user on a control they cannot see.
    launcher.hidden = presentation !== 'bubble';

    trap = trapFocus(panel, shadow);

    focusOnOpen();

    // Asked here rather than at mount: a widget nobody opens should cost the
    // host page nothing beyond the socket it already opens. Every open, not
    // only the first — a status can have moved while the panel was shut, and
    // nothing else would tell us. See `refreshSessions`.
    requestSessions();

    // The identical argument, for the chooser's own entry: opening the panel
    // is the one moment the answer is about to be used, and the browser's
    // own HTTP cache (`max-age=30, stale-while-revalidate=300`) makes this
    // usually free. No timer, no poll — see `refreshRemoteConfig`'s own doc.
    if (Date.now() - remoteFetchedAt > SUPPORT_STALE_MS) void refreshRemoteConfig();

    try {
      store.client.markRead();
    } catch (error) {
      report(error);
    }
    // Opening the panel is the clearest statement of intent the customer can
    // make. If core parked the connection while they were away, this is the
    // moment to try again rather than showing them a dead widget and waiting
    // for them to find the button.
    reconnect('auto');
    syncLauncher(store.getState());
    messageList.render(store.getState(), localParticipantId);
  }

  function close(): void {
    if (!open) return;
    open = false;

    panel.setAttribute('data-open', 'false');
    panel.setAttribute('aria-hidden', 'true');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.hidden = false;

    // Forgets the back stack — see screens.ts's own contract for this
    // method. A customer three rows deep in Messages who closes and reopens
    // the widget gets the same landing screen everyone else does, not
    // wherever they happened to leave off; `initialScreenName` is the one
    // exception, for a host that named a specific `sessionId`.
    screens.reset(initialScreenName);

    trap?.release();
    trap = null;

    // Back where it came from. Without this, a keyboard user who opened the
    // chat from a "Need help?" link is dumped at the top of the document.
    restoreFocus?.();
    restoreFocus = null;

    syncLauncher(store.getState());
  }

  function toggle(): void {
    if (open) close();
    else openPanel();
  }

  // Contact-info enrichment for the console's contact-info panel — IP
  // watermark, raw user agent, best-effort GPS — captured ONCE per widget
  // session, here, "very early". Fire-and-forget and NOT awaited: per the
  // product decision behind this feature, none of this may gate the chat
  // opening (a slow ip-watermark fetch, and especially a GPS permission
  // prompt the visitor may never answer, must never delay `connect()` below).
  // Each piece reaches core independently via `client.setContactInfo()`
  // whenever (if ever) it resolves — see contact-info.ts's header for what
  // happens when that is after the first `connection.hello` already went out.
  void captureContactInfo(store.client, config.apiUrl);

  // Nothing above this point opened a socket. Connecting last means a config
  // or DOM failure surfaces before any network cost is incurred.
  //
  // Nothing here seeds history, and neither does any subscription above. Core
  // does it, on every `connected`, guarded by `pagination.initialLoaded` — so
  // it fetches page one exactly once per session and never re-requests it
  // under a customer who has scrolled back. The once-ever latch this file used
  // to keep could do neither: it could not re-arm when the customer switched
  // conversations, which is why picking a past session left the previous
  // session's transcript on screen.
  const connecting = store.client.connect();

  const namedSession = config.sessionId;
  if (namedSession === undefined) {
    connecting.catch(report);
  } else {
    // AFTER the socket is up, and through `switchSession` rather than
    // `joinSession`. Both halves of the old call were wrong. `joinSession`
    // writes a raw `session.join` frame, and `WebSocketTransport.send` DROPS a
    // frame written while the socket is closed — which, fired synchronously
    // beside `connect()`, it always was — so a host that named a session had
    // its instruction silently discarded on every page load. And even landed,
    // `joinSession` changes no client state: it neither clears the transcript
    // that is on screen nor fetches the named session's history.
    connecting.then(() => openNamedSession(namedSession)).catch(report);
  }
  if (config.openOnLoad) openPanel();

  return {
    store,
    open: openPanel,
    close,
    toggle,
    isOpen: () => open,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // Before anything else: an in-flight config fetch holds a timer and a
      // pending promise, and its `.then` would otherwise run against a torn-
      // down widget. The `destroyed` guard in there covers the race; this
      // releases the socket rather than leaving it to time out.
      remoteConfigAbort.abort();
      // A pending delay timer, or a document-level `mouseout` listener that
      // would otherwise outlive the shadow root.
      releaseAutoOpen();
      clearTimeout(greetingTimer);
      window.removeEventListener('resize', onResize);
      // Both hold a window listener or a timer that would otherwise outlive
      // the shadow root. The pump goes first: it subscribes to `network`.
      reconnectPump.destroy();
      unsubscribeNetwork();
      network.destroy();
      trap?.release();
      restoreFocus?.();
      // Before `store.destroy()`: these settle by unsubscribing from the
      // store, and `select`'s unsubscribe on an already-destroyed store is a
      // no-op rather than an error, but draining first keeps the ordering
      // obvious. A copy, because `finish` deletes from the set it walks.
      for (const cancel of [...pendingHistorySettles]) cancel();
      for (const unsubscribe of unsubscribers) unsubscribe();
      closeSurface();
      // Its pending storage read resolves after teardown otherwise, and would
      // touch a node that is on its way out.
      consent.destroy();
      // Its own document-level pointerdown listener, same as the message menu.
      headerMenu.destroy();
      composer.destroy();
      endedFooter.destroy();
      messagesScreen.destroy();
      // Its scroll IntersectionObserver, and the marker it inserted into
      // `.dh-home` — both would otherwise outlive the shadow root.
      heroHeader.destroy();
      // `disconnect: true` — this store built the client it wraps, so nothing
      // else on the page is using that socket.
      store.destroy({ disconnect: true });
      root.destroy();
    },
  };
}
