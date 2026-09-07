# Keyless admin panel — reference integration

A plain HTML + TypeScript staff console built on `createConversationClient`,
the **keyless** front door. No framework, no publishable key, no token-minting
server.

It exists to answer two questions that are usually tangled together:

| Question | What answers it |
|---|---|
| Is my SDK wiring right? | `pnpm smoke` — no browser, no token, ~3 seconds |
| Is my backend configured and my token good? | this panel against your real chat-service |

Keeping them apart matters, because a misconfigured backend and a bad token and
a non-staff role all fail **identically**: `AUTH_INVALID` and a 1008 close. See
[Troubleshooting](#8-troubleshooting).

---

## 1. The one idea

There is no `mode: 'staff'` flag. The config object simply has **no
`publishableKey` property**, and that absence is what selects chat-service's
staff flow — the server branches on `conn.staffSurface`, which the keyless hello
sets. Consequences, all deliberate:

- `publishableKey: ''` **throws**. It is not a quieter second route to the staff
  flow.
- A secret key throws `SecretKeyInClientError`, ahead of any format check.
- `publishableKey: process.env.PK` evaluating to `undefined` cannot silently
  become a staff connection, because this is a **different factory** from
  `createChatClient` — not a widened config.

The staff flow differs from the customer flow in a way you will feel: joined
sessions **accumulate** rather than evict.

---

## 2. Run it, from a cold start

Numbered, copy-pasteable, and honest about where it stops.

### Steps 1-5 need nothing but this repo

```bash
# 1. From the repo root — the example resolves the SDK through each package's
#    `exports` field, which points at dist/. An unbuilt workspace cannot resolve.
cd <repo root>
pnpm install
pnpm -r build

# 2. Prove the SDK wiring with no browser, no backend and no token (~3s).
cd examples/admin-panel
pnpm smoke
```

Expected — the last line is the one that matters:

```
  ✓ connected — keyless hello accepted, session-less ack (state: connected)
  ✓ a refused join throws ConversationJoinError { reason: "refused", code: "SESSION_NOT_FOUND" }
  ✓ open() resolved: status=ASSIGNED mode=HUMAN history=2 row(s), initialLoaded=true
  ✓ raw history rows projected — integer enums decoded (senderType=CUSTOMER, type=TEXT)
  ✓ optimistic echo rendered immediately with delivery.state="queued"
  ✓ server acked — delivery cleared, seq=102
  ✓ inbound message.new landed on this row: CUSTOMER "(stub customer) got it — …"
  ✓ disconnect() — user-initiated and terminal

  8 steps, all green.

[smoke] PASS — the SDK path works. This says nothing about your auth.
```

```bash
# 3. Now the page itself, against the same stub.
pnpm start:stub

# 4. Open http://127.0.0.1:5174 — a yellow STUB banner should be at the top and
#    the URL and token fields should already be filled in.

# 5. In the page, in this order:
#      a. press Connect                      -> Connection state goes to `connected`
#      b. press "List my queue"              -> two session buttons appear
#      c. click `no-such-session`, press Open -> the log shows
#         ConversationJoinError { reason: "refused", code: "SESSION_NOT_FOUND" }
#      d. click `stub_session_1`, press Open  -> Status ASSIGNED, Mode HUMAN,
#         "Page one loaded: true", two history messages render
#      e. type "on my way" and press Send     -> it appears at once as
#         `AGENT on my way — queued`, the badge clears ~400ms later, and a
#         `CUSTOMER (stub customer) got it — …` reply arrives a second after that
```

If step 5 works, **your panel wiring is correct**. Everything after this point is
about your backend and your credentials, and nothing you change in the panel can
fix it.

### Step 6 — point it at a real chat-service

```bash
# 6a. In your chat-service-node checkout, .env needs BOTH of these:
#       WS_V2_ENABLED=true
#       WS_V2_STAFF_ENABLED=true      <- NOT in .env.example, and NOT implied by the line above
#     plus APP_PORT=3000, KAFKA_ENABLED=false, a >=32-char CHAT_ACCESS_TOKEN_SECRET,
#     and Postgres running. Then restart it — these are read at boot.

# 6b. Confirm it is actually chat-service answering on that port, not something else:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/chat-services/health   # expect 200
lsof -nP -iTCP:3000 -sTCP:LISTEN

# 6c. Serve the panel with no stub:
cd examples/admin-panel
pnpm start                                    # http://127.0.0.1:5174
```

### Step 7 — THIS IS WHERE YOU GET STUCK WITHOUT AN ADMIN TOKEN

```
# 7. In the page:
#      WebSocket URL   ws://127.0.0.1:3000/chat-services/v2/ws
#      REST origin     http://127.0.0.1:3000
#      id_token        <-- a dh-auth id_token whose roleId is 1, 5, 6 or 66
#      participant id  anything; it is a local echo hint
```

**There is no way past this step from inside this repo.** The panel has no
credential of its own and cannot mint one — that is the whole design of the
keyless surface. The token has to come from your dh-auth deployment: sign in to
an admin account and take the `id_token` your app already holds.

Two specific traps at this step:

- A **merchant (roleId 2)** or **manager (roleId 3)** token verifies perfectly
  and is still refused, because the verifier maps them to `roles: []`. It fails
  identically to a bad token. See §7.
- Everything before this step is a mock. `pnpm smoke` and `pnpm start:stub` prove
  nothing whatsoever about authentication — the stub accepts any non-empty
  string as a token.

```bash
# 8. Then, in the page: press "List my queue" to get a real session id, click it,
#    press Open, and send. Same five sub-steps as 5a-5e, against real data.

# 9. Optionally, the repo's own live integration tests. They SKIP silently
#    without all four variables, and a skip is not a pass:
export CHATSDK_IT_WS_URL=ws://127.0.0.1:3000/chat-services/v2/ws
export CHATSDK_IT_API_URL=http://127.0.0.1:3000
export CHATSDK_IT_TOKEN=<the same id_token>
export CHATSDK_IT_SESSION_ID=<a session id from step 8>
cd <repo root>
npx vitest run packages/core/test/conversation
```

---

## 3. Install

```bash
pnpm add @dhaam-ccrm/core
```

`@dhaam-ccrm/rest` is optional but recommended even on this surface — not for
its `RestClient` (see [§6](#6-history-is-injected-and-restclient-cannot-help-you-yet)),
but for `projectHistoryRow`, the pure function that knows a raw history row
carries integer enums.

No framework binding is required. `@dhaam-ccrm/react` wraps the **customer**
`ChatClient`; the per-conversation handle that makes those bindings work
per-thread is a later slice.

---

## 4. Boot code

```ts
import { createConversationClient } from '@dhaam-ccrm/core';

const client = createConversationClient({
  wsUrl: 'wss://api.example.com/chat-services/v2/ws',
  // NO publishableKey. Its ABSENCE is what selects the server's staff flow.
  getToken: async () => ({ token: await auth.idToken(), expiresInMs: auth.msUntilExpiry() }),
  localSender: { senderId: auth.userId, senderType: 'AGENT' },
  history: {
    async listMessages({ sessionId, before, limit }) {
      const url = new URL(`/chat-services/api/v1/agent/sessions/${sessionId}/messages`, apiUrl);
      url.searchParams.set('limit', String(limit));
      if (before !== undefined) url.searchParams.set('before', before);
      const res = await fetch(url, { headers: { authorization: `Bearer ${await auth.idToken()}` } });
      const { data } = await res.json();
      return { messages: data.messages, hasMore: data.hasMore };
    },
  },
});

await client.connect();
```

**Return `{ token, expiresInMs }`, never a bare string.** A bare string is legal
and disables proactive refresh entirely. After a bounded number of auth failures
the connection **suspends**, and an explicit `connect()` is the only way out — so
a dashboard whose `id_token` lapses overnight goes quietly and permanently dead
with nothing in the UI to say so. `expiresInMs` is **milliseconds**; the service
returns `expiresIn` in **seconds**, and the obvious hand-written adapter
typechecks and refreshes every 2.9 seconds forever.

Do not decode the JWT to find the expiry. This SDK refuses to decode tokens even
for `exp`; read the value from the auth library that issued it.

---

## 5. Open a conversation and render it

```ts
try {
  await client.open({ conversationId: sessionId });
} catch (error) {
  if (error instanceof ConversationJoinError) {
    error.reason; // 'refused' | 'timeout' | 'notSent' | 'noSnapshot'
    error.code;   // e.g. 'SESSION_NOT_FOUND', or null when determined locally
  }
}

client.subscribe((state) => {
  const row = state.conversations[sessionId]; // a complete, deeply frozen ChatState
  render(row.messages, row.session?.status, state.connectionState);
});

await client.sendMessage(sessionId, 'on my way'); // optimistic echo, then ack
```

Four things worth knowing:

- **`open()` resolving is a strong postcondition.** It means `session.join` was
  acked, the `session.updated` snapshot arrived, *and* page one of history
  loaded. Anything weaker and you could not send, because a send is addressed
  from `ChatState.session`.
- **`ChatState` is the element type, not the container.** One conversation
  projects to one complete, ordinary `ChatState`. `conversations` is
  `Record<sessionId, ChatState>`.
- **Name the conversation explicitly on every send.** There is no "current"
  conversation on this surface. Inferring one is how a message lands in the
  wrong thread.
- **Two fields are inert on a party row**, called out so nobody builds on them:
  `pastSessions` is always `[]`, and `connectionState` is the connection's,
  mirrored. `unreadCount` also does not move on an inbound message — it
  recomputes when a watermark commits, the same as on the customer surface.

`error.reason` exists because the four outcomes need four different responses.
`noSnapshot` in particular is **not** a timeout: the connection *is* joined
server-side and will keep receiving pushes; what is missing is only the snapshot.

---

## 6. History is injected, and `RestClient` cannot help you yet

Core makes no HTTP call of its own and touches no DOM, so `history` is required
at construction. The customer demo gets it in one line:

```ts
history: createHistorySource<ChatMessage>(rest)   // examples/demo
```

**A keyless panel cannot use that.** `RestClient` requires a `publishableKey`
and sends `X-Publishable-Key` on every request, and a staff console holds no
publishable key. This is a known gap with a written fix — the plan turns
`RestClientOptions` into a discriminated union with `party: true` — scheduled for
a later slice. Until then, write the ~30 lines in
[`src/admin-api.ts`](./src/admin-api.ts).

**Use the `/agent/…` route, not the `/chat/…` one.** `MessageHistorySource`'s own
doc names `GET /chat-services/api/v1/chat/sessions/{id}/messages`. That is the
**customer** route: chat-service guards it with the customer middleware plus
`requireSessionOwner`, where "owner" means the customer who started the session.
An admin `id_token` gets a 401 there every time. The staff route is:

```
GET /chat-services/api/v1/agent/sessions/{sessionId}/messages
```

guarded by `authenticateAgent` + `requireOwnedSession` — a dh-auth bearer whose
role maps to staff, and a session in that token's tenant. Same query contract,
same envelope. One behavioural difference: the customer route passes
`publicOnly: true` and the staff route does not, so **INTERNAL agent notes are
included**. Correct for a staff panel; a disclosure on a customer one.

Do not hand raw rows straight to core. They carry integer enums (`senderType: 1`),
call the session `chatSessionId`, call the type `messageType`, and bury
attachments in `metadata`. `projectHistoryRow` from `@dhaam-ccrm/rest` is the one
place that knows all four.

---

## 7. Backend prerequisites — bluntly

### Both flags, or nothing

```bash
WS_V2_ENABLED=true
WS_V2_STAFF_ENABLED=true     # NOT implied by the line above
```

`staffSurfaceEnabled()` is `WS_V2_ENABLED === 'true' && WS_V2_STAFF_ENABLED === 'true'`,
and absence means **off** — deliberately, so that turning the v2 socket on to
serve customer widgets never also opens a keyless staff handshake as a side
effect. `WS_V2_STAFF_ENABLED` is not in `.env.example`. Only the literal string
`true` counts.

With the flag off you get `AUTH_INVALID` + close 1008, which is the same thing a
bad token gets.

### Only four roles can connect today

The dh-auth `roleId` claim is mapped like this, and everything unmapped becomes
`roles: []`, which is refused at the door:

| roleId | role | connects? |
|---:|---|---|
| 1 | admin | yes |
| 5 | super_admin | yes |
| 6 | agent | yes |
| 66 | supervisor | yes |
| **2** | **merchant** | **no — `roles: []`** |
| **3** | **manager** | **no — `roles: []`** |
| 67 | visitor | no, deliberately (nothing enforces read-only yet) |

A merchant or manager token **verifies perfectly** and is still refused. That is
not a bug you can configure around: it is a mapping gap in the verifier, and it
is the single hard prerequisite for the merchant/manager surfaces this SDK
surface was designed for.

The refusal is deliberately indistinguishable from a bad token — a distinct
`STAFF_REQUIRED` code would tell an enumerating caller which accounts have staff
roles.

### Where a session id comes from

```
GET /chat-services/api/v1/agent/queue
Authorization: Bearer <id_token>
```

Scoped server-side from the **verified** role: admin / super_admin / supervisor
see the tenant's queue; a plain agent is pinned to their own assignments. The
`?tenantId=` parameter is a redundant echo, compared against the token and
discarded — there is nothing useful to pass. The panel's **List my queue**
button is this call.

Note the envelope differs from the history route's: rows are `data` itself, with
`hasMore` / `nextCursor` as siblings.

---

## 8. Troubleshooting

**`AUTH_INVALID`, and the message mentions a publishable key.**
It should not — this SDK rewrites it, because the server answers
`AUTH_INVALID` / `"Invalid publishable key"` for **three unrelated causes** on a
connection that sent no key at all. Check in this order; the wire cannot tell you
which it is:

1. `WS_V2_STAFF_ENABLED=true` on the server.
2. The token — expired, or from a different dh-auth deployment.
3. The role — see the table above.

If you *do* see the server's original text, you are branching on `message`
somewhere. Branch on `code`.

**A 60-second hang instead of an error.**
Use `127.0.0.1`, not `localhost`. On macOS an IPv6 `::1` listener wins name
resolution, and a server bound only to IPv4 gives you a timeout rather than a
refusal. This is not hypothetical — it is how you lose an hour.

**`connecting` forever, and nothing in the server log.**
Something is listening on that port and it is not chat-service. Check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/chat-services/health   # expect 200
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

A Next.js dev server on 3000 accepts the TCP connection, never upgrades, and
never answers. That looks exactly like a firewalled port.

Also note the WebSocket is on `APP_PORT` (3000), **not** `WS_PORT` (3001) —
3001 is the legacy v1 socket.io server.

**A 401 from `/agent/queue` or the history route.**
chat-service answers an identical `Invalid token` for a bad token, an expired one
**and** a non-staff role, on purpose. There is no way to tell them apart from the
response.

**The browser blocked the REST call.**
A CORS rejection and a dead host are indistinguishable to page JavaScript — both
surface as a `TypeError` with no status. The panel reports both as `status: 0`.

**`vitest` says `skipped` and you expected it to run.**
The integration tests are skip-guarded on env vars
(`CHATSDK_IT_WS_URL`, `CHATSDK_IT_API_URL`, `CHATSDK_IT_TOKEN`,
`CHATSDK_IT_SESSION_ID`). `skipped` means they never reached the process — check
you exported them in the *same* shell, and that your runner is not stripping
them. A skipped integration test is **not** a passing one.

**`Failed to resolve entry for package "@dhaam-ccrm/core"`.**
Run `pnpm -r build` from the repo root. Packages are consumed through their
`exports` field, which points at `dist/`.

---

## 9. Security notes for this example

- **The token is a runtime field.** It is held in memory, never written to
  `localStorage` (the URL fields are), never logged, and never sent anywhere but
  the two endpoints you type in. A bearer credential in `localStorage` outlives
  the tab and is readable by anything achieving script execution on the origin.
- **No key of any kind appears in this example**, and none could: this surface
  reads no publishable key, and a secret key (`dhk_…` / `dhsk_…`) throws
  `SecretKeyInClientError` on the customer surface rather than being sent. If you
  find yourself wanting to paste one here, you are on the wrong surface.
- **There is no token endpoint and no server-side credential.** The customer demo
  needs one because a publishable key must be paired with a token minted by a
  secret key that may never reach a browser. A staff panel needs neither: the
  operator already holds a dh-auth `id_token`. `server/serve.mjs` bundles and
  serves static files and does nothing else.
- **This is not a production console.** Serve over HTTPS and `wss://`, and get
  the token from your app's existing auth session rather than a textarea.
