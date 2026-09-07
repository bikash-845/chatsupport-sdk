// ==========================================
// connection.hello — the counterparty (role, id) pair
// ==========================================
// A conversation addressed to a merchant carries `targetRole`/`targetId` on the
// hello. The property that actually matters here is NOT that the first hello
// carries them — it is that EVERY hello does.
//
// The server's find-or-create is scoped by the pair: a hello without it resolves
// the caller's SUPPORT conversation instead. So a reconnect that dropped the
// pair would silently move an open merchant conversation back to the support
// desk, and the customer's next message would land in the agent queue. That is
// the regression these tests exist to prevent, and it is why the pair is NOT
// latched-and-cleared the way `subject`/`topic` are.

import { describe, expect, it, vi } from 'vitest';

import { AuthBackoffPolicy, TransportBackoffPolicy } from '../backoff/index.js';
import { ManualTimers } from '../presence/index.js';
import type { ConnectionAckPayload, ServerFrame, SessionSnapshot } from '../protocol/index.js';
import { ChatStore, createInitialChatState } from '../state/index.js';
import { ConnectionController } from './controller.js';
import { FakeTransport } from './fake-transport.js';
import type { TokenProvider } from './types.js';

async function tick(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const SESSION_SNAPSHOT: SessionSnapshot = {
  sessionId: 'sess_1',
  status: 'OPEN',
  mode: 'BOT',
  participants: [],
  createdAt: '2026-08-17T00:00:00.000Z',
};

function ackFrame(overrides: Partial<ConnectionAckPayload> = {}): ServerFrame {
  return {
    v: 1, t: 'connection.ack', id: 'srv_ack', ts: 0,
    d: { protocolVersion: 1, session: SESSION_SNAPSHOT, seq: 0, ...overrides },
  };
}

const TARGET = { role: 'merchant', id: 'merch-7' } as const;

function harness(opts: { target?: { role: string; id: string } } = {}) {
  const store = new ChatStore({ initialState: createInitialChatState() });
  const timers = new ManualTimers();
  let transport!: FakeTransport;

  const controller = new ConnectionController({
    store,
    url: 'wss://example.test/chat-services/v2/ws',
    publishableKey: 'dhp_test_1',
    ...(opts.target ? { target: opts.target } : {}),
    getToken: vi.fn(async () => 'tok_abc') as unknown as TokenProvider,
    schedule: timers.schedule,
    transportBackoff: new TransportBackoffPolicy({ random: () => 1 }),
    authBackoff: new AuthBackoffPolicy({ random: () => 1 }),
    createTransport: (handlers) => {
      transport = new FakeTransport(handlers);
      return transport;
    },
  });

  return { store, timers, controller, get transport() { return transport; } };
}

async function connect(h: ReturnType<typeof harness>): Promise<void> {
  const p = h.controller.connect();
  await tick();
  h.transport.open();
  h.transport.emitFrame(ackFrame());
  await p;
}

describe('a targeted conversation sends the pair', () => {
  it('puts both halves on the hello', async () => {
    const h = harness({ target: { ...TARGET } });
    await connect(h);

    const hello = h.transport.connects[0]!.hello as Record<string, unknown>;
    expect(hello.targetRole).toBe('merchant');
    expect(hello.targetId).toBe('merch-7');
  });

  // The load-bearing one. A dropped pair on reconnect silently repoints an open
  // merchant conversation at the support desk.
  it('sends the pair again on every reconnect', async () => {
    const h = harness({ target: { ...TARGET } });
    await connect(h);

    // A peer-side drop (1006) — the retryable case the controller reconnects
    // from on its own backoff schedule.
    h.transport.drop();
    await tick();
    h.timers.advance(120_000);
    await tick();
    h.transport.open();
    h.transport.emitFrame(ackFrame());
    await tick();

    expect(h.transport.connects.length).toBeGreaterThan(1);
    for (const c of h.transport.connects) {
      const hello = c.hello as Record<string, unknown>;
      expect(hello.targetRole).toBe('merchant');
      expect(hello.targetId).toBe('merch-7');
    }
  });
});

describe('an untargeted conversation is byte-for-byte unchanged', () => {
  // The existing customer<->agent path is the top acceptance criterion: a host
  // upgrading the SDK must notice nothing. ABSENT, not `undefined` — under
  // `exactOptionalPropertyTypes` those are different things, and the server
  // selects its flow on presence.
  it('omits both keys entirely when no target was given', async () => {
    const h = harness();
    await connect(h);

    const hello = h.transport.connects[0]!.hello as Record<string, unknown>;
    expect('targetRole' in hello).toBe(false);
    expect('targetId' in hello).toBe(false);
  });

  it('still sends the publishable key alongside a target', async () => {
    const h = harness({ target: { ...TARGET } });
    await connect(h);

    const hello = h.transport.connects[0]!.hello as Record<string, unknown>;
    expect(hello.publishableKey).toBe('dhp_test_1');
  });
});
