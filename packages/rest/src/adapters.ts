// The three seams `createChatClient` requires.
//
// Each is a thin adapter — the interesting logic all lives in core — but "thin"
// is not "pass-through": chat-service's REST path returns raw database rows
// where its WebSocket path returns projected payloads, and core is written
// against the projected shape. Absorbing that difference is this package's
// entire job, and it happens in three shared pieces the adapters below reuse:
// `envelope.ts` (every route replies `{success, data}`), `projection.ts` (rows
// carry integer enums and bury attachments in `metadata`), and `media-type.ts`
// (uploads report an S3 folder name).

import type { RestClient } from './client.js';
import { RestApiError, RestSessionReadBackError, RestTransportError } from './errors.js';
import { unwrapEnvelope } from './envelope.js';
import { normalizeMediaType } from './media-type.js';
import {
  projectHistoryRow,
  projectSessionSummaryRow,
  toChatSession,
  type RestAttachmentMetadata,
  type RestChatMessage,
  type RestChatSession,
  type RestChatSessionSummary,
} from './projection.js';

/**
 * Core's `MessagePage`, declared locally rather than imported from
 * `@dhaam-ccrm/core` — as are the message, session, and attachment shapes in
 * projection.ts.
 *
 * Declaring them here keeps this package usable without a value-level
 * dependency on core, and keeps the seam honest: if core's shape changes, the
 * consumer's `createChatClient` call fails to typecheck, which is where the
 * mismatch belongs.
 */
interface WireMessagePage<TMessage> {
  readonly messages: readonly TMessage[];
  readonly hasMore: boolean;
}

/**
 * `GET /chat/sessions/{sessionId}/messages` — backward cursor, `hasMore`, no
 * forward cursor (live messages arrive over the WebSocket, §12.10).
 *
 * The route is under `/chat/…` (`chat.routes.ts:262`); the `/sessions/…` path
 * this used to request is served by nothing, which is one half of why a
 * reloaded conversation came back empty. The other half was the envelope: the
 * body is `{success, data:{messages, hasMore}}`, so reading `messages` off the
 * top level produced an empty page with `hasMore: false` — a silent "no
 * history" rather than a visible failure.
 */
export function createHistorySource<TMessage>(client: RestClient): {
  listMessages(query: {
    readonly sessionId: string;
    readonly before?: string;
    readonly limit: number;
  }): Promise<WireMessagePage<TMessage>>;
} {
  return {
    async listMessages(query) {
      const body = await client.request<unknown>(
        'GET',
        `/chat/sessions/${encodeURIComponent(query.sessionId)}/messages`,
        { query: { before: query.before, limit: query.limit } },
      );

      const page = unwrapEnvelope<{ messages?: unknown; hasMore?: unknown }>(
        body,
        'GET /chat/sessions/{sessionId}/messages',
      );

      // Defended rather than trusted: core prepends this page straight into
      // state, and an absent `messages` would surface as a confusing crash
      // deep inside the message list instead of here.
      const rows = Array.isArray(page.messages) ? page.messages : [];

      // Every row is a raw Prisma row — integer enums, `chatSessionId`, and any
      // attachment still buried in `metadata`. The REST history service does no
      // projection of its own (message.service.ts:285-296, :470-482), so this is
      // the only place it happens for this path. See projection.ts.
      //
      // Per row, not per page: one message this SDK cannot decode — a newly
      // appended enum value, which enums.ts:8 documents as routine — must cost
      // that one message, not the customer's entire history.
      const messages: readonly RestChatMessage[] = rows
        .map(projectHistoryRow)
        .filter((message): message is RestChatMessage => message !== null);

      // The type parameter is the caller's own message type, structurally this
      // shape (core's `ChatMessage`); the assertion is what lets this package
      // stay free of a dependency on core.
      return {
        messages: messages as unknown as readonly TMessage[],
        hasMore: page.hasMore === true,
      };
    },
  };
}

/**
 * `POST /upload` — step one of the two-step upload-then-announce flow. Core
 * sends the returned metadata as a **top-level** `attachment` field on
 * `message.send`, never nested under `metadata` (D4).
 *
 * The route is a single tenant-wide endpoint (`upload.routes.ts:82`), not a
 * per-session sub-resource: `POST /sessions/{id}/attachments` has never existed
 * on this service, so every upload 404'd.
 */
export function createAttachmentUploader<TAttachment>(client: RestClient): {
  upload(request: {
    readonly sessionId: string;
    readonly file: Blob;
    readonly fileName?: string;
  }): Promise<TAttachment>;
} {
  return {
    async upload(request) {
      const form = new FormData();
      // `File`'s own name when there is one, then the caller's override, then a
      // placeholder. Content-Disposition requires *some* filename; omitting it
      // makes several multipart parsers drop the part silently.
      const derived = (request.file as { name?: unknown }).name;
      const fileName =
        request.fileName ?? (typeof derived === 'string' && derived ? derived : 'upload');
      form.append('file', request.file, fileName);

      const body = await client.request<unknown>('POST', '/upload', {
        // ── Query param, never a multipart field ──
        //
        // The route reads `data.fields?.chatSessionId` off `request.file()`
        // (upload.routes.ts:144-147), which only resolves fields parsed BEFORE
        // the file part. This FormData appends `file` first — as it must, so a
        // large body streams rather than buffering behind small fields — so a
        // field here would be silently dropped. The route falls back to
        // `request.query.chatSessionId`, which always arrives.
        //
        // Nothing else is sent with it: the route derives the tenant from the
        // verified token and ignores `X-Tenant-ID` (upload.routes.ts:139-142),
        // and it implements no idempotency key.
        query: { chatSessionId: request.sessionId },
        formData: form,
      });

      const data = unwrapEnvelope<Record<string, unknown>>(body, 'POST /upload');
      const url = data['url'];
      if (typeof url !== 'string' || url === '') {
        // Without a URL there is nothing to announce; core would render a
        // bubble pointing nowhere. Fail here, where the route is still named.
        throw new RestApiError({
          code: 'MALFORMED_RESPONSE',
          message: 'POST /upload returned no attachment url',
          status: 200,
          retryable: false,
        });
      }

      const attachment: RestAttachmentMetadata = {
        url,
        // The route echoes all four, but each falls back to what this side
        // already knows rather than reaching core as `undefined`.
        fileName: typeof data['fileName'] === 'string' ? data['fileName'] : fileName,
        mimeType: typeof data['mimeType'] === 'string' ? data['mimeType'] : request.file.type,
        size: typeof data['size'] === 'number' ? data['size'] : request.file.size,
        // `mediaType` arrives as an S3 folder name (`images`), and core's
        // messageTypeFor only knows `IMAGE|VIDEO|AUDIO` — so unnormalized, every
        // upload degraded to a generic FILE. See media-type.ts.
        mediaType: normalizeMediaType(data['mediaType']),
      };

      // The type parameter is the caller's own attachment type, structurally
      // this shape (core's `AttachmentMetadata`); the assertion is what lets
      // this package stay free of a dependency on core.
      return attachment as unknown as TAttachment;
    },
  };
}

/**
 * How many times the post-mutation read-back is attempted before giving up.
 *
 * Small on purpose: every attempt costs the caller latency on an action whose
 * server-side effect has already happened, and the failures worth surviving
 * here are the momentary ones.
 */
const READ_BACK_ATTEMPTS = 3;

/** Would trying the same request again plausibly produce a different answer? */
function isWorthRetrying(error: unknown): boolean {
  if (error instanceof RestTransportError) return true;
  // Carries the server's own verdict, falling back to the status class — so a
  // 500 retries and a MALFORMED_RESPONSE, which no retry can reshape, does not.
  if (error instanceof RestApiError) return error.retryable;
  return false;
}

/**
 * `POST /chat/sessions/{id}/reopen` and `/close`.
 *
 * These are REST-only: T13 found that neither has a WebSocket frame type in
 * §7.3's catalog at all, even though §6.2 lists both as client methods. That
 * asymmetry is why `SessionActions` exists as a seam rather than a frame.
 *
 * ── Why each action is two round trips ──
 *
 * DO NOT "optimize" the second request away. Core's `SessionActions` contract
 * returns the FULL `ChatSession` — id, status, mode, createdAt, closedAt,
 * assignedAgent, customer, ticket — because that value replaces
 * `ChatState.session` wholesale. The mutating routes return a receipt and
 * nothing more: close gives `{sessionId, status, closedAt}` and reopen gives
 * `{sessionId, status, mode}` (chat.routes.ts:289-292, :310-313). The remaining
 * fields are in neither response, and no other part of them carries the
 * participant profiles.
 *
 * So the mutation is followed by a read of `GET /chat/sessions/{id}/full`
 * (chat.routes.ts:242-257), which is the one route that returns an enriched
 * session. Collapsing this back to one call does not make the second request
 * unnecessary — it makes the returned session half-populated, and a session
 * with `customer: null` and an epoch `createdAt` looks like data rather than
 * like the missing fields it is.
 */
/**
 * `POST /chat/sessions/{id}/csat`'s response body, field-for-field —
 * `csat.service.ts`'s `CsatRecord` serialized straight to JSON, with no
 * integer-enum projection to undo (unlike `RestChatSession`'s `status`/`mode`):
 * this route has never carried a database-integer field, so there is nothing
 * here for `projection.ts`'s enum tables to translate.
 *
 * Declared locally rather than as core's own `CsatSubmission`, for the exact
 * reason `WireMessagePage` above is: this package stays usable with no
 * value-level dependency on `@dhaam-ccrm/core`, and a shape mismatch between
 * the two is caught at the consumer's `createChatClient(...)` call, not here.
 */
interface RestCsatSubmission {
  sessionId: string;
  rating: number;
  comment: string | null;
  /** ISO-8601. */
  submittedAt: string;
}

/**
 * `GET /chat/sessions/{sessionId}/csat` — whether THIS session already carries
 * a rating, and what it was.
 *
 * A discriminated pair rather than `RestCsatSubmission | null`, because the
 * route answers `200 {rated: false}` for an unrated session rather than a 404:
 * "no rating yet" is a successful answer about a session the customer owns,
 * and folding it into the same 404 that means "not your session" would make
 * the one case the caller must act on indistinguishable from the one it must
 * report.
 */
type RestCsatStatus =
  | { rated: false }
  | {
      rated: true;
      /** 1-5. */
      rating: number;
      /** `null` when the customer left none. */
      comment: string | null;
      /** ISO-8601. Absent only if the service omitted it. */
      submittedAt?: string;
    };

export function createSessionActions<TSession>(client: RestClient): {
  reopenSession(sessionId: string): Promise<TSession>;
  closeSession(sessionId: string): Promise<TSession>;
  submitCsat(sessionId: string, rating: number, comment?: string): Promise<RestCsatSubmission>;
  getCsat(sessionId: string): Promise<RestCsatStatus>;
} {
  /**
   * Reads back the session the mutation settled on.
   *
   * `/full` returns `{session, messages, participants, hasMore}`; only the
   * session is projected here — core loads history through its own seam, and
   * handing it a second, differently-shaped copy of the same messages is how
   * the two disagree.
   */
  async function readFullSession(sessionId: string): Promise<RestChatSession> {
    const body = await client.request<unknown>(
      'GET',
      `/chat/sessions/${encodeURIComponent(sessionId)}/full`,
    );
    const data = unwrapEnvelope<{ session?: unknown }>(
      body,
      'GET /chat/sessions/{sessionId}/full',
    );
    return toChatSession(data.session);
  }

  /**
   * Reads the session back, retrying the GET and only the GET.
   *
   * The mutation has already been applied by the time this runs, and
   * `chatSessionService.closeSession` is not idempotent — a second POST re-runs
   * the status update, re-marks participants as left, and emits another "chat
   * closed" SYSTEM message plus another Kafka event, all of which the customer
   * would see. So the retry surface is deliberately this one read.
   *
   * No delay between attempts: this package has no clock seam, and adding
   * `setTimeout` here would put an untestable timer inside an adapter whose
   * scheduling core already owns. The attempts cover the case worth covering —
   * a single dropped connection or one 5xx from a replica that has not caught
   * up — and anything more persistent is reported rather than waited on.
   */
  async function readBackAfterMutation(sessionId: string): Promise<RestChatSession> {
    let failure: unknown;
    for (let attempt = 1; attempt <= READ_BACK_ATTEMPTS; attempt += 1) {
      try {
        return await readFullSession(sessionId);
      } catch (error) {
        failure = error;
        if (!isWorthRetrying(error)) break;
      }
    }
    // Distinguishable on purpose: the session HAS changed on the server, and a
    // caller that treats this like a failed close is wrong in both directions.
    throw new RestSessionReadBackError({ sessionId, cause: failure });
  }

  /**
   * Runs the mutation and returns the session id it settled on.
   *
   * The id is read back out of the response rather than reused from the
   * request because `reopenSession` may converge onto a DIFFERENT,
   * already-active session and returns that one's id (chat.routes.ts:297-308).
   * Re-reading the requested id would then return the wrong session — and the
   * convergence stays inside the authorization boundary, so the id that comes
   * back is safe to follow.
   */
  async function mutate(path: string, sessionId: string, context: string): Promise<TSession> {
    const body = await client.request<unknown>(
      'POST',
      `/chat/sessions/${encodeURIComponent(sessionId)}/${path}`,
    );
    const receipt = unwrapEnvelope<{ sessionId?: unknown }>(body, context);
    const settled = typeof receipt.sessionId === 'string' ? receipt.sessionId : sessionId;

    // The type parameter is the caller's own session type, structurally this
    // shape (core's `ChatSession`); the assertion is what lets this package stay
    // free of a dependency on core.
    return (await readBackAfterMutation(settled)) as unknown as TSession;
  }

  return {
    reopenSession(sessionId) {
      return mutate('reopen', sessionId, 'POST /chat/sessions/{sessionId}/reopen');
    },
    closeSession(sessionId) {
      return mutate('close', sessionId, 'POST /chat/sessions/{sessionId}/close');
    },
    // ONE round trip, deliberately unlike `mutate` above: the route's own
    // response already carries the whole rating (chat.routes.ts's
    // `/csat` handler answers `{success: true, data: record}` directly from
    // `submitCsat`'s return value), so there is no partial receipt here
    // needing a `GET /full` to fill in — and nothing about a rating changes
    // `ChatState.session` for that read to refresh in the first place.
    async submitCsat(sessionId, rating, comment) {
      const body = await client.request<unknown>(
        'POST',
        `/chat/sessions/${encodeURIComponent(sessionId)}/csat`,
        // `comment` omitted rather than sent as `undefined`: the route's own
        // validator (`csatBodySchema`) treats an absent field and a blank one
        // differently only in that the service trims/nulls it either way, but
        // omitting keeps this call's body honest about what the customer
        // actually typed rather than asserting an explicit empty value.
        { body: comment === undefined ? { rating } : { rating, comment } },
      );
      return unwrapEnvelope<RestCsatSubmission>(body, 'POST /chat/sessions/{sessionId}/csat');
    },
    // The read half of the same route, and the reason a customer can no longer
    // rate one conversation twice: the widget's own memory of "already rated"
    // is a variable in a closure that a page reload destroys, so before this
    // existed the survey re-armed for every already-rated session and the
    // POST — an upsert server-side — happily overwrote the score.
    //
    // Strict about `rated` on purpose. Anything that is not a literal boolean
    // is rejected rather than read as `false`: a caller that treats a
    // malformed body as "not rated yet" offers the survey again, which is the
    // exact duplicate this call exists to prevent. A thrown
    // `MALFORMED_RESPONSE` reaches the widget as a failed lookup, and its
    // documented answer to a failed lookup is to withhold the survey.
    async getCsat(sessionId) {
      const body = await client.request<unknown>(
        'GET',
        `/chat/sessions/${encodeURIComponent(sessionId)}/csat`,
      );
      const context = 'GET /chat/sessions/{sessionId}/csat';
      const data = unwrapEnvelope<{
        rated?: unknown;
        rating?: unknown;
        comment?: unknown;
        submittedAt?: unknown;
      }>(body, context);

      if (typeof data.rated !== 'boolean') {
        throw new RestApiError({
          code: 'MALFORMED_RESPONSE',
          message: `${context} did not return a boolean \`rated\``,
          status: 200,
          retryable: false,
        });
      }
      if (!data.rated) return { rated: false };

      // `rated: true` without a usable score is the same contract drift: the
      // widget would render a "locked" survey with nothing in it, which looks
      // exactly like the bug where a rating is lost.
      if (typeof data.rating !== 'number') {
        throw new RestApiError({
          code: 'MALFORMED_RESPONSE',
          message: `${context} reported rated: true with no numeric rating`,
          status: 200,
          retryable: false,
        });
      }

      return {
        rated: true,
        rating: data.rating,
        // Normalised to `null` — the route documents `string | null`, and a
        // caller distinguishing "absent" from "explicitly empty" here would be
        // reading a difference the server does not make.
        comment: typeof data.comment === 'string' ? data.comment : null,
        ...(typeof data.submittedAt === 'string' ? { submittedAt: data.submittedAt } : {}),
      };
    },
  };
}

/**
 * `limit`'s valid range on `GET /chat/sessions/customer` (openapi's
 * `listSessions`, `chat.validator.ts:74-78` — server default 50, cap 100).
 */
const SESSION_SUMMARY_LIMIT_MIN = 1;
const SESSION_SUMMARY_LIMIT_MAX = 100;

/**
 * Validates `limit` before any request is made — the route itself would 400
 * on an out-of-range value, but a caller bug (e.g. a widget passing a page
 * size where a picker size belongs) should surface right here, not as a round
 * trip's worth of latency plus a generic `VALIDATION_FAILED` from the server.
 *
 * `status: 0` on the thrown error documents that no HTTP request happened for
 * it — every other `RestApiError` in this package carries a real response
 * status, and this is the one exception, by design.
 */
function validateSessionSummaryLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (
    !Number.isInteger(limit) ||
    limit < SESSION_SUMMARY_LIMIT_MIN ||
    limit > SESSION_SUMMARY_LIMIT_MAX
  ) {
    throw new RestApiError({
      code: 'VALIDATION_FAILED',
      message: `limit must be an integer between ${SESSION_SUMMARY_LIMIT_MIN} and ${SESSION_SUMMARY_LIMIT_MAX}, got ${JSON.stringify(limit)}`,
      status: 0,
      retryable: false,
    });
  }
  return limit;
}

/**
 * `GET /chat/sessions/customer` — the authenticated customer's own recent
 * sessions, most recent first, for the SDK's session-picker (openapi's
 * `listSessions` operation; hydrates core's `ChatState.pastSessions`, PRD
 * §6.4).
 *
 * **A guest gets `200 { sessions: [] }`, never a 403/404** (see the
 * `listSessions` operation description) — the widget uses an empty array to
 * decide not to render a picker at all, so an empty page must reach the
 * caller exactly like any other successful page. Nothing here treats
 * emptiness as a failure, or distinguishes "no sessions yet" from "not
 * identified" — the wire does not either.
 */
export function createSessionSummarySource<TSessionSummary>(client: RestClient): {
  listSessions(query?: { readonly limit?: number }): Promise<readonly TSessionSummary[]>;
} {
  return {
    async listSessions(query = {}) {
      const limit = validateSessionSummaryLimit(query.limit);

      const body = await client.request<unknown>('GET', '/chat/sessions/customer', {
        query: { limit },
      });

      const page = unwrapEnvelope<{ sessions?: unknown }>(body, 'GET /chat/sessions/customer');

      // Defended rather than trusted, same reasoning as listMessages: an
      // absent `sessions` should surface as an empty picker, not a crash deep
      // inside core's state layer.
      const rows = Array.isArray(page.sessions) ? page.sessions : [];

      // Per row, not per page — one session summary this SDK cannot decode
      // must cost that one row, not the customer's whole picker. See
      // projectSessionSummaryRow.
      const sessions: readonly RestChatSessionSummary[] = rows
        .map(projectSessionSummaryRow)
        .filter((summary): summary is RestChatSessionSummary => summary !== null);

      // The type parameter is the caller's own summary type, structurally
      // this shape (core's `ChatSessionSummary`, plus the additive
      // `handledBy` — see projection.ts's `RestChatSessionSummary`); the
      // assertion is what lets this package stay free of a dependency on core.
      return sessions as unknown as readonly TSessionSummary[];
    },
  };
}

/**
 * Core's `IdentityProfile`, redeclared here rather than imported from
 * `@dhaam-ccrm/core` — same reasoning as `WireMessagePage` above, and the
 * frozen contract requires it (`CONTACT_IDENTIFY_CONTRACT.md` §3.3): this
 * package has no dependency on core, so the two declarations are kept
 * identical by hand and the structural match is checked where it belongs, at
 * the consumer's `createChatClient` call.
 *
 * Note that every optional here is `string`, not `string | null`, while the
 * route accepts `string | null` (§1.3). That is deliberate and lossless: §4's
 * write matrix collapses absent, `null`, and `""` to the same "not present",
 * so this side only ever needs to omit a field, never to send a null.
 */
interface RestIdentityProfile {
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly city?: string;
  readonly country?: string;
  readonly tags?: readonly string[];
  readonly device?: {
    readonly deviceId: string;
    readonly deviceToken?: string;
    readonly platform?: 'ios' | 'android' | 'web';
  };
}

/**
 * `data` on the 200 (§1.6). `lastLoginAt` stays the ISO 8601 string the server
 * sent — this package does not parse it into a `Date`, because the value is a
 * receipt to log rather than a clock to read, and a `Date` here would be the
 * only place in this package that reinterprets a server timestamp.
 */
interface RestIdentityResult {
  readonly contactId: string;
  readonly externalId: string;
  readonly lastLoginAt: string;
}

/**
 * Reads one field off the identify receipt, or reports the drift.
 *
 * `unwrapEnvelope` guarantees `data` is a non-array object and nothing beyond
 * that, and these three fields are the entire documented payload (§1.6) — so an
 * absent one is a contract mismatch, not a partial success. Failing here
 * matches `createAttachmentUploader`'s missing-`url` branch: loud at the seam
 * that knows what the route should have returned, rather than handing core an
 * `undefined` that surfaces later as a confusing log line.
 *
 * Safe to fail on: identify is idempotent by construction (§4c — a repeat call
 * converges on the same contact), so core's one retry costs an extra
 * round trip and nothing else.
 */
function requireIdentityField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new RestApiError({
      code: 'MALFORMED_RESPONSE',
      message: `POST /identify returned no ${field}`,
      // The transport succeeded and the server reported no failure; the body
      // simply is not what the route documents. Same reading as envelope.ts.
      status: 200,
      retryable: false,
    });
  }
  return value;
}

/**
 * `POST /identify` — upserts the logged-in customer into the CRM as a Contact
 * (`CONTACT_IDENTIFY_CONTRACT.md`; core's `IdentitySync` seam).
 *
 * Unlike the four factories above this one takes no type parameter, because the
 * seam runs the other way. Those return a core type this package cannot name,
 * so they are generic and cast on the way out. Here core's type is an
 * *argument*, and a locally-declared parameter accepts any structurally
 * compatible profile without a generic. The return type is not core's at all:
 * `IdentitySync.sync` resolves to `void` and this resolves to the receipt, an
 * intentional mismatch the widget bridges in one line at the call site (§3.3,
 * AMENDED). Do not collapse it — core has no use for the receipt, and
 * discarding it here would throw away the only signal a caller could log.
 *
 * Nothing is retried in this adapter. `RestClient` has no backoff by design and
 * the identify retry lives in core, where the jitter and timer seams are; the
 * `READ_BACK_ATTEMPTS` loop above is scoped to one specific read-back and is
 * not a pattern to generalize.
 */
export function createIdentitySync(client: RestClient): {
  sync(profile: RestIdentityProfile): Promise<RestIdentityResult>;
} {
  return {
    async sync(profile) {
      // The profile goes on the wire verbatim. An optional the caller omitted
      // is ABSENT from the JSON rather than `null`, because `JSON.stringify`
      // drops an undefined property — which is what the route wants: both the
      // body and `device` are `.strict()` (§2), so an unexpected key is a 400,
      // and §4 reads absent and null identically anyway.
      const body = await client.request<unknown>('POST', '/identify', { body: profile });

      const data = unwrapEnvelope<Record<string, unknown>>(body, 'POST /identify');

      // Rebuilt rather than cast, matching the other adapters: the caller gets
      // exactly the three documented fields, defended, and nothing the route
      // may grow later rides along untyped.
      return {
        contactId: requireIdentityField(data['contactId'], 'contactId'),
        externalId: requireIdentityField(data['externalId'], 'externalId'),
        lastLoginAt: requireIdentityField(data['lastLoginAt'], 'lastLoginAt'),
      };
    },
  };
}
