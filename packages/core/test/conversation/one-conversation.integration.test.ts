// ONE live conversation against a REAL chat-service. Opt-in, and skipped by
// default — exactly as `keyless-boot.integration.test.ts` is, and for the same
// reason: a run that proves nothing must SAY it proved nothing rather than
// report green.
//
// ── What this needs, and why none of it is a backend code change ─────────
//
//   1. `chat-service-node` with `WS_V2_ENABLED=true` AND
//      `WS_V2_STAFF_ENABLED=true` (`config/index.ts:111`). The checked-in `.env`
//      sets only the first, so this is a config change and nothing more.
//   2. A dh-auth ADMIN `id_token` (roleId 1). `cognito-verifier.ts` maps
//      roleId 1/5/6/66 to a role and `handleStaffHello` admits anything in
//      `STAFF_ROLES`; roleId 2/3 map to `roles: []` and are refused. An admin
//      also clears `canAccessSession`, whose staff branch is
//      `return subject.isStaff` — so no per-session grant is needed either.
//   3. A session id the tenant behind that token owns. `session.join` is the
//      one frame that takes a caller-supplied session id and it ownership-checks
//      it, answering `SESSION_NOT_FOUND` identically for "does not exist" and
//      "belongs to someone else".
//   4. An HTTP history source. Core does no HTTP — that is the point of the
//      seam — so this file supplies a `fetch`-based adapter of its own, which
//      is also a fair test of the seam's shape.
//
// ── Running it ───────────────────────────────────────────────────────────
//
//   CHATSDK_IT_WS_URL='ws://127.0.0.1:3000/chat-services/v2/ws' \
//   CHATSDK_IT_API_URL='http://127.0.0.1:3000' \
//   CHATSDK_IT_TOKEN='<a real dh-auth admin id_token>' \
//   CHATSDK_IT_SESSION_ID='<a session that tenant owns>' \
//   npx vitest run packages/core/test/conversation
//
// Prefer `127.0.0.1` over `localhost`: another server bound to the same port on
// `::1` wins name resolution, and the socket then never opens — which reads as
// a 60-second timeout rather than as a wrong host.

import { describe, expect, it } from 'vitest';

import { createConversationClient } from '../../src/index.js';
import type { MessagePage } from '../../src/messages/index.js';
import type { ChatMessage } from '../../src/state/index.js';

const WS_URL = process.env['CHATSDK_IT_WS_URL'];
const API_URL = process.env['CHATSDK_IT_API_URL'];
const TOKEN = process.env['CHATSDK_IT_TOKEN'];
const SESSION_ID = process.env['CHATSDK_IT_SESSION_ID'];

const READY =
  typeof WS_URL === 'string' &&
  WS_URL !== '' &&
  typeof API_URL === 'string' &&
  API_URL !== '' &&
  typeof TOKEN === 'string' &&
  TOKEN !== '' &&
  typeof SESSION_ID === 'string' &&
  SESSION_ID !== '';

/**
 * The history seam, over real HTTP.
 *
 * Deliberately written here rather than imported from `@dhaam-ccrm/rest`: this
 * file is proving that core needs nothing but this interface, and reaching for
 * the shipped adapter would prove that the shipped adapter works instead.
 */
function httpHistory(apiUrl: string, token: string): {
  listMessages: (q: { sessionId: string; before?: string; limit: number }) => Promise<MessagePage>;
} {
  return {
    async listMessages(query): Promise<MessagePage> {
      const url = new URL(
        `/chat-services/api/v1/chat/sessions/${encodeURIComponent(query.sessionId)}/messages`,
        apiUrl,
      );
      url.searchParams.set('limit', String(query.limit));
      if (query.before !== undefined) url.searchParams.set('before', query.before);

      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`history read failed: ${response.status}`);

      const body = (await response.json()) as {
        data?: { messages?: ChatMessage[]; hasMore?: boolean };
      };
      return {
        messages: body.data?.messages ?? [],
        hasMore: body.data?.hasMore ?? false,
      };
    },
  };
}

describe.skipIf(!READY)('one live conversation against a live chat-service', () => {
  it('joins, snapshots, pages history, sends, and sees the echo confirmed', async () => {
    const client = createConversationClient({
      wsUrl: WS_URL as string,
      getToken: () => TOKEN as string,
      localSender: { senderId: 'integration_admin', senderType: 'AGENT' },
      history: httpHistory(API_URL as string, TOKEN as string),
    });

    try {
      await client.connect();
      expect(client.getState().connectionState).toBe('connected');
      // A staff handshake resolves NO session — the whole reason `open()` has
      // to exist rather than the connection auto-joining one.
      expect(client.getState().conversations).toEqual({});

      await client.open({ conversationId: SESSION_ID as string });

      const row = client.getState().conversations[SESSION_ID as string];
      expect(row).toBeDefined();
      // The snapshot the server pushes after every accepted join.
      expect(row?.session?.id).toBe(SESSION_ID);
      // Page one was read through the injected seam — `initialLoaded` is what
      // separates "there is nothing older" from "nobody has asked yet".
      expect(row?.pagination.initialLoaded).toBe(true);
      expect(row?.connectionState).toBe('connected');
      expect(Object.isFrozen(row)).toBe(true);

      const before = row?.messages.length ?? 0;
      const content = `sdk integration probe ${Date.now()}`;
      await client.sendMessage(SESSION_ID as string, content);

      const echo = client
        .getState()
        .conversations[SESSION_ID as string]?.messages.find((m) => m.content === content);
      expect(echo).toBeDefined();
      expect(client.getState().conversations[SESSION_ID as string]?.messages.length).toBe(before + 1);

      // The server never echoes `message.new` back to the sender, so the ack is
      // the only confirmation that will arrive: `delivery` clears and `seq` is
      // recorded on the same row the optimistic echo created.
      const deadline = Date.now() + 10_000;
      let confirmed = false;
      while (Date.now() < deadline && !confirmed) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const current = client
          .getState()
          .conversations[SESSION_ID as string]?.messages.find((m) => m.id === echo?.id);
        confirmed = current?.delivery === undefined && typeof current?.seq === 'number';
      }
      expect(confirmed).toBe(true);
    } finally {
      client.disconnect();
    }
  }, 60_000);
});
