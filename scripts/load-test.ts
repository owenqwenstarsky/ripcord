import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { db } from '../src/lib/db';
import { appUrl, newSession, passwordHash } from '../src/lib/auth';
import { createServer, setOverride } from '../src/lib/community';
import { P } from '../src/lib/permissions';
import { assert } from '../src/lib/errors';

const run = randomUUID().slice(0, 8),
  sockets: Socket[] = [],
  ids: string[] = [];
let serverId: string | undefined, roomId: string | undefined;
const tokens: string[] = [];
function waitEvent<T>(
  socket: Socket,
  name: string,
  check: (value: T) => boolean = () => true,
  timeout = 20000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const listener = (value: T) => {
      if (!check(value)) return;
      clearTimeout(timer);
      socket.off(name, listener);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.off(name, listener);
      reject(new Error(`Timeout waiting for ${name}`));
    }, timeout);
    socket.on(name, listener);
  });
}
async function post(path: string, data: unknown, index = 0) {
  const result = await fetch(`${appUrl()}/api/${path}`, {
    method: 'POST',
    headers: {
      Origin: appUrl(),
      Cookie: `ripcord_session=${tokens[index]}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  assert(result.ok, result.status, await result.clone().text());
  return result.json();
}
async function main() {
  assert(
    ['localhost', '127.0.0.1'].includes(new URL(appUrl()).hostname) &&
      process.env.NODE_ENV !== 'production',
    400,
    'Run the load test only against a local development or staging instance.',
  );
  assert(
    (await fetch(`${appUrl()}/api/health`)).ok,
    503,
    'Start the app before running the load test.',
  );
  const pass = await passwordHash(randomUUID());
  for (let i = 0; i < 100; i++) {
    const user = await db.user.create({
      data: { username: `load_${run}_${i}`, displayName: `Load ${i}`, passwordHash: pass },
    });
    ids.push(user.id);
    tokens.push(await newSession(user.id));
  }
  const server = await createServer(ids[0], `Load test ${run}`);
  serverId = server.id;
  await db.membership.createMany({
    data: ids.slice(1).map((userId) => ({ userId, serverId: server.id })),
  });
  const room = await db.room.findFirstOrThrow({ where: { serverId, name: 'general' } });
  roomId = room.id;
  const started = performance.now();
  await Promise.all(
    tokens.map(async (token) => {
      const socket = io(appUrl(), {
        autoConnect: false,
        transports: ['websocket'],
        extraHeaders: { Cookie: `ripcord_session=${token}`, Origin: appUrl() },
        reconnection: false,
      });
      sockets.push(socket);
      const ready = waitEvent(socket, 'connect');
      socket.connect();
      await ready;
      await new Promise<void>((resolve, reject) =>
        socket
          .timeout(15000)
          .emit(
            'subscribe',
            roomId,
            (error: Error | null, ack: { ok?: boolean; error?: string }) =>
              error || !ack?.ok ? reject(error ?? new Error(ack?.error)) : resolve(),
          ),
      );
    }),
  );
  console.log(
    `100 authenticated sockets connected and subscribed in ${Math.round(performance.now() - started)} ms.`,
  );
  const sendStarted = performance.now();
  const deliveries = sockets.map((socket) =>
    waitEvent<{ roomId: string; type: string }>(
      socket,
      'invalidate',
      (e) => e.roomId === roomId && e.type === 'messages',
    ).then(() => performance.now() - sendStarted),
  );
  const nonce = randomUUID();
  const sent = await Promise.all(
    Array.from({ length: 5 }, () =>
      post(`rooms/${roomId}/messages`, { content: `Load test ${run}`, nonce, attachmentIds: [] }),
    ),
  );
  assert(new Set(sent.map((m) => m.id)).size === 1, 500, 'Retry deduplication failed.');
  const times = (await Promise.all(deliveries)).sort((a, b) => a - b);
  console.log(
    `All 100 received the committed event. Delivery p50=${Math.round(times[49])} ms, p95=${Math.round(times[94])} ms; duplicate retries created one message.`,
  );
  const revoked = waitEvent<{ roomId: string }>(
    sockets[1],
    'access.revoked',
    (e) => e.roomId === roomId,
  );
  await setOverride(ids[0], serverId, 'room', roomId, {
    targetType: 'MEMBER',
    targetId: ids[1],
    allow: '0',
    deny: P.VIEW_CHANNEL.toString(),
  });
  await revoked;
  const forbidden = await fetch(`${appUrl()}/api/rooms/${roomId}/messages`, {
    headers: { Cookie: `ripcord_session=${tokens[1]}` },
  });
  assert(forbidden.status === 403, 500, 'Revoked user could fetch history.');
  console.log('Live permission revocation cleared the subscription and blocked HTTP history.');
  sockets[2].disconnect();
  const next = await post(`rooms/${roomId}/messages`, {
    content: 'Missed while disconnected',
    nonce: randomUUID(),
    attachmentIds: [],
  });
  const reconnected = waitEvent(sockets[2], 'connect');
  sockets[2].connect();
  await reconnected;
  const recovery = await fetch(`${appUrl()}/api/rooms/${roomId}/messages?after=${sent[0].seq}`, {
    headers: { Cookie: `ripcord_session=${tokens[2]}` },
  }).then((r) => r.json());
  assert(
    recovery.messages.some((m: { id: string }) => m.id === next.id),
    500,
    'Reconnect recovery missed the message.',
  );
  const sessionRevoked = waitEvent(sockets[3], 'account.revoked');
  await db.session.deleteMany({ where: { userId: ids[3] } });
  await sessionRevoked;
  console.log(
    'Reconnect recovered missed history, and session revocation disconnected an active socket.',
  );
}
async function cleanup() {
  for (const socket of sockets) socket.disconnect();
  if (serverId) await db.server.deleteMany({ where: { id: serverId } });
  await db.event.deleteMany({
    where: {
      targetId: { in: [...ids, ...(serverId ? [serverId] : []), ...(roomId ? [roomId] : [])] },
    },
  });
  await db.rateBucket.deleteMany({
    where: { key: { in: ids.flatMap((id) => [`user:${id}`, `send:${id}`]) } },
  });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
}
void main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
