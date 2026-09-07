// The anonymous web-form submit client — POST /widget/webform.
//
// A DEDICATED client, not `RestClient` (`packages/rest`), and that is
// deliberate: `RestClient.request` awaits `#getAccessToken()` and sends
// `Authorization: Bearer` on every call, but this route takes only
// `X-Publishable-Key` and never mints a token (see
// `docs/design/chat-service-webform-endpoint.md` D3 and
// `docs/design/DECISIONS.md` D3) — the tenant comes from the key alone.
// Routing an anonymous submit through `RestClient` would make it fail
// whenever the token mint fails, which is exactly the outage during which a
// visitor most wants to leave a message.
//
// Shaped like `remote-config.ts`'s fetch half instead: its own `fetch`, its
// own `AbortController`, and a contract that resolves with exactly one shape
// or rejects with exactly one shape.
//
// ── The server's `message` is never shown ────────────────────────────────
//
// An error body is attacker-influencable and may echo request detail —
// `packages/rest/src/client.ts` states the same rule for the same reason.
// The visitor's sentence comes from {@link visitorMessage}, which reads only
// `error.kind`; the raw error (with its `code` and `requestId`) goes to
// `config.onError`.

/** Path is fixed by chat-service; only the origin is the host's to state. */
export const WEBFORM_PATH = '/chat-services/api/v1/widget/webform';

/**
 * Longer than the config fetch's 2 s: this one carries the visitor's words,
 * and abandoning it early would ask them to retype rather than wait.
 */
export const WEBFORM_TIMEOUT_MS = 15_000;

/**
 * Mirrors the server's `WEBFORM_LIMITS` for the two fields a visitor can
 * realistically overrun. Advisory only — the server is the authority, and a
 * disagreement is a 400 this client surfaces, not a rule it owns.
 */
export const WEBFORM_MESSAGE_MAX = 4000;
export const WEBFORM_SUBJECT_MAX = 200;

/**
 * Exactly the accepted body. No extra keys — the route is `.strict()` and an
 * unknown key is a 400.
 */
export interface WebformDraft {
  /** Caller-minted idempotency key, stable for the life of one form instance. */
  readonly submissionId: string;
  readonly name?: string;
  /** REQUIRED — nexusai's ticket create demands one, and the server, not the
   *  visitor, picks whether this submission becomes a ticket. */
  readonly email: string;
  readonly phone?: string;
  readonly subject?: string;
  readonly message: string;
  /** Honoured ONLY on the decision-table rows that offer a choice. This
   *  widget never sends `'chat'` here — see `ui/webform-form.ts`'s header. */
  readonly prefer?: 'chat' | 'ticket';
  readonly pageUrl?: string;
  readonly locale?: string;
  /** Elapsed ms since the form rendered. Never a wall-clock stamp. */
  readonly fillMs: number;
  /** HONEYPOT. Always sent; `''` for a human. */
  readonly company_website: string;
}

export type WebformFailureKind =
  | 'validation' // 400 VALIDATION_FAILED — our predicates and theirs disagree
  | 'unauthorized' // 401 AUTH_INVALID — the merchant's publishable key is wrong or revoked
  | 'origin' // 403 ORIGIN_NOT_ALLOWED
  | 'channel_off' // 403 CHANNEL_DISABLED — our cached `support` is stale
  | 'too_large' // 413 PAYLOAD_TOO_LARGE
  | 'rate_limited' // 429 RATE_LIMITED
  | 'unavailable' // 503 WEBFORM_UNAVAILABLE or 500 INTERNAL
  | 'network'; // no verdict at all: offline, CORS, DNS, abort

export interface WebformErrorDetails {
  /** The server's `error.code`, when the body carried one. Diagnostic. */
  readonly code?: string;
  /** Present only for `'validation'`, when `details.fieldErrors` named one. */
  readonly field?: string;
  /** Seconds, from `Retry-After`. Present only for `'rate_limited'`. */
  readonly retryAfterSec?: number;
  /** `X-Request-ID`, echoed by the handler. For `onError` only. */
  readonly requestId?: string;
}

/** Rejected with by {@link submitWebform}. Never anything else. */
export class WebformError extends Error {
  readonly kind: WebformFailureKind;
  readonly retryable: boolean;
  readonly code: string | undefined;
  readonly field: string | undefined;
  readonly retryAfterSec: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    kind: WebformFailureKind,
    message: string,
    retryable: boolean,
    details: WebformErrorDetails = {},
  ) {
    super(message);
    this.name = 'WebformError';
    this.kind = kind;
    this.retryable = retryable;
    this.code = details.code;
    this.field = details.field;
    this.retryAfterSec = details.retryAfterSec;
    this.requestId = details.requestId;
  }
}

export interface WebformReceipt {
  readonly outcome: 'chat' | 'ticket' | 'queued';
  readonly receiptId: string;
  /** True when this exact submission was already accepted; the other fields
   *  describe the ORIGINAL, not a second artefact. */
  readonly duplicate: boolean;
  /** Present only when `outcome === 'chat'`. */
  readonly chatSessionId?: string;
  /** Present only when `outcome === 'ticket'` AND nexusai returned one. */
  readonly ticketRef?: string;
}

/**
 * One id per form instance, minted when the form builds and reused by every
 * attempt from it — never regenerated on a retry.
 *
 * Without this, an abort is not a rollback: the request may have been
 * received and the row written before the 202 was lost in transit, and a
 * retry with a fresh id would file a second real submission. The server
 * closes this with `UNIQUE (tenant_id, idempotency_key)`, but only if every
 * attempt from one form sends the SAME key.
 *
 * `crypto.randomUUID` needs a secure context and this widget also runs on
 * plain-http storefronts, so it is feature-detected rather than assumed.
 * Matches the server's `/^[A-Za-z0-9._:-]{8,64}$/`.
 */
export function newSubmissionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const GENERIC_RETRY_MESSAGE = "We couldn't save that just now — please try again.";

/** Failure → the one sentence a visitor sees. Total, and pure. */
export function visitorMessage(error: unknown): string {
  const kind = error instanceof WebformError ? error.kind : 'network';
  switch (kind) {
    case 'validation':
      return 'Please check the highlighted field and try again.';
    case 'unauthorized':
    case 'origin':
      return "We can't reach support from this page right now.";
    case 'channel_off':
      return 'Messaging is switched off for this site.';
    case 'too_large':
      return 'That message is too long — please shorten it.';
    case 'rate_limited':
      return 'Too many messages from this page just now. Try again in a minute.';
    case 'unavailable':
    case 'network':
      return GENERIC_RETRY_MESSAGE;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `error.details.fieldErrors`'s first key, or `undefined`. */
function fieldFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body['error'];
  if (!isRecord(error)) return undefined;
  const details = error['details'];
  if (!isRecord(details)) return undefined;
  const fieldErrors = details['fieldErrors'];
  if (!isRecord(fieldErrors)) return undefined;
  const [first] = Object.keys(fieldErrors);
  return first;
}

function codeFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body['error'];
  return isRecord(error) ? str(error['code']) : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Status (and, for the one status that needs it, `error.code`) → a typed
 * {@link WebformError}. Total: a status this bundle has never seen still
 * produces a sentence, via the `>= 500` / everything-else split at the end.
 */
function errorFromResponse(response: Response, body: unknown): WebformError {
  const status = response.status;
  const code = codeFromBody(body);
  const requestId = response.headers.get('X-Request-ID') ?? undefined;
  const details: WebformErrorDetails = {
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { requestId }),
  };

  if (status === 401) {
    return new WebformError('unauthorized', `webform submit → 401${code ? ` ${code}` : ''}`, false, details);
  }
  if (status === 403) {
    // Told apart by `error.code`, not by the status. A 403 with an
    // unparseable body falls to 'origin' — the safer of the two, since it
    // does not trigger the §4.4 stale-cache refresh a `channel_off` would.
    const kind = code === 'CHANNEL_DISABLED' ? 'channel_off' : 'origin';
    return new WebformError(kind, `webform submit → 403 ${code ?? '(no code)'}`, false, details);
  }
  if (status === 413) {
    return new WebformError('too_large', 'webform submit → 413', false, details);
  }
  if (status === 429) {
    const retryAfterSec = parseRetryAfter(response.headers.get('Retry-After'));
    return new WebformError('rate_limited', 'webform submit → 429', true, {
      ...details,
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
    });
  }
  if (status >= 500) {
    return new WebformError('unavailable', `webform submit → ${status}`, true, details);
  }
  // 400, and every other unlisted status below 500 (a future addition this
  // bundle has never seen) — treated as a validation disagreement, since
  // that is what every status in this range means on this route today.
  const field = fieldFromBody(body);
  return new WebformError('validation', `webform submit → ${status}`, false, {
    ...details,
    ...(field === undefined ? {} : { field }),
  });
}

const OUTCOMES = ['chat', 'ticket', 'queued'] as const;

/** Defensively reads a 2xx body. A body this bundle cannot trust is treated
 *  as a failure rather than handed to the UI half-formed. */
function parseReceipt(body: unknown): WebformReceipt {
  if (!isRecord(body)) throw new WebformError('unavailable', 'webform submit → malformed 2xx body', true);
  const outcome = body['outcome'];
  const receiptId = body['receiptId'];
  const duplicate = body['duplicate'];
  if (
    typeof receiptId !== 'string' ||
    typeof duplicate !== 'boolean' ||
    !(OUTCOMES as readonly unknown[]).includes(outcome)
  ) {
    throw new WebformError('unavailable', 'webform submit → malformed 2xx body', true);
  }
  const chatSessionId = str(body['chatSessionId']);
  const ticketRef = str(body['ticketRef']);
  return {
    outcome: outcome as WebformReceipt['outcome'],
    receiptId,
    duplicate,
    ...(chatSessionId === undefined ? {} : { chatSessionId }),
    ...(ticketRef === undefined ? {} : { ticketRef }),
  };
}

export interface SubmitWebformOptions {
  readonly apiUrl: string;
  readonly publishableKey: string;
  readonly draft: WebformDraft;
  readonly timeoutMs?: number;
}

/**
 * Submits one form. Resolves with a receipt, or rejects with a
 * {@link WebformError}. Never anything else — a plain network failure, a
 * timeout, and a CORS refusal (which surfaces as a bare `TypeError` with no
 * detail the way `remote-config.ts`'s fetch already documents) all become
 * `kind: 'network'` rather than an unhandled rejection shape.
 */
export async function submitWebform(options: SubmitWebformOptions): Promise<WebformReceipt> {
  const { apiUrl, publishableKey, draft, timeoutMs = WEBFORM_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, '')}${WEBFORM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Publishable-Key': publishableKey },
      // No cookies — an anonymous write needs none, and sending the
      // merchant's own session along would be a CSRF surface for nothing.
      credentials: 'omit',
      // Never cached, unlike the config read: this is a write, and a browser
      // that ever served a stale POST response would be a browser bug, not
      // something to plan for either way.
      cache: 'no-store',
      body: JSON.stringify(draft),
      signal: controller.signal,
    });
  } catch {
    throw new WebformError('network', 'webform submit failed before a response arrived', true);
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok) return parseReceipt(body);
  throw errorFromResponse(response, body);
}
