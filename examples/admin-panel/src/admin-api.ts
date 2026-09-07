// The REST half of a staff panel: the injected history seam, and the one call
// that answers "which session id do I even type in?".
//
// ── Why this file is hand-rolled and the customer demo's is not ───────────
//
// `examples/demo/src/chat-client.ts` gets its history seam in one line:
//
//     history: createHistorySource<ChatMessage>(rest)
//
// A keyless panel cannot. `RestClient` requires a `publishableKey`
// (packages/rest/src/client.ts, constructor) and sends `X-Publishable-Key` on
// every request — and a staff console holds no publishable key at all. That is
// a known gap with a written fix (plan §5.5 turns `RestClientOptions` into a
// discriminated union with `party: true`), scheduled for slice 3. Until then a
// keyless integrator writes the ~30 lines below, which is exactly what this
// file is here to show.
//
// What is NOT hand-rolled: the row projection. `projectHistoryRow` is a pure
// function exported from `@dhaam-ccrm/rest`'s public barrel with no
// `RestClient` anywhere near it, and it is the only thing that knows a raw
// history row carries INTEGER enums, calls the session `chatSessionId`, and
// buries attachments in `metadata`. Re-deriving that by hand is how a panel
// ends up rendering `senderType: 2`.
//
// ── Which route, and why not the one in the type's own doc comment ────────
//
// `MessageHistorySource`'s doc names
// `GET /chat-services/api/v1/chat/sessions/{id}/messages`. That is the
// CUSTOMER route: chat-service guards it with
// `[authenticate, throttle.limitIdentity, requireSessionOwner]`
// (chat.routes.ts:494), where `authenticate` is the customer middleware and
// "owner" means the customer who started the session. An admin id_token gets a
// 401 there, every time.
//
// The staff route is `GET /chat-services/api/v1/agent/sessions/{id}/messages`
// (agent.routes.ts:1333), guarded by `[authenticateAgent, requireOwnedSession]`
// — a dh-auth bearer token whose role maps to staff, and a session belonging to
// that token's tenant. Same query contract (`limit`, `before`), same
// `{ success, data: { messages, hasMore } }` envelope. Which URL a history
// source reads is the adapter's business; that is the entire point of the seam.
//
// One behavioural difference worth knowing before you ship: the customer route
// passes `publicOnly: true` and the staff route does not, so INTERNAL agent
// notes are included here. That is correct for a staff panel and would be a
// disclosure on a customer one.

import { projectHistoryRow, unwrapEnvelope } from '@dhaam-ccrm/rest';
import type { RestChatMessage } from '@dhaam-ccrm/rest';
import type { ChatMessage, MessageHistorySource } from '@dhaam-ccrm/core';

/** Every route on chat-service sits under this prefix (`api/rest/server.ts:205`). */
const BASE_PATH = '/chat-services/api/v1';

export interface AdminApiOptions {
  /** Origin only — scheme and host, no path, no trailing slash. */
  readonly apiUrl: string;

  /**
   * The dh-auth `id_token`, read per request rather than captured once.
   *
   * A function, not a string, for the same reason `RestClientOptions` takes
   * one: the panel's token field can change under a long-lived client, and an
   * adapter holding a copy would keep presenting the old one.
   */
  readonly getToken: () => string;
}

/** Anything this module could not get from the service, with the HTTP status attached. */
export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

function trimOrigin(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

/**
 * One authenticated GET, unwrapped.
 *
 * The failure path deliberately surfaces the STATUS and the service's error
 * `code`, and not its free-text message: on this surface a 401 is genuinely
 * ambiguous (bad token / expired token / non-staff role all answer
 * `Invalid token`, auth.middleware.ts:149 — the same string, on purpose, so a
 * caller cannot enumerate which half to attack), and quoting prose that says
 * more than it knows is how an integrator ends up debugging the wrong half.
 */
async function getJson(options: AdminApiOptions, path: string, query: Record<string, string>): Promise<unknown> {
  const url = new URL(`${trimOrigin(options.apiUrl)}${BASE_PATH}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${options.getToken()}` },
    });
  } catch (error) {
    // A CORS rejection and a dead host are indistinguishable here by design —
    // the browser refuses to say which. Both are `status: 0`.
    throw new AdminApiError(
      `could not reach ${url.origin} (network error, or the browser blocked it by CORS)`,
      0,
      error instanceof Error ? error.name : null,
    );
  }

  if (!response.ok) {
    let code: string | null = null;
    try {
      const body = (await response.json()) as { error?: { code?: unknown } };
      if (typeof body?.error?.code === 'string') code = body.error.code;
    } catch {
      // A non-JSON error body is not itself an error worth reporting over the
      // status, which is the fact the caller acts on.
    }
    throw new AdminApiError(`${path} returned ${response.status}`, response.status, code);
  }

  return (await response.json()) as unknown;
}

/**
 * The `history` seam `createConversationClient` requires at construction.
 *
 * Required at CONSTRUCTION, not at first `open()` — a panel that discovers its
 * history wiring is missing only when a human opens a thread has turned a
 * config mistake into a runtime failure in front of that human.
 */
export function createAdminHistorySource(options: AdminApiOptions): MessageHistorySource {
  return {
    async listMessages(query) {
      const body = await getJson(options, `/agent/sessions/${encodeURIComponent(query.sessionId)}/messages`, {
        limit: String(query.limit),
        ...(query.before === undefined ? {} : { before: query.before }),
      });

      const page = unwrapEnvelope<{ messages?: unknown; hasMore?: unknown }>(
        body,
        'GET /agent/sessions/{sessionId}/messages',
      );

      const rows = Array.isArray(page.messages) ? page.messages : [];

      // Per row, not per page: one message this SDK cannot decode — a newly
      // appended enum value — must cost that one message, not the whole
      // transcript. Same rule the shipped adapter follows.
      const messages = rows
        .map(projectHistoryRow)
        .filter((message): message is RestChatMessage => message !== null);

      return {
        // `RestChatMessage` is structurally core's `ChatMessage`; the assertion
        // is what lets `@dhaam-ccrm/rest` stay free of a dependency on core.
        messages: messages as unknown as readonly ChatMessage[],
        hasMore: page.hasMore === true,
      };
    },
  };
}

/** One row of `GET /agent/queue`, narrowed to what this panel renders. */
export interface QueueRow {
  readonly sessionId: string;
  readonly status: string;
  readonly customerName: string | null;
  readonly lastMessage: string | null;
}

function readQueueRow(row: unknown): QueueRow | null {
  if (typeof row !== 'object' || row === null) return null;
  const source = row as Record<string, unknown>;
  const sessionId = source['id'];
  if (typeof sessionId !== 'string') return null;

  const customer = source['customer'];
  const customerName =
    typeof customer === 'object' && customer !== null
      ? ((customer as Record<string, unknown>)['displayName'] as string | undefined) ?? null
      : null;

  const lastMessage = source['lastMessage'];
  const lastContent =
    typeof lastMessage === 'object' && lastMessage !== null
      ? ((lastMessage as Record<string, unknown>)['content'] as string | undefined) ?? null
      : null;

  return {
    sessionId,
    status: typeof source['status'] === 'string' ? (source['status'] as string) : String(source['status'] ?? '?'),
    customerName,
    lastMessage: lastContent,
  };
}

/**
 * Lists this token's visible sessions — the answer to "where do I get a
 * session id?".
 *
 * `GET /agent/queue` (agent.routes.ts:923). Scoped server-side from the
 * VERIFIED role: admin / super_admin / supervisor see the tenant's queue, a
 * plain agent (roleId 6) is pinned to their own assignments. The `?tenantId=`
 * parameter is a redundant echo compared against the token and discarded, so
 * there is nothing to pass here.
 *
 * Note this envelope is NOT the `{ data: { … } }` shape the history route uses:
 * the rows are `data` itself, with `hasMore`/`nextCursor` as siblings. That is
 * why `unwrapEnvelope` is not used on this one.
 */
export async function listQueue(options: AdminApiOptions, limit = 20): Promise<readonly QueueRow[]> {
  const body = (await getJson(options, '/agent/queue', {
    limit: String(limit),
    includeClosed: 'false',
  })) as { data?: unknown };

  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map(readQueueRow).filter((row): row is QueueRow => row !== null);
}
