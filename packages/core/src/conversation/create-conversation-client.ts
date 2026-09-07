// createConversationClient — the keyless (staff/party) front door.
//
// ── The one thing to know before reading ─────────────────────────────────
//
// This file adds a surface. It does not modify one. `create-chat-client.ts`,
// `ChatClientConfig`, `ChatState`, `switchSession`, `commitSession`,
// `perSessionReset`, `mount()` and `singleton.ts` are all untouched by the
// whole of this work, and that is a stronger guarantee than "the suite is
// green": the customer path is produced by literally the same bytes of source
// as before, so there is nothing for a regression to hide in.
//
// ── Zero lines of connection code change, and why that was checkable ─────
//
// Everything keyless already existed inside `ConnectionController`; nothing had
// ever constructed it that way. Verified on HEAD before writing a line here:
//
//   • `ConnectionControllerOptions.publishableKey` is already optional
//     (`connection/types.ts`), documented as "OMITTED for a STAFF connection".
//   • `#openSocket` already omits it by conditional spread rather than sending
//     `undefined` (`connection/controller.ts:489`) — which matters, because
//     under `exactOptionalPropertyTypes` those are different values and
//     `validate.ts` rejects `''` precisely so a blank key cannot become a
//     second route into the server's staff branch.
//   • `#customerAckViolation` already returns `null` when no key was sent
//     (`connection/controller.ts:650`), so a session-less `connection.ack` —
//     which is what the staff flow answers with — is admitted rather than
//     treated as a protocol violation.
//
// So this file constructs the existing engine with the argument omitted. That
// is the entire keyless mechanism.
//
// ── …and the same is true one layer up ───────────────────────────────────
//
// The two addressing decisions this surface had to make — what an OUTBOUND
// frame carries, and what happens to an INBOUND frame the wire cannot address —
// are stated in full in `addressing.ts`'s header. Read that file first; it is
// the only place either decision is made.
//
// The conversation runtime underneath (`runtime.ts`, `registry.ts`) reuses the
// SHIPPED `MessageController`, `PresenceCoordinator` and `SendQueue`
// unmodified, each over a `ChatStore` of the conversation's own. So this whole
// surface still edits ZERO existing runtime files: `git diff` over
// `client/`, `connection/`, `messages/`, `presence/`, `queue/`, `state/` and
// `widget/` is empty, which is a stronger statement than "the suite is green".

import { parsePublishableKey } from '../auth/index.js';
import { ConnectionController, ConnectionSuspendedError } from '../connection/index.js';
import type { TransportFactory } from '../connection/index.js';
import { ChatClientConfigError } from '../client/index.js';
import type { LocalSender, SendMessageOptions } from '../messages/index.js';
import { ChatStore } from '../state/index.js';
import type { ChatError, ChatState, Unsubscribe } from '../state/index.js';
import { WebSocketTransport } from '../transport/index.js';
import type { TransportLogger } from '../transport/index.js';
import { describeConnectionError } from './errors.js';
import { ConversationRegistry } from './registry.js';
import type { ConversationClient, ConversationClientConfig, ConversationsState } from './types.js';

/** Resolves `config.localSender` to a plain `() => LocalSender`, whether given as an object or a thunk. */
function normalizeLocalSender(input: LocalSender | (() => LocalSender)): () => LocalSender {
  return typeof input === 'function' ? input : () => input;
}

/** Adapts the public logger callback to the transport's single-method logger. */
function adaptLogger(logger: ConversationClientConfig['logger']): TransportLogger | undefined {
  if (logger === undefined) return undefined;
  return {
    warn(message, context) {
      logger('warn', message, context);
    },
  };
}

export function createConversationClient(config: ConversationClientConfig): ConversationClient {
  // -------------------------------------------------------------------------
  // 1. Validate. Loud at construction, for the same reason `createChatClient`
  //    is: a client that silently never connects is the worst outcome here.
  // -------------------------------------------------------------------------
  if (config.wsUrl === undefined || config.wsUrl === '') {
    throw new ChatClientConfigError(
      'wsUrl is required: core has no legitimate default WebSocket endpoint to fall back to. ' +
        'Pass ConversationClientConfig.wsUrl explicitly.',
    );
  }

  // `parsePublishableKey` runs for every value that is not `undefined`. It is
  // not a format check but the sk_-never-reaches-the-browser guard, and it is
  // ordered so the security finding wins over the format one. `undefined` is
  // the signal for "keyless" and is the ONLY way to reach the staff flow —
  // `''` throws here rather than becoming a second, quieter route to it.
  const publishableKey =
    config.publishableKey === undefined ? undefined : parsePublishableKey(config.publishableKey);

  // Resolved eagerly, exactly as `createChatClient` resolves its own: a thunk
  // that needs data only available after `connect()` is a bug, and finding it
  // now beats finding it at first send.
  const localSender = normalizeLocalSender(config.localSender)();
  if (typeof localSender.senderId !== 'string' || localSender.senderId === '') {
    // Stricter than the customer path deliberately, and safely: this is a new
    // surface with no installed base, so refusing an empty id costs nobody a
    // migration. It buys the storage keyspace a later slice adds — an empty
    // segment encodes to `'_'`, which collides with a literal `'_'`.
    throw new ChatClientConfigError(
      'localSender.senderId must be a non-empty string: it identifies the local participant ' +
        'and becomes a storage namespace segment, where an empty value is not distinguishable ' +
        'from a literal "_".',
    );
  }

  // -------------------------------------------------------------------------
  // 2. The store. Reused as-is: `ConnectionController` writes exactly two of
  //    its fields (`connectionState` and `lastError`) and nothing here needs
  //    the other ten. Projected — never handed out — so no consumer of this
  //    surface can come to depend on `ChatState`'s customer-shaped fields.
  // -------------------------------------------------------------------------
  const store = new ChatStore();

  const transportLogger = adaptLogger(config.logger);

  // Forward-declared, and assigned synchronously from inside
  // `new ConnectionController` below — the same pattern `createChatClient`
  // uses, for the same reason. The transport is constructed here rather than
  // through `createWebSocketTransportFactory` because two of its callers need
  // the concrete class: the send queue replays a frame under its ORIGINAL
  // envelope id (`send(t, d, replayId)`, D1/§9.3), and `QueueTransport.isOpen`
  // reads the live socket. Neither is on the narrow `ConnectionTransport`
  // interface the controller depends on.
  let realTransport!: WebSocketTransport;
  let registry!: ConversationRegistry;

  const createTransport: TransportFactory = (handlers) => {
    realTransport = new WebSocketTransport({
      ...(config.webSocketFactory === undefined ? {} : { webSocket: config.webSocketFactory }),
      ...(config.now === undefined ? {} : { now: config.now }),
      ...(config.schedule === undefined ? {} : { schedule: config.schedule }),
      ...(transportLogger === undefined ? {} : { logger: transportLogger }),
      ...(config.protocolVersion === undefined ? {} : { protocolVersion: config.protocolVersion }),
      ...handlers,
    });
    return realTransport;
  };

  const connection = new ConnectionController({
    store,
    url: config.wsUrl,
    // THE line. Omitted entirely when there is no key, never passed as
    // `undefined` — under `exactOptionalPropertyTypes` those are different,
    // and `#openSocket` spreads on `=== undefined`, so an explicit `undefined`
    // would still be omitted from the hello but would read here as though a
    // key had been considered and rejected. Say what is meant.
    ...(publishableKey === undefined ? {} : { publishableKey }),
    getToken: config.getToken,
    createTransport,
    // Read lazily: `registry` is assigned on the next statement, and no frame
    // can arrive before `connect()`, which is a caller's own later act.
    onFrame: (frame) => {
      registry.route(frame);
    },
    ...(config.schedule === undefined ? {} : { schedule: config.schedule }),
  });

  registry = new ConversationRegistry({
    store,
    transport: () => realTransport,
    localSender,
    history: config.history,
    ...(config.pageSize === undefined ? {} : { pageSize: config.pageSize }),
    ...(config.schedule === undefined ? {} : { schedule: config.schedule }),
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.logger === undefined ? {} : { logger: config.logger }),
  });

  // -------------------------------------------------------------------------
  // 3. The projection.
  //
  //    Cached, and recomputed only when one of the two fields it reads has
  //    actually changed, so `getState()` is stable by reference — the
  //    contract `useSyncExternalStore` needs and the reason bindings can use
  //    it directly without an equality function.
  // -------------------------------------------------------------------------
  const keyed = publishableKey !== undefined;

  let cached: ConversationsState = Object.freeze({
    connectionState: store.getState().connectionState,
    conversations: registry.conversations(),
    lastError: null,
  });

  /** The `ChatState.lastError` the cached projection was built from. */
  let cachedFrom: ChatError | null = store.getState().lastError;

  function project(): ConversationsState {
    const state = store.getState();
    // Already reference-stable: the registry rebuilds this map only when a row
    // it holds actually changed, so comparing it is a pointer compare and not a
    // walk. See `ConversationRegistry.conversations`.
    const conversations = registry.conversations();

    // Reference equality is the right test on `lastError`: `ChatState.lastError`
    // is replaced wholesale on every report and never mutated, and
    // `describeConnectionError` is a pure function of it — so an unchanged
    // reference in means an unchanged value out.
    if (
      cached.connectionState === state.connectionState &&
      cachedFrom === state.lastError &&
      cached.conversations === conversations
    ) {
      return cached;
    }

    cachedFrom = state.lastError;
    cached = Object.freeze({
      connectionState: state.connectionState,
      conversations,
      lastError:
        state.lastError === null ? null : describeConnectionError(state.lastError, keyed),
    });
    return cached;
  }

  // -------------------------------------------------------------------------
  // 4. The client.
  // -------------------------------------------------------------------------
  return {
    getState: project,

    subscribe(listener: (state: ConversationsState) => void): Unsubscribe {
      // `last` is PER SUBSCRIPTION, deliberately — not the module-shared
      // `cached`. Comparing against `cached` looks equivalent and is not: the
      // store notifies subscribers in turn, and the FIRST callback's `project()`
      // already advanced `cached`. Every later subscriber then read
      // `before === next` and was silently skipped, so only one listener per
      // client ever woke — which breaks the `useSyncExternalStore` contract this
      // projection exists to satisfy the moment a second component mounts.
      //
      // Reference stability is unaffected: `project()` still returns the one
      // shared frozen object, stable until it genuinely changes. Each
      // subscription only keeps its own record of which one it last saw.
      let last = project();
      const wake = (): void => {
        const next = project();
        // Both sources notify on any change; this surface exposes a projection
        // of them. A change to nothing it projects is not a change here, and
        // waking every subscriber for it would break the reference-stability
        // this projection exists to provide. It is also what makes the two
        // registrations below safe: whichever fires second sees `next === last`
        // and stays quiet.
        if (next !== last) {
          last = next;
          listener(next);
        }
      };

      // TWO sources, because the state has two halves that change
      // independently: the connection store carries `connectionState` and
      // `lastError`, and the registry carries the conversation rows, each of
      // which is a store of its own.
      const offStore = store.subscribe(wake);
      const offRegistry = registry.onChange(wake);
      return () => {
        offStore();
        offRegistry();
      };
    },

    // `connect()` is wrapped, and `disconnect`/`retryNow` are not, because only
    // this one rejects with a `ConnectionSuspendedError` whose `message` was
    // built by `ConnectionController` as
    // `Connection suspended (${reason}): ${cause.message}` — interpolating the
    // SERVER's text. On a keyless connection that text is "Invalid publishable
    // key", which `describeConnectionError` exists to drop precisely because it
    // is false here: no key was sent.
    //
    // Scrubbing only `state.lastError` left the leak open on the primary drive
    // path, since `await client.connect()` in a try/catch is what the documented
    // API tells a host to write. So the rejection is rebuilt around the scrubbed
    // cause. `reason`, `code`, `source` and `retryable` are the structured facts
    // and pass through untouched; only the human-readable text changes.
    //
    // The controller is NOT edited to fix this — `packages/core/src/connection/`
    // is on the shipped customer path and must stay byte-identical.
    connect: async () => {
      try {
        await connection.connect();
      } catch (error) {
        if (error instanceof ConnectionSuspendedError) {
          throw new ConnectionSuspendedError(
            error.reason,
            describeConnectionError(error.cause, keyed),
          );
        }
        throw error;
      }
    },
    disconnect: () => {
      // `disconnected` is emitted only for a transport-caused drop — the
      // controller discards `cause: 'local'` before emitting it — so the
      // registry has to be told about a deliberate one directly, or typing and
      // presence learned over the socket that just went would linger.
      registry.handleLocalDisconnect();
      connection.disconnect();
    },
    retryNow: () => connection.retryNow(),

    open: (target) => registry.open(target.conversationId),

    sendMessage: (conversationId: string, content: string, options?: SendMessageOptions) =>
      registry.sendMessage(conversationId, content, options ?? {}),
  };
}
