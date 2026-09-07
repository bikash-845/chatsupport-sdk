// The web-form surface: an anonymous visitor leaving a message.
//
// Reached from two directions — see `widget.ts`'s `openWebform` and the
// gate-1 carve-out in `syncProductSurfaces` — but built here exactly once,
// the same "one surface, several openers" shape `ui/offline-form.ts` and
// `ui/report-issue.ts` already use.
//
// ── This is NOT `ui/report-issue.ts` ─────────────────────────────────────
//
// That form files a ticket FROM INSIDE an authenticated conversation, against
// a `sessionId`. This one is for a visitor who never started a conversation
// and holds no session — the route resolves the tenant from the publishable
// key alone (`docs/design/DECISIONS.md` D3) and never mints one. They share
// `ui/forms.ts` and nothing else.
//
// ── The honeypot ──────────────────────────────────────────────────────────
//
// `company_website`, fixed by the server's schema. A REAL input in the DOM —
// a bot reads the DOM, not the stylesheet — hidden by the geometry this
// package already ships for screen-reader-only text (`.dh-sr`), and kept out
// of both the tab order and the accessibility tree. No `-9999px` offset: a
// later `left` would override a logical `inset-inline-start` outright (they
// cascade together), producing a physical-only rule with no honest RTL
// story, and a 9999px offset inside the panel is its own horizontal-overflow
// risk on the host page. `.dh-sr` has no offsets at all.
//
// ── `prefer` is always `'ticket'` from this surface ─────────────────────
//
// Leaving a message is what this form is FOR. Row 2's "Try live chat
// anyway" does not submit through here at all — it calls `onChooseChat`,
// which hands the visitor to a real, authenticated socket session
// (`startNewConversation`). This form never sends `prefer: 'chat'`.

import { el } from './dom.js';
import {
  createField,
  createStatusLine,
  createSubmitButton,
  firstMissingRequired,
  submitOnce,
} from './forms.js';
import type { FieldSpec } from './forms.js';
import { WEBFORM_MESSAGE_MAX, WebformError, newSubmissionId, visitorMessage } from '../webform.js';
import type { WebformDraft, WebformReceipt } from '../webform.js';

export interface WebformFormOptions {
  /** Row 2's "Try live chat anyway" — present only when the resolved entry's
   *  secondary option is chat. `null` renders no alternative at all. */
  readonly alternative: 'chat' | null;
  readonly hours: 'OPEN' | 'CLOSED' | 'NO_CALENDAR' | 'UNKNOWN';
  /**
   * `'assumed'` never actually reaches this form today — `entryFor` only
   * ever returns `'assumed'` paired with `primary: 'chat'`, which cannot open
   * a webform surface either from the Home CTA or from gate 1 — but it is
   * threaded through anyway so a future change to that resolution can never
   * make an unpublished entry claim "we're closed" here without this form
   * having to change too. See the closed-copy guard below.
   */
  readonly source: 'published' | 'assumed';
  readonly offlineMessage?: string;
  /** The merchant's pre-chat fields, for a guest visitor — folded into the
   *  message body, exactly like `ui/offline-form.ts`: there is no structured
   *  slot for them on the wire, and this path produces a message a human
   *  reads, not a record with a schema. */
  readonly extraFields: readonly FieldSpec[];
}

export interface WebformFormCallbacks {
  /** Submits the draft. Resolves with the receipt, rejects with a
   *  `WebformError` — the form shows its own message and keeps what the
   *  visitor typed either way. */
  readonly onSubmit: (draft: WebformDraft) => Promise<WebformReceipt>;
  /** Row 2's escape hatch back to a real chat. Absent when `alternative` is
   *  `null`, or when this form was raised automatically (gate 1) rather than
   *  opened by the visitor. */
  readonly onChooseChat?: () => void;
  /** Absent for the automatic (gate-1) form, which has nowhere to cancel TO —
   *  it is standing in for the composer, not a detour from it. */
  readonly onCancel?: () => void;
  readonly onError: (error: unknown) => void;
}

export interface WebformView {
  readonly node: HTMLElement;
  focus(): void;
  destroy(): void;
}

const NAME_FIELD: FieldSpec = { id: 'name', label: 'Name', type: 'text', required: false };
const EMAIL_FIELD: FieldSpec = { id: 'email', label: 'Email', type: 'email', required: true };
const PHONE_FIELD: FieldSpec = { id: 'phone', label: 'Phone', type: 'phone', required: false };
const FIELDS: readonly FieldSpec[] = [NAME_FIELD, EMAIL_FIELD, PHONE_FIELD];

/**
 * Console fields that duplicate the three built-ins above — same dedup rule
 * `ui/offline-form.ts` applies for the same reason: the console seeds every
 * workspace with "Your name" and "Email address", so without this a merchant
 * who never touched pre-chat settings gets a field asking twice.
 */
const BUILT_IN_LABEL = /^(name|your name|email|email address|phone|contact|contact details)$/i;

export function createWebformForm(
  options: WebformFormOptions,
  callbacks: WebformFormCallbacks,
): WebformView {
  const closed = options.source === 'published' && options.hours === 'CLOSED';

  const banner = el('div', {
    attrs: { class: 'dh-offline-banner' },
    children: [
      el('p', {
        attrs: { class: 'dh-form-heading', id: 'dh-webform-heading' },
        text: closed ? "We're currently offline." : 'Leave a message',
      }),
      el('p', {
        attrs: { class: 'dh-form-subtitle' },
        text: closed
          ? (options.offlineMessage ?? "Leave us a message and we'll get back to you.")
          : "We'll reply by email.",
      }),
    ],
  });

  const views = FIELDS.map((spec) => ({ spec, view: createField(spec, 'dh-webform') }));
  const custom = options.extraFields
    .filter((spec) => !BUILT_IN_LABEL.test(spec.label.trim()))
    .map((spec) => ({ spec, view: createField(spec, 'dh-webform') }));

  const messageLabel = el('label', {
    attrs: { class: 'dh-field-label', for: 'dh-webform-message' },
    text: 'How can we help?',
  });
  const message = el('textarea', {
    attrs: {
      class: 'dh-field-input dh-offline-message',
      id: 'dh-webform-message',
      rows: '4',
      maxlength: String(WEBFORM_MESSAGE_MAX),
    },
  });

  // ── Honeypot. See this module's header. ─────────────────────────────
  const honeypot = el('input', {
    attrs: {
      id: 'dh-webform-company-website',
      name: 'company_website',
      type: 'text',
      tabindex: '-1',
      autocomplete: 'off',
    },
  });
  const honeypotWrap = el('div', {
    attrs: { class: 'dh-sr', 'aria-hidden': 'true' },
    children: [honeypot],
  });

  const status = createStatusLine();
  const submit = createSubmitButton('Send message', 'Sending…');

  const cancel =
    callbacks.onCancel === undefined
      ? null
      : el('button', {
          attrs: { class: 'dh-form-skip', type: 'button' },
          text: 'Cancel',
          on: { click: () => callbacks.onCancel?.() },
        });

  // Its own class, deliberately NOT `.dh-form-skip`: on Row 2, `openWebform`
  // supplies BOTH `onCancel` and `onChooseChat` unconditionally (design
  // §5.2), and this button and Cancel above can therefore be on screen
  // together — sharing a class here would make `.dh-form-skip` stop
  // uniquely identifying "the Cancel button" within an open surface, the
  // same collision `ui/home-screen.ts`'s own alt button caused once already
  // (see that file's comment). `.dh-webform-alt` gets `.dh-form-skip`'s LOOK
  // (styles.ts) without its identity.
  const chatAlt =
    options.alternative === 'chat' && callbacks.onChooseChat !== undefined
      ? el('button', {
          attrs: { class: 'dh-webform-alt', type: 'button' },
          text: 'Try live chat anyway',
          on: { click: () => callbacks.onChooseChat?.() },
        })
      : null;

  const actions = el('div', {
    attrs: { class: 'dh-form-actions' },
    children: cancel === null ? [submit.node] : [submit.node, cancel],
  });

  const form = el('form', {
    attrs: { class: 'dh-form dh-webform-form', 'aria-labelledby': 'dh-webform-heading', novalidate: true },
    children: [
      banner,
      ...views.map((f) => f.view.node),
      ...custom.map((f) => f.view.node),
      el('div', { attrs: { class: 'dh-field' }, children: [messageLabel, message] }),
      honeypotWrap,
      status.node,
      actions,
      ...(chatAlt === null ? [] : [chatAlt]),
    ],
    on: {
      submit: (event) => {
        event.preventDefault();
        void run();
      },
    },
  });

  // Reuses `.dh-offline-sent` wholesale — see `ui/offline-form.ts`'s own
  // confirmation. A confirmation, not a toast: the form is spent once sent,
  // and leaving it on screen invites a second identical message from a
  // visitor unsure the first one landed.
  const confirmation = el('div', {
    attrs: { class: 'dh-offline-sent', role: 'status', hidden: true },
    children: [
      el('p', { attrs: { class: 'dh-form-heading' }, text: 'Message received' }),
      el('p', { attrs: { class: 'dh-form-subtitle' } }),
    ],
  });

  const node = el('div', { attrs: { class: 'dh-webform' }, children: [form, confirmation] });

  // Minted once, at build time, and reused by every attempt from this form
  // instance — a retry after a rejected attempt must send the SAME id, or
  // the server's idempotency guard cannot recognise it as the same
  // submission. `builtAt` is likewise fixed at build time: `fillMs` is an
  // ELAPSED delta, never a wall-clock stamp.
  const submissionId = newSubmissionId();
  const builtAt = Date.now();
  let lastReceipt: WebformReceipt | null = null;

  function focusFieldNamed(name: string): void {
    const match = views.find((f) => f.spec.id === name) ?? custom.find((f) => f.spec.id === name);
    if (match !== undefined) {
      match.view.input.focus({ preventScroll: true });
      return;
    }
    if (name === 'message') message.focus({ preventScroll: true });
  }

  async function run(): Promise<void> {
    const missing = firstMissingRequired(views) ?? firstMissingRequired(custom);
    if (missing !== null) {
      status.show(`${missing.spec.label} is required.`);
      missing.view.input.focus({ preventScroll: true });
      return;
    }
    if (message.value.trim() === '') {
      status.show('Please tell us what you need.');
      message.focus({ preventScroll: true });
      return;
    }

    const byId = (id: string): string =>
      views.find((f) => f.spec.id === id)?.view.value() ?? '';
    const nameValue = byId('name');
    const emailValue = byId('email');
    const phoneValue = byId('phone');

    const answered = custom.filter((field) => field.view.value() !== '');
    const extra = answered.map((field) => `${field.spec.label}: ${field.view.value()}`).join('\n\n');
    const body = extra === '' ? message.value.trim() : `${message.value.trim()}\n\n${extra}`;

    const pageUrl = typeof window === 'undefined' ? undefined : window.location.href;
    const locale = typeof navigator === 'undefined' ? undefined : navigator.language;

    const draft: WebformDraft = {
      submissionId,
      ...(nameValue === '' ? {} : { name: nameValue }),
      email: emailValue,
      ...(phoneValue === '' ? {} : { phone: phoneValue }),
      message: body,
      prefer: 'ticket',
      ...(pageUrl === undefined ? {} : { pageUrl }),
      ...(locale === undefined ? {} : { locale }),
      fillMs: Date.now() - builtAt,
      company_website: honeypot.value,
    };

    const sent = await submitOnce(
      async () => {
        lastReceipt = await callbacks.onSubmit(draft);
      },
      {
        button: submit,
        status,
        failureMessage: (error: unknown) => visitorMessage(error),
        onError: (error: unknown) => {
          callbacks.onError(error);
          if (error instanceof WebformError && error.field !== undefined) focusFieldNamed(error.field);
        },
      },
    );

    if (!sent || lastReceipt === null) return;
    const line =
      lastReceipt.outcome === 'chat'
        ? `Thanks — someone will pick this up and reply to ${emailValue}.`
        : `Message received. We'll reply to ${emailValue}.`;
    const echo = confirmation.querySelector('.dh-form-subtitle');
    if (echo !== null) echo.textContent = line;
    form.hidden = true;
    confirmation.hidden = false;
    // Focus follows the surface — leaving it on the now-hidden submit button
    // would strand a keyboard visitor on an element that no longer exists to
    // them. Same rule, same mechanism, as `ui/offline-form.ts`.
    confirmation.setAttribute('tabindex', '-1');
    confirmation.focus({ preventScroll: true });
  }

  return {
    node,
    focus() {
      (form.hidden ? confirmation : views[0]!.view.input).focus({ preventScroll: true });
    },
    destroy() {
      // No document-level listeners; every listener here is on a node inside
      // `node`, and goes with it.
    },
  };
}
