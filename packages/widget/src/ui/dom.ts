// The smallest element helper that removes the two mistakes this UI would
// otherwise make repeatedly.
//
// Mistake one is `innerHTML`. Every string this widget renders is either a
// message body or a display name, and both come from other users of the host's
// product — the customer's own typing, an agent's reply. `innerHTML` on that
// path is stored XSS, and it is stored XSS *inside a shadow root on a
// customer's checkout page*, which is about the worst place to put it. So this
// module has no HTML-string entry point at all: text goes through `textContent`
// and nowhere else, and the only markup that is ever parsed is the icon set
// below, which is a module-scope constant with no interpolation in it.
//
// Mistake two is forgetting that `class` is not a property. `el('div', {
// class: 'x' })` and `element.class = 'x'` behave differently and the second
// silently does nothing; routing everything through `setAttribute` makes them
// the same thing.

/** Namespace for the icons. `createElement` would produce unstyleable HTML elements. */
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ElementSpec {
  /** Attributes. `null`/`undefined` values are skipped, so callers can inline conditionals. */
  readonly attrs?: Record<string, string | number | boolean | null | undefined>;
  /** Text content. Always set via `textContent` — never parsed as markup. */
  readonly text?: string;
  readonly children?: readonly Node[];
  readonly on?: Record<string, EventListener>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElementSpec = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applySpec(node, spec);
  return node;
}

function applySpec(node: Element, spec: ElementSpec): void {
  for (const [name, value] of Object.entries(spec.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  if (spec.text !== undefined) node.textContent = spec.text;
  for (const child of spec.children ?? []) node.appendChild(child);
  for (const [type, handler] of Object.entries(spec.on ?? {})) {
    node.addEventListener(type, handler);
  }
}

/**
 * Builds one icon from a path list.
 *
 * `aria-hidden` on every icon without exception: each one sits inside a
 * control that already carries a real accessible name, so an unhidden icon
 * would make a screen reader announce the button twice.
 */
export function icon(paths: readonly string[], size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * The same renderer for a FILLED glyph.
 *
 * Heroicons' solid set — which the console's launcher picker draws from — are
 * filled shapes with `fill="currentColor"` and no stroke. Passing one to
 * {@link icon} outlines its silhouette at 1.8px and fills nothing, which turns
 * a speech bubble into a smudge. Two renderers rather than a flag on one,
 * because the caller always knows statically which kind it holds.
 */
export function solidIcon(paths: readonly string[], size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    // Every one of these is authored for the even-odd rule; the default
    // nonzero fills the holes in, so a life-ring renders as a disc.
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('clip-rule', 'evenodd');
    svg.appendChild(path);
  }
  return svg;
}

export const ICONS = {
  chat: ['M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.8-.7L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4 20-7Z'],
  paperclip: ['M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  mic: ['M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v1a7 7 0 0 1-14 0v-1', 'M12 18.5V22'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
  stop: ['M7 7h10v10H7z'],
  // The session-switcher toggle (ui/session-picker.ts) — a plain list glyph,
  // not a chat/clock icon, so it does not compete visually with the launcher.
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  // Per-message actions (ui/message-actions.ts). A vertical ellipsis rather
  // than a horizontal one: the row it sits in is already horizontal, and the
  // upright form is what every mobile OS uses for "more on this item".
  more: ['M12 5h.01', 'M12 12h.01', 'M12 19h.01'],
  copy: ['M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  reply: ['M9 17l-5-5 5-5', 'M4 12h11a5 5 0 0 1 5 5v3'],
} as const;

/**
 * The launcher glyphs the console's icon picker offers, keyed by its own ids.
 *
 * ── These are the CONSOLE'S artwork, copied, not lookalikes ───────────────
 *
 * The console renders this picker from `@heroicons/react/24/solid`
 * (`app/components/chat/launcher/launcherIcons.tsx`). This package had its own
 * hand-drawn outline paths under the SAME ids, so a merchant who chose
 * "Conversations" saw one glyph in the console preview and a different one on
 * their storefront — the picker and the widget disagreeing about what the id
 * MEANS, which is the one thing an icon picker has to get right.
 *
 * So the `d` attributes below are Heroicons' own, lifted verbatim from the
 * installed package. They are SOLID, and must be drawn with {@link solidIcon}
 * rather than `icon()` — the outline renderer would stroke a filled shape and
 * produce a blot.
 *
 * If the console's picker gains an id, add it here with the same source.
 */
export const LAUNCHER_ICONS: Record<string, readonly string[]> = {
  // The package's own default, kept: the console has no id for it.
  chat: ICONS.chat,
  chats: [
    'M4.913 2.658c2.075-.27 4.19-.408 6.337-.408 2.147 0 4.262.139 6.337.408 1.922.25 3.291 1.861 3.405 3.727a4.403 4.403 0 0 0-1.032-.211 50.89 50.89 0 0 0-8.42 0c-2.358.196-4.04 2.19-4.04 4.434v4.286a4.47 4.47 0 0 0 2.433 3.984L7.28 21.53A.75.75 0 0 1 6 21v-4.03a48.527 48.527 0 0 1-1.087-.128C2.905 16.58 1.5 14.833 1.5 12.862V6.638c0-1.97 1.405-3.718 3.413-3.979Z',
    'M15.75 7.5c-1.376 0-2.739.057-4.086.169C10.124 7.797 9 9.103 9 10.609v4.285c0 1.507 1.128 2.814 2.67 2.94 1.243.102 2.5.157 3.768.165l2.782 2.781a.75.75 0 0 0 1.28-.53v-2.39l.33-.026c1.542-.125 2.67-1.433 2.67-2.94v-4.286c0-1.505-1.125-2.811-2.664-2.94A49.392 49.392 0 0 0 15.75 7.5Z',
  ],
  message: [
    'M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 0 1-3.476.383.39.39 0 0 0-.297.17l-2.755 4.133a.75.75 0 0 1-1.248 0l-2.755-4.133a.39.39 0 0 0-.297-.17 48.9 48.9 0 0 1-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97ZM6.75 8.25a.75.75 0 0 1 .75-.75h9a.75.75 0 0 1 0 1.5h-9a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5H12a.75.75 0 0 0 0-1.5H7.5Z',
  ],
  help: [
    'M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm11.378-3.917c-.89-.777-2.366-.777-3.255 0a.75.75 0 0 1-.988-1.129c1.454-1.272 3.776-1.272 5.23 0 1.513 1.324 1.513 3.518 0 4.842a3.75 3.75 0 0 1-.837.552c-.676.328-1.028.774-1.028 1.152v.75a.75.75 0 0 1-1.5 0v-.75c0-1.279 1.06-2.107 1.875-2.502.182-.088.351-.199.503-.331.83-.727.83-1.857 0-2.584ZM12 18a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z',
  ],
  support: [
    'M19.449 8.448 16.388 11a4.52 4.52 0 0 1 0 2.002l3.061 2.55a8.275 8.275 0 0 0 0-7.103ZM15.552 19.45 13 16.388a4.52 4.52 0 0 1-2.002 0l-2.55 3.061a8.275 8.275 0 0 0 7.103 0ZM4.55 15.552 7.612 13a4.52 4.52 0 0 1 0-2.002L4.551 8.45a8.275 8.275 0 0 0 0 7.103ZM8.448 4.55 11 7.612a4.52 4.52 0 0 1 2.002 0l2.55-3.061a8.275 8.275 0 0 0-7.103 0Zm8.657-.86a9.776 9.776 0 0 1 1.79 1.415 9.776 9.776 0 0 1 1.414 1.788 9.764 9.764 0 0 1 0 10.211 9.777 9.777 0 0 1-1.415 1.79 9.777 9.777 0 0 1-1.788 1.414 9.764 9.764 0 0 1-10.212 0 9.776 9.776 0 0 1-1.788-1.415 9.776 9.776 0 0 1-1.415-1.788 9.764 9.764 0 0 1 0-10.212 9.774 9.774 0 0 1 1.415-1.788A9.774 9.774 0 0 1 6.894 3.69a9.764 9.764 0 0 1 10.211 0ZM14.121 9.88a2.985 2.985 0 0 0-1.11-.704 3.015 3.015 0 0 0-2.022 0 2.985 2.985 0 0 0-1.11.704c-.326.325-.56.705-.704 1.11a3.015 3.015 0 0 0 0 2.022c.144.405.378.785.704 1.11.325.326.705.56 1.11.704.652.233 1.37.233 2.022 0a2.985 2.985 0 0 0 1.11-.704c.326-.325.56-.705.704-1.11a3.016 3.016 0 0 0 0-2.022 2.985 2.985 0 0 0-.704-1.11Z',
  ],
  phone: [
    'M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z',
  ],
  mail: [
    'M1.5 8.67v8.58a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V8.67l-8.928 5.493a3 3 0 0 1-3.144 0L1.5 8.67Z',
    'M22.5 6.908V6.75a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3v.158l9.714 5.978a1.5 1.5 0 0 0 1.572 0L22.5 6.908Z',
  ],
  sparkle: [
    'M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813A3.75 3.75 0 0 0 7.466 7.89l.813-2.846A.75.75 0 0 1 9 4.5ZM18 1.5a.75.75 0 0 1 .728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 0 1 0 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 0 1-1.456 0l-.258-1.036a2.625 2.625 0 0 0-1.91-1.91l-1.036-.258a.75.75 0 0 1 0-1.456l1.036-.258a2.625 2.625 0 0 0 1.91-1.91l.258-1.036A.75.75 0 0 1 18 1.5ZM16.5 15a.75.75 0 0 1 .712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 0 1 0 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 0 1-1.422 0l-.395-1.183a1.5 1.5 0 0 0-.948-.948l-1.183-.395a.75.75 0 0 1 0-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0 1 16.5 15Z',
  ],
};

/** Ids whose artwork is a FILLED shape rather than a stroked outline. */
export const SOLID_LAUNCHER_ICONS: ReadonlySet<string> = new Set([
  'chats', 'message', 'help', 'support', 'phone', 'mail', 'sparkle',
]);

/**
 * A config-supplied image URL, or `null` if it is not one we will load.
 *
 * The allowlist is the point. `logoUrl`, `imageUrl` and the header's avatars
 * all arrive from a merchant's console over a public endpoint, and every one
 * of them ends up in a `src` attribute inside a shadow root on someone else's
 * checkout page. Three things are refused:
 *
 *   - `javascript:` — inert in `<img src>` today, but this same guard is what
 *     the header's logo and CTA will pass through, and one of those could
 *     become an `<a href>` the day a design changes.
 *   - `data:` that is not an image — the console writes `data:image/…` for an
 *     uploaded file, and nothing else it writes has any business being one.
 *   - anything relative — it would resolve against the HOST page's origin, so
 *     a merchant's typo would silently fetch a random path off a storefront
 *     nobody involved controls.
 *
 * `blob:` is not on the list because it is meaningless here: a blob URL is
 * scoped to the document that created it, and this one arrived as JSON.
 */
export function safeImageUrl(value: string): string | null {
  const url = value.trim();
  if (url === '') return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\/[a-zA-Z0-9_\-\.\/]+/i.test(url)) return url;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(url)) return url;
  return null;
}

/**
 * The fallback source for a logo/avatar `<img>` whose configured URL passed
 * {@link safeImageUrl} but the BROWSER still could not load — most commonly
 * the documented relative-path risk above: a merchant's `/assets/...` path
 * resolves against whichever origin embeds the widget, and a tenant whose
 * config was written for a different origin (or whose asset was since
 * deleted) 404s there forever, not just once. A `<img>` with no `onerror`
 * handler just sits there as the browser's broken-image glyph, which reads
 * as this widget being broken rather than as one tenant's stale asset.
 *
 * An inline `data:` URI, deliberately — never a same-origin request, so it
 * cannot itself 404, and callers wire it up with `{ once: true }` so a
 * transient network blip does not retry into a loop against a URL that is
 * never coming back.
 */
import { AGENT_1_IMAGE, DEFAULT_AGENT_AVATARS } from './agent-avatars.js';
export { DEFAULT_AGENT_AVATARS };

export const DEFAULT_AVATAR_IMAGE: string = AGENT_1_IMAGE;

/**
 * The Dhaam AI wordmark, used as the fallback in place of {@link
 * DEFAULT_AVATAR_IMAGE} everywhere a *brand logo* 404s (header avatar in
 * `'logo'` mode, launcher bubble, hero banner) — as opposed to an *agent
 * photo* 404ing, which still falls back to the generic silhouette above.
 *
 * `fill="white"` throughout, same as the source asset: only safe to place on
 * the widget's own colored surfaces (header/launcher/hero backgrounds).
 */
export const DEFAULT_LOGO_IMAGE: string = '/assets/chat/default-logo.svg';

/**
 * The same allowlist for a value going into an `href`, where the stakes are
 * higher than in a `src`.
 *
 * Deliberately NARROWER than {@link safeImageUrl} rather than a reuse of it:
 * `data:` is refused outright here. A `data:image/svg+xml` in an `<img>` is
 * rendered as a picture with no script, but the same string NAVIGATED to is a
 * document with a script — the exact difference the two guards exist to keep
 * apart. Only absolute `http(s)` survives, so `javascript:` is unreachable
 * rather than merely unlikely, and a relative path cannot silently point at
 * the host page's own origin.
 */
export function safeLinkUrl(value: string): string | null {
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : null;
}
