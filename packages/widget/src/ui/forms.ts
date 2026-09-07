// Form primitives shared by the three data-collecting surfaces — the pre-chat
// form, the out-of-hours form, and the CSAT survey.
//
// Extracted at the third use, not the first: the pre-chat form and the offline
// form render the SAME console-defined `PreChatField[]`, so their inputs have
// to agree on type mapping, required marking and label association or a
// merchant's field renders differently depending on which screen asked it.
//
// ── The bug this module exists to make unrepeatable ──────────────────────
//
// All three React originals are written as:
//
//     setBusy(true); await onSubmit(...); setBusy(false);
//
// with no `try`/`finally` and no rejection branch. A failed submit therefore
// leaves the button disabled and reading "Sending…" forever, with the
// customer's typed message still on screen and no way to send it — a network
// blip becomes a dead form. `submitOnce` below is the single place that is
// fixed, and every surface goes through it.

import { el } from './dom.js';

/** A console-defined field. Structurally the wire's `PreChatField`. */
export interface FieldSpec {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'email' | 'phone';
  readonly required: boolean;
}

export interface FieldView {
  readonly node: HTMLElement;
  readonly input: HTMLInputElement;
  /** Trimmed. */
  value(): string;
}

/**
 * `type` and `inputMode` for a field kind.
 *
 * `phone` becomes `tel` in both: there is no `type="phone"`, and getting this
 * wrong is the difference between a numeric keypad and a full QWERTY keyboard
 * on the device most customers are holding.
 */
const INPUT_KIND: Record<FieldSpec['type'], { type: string; inputMode: string }> = {
  text: { type: 'text', inputMode: 'text' },
  email: { type: 'email', inputMode: 'email' },
  phone: { type: 'tel', inputMode: 'tel' },
};

export function createField(spec: FieldSpec, idPrefix: string): FieldView {
  const inputId = `${idPrefix}-${spec.id}`;
  const kind = INPUT_KIND[spec.type];

  const label = el('label', {
    attrs: { class: 'dh-field-label', for: inputId },
    text: spec.label,
  });
  // Optional is marked, not required — the inverse of the usual asterisk
  // convention, and deliberately the same choice the console's own preview
  // makes, so a merchant sees their form labelled the way they designed it.
  if (!spec.required) {
    label.appendChild(el('span', { attrs: { class: 'dh-field-optional' }, text: ' (optional)' }));
  }

  const input = el('input', {
    attrs: {
      class: 'dh-field-input',
      id: inputId,
      type: kind.type,
      inputmode: kind.inputMode,
      // Set for ASSISTIVE TECH — a screen reader announces the field as
      // required — and deliberately NOT as the validation mechanism. Every
      // form here carries `novalidate`, so the browser's own bubble never
      // fires and this module owns the message.
      //
      // Without that, the two fight and the browser wins: `requestSubmit()`
      // runs constraint validation FIRST and refuses to dispatch `submit` at
      // all, so the specific, styled, focus-managing messages below would be
      // unreachable code and the customer would get an unstyled native
      // tooltip whose wording changes per browser.
      required: spec.required,
      autocomplete: autocompleteFor(spec),
    },
  });

  return {
    node: el('div', { attrs: { class: 'dh-field' }, children: [label, input] }),
    input,
    value: () => input.value.trim(),
  };
}

/**
 * A best-effort `autocomplete` token, so the browser can fill the two fields
 * it reliably knows. Guessed from the field TYPE first and the label only as a
 * fallback, because the type is structured data and the label is free text a
 * merchant wrote.
 */
function autocompleteFor(spec: FieldSpec): string {
  if (spec.type === 'email') return 'email';
  if (spec.type === 'phone') return 'tel';
  return /name/i.test(spec.label) ? 'name' : 'on';
}

export interface StatusLineView {
  readonly node: HTMLElement;
  show(message: string): void;
  clear(): void;
}

/** One `role="alert"` line per form. Announced when set, silent when empty. */
export function createStatusLine(): StatusLineView {
  const node = el('p', { attrs: { class: 'dh-form-error', role: 'alert', hidden: true } });
  return {
    node,
    show(message) {
      node.textContent = message;
      node.hidden = false;
    },
    clear() {
      node.textContent = '';
      node.hidden = true;
    },
  };
}

export interface SubmitButtonView {
  readonly node: HTMLButtonElement;
  setBusy(busy: boolean): void;
}

export function createSubmitButton(label: string, busyLabel: string): SubmitButtonView {
  const node = el('button', {
    attrs: { class: 'dh-form-submit', type: 'submit' },
    text: label,
  });
  return {
    node,
    setBusy(busy) {
      node.disabled = busy;
      node.textContent = busy ? busyLabel : label;
      // Spoken as well as shown: a disabled button that changed its own label
      // is a state change a screen reader should hear, and `aria-busy` is the
      // one attribute that says "working" without hijacking a live region.
      node.setAttribute('aria-busy', busy ? 'true' : 'false');
    },
  };
}

export interface SubmitOnceOptions {
  readonly button: SubmitButtonView;
  readonly status: StatusLineView;
  /**
   * What the customer is told when the submit rejects. A plain string for
   * every surface that has exactly one failure sentence; a function for one
   * that needs to choose among several from the rejection itself (the
   * web-form surface's `visitorMessage`, keyed off a typed error's `kind`).
   */
  readonly failureMessage: string | ((error: unknown) => string);
  readonly onError: (error: unknown) => void;
}

/**
 * Runs one submit, guaranteeing the form comes back to life afterwards.
 *
 * The `finally` is the entire point — see the module header. On rejection the
 * customer gets a plain sentence and their typed input back, and the ERROR
 * goes to the host's `onError` rather than onto the screen: the rejection
 * carries a stack and possibly a URL, and neither belongs in front of a
 * customer.
 *
 * Returns whether it succeeded, so callers can advance to a confirmation
 * state only when there is something to confirm.
 */
export async function submitOnce(
  run: () => Promise<void>,
  { button, status, failureMessage, onError }: SubmitOnceOptions,
): Promise<boolean> {
  button.setBusy(true);
  status.clear();
  try {
    await run();
    return true;
  } catch (error) {
    status.show(typeof failureMessage === 'string' ? failureMessage : failureMessage(error));
    onError(error);
    return false;
  } finally {
    button.setBusy(false);
  }
}

/**
 * The first unfilled required field, or `null`.
 *
 * Returns the FIELD rather than a boolean so the caller can move focus to it —
 * a form that says "fill in the fields above" without saying which one is a
 * scavenger hunt on a 6-field form.
 */
export function firstMissingRequired(
  fields: ReadonlyArray<{ spec: FieldSpec; view: FieldView }>,
): { spec: FieldSpec; view: FieldView } | null {
  for (const field of fields) {
    if (field.spec.required && field.view.value() === '') return field;
  }
  return null;
}
