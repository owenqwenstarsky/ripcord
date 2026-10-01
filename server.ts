import { createServer } from 'node:http';
import next from 'next';
import { Server, type Socket } from 'socket.io';
import { db } from './src/lib/db';
import { appUrl, cookieToken, sessionUser, digest, personSelect } from './src/lib/auth';
import { roomAccess, roomAudience, dmSendAccess } from './src/lib/access';
import { cleanupUploads } from './src/lib/uploads';
import { P } from './src/lib/permissions';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
if (!dev && !appUrl().startsWith('https://') && process.env.ALLOW_INSECURE_HTTP !== '1')
  throw new Error(
    'Production requires an HTTPS APP_URL. For local production testing only, set ALLOW_INSECURE_HTTP=1.',
  );
const app = next({ dev, hostname: '0.0.0.0', port });
const handler = app.getRequestHandler();
const log = (event: string, extra = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...extra }));
async function main() {
  await app.prepare();
  const http = createServer((req, res) => {
    // Never trust a client-supplied internal IP header. Forwarded headers require explicit proxy configuration.
    const address =
      process.env.TRUST_PROXY === '1'
        ? String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress)
            .split(',')[0]
            .trim()
        : req.socket.remoteAddress;
    req.headers['x-ripcord-client-ip'] = address ?? 'unknown';
    void handler(req, res).catch((error) => {
      log('http.error', { message: String(error) });
      res.statusCode = 500;
      res.end('Internal server error');
    });
  });
  const io = new Server(http, {
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 4096,
    cors: { origin: appUrl(), credentials: true },
    allowRequest: (req, callback) => callback(null, req.headers.origin === appUrl()),
  });
  io.use(async (socket, done) => {
    try {
      const token = cookieToken(socket.handshake.headers.cookie),
        user = await sessionUser(token);
      if (!user) return done(new Error('Authentication required.'));
      const existing = [...io.sockets.sockets.values()].filter(
        (s) => s.data.userId === user.id,
      ).length;
      if (existing >= 8) return done(new Error('Too many active connections.'));
      socket.data.userId = user.id;
      socket.data.token = token;
      socket.data.lastTyping = 0;
      done();
    } catch {
      done(new Error('Authentication unavailable.'));
    }
  });
  async function validate(socket: Socket) {
    const user = await sessionUser(socket.data.token);
    if (!user) {
      socket.emit('account.revoked');
      socket.disconnect(true);
      return null;
    }
    return user;
  }
  const pendingPresence = new Set<string>();
  const schedulePresence = (roomId?: string) => {
    if (roomId) pendingPresence.add(roomId);
  };
  async function liveSockets() {
    const connected = [...io.sockets.sockets.values()];
    const sessions = await db.session.findMany({
      where: {
        id: { in: connected.map((s) => digest(s.data.token)) },
        expiresAt: { gt: new Date() },
        user: { suspended: false },
      },
      include: { user: { select: personSelect } },
    });
    const valid = new Map(sessions.map((s) => [s.id, s.user]));
    return connected.filter((socket) => {
      const user = valid.get(digest(socket.data.token));
      if (!user) {
        socket.emit('account.revoked');
        socket.disconnect(true);
        return false;
      }
      socket.data.person = user;
      return true;
    });
  }
  io.on('connection', (socket) => {
    socket.on('subscribe', async (input: unknown, ack?: (value: unknown) => void) => {
      try {
        if (!(await validate(socket))) return;
        if (typeof input !== 'string' || input.length > 100)
          throw new Error('Invalid conversation.');
        await roomAccess(socket.data.userId, input);
        const old = socket.data.roomId;
        socket.data.roomId = input;
        ack?.({ ok: true });
        schedulePresence(old);
        schedulePresence(input);
      } catch {
        ack?.({ error: 'Conversation unavailable.' });
      }
    });
    socket.on('unsubscribe', () => {
      const old = socket.data.roomId;
      socket.data.roomId = null;
      schedulePresence(old);
    });
    socket.on('typing', async () => {
      const roomId = socket.data.roomId;
      if (!roomId || Date.now() - socket.data.lastTyping < 2000) return;
      socket.data.lastTyping = Date.now();
      try {
        const user = await validate(socket);
        if (!user) return;
        const access = await roomAccess(user.id, roomId, P.SEND_MESSAGES);
        if (access.room.kind === 'DIRECT')
          await dmSendAccess(
            user.id,
            access.room.members.map((m) => m.userId),
          );
        const peers = await liveSockets();
        const audience = await roomAudience(roomId, [
          ...new Set(peers.map((p) => p.data.userId as string)),
        ]);
        for (const peer of peers)
          if (
            peer.data.roomId === roomId &&
            peer.data.userId !== user.id &&
            audience.allowed.has(peer.data.userId)
          )
            peer.emit('typing', { roomId, user: { id: user.id, displayName: user.displayName } });
      } catch {
        /* typing is ephemeral */
      }
    });
    socket.on('disconnect', () => {
      for (const peer of io.sockets.sockets.values()) schedulePresence(peer.data.roomId);
    });
  });
  let busy = false,
    lastCheck = 0;
  const dispatch = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const events = await db.event.findMany({
        where: { deliveredAt: null },
        orderBy: { id: 'asc' },
        take: 100,
      });
      if (!events.length && !pendingPresence.size && Date.now() - lastCheck < 2000) return;
      lastCheck = Date.now();
      const peers = await liveSockets();
      const userIds = [...new Set(peers.map((peer) => peer.data.userId as string))];
      const presenceRooms = new Set(pendingPresence);
      pendingPresence.clear();
      const roomIds = new Set<string>([
        ...peers.map((peer) => peer.data.roomId).filter(Boolean),
        ...events.filter((e) => e.scope === 'room').map((e) => e.targetId),
        ...presenceRooms,
      ]);
      const rooms = new Map<string, Awaited<ReturnType<typeof roomAudience>>>();
      for (const id of roomIds) rooms.set(id, await roomAudience(id, userIds));
      const serverIds = [
        ...new Set(events.filter((e) => e.scope === 'server').map((e) => e.targetId)),
      ];
      const memberships = serverIds.length
        ? await db.membership.findMany({
            where: { serverId: { in: serverIds }, userId: { in: userIds } },
            select: { serverId: true, userId: true },
          })
        : [];
      const serverMembers = new Set(memberships.map((m) => `${m.serverId}:${m.userId}`));
      for (const peer of peers) {
        const userId = peer.data.userId;
        if (peer.data.roomId && !rooms.get(peer.data.roomId)?.allowed.has(userId)) {
          const revokedRoom = peer.data.roomId;
          peer.data.roomId = null;
          peer.emit('access.revoked', { roomId: revokedRoom });
        }
        for (const e of events) {
          const permitted =
            e.scope === 'instance' ||
            (e.scope === 'user' && e.targetId === userId) ||
            (e.scope === 'room' && rooms.get(e.targetId)?.allowed.has(userId)) ||
            (e.scope === 'server' && serverMembers.has(`${e.targetId}:${userId}`));
          if (permitted)
            peer.emit('invalidate', {
              id: e.id.toString(),
              type: e.type,
              roomId: e.scope === 'room' ? e.targetId : undefined,
              serverId: e.scope === 'server' ? e.targetId : undefined,
            });
        }
        if (peer.data.roomId && presenceRooms.has(peer.data.roomId)) {
          const audience = rooms.get(peer.data.roomId)!;
          const people = new Map(
            peers
              .filter((p) => audience.members.has(p.data.userId))
              .map((p) => [p.data.userId, p.data.person]),
          );
          peer.emit('presence', { roomId: peer.data.roomId, users: [...people.values()] });
        }
      }
      if (events.length)
        await db.event.updateMany({
          where: { id: { in: events.map((e) => e.id) } },
          data: { deliveredAt: new Date() },
        });
    } catch (error) {
      log('outbox.error', { message: String(error) });
    } finally {
      busy = false;
    }
  }, 300);
  let cleaning = false;
  const maintenance = setInterval(async () => {
    if (cleaning) return;
    cleaning = true;
    try {
      await cleanupUploads();
      await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await db.accountToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await db.rateBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await db.event.deleteMany({
        where: { deliveredAt: { lt: new Date(Date.now() - 7 * 86400000) } },
      });
    } catch (error) {
      log('maintenance.error', { message: String(error) });
    } finally {
      cleaning = false;
    }
  }, 60000);
  http.listen(port, '0.0.0.0', () =>
    log('server.ready', { port, environment: dev ? 'development' : 'production' }),
  );
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(dispatch);
    clearInterval(maintenance);
    io.close(() => {
      http.close();
      void app
        .close()
        .then(() => db.$disconnect())
        .then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
void main().catch((error) => {
  log('startup.failed', { message: String(error) });
  process.exit(1);
});
