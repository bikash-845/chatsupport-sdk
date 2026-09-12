// The admin/staff data path for the widget's "Customers" tab in portal mode
// (`userRole: 'admin'`) — a second path, parallel to and independent from
// `client.ts`'s customer flow, never a branch inside it.
//
// ── Why a second path instead of a branch ──────────────────────────────────
//
// `client.ts` always builds a `ChatClient` (`@dhaam-ccrm/core`'s customer
// surface): a KEYED hello carrying `publishableKey`, one active session plus
// that SAME identity's own past-session history. `userRole` never changed
// that — it only ever selected which tab labels `ui/messages-screen.ts`
// draws — which is exactly the bug this module fixes: for an admin, "my own
// past sessions" is an empty, irrelevant list; the tenant's real customer
// conversations live behind a different protocol entirely.
//
// `@dhaam-ccrm/core`'s OTHER client, `createConversationClient`, is that
// protocol: a KEYLESS hello (no `publishableKey` — its absence is what
// selects chat-service's staff flow), N sessions held at once rather than
// one, and no "my own history" concept at all. The two clients do not share
// a session model or a config shape, so there is nothing safe to unify them
// into — this module builds the second one, the UI-facing wiring lives in
// `widget.ts`, and the read/render surface (`ui/portal-thread.ts`) is
// deliberately small rather than a retrofit of `ui/message-list.ts` +
// `ui/composer.ts`, because neither attachments, voice, emoji, typing nor
// CSAT exist on this protocol in this SDK slice.
//
// Ported from chatsupport-sdk/examples/admin-panel/src/admin-api.ts, the
// proven reference for this exact backend contract:
//   - GET /chat-services/api/v1/agent/queue                     (queue list)
//   - GET /chat-services/api/v1/agent/sessions/{id}/messages    (history)
//   - keyless v2 WS hello                                        (send/join)
// See that example's README for why `@dhaam-ccrm/rest`'s `RestClient` can't
// serve this surface: it requires a `publishableKey` and sends
// `X-Publishable-Key` on every request, which would put the connection back
// on the customer flow.

import { projectHistoryRow, unwrapEnvelope } from '@dhaam-ccrm/rest';
import type { RestChatMessage } from '@dhaam-ccrm/rest';
import { createConversationClient, isChatStatus } from '@dhaam-ccrm/core';
import type { ChatMessage, ConversationClient, MessageHistorySource } from '@dhaam-ccrm/core';

export interface PortalStaffOptions {
  /** Origin only — scheme and host, no path, no trailing slash. */
  readonly apiUrl: string;
  readonly wsUrl: string;
  /**
   * The dh-auth bearer token this admin session already holds — the SAME
   * value `WidgetConfig.auth.getToken` resolves to. Async and read per call
   * (never cached) so a re-login is picked up without rebuilding the client.
   */
  readonly getToken: () => Promise<string>;
  /** Local-echo hint only; the server derives the real sender from the token. */
  readonly senderId: string;
}

/** Anything the staff REST surface refused, with the HTTP status attached. */
export class PortalApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PortalApiError';
    this.status = status;
  }
}

const BASE_PATH = '/chat-services/api/v1';

function trimOrigin(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

async function getJson(options: PortalStaffOptions, path: string, query: Record<string, string>): Promise<unknown> {
  const url = new URL(`${trimOrigin(options.apiUrl)}${BASE_PATH}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  let response: Response;
  try {
    const token = await options.getToken();
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    // A CORS rejection and a dead host are indistinguishable to page
    // JavaScript — both surface as a `TypeError` with no status.
    throw new PortalApiError(`could not reach ${url.origin} (network error, or blocked by CORS)`, 0);
  }

  if (!response.ok) {
    throw new PortalApiError(`${path} returned ${response.status}`, response.status);
  }

  return (await response.json()) as unknown;
}

/** The `history` seam `createConversationClient` requires at construction. */
function createStaffHistorySource(options: PortalStaffOptions): MessageHistorySource {
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
      const messages = rows
        .map(projectHistoryRow)
        .filter((message): message is RestChatMessage => message !== null);

      return {
        messages: messages as unknown as readonly ChatMessage[],
        hasMore: page.hasMore === true,
      };
    },
  };
}

/** Builds the keyless staff `ConversationClient` behind the widget's portal (admin) mode. */
export function createPortalConversationClient(options: PortalStaffOptions): ConversationClient {
  return createConversationClient({
    wsUrl: options.wsUrl,
    // No publishableKey: its ABSENCE is what selects chat-service's staff
    // flow (sessions accumulate instead of evicting on join).
    getToken: async () => ({ token: await options.getToken(), expiresInMs: 5 * 60 * 1000 }),
    localSender: { senderId: options.senderId, senderType: 'AGENT' },
    history: createStaffHistorySource(options),
    pageSize: 20,
  });
}

/** One row of `GET /agent/queue`, narrowed to what the Customers tab renders. */
export interface PortalQueueRow {
  readonly sessionId: string;
  readonly status: string;
  readonly customerName: string | null;
  readonly lastMessage: string | null;
}

// `/agent/queue` is a REST endpoint, not the v2 WS protocol §12.1 talks about
// above — it leaks chat-service's raw DB integer (`ChatStatus.OPEN = 1`, …)
// rather than the canonical string name the rest of this SDK deals in
// exclusively. Widening a string-typed field to `1 | '1'` at the type level
// gets this wrong just as badly as ignoring it: `ui/session-status.ts`'s
// `SESSION_STATUS_WORDS[status]` is a plain object keyed by the six string
// names, so an unmapped numeric code (or its naive `String(...)`, `'1'`)
// looks up as `undefined` and throws reading `.label` off it — a live crash
// on every row this endpoint returns, not a cosmetic wrong label.
// chat-service-node's `ChatStatus` enum (shared/constants/enums.ts) — the DB
// integer this REST endpoint leaks. Not exported anywhere this SDK can import
// it from, so mirrored here; `isChatStatus` (from @dhaam-ccrm/core) covers
// the "already a valid name" half instead of a second copy of that list.
const QUEUE_STATUS_BY_CODE: Record<number, string> = {
  1: 'OPEN',
  2: 'WAITING_FOR_AGENT',
  3: 'ASSIGNED',
  4: 'CLOSED',
  5: 'RESOLVED',
  6: 'ON_HOLD',
};

function readQueueStatus(value: unknown): string {
  if (typeof value === 'string' && isChatStatus(value)) return value;
  if (typeof value === 'number' && value in QUEUE_STATUS_BY_CODE) return QUEUE_STATUS_BY_CODE[value] as string;
  // Neither a known name nor a known code — 'OPEN' rather than the crash
  // above, matching `widget.ts`'s own `?? 'OPEN'` fallback for a missing one.
  return 'OPEN';
}

function readQueueRow(row: unknown): PortalQueueRow | null {
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
    status: readQueueStatus(source['status']),
    customerName,
    lastMessage: lastContent,
  };
}

/**
 * Lists this token's visible sessions — the Customers tab's real data source.
 *
 * `GET /agent/queue`, scoped server-side from the verified role: admin /
 * super_admin / supervisor see the tenant's whole queue. Merchant and manager
 * tokens are refused before reaching this call at all (chat-service's
 * staff-role mapping gap) — `widget.ts` only wires this path in for
 * `userRole === 'admin'` for exactly that reason.
 */
export async function listPortalQueue(options: PortalStaffOptions, limit = 50): Promise<readonly PortalQueueRow[]> {
  const body = (await getJson(options, '/agent/queue', {
    limit: String(limit),
    includeClosed: 'false',
  })) as { data?: unknown };

  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map(readQueueRow).filter((row): row is PortalQueueRow => row !== null);
}
