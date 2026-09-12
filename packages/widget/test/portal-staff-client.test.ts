// node, vi.stubGlobal('fetch', …). The one non-trivial piece of logic
// `./portal/portal-staff-client.ts` adds is `readQueueRow`'s defensive
// parsing of GET /agent/queue's rows — this exercises that, plus the
// PortalApiError status mapping, so a malformed or missing field never
// silently produces a Customers-tab row that can't be opened.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { listPortalQueue, PortalApiError } from '../src/portal/portal-staff-client.js';

const OPTIONS = {
  apiUrl: 'https://chat.example.com',
  wsUrl: 'wss://chat.example.com',
  getToken: async () => 'test-token',
  senderId: 'admin_1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('listPortalQueue — GET /agent/queue row parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('projects well-formed rows, pulling nested customer/lastMessage fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 'sess_1',
              status: 'OPEN',
              customer: { displayName: 'Jane Doe' },
              lastMessage: { content: 'Where is my order?' },
            },
          ],
        }),
      ),
    );

    const rows = await listPortalQueue(OPTIONS);
    expect(rows).toEqual([
      { sessionId: 'sess_1', status: 'OPEN', customerName: 'Jane Doe', lastMessage: 'Where is my order?' },
    ]);
  });

  it('drops rows with no string id instead of throwing or fabricating one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            { id: 'sess_1', status: 'OPEN' },
            { status: 'OPEN' }, // no id — must be dropped
            null, // not an object — must be dropped
          ],
        }),
      ),
    );

    const rows = await listPortalQueue(OPTIONS);
    expect(rows.map((r) => r.sessionId)).toEqual(['sess_1']);
  });

  it('falls back to null customerName/lastMessage when those fields are absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'sess_2', status: 'WAITING_FOR_AGENT' }] })),
    );

    const rows = await listPortalQueue(OPTIONS);
    expect(rows).toEqual([
      { sessionId: 'sess_2', status: 'WAITING_FOR_AGENT', customerName: null, lastMessage: null },
    ]);
  });

  it('maps the live /agent/queue endpoint\'s numeric status code to the SDK\'s string name', async () => {
    // The real endpoint leaks chat-service's raw ChatStatus DB integer
    // (enums.ts: OPEN=1, WAITING_FOR_AGENT=2, ASSIGNED=3, CLOSED=4,
    // RESOLVED=5, ON_HOLD=6) rather than the canonical string name — see
    // readQueueStatus's own comment for why leaving this unmapped crashes
    // ui/session-status.ts's SESSION_STATUS_WORDS lookup on every row.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'sess_3', status: 3 }] })),
    );

    const rows = await listPortalQueue(OPTIONS);
    expect(rows[0]?.status).toBe('ASSIGNED');
  });

  it('falls back to OPEN for a status code/name it does not recognize', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'sess_4', status: 99 }] })),
    );

    const rows = await listPortalQueue(OPTIONS);
    expect(rows[0]?.status).toBe('OPEN');
  });

  it('treats a non-array "data" as an empty queue rather than crashing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: null })));
    const rows = await listPortalQueue(OPTIONS);
    expect(rows).toEqual([]);
  });

  it('raises PortalApiError with the HTTP status on a non-2xx response — same identical-401 contract examples/admin-panel documents (bad token / expired token / non-staff role all answer the same)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    await expect(listPortalQueue(OPTIONS)).rejects.toMatchObject(
      expect.objectContaining({ status: 401 }) as Partial<PortalApiError>,
    );
  });

  it('reports a network/CORS failure as PortalApiError status 0 rather than an unhandled TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(listPortalQueue(OPTIONS)).rejects.toMatchObject(
      expect.objectContaining({ status: 0 }) as Partial<PortalApiError>,
    );
  });
});
