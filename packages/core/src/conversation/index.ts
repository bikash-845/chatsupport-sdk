// Conversation module barrel — the keyless (staff/party) surface.
//
// What leaves this module is deliberately small, and smaller than what leaves
// the module's own files: `describeConnectionError` is internal hygiene with no
// consumer-facing use, in the same spirit as `auth/redact.ts`.
//
// As with every other module barrel in core, appearing here does NOT make a
// name public API — `src/index.ts` decides that separately, and the hand-typed
// allowlist in `test/invariants/public-barrel-surface.test.ts` is what makes
// adding one a deliberate act.

export { createConversationClient } from './create-conversation-client.js';
export { ConversationJoinError, ConversationNotOpenError } from './errors.js';
export type { ConversationJoinFailure } from './errors.js';
export type {
  ConversationClient,
  ConversationClientConfig,
  ConversationLogger,
  ConversationsState,
} from './types.js';
