// ███ A STUB. THIS IS NOT chat-service. ███
//
// It exists for one reason: `WS_V2_STAFF_ENABLED=true` plus a dh-auth admin
// `id_token` is a real operational dependency, and most people reading this
// example do not have both to hand on the first day. Without something to talk
// to, "does my wiring work?" and "is the backend configured?" fail identically
// — a 1008 close and an `AUTH_INVALID` — and you cannot tell which half you are
// debugging.
//
// So: run the panel against this first. If the flow works here and not against
// your deployment, the panel wiring is fine and the problem is the backend's
// flag or your token. That is the entire value of this file, and it is the only
// claim it makes.
//
// ── What it is honest about ──────────────────────────────────────────────
//
//   • It ACCEPTS ANY NON-EMPTY TOKEN. There is no verification, no dh-auth, no
//     role check, no tenancy. Nothing here proves anything about auth.
//   • It keeps everything in memory and forgets on exit.
//   • It implements the handful of frames this panel drives and nothing else.
//
// ── What it IS faithful to, deliberately ─────────────────────────────────
//
//   • The keyless hello answers a SESSION-LESS `connection.ack` (no `session`,
//     no `seq`) — the staff shape. The customer branch answers with both, and a
//     stub that returned the customer shape would hide a real class of bug.
//   • `session.join` is acked and the `session.updated` snapshot follows as a
//     SEPARATE push, in that order, because that is the order chat-service does
//     it in (handlers.ts:1927 then :1933) and `open()` waits for both.
//   • A refused join answers `SESSION_NOT_FOUND` — the code the real server
//     uses for "no such session" AND for "another tenant's session",
//     indistinguishably. Ask for the session id `no-such-session` to see it.
//   • The REST history route returns RAW rows: integer enums, `chatSessionId`
//     rather than `sessionId`, `messageType` rather than `type`. That is what
//     the service actually returns, and it is what makes `projectHistoryRow`
//     in src/admin-api.ts load-bearing rather than decorative.
//
// The WebSocket server is ~100 lines of RFC 6455 rather than a dependency:
// this repo ships zero runtime dependencies and an example that added one to
// fake a backend would be a poor advertisement for that.

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const STUB_WARNING =
  'STUB BACKEND — this is not chat-service. It accepts ANY non-empty token, verifies nothing, ' +
  'and stores nothing. It proves your panel wiring, never your auth.';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BASE_PATH = '/chat-services/api/v1';
const WS_PATH = '/chat-services/v2/ws';

/** The one session this stub knows about, plus whatever else you ask to open. */
const KNOWN_CUSTOMER = { participantId: 'participant_customer_1', displayName: 'Ada (stub customer)' };
const REFUSE_ID = 'no-such-session';

let seq = 100;
const nextSeq = () => (seq += 1);

// ---------------------------------------------------------------------------
// Minimal RFC 6455 — text frames only, which is all this protocol uses
// ---------------------------------------------------------------------------

function acceptKey(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/** Server→client frame. Never masked, per RFC 6455 §5.1. */
function encode(opcode, payload) {
  const body = Buffer.from(payload, 'utf8');
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

/**
 * Pulls as many complete frames as `buffer` holds.
 *
 * Returns `{ frames, rest }`. Client→server frames are always masked; an
 * unmasked one is a protocol error the real server closes on, and this stub
 * simply ignores it — it is a stub, and no client in this repo sends one.
 */
function decode(buffer) {
  const frames = [];
  let offset = 0;

  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask !== null) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * A Crockford base32 ULID — 10 chars of millisecond timestamp, 16 of
 * randomness.
 *
 * Not decoration. `protocol/validate.ts` accepts ULID **or** UUID for a
 * message's own `d.id` (an AI bot reply carries a UUID), but an ENVELOPE `id`
 * and an `ack.ref` are strict ULID. A stub emitting `randomUUID()` there gets
 * every frame it sends dropped as malformed — with one `warn` and no other
 * symptom, which is a genuinely nasty way to spend an afternoon.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
  let time = '';
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  let random = '';
  for (let i = 0; i < 16; i += 1) {
    random += CROCKFORD[Math.floor(Math.random() * 32)];
  }
  return time + random;
}

function envelope(type, data, ref) {
  const frame = { v: 1, t: type, id: ulid(), ts: Date.now(), d: data };
  if (ref !== undefined) frame.ref = ref;
  return frame;
}

function snapshot(sessionId) {
  return {
    sessionId,
    status: 'ASSIGNED',
    mode: 'HUMAN',
    participants: [
      { participantId: KNOWN_CUSTOMER.participantId, type: 'CUSTOMER', displayName: KNOWN_CUSTOMER.displayName },
      { participantId: 'participant_staff_stub', type: 'AGENT', displayName: 'You (stub)' },
    ],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  };
}

function handleFrame(conn, frame, send) {
  const { t, id, d } = frame;

  switch (t) {
    case 'connection.hello': {
      if (typeof d?.publishableKey === 'string') {
        // The real server routes a keyed hello into the CUSTOMER branch. This
        // stub implements only the staff one, and says so rather than pretending.
        send(envelope('error', { code: 'AUTH_INVALID', message: 'this stub implements only the KEYLESS staff hello', retryable: false }, id));
        return;
      }
      if (typeof d?.token !== 'string' || d.token === '') {
        send(envelope('error', { code: 'AUTH_INVALID', message: 'Invalid publishable key', retryable: false }, id));
        return;
      }
      conn.authenticated = true;
      // SESSION-LESS. The staff shape: no `session`, no `seq`.
      send(envelope('connection.ack', { protocolVersion: 1 }));
      console.log('[stub] keyless hello accepted (token NOT verified — this is a stub)');
      return;
    }

    case 'connection.reauth': {
      send(envelope('ack', { ok: true }, id));
      console.log('[stub] reauth — core refreshed proactively at 80% of the declared window');
      return;
    }

    case 'session.join': {
      const sessionId = d?.sessionId;
      if (sessionId === REFUSE_ID) {
        send(envelope('ack', { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'Chat session not found', retryable: false } }, id));
        console.log(`[stub] refused session.join for "${sessionId}"`);
        return;
      }
      conn.joined.add(sessionId);
      // Ack first, snapshot second — the order the real server uses, and the
      // order `open()` waits in.
      send(envelope('ack', { ok: true, seq: nextSeq(), replay: [] }, id));
      send(envelope('session.updated', { session: snapshot(sessionId) }));
      console.log(`[stub] joined "${sessionId}" (${conn.joined.size} joined on this connection — staff accumulates)`);
      return;
    }

    case 'message.send': {
      const assigned = nextSeq();
      // Acked after a beat, not in the same tick. Not padding: an instant ack
      // makes the optimistic echo — `delivery: { state: 'queued' }`, the
      // "Sending…" a real panel renders — invisible, because it is replaced
      // before the next paint. A stub that hides the SDK's most visible
      // behaviour is a stub that lets you ship a panel which never renders it.
      setTimeout(() => send(envelope('ack', { ok: true, seq: assigned }, id)), 400);
      console.log(`[stub] message.send sessionId=${d?.sessionId ?? '(UNADDRESSED)'} seq=${assigned}`);

      // A scripted reply, so the inbound path is exercised too.
      setTimeout(() => {
        send(
          envelope('message.new', {
            id: randomUUID(),
            sessionId: d?.sessionId,
            senderId: KNOWN_CUSTOMER.participantId,
            senderType: 'CUSTOMER',
            type: 'TEXT',
            content: `(stub customer) got it — "${String(d?.content ?? '').slice(0, 60)}"`,
            seq: nextSeq(),
            createdAt: new Date().toISOString(),
          }),
        );
      }, 1300);
      return;
    }

    case 'system.heartbeat': {
      // Without this the transport declares `heartbeatTimeout` after 10s and
      // reconnects, forever.
      send(envelope('system.pong', {}));
      return;
    }

    // Every addressable frame the party surface emits carries its `sessionId`.
    // Logged rather than silently acked, because "did my frame arrive
    // addressed?" is the single most useful thing to be able to see here.
    case 'typing.start':
    case 'typing.stop':
    case 'message.markRead':
    case 'message.markDelivered': {
      console.log(`[stub] ${t} sessionId=${d?.sessionId ?? '(UNADDRESSED — the real server would throw on a multi-join connection)'}`);
      send(envelope('ack', { ok: true }, id));
      return;
    }

    default: {
      send(envelope('ack', { ok: true }, id));
    }
  }
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/** Raw rows, in the shape the service actually returns. See the header. */
function historyRows(sessionId) {
  const base = Date.now() - 600_000;
  return [
    {
      id: randomUUID(),
      chatSessionId: sessionId,
      senderId: KNOWN_CUSTOMER.participantId,
      senderType: 1, // CUSTOMER
      messageType: 1, // TEXT
      content: 'Hi — my order has not arrived.',
      seq: 1,
      createdAt: new Date(base).toISOString(),
    },
    {
      id: randomUUID(),
      chatSessionId: sessionId,
      senderId: 'participant_staff_stub',
      senderType: 2, // AGENT
      messageType: 1,
      content: 'Looking into it now.',
      seq: 2,
      createdAt: new Date(base + 60_000).toISOString(),
    },
  ];
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // The panel is served from a different port, so every REST call here is
    // cross-origin. The real chat-service has its own CORS configuration; this
    // is the stub's, and it is wide open because it is a stub.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function handleRest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    });
    res.end();
    return;
  }

  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
    // The real service answers an identical generic message for a bad token, an
    // expired one and a non-staff role. Mirrored so the panel's 401 hint is
    // reachable here too.
    sendJson(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
    return;
  }

  if (url.pathname === `${BASE_PATH}/agent/queue`) {
    sendJson(res, 200, {
      success: true,
      data: [
        {
          id: 'stub_session_1',
          status: 'ASSIGNED',
          customer: { displayName: KNOWN_CUSTOMER.displayName },
          lastMessage: { content: 'Looking into it now.' },
        },
        { id: REFUSE_ID, status: 'ASSIGNED', customer: { displayName: '(join is refused — try it)' }, lastMessage: null },
      ],
      hasMore: false,
      nextCursor: null,
    });
    return;
  }

  const history = url.pathname.match(new RegExp(`^${BASE_PATH}/agent/sessions/([^/]+)/messages$`));
  if (history !== null) {
    sendJson(res, 200, { success: true, data: { messages: historyRows(decodeURIComponent(history[1])), hasMore: false } });
    return;
  }

  sendJson(res, 404, { success: false, error: { code: 'NOT_FOUND', message: url.pathname } });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function startStub(port) {
  const server = createServer(handleRest);

  server.on('upgrade', (req, socket) => {
    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const key = req.headers['sec-websocket-key'];
    if (pathname !== WS_PATH || typeof key !== 'string') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '\r\n',
      ].join('\r\n'),
    );

    const conn = { authenticated: false, joined: new Set() };
    const send = (frame) => {
      if (!socket.destroyed) socket.write(encode(0x1, JSON.stringify(frame)));
    };

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decode(buffer);
      buffer = rest;

      for (const { opcode, payload } of frames) {
        if (opcode === 0x8) {
          socket.end(encode(0x8, ''));
          return;
        }
        if (opcode === 0x9) {
          socket.write(encode(0xa, payload.toString('utf8')));
          continue;
        }
        if (opcode !== 0x1) continue;

        let frame;
        try {
          frame = JSON.parse(payload.toString('utf8'));
        } catch {
          console.warn('[stub] dropped a non-JSON text frame');
          continue;
        }
        try {
          handleFrame(conn, frame, send);
        } catch (error) {
          console.error('[stub] handler threw', error);
        }
      }
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => console.log('[stub] socket closed'));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[stub] listening on http://127.0.0.1:${port}  (ws ${WS_PATH})`);
      resolve(server);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(STUB_WARNING);
  await startStub(Number(process.env['STUB_PORT'] ?? 4400));
}
