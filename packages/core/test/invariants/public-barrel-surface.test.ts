// GUARD 5 — PRD §15: the public barrel exports no internals.
//
// ── Read `src/index.test.ts` before adding anything here ─────────────────
//
// T13 already guards this, and this file does NOT restate it. That test
// enumerates ~25 forbidden names (`SendQueue`, `ConnectionController`,
// `ChatStore`, `scrubCredentials`, …) and asserts none of them are exported,
// plus positive checks that the intended §6.4/§6.5 surface IS exported. All of
// that is left where it is.
//
// This file closes the one gap a denylist structurally cannot close.
//
// A denylist answers "did any of these 25 known internals leak?". The failure
// it cannot see is the export nobody thought to add to the list: a new engine
// class written next year, an internal helper re-exported for a binding's
// convenience, or a `export *` added to `index.ts` that drags a module's whole
// surface out at once. Every one of those passes the denylist — the names are
// not on it — and every one is the same mistake the denylist exists to catch.
//
// An allowlist inverts that. It fails on ANY change to the exported surface,
// known or unknown, so a new export cannot ship without someone editing this
// list and, in doing so, deciding on purpose that the name is public API.
//
// ── Why the list is written out rather than derived ──────────────────────
//
// The obvious shortcut — read `index.ts`, extract its exports, compare to what
// the module exports — is a test that compares the code to itself. It passes
// no matter what is exported, because both sides change together. The names
// below are therefore typed out, and updating them is meant to be a deliberate
// act.
//
// WHEN THIS TEST FAILS, DO NOT JUST PASTE THE NEW LIST IN. The question it is
// asking is "should a consumer of `@dhaam-ccrm/core` be able to reach this?"
// Adding a name here is an API commitment; removing one is a breaking change.

import { describe, expect, it } from 'vitest';

import * as core from '../../src/index.js';

/**
 * The complete runtime export surface of `@dhaam-ccrm/core`.
 *
 * Runtime only: `Object.keys` cannot see type-only exports, so the type
 * surface (`ChatState`, `ChatClientConfig`, `StorageAdapter`, …) is not
 * covered here and is checked by `tsc` and by `src/index.test.ts`'s
 * type-level imports instead.
 */
const PUBLIC_SURFACE: readonly string[] = [
  // §6.1 construction.
  'createChatClient',
  // The KEYLESS (staff/party) surface's construction. A DELIBERATE API
  // commitment, and a separate factory on purpose: widening
  // `ChatClientConfig.publishableKey` to optional would let
  // `publishableKey: process.env.PK` evaluating to `undefined` silently become
  // a keyless staff connection. This name is the whole runtime addition — the
  // rest of that surface (`ConversationClient`, `ConversationClientConfig`,
  // `ConversationsState`) is type-only and invisible to `Object.keys`.
  'createConversationClient',
  // The two failures the KEYLESS surface's operations reject with. Both are
  // here for the same reason `ConnectionAbortedError` is: a caller is expected
  // to CATCH them and branch, which needs `instanceof`, which needs the class
  // itself to be public. `ConversationJoinError` carries a structured `reason`
  // and the server's §7.4 `code`; `ConversationNotOpenError` names the
  // conversation that was not open.
  'ConversationJoinError',
  'ConversationNotOpenError',
  // Errors a consumer is expected to catch.
  'ChatClientConfigError',
  'ConnectionAbortedError',
  'ConnectionSuspendedError',
  'InvalidPublishableKeyError',
  'InvalidTokenResponseError',
  'NoActiveSessionError',
  'SecretKeyInClientError',
  // A failed `switchSession()` — the server refused the join, the socket was
  // not open, or the snapshot never arrived. A session picker has to be able
  // to tell that apart from any other rejection to report on the right row.
  'SessionSwitchError',
  'StorageError',
  'isStorageError',
  // §6.4/§6.5 state and event catalogue.
  'createInitialChatState',
  'CHAT_EVENT_NAMES',
  'CONNECTION_STATE_VALUES',
  // Protocol enum values and their runtime guards.
  'CHAT_MODE_VALUES',
  'CHAT_STATUS_VALUES',
  'CLOSE_REASON_VALUES',
  'ERROR_CODE_VALUES',
  'MESSAGE_TYPE_VALUES',
  'PARKED_CLOSE_REASONS',
  'PARTICIPANT_TYPE_VALUES',
  'PRESENCE_STATUS_VALUES',
  'SENDER_TYPE_VALUES',
  'isChatMode',
  'isChatStatus',
  'isCloseReason',
  'isErrorCode',
  'isMessageType',
  'isParkedCloseReason',
  'isParticipantType',
  'isPresenceStatus',
  'isSenderType',
  // Storage adapters and the namespace helper.
  'BrowserStorageAdapter',
  'MemoryStorageAdapter',
  'createBrowserStorageAdapter',
  'namespaced',
  // Auth boundary.
  'createTokenProvider',
  'isPublishableKey',
  'parsePublishableKey',
  'publishableKeyEnvironment',
  'toAuthToken',
  // Message list algebra, for bindings writing custom optimistic UI.
  'DEFAULT_PAGE_SIZE',
  'compareBySeq',
  'prependPage',
  'sortMessages',
  'upsertMessage',
  // The canonical tick derivation. Deliberately public: every binding renders
  // ticks from these, and a binding computing its own is the divergence the
  // conformance suite exists to catch. They were exported from messages/index.ts
  // but never promoted here, and core's single "." exports entry blocks any
  // subpath workaround — so no binding could reach them at all.
  'MESSAGE_TICK_STATES',
  'deriveTickState',
  'deriveTickStateFromState',
  // The one canonical `handledBy`-staleness derivation (T10), same reasoning
  // as the tick derivations above: `ChatSession.handledBy` can legitimately
  // lag `status` right after a server-side reactivation, and every binding
  // must gate "connected to <name>" copy on this rather than re-deriving the
  // WAITING_FOR_AGENT rule ad hoc.
  'isHandledByCurrent',
];

describe('§15 guard: the public barrel exports exactly the reviewed surface', () => {
  const actual = Object.keys(core).sort();
  const expected = [...PUBLIC_SURFACE].sort();

  it('exports nothing that is not on the reviewed list', () => {
    // The half a denylist cannot do: catches an internal nobody predicted.
    const unexpected = actual.filter((name) => !expected.includes(name));
    expect(unexpected).toEqual([]);
  });

  it('still exports everything on the reviewed list', () => {
    // The other direction, so an accidental deletion is a test failure rather
    // than a silent breaking change for every consumer.
    const missing = expected.filter((name) => !actual.includes(name));
    expect(missing).toEqual([]);
  });

  it('sanity: the barrel really was imported and really has exports', () => {
    // Guards the whole file against passing because `core` resolved to an
    // empty module — in which case both assertions above would hold vacuously.
    expect(actual.length).toBeGreaterThan(40);
    expect(typeof core.createChatClient).toBe('function');
  });

  it('the list has no duplicates, which would mask a missing export', () => {
    expect(new Set(PUBLIC_SURFACE).size).toBe(PUBLIC_SURFACE.length);
  });
});
