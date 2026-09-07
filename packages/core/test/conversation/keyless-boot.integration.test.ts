// Keyless boot against a REAL chat-service. Opt-in, and skipped by default.
//
// ── Why this needs no backend CODE change ────────────────────────────────
//
// The keyless staff hello already works today for a role the deployment
// already issues: `cognito-verifier.ts` maps roleId 1/5/6/66 to a role, and
// `handlers.ts` admits anything passing `isStaffConnection` over
// `STAFF_ROLES = {agent, admin, super_admin, supervisor}`. An ADMIN token
// (roleId 1) passes both gates. So this path is provable end to end with zero
// server code changes — config only.
//
// ── The two halves, and why they are guarded separately ──────────────────
//
// The REFUSAL half needs no credential at all, so it runs against any reachable
// v2 endpoint. It is the more interesting of the two against a default local
// deployment: `staffSurfaceEnabled` is
// `WS_V2_ENABLED === 'true' && WS_V2_STAFF_ENABLED === 'true'`
// (`chat-service-node/src/config/index.ts:110`), and the checked-in
// `.env` sets only the first — so a keyless hello lands on the
// `staff_disabled` branch and comes back as `AUTH_INVALID` / "Invalid
// publishable key" on a connection that sent no key. That is exactly the wire
// shape `src/conversation/keyless-errors.test.ts` asserts against a stub, and
// running it here proves the stub is faithful.
//
// The CONNECTED half additionally needs a real dh-auth admin id_token AND
// `WS_V2_STAFF_ENABLED=true`, so it is guarded on the token being supplied.
//
// ── Running it ───────────────────────────────────────────────────────────
//
//   Refusal half only (no credential needed):
//     CHATSDK_IT_WS_URL='ws://localhost:3000/chat-services/v2/ws' \
//     pnpm vitest run packages/core/test/conversation
//
//   Both halves:
//     start chat-service-node with WS_V2_ENABLED=true WS_V2_STAFF_ENABLED=true
//     CHATSDK_IT_WS_URL='ws://localhost:3000/chat-services/v2/ws' \
//     CHATSDK_IT_TOKEN='<a real admin id_token>' \
//     pnpm vitest run packages/core/test/conversation
//
// With the variables absent the cases SKIP. They do not pass vacuously and
// they do not fail. A skipped run proves nothing, and this file says so rather
// than reporting green.
//
// Practical note: prefer `127.0.0.1` over `localhost` in the URL. Another dev
// server bound to the same port on `::1` will win the name resolution and the
// socket then never opens — which reads as a 60-second timeout rather than as
// a wrong host.

import { describe, expect, it } from 'vitest';

import { createConversationClient } from '../../src/index.js';

const WS_URL = process.env['CHATSDK_IT_WS_URL'];
const TOKEN = process.env['CHATSDK_IT_TOKEN'];

const HAVE_URL = typeof WS_URL === 'string' && WS_URL !== '';
const HAVE_TOKEN = typeof TOKEN === 'string' && TOKEN !== '';

describe.skipIf(!HAVE_URL)('keyless refusal against a live chat-service', () => {
  it('surfaces AUTH_INVALID, and never the server text, for a hello it will not admit', async () => {
    const client = createConversationClient({
      wsUrl: WS_URL as string,
      // Deliberately not a real credential. Every cause the server has for
      // refusing a keyless hello answers with the same code, which is the
      // whole reason this surface branches on `code` and rewrites `message`.
      getToken: () => 'not-a-real-token',
      localSender: { senderId: 'integration_probe', senderType: 'AGENT' },
      history: { listMessages: async () => ({ messages: [], hasMore: false }) },
    });

    try {
      await expect(client.connect()).rejects.toThrow();

      const error = client.getState().lastError;
      expect(error?.code).toBe('AUTH_INVALID');
      expect(error?.message).not.toContain('Invalid publishable key');
      expect(error?.message).toContain('WS_V2_STAFF_ENABLED');
    } finally {
      client.disconnect();
    }
  }, 60_000);
});

describe.skipIf(!HAVE_URL || !HAVE_TOKEN)('keyless boot against a live chat-service', () => {
  it('reaches connected on a session-less ack and holds no conversations', async () => {
    const client = createConversationClient({
      wsUrl: WS_URL as string,
      getToken: () => TOKEN as string,
      localSender: { senderId: 'integration_admin', senderType: 'AGENT' },
      history: { listMessages: async () => ({ messages: [], hasMore: false }) },
    });

    try {
      await client.connect();

      expect(client.getState().connectionState).toBe('connected');
      // A staff connection resolves no session, so there is nothing to project
      // and a successful handshake must leave `lastError` untouched.
      expect(client.getState().conversations).toEqual({});
      expect(client.getState().lastError).toBeNull();
    } finally {
      client.disconnect();
    }
  }, 30_000);
});
