import type { Prisma } from '@prisma/client';
import { db } from './db';
import { instance, personSelect } from './auth';
import { assert } from './errors';
import { serverAccess, roomAccess, dmSendAccess } from './access';
import { P, has } from './permissions';

export const messageInclude = {
  author: { select: personSelect },
  attachments: { select: { id: true, name: true, mime: true, size: true } },
  reactions: { select: { userId: true, emoji: true } },
  reply: { select: { id: true, content: true, deletedAt: true, author: { select: personSelect } } },
} as const;
export const lock = (tx: Prisma.TransactionClient, key: string) =>
  tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
export const event = (
  tx: Prisma.TransactionClient,
  scope: string,
  targetId: string,
  type: string,
) => tx.event.create({ data: { scope, targetId, type } });
export const audit = (
  tx: Prisma.TransactionClient,
  actorId: string,
  serverId: string | null,
  action: string,
  targetId?: string,
  detail?: Prisma.InputJsonValue,
) => tx.auditLog.create({ data: { actorId, serverId, action, targetId, detail } });
export async function roomTransaction<T>(
  roomId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return db.$transaction(
    async (tx) => {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      assert(room, 404, 'Conversation not found.');
      await lock(tx, room.serverId ? `server:${room.serverId}` : `room:${roomId}`);
      return fn(tx);
    },
    { timeout: 20000 },
  );
}
export async function workspace(userId: string) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { ...personSelect, isAdmin: true, friendsOnly: true, email: true, emailVerified: true },
  });
  const settings = await instance();
  const memberships = await db.membership.findMany({
    where: { userId },
    include: {
      server: {
        include: {
          categories: { orderBy: { position: 'asc' } },
          rooms: { orderBy: { position: 'asc' } },
        },
      },
    },
  });
  async function decorate(roomId: string) {
    try {
      const { room, permissions } = await roomAccess(userId, roomId);
      const read = await db.readPosition.findUnique({
        where: { userId_roomId: { userId, roomId } },
      });
      const where = {
        roomId,
        seq: { gt: read?.seq ?? 0n },
        deletedAt: null,
        authorId: { not: userId },
      };
      const history = has(permissions, P.READ_HISTORY);
      const unread = history ? await db.message.count({ where }) : 0;
      const mentions = history
        ? await db.message.count({
            where: {
              ...where,
              OR: [
                { content: { contains: `@${user.username}` } },
                { content: { contains: '@everyone' } },
                { content: { contains: '@here' } },
              ],
            },
          })
        : 0;
      const { overrides: _o, category: _c, members: _m, ...data } = room;
      const members =
        room.kind !== 'TEXT'
          ? await db.roomMember.findMany({
              where: { roomId },
              include: { user: { select: personSelect } },
            })
          : undefined;
      return { ...data, permissions, unread, mentions, members };
    } catch {
      return null;
    }
  }
  const servers = [];
  for (const { server } of memberships) {
    const access = await serverAccess(userId, server.id);
    const rooms = (await Promise.all(server.rooms.map((r) => decorate(r.id)))).filter(Boolean);
    servers.push({ ...server, rooms, permissions: access.permissions });
  }
  const dmRooms = await db.room.findMany({
    where: { kind: { not: 'TEXT' }, members: { some: { userId } } },
    orderBy: { createdAt: 'asc' },
  });
  const dms = (await Promise.all(dmRooms.map((r) => decorate(r.id)))).filter(Boolean);
  const relationships = await db.relationship.findMany({
    where: { OR: [{ fromId: userId }, { toId: userId, kind: { not: 'BLOCK' } }] },
  });
  const related = await db.user.findMany({
    where: { id: { in: relationships.map((r) => (r.fromId === userId ? r.toId : r.fromId)) } },
    select: personSelect,
  });
  return {
    user,
    instance: {
      name: settings.name,
      maxMessageLength: settings.maxMessageLength,
      maxFileBytes: settings.maxFileBytes,
      maxAttachments: settings.maxAttachments,
    },
    servers,
    dms,
    relationships: relationships.map((r) => ({
      ...r,
      user: related.find((u) => u.id === (r.fromId === userId ? r.toId : r.fromId)),
    })),
  };
}
export async function history(userId: string, roomId: string, before?: string, after?: string) {
  await roomAccess(userId, roomId, P.READ_HISTORY);
  const messages = await db.message.findMany({
    where: {
      roomId,
      ...(before ? { seq: { lt: BigInt(before) } } : after ? { seq: { gt: BigInt(after) } } : {}),
    },
    include: messageInclude,
    orderBy: { seq: after ? 'asc' : 'desc' },
    take: 50,
  });
  return { messages: after ? messages : messages.reverse(), hasMore: messages.length === 50 };
}
export async function sendMessage(
  userId: string,
  roomId: string,
  input: { content: string; nonce: string; replyId?: string; attachmentIds: string[] },
) {
  const settings = await instance();
  assert(
    input.content.length <= settings.maxMessageLength &&
      input.attachmentIds.length <= settings.maxAttachments,
    400,
    'Message or attachment limit exceeded.',
  );
  assert(
    input.content.trim() || input.attachmentIds.length,
    400,
    'Write a message or attach a file.',
  );
  return roomTransaction(roomId, async (tx) => {
    const { room, permissions, server } = await roomAccess(userId, roomId, P.SEND_MESSAGES, tx);
    if (room.kind !== 'TEXT')
      await dmSendAccess(
        userId,
        room.members.map((m) => m.userId),
        tx,
      );
    const existing = await tx.message.findUnique({
      where: { authorId_roomId_nonce: { authorId: userId, roomId, nonce: input.nonce } },
      include: messageInclude,
    });
    if (existing) return existing;
    if (/@(?:everyone|here)\b/.test(input.content) && room.kind === 'TEXT')
      assert(
        has(permissions, P.MENTION_EVERYONE),
        403,
        'You cannot mention everyone in this channel.',
      );
    if (input.attachmentIds.length) {
      await lock(tx, 'storage');
      assert(has(permissions, P.ATTACH_FILES), 403, 'You cannot attach files in this channel.');
      const files = await tx.attachment.findMany({
        where: { id: { in: input.attachmentIds }, ownerId: userId, messageId: null },
      });
      assert(
        files.length === input.attachmentIds.length &&
          new Set(input.attachmentIds).size === input.attachmentIds.length,
        400,
        'One or more attachments are unavailable.',
      );
      assert(
        !(await tx.user.findFirst({ where: { avatarId: { in: input.attachmentIds } } })),
        400,
        'An avatar cannot be used as an attachment.',
      );
    }
    if (
      room.slowMode &&
      server &&
      !server.owner &&
      !has(server.permissions, P.MANAGE_MESSAGES) &&
      !has(server.permissions, P.ADMINISTRATOR)
    ) {
      const last = await tx.message.findFirst({
        where: { roomId, authorId: userId },
        orderBy: { seq: 'desc' },
      });
      assert(
        !last || Date.now() - last.createdAt.getTime() >= room.slowMode * 1000,
        429,
        `Slow mode: wait ${room.slowMode} seconds between messages.`,
      );
    }
    if (input.replyId) {
      assert(has(permissions, P.READ_HISTORY), 403, 'You cannot reply to history in this channel.');
      const reply = await tx.message.findUnique({ where: { id: input.replyId } });
      assert(reply?.roomId === roomId, 400, 'Replies must belong to this conversation.');
    }
    const message = await tx.message.create({
      data: {
        roomId,
        authorId: userId,
        content: input.content,
        nonce: input.nonce,
        replyId: input.replyId,
        attachments: { connect: input.attachmentIds.map((id) => ({ id })) },
      },
      include: messageInclude,
    });
    await event(tx, 'room', roomId, 'messages');
    return message;
  });
}
export async function modifyMessage(userId: string, messageId: string, content?: string) {
  const found = await db.message.findUnique({ where: { id: messageId } });
  assert(found, 404, 'Message not found.');
  const settings = await instance();
  if (content !== undefined)
    assert(
      content.trim().length && content.length <= settings.maxMessageLength,
      400,
      'Invalid message length.',
    );
  return roomTransaction(found.roomId, async (tx) => {
    const access = await roomAccess(userId, found.roomId, P.READ_HISTORY, tx);
    const message = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
    assert(!message.deletedAt, 400, 'This message was deleted.');
    assert(
      message.authorId === userId ||
        (content === undefined && access.server && has(access.permissions, P.MANAGE_MESSAGES)),
      403,
      'You cannot modify this message.',
    );
    if (content !== undefined) {
      await roomAccess(userId, found.roomId, P.SEND_MESSAGES, tx);
      if (!access.server)
        await dmSendAccess(
          userId,
          access.room.members.map((m) => m.userId),
          tx,
        );
      if (/@(?:everyone|here)\b/.test(content) && access.server)
        assert(has(access.permissions, P.MENTION_EVERYONE), 403, 'You cannot mention everyone.');
    } else {
      await lock(tx, 'storage');
      await tx.attachment.updateMany({ where: { messageId }, data: { messageId: null } });
      await tx.reaction.deleteMany({ where: { messageId } });
      if (message.authorId !== userId)
        await audit(tx, userId, access.room.serverId, 'message.delete', messageId);
    }
    const result = await tx.message.update({
      where: { id: messageId },
      data:
        content === undefined
          ? { content: null, deletedAt: new Date() }
          : { content, editedAt: new Date() },
      include: messageInclude,
    });
    await event(tx, 'room', found.roomId, 'messages');
    return result;
  });
}
export async function react(userId: string, messageId: string, emoji: string) {
  assert(
    /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3\u{1f3fb}-\u{1f3ff}])+$/u.test(
      emoji,
    ) && [...emoji].length <= 16,
    400,
    'Choose a Unicode emoji.',
  );
  const message = await db.message.findUnique({ where: { id: messageId } });
  assert(message, 404, 'Message not found.');
  return roomTransaction(message.roomId, async (tx) => {
    const { room } = await roomAccess(userId, message.roomId, P.ADD_REACTIONS | P.READ_HISTORY, tx);
    assert(
      !(await tx.message.findFirst({ where: { id: messageId, deletedAt: { not: null } } })),
      400,
      'This message was deleted.',
    );
    if (room.kind !== 'TEXT')
      await dmSendAccess(
        userId,
        room.members.map((m) => m.userId),
        tx,
      );
    const key = { messageId, userId, emoji };
    const existing = await tx.reaction.findUnique({ where: { messageId_userId_emoji: key } });
    if (existing) await tx.reaction.delete({ where: { messageId_userId_emoji: key } });
    else await tx.reaction.create({ data: key });
    await event(tx, 'room', message.roomId, 'messages');
  });
}
export async function markRead(userId: string, roomId: string, seq: string) {
  await roomAccess(userId, roomId, P.READ_HISTORY);
  const value = BigInt(seq);
  assert(
    value >= 0n && (!value || (await db.message.findFirst({ where: { roomId, seq: value } }))),
    400,
    'Invalid read position.',
  );
  await db.$executeRaw`INSERT INTO "ReadPosition" ("userId", "roomId", "seq") VALUES (${userId}, ${roomId}, ${value}) ON CONFLICT ("userId", "roomId") DO UPDATE SET "seq" = GREATEST("ReadPosition"."seq", EXCLUDED."seq")`;
}
export async function searchMessages(
  userId: string,
  query: string,
  roomId?: string,
  serverId?: string,
) {
  const candidates = roomId
    ? [{ id: roomId }]
    : await db.room.findMany({
        where: serverId
          ? { serverId }
          : {
              OR: [
                { server: { members: { some: { userId } } } },
                { members: { some: { userId } } },
              ],
            },
        select: { id: true },
      });
  const ids: string[] = [];
  for (const r of candidates) {
    try {
      await roomAccess(userId, r.id, P.READ_HISTORY);
      ids.push(r.id);
    } catch {
      /* inaccessible rooms are excluded */
    }
  }
  if (!ids.length) return [];
  const matches = await db.$queryRaw<
    { id: string }[]
  >`SELECT "id" FROM "Message" WHERE "roomId" = ANY(${ids}::text[]) AND "deletedAt" IS NULL AND to_tsvector('simple', COALESCE("content", '')) @@ plainto_tsquery('simple', ${query}) ORDER BY "seq" DESC LIMIT 50`;
  return db.message.findMany({
    where: { id: { in: matches.map((m) => m.id) } },
    include: messageInclude,
    orderBy: { seq: 'desc' },
  });
}
