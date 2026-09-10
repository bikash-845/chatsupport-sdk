// createChatStore — the whole of this binding's reactivity mapping.
//
// ---------------------------------------------------------------------------
// What replaces a re-render
// ---------------------------------------------------------------------------
//
// React maps core's store onto `useSyncExternalStore`; Vue onto refs; Angular
// onto signals. There is no framework here, so the notification primitive is
// the smallest thing that every one of those could itself be built on: a
// plain callback, invoked synchronously, returning an idempotent unsubscribe.
//
// Not an `EventTarget`: it would box every payload in a `CustomEvent`
// (allocation per notification, `detail` typed as `any`), it is a DOM-family
// global this package has deliberately excluded (tsconfig.json drops `DOM`
// precisely so SSR/Node imports stay provable rather than aspirational), and
// it offers no place to hang per-subscriber selector caching — which is the
// one job this file actually has. Not a custom Observable either: an
// Observable's value is its subscription protocol, and a widget that wants
// one can wrap a callback in three lines, whereas a widget that does not want
// one cannot unship it.
//
// ---------------------------------------------------------------------------
// Why selector caching is per subscription, not per store
// ---------------------------------------------------------------------------
//
// §6.4 assigns field-level diffing to bindings: "core only guarantees the
// full, consistent snapshot is available on every notification; it does not
// do field-level diffing itself." So every subscription keeps `{raw,
// selected}` — the last `ChatState` it saw and the value it derived from it.
// Two cheap gates follow, in order:
//
//   1. `raw === state` — core keeps `getState()` reference-identical while
//      nothing changed, so an unchanged snapshot skips the selector entirely.
//   2. `isEqual(selected, next)` — a composite selector builds a new object
//      every call by construction; without this gate every subscriber fires
//      on every state change, which is the exact failure this package exists
//      to prevent. On a miss the OLD reference is kept, so a downstream
//      identity check (a framework's, or a widget's own `if (next === prev)`)
//      also sees "unchanged".
//
// ---------------------------------------------------------------------------
// Thin means thin
// ---------------------------------------------------------------------------
//
// No reconnect, backoff, dedup, ordering, queueing, token refresh, watermark
// or tick logic lives here. All of it is core's, tested there. `messages` is
// passed through in the order core hands it over — never re-sorted — and the
// tick comes from core's `deriveTickStateFromState`, never from a local
// reimplementation.

import { deriveTickStateFromState } from '@dhaam-ccrm/core';
import type {
  ChatClient,
  ChatEventHandler,
  ChatEventMap,
  ChatEventName,
  ChatState,
  MessageTickState,
  Unsubscribe,
} from '@dhaam-ccrm/core';

import { strictEqual } from './equality.js';
import type {
  ChatStore,
  ChatStoreOptions,
  DestroyOptions,
  SelectOptions,
  StateListener,
  SubscribeOptions,
} from './types.js';

/**
 * One live selector subscription. Generics are erased here on purpose: the
 * store holds a heterogeneous `Set` of these, and re-introducing `T` would
 * buy nothing a cast at the two registration sites does not already give.
 */
interface Selection {
  readonly selector: (state: ChatState) => unknown;
  readonly isEqual: (a: unknown, b: unknown) => boolean;
  readonly listener: (value: unknown, previous: unknown) => void;
  /** The last snapshot this subscription evaluated. Gate 1 above. */
  raw: ChatState;
  /** The value it derived. Held as the previous reference for gate 2 and for `StateListener`'s `previous`. */
  selected: unknown;
}

function defaultOnError(error: unknown): void {
  // Reported rather than rethrown: rethrowing here would land inside core's
  // own listener loop (which isolates and discards it) or, if queued to a
  // macrotask, become an uncaught exception that takes the host page down for
  // one broken selector. Silence is the only worse option — a subscription
  // that has quietly stopped updating is the single hardest widget bug to
  // diagnose, which is why this defaults to loud instead of off.
  //
  // `globalThis.console` rather than a bare `console` reference: this package
  // deliberately excludes the DOM lib (see tsconfig.json), which is what
  // puts `console` in scope for TS. `globalThis` IS in ES2020, and both
  // browsers and Node expose `console` on it, so this is equivalent at
  // runtime while satisfying the stricter lib constraint at compile time.
  const con = (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console;
  if (con !== undefined && typeof con.error === 'function') {
    con.error(
      '[@dhaam-ccrm/js] a subscriber threw; every other subscriber is unaffected and this one ' +
        'will recover on the next snapshot. Pass createChatStore(client, { onError }) to handle it yourself.',
      error,
    );
  }
}

/**
 * Wraps one `ChatClient` in the store described by {@link ChatStore}.
 *
 * Takes a built client rather than a `ChatClientConfig` so that a consumer
 * who already has one does not drag `createChatClient` (and core's whole
 * client assembly behind it) into their bundle. See `createChat` in
 * create.ts for the one-call convenience that does accept a config — kept in
 * its own module so bundlers can drop it, and core's factory with it, when it
 * is unused.
 */
export function createChatStore(client: ChatClient, options?: ChatStoreOptions): ChatStore {
  const onError = options?.onError ?? defaultOnError;

  const selections = new Set<Selection>();
  /** Every teardown this store owns — selector subscriptions and event handlers alike. */
  const disposers = new Set<() => void>();
  let destroyed = false;

  function report(error: unknown): void {
    try {
      onError(error);
    } catch {
      // A broken error handler must not become the thing that breaks the
      // fan-out. There is nowhere left to report to at this point.
    }
  }

  function assertLive(method: string): void {
    if (destroyed) {
      throw new Error(`[@dhaam-ccrm/js] ${method}() was called on a destroyed store. Create a new one with createChatStore().`);
    }
  }

  /**
   * Registers `dispose` for {@link ChatStore.destroy} and hands back an
   * idempotent caller-facing version of it. Every unsubscribe this package
   * returns goes through here, which is what makes "unsubscribe twice, then
   * destroy" a no-op rather than a double-decrement.
   */
  function track(dispose: () => void): Unsubscribe {
    let done = false;
    const wrapped = (): void => {
      if (done) return;
      done = true;
      disposers.delete(wrapped);
      dispose();
    };
    disposers.add(wrapped);
    return wrapped;
  }

  /**
   * One `client.subscribe` for the whole store, fanned out here. Cheaper than
   * one core-level subscription per selector, and — more importantly — it is
   * what puts the try/catch below on OUR side of the boundary, so a throwing
   * selector is reported to `onError` instead of being silently swallowed by
   * core's own listener isolation.
   */
  const unsubscribeFromClient = client.subscribe((state) => {
    // Snapshot the set: a listener is allowed to subscribe or unsubscribe
    // (including to destroy the store) from inside its own notification.
    for (const selection of [...selections]) {
      if (!selections.has(selection)) continue;
      if (selection.raw === state) continue;

      try {
        const next = selection.selector(state);
        selection.raw = state;
        if (selection.isEqual(selection.selected, next)) continue;

        const previous = selection.selected;
        selection.selected = next;
        selection.listener(next, previous);
      } catch (error) {
        // Contained to this subscription: reported, and the loop moves on to
        // the next sibling. The subscription is NOT torn down — a selector
        // that throws for one particular snapshot is a bug in the selector,
        // not a reason to stop delivering the snapshots it can handle — so it
        // is re-evaluated normally on the next notification.
        //
        // (`raw`/`selected` are only advanced after the call that produces
        // them succeeds. Given core's contract — a fresh snapshot reference on
        // every notification — that ordering is unobservable rather than
        // load-bearing; it is kept because committing a cache entry for a
        // computation that did not finish is the wrong shape regardless.)
        report(error);
      }
    }
  });

  function select<T>(
    selector: (state: ChatState) => T,
    listener: StateListener<T>,
    selectOptions?: SelectOptions<T>,
  ): Unsubscribe {
    assertLive('select');

    const raw = client.getState();
    const selection: Selection = {
      selector: selector as (state: ChatState) => unknown,
      isEqual: (selectOptions?.isEqual ?? strictEqual) as (a: unknown, b: unknown) => boolean,
      listener: listener as (value: unknown, previous: unknown) => void,
      raw,
      // Deliberately NOT wrapped: a selector that throws on the very first
      // snapshot is a programming error the caller must see, and swallowing
      // it would hand back a live subscription with no valid cached value.
      selected: selector(raw),
    };
    selections.add(selection);

    const unsubscribe = track(() => {
      selections.delete(selection);
    });

    if (selectOptions?.immediate === true) {
      try {
        listener(selection.selected as T, selection.selected as T);
      } catch (error) {
        report(error);
      }
    }

    return unsubscribe;
  }

  return {
    client,

    getState: () => client.getState(),

    subscribe(listener: StateListener<ChatState>, subscribeOptions?: SubscribeOptions): Unsubscribe {
      return select((state) => state, listener, subscribeOptions);
    },

    select,

    on<E extends ChatEventName>(event: E, handler: ChatEventHandler<E>): Unsubscribe {
      assertLive('on');
      const unsubscribe = client.on(event, ((payload: ChatEventMap[E]) => {
        try {
          (handler as (value: ChatEventMap[E]) => void)(payload);
        } catch (error) {
          report(error);
        }
      }) as ChatEventHandler<E>);
      return track(unsubscribe);
    },

    tick(messageId: string, localParticipantId: string | null): MessageTickState | null {
      const state = client.getState();
      const message = state.messages.find((candidate) => candidate.id === messageId);
      if (message === undefined) return null;
      return deriveTickStateFromState(state, message, localParticipantId);
    },

    destroy(destroyOptions?: DestroyOptions): void {
      if (destroyed) return;
      destroyed = true;

      // Subscriptions first, connection second: disconnecting pushes a state
      // change through core, and a listener firing during its own teardown is
      // exactly the re-entrancy a widget author should never have to reason
      // about.
      for (const dispose of [...disposers]) dispose();
      disposers.clear();
      selections.clear();
      unsubscribeFromClient();

      if (destroyOptions?.disconnect === true) {
        try {
          client.disconnect();
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
