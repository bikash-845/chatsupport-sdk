// What a keyless connection is allowed to tell the host about a failure.
//
// ── The problem this exists to solve ─────────────────────────────────────
//
// A keyless hello that the server refuses comes back as `AUTH_INVALID` with
// the text **"Invalid publishable key"** — on a connection that sent no
// publishable key at all. Verified in `chat-service-node`'s
// `src/api/websocket/v2/handlers.ts`, where the keyless branch answers with
// that exact payload in two places:
//
//   • the staff surface is not enabled on this deployment
//     (`if (!config.websocket.v2StaffEnabled)`, ~:1113)
//   • the token verified, but the role is not staff (~:1190)
//
// and with `authErrorPayload(d.token)` in a third (~:1164, token verification
// failed), which resolves to `AUTH_INVALID`/"Authentication failed" or, if the
// token is merely expired, `AUTH_EXPIRED`/"Token has expired".
//
// So on this surface the server's message is not just unhelpful, it is
// actively wrong, and it is inconsistent between causes that need different
// fixes: turn a flag on, get a new token, or use an account with a staff role.
// Passing it through would send an integrator hunting for a key they were
// never supposed to have.
//
// ── The rule ─────────────────────────────────────────────────────────────
//
// Branch on `code`. NEVER on `message`, and never surface the server's own
// string to the host on a keyless connection. `ChatError.message` is
// documented as human-readable and never a branch target, so replacing it is
// legitimate — and it is the only way to make the surfaced text true.
//
// The server's text is not merely renamed, it is DROPPED: a host that logs
// `lastError.message` to its error tracker must not have "Invalid publishable
// key" in the report for a connection that never sent one.

import type { ErrorCode } from '../protocol/index.js';
import type { ChatError } from '../state/index.js';

/**
 * What this SDK says instead, for a refusal on a connection that sent no key.
 *
 * Written out rather than assembled, so the text a host sees in their tracker
 * is greppable back to this line.
 */
const KEYLESS_AUTH_INVALID =
  'The server refused this keyless connection. It reports AUTH_INVALID for three ' +
  'unrelated causes on a connection that sent no publishable key: the staff ' +
  'surface is disabled on this deployment, the token failed verification, or the ' +
  "token's role is not a staff role. Check WS_V2_STAFF_ENABLED, then the token, " +
  'then the role.';

/**
 * Rewrites a connection-level error for the conversation surface.
 *
 * `keyed` clients are left alone: they DID send a publishable key, so the
 * server's message is about something that actually happened and is the
 * clearer of the two.
 *
 * Only the message is rewritten. `code`, `source` and `retryable` are the
 * structured facts a host branches on and they pass through untouched;
 * `details` is dropped along with the message, because it is the server's own
 * elaboration of a claim that does not apply here.
 */
export function describeConnectionError(error: ChatError, keyed: boolean): ChatError {
  if (keyed) return error;
  if (error.code !== 'AUTH_INVALID') return error;

  return {
    source: error.source,
    code: error.code,
    message: KEYLESS_AUTH_INVALID,
    retryable: error.retryable,
  };
}

// ---------------------------------------------------------------------------
// Conversation-scoped failures.
//
// Both are ERRORS rather than state, deliberately, and the split is the same
// one §6.4 draws everywhere else in this SDK: `open()` and `sendMessage()` are
// operations a caller AWAITS, so their failures belong on the promise they are
// already waiting on. Failures with no caller — a re-join that fails after a
// reconnect — land on the row's own `ChatState.lastError` instead.
//
// Neither carries the server's own message text. `code` is the structured fact
// to branch on (§12.6), and a refused `session.join` answers `SESSION_NOT_FOUND`
// for a session that does not exist AND for one belonging to another tenant —
// the server makes them deliberately indistinguishable, and passing its prose
// through would only look like it said more than it does.
// ---------------------------------------------------------------------------

/** Why `session.join` did not produce a usable conversation. */
export type ConversationJoinFailure =
  /** The server answered `ack.ok === false`. Look at `code`. */
  | 'refused'
  /** Nothing answered within the ack deadline. The join may or may not have landed. */
  | 'timeout'
  /** There was no open socket to write it to. */
  | 'notSent'
  /**
   * The join WAS acknowledged, but the `session.updated` snapshot the server
   * pushes after every accepted join never arrived.
   *
   * A distinct outcome rather than a timeout, because the two need different
   * responses: this connection IS joined server-side, so the conversation will
   * still receive pushes — what is missing is the snapshot a caller needs before
   * it can send, since a send is addressed from `ChatState.session`.
   */
  | 'noSnapshot';

/** `open()` could not bring a conversation up. */
export class ConversationJoinError extends Error {
  readonly conversationId: string;
  readonly reason: ConversationJoinFailure;

  /** The server's §7.4 code when it refused; `null` for every locally-determined outcome. */
  readonly code: ErrorCode | null;

  constructor(
    conversationId: string,
    reason: ConversationJoinFailure,
    code: ErrorCode | null,
    detail: string,
  ) {
    super(`could not open conversation "${conversationId}" (${reason}): ${detail}`);
    this.name = 'ConversationJoinError';
    this.conversationId = conversationId;
    this.reason = reason;
    this.code = code;
  }
}

/** An operation named a conversation this client does not hold open. */
export class ConversationNotOpenError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, detail: string) {
    super(`conversation "${conversationId}" is not open: ${detail}`);
    this.name = 'ConversationNotOpenError';
    this.conversationId = conversationId;
  }
}
