// The panel. Plain TypeScript over the DOM — no framework, on purpose: every
// line between "the operator pressed Connect" and "a message appeared" is
// visible in one file.
//
// ── The one idea worth taking away ───────────────────────────────────────
//
// There is no `mode: 'staff'` flag anywhere below. The config object simply has
// no `publishableKey` property, and that ABSENCE is what selects chat-service's
// staff flow — the server branches on `conn.staffSurface`, set by the keyless
// hello (handlers.ts:1198). `''` is not a second route to it: the SDK throws.
// A secret key throws `SecretKeyInClientError` before any formatting check.
//
// Consequently there is NO server process in this example, and no
// `POST /api/token` route like the customer demo has. A customer widget needs
// one because a publishable key must be paired with a token minted by a SECRET
// key that may never reach a browser. A staff panel needs neither key: the
// operator already holds a dh-auth `id_token`, and it goes straight into the
// field. The server file next door does nothing but bundle and serve static
// files.

import {
  ConnectionSuspendedError,
  ConversationJoinError,
  ConversationNotOpenError,
  createConversationClient,
} from '@dhaam-ccrm/core';
import type {
  ChatMessage,
  ChatState,
  ConversationClient,
  ConversationsState,
} from '@dhaam-ccrm/core';

import { AdminApiError, createAdminHistorySource, listQueue } from './admin-api.js';
import type { AdminApiOptions } from './admin-api.js';

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the page is missing #${id}`);
  return node as T;
}

const ui = {
  form: el<HTMLFormElement>('connect-form'),
  wsUrl: el<HTMLInputElement>('wsUrl'),
  apiUrl: el<HTMLInputElement>('apiUrl'),
  token: el<HTMLTextAreaElement>('token'),
  senderId: el<HTMLInputElement>('senderId'),
  connect: el<HTMLButtonElement>('connect'),
  disconnect: el<HTMLButtonElement>('disconnect'),
  retry: el<HTMLButtonElement>('retry'),
  state: el<HTMLElement>('state'),
  error: el<HTMLElement>('error'),
  sessionId: el<HTMLInputElement>('sessionId'),
  open: el<HTMLButtonElement>('open'),
  find: el<HTMLButtonElement>('find'),
  queue: el<HTMLElement>('queue'),
  sessStatus: el<HTMLElement>('sess-status'),
  sessMode: el<HTMLElement>('sess-mode'),
  sessLoaded: el<HTMLElement>('sess-loaded'),
  sessCount: el<HTMLElement>('sess-count'),
  messages: el<HTMLOListElement>('messages'),
  composeForm: el<HTMLFormElement>('compose-form'),
  compose: el<HTMLInputElement>('compose'),
  send: el<HTMLButtonElement>('send'),
  log: el<HTMLOListElement>('log'),
  stubBanner: el<HTMLElement>('stub-banner'),
};

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

function log(level: 'panel' | 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const line = document.createElement('li');
  const tag = document.createElement('span');
  tag.className = `lvl lvl-${level}`;
  tag.textContent = level;
  line.append(tag, document.createTextNode(` ${message}`));
  if (meta !== undefined && meta !== null && Object.keys(meta as object).length > 0) {
    line.append(document.createTextNode(` ${JSON.stringify(meta)}`));
  }
  ui.log.prepend(line);
  while (ui.log.childElementCount > 300) ui.log.lastElementChild?.remove();
}

// ---------------------------------------------------------------------------
// Field persistence — everything EXCEPT the token
// ---------------------------------------------------------------------------
//
// The three URL/id fields are restored across reloads because retyping them is
// pure friction. The token is deliberately not: a bearer credential in
// `localStorage` outlives the tab, is readable by anything that achieves script
// execution on this origin, and this page has no reason to keep one.

const REMEMBERED = ['wsUrl', 'apiUrl', 'senderId', 'sessionId'] as const;
const STORAGE_KEY = 'dhaam.adminPanelExample.fields';

function restoreFields(): void {
  const preset = window.__PANEL_CONFIG__;
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    // A private window, or cleared site data. Not worth a word to the operator.
  }
  for (const name of REMEMBERED) {
    const field = ui[name];
    const value = saved[name];
    if (typeof value === 'string' && value !== '') field.value = value;
  }
  // A preset from the server wins over a remembered value: it is what this
  // process is actually serving, which the remembered one may no longer be.
  if (preset?.wsUrl !== undefined && preset.wsUrl !== '') ui.wsUrl.value = preset.wsUrl;
  if (preset?.apiUrl !== undefined && preset.apiUrl !== '') ui.apiUrl.value = preset.apiUrl;
  if (ui.senderId.value === '') ui.senderId.value = 'admin_panel_demo';
}

function rememberFields(): void {
  const payload: Record<string, string> = {};
  for (const name of REMEMBERED) payload[name] = ui[name].value.trim();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Same as above.
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderConnection(state: ConversationsState): void {
  ui.state.textContent = state.connectionState;
  ui.state.className = `state-${state.connectionState}`;

  const live = state.connectionState === 'connected';
  ui.disconnect.disabled = state.connectionState === 'idle' || state.connectionState === 'closed';
  ui.retry.disabled = state.connectionState !== 'reconnecting';
  ui.open.disabled = !live;
  ui.find.disabled = !live && state.connectionState !== 'idle' && state.connectionState !== 'closed';

  if (state.lastError === null) {
    ui.error.hidden = true;
    return;
  }

  // `code` is the fact to branch on; `message` is human-readable and is never
  // a branch target. On a keyless connection the SDK has ALREADY replaced the
  // server's own text — the server answers AUTH_INVALID / "Invalid publishable
  // key" for three unrelated causes on a connection that sent no key, so
  // passing that through would send you hunting for a key you never had.
  const lines = [`${state.lastError.code ?? state.lastError.source}: ${state.lastError.message}`];
  if (state.lastError.code === 'AUTH_INVALID') {
    lines.push(
      '',
      'Check them in this order — the wire cannot tell you which one it is:',
      '  1. WS_V2_STAFF_ENABLED=true on the server (WS_V2_ENABLED alone is not enough).',
      '  2. The id_token: expired, or from a different dh-auth deployment.',
      '  3. The role: only roleId 1 (admin), 5 (super_admin), 6 (agent) and 66 (supervisor)',
      '     are staff. A merchant (2) or manager (3) verifies fine and is still refused.',
    );
  }
  ui.error.textContent = lines.join('\n');
  ui.error.hidden = false;
}

function renderMessage(message: ChatMessage): HTMLLIElement {
  const item = document.createElement('li');

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = `${message.senderType} `;
  item.append(who, document.createTextNode(message.content));

  // Absent `delivery` means the server confirmed it. `seq` is the server's
  // ordering key and is absent until then — one fact, one field, no invented
  // `pending` flag.
  if (message.delivery !== undefined) {
    const badge = document.createElement('span');
    badge.className = 'pending';
    badge.textContent = ` — ${message.delivery.state}`;
    item.append(badge);
  }
  return item;
}

function renderConversation(row: ChatState | undefined): void {
  if (row === undefined) {
    ui.sessStatus.textContent = '—';
    ui.sessMode.textContent = '—';
    ui.sessLoaded.textContent = '—';
    ui.sessCount.textContent = '0';
    ui.messages.replaceChildren();
    ui.compose.disabled = true;
    ui.send.disabled = true;
    return;
  }

  ui.sessStatus.textContent = row.session?.status ?? '(no snapshot)';
  ui.sessMode.textContent = row.session?.mode ?? '—';
  ui.sessLoaded.textContent = String(row.pagination.initialLoaded);
  ui.sessCount.textContent = String(row.messages.length);

  if (row.messages.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No messages in this conversation yet.';
    ui.messages.replaceChildren(empty);
  } else {
    ui.messages.replaceChildren(...row.messages.map(renderMessage));
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  const sendable = row.session !== null;
  ui.compose.disabled = !sendable;
  ui.send.disabled = !sendable;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let client: ConversationClient | null = null;
let unsubscribe: (() => void) | null = null;
let openedId: string | null = null;

/** The token, read live from the field so a re-paste is picked up without a rebuild. */
function currentToken(): string {
  return ui.token.value.trim();
}

function buildClient(): ConversationClient {
  const apiOptions: AdminApiOptions = {
    apiUrl: ui.apiUrl.value.trim(),
    getToken: currentToken,
  };

  return createConversationClient({
    wsUrl: ui.wsUrl.value.trim(),

    // ── NOT A LINE OF CODE, AND THAT IS THE POINT ────────────────────────
    // `publishableKey` is absent. Not `undefined`, not `''` — absent. Adding
    // it here would put this connection on the server's CUSTOMER flow, where
    // sessions EVICT on join instead of accumulating.
    //
    // Nothing that looks like `dhpk_…`, `dhk_…` or `dhsk_…` appears anywhere in
    // this example, and a secret key never could: `parsePublishableKey` throws
    // `SecretKeyInClientError` on one, and this surface does not read the field
    // at all.

    // `{ token, expiresInMs }`, never a bare string. A bare string disables
    // proactive refresh entirely, and after a bounded number of auth failures
    // the connection SUSPENDS — from which an explicit `connect()` is the only
    // exit. A dashboard whose id_token lapses then goes quietly, permanently
    // dead with no error anyone sees.
    //
    // This page does NOT decode the JWT to find the real expiry — the SDK
    // refuses to decode tokens even for `exp`, and a page that does it anyway
    // is a page that has to be right about `nbf`, clock skew and the algorithm.
    // A real host reads `msUntilExpiry()` from the auth library that issued the
    // token. Five minutes here is a deliberately short stand-in: it makes the
    // proactive-refresh path (a `connection.reauth` at 80% of the window)
    // observable in the log during a short session, instead of theoretical.
    getToken: async () => ({ token: currentToken(), expiresInMs: 5 * 60 * 1000 }),

    // A local-echo hint only — the server derives the real sender from the
    // token — but required, and correctly so: a session carries both a customer
    // and an agent, so nothing else here says which one this browser is.
    localSender: { senderId: ui.senderId.value.trim(), senderType: 'AGENT' },

    // The injected history seam. Core makes no HTTP call of its own and touches
    // no DOM; this page owns the client, the headers and the retry policy.
    history: createAdminHistorySource(apiOptions),

    pageSize: 20,

    // Documented never to receive credential material or message content.
    logger: (level, message, meta) => log(level, message, meta),
  });
}

function teardown(): void {
  unsubscribe?.();
  unsubscribe = null;
  client?.disconnect();
  client = null;
  openedId = null;
  renderConversation(undefined);
}

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  rememberFields();

  if (currentToken() === '') {
    log('error', 'paste a dh-auth id_token first — this surface has no other credential');
    return;
  }

  teardown();
  ui.connect.disabled = true;

  try {
    client = buildClient();
  } catch (error) {
    // Construction throws for a bad wsUrl or an empty senderId. Loud here, on
    // purpose: a client that silently never connects is the worse outcome.
    ui.connect.disabled = false;
    log('error', `could not build the client: ${(error as Error).message}`);
    return;
  }

  const live = client;
  unsubscribe = live.subscribe((state) => {
    renderConnection(state);
    renderConversation(openedId === null ? undefined : state.conversations[openedId]);
  });
  renderConnection(live.getState());

  log('panel', 'connecting — keyless hello, no publishable key on the wire');
  live
    .connect()
    .then(() => {
      log('panel', 'connected: the server accepted the keyless hello and returned a session-less ack');
    })
    .catch((error: unknown) => {
      if (error instanceof ConnectionSuspendedError) {
        // The rejection carries a SCRUBBED cause: the controller builds its
        // message by interpolating the server's text, which on this surface is
        // the false "Invalid publishable key". The conversation client rebuilds
        // the error around the corrected one.
        log('error', `suspended (${error.reason}) — an explicit Connect is the only way out`);
        return;
      }
      log('error', `connect failed: ${(error as Error).message}`);
    })
    .finally(() => {
      ui.connect.disabled = false;
    });
});

ui.disconnect.addEventListener('click', () => {
  log('panel', 'disconnect — user-initiated and terminal; only an explicit Connect revives it');
  teardown();
  ui.state.textContent = 'closed';
  ui.state.className = 'state-closed';
  ui.open.disabled = true;
  ui.disconnect.disabled = true;
});

ui.retry.addEventListener('click', () => {
  const started = client?.retryNow() ?? false;
  log('panel', started ? 'retrying now, from attempt 0' : 'retryNow() returned false (not reconnecting)');
});

ui.open.addEventListener('click', () => {
  const live = client;
  const conversationId = ui.sessionId.value.trim();
  if (live === null || conversationId === '') return;
  rememberFields();

  ui.open.disabled = true;
  log('panel', `open({ conversationId: "${conversationId}" }) — join, snapshot, then page one`);

  live
    .open({ conversationId })
    .then(() => {
      openedId = conversationId;
      // On resolution the row is guaranteed usable: snapshot applied and page
      // one landed. Anything weaker and a caller cannot send, because a send is
      // addressed from `ChatState.session`.
      renderConversation(live.getState().conversations[conversationId]);
      log('panel', 'open resolved: snapshot applied, page one loaded, sends will work');
    })
    .catch((error: unknown) => {
      if (error instanceof ConversationJoinError) {
        // Four outcomes, four different fixes — which is exactly why this is a
        // typed reason and not a string.
        const advice: Record<string, string> = {
          refused: 'the server said no. `code` is the fact; SESSION_NOT_FOUND covers both "no such session" AND "another tenant\'s session", deliberately indistinguishably.',
          timeout: 'nothing answered in time. The join may or may not have landed.',
          notSent: 'there was no open socket. Connect first.',
          noSnapshot: 'the join WAS accepted, but no session.updated followed. This connection IS joined; what is missing is the snapshot a send needs.',
        };
        log('error', `open failed (${error.reason}${error.code === null ? '' : `, ${error.code}`}): ${advice[error.reason] ?? ''}`);
      } else {
        log('error', `open failed: ${(error as Error).message}`);
      }
    })
    .finally(() => {
      ui.open.disabled = client === null;
    });
});

ui.composeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const live = client;
  const content = ui.compose.value;
  if (live === null || openedId === null || content.trim() === '') return;

  ui.compose.value = '';
  // The optimistic echo lands on the row synchronously, carrying
  // `delivery: { state: 'queued' }`, and clears when the server acks. The
  // conversation is named explicitly — this surface has no "current" one, and
  // inferring one is how a message lands in the wrong thread.
  live.sendMessage(openedId, content).catch((error: unknown) => {
    if (error instanceof ConversationNotOpenError) {
      log('error', `not open: ${error.conversationId} — call open() and await it first`);
      return;
    }
    log('error', `send failed: ${(error as Error).message}`);
  });
});

ui.find.addEventListener('click', () => {
  const options: AdminApiOptions = { apiUrl: ui.apiUrl.value.trim(), getToken: currentToken };
  if (currentToken() === '') {
    log('error', 'paste an id_token first — GET /agent/queue is authenticated');
    return;
  }

  ui.find.disabled = true;
  log('panel', 'GET /agent/queue — this is REST, not the socket; it works before Connect');

  listQueue(options)
    .then((rows) => {
      ui.queue.replaceChildren();
      if (rows.length === 0) {
        ui.queue.textContent = 'No open sessions visible to this token.';
      } else {
        for (const row of rows) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `${row.sessionId} · ${row.status}${row.customerName === null ? '' : ` · ${row.customerName}`}`;
          button.addEventListener('click', () => {
            ui.sessionId.value = row.sessionId;
            rememberFields();
          });
          ui.queue.append(button);
        }
      }
      ui.queue.hidden = false;
      log('panel', `queue returned ${rows.length} session(s)`);
    })
    .catch((error: unknown) => {
      if (error instanceof AdminApiError) {
        const hint =
          error.status === 401
            ? ' — chat-service answers an identical "Invalid token" for a bad token, an expired one AND a non-staff role, on purpose'
            : error.status === 0
              ? ' — the origin is unreachable, or the browser blocked it by CORS'
              : '';
        log('error', `queue lookup failed: ${error.message}${hint}`);
        return;
      }
      log('error', `queue lookup failed: ${(error as Error).message}`);
    })
    .finally(() => {
      ui.find.disabled = false;
    });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __PANEL_CONFIG__?: { readonly wsUrl?: string; readonly apiUrl?: string; readonly stub?: string };
  }
}

restoreFields();

const stubNote = window.__PANEL_CONFIG__?.stub;
if (typeof stubNote === 'string' && stubNote !== '') {
  ui.stubBanner.textContent = stubNote;
  ui.stubBanner.hidden = false;
  ui.token.value = 'stub-accepts-any-non-empty-token';
}

log('panel', 'ready — no publishable key will be sent; absence is what selects the staff flow');
