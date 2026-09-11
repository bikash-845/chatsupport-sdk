import { describe, expect, it, vi } from 'vitest';

import {
  createAttachmentUploader,
  createHistorySource,
  createSessionActions,
  createSessionSummarySource,
} from './adapters.js';
import { BASE_PATH, RestClient } from './client.js';
import { RestApiError, RestSessionReadBackError, RestTransportError } from './errors.js';

const KEY = 'dhp' + '_test_' + 'A'.repeat(43);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What GET /chat/sessions/{id}/messages actually replies (chat.routes.ts:276). */
function historyResponse(messages: unknown[] = [], hasMore = false) {
  return { success: true, data: { messages, hasMore } };
}

/** A raw Prisma row, exactly as the REST path hands it back — unprojected. */
function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    chatSessionId: 's1',
    senderId: 'agent-9',
    senderType: 2,
    messageType: 4,
    content: 'here you go',
    metadata: null,
    replyToMessageId: null,
    createdAt: '2026-08-19T10:00:00.000Z',
    seq: 12,
    ...overrides,
  };
}

function harness(responder: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  });
  const client = new RestClient({
    apiUrl: 'https://chat.example.test',
    publishableKey: KEY,
    getAccessToken: () => 'tok_abc',
    fetch: fetchStub as unknown as typeof globalThis.fetch,
  });
  return { client, calls, fetchStub };
}

describe('RestClient paths and credentials', () => {
  it('pins the base path to what the service mounts', () => {
    expect(BASE_PATH).toBe('/chat-services/api/v1');
  });

  it('builds URLs under the prefix the service actually mounts', async () => {
    // The spec's servers block originally resolved to {apiUrl}/v1, which no
    // route serves. This asserts the corrected base rather than trusting it.
    const h = harness(() => jsonResponse(historyResponse()));

    await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    // Literal, deliberately NOT `${BASE_PATH}/...`: asserting against the same
    // constant the code uses is tautological — it passes even when the constant
    // is wrong, which is exactly the defect this test exists to catch.
    expect(h.calls[0]?.url.pathname).toBe('/chat-services/api/v1/chat/sessions/s1/messages');
  });

  it('sends both credentials on every request', async () => {
    const h = harness(() => jsonResponse(historyResponse()));

    await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    const headers = h.calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_abc');
    expect(headers['X-Publishable-Key']).toBe(KEY);
  });

  it('reads the token per request, so a refreshed token is picked up', async () => {
    let token = 'first';
    // Parameters declared so `mock.calls` is a typed tuple; `vi.fn(async () => …)`
    // infers `[]` and nothing can be read out of it.
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(historyResponse()),
    );
    const client = new RestClient({
      apiUrl: 'https://chat.example.test',
      publishableKey: KEY,
      getAccessToken: () => token,
      fetch: fetchStub as unknown as typeof globalThis.fetch,
    });
    const history = createHistorySource(client);

    await history.listMessages({ sessionId: 's1', limit: 20 });
    token = 'second';
    await history.listMessages({ sessionId: 's1', limit: 20 });

    const seen = fetchStub.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)['Authorization'],
    );
    expect(seen).toEqual(['Bearer first', 'Bearer second']);
  });

  it('does not double the slash when apiUrl has a trailing one', async () => {
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(historyResponse()),
    );
    const client = new RestClient({
      apiUrl: 'https://chat.example.test/',
      publishableKey: KEY,
      getAccessToken: () => 'tok',
      fetch: fetchStub as unknown as typeof globalThis.fetch,
    });

    await createHistorySource(client).listMessages({ sessionId: 's1', limit: 20 });

    const [input] = fetchStub.mock.calls[0] ?? [];
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).pathname).not.toContain('//');
  });
});

describe('history pagination', () => {
  it('passes the cursor and limit through as query params', async () => {
    const h = harness(() => jsonResponse(historyResponse([], true)));

    await createHistorySource(h.client).listMessages({ sessionId: 's1', before: 'm9', limit: 30 });

    expect(h.calls[0]?.url.searchParams.get('before')).toBe('m9');
    expect(h.calls[0]?.url.searchParams.get('limit')).toBe('30');
  });

  it('omits the cursor entirely when asking for the newest page', async () => {
    const h = harness(() => jsonResponse(historyResponse()));

    await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    expect(h.calls[0]?.url.searchParams.has('before')).toBe(false);
  });

  it('normalizes an enveloped page whose fields are missing', async () => {
    const h = harness(() => jsonResponse({ success: true, data: {} }));

    const page = await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('rejects an unenveloped 200 instead of reporting an empty history', async () => {
    // This is the reload bug's signature: reading `messages` off the top level
    // of a {success,data} body yields an empty page with hasMore:false, which
    // looks exactly like a conversation with no history.
    const h = harness(() => jsonResponse({ messages: [messageRow()], hasMore: false }));

    await expect(
      createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 }),
    ).rejects.toMatchObject({ name: 'RestApiError', code: 'MALFORMED_RESPONSE' });
  });
});

describe('history projection', () => {
  it('decodes integer enums and renames the row fields core does not use', async () => {
    const h = harness(() => jsonResponse(historyResponse([messageRow()])));

    const page = await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    expect(page.messages).toEqual([
      {
        id: 'm1',
        sessionId: 's1',
        senderId: 'agent-9',
        senderType: 'AGENT',
        type: 'IMAGE',
        content: 'here you go',
        seq: 12,
        createdAt: '2026-08-19T10:00:00.000Z',
      },
    ]);
  });

  it('surfaces an attachment buried in metadata so a reloaded image survives', async () => {
    const attachment = {
      url: 'https://cdn.example.test/cat.png',
      fileName: 'cat.png',
      mimeType: 'image/png',
      size: 1024,
      mediaType: 'IMAGE',
    };
    const h = harness(() =>
      jsonResponse(historyResponse([messageRow({ metadata: { attachment } })])),
    );

    const page = await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    expect(page.messages[0]).toMatchObject({ attachment });
    expect(page.messages[0]).not.toHaveProperty('metadata');
  });

  it('reports hasMore from the envelope so scroll-up keeps working', async () => {
    const h = harness(() => jsonResponse(historyResponse([messageRow()], true)));

    const page = await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    expect(page.hasMore).toBe(true);
  });

  it('keeps every good row when one row cannot be decoded', async () => {
    // A newly appended enum value is routine (enums.ts:8). One such message must
    // cost that message, not the customer's whole history — which would be the
    // same user-facing outcome as the empty-page bug this adapter fixes.
    const h = harness(() =>
      jsonResponse(
        historyResponse([
          messageRow({ id: 'm1' }),
          messageRow({ id: 'm2', senderType: 99 }),
          messageRow({ id: 'm3', content: 'still here' }),
        ]),
      ),
    );

    const page = await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    expect(page.messages.map((m) => (m as { id: string }).id)).toEqual(['m1', 'm2', 'm3']);
    expect(page.messages[1]).toMatchObject({ senderType: 'SYSTEM', type: 'SYSTEM', content: '' });
    expect(page.messages[2]).toMatchObject({ content: 'still here' });
  });

  it('omits a row too damaged even to place a marker for', async () => {
    const h = harness(() =>
      jsonResponse(
        historyResponse([messageRow({ id: 'm1' }), { senderType: 99 }, messageRow({ id: 'm3' })]),
      ),
    );

    const page = await createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 });

    expect(page.messages.map((m) => (m as { id: string }).id)).toEqual(['m1', 'm3']);
  });
});

describe('error taxonomy', () => {
  it('surfaces a structured API error as a typed error, not a raw throw', async () => {
    const h = harness(() =>
      jsonResponse({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found', retryable: false } }, 404),
    );

    await expect(
      createHistorySource(h.client).listMessages({ sessionId: 'nope', limit: 20 }),
    ).rejects.toMatchObject({
      name: 'RestApiError',
      code: 'SESSION_NOT_FOUND',
      status: 404,
      retryable: false,
      serverMessage: 'Session not found',
    });
  });

  it('distinguishes a 401 from a network failure', async () => {
    // These demand opposite responses — fix the credential vs retry later — so
    // collapsing them into one error type is a real bug, not a style choice.
    const unauthorized = harness(() =>
      jsonResponse({ error: { code: 'AUTH_INVALID', message: 'bad key', retryable: false } }, 401),
    );
    const offline = harness(() => {
      throw new TypeError('fetch failed');
    });

    await expect(
      createHistorySource(unauthorized.client).listMessages({ sessionId: 's1', limit: 20 }),
    ).rejects.toBeInstanceOf(RestApiError);
    await expect(
      createHistorySource(offline.client).listMessages({ sessionId: 's1', limit: 20 }),
    ).rejects.toBeInstanceOf(RestTransportError);
  });

  it('treats a 5xx without a structured body as retryable', async () => {
    const h = harness(() => new Response('gateway exploded', { status: 502 }));

    await expect(
      createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 }),
    ).rejects.toMatchObject({ retryable: true, status: 502 });
  });

  it('falls back to the status when the server omits retryable entirely', async () => {
    // The service's global error handler emits {code, message} and no
    // `retryable`. Coercing that absence to false made the status fallback
    // unreachable and reported every 500 as permanent — retry silently off for
    // exactly the class of failure retry exists for.
    const h = harness(() =>
      jsonResponse({ error: { code: 'INTERNAL', message: 'boom' } }, 500),
    );

    await expect(
      createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 }),
    ).rejects.toMatchObject({ code: 'INTERNAL', status: 500, retryable: true });
  });

  it('keeps a 4xx without retryable non-retryable', async () => {
    const h = harness(() =>
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired credentials' } }, 401),
    );

    await expect(
      createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401, retryable: false });
  });

  it("honours an explicit retryable: false on a 5xx over the status fallback", async () => {
    // The server's own verdict still wins — the fallback only fills a gap.
    const h = harness(() =>
      jsonResponse({ error: { code: 'INTERNAL', message: 'give up', retryable: false } }, 503),
    );

    await expect(
      createHistorySource(h.client).listMessages({ sessionId: 's1', limit: 20 }),
    ).rejects.toMatchObject({ status: 503, retryable: false });
  });

  it('keeps the server error string off .message, where reporters read it', async () => {
    // upload.routes.ts:197-203 returns the raw caught AWS SDK message on its
    // 500 branch, which can name the bucket, key, region or endpoint. Host apps
    // pipe RestApiError straight into Sentry.
    const leaky =
      'PutObject failed: https://acme-private.s3.us-east-1.amazonaws.com/x?X-Amz-Signature=SECRETSIG';
    const h = harness(() => jsonResponse({ error: { code: 'INTERNAL', message: leaky } }, 500));

    const error: unknown = await createHistorySource(h.client)
      .listMessages({ sessionId: 's1', limit: 20 })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RestApiError);
    expect((error as RestApiError).message).not.toContain('SECRETSIG');
    expect((error as RestApiError).message).not.toContain('acme-private');
    expect((error as RestApiError).message).toBe('request failed with status 500');
    // Still reachable for a human who went looking, and only there.
    expect((error as RestApiError).serverMessage).toBe(leaky);
  });

  it('leaves serverMessage absent when the body carried no structured error', async () => {
    const h = harness(() => new Response('gateway exploded', { status: 502 }));

    const error: unknown = await createHistorySource(h.client)
      .listMessages({ sessionId: 's1', limit: 20 })
      .then(() => null)
      .catch((e: unknown) => e);

    expect((error as RestApiError).serverMessage).toBeUndefined();
    expect((error as RestApiError).message).not.toContain('gateway exploded');
  });

  it('never puts the raw error body into the message', async () => {
    // An error body is attacker-influencable and may echo request detail (§14).
    const h = harness(() => new Response(`token=${'dhk' + '_live_'}LEAKED`, { status: 400 }));

    const error: unknown = await createHistorySource(h.client)
      .listMessages({ sessionId: 's1', limit: 20 })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RestApiError);
    expect((error as RestApiError).message).not.toContain('LEAKED');
  });
});

/** What POST /upload actually replies (upload.routes.ts:166-175). */
function uploadResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      url: 'https://cdn.example.test/dev/t1/images/x.png',
      fileName: 'x.png',
      mimeType: 'image/png',
      size: 1024,
      mediaType: 'images',
      chatSessionId: 's1',
      ...overrides,
    },
  };
}

describe('attachment upload', () => {
  it('posts to /upload, the only route that exists', async () => {
    // `POST /sessions/{id}/attachments` has never been served by chat-service;
    // uploads 404'd. Literal path, deliberately not built from BASE_PATH.
    const h = harness(() => jsonResponse(uploadResponse()));

    await createAttachmentUploader(h.client).upload({
      sessionId: 's1',
      file: new Blob(['x'], { type: 'image/png' }),
      fileName: 'x.png',
    });

    expect(`${h.calls[0]?.init.method} ${h.calls[0]?.url.pathname}`).toBe(
      'POST /chat-services/api/v1/upload',
    );
  });

  it('carries chatSessionId as a query param, not a multipart field', async () => {
    // The route reads the field off `request.file()`, which only resolves
    // fields parsed BEFORE the file part — and this FormData appends the file
    // first, so a field would be dropped silently.
    const h = harness(() => jsonResponse(uploadResponse()));

    await createAttachmentUploader(h.client).upload({
      sessionId: 's 1/2',
      file: new Blob(['x'], { type: 'image/png' }),
    });

    expect(h.calls[0]?.url.searchParams.get('chatSessionId')).toBe('s 1/2');
    const form = h.calls[0]?.init.body as FormData;
    expect(form.has('chatSessionId')).toBe(false);
    expect(form.has('file')).toBe(true);
  });

  it('sends neither a tenant hint nor an idempotency key', async () => {
    // The route derives the tenant from the verified token and ignores
    // X-Tenant-ID; it implements no idempotency key at all.
    const h = harness(() => jsonResponse(uploadResponse()));

    await createAttachmentUploader(h.client).upload({
      sessionId: 's1',
      file: new Blob(['x'], { type: 'image/png' }),
    });

    const headers = h.calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-Tenant-ID']).toBeUndefined();
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('uploads multipart without setting Content-Type by hand', async () => {
    // Setting it manually omits the boundary, and the server cannot parse the body.
    const h = harness(() => jsonResponse(uploadResponse()));

    await createAttachmentUploader(h.client).upload({
      sessionId: 's1',
      file: new Blob(['x'], { type: 'image/png' }),
      fileName: 'x.png',
    });

    const headers = h.calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(h.calls[0]?.init.body).toBeInstanceOf(FormData);
  });

  it('unwraps the envelope and normalizes mediaType to a name core knows', async () => {
    const h = harness(() => jsonResponse(uploadResponse()));

    const attachment = await createAttachmentUploader(h.client).upload({
      sessionId: 's1',
      file: new Blob(['x'], { type: 'image/png' }),
      fileName: 'x.png',
    });

    // 'images' unnormalized falls through core's messageTypeFor default, and
    // every uploaded image is announced as a generic FILE.
    expect(attachment).toEqual({
      url: 'https://cdn.example.test/dev/t1/images/x.png',
      fileName: 'x.png',
      mimeType: 'image/png',
      size: 1024,
      mediaType: 'IMAGE',
    });
  });

  it('maps a documents upload to DOCUMENT', async () => {
    const h = harness(() =>
      jsonResponse(uploadResponse({ mediaType: 'documents', mimeType: 'application/pdf' })),
    );

    const attachment = await createAttachmentUploader(h.client).upload({
      sessionId: 's1',
      file: new Blob(['x'], { type: 'application/pdf' }),
      fileName: 'x.pdf',
    });

    expect((attachment as { mediaType: string }).mediaType).toBe('DOCUMENT');
  });

  it('rejects an unenveloped 200 instead of returning an undefined url', async () => {
    const h = harness(() => jsonResponse({ url: 'https://cdn.example.test/x.png' }));

    await expect(
      createAttachmentUploader(h.client).upload({
        sessionId: 's1',
        file: new Blob(['x'], { type: 'image/png' }),
      }),
    ).rejects.toMatchObject({ name: 'RestApiError', code: 'MALFORMED_RESPONSE' });
  });

  it('rejects an enveloped response with no url', async () => {
    const h = harness(() => jsonResponse({ success: true, data: { fileName: 'x.png' } }));

    await expect(
      createAttachmentUploader(h.client).upload({
        sessionId: 's1',
        file: new Blob(['x'], { type: 'image/png' }),
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('falls back to locally-known file facts when the route omits them', async () => {
    const h = harness(() =>
      jsonResponse({ success: true, data: { url: 'https://cdn.example.test/x.png' } }),
    );

    const attachment = await createAttachmentUploader(h.client).upload({
      sessionId: 's1',
      file: new Blob(['1234'], { type: 'image/png' }),
      fileName: 'named.png',
    });

    expect(attachment).toMatchObject({ fileName: 'named.png', mimeType: 'image/png', size: 4 });
  });
});

/** A raw session row as GET /chat/sessions/{id}/full nests it under `session`. */
function fullSessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      session: {
        id: 's1',
        tenantId: 't1',
        customerId: 'cust-1',
        assignedAgentId: 'agent-9',
        ticketId: 'TICK-7',
        mode: 2,
        status: 3,
        priority: 2,
        closedAt: null,
        createdAt: '2026-08-19T09:00:00.000Z',
        updatedAt: '2026-08-19T09:30:00.000Z',
        // enrichSessionWithUsers attaches these — with no id of their own.
        assignedAgent: { displayName: 'Ada', email: 'ada@x.test', avatarUrl: null, isOnline: true },
        customer: { displayName: 'Bob', email: null, avatarUrl: null, isOnline: false },
        ...overrides,
      },
      messages: [],
      participants: [],
      hasMore: false,
    },
  };
}

/** Routes a two-request action: the mutation receipt, then the /full read-back. */
function sessionActionHarness(fullOverrides: Record<string, unknown> = {}, receiptId = 's1') {
  return harness((url) => {
    if (url.pathname.endsWith('/full')) return jsonResponse(fullSessionResponse(fullOverrides));
    return jsonResponse({ success: true, data: { sessionId: receiptId, status: 4 } });
  });
}

describe('session actions', () => {
  it('posts reopen and close under /chat and reads the session back from /full', async () => {
    // Two round trips on purpose: the mutating routes return only a receipt
    // ({sessionId,status,closedAt} / {sessionId,status,mode}), and core's
    // contract needs the full session. See the comment on createSessionActions.
    const h = sessionActionHarness();
    const actions = createSessionActions(h.client);

    await actions.reopenSession('s1');
    await actions.closeSession('s1');

    expect(h.calls.map((c) => `${c.init.method} ${c.url.pathname}`)).toEqual([
      'POST /chat-services/api/v1/chat/sessions/s1/reopen',
      'GET /chat-services/api/v1/chat/sessions/s1/full',
      'POST /chat-services/api/v1/chat/sessions/s1/close',
      'GET /chat-services/api/v1/chat/sessions/s1/full',
    ]);
  });

  it('returns a fully-populated ChatSession, not a receipt', async () => {
    const h = sessionActionHarness();

    const session = await createSessionActions(h.client).closeSession('s1');

    expect(session).toEqual({
      id: 's1',
      status: 'ASSIGNED',
      mode: 'HUMAN',
      createdAt: '2026-08-19T09:00:00.000Z',
      closedAt: null,
      assignedAgent: {
        participantId: 'agent-9',
        displayName: 'Ada',
        // Never populated on this path — see toProfile in projection.ts.
        email: null,
        avatarUrl: null,
      },
      customer: { participantId: 'cust-1', displayName: 'Bob', email: null, avatarUrl: null },
      ticket: { id: 'TICK-7', url: null },
    });
  });

  it('reads back the session reopen converged on, not the one requested', async () => {
    // reopenSession may converge onto a different, already-active session and
    // returns THAT id; re-reading the requested one would return the wrong
    // session. The convergence stays inside the authorization boundary.
    const h = sessionActionHarness({ id: 's2' }, 's2');

    const session = await createSessionActions(h.client).reopenSession('s1');

    expect(h.calls[1]?.url.pathname).toBe('/chat-services/api/v1/chat/sessions/s2/full');
    expect((session as { id: string }).id).toBe('s2');
  });

  it('decodes the integer status and ISO closedAt of a closed session', async () => {
    const h = sessionActionHarness({ status: 4, closedAt: '2026-08-19T11:00:00.000Z' });

    const session = await createSessionActions(h.client).closeSession('s1');

    expect(session).toMatchObject({ status: 'CLOSED', closedAt: '2026-08-19T11:00:00.000Z' });
  });

  it('rejects an unenveloped /full response rather than returning a hollow session', async () => {
    const h = harness((url) =>
      url.pathname.endsWith('/full')
        ? jsonResponse({ session: { id: 's1', status: 3, mode: 2 } })
        : jsonResponse({ success: true, data: { sessionId: 's1' } }),
    );

    const error: unknown = await createSessionActions(h.client)
      .closeSession('s1')
      .then(() => null)
      .catch((e: unknown) => e);

    // Surfaced as a read-back failure — the mutation still happened — with the
    // underlying verdict retained rather than interpolated.
    expect(error).toBeInstanceOf(RestSessionReadBackError);
    expect((error as RestSessionReadBackError).cause).toMatchObject({
      name: 'RestApiError',
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('reports a failed read-back distinguishably from a failed mutation', async () => {
    // The server HAS closed the session by this point. A caller that treats
    // this like a failed close is wrong in both directions.
    const h = harness((url) =>
      url.pathname.endsWith('/full')
        ? jsonResponse({ error: { code: 'INTERNAL', message: 'boom' } }, 500)
        : jsonResponse({ success: true, data: { sessionId: 's1' } }),
    );

    const error: unknown = await createSessionActions(h.client)
      .closeSession('s1')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RestSessionReadBackError);
    expect((error as RestSessionReadBackError).sessionMutationApplied).toBe(true);
    expect((error as RestSessionReadBackError).sessionId).toBe('s1');
  });

  it('retries the read-back GET and never re-issues the mutation', async () => {
    // closeSession is NOT idempotent: a second POST re-runs the status update,
    // re-marks participants left, and emits another "chat closed" SYSTEM
    // message plus another Kafka event — all visible to the customer.
    const h = harness((url) =>
      url.pathname.endsWith('/full')
        ? jsonResponse({ error: { code: 'INTERNAL', message: 'boom' } }, 500)
        : jsonResponse({ success: true, data: { sessionId: 's1' } }),
    );

    await expect(createSessionActions(h.client).closeSession('s1')).rejects.toBeInstanceOf(
      RestSessionReadBackError,
    );

    const methods = h.calls.map((c) => `${c.init.method} ${c.url.pathname.split('/').pop()}`);
    expect(methods.filter((m) => m.startsWith('POST'))).toEqual(['POST close']);
    expect(methods.filter((m) => m.startsWith('GET'))).toHaveLength(3);
  });

  it('succeeds when a retried read-back recovers', async () => {
    let fullCalls = 0;
    const h = harness((url) => {
      if (!url.pathname.endsWith('/full')) {
        return jsonResponse({ success: true, data: { sessionId: 's1' } });
      }
      fullCalls += 1;
      if (fullCalls === 1) throw new TypeError('fetch failed');
      return jsonResponse(fullSessionResponse());
    });

    const session = await createSessionActions(h.client).closeSession('s1');

    expect((session as { id: string }).id).toBe('s1');
    expect(fullCalls).toBe(2);
  });

  it('does not retry a read-back whose body no retry could reshape', async () => {
    // A malformed envelope is a contract drift, not a blip.
    const h = harness((url) =>
      url.pathname.endsWith('/full')
        ? jsonResponse({ session: { id: 's1' } })
        : jsonResponse({ success: true, data: { sessionId: 's1' } }),
    );

    await expect(createSessionActions(h.client).closeSession('s1')).rejects.toBeInstanceOf(
      RestSessionReadBackError,
    );
    expect(h.calls.filter((c) => c.url.pathname.endsWith('/full'))).toHaveLength(1);
  });

  it('does not issue the read-back when the mutation itself fails', async () => {
    const h = harness(() =>
      jsonResponse({ error: { code: 'SESSION_NOT_FOUND', message: 'nope' } }, 404),
    );

    await expect(createSessionActions(h.client).closeSession('s1')).rejects.toBeInstanceOf(
      RestApiError,
    );
    expect(h.calls).toHaveLength(1);
  });
});

describe('session actions — submitCsat', () => {
  /** `chat.routes.ts`'s own `/csat` response shape — `{success, data: CsatRecord}`. */
  function csatResponse(overrides: Record<string, unknown> = {}) {
    return {
      success: true,
      data: {
        sessionId: 's1',
        rating: 4,
        comment: null,
        submittedAt: '2026-08-19T09:30:00.000Z',
        ...overrides,
      },
    };
  }

  it('is ONE round trip, unlike reopen/close — no /full read-back', async () => {
    const h = harness(() => jsonResponse(csatResponse()));

    await createSessionActions(h.client).submitCsat('s1', 4);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.init.method).toBe('POST');
    expect(h.calls[0]?.url.pathname).toBe('/chat-services/api/v1/chat/sessions/s1/csat');
  });

  it('sends the rating and comment as the JSON body', async () => {
    const h = harness(() => jsonResponse(csatResponse()));

    await createSessionActions(h.client).submitCsat('s1', 5, 'great help');

    expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ rating: 5, comment: 'great help' });
  });

  it('omits comment from the body rather than sending it as null/undefined', async () => {
    const h = harness(() => jsonResponse(csatResponse()));

    await createSessionActions(h.client).submitCsat('s1', 3);

    const body = JSON.parse(String(h.calls[0]?.init.body)) as Record<string, unknown>;
    expect('comment' in body).toBe(false);
    expect(body).toEqual({ rating: 3 });
  });

  it('returns the stored rating field-for-field', async () => {
    const h = harness(() => jsonResponse(csatResponse({ rating: 2, comment: 'meh' })));

    const record = await createSessionActions(h.client).submitCsat('s1', 2, 'meh');

    expect(record).toEqual({
      sessionId: 's1',
      rating: 2,
      comment: 'meh',
      submittedAt: '2026-08-19T09:30:00.000Z',
    });
  });

  it('rejects an unenveloped response as MALFORMED_RESPONSE, never a hollow record', async () => {
    const h = harness(() => jsonResponse({ rating: 4 }));

    const error: unknown = await createSessionActions(h.client)
      .submitCsat('s1', 4)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RestApiError);
    expect((error as RestApiError).code).toBe('MALFORMED_RESPONSE');
  });

  it('propagates a refused rating (e.g. another customer\'s session) as RestApiError', async () => {
    const h = harness(() =>
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'not your session' } }, 403),
    );

    await expect(createSessionActions(h.client).submitCsat('s1', 4)).rejects.toBeInstanceOf(
      RestApiError,
    );
  });
});

describe('session actions — getCsat', () => {
  /** The route's own two shapes: an answered rating, and an honest "not yet". */
  const rated = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    data: {
      rated: true,
      rating: 4,
      comment: 'quick and clear',
      submittedAt: '2026-08-19T09:30:00.000Z',
      ...overrides,
    },
  });

  it('is a GET on the same path the POST uses, in one round trip', async () => {
    const h = harness(() => jsonResponse(rated()));

    await createSessionActions(h.client).getCsat('s1');

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.init.method).toBe('GET');
    expect(h.calls[0]?.url.pathname).toBe('/chat-services/api/v1/chat/sessions/s1/csat');
  });

  it('returns the stored rating', async () => {
    const h = harness(() => jsonResponse(rated()));

    await expect(createSessionActions(h.client).getCsat('s1')).resolves.toEqual({
      rated: true,
      rating: 4,
      comment: 'quick and clear',
      submittedAt: '2026-08-19T09:30:00.000Z',
    });
  });

  it('normalises a missing comment to null — the route documents `string | null`', async () => {
    const h = harness(() => jsonResponse(rated({ comment: undefined })));

    const status = await createSessionActions(h.client).getCsat('s1');

    expect(status).toEqual({
      rated: true,
      rating: 4,
      comment: null,
      submittedAt: '2026-08-19T09:30:00.000Z',
    });
  });

  it('reports an unrated session as an ANSWER, not an absence', async () => {
    const h = harness(() => jsonResponse({ success: true, data: { rated: false } }));

    // The caller acts on this: it is what lets the survey be offered at all,
    // and it must be distinguishable from a lookup that failed.
    await expect(createSessionActions(h.client).getCsat('s1')).resolves.toEqual({ rated: false });
  });

  it('rejects a body with no boolean `rated` rather than reading it as unrated', async () => {
    // Reading a malformed body as "not rated yet" would offer the survey
    // again over a rated session, and the POST is an upsert — the exact
    // duplicate this call exists to prevent.
    const h = harness(() => jsonResponse({ success: true, data: { rating: 4 } }));

    const error: unknown = await createSessionActions(h.client)
      .getCsat('s1')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RestApiError);
    expect((error as RestApiError).code).toBe('MALFORMED_RESPONSE');
  });

  it('rejects `rated: true` with no numeric rating — a locked card with nothing in it', async () => {
    const h = harness(() => jsonResponse({ success: true, data: { rated: true, comment: 'hm' } }));

    const error: unknown = await createSessionActions(h.client)
      .getCsat('s1')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RestApiError);
    expect((error as RestApiError).code).toBe('MALFORMED_RESPONSE');
  });

  it('rejects an unenveloped response as MALFORMED_RESPONSE', async () => {
    const h = harness(() => jsonResponse({ rated: false }));

    await expect(createSessionActions(h.client).getCsat('s1')).rejects.toBeInstanceOf(RestApiError);
  });

  it("propagates the POST's own owner guards — 403 and 404 — as RestApiError", async () => {
    const forbidden = harness(() =>
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'not your session' } }, 403),
    );
    await expect(createSessionActions(forbidden.client).getCsat('s1')).rejects.toBeInstanceOf(
      RestApiError,
    );

    const missing = harness(() =>
      jsonResponse({ error: { code: 'SESSION_NOT_FOUND', message: 'nope' } }, 404),
    );
    await expect(createSessionActions(missing.client).getCsat('s1')).rejects.toBeInstanceOf(
      RestApiError,
    );
  });

  it('percent-encodes the session id into the path', async () => {
    const h = harness(() => jsonResponse({ success: true, data: { rated: false } }));

    await createSessionActions(h.client).getCsat('a/b');

    expect(h.calls[0]?.url.pathname).toBe('/chat-services/api/v1/chat/sessions/a%2Fb/csat');
  });
});

describe('upload -> history round trip', () => {
  // Neither adapter is exercised against the other anywhere else: the upload
  // tests only look at what `upload()` returns, and the history tests only
  // look at what `listMessages()` returns from a hand-built row. Nothing pins
  // the two together, so a normalization drift between them (e.g. media-type
  // casing) would pass every existing test while still shipping a reloaded
  // message with a lost or mislabelled attachment.
  //
  // This drives both adapters against what the service actually does with an
  // upload in between: the client posts the image, gets back an attachment,
  // sends a message carrying it (core stamps `type` from `attachment.mediaType`
  // per messageTypeFor, controller.ts:87-97), the server persists that
  // attachment inside the message row's `metadata` column exactly as
  // `POST /upload` described it, and a reload reads it back through
  // `GET /chat/sessions/{id}/messages`.
  it('comes back from history as IMAGE with the attachment intact after an upload', async () => {
    const h = harness((url) => {
      if (url.pathname.endsWith('/upload')) return jsonResponse(uploadResponse());
      return jsonResponse(
        historyResponse([
          messageRow({
            messageType: 4, // MessageType.IMAGE (enums.ts:40) — set from the uploaded attachment.
            content: uploadResponse().data.url, // §12.10 placeholder: content === attachment.url.
            metadata: {
              // The row's `metadata.attachment` is exactly what `/upload` handed back —
              // this is what the server is trusted to have persisted verbatim.
              attachment: {
                url: uploadResponse().data.url,
                fileName: uploadResponse().data.fileName,
                mimeType: uploadResponse().data.mimeType,
                size: uploadResponse().data.size,
                mediaType: 'IMAGE', // normalizeMediaType('images') — never the raw S3 folder name.
              },
            },
          }),
        ]),
      );
    });

    const uploaded = await createAttachmentUploader(h.client).upload({
      sessionId: 's1',
      file: new Blob(['x'], { type: 'image/png' }),
      fileName: 'x.png',
    });

    // What core would actually stamp on the outgoing message.
    expect((uploaded as { mediaType: string }).mediaType).toBe('IMAGE');

    const page = await createHistorySource(h.client).listMessages({
      sessionId: 's1',
      limit: 20,
    });

    expect(page.messages[0]).toMatchObject({
      type: 'IMAGE',
      attachment: uploaded,
    });
    // The §12.10 placeholder must not resurface as visible caption text — that
    // is the widget's job (message-list.ts's `visibleContent`), but the row it
    // works from has to actually carry the placeholder for that filter to fire.
    expect((page.messages[0] as { content: string }).content).toBe(
      (uploaded as { url: string }).url,
    );
  });
});

/** What GET /chat/sessions/customer actually replies (chat.routes.ts:238, openapi's SessionSummaryPageWire). */
function sessionSummaryPageResponse(sessions: unknown[] = []) {
  return { success: true, data: { sessions } };
}

/** One `sessions[]` item, exactly as the wire sends it — v2 string enums, no row renames needed. */
function sessionSummaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sum-1',
    status: 'ASSIGNED',
    mode: 'HUMAN',
    createdAt: '2026-08-19T09:00:00.000Z',
    closedAt: null,
    lastMessageAt: '2026-08-19T09:05:00.000Z',
    lastMessagePreview: 'here you go',
    unreadCount: 3,
    handledBy: { kind: 'AGENT', id: 'agent-9', displayName: 'Ada' },
    ...overrides,
  };
}

describe('session summaries (listSessions)', () => {
  it('requests GET /chat/sessions/customer under the correct base path', async () => {
    const h = harness(() => jsonResponse(sessionSummaryPageResponse()));

    await createSessionSummarySource(h.client).listSessions();

    expect(`${h.calls[0]?.init.method} ${h.calls[0]?.url.pathname}`).toBe(
      'GET /chat-services/api/v1/chat/sessions/customer',
    );
  });

  it('sends both credentials, same as every other adapter', async () => {
    const h = harness(() => jsonResponse(sessionSummaryPageResponse()));

    await createSessionSummarySource(h.client).listSessions();

    const headers = h.calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_abc');
    expect(headers['X-Publishable-Key']).toBe(KEY);
  });

  it('parses a full session summary, including handledBy', async () => {
    const h = harness(() => jsonResponse(sessionSummaryPageResponse([sessionSummaryRow()])));

    const sessions = await createSessionSummarySource(h.client).listSessions();

    expect(sessions).toEqual([
      {
        id: 'sum-1',
        status: 'ASSIGNED',
        mode: 'HUMAN',
        createdAt: '2026-08-19T09:00:00.000Z',
        closedAt: null,
        lastMessageAt: '2026-08-19T09:05:00.000Z',
        lastMessagePreview: 'here you go',
        unreadCount: 3,
        handledBy: { kind: 'AGENT', id: 'agent-9', displayName: 'Ada' },
      },
    ]);
  });

  it('leaves absent optional fields absent, not undefined-valued keys or null', async () => {
    const row = sessionSummaryRow();
    delete (row as Record<string, unknown>)['lastMessagePreview'];
    delete (row as Record<string, unknown>)['handledBy'];
    const h = harness(() => jsonResponse(sessionSummaryPageResponse([row])));

    const sessions = await createSessionSummarySource(h.client).listSessions();
    const summary = sessions[0] as Record<string, unknown>;

    expect('lastMessagePreview' in summary).toBe(false);
    expect('handledBy' in summary).toBe(false);
    expect(Object.keys(summary).sort()).toEqual([
      'closedAt',
      'createdAt',
      'id',
      'lastMessageAt',
      'mode',
      'status',
      'unreadCount',
    ]);
  });

  it('treats a guest 200-with-empty-array as a normal success, not an error', async () => {
    const h = harness(() => jsonResponse(sessionSummaryPageResponse([])));

    await expect(createSessionSummarySource(h.client).listSessions()).resolves.toEqual([]);
  });

  it('passes limit through as a query param when supplied', async () => {
    const h = harness(() => jsonResponse(sessionSummaryPageResponse()));

    await createSessionSummarySource(h.client).listSessions({ limit: 10 });

    expect(h.calls[0]?.url.searchParams.get('limit')).toBe('10');
  });

  it('omits limit entirely when not supplied, deferring to the server default of 5', async () => {
    const h = harness(() => jsonResponse(sessionSummaryPageResponse()));

    await createSessionSummarySource(h.client).listSessions();

    expect(h.calls[0]?.url.searchParams.has('limit')).toBe(false);
  });

  it.each([0, 101, 1.5, -1, NaN])(
    'rejects an out-of-range limit (%s) locally, without making a request',
    async (limit) => {
      const h = harness(() => jsonResponse(sessionSummaryPageResponse()));

      await expect(
        createSessionSummarySource(h.client).listSessions({ limit }),
      ).rejects.toMatchObject({ name: 'RestApiError', code: 'VALIDATION_FAILED' });
      expect(h.calls).toHaveLength(0);
    },
  );

  it.each([1, 100, 50, 20, 5])('accepts the boundary values 1 and 100, and defaults', async (limit) => {
    const h = harness(() => jsonResponse(sessionSummaryPageResponse()));

    await createSessionSummarySource(h.client).listSessions({ limit });

    expect(h.calls[0]?.url.searchParams.get('limit')).toBe(String(limit));
  });

  it('rejects an unenveloped 200 instead of returning an empty picker', async () => {
    const h = harness(() => jsonResponse({ sessions: [sessionSummaryRow()] }));

    await expect(createSessionSummarySource(h.client).listSessions()).rejects.toMatchObject({
      name: 'RestApiError',
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('keeps every good session when one cannot be decoded', async () => {
    const h = harness(() =>
      jsonResponse(
        sessionSummaryPageResponse([
          sessionSummaryRow({ id: 's1' }),
          sessionSummaryRow({ id: 's2', status: 'NOT_A_REAL_STATUS' }),
          sessionSummaryRow({ id: 's3' }),
        ]),
      ),
    );

    const sessions = await createSessionSummarySource(h.client).listSessions();

    expect(sessions.map((s) => (s as { id: string }).id)).toEqual(['s1', 's3']);
  });

  it('maps a structured API error the same way every other adapter does', async () => {
    const h = harness(() =>
      jsonResponse({ error: { code: 'AUTH_EXPIRED', message: 'token expired', retryable: true } }, 401),
    );

    await expect(createSessionSummarySource(h.client).listSessions()).rejects.toMatchObject({
      name: 'RestApiError',
      code: 'AUTH_EXPIRED',
      status: 401,
      retryable: true,
      serverMessage: 'token expired',
    });
  });

  it('distinguishes a transport failure from a server verdict', async () => {
    const h = harness(() => {
      throw new TypeError('fetch failed');
    });

    await expect(createSessionSummarySource(h.client).listSessions()).rejects.toBeInstanceOf(
      RestTransportError,
    );
  });

  it('treats a 5xx without a structured body as retryable, same status fallback as history', async () => {
    const h = harness(() => new Response('gateway exploded', { status: 502 }));

    await expect(createSessionSummarySource(h.client).listSessions()).rejects.toMatchObject({
      retryable: true,
      status: 502,
    });
  });
});
