import type { Prisma } from '@prisma/client';
import { db } from './db';
import { instance, personSelect } from './auth';
import { assert } from './errors';
import { mentionTokens } from './mentions';
import { accessibleRooms, roomAccess, dmSendAccess } from './access';
import { P, has } from './permissions';

export const messageInclude = {
  author: { select: personSelect },
  attachments: { select: { id: true, name: true, mime: true, size: true } },
  mentions: { select: { userId: true } },
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
  messageId?: string,
) => tx.event.create({ data: { scope, targetId, type, messageId } });
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
    select: {
      ...personSelect,
      isAdmin: true,
      friendsOnly: true,
      email: true,
      emailVerified: true,
      notifyMentions: true,
      notifyDms: true,
    },
  });
  const settings = await instance();
  const snapshot = await accessibleRooms(userId);
  const ids = snapshot.rooms.filter((r) => has(r.permissions, P.READ_HISTORY)).map((r) => r.id);
  const reads = await db.readPosition.findMany({ where: { userId, roomId: { in: ids } } });
  const preferences = await db.notificationPreference.findMany({ where: { userId } });
  const counts = ids.length
    ? await db.$queryRaw<
        {
          roomId: string;
          unread: bigint;
          mentions: bigint;
          firstUnreadId: string | null;
          latestSeq: bigint | null;
          lastActivityAt: Date | null;
          latestEvent: bigint | null;
        }[]
      >`
    SELECT r."id" AS "roomId",
      COUNT(m."id") FILTER (WHERE m."seq" > COALESCE(p."seq", 0) AND m."deletedAt" IS NULL AND m."authorId" <> ${userId}) AS unread,
      COUNT(m."id") FILTER (WHERE m."seq" > COALESCE(p."seq", 0) AND m."deletedAt" IS NULL AND mm."userId" IS NOT NULL) AS mentions,
      (array_agg(m."id" ORDER BY m."seq") FILTER (WHERE m."seq" > COALESCE(p."seq", 0) AND m."deletedAt" IS NULL AND m."authorId" <> ${userId}))[1] AS "firstUnreadId",
      MAX(m."seq") AS "latestSeq", MAX(m."createdAt") AS "lastActivityAt",
      (SELECT MAX(e."id") FROM "Event" e WHERE e."scope" = 'room' AND e."targetId" = r."id" AND e."type" = 'messages') AS "latestEvent"
    FROM "Room" r LEFT JOIN "Message" m ON m."roomId" = r."id"
    LEFT JOIN "ReadPosition" p ON p."roomId" = r."id" AND p."userId" = ${userId}
    LEFT JOIN "MessageMention" mm ON mm."messageId" = m."id" AND mm."userId" = ${userId}
    WHERE r."id" = ANY(${ids}::text[]) GROUP BY r."id", p."seq"`
    : [];
  const decorated = snapshot.rooms.map((room) => {
    const count = counts.find((c) => c.roomId === room.id);
    return {
      ...room,
      unread: Number(count?.unread ?? 0),
      mentions: Number(count?.mentions ?? 0),
      readSeq: reads.find((r) => r.roomId === room.id)?.seq ?? 0n,
      firstUnreadId: count?.firstUnreadId ?? null,
      latestSeq: count?.latestSeq ?? null,
      latestEvent: count?.latestEvent ?? 0n,
      lastActivityAt: count?.lastActivityAt ?? room.createdAt,
      muted: preferences.some((p) => p.muted && p.scope === 'room' && p.targetId === room.id),
    };
  });
  const servers = snapshot.servers.map((access) => ({
    ...access.member.server,
    permissions: access.permissions,
    rooms: decorated.filter((r) => r.serverId === access.member.serverId),
    muted: preferences.some(
      (p) => p.muted && p.scope === 'server' && p.targetId === access.member.serverId,
    ),
  }));
  const dms = decorated
    .filter((r) => r.kind !== 'TEXT')
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
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
    if (room.kind === 'DIRECT')
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
    assert(
      !(await tx.sendCancellation.findUnique({
        where: { authorId_roomId_nonce: { authorId: userId, roomId, nonce: input.nonce } },
      })),
      409,
      'This send was discarded. Create a new message to send it.',
    );
    if (
      [...mentionTokens(input.content)].some((t) => t === 'everyone' || t === 'here') &&
      room.kind === 'TEXT'
    )
      assert(
        has(permissions, P.MENTION_EVERYONE),
        403,
        'You cannot mention everyone in this channel.',
      );
    if (input.attachmentIds.length) {
      await lock(tx, 'storage');
      assert(has(permissions, P.ATTACH_FILES), 403, 'You cannot attach files in this channel.');
      const files = await tx.attachment.findMany({
        where: {
          id: { in: input.attachmentIds },
          ownerId: userId,
          messageId: null,
          createdAt: { gt: new Date(Date.now() - 86400000) },
        },
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
    await persistMentions(tx, room, userId, message.id, input.content);
    await event(tx, 'room', roomId, 'messages', message.id);
    return tx.message.findUniqueOrThrow({ where: { id: message.id }, include: messageInclude });
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
      if (access.room.kind === 'DIRECT')
        await dmSendAccess(
          userId,
          access.room.members.map((m) => m.userId),
          tx,
        );
      if (
        [...mentionTokens(content)].some((t) => t === 'everyone' || t === 'here') &&
        access.server
      )
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
    await persistMentions(tx, access.room, message.authorId, messageId, content ?? '');
    await event(tx, 'room', found.roomId, 'messages', result.id);
    return tx.message.findUniqueOrThrow({ where: { id: result.id }, include: messageInclude });
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
    if (room.kind === 'DIRECT')
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
  const snapshot = await accessibleRooms(userId);
  const ids = snapshot.rooms
    .filter(
      (r) =>
        has(r.permissions, P.READ_HISTORY) &&
        (!roomId || r.id === roomId) &&
        (!serverId || r.serverId === serverId),
    )
    .map((r) => r.id);
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

async function persistMentions(
  tx: Prisma.TransactionClient,
  room: { id: string; serverId: string | null },
  authorId: string,
  messageId: string,
  content: string,
) {
  const tokens = mentionTokens(content);
  await tx.messageMention.deleteMany({ where: { messageId } });
  if (!tokens.size) return;
  const members = room.serverId
    ? (
        await tx.membership.findMany({
          where: { serverId: room.serverId },
          include: { user: { select: { id: true, username: true } } },
        })
      ).map((m) => m.user)
    : (
        await tx.roomMember.findMany({
          where: { roomId: room.id },
          include: { user: { select: { id: true, username: true } } },
        })
      ).map((m) => m.user);
  const recipients = members.filter(
    (u) =>
      u.id !== authorId && (tokens.has(u.username) || tokens.has('everyone') || tokens.has('here')),
  );
  await tx.messageMention.createMany({
    data: recipients.map((u) => ({ messageId, userId: u.id })),
    skipDuplicates: true,
  });
}
export async function messageContext(userId: string, roomId: string, messageId: string) {
  await roomAccess(userId, roomId, P.READ_HISTORY);
  const target = await db.message.findFirst({ where: { id: messageId, roomId } });
  assert(target, 404, 'This message is no longer available in the conversation.');
  const [older, newer] = await Promise.all([
    db.message.findMany({
      where: { roomId, seq: { lt: target.seq } },
      orderBy: { seq: 'desc' },
      take: 25,
      include: messageInclude,
    }),
    db.message.findMany({
      where: { roomId, seq: { gte: target.seq } },
      orderBy: { seq: 'asc' },
      take: 26,
      include: messageInclude,
    }),
  ]);
  const messages = [...older.reverse(), ...newer];
  return {
    messages,
    hasMore: older.length === 25,
    hasNewer: newer.length === 26,
    olderCursor: messages[0]?.seq,
    newerCursor: messages.at(-1)?.seq,
  };
}
export async function sendStatus(userId: string, roomId: string, nonce: string) {
  await roomAccess(userId, roomId); // Author scoped; no READ_HISTORY requirement.
  const message = await db.message.findUnique({
    where: { authorId_roomId_nonce: { authorId: userId, roomId, nonce } },
    include: messageInclude,
  });
  return { status: message ? 'sent' : 'not-found', message };
}
export async function mentionHistory(userId: string, before?: string) {
  const { rooms } = await accessibleRooms(userId);
  const messages = await db.message.findMany({
    where: {
      roomId: { in: rooms.filter((r) => has(r.permissions, P.READ_HISTORY)).map((r) => r.id) },
      deletedAt: null,
      mentions: { some: { userId } },
      ...(before ? { seq: { lt: BigInt(before) } } : {}),
    },
    orderBy: { seq: 'desc' },
    take: 50,
    include: messageInclude,
  });
  return { messages, nextCursor: messages.length === 50 ? messages.at(-1)?.seq : null };
}
export async function notificationMessages(
  userId: string,
  after: string,
  afterEvent?: string,
  untilEvent?: string,
) {
  const { rooms } = await accessibleRooms(userId);
  const roomIds = rooms.filter((r) => has(r.permissions, P.READ_HISTORY)).map((r) => r.id);
  const events = afterEvent
    ? await db.event.findMany({
        where: {
          id: { gt: BigInt(afterEvent), ...(untilEvent ? { lte: BigInt(untilEvent) } : {}) },
          scope: 'room',
          type: 'messages',
          messageId: { not: null },
          targetId: { in: roomIds },
        },
        orderBy: { id: 'asc' },
        take: 101,
        select: { id: true, messageId: true },
      })
    : null;
  const page = events?.slice(0, 100);
  const messages = await db.message.findMany({
    where: {
      roomId: { in: roomIds },
      ...(page ? { id: { in: page.map((e) => e.messageId!) } } : { seq: { gt: BigInt(after) } }),
      authorId: { not: userId },
      deletedAt: null,
      OR: [{ mentions: { some: { userId } } }, { room: { kind: { not: 'TEXT' } } }],
    },
    orderBy: { seq: 'asc' },
    take: 100,
    include: messageInclude,
  });
  return events
    ? {
        messages,
        nextCursor: page?.at(-1)?.id.toString() ?? untilEvent ?? afterEvent!,
        hasMore: events.length > 100,
      }
    : messages;
}

export async function cancelSend(userId: string, roomId: string, nonce: string) {
  return roomTransaction(roomId, async (tx) => {
    await roomAccess(userId, roomId, P.VIEW_CHANNEL, tx);
    const key = { authorId: userId, roomId, nonce };
    const message = await tx.message.findUnique({
      where: { authorId_roomId_nonce: key },
      include: messageInclude,
    });
    if (message) return { status: 'sent', message };
    await tx.sendCancellation.upsert({
      where: { authorId_roomId_nonce: key },
      create: key,
      update: {},
    });
    return { status: 'cancelled', message: null };
  });
}
