// node, vi.stubGlobal('fetch', …). Mirrors remote-config.test.ts's own
// fetch-testing idiom, one level down: this is the write half.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WEBFORM_PATH,
  WebformError,
  newSubmissionId,
  submitWebform,
  visitorMessage,
} from '../src/webform.js';
import type { WebformDraft, WebformFailureKind } from '../src/webform.js';

const PUBLISHABLE = 'dhp_' + 'test_' + '0123456789abcdefghijklmn';

function draft(overrides: Partial<WebformDraft> = {}): WebformDraft {
  return {
    submissionId: 'sub-0123456789',
    email: 'ada@example.com',
    message: 'Where is my order?',
    fillMs: 4200,
    company_website: '',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submitWebform — the request', () => {
  it('POSTs to WEBFORM_PATH under apiUrl, stripping a trailing slash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { outcome: 'ticket', receiptId: 'r1', duplicate: false }));
    vi.stubGlobal('fetch', fetchMock);

    await submitWebform({ apiUrl: 'https://chat.example.com//', publishableKey: PUBLISHABLE, draft: draft() });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://chat.example.com${WEBFORM_PATH}`);
    expect(init.method).toBe('POST');
  });

  it('carries X-Publishable-Key and no Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { outcome: 'ticket', receiptId: 'r1', duplicate: false }));
    vi.stubGlobal('fetch', fetchMock);

    await submitWebform({ apiUrl: 'https://chat.example.com', publishableKey: PUBLISHABLE, draft: draft() });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Publishable-Key']).toBe(PUBLISHABLE);
    expect(headers['Authorization']).toBeUndefined();
    expect(init.credentials).toBe('omit');
  });

  it('sends a body with exactly the WebformDraft keys — the route is .strict()', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { outcome: 'ticket', receiptId: 'r1', duplicate: false }));
    vi.stubGlobal('fetch', fetchMock);

    const theDraft = draft({ name: 'Ada', phone: '+1', subject: 'Order', prefer: 'ticket', pageUrl: 'https://x', locale: 'en-US' });
    await submitWebform({ apiUrl: 'https://chat.example.com', publishableKey: PUBLISHABLE, draft: theDraft });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(theDraft).sort());
    expect(sent).toEqual(theDraft);
  });

  it('omits an absent optional field rather than sending it as null/undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { outcome: 'ticket', receiptId: 'r1', duplicate: false }));
    vi.stubGlobal('fetch', fetchMock);

    await submitWebform({ apiUrl: 'https://chat.example.com', publishableKey: PUBLISHABLE, draft: draft() });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect('name' in sent).toBe(false);
    expect('phone' in sent).toBe(false);
    expect('subject' in sent).toBe(false);
  });
});

describe('submitWebform — success', () => {
  it('resolves with the receipt on 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(202, { outcome: 'chat', receiptId: 'r1', duplicate: false, chatSessionId: 'sess_1' })),
    );

    await expect(
      submitWebform({ apiUrl: 'https://chat.example.com', publishableKey: PUBLISHABLE, draft: draft() }),
    ).resolves.toEqual({ outcome: 'chat', receiptId: 'r1', duplicate: false, chatSessionId: 'sess_1' });
  });

  it('rejects with an "unavailable" WebformError when the 2xx body is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(202, { nonsense: true })));

    const rejection = await submitWebform({
      apiUrl: 'https://chat.example.com',
      publishableKey: PUBLISHABLE,
      draft: draft(),
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(WebformError);
    expect((rejection as WebformError).kind).toBe('unavailable');
  });
});

describe('submitWebform — status → WebformFailureKind, exhaustively', () => {
  it.each<[number, unknown, WebformFailureKind]>([
    [400, { error: { code: 'VALIDATION_FAILED' } }, 'validation'],
    [401, { error: { code: 'AUTH_INVALID' } }, 'unauthorized'],
    [403, { error: { code: 'ORIGIN_NOT_ALLOWED' } }, 'origin'],
    [403, { error: { code: 'CHANNEL_DISABLED' } }, 'channel_off'],
    [413, { error: { code: 'PAYLOAD_TOO_LARGE' } }, 'too_large'],
    [429, { error: { code: 'RATE_LIMITED' } }, 'rate_limited'],
    [503, { error: { code: 'WEBFORM_UNAVAILABLE' } }, 'unavailable'],
    [500, { error: { code: 'INTERNAL' } }, 'unavailable'],
    // Unlisted statuses, exercising the total fallback: below 500 reads as a
    // validation disagreement, at or above it reads as unavailable.
    [418, {}, 'validation'],
    [507, {}, 'unavailable'],
  ])('%i → %s', async (status, body, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, body)));

    const rejection = await submitWebform({
      apiUrl: 'https://chat.example.com',
      publishableKey: PUBLISHABLE,
      draft: draft(),
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WebformError);
    expect((rejection as WebformError).kind).toBe(kind);
  });

  it('a 403 with an unparseable body falls to "origin" — the branch that does not trigger a refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 403 })));

    const rejection = await submitWebform({
      apiUrl: 'https://chat.example.com',
      publishableKey: PUBLISHABLE,
      draft: draft(),
    }).catch((error: unknown) => error);
    expect((rejection as WebformError).kind).toBe('origin');
  });

  it('parses Retry-After into retryAfterSec on a 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(429, { error: { code: 'RATE_LIMITED' } }, { 'Retry-After': '30' })),
    );

    const rejection = await submitWebform({
      apiUrl: 'https://chat.example.com',
      publishableKey: PUBLISHABLE,
      draft: draft(),
    }).catch((error: unknown) => error);
    expect((rejection as WebformError).retryAfterSec).toBe(30);
  });

  it('leaves retryAfterSec undefined when the header is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: { code: 'RATE_LIMITED' } })));

    const rejection = await submitWebform({
      apiUrl: 'https://chat.example.com',
      publishableKey: PUBLISHABLE,
      draft: draft(),
    }).catch((error: unknown) => error);
    expect((rejection as WebformError).retryAfterSec).toBeUndefined();
  });

  it('names the field from details.fieldErrors on a 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(400, { error: { code: 'VALIDATION_FAILED', details: { fieldErrors: { email: ['invalid'] } } } }),
      ),
    );

    const rejection = await submitWebform({
      apiUrl: 'https://chat.example.com',
      publishableKey: PUBLISHABLE,
      draft: draft(),
    }).catch((error: unknown) => error);
    expect((rejection as WebformError).field).toBe('email');
  });
});

describe('submitWebform — network and timeout', () => {
  it('rejects with kind "network" on a bare fetch rejection (offline, CORS, DNS)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const rejection = await submitWebform({
      apiUrl: 'https://chat.example.com',
      publishableKey: PUBLISHABLE,
      draft: draft(),
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(WebformError);
    expect((rejection as WebformError).kind).toBe('network');
  });

  it('aborts after the timeout and rejects with "network" rather than hanging', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );

    const pending = submitWebform({
      apiUrl: 'https://chat.example.com',
      publishableKey: PUBLISHABLE,
      draft: draft(),
      timeoutMs: 15_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15_000);
    const rejection = await pending;
    expect(rejection).toBeInstanceOf(WebformError);
    expect((rejection as WebformError).kind).toBe('network');
    vi.useRealTimers();
  });
});

describe('newSubmissionId', () => {
  const ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

  it('matches the server-required pattern when crypto.randomUUID is present', () => {
    const id = newSubmissionId();
    expect(id).toMatch(ID_PATTERN);
  });

  it('matches the server-required pattern in the fallback path too', () => {
    vi.stubGlobal('crypto', {});
    const id = newSubmissionId();
    expect(id).toMatch(ID_PATTERN);
  });

  it('mints a different id on every call', () => {
    expect(newSubmissionId()).not.toBe(newSubmissionId());
  });
});

describe('visitorMessage — total, and never the server’s own words', () => {
  const kinds: readonly WebformFailureKind[] = [
    'validation',
    'unauthorized',
    'origin',
    'channel_off',
    'too_large',
    'rate_limited',
    'unavailable',
    'network',
  ];

  it.each(kinds)('yields a non-empty sentence for %s', (kind) => {
    const error = new WebformError(kind, 'attacker-controlled detail: <script>', kind === 'rate_limited');
    const message = visitorMessage(error);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('<script>');
    expect(message).not.toContain('attacker-controlled');
  });

  it('treats anything that is not a WebformError as "network"', () => {
    expect(visitorMessage(new Error('boom'))).toBe(visitorMessage(new WebformError('network', '', true)));
  });

  it('channel_off gets its own sentence, distinct from a plain retry', () => {
    expect(visitorMessage(new WebformError('channel_off', '', false))).toBe(
      'Messaging is switched off for this site.',
    );
  });
});
