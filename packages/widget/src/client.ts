// One `WidgetConfig` in, one live `ChatStore` out.
//
// This is the file that earns the widget its "drop-in" claim. examples/demo
// does the same assembly in ~140 lines that an integrator has to read,
// understand, and keep correct — the generic type arguments on the REST
// factories, the seconds-vs-milliseconds token conversion, the shared token
// cache between core and REST. None of that is interesting to someone who
// wants a chat bubble on their food-ordering page, so it lives here once.

import { createChatStore } from '@dhaam-ccrm/js';
import type { ChatStore } from '@dhaam-ccrm/js';
import type {
  AttachmentMetadata,
  ChatClientConfig,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  IdentitySync,
} from '@dhaam-ccrm/core';
import {
  MemoryStorageAdapter,
  createBrowserStorageAdapter,
  createChatClient,
} from '@dhaam-ccrm/core';
import {
  RestClient,
  createAttachmentUploader,
  createHistorySource,
  createIdentitySync,
  createSessionActions,
  createSessionSummarySource,
} from '@dhaam-ccrm/rest';

import { createTokenSource } from './auth.js';
import type { ResolvedConfig } from './config.js';

/**
 * Builds the client and wraps it in `@dhaam-ccrm/js`'s store.
 *
 * The store, not the raw client, because everything the UI below does is
 * "call me when this slice of state changes" — which is precisely the one job
 * `@dhaam-ccrm/js` exists to do, with per-subscription selector caching this
 * package would otherwise have had to write itself. `store.client` remains
 * reachable for the ~18 imperative operations (§6.2/§6.3).
 *
 * `rest` comes back alongside it because a couple of things the widget offers
 * are plain REST calls with no state to subscribe to — emailing a transcript
 * is the first. Handing the SAME client back, rather than letting a caller
 * build a second one, is what keeps them on one token source: a second
 * `RestClient` would mean a second `createTokenSource`, and therefore a
 * second mint of a token the widget already holds.
 */
export interface WidgetStore {
  readonly store: ChatStore;
  readonly rest: RestClient;
}

export function createWidgetStore(config: ResolvedConfig): WidgetStore {
  const { publishableKey, tokens } = createTokenSource(config);

  const rest = new RestClient({
    apiUrl: config.apiUrl,
    publishableKey,
    getAccessToken: tokens.getAccessToken,
  });

  // The one place the identify seam is bridged (CONTACT_IDENTIFY_CONTRACT.md
  // §3.3, AMENDED). The two return types differ ON PURPOSE: core's
  // `IdentitySync.sync` resolves to `void` because core has no use for the
  // receipt, while `createIdentitySync` resolves to it because discarding it
  // inside packages/rest would throw away the only signal a caller could log.
  //
  // The wrapper is not ceremony. `Promise<T>` is INVARIANT in `T`, so
  // `Promise<RestIdentityResult>` is not assignable to `Promise<void>` even
  // with zero drift between the two shapes — TypeScript's assignable-to-void
  // special case covers a bare `void` return, not a `Promise<void>` one. So
  // the receipt is awaited and dropped here, on the only side that can see
  // both types.
  //
  // Note what is NOT here: a try/catch. A rejection propagates to core, which
  // owns the retry and the give-up (it has the jitter and timer seams); a
  // `.catch(() => {})` at this line would silently disarm both.
  const syncer = createIdentitySync(rest);
  const identitySync: IdentitySync = {
    sync: async (p) => {
      await syncer.sync(p);
    },
  };

  const clientConfig: ChatClientConfig = {
    publishableKey,
    getToken: tokens.getToken,
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,

    // A page-embedded widget is always the customer side. An agent console is
    // a different product with a different token, and guessing wrong here
    // mislabels every optimistic echo the user sees.
    localSender: { senderId: config.identity.userId, senderType: 'CUSTOMER' },

    ...(config.target === undefined ? {} : { target: config.target }),
    ...(config.subject === undefined ? {} : { subject: config.subject }),

    // Identify, for a logged-in user only. A guest has a `userId` too, so
    // `profile` — and nothing else — is the discriminator.
    //
    // Spread, because `identityProfile: config.identity.profile` does not
    // compile under `exactOptionalPropertyTypes` (TS2375). So the real choice
    // is spread vs. one of the escapes from that error — a cast, a `!`, or
    // widening core's field — and each of those compiles while putting an
    // identity-shaped KEY holding `undefined` on every guest's config. Only
    // the spread makes `'identityProfile' in cfg === false` true for a guest.
    ...(config.identity.profile === undefined
      ? {}
      : { identityProfile: config.identity.profile, identitySync }),

    // Durable, not in-memory. Core's default is `MemoryStorageAdapter`, which
    // by its own doc "survives a network blip, not a reload" — and two things
    // the customer would call bugs depend on surviving exactly that:
    //
    //   1. The offline send queue (§9.1). A message typed with no signal is
    //      shown as queued and is then lost by refreshing the tab.
    //   2. Which conversation the customer is IN. `connection.hello` carries
    //      no session id and the server re-resolves the customer to whichever
    //      session is ACTIVE, so a customer reading a RESOLVED conversation
    //      comes back to a different one. Core records the choice under
    //      `chatsdk:<publishableKey>:selectedSession` and re-joins it on
    //      connect — but only if it has somewhere to write it.
    //
    // `?? new MemoryStorageAdapter()` is core's own documented fallback, not a
    // defensive flourish: `createBrowserStorageAdapter()` returns `null` when
    // site data is blocked (Safari private mode, a locked-down enterprise
    // profile), and a widget that threw there would take the host's page down
    // over a preference the visitor is entitled to.
    storage: createBrowserStorageAdapter() ?? new MemoryStorageAdapter(),

    // The explicit type arguments are load-bearing, not decoration: these
    // factories are generic over the wire shape and infer `unknown` without
    // them, which then fails to satisfy core's seam interfaces.
    history: createHistorySource<ChatMessage>(rest),
    uploader: createAttachmentUploader<AttachmentMetadata>(rest),
    sessionActions: createSessionActions<ChatSession>(rest),

    // What the session picker runs on. Without it `client.listSessions()`
    // throws `ChatClientConfigError` instead of returning a page, and the
    // widget would have a picker with nothing to put in it.
    //
    // `createSessionSummarySource` returns a structural, not nominal, match
    // for core's `SessionSummarySource` — it is generic over the row shape and
    // the explicit `<ChatSessionSummary>` is what makes the two line up,
    // exactly as for the three factories above.
    //
    // Note what is NOT here: any notion of "is this caller a guest".
    // `GET /chat/sessions/customer` answers a guest with `200 { sessions: [] }`
    // rather than a 403, so emptiness is the signal, and it is read once — at
    // the one place that decides whether to show a picker — rather than
    // re-derived here.
    sessionSummarySource: createSessionSummarySource<ChatSessionSummary>(rest),

    // §14: core promises this never receives credentials or message content,
    // so routing it to the host's error sink is safe. Only `warn`/`error` are
    // forwarded — `debug` on a customer's production page is noise they did
    // not ask for.
    logger: (level, message) => {
      if (level === 'warn' || level === 'error') config.onError(`[chat-sdk] ${message}`);
    },
  };

  return {
    store: createChatStore(createChatClient(clientConfig), { onError: config.onError }),
    rest,
  };
}
