---
"@dhaam-ccrm/widget": minor
---

Add the visitor-facing chat-or-message chooser, driven by chat-service's
`support` block on `GET /widget/config`.

chat-service now resolves each tenant to one of six rows —
`{ primary: 'chat' | 'ticket' | 'offline' | 'none', secondary: 'chat' |
'ticket' | null, hours }` — and this release reads that answer rather than
re-deriving it. `remote-config.ts` gains `SupportEntry`, `entryFor` and an
extended `shouldMount`; `support: null` (an older chat-service, or a fetch
that never landed) degrades to exactly today's behaviour — a chat entry
point, `HIDE_WIDGET` still hides the launcher — which is what makes this safe
to ship ahead of the chat-service release it depends on.

- The Home CTA (`ui/home-screen.ts`) now shows "Chat now", "Leave a message"
  or today's "Send us a message", with a secondary text button beside it on
  the two rows that offer a choice ("Leave a message instead" / "Try live
  chat anyway").
- A new `'webform'` surface (`ui/webform-form.ts`, `webform.ts`) lets an
  anonymous visitor leave a message — name/email/phone/message, a honeypot,
  and an idempotency key stable across a retry — POSTed to the new
  `/widget/webform` endpoint via a dedicated client that never mints a token.
  A `403 CHANNEL_DISABLED` triggers one config re-fetch before it is ever
  shown as "switched off", never on the strength of the 403 alone.
- The existing `WidgetOfflineMode` offline form is extended, not duplicated:
  under `COLLECT_MESSAGE` while closed, a tenant with a ticket destination
  gets the webform in the SAME gate that used to build only the built-in
  offline form — an upgrade in place, from a chat message an agent had to
  notice to a durable, tracked submission.
- `ui/forms.ts`'s `submitOnce` now accepts a `failureMessage` function as
  well as a string, for the one surface that needs to choose its sentence
  from a typed error rather than have exactly one.

Additive and backward compatible: every existing tenant without a published
`support` block sees byte-identical behaviour, pinned by an exhaustive test
against the pre-chooser `shouldMount` rule.

**Bundle, measured (`scripts/bundle.mjs`), not estimated:** `dist/widget.js`
was 290,319 B raw / 85,985 B gzip before this change; it is now 301,764 B raw
/ 89,223 B gzip — **+11,445 B raw, +3,238 B gzip (+3.8%)**. `WIDGET_GZIP_BUDGET`
(92,160 B / 90 KiB) now fails the build if a future addition pushes past
roughly 2.9 KB more headroom.
