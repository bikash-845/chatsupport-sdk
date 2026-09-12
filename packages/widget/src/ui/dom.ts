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
export const DEFAULT_AVATAR_IMAGE: string =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
      '<circle cx="20" cy="20" r="20" fill="#E5E7EB"/>' +
      '<circle cx="20" cy="16" r="7" fill="#9CA3AF"/>' +
      '<path d="M6 35c1.6-8.4 7.9-13 14-13s12.4 4.6 14 13" fill="#9CA3AF"/>' +
      '</svg>',
  );

/**
 * The Dhaam AI wordmark, used as the fallback in place of {@link
 * DEFAULT_AVATAR_IMAGE} everywhere a *brand logo* 404s (header avatar in
 * `'logo'` mode, launcher bubble, hero banner) — as opposed to an *agent
 * photo* 404ing, which still falls back to the generic silhouette above.
 *
 * `fill="white"` throughout, same as the source asset: only safe to place on
 * the widget's own colored surfaces (header/launcher/hero backgrounds), which
 * is the only place this constant is used.
 */
export const DEFAULT_LOGO_IMAGE: string =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg width="72" height="23" viewBox="0 0 72 23" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M0 15V2H5C7 2 8 3 9 4C10 5 11 6 11 8C11 10 10 12 9 13C8 14 7 15 5 15H0ZM3 13H4C6 13 7 12 7 12C8 11 8 10 8 8C8 7 8 6 7 5C7 5 6 4 4 4H3V13Z" fill="white"/>' +
      '<path d="M11 15V1H14V7L13 6C13 6 14 6 15 5C15 5 16 5 16 5C17 5 18 5 18 5C19 6 19 6 19 7C20 7 20 8 20 9V15H18V9C18 8 17 8 17 7C17 7 16 7 16 7C15 7 15 7 15 7C14 7 14 7 14 7L14 15H11Z" fill="white"/>' +
      '<path d="M25 15C24 15 24 15 23 15C23 15 22 14 22 14C21 14 21 14 21 13C21 13 21 12 21 12C21 11 21 11 21 10C21 10 22 9 22 9C23 9 23 9 24 9C24 9 25 9 25 9C26 9 26 9 26 9C27 9 27 10 27 10L27 11C27 11 27 11 26 11C26 10 25 10 25 10C24 10 24 11 23 11C23 11 23 11 23 12C23 12 23 12 23 13C23 13 24 13 24 13C24 13 24 13 25 13C25 13 26 13 26 13C26 13 27 13 27 12V9C27 8 26 8 26 7C26 7 25 7 24 7C24 7 23 7 23 7C22 7 22 8 21 8V6C22 6 22 5 23 5C24 5 24 5 25 5C25 5 26 5 26 5C26 5 27 5 27 5C27 6 28 6 28 6C28 6 29 6 29 7C29 7 29 8 29 8V13C29 13 29 14 28 14C28 14 28 15 27 15C26 15 25 15 25 15Z" fill="white"/>' +
      '<path d="M34 15C33 15 33 15 32 15C32 15 31 14 31 14C30 14 30 14 30 13C30 13 30 12 30 12C30 11 30 11 30 10C30 10 31 9 31 9C32 9 32 9 33 9C33 9 34 9 34 9C35 9 35 9 35 9C36 9 36 10 36 10L36 11C36 11 36 11 35 11C35 10 34 10 34 10C33 10 33 11 32 11C32 11 32 11 32 12C32 12 32 12 32 13C32 13 33 13 33 13C33 13 33 13 34 13C34 13 35 13 35 13C36 13 36 13 36 12V9C36 8 35 8 35 7C35 7 34 7 33 7C33 7 32 7 32 7C31 7 31 8 30 8V6C31 6 31 5 32 5C33 5 33 5 34 5C34 5 35 5 35 5C36 5 36 5 36 5C37 6 37 6 37 6C37 6 38 6 38 7C38 7 38 8 38 8V13C38 13 38 14 37 14C37 14 37 15 36 15C35 15 34 15 34 15Z" fill="white"/>' +
      '<path d="M48 8V15H45V9C45 9 45 8 45 8C45 8 45 8 45 8C45 7 44 7 44 7C44 7 44 7 43 7C43 7 43 7 42 7C42 7 42 7 41 7V15H39V6C39 6 40 6 40 6C40 6 41 5 41 5C42 5 42 5 42 5C43 5 43 5 44 5C45 5 45 5 46 5C46 6 47 6 47 6C47 7 48 8 48 8ZM45 7C45 6 46 6 46 6C47 5 47 5 48 5C48 5 49 5 50 5C50 5 51 5 52 5C52 6 53 6 53 6C53 7 53 8 53 8V15H51V9C51 9 51 8 51 8C51 8 51 8 51 8C50 7 50 7 50 7C50 7 49 7 49 7C49 7 48 7 48 7C48 7 48 7 47 7L45 7Z" fill="white"/>' +
      '<path d="M69 0C71 0 72 1 72 3V14C72 15 71 17 69 17H58C56 17 55 15 55 14V3C55 1 56 0 58 0H69ZM61 5L59 14H60L60 12H64L65 14H66L63 5H61ZM66 5V14H67V5H66ZM64 11H61L62 6L64 11ZM67 2C67 2 67 2 67 2L67 3L67 3C66 3 66 3 66 3C66 3 66 3 66 3L66 3L66 3C66 3 66 4 66 4L66 4L66 4C66 4 66 4 66 4C66 4 66 4 67 4L67 5L67 5C67 5 67 5 67 5L67 4L67 4C67 4 67 4 67 4C68 4 68 4 68 4L68 4L68 4C68 4 68 3 68 3L68 3L68 3C68 3 67 3 67 3C67 3 67 3 67 3L67 2L67 2ZM68 2C68 2 68 2 68 2C68 2 68 2 68 2L68 2L68 2L68 2C68 2 68 2 68 2C68 2 68 2 68 2C68 2 68 2 68 2C68 3 68 3 68 3L68 3L68 3L68 3C68 3 68 3 68 3C68 3 68 3 68 3C68 3 68 3 68 3C68 3 68 3 68 3L68 3L68 3L68 3C68 3 68 2 68 2C68 2 68 2 68 2C68 2 68 2 68 2C68 2 68 2 68 2L68 2L68 2L68 2C68 2 68 2 68 2C68 2 68 2 68 2Z" fill="white"/>' +
      '<path d="M0 23V20H1V23H2V23H0Z" fill="white"/>' +
      '<path d="M4 23C4 23 4 23 3 23C3 23 3 23 3 22C3 22 3 22 3 22C3 21 3 21 3 21C3 21 3 21 3 21C4 21 4 20 4 20C4 20 4 21 5 21C5 21 5 21 5 21C5 21 5 21 5 22C5 22 5 22 5 22C5 22 5 22 5 22H3V22H5L5 22C5 21 5 21 5 21C5 21 5 21 4 21C4 21 4 21 4 21C4 21 4 21 4 21C3 21 3 21 3 21C3 21 3 22 3 22V22C3 22 3 22 3 22C3 22 3 22 4 22C4 23 4 23 4 23C4 23 4 23 4 23C5 22 5 22 5 22L5 23C5 23 5 23 5 23C4 23 4 23 4 23Z" fill="white"/>' +
      '<path d="M7 23V22L7 22V21C7 21 7 21 7 21C7 21 7 21 7 21C7 21 6 21 6 21C6 21 6 21 6 21L6 21C6 21 6 21 6 21C6 20 7 20 7 20C7 20 7 21 8 21C8 21 8 21 8 21V23H7ZM7 23C6 23 6 23 6 23C6 23 6 23 6 23C6 23 6 22 6 22C6 22 6 22 6 22C6 22 6 22 6 22C6 22 6 22 7 22H7V22H7C7 22 6 22 6 22C6 22 6 22 6 22C6 22 6 22 6 23C6 23 7 23 7 23C7 23 7 23 7 23C7 22 7 22 7 22L8 23C7 23 7 23 7 23C7 23 7 23 7 23Z" fill="white"/>' +
      '<path d="M10 23C10 23 9 23 9 23C9 23 9 23 9 22C9 22 9 22 9 22C9 21 9 21 9 21C9 21 9 21 9 21C9 21 10 20 10 20C10 20 10 20 10 21C11 21 11 21 11 21C11 21 11 21 11 22C11 22 11 22 11 22C11 23 11 23 10 23C10 23 10 23 10 23ZM10 23C10 23 10 23 10 22C10 22 11 22 11 22C11 22 11 22 11 22C11 22 11 21 11 21C11 21 10 21 10 21C10 21 10 21 10 21C10 21 10 21 9 21C9 21 9 21 9 21C9 21 9 22 9 22C9 22 9 22 9 22C9 22 9 22 9 22C10 23 10 23 10 23ZM11 23V22L11 22L11 21V19H11V23H11Z" fill="white"/>' +
      '<path d="M14 23V20H13V20H16V20H15V23H14Z" fill="white"/>' +
      '<path d="M18 20C18 20 18 20 18 21C19 21 19 21 19 21C19 21 19 21 19 22V23H18V22C18 21 18 21 18 21C18 21 18 21 18 21C18 21 17 21 17 21C17 21 17 21 17 21C17 21 17 22 17 22V23H17V19H17V21L17 21C17 21 17 21 17 21C17 20 18 20 18 20Z" fill="white"/>' +
      '<path d="M21 23C21 23 20 23 20 23C20 23 20 23 20 22C20 22 20 22 20 22C20 21 20 21 20 21C20 21 20 21 20 21C20 21 21 20 21 20C21 20 21 21 22 21C22 21 22 21 22 21C22 21 22 21 22 22C22 22 22 22 22 22C22 22 22 22 22 22H20V22H22L22 22C22 21 22 21 22 21C22 21 21 21 21 21C21 21 21 21 21 21C21 21 21 21 20 21C20 21 20 21 20 21C20 21 20 22 20 22V22C20 22 20 22 20 22C20 22 20 22 20 22C21 23 21 23 21 23C21 23 21 23 21 23C21 22 22 22 22 22L22 23C22 23 22 23 22 23C21 23 21 23 21 23Z" fill="white"/>' +
      '<path d="M24 23V20H26C26 20 26 20 26 20C27 20 27 20 27 20C27 20 27 21 27 21C27 21 27 21 27 21C27 22 27 22 26 22C26 22 26 22 26 22H25L25 22V23H24ZM25 22L25 22H26C26 22 26 21 26 21C26 21 27 21 27 21C27 21 26 20 26 20C26 20 26 20 26 20H25L25 20V22Z" fill="white"/>' +
      '<path d="M29 23V22L29 22V21C29 21 29 21 29 21C29 21 29 21 29 21C28 21 28 21 28 21C28 21 28 21 28 21L28 21C28 21 28 21 28 21C28 20 28 20 29 20C29 20 29 21 29 21C30 21 30 21 30 21V23H29ZM28 23C28 23 28 23 28 23C28 23 28 23 28 23C28 23 28 22 28 22C28 22 28 22 28 22C28 22 28 22 28 22C28 22 28 22 29 22H29V22H29C28 22 28 22 28 22C28 22 28 22 28 22C28 22 28 22 28 23C28 23 28 23 29 23C29 23 29 23 29 23C29 22 29 22 29 22L29 23C29 23 29 23 29 23C29 23 29 23 28 23Z" fill="white"/>' +
      '<path d="M32 23C32 23 31 23 31 23C31 23 31 23 31 22C31 22 30 22 30 22C30 21 31 21 31 21C31 21 31 21 31 21C31 21 32 20 32 20C32 20 32 20 32 21C33 21 33 21 33 21L32 21C32 21 32 21 32 21C32 21 32 21 32 21C32 21 31 21 31 21C31 21 31 21 31 21C31 21 31 22 31 22C31 22 31 22 31 22C31 22 31 22 31 22C31 23 32 23 32 23C32 23 32 23 32 23C32 22 32 22 32 22L33 22C33 23 33 23 32 23C32 23 32 23 32 23Z" fill="white"/>' +
      '<path d="M35 23C34 23 34 23 34 23C34 23 34 23 33 22C33 22 33 22 33 22C33 21 33 21 33 21C34 21 34 21 34 21C34 21 34 20 35 20C35 20 35 21 35 21C35 21 35 21 36 21C36 21 36 21 36 22C36 22 36 22 36 22C36 22 36 22 36 22H34V22H35L35 22C35 21 35 21 35 21C35 21 35 21 35 21C35 21 35 21 35 21C34 21 34 21 34 21C34 21 34 21 34 21C34 21 34 22 34 22V22C34 22 34 22 34 22C34 22 34 22 34 22C34 23 34 23 35 23C35 23 35 23 35 23C35 22 35 22 35 22L36 23C35 23 35 23 35 23C35 23 35 23 35 23Z" fill="white"/>' +
      '<path d="M39 23L38 20H38L39 23H39L40 20H40L41 23H41L42 20H43L42 23H41L40 20H40L39 23H39Z" fill="white"/>' +
      '<path d="M43 23V20H44V23H43ZM44 20C43 20 43 20 43 20C43 20 43 20 43 20C43 20 43 20 43 19C43 19 43 19 44 19C44 19 44 19 44 19C44 20 44 20 44 20C44 20 44 20 44 20C44 20 44 20 44 20Z" fill="white"/>' +
      '<path d="M46 23C45 23 45 23 45 23C45 23 45 22 45 22V20H45V22C45 22 45 22 45 23C45 23 46 23 46 23C46 23 46 23 46 22L46 23C46 23 46 23 46 23C46 23 46 23 46 23ZM44 21V20H46V21H44Z" fill="white"/>' +
      '<path d="M48 20C48 20 49 20 49 21C49 21 49 21 49 21C49 21 49 21 49 22V23H49V22C49 21 49 21 49 21C48 21 48 21 48 21C48 21 48 21 48 21C48 21 47 21 47 21C47 21 47 22 47 22V23H47V19H47V21L47 21C47 21 47 21 48 21C48 20 48 20 48 20Z" fill="white"/>' +
      '<path d="M51 23L53 20H53L55 23H54L53 20H53L52 23H51ZM52 22L52 22H54L54 22H52Z" fill="white"/>' +
      '<path d="M55 23V20H56V23H55Z" fill="white"/>' +
      '<path d="M60 23C59 23 59 23 59 23C59 23 59 23 58 23C58 22 58 22 58 22C58 22 58 22 58 21C58 21 58 21 58 21C58 20 58 20 58 20C59 20 59 20 59 20C59 20 59 20 60 20C60 20 60 20 60 20C61 20 61 20 61 20L61 20C61 20 60 20 60 20C60 20 60 20 60 20C60 20 59 20 59 20C59 20 59 20 59 20C59 21 59 21 59 21C58 21 58 21 58 21C58 21 58 22 59 22C59 22 59 22 59 22C59 22 59 22 59 22C59 23 60 23 60 23C60 23 60 23 60 23C60 22 61 22 61 22L61 23C61 23 61 23 60 23C60 23 60 23 60 23ZM61 23V21H61V23L61 23Z" fill="white"/>' +
      '<path d="M62 23V20H62V21L62 21C62 21 63 21 63 21C63 20 63 20 63 20V21C63 21 63 21 63 21C63 21 63 21 63 21C63 21 63 21 63 21C62 21 62 21 62 22V23H62Z" fill="white"/>' +
      '<path d="M65 23V22L65 22V21C65 21 65 21 65 21C65 21 65 21 65 21C64 21 64 21 64 21C64 21 64 21 64 21L64 21C64 21 64 21 64 21C64 20 64 20 65 20C65 20 65 21 65 21C66 21 66 21 66 21V23H65ZM65 23C64 23 64 23 64 23C64 23 64 23 64 23C64 23 64 22 64 22C64 22 64 22 64 22C64 22 64 22 64 22C64 22 64 22 65 22H65V22H65C64 22 64 22 64 22C64 22 64 22 64 22C64 22 64 22 64 23C64 23 64 23 65 23C65 23 65 23 65 23C65 22 65 22 65 22L65 23C65 23 65 23 65 23C65 23 65 23 65 23Z" fill="white"/>' +
      '<path d="M68 23C68 23 67 23 67 23C67 23 67 23 67 22C67 22 67 22 67 22C67 21 67 21 67 21C67 21 67 21 67 21C67 21 68 20 68 20C68 20 68 20 68 21C69 21 69 21 69 21L68 21C68 21 68 21 68 21C68 21 68 21 68 21C68 21 68 21 67 21C67 21 67 21 67 21C67 21 67 22 67 22C67 22 67 22 67 22C67 22 67 22 67 22C68 23 68 23 68 23C68 23 68 23 68 23C68 22 68 22 68 22L69 22C69 23 69 23 68 23C68 23 68 23 68 23Z" fill="white"/>' +
      '<path d="M71 23C70 23 70 23 70 23C70 23 70 23 69 22C69 22 69 22 69 22C69 21 69 21 69 21C70 21 70 21 70 21C70 21 70 20 71 20C71 20 71 21 71 21C71 21 72 21 72 21C72 21 72 21 72 22C72 22 72 22 72 22C72 22 72 22 72 22H70V22H72L71 22C71 21 71 21 71 21C71 21 71 21 71 21C71 21 71 21 71 21C70 21 70 21 70 21C70 21 70 21 70 21C70 21 70 22 70 22V22C70 22 70 22 70 22C70 22 70 22 70 22C70 23 70 23 71 23C71 23 71 23 71 23C71 22 71 22 71 22L72 23C72 23 71 23 71 23C71 23 71 23 71 23Z" fill="white"/>' +
      '<path d="M0 17C0 17 0 17 0 17H53C53 17 53 17 53 17C53 17 53 17 53 17H0C0 17 0 17 0 17Z" fill="white"/>' +
      '</svg>',
  );

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
