import { z, ZodError } from 'zod';
import { verify } from '@node-rs/argon2';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { AppError, assert, json } from './errors';
import {
  checkOrigin,
  requireUser,
  cookieToken,
  digest,
  instance,
  login,
  register,
  newSession,
  sessionCookie,
  consumeInvite,
  recoveryCodes,
  recover,
  passwordHash,
  rateLimit,
  personSelect,
  sendAccountEmail,
} from './auth';
import {
  requireAdmin,
  requireServerPermission,
  serverAccess,
  roomAccess,
  accessibleRooms,
  canDm,
  isBlocked,
} from './access';
import { P } from './permissions';
import {
  workspace,
  history,
  messageContext,
  sendStatus,
  cancelSend,
  mentionHistory,
  notificationMessages,
  sendMessage,
  modifyMessage,
  react,
  markRead,
  searchMessages,
  lock,
  event,
  audit,
  roomTransaction,
} from './chat';
import {
  createServer,
  serverDetails,
  updateServer,
  deleteServer,
  categoryMutation,
  channelMutation,
  roleMutation,
  assignRoles,
  setOverride,
  moderate,
  createInvite,
  createDm,
  serverTransaction,
} from './community';
import { upload, download } from './uploads';

const id = z.string().min(1).max(100);
const name = z.string().trim().min(1).max(80);
const password = z.string().min(10).max(128);
const username = z.string().regex(/^[a-zA-Z0-9_]{3,32}$/);
const numeric = z
  .string()
  .regex(/^\d{1,19}$/)
  .refine(
    (value) => BigInt(value) <= 9223372036854775807n,
    'Value exceeds the database integer limit.',
  );
async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const reader = request.body?.getReader();
  assert(reader, 400, 'A request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      assert(size <= 65536, 413, 'Request body is too large.');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new AppError(400, 'Invalid JSON.');
  }
  return schema.parse(value);
}
const ok = () => json({ ok: true });
export async function handleRequest(request: Request) {
  try {
    return await dispatch(request);
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    if (error instanceof ZodError)
      return json(
        {
          error: error.issues.map((i) => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; '),
        },
        400,
      );
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002')
        return json({ error: 'That name or value is already in use.' }, 409);
      if (error.code === 'P2025' || error.code === 'P2003')
        return json({ error: 'The requested item is no longer available.' }, 404);
    }
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'request.failed',
        path: new URL(request.url).pathname,
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url),
    parts = url.pathname.split('/').filter(Boolean).slice(1);
  const [area, key, action, subkey, subaction] = parts;
  const method = request.method;
  const page = z.coerce
    .number()
    .int()
    .min(0)
    .max(1000000)
    .parse(url.searchParams.get('page') ?? 0);
  const pagination = { skip: page * 100, take: 100 };
  checkOrigin(request);
  if (area === 'health' && method === 'GET') {
    await db.$queryRaw`SELECT 1`;
    return json({ status: 'ok' });
  }
  if (area === 'public' && method === 'GET') {
    const s = await instance();
    return json({
      name: s.name,
      publicRegistration: s.publicRegistration,
      smtp: !!process.env.SMTP_URL,
      needsBootstrap: !(await db.user.findFirst({ where: { isAdmin: true } })),
    });
  }
  if (area === 'auth') {
    const ip = request.headers.get('x-ripcord-client-ip') ?? 'unknown';
    await rateLimit(`auth:ip:${ip}`, 30, 600);
    if (key === 'login' && method === 'POST') {
      const input = await body(request, z.object({ username, password: z.string().max(128) }));
      await rateLimit(`login:${input.username.toLowerCase()}`, 10, 600);
      const token = await login(input.username, input.password);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    if (key === 'register' && method === 'POST') {
      const input = await body(
        request,
        z.object({ username, displayName: name, password, invite: id.optional() }),
      );
      const result = await register(input),
        token = await newSession(result.user.id);
      return json({ codes: result.codes, serverId: result.serverId }, 201, {
        'Set-Cookie': sessionCookie(token),
      });
    }
    if (key === 'recover' && method === 'POST') {
      const input = await body(request, z.object({ username, code: id, password }));
      await recover(input.username, input.code, input.password);
      return ok();
    }
    if (key === 'forgot' && method === 'POST') {
      const input = await body(request, z.object({ email: z.email().max(254) }));
      const user = await db.user.findUnique({ where: { email: input.email.toLowerCase() } });
      if (user?.emailVerified && !user.suspended)
        await sendAccountEmail(user, 'reset', user.email!);
      return json({
        message: 'If that verified email belongs to an account, a reset link will be sent.',
      });
    }
    if ((key === 'reset' || key === 'verify') && method === 'POST') {
      const input = await body(request, z.object({ token: id, password: password.optional() }));
      const pass = input.password ? await passwordHash(input.password) : undefined;
      await db.$transaction(async (tx) => {
        const token = await tx.accountToken.findUnique({
          where: { hash: digest(input.token) },
          include: { user: true },
        });
        assert(
          token && !token.user.suspended && token.expiresAt > new Date() && token.purpose === key,
          400,
          'This link is invalid or expired.',
        );
        const used = await tx.accountToken.deleteMany({ where: { hash: token.hash } });
        assert(used.count === 1, 400, 'This link was already used.');
        if (key === 'reset') {
          assert(pass, 400, 'A new password is required.');
          await tx.user.update({ where: { id: token.userId }, data: { passwordHash: pass } });
          await tx.session.deleteMany({ where: { userId: token.userId } });
        } else {
          assert(token.email, 400, 'Invalid email verification.');
          await tx.user.update({
            where: { id: token.userId },
            data: { email: token.email, emailVerified: true },
          });
        }
        await tx.accountToken.deleteMany({ where: { userId: token.userId } });
      });
      return ok();
    }
    if (key === 'logout' && method === 'POST') {
      const token = cookieToken(request.headers.get('cookie'));
      if (token) await db.session.deleteMany({ where: { id: digest(token) } });
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', true) });
    }
  }
  if (area === 'invites' && key && method === 'GET') {
    const invite = await db.invite.findUnique({
      where: { code: key },
      include: { server: { select: { id: true, name: true, description: true, icon: true } } },
    });
    assert(
      invite &&
        !invite.revoked &&
        (!invite.expiresAt || invite.expiresAt > new Date()) &&
        (invite.maxUses === null || invite.uses < invite.maxUses),
      404,
      'Invitation unavailable.',
    );
    return json({
      kind: invite.serverId ? 'community' : 'instance',
      server: invite.server,
      serverId: invite.serverId,
      serverName: invite.server?.name ?? 'this instance',
    });
  }
  const user = await requireUser(request);
  await rateLimit(`user:${user.id}`, 300, 60);
  if (area === 'workspace' && method === 'GET') return json(await workspace(user.id));
  if (area === 'me') {
    if (!key && method === 'PATCH') {
      const input = await body(
        request,
        z.object({
          displayName: name.optional(),
          friendsOnly: z.boolean().optional(),
          notifyMentions: z.boolean().optional(),
          notifyDms: z.boolean().optional(),
          avatarId: id.nullable().optional(),
        }),
      );
      await db.$transaction(async (tx) => {
        await lock(tx, 'storage');
        if (input.avatarId)
          assert(
            await tx.attachment.findFirst({
              where: {
                id: input.avatarId,
                ownerId: user.id,
                messageId: null,
                mime: { startsWith: 'image/' },
                size: { lte: 5242880 },
              },
            }),
            400,
            'Choose a raster image up to 5 MB.',
          );
        await tx.user.update({ where: { id: user.id }, data: input });
        await event(tx, 'instance', 'instance', 'profiles');
      });
      return ok();
    }
    if (key === 'sessions' && method === 'GET')
      return json(
        await db.session.findMany({
          where: { userId: user.id },
          select: { id: true, createdAt: true, expiresAt: true },
        }),
      );
    if (key === 'sessions' && method === 'DELETE') {
      await db.session.deleteMany({ where: { userId: user.id } });
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', true) });
    }
    if (key === 'password' && method === 'POST') {
      const input = await body(
        request,
        z.object({ currentPassword: z.string().max(128), password }),
      );
      assert(
        await verify(user.passwordHash, input.currentPassword),
        403,
        'Current password is incorrect.',
      );
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash: await passwordHash(input.password) },
        });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.accountToken.deleteMany({ where: { userId: user.id } });
      });
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', true) });
    }
    if (key === 'recovery' && method === 'POST') {
      const input = await body(request, z.object({ password: z.string().max(128) }));
      assert(await verify(user.passwordHash, input.password), 403, 'Password is incorrect.');
      return json({ codes: await db.$transaction((tx) => recoveryCodes(tx, user.id)) });
    }
    if (key === 'email' && method === 'POST') {
      const input = await body(
        request,
        z.object({ email: z.email().max(254), password: z.string().max(128) }),
      );
      assert(await verify(user.passwordHash, input.password), 403, 'Password is incorrect.');
      await sendAccountEmail(user, 'verify', input.email.toLowerCase());
      return ok();
    }
  }
  if (area === 'users' && method === 'GET') {
    const q = z.string().min(2).max(32).parse(url.searchParams.get('q'));
    return json(
      await db.user.findMany({
        where: {
          suspended: false,
          username: { startsWith: q.toLowerCase() },
          id: { not: user.id },
        },
        select: personSelect,
        take: 15,
      }),
    );
  }
  if (area === 'relationships' && method === 'POST') {
    const input = await body(
      request,
      z.object({ userId: id, action: z.enum(['request', 'accept', 'remove', 'block', 'unblock']) }),
    );
    assert(
      input.userId !== user.id && (await db.user.findUnique({ where: { id: input.userId } })),
      400,
      'Choose another user.',
    );
    await db.$transaction(async (tx) => {
      await lock(tx, `relationship:${[user.id, input.userId].sort().join(':')}`);
      const pair = [
        { fromId: user.id, toId: input.userId },
        { fromId: input.userId, toId: user.id },
      ];
      if (input.action === 'block') {
        await tx.relationship.deleteMany({ where: { OR: pair, kind: { not: 'BLOCK' } } });
        await tx.relationship.upsert({
          where: { fromId_toId_kind: { ...pair[0], kind: 'BLOCK' } },
          create: { ...pair[0], kind: 'BLOCK' },
          update: {},
        });
      } else if (input.action === 'unblock')
        await tx.relationship.deleteMany({ where: { ...pair[0], kind: 'BLOCK' } });
      else if (input.action === 'remove')
        await tx.relationship.deleteMany({ where: { OR: pair, kind: { not: 'BLOCK' } } });
      else {
        assert(
          !(await isBlocked(user.id, input.userId, tx)),
          403,
          'Friendship is unavailable between these users.',
        );
        if (input.action === 'accept') {
          assert(
            await tx.relationship.findFirst({ where: { ...pair[1], kind: 'REQUEST' } }),
            400,
            'Friend request not found.',
          );
          await tx.relationship.deleteMany({ where: { OR: pair, kind: 'REQUEST' } });
          await tx.relationship.upsert({
            where: { fromId_toId_kind: { ...pair[0], kind: 'FRIEND' } },
            create: { ...pair[0], kind: 'FRIEND' },
            update: {},
          });
        } else {
          assert(
            !(await tx.relationship.findFirst({
              where: { OR: pair, kind: { in: ['FRIEND', 'REQUEST'] } },
            })),
            409,
            'A friendship or request already exists.',
          );
          await tx.relationship.create({ data: { ...pair[0], kind: 'REQUEST' } });
        }
      }
      for (const target of [user.id, input.userId])
        await event(tx, 'user', target, 'relationships');
    });
    return ok();
  }
  if (area === 'invites' && method === 'POST' && key) {
    const invite = await db.$transaction((tx) => consumeInvite(tx, key, user.id));
    const joined = await workspace(user.id);
    return json({
      kind: invite.serverId ? 'community' : 'instance',
      serverId: invite.serverId,
      server: joined.servers.find((s) => s.id === invite.serverId) ?? null,
    });
  }
  if (area === 'servers') {
    if (!key && method === 'POST') {
      const input = await body(
        request,
        z.object({ name, description: z.string().max(500).optional() }),
      );
      return json(await createServer(user.id, input.name, input.description), 201);
    }
    assert(key, 404, 'Server not found.');
    if (!action && method === 'GET') return json(await serverDetails(user.id, key));
    if (!action && method === 'PATCH')
      return json(
        await updateServer(
          user.id,
          key,
          await body(
            request,
            z.object({
              name: name.optional(),
              description: z.string().max(500).optional(),
              icon: z.string().max(4).optional(),
              ownerId: id.optional(),
            }),
          ),
        ),
      );
    if (!action && method === 'DELETE') {
      await deleteServer(user.id, key);
      return ok();
    }
    if (action === 'leave' && method === 'POST') {
      await serverTransaction(key, async (tx) => {
        const access = await serverAccess(user.id, key, tx);
        assert(!access.owner, 400, 'Transfer ownership before leaving.');
        await tx.membership.delete({ where: { id: access.member.id } });
        await event(tx, 'server', key, 'membership');
        await event(tx, 'user', user.id, 'permissions');
      });
      return ok();
    }
    if (action === 'categories' && ['POST', 'PATCH', 'DELETE'].includes(method)) {
      const input =
        method === 'DELETE'
          ? {}
          : await body(
              request,
              z.object({
                name: name.optional(),
                position: z.number().int().min(0).max(10000).optional(),
              }),
            );
      if (method !== 'POST') assert(subkey, 400, 'Category ID is required.');
      await categoryMutation(user.id, key, input, subkey, method === 'DELETE');
      return ok();
    }
    if (action === 'channels' && ['POST', 'PATCH', 'DELETE'].includes(method)) {
      const input =
        method === 'DELETE'
          ? {}
          : await body(
              request,
              z.object({
                name: z
                  .string()
                  .trim()
                  .min(1)
                  .max(80)
                  .regex(/^[\p{L}\p{N}_-]+$/u)
                  .optional(),
                topic: z.string().max(500).optional(),
                categoryId: id.nullable().optional(),
                position: z.number().int().min(0).max(10000).optional(),
                slowMode: z.number().int().min(0).max(21600).optional(),
                synchronized: z.boolean().optional(),
                privateRoleId: id.optional(),
              }),
            );
      if (method !== 'POST') assert(subkey, 400, 'Channel ID is required.');
      return json(
        (await channelMutation(user.id, key, input, subkey, method === 'DELETE')) ?? { ok: true },
      );
    }
    if (action === 'roles' && ['POST', 'PATCH', 'DELETE'].includes(method)) {
      const input =
        method === 'DELETE'
          ? {}
          : await body(
              request,
              z.object({
                name: name.optional(),
                color: z
                  .string()
                  .regex(/^#[0-9a-fA-F]{6}$/)
                  .optional(),
                position: z.number().int().min(1).max(10000).optional(),
                permissions: numeric.optional(),
              }),
            );
      if (method !== 'POST') assert(subkey, 400, 'Role ID is required.');
      return json(
        (await roleMutation(user.id, key, input, subkey, method === 'DELETE')) ?? { ok: true },
      );
    }
    if (action === 'overrides' && ['PUT', 'DELETE'].includes(method)) {
      const input = await body(
        request,
        z.object({
          scope: z.enum(['room', 'category']),
          id,
          targetType: z.enum(['ROLE', 'MEMBER']),
          targetId: id,
          allow: numeric,
          deny: numeric,
        }),
      );
      await setOverride(user.id, key, input.scope, input.id, input, method === 'DELETE');
      return ok();
    }
    if (action === 'members' && subkey && subaction === 'roles' && method === 'PUT') {
      const input = await body(request, z.object({ roleIds: z.array(id).max(100) }));
      await assignRoles(user.id, key, subkey, input.roleIds);
      return ok();
    }
    if (action === 'members' && subkey && method === 'POST') {
      const input = await body(
        request,
        z.object({
          action: z.enum(['kick', 'ban', 'timeout', 'nickname']),
          reason: z.string().max(500).default(''),
          seconds: z.number().int().min(0).max(2419200).optional(),
          nickname: z.string().max(32).nullable().optional(),
        }),
      );
      await moderate(
        user.id,
        key,
        subkey,
        input.action,
        input.reason,
        input.seconds,
        input.nickname,
      );
      return ok();
    }
    if (action === 'invites') {
      if (method === 'POST') {
        const input = await body(
          request,
          z.object({
            maxUses: z.number().int().min(1).max(100000).nullable().optional(),
            expiresHours: z.number().int().min(1).max(8760).nullable().optional(),
          }),
        );
        return json(await createInvite(user.id, key, input.maxUses, input.expiresHours));
      }
      await requireServerPermission(user.id, key, P.MANAGE_SERVER);
      if (method === 'GET')
        return json(
          await db.invite.findMany({
            where: { serverId: key },
            orderBy: { code: 'asc' },
            ...pagination,
          }),
        );
      if (method === 'DELETE' && subkey) {
        await db.invite.updateMany({
          where: { code: subkey, serverId: key },
          data: { revoked: true },
        });
        return ok();
      }
    }
    if (action === 'audit' && method === 'GET') {
      await requireServerPermission(user.id, key, P.VIEW_AUDIT_LOG);
      return json(
        await readableAudit(
          await db.auditLog.findMany({
            where: { serverId: key },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            ...pagination,
          }),
        ),
      );
    }
    if (action === 'bans') {
      await requireServerPermission(user.id, key, P.BAN_MEMBERS);
      if (method === 'GET') {
        const bans = await db.ban.findMany({
          where: { serverId: key },
          orderBy: { userId: 'asc' },
          ...pagination,
        });
        const people = await db.user.findMany({
          where: { id: { in: bans.map((b) => b.userId) } },
          select: personSelect,
        });
        return json(
          bans.map((b) => ({ ...b, user: people.find((p) => p.id === b.userId) ?? null })),
        );
      }
      if (method === 'DELETE' && subkey) {
        await serverTransaction(key, async (tx) => {
          await requireServerPermission(user.id, key, P.BAN_MEMBERS, tx);
          await tx.ban.deleteMany({ where: { serverId: key, userId: subkey } });
          await audit(tx, user.id, key, 'member.unban', subkey);
        });
        return ok();
      }
    }
  }
  if (area === 'dms' && method === 'POST') {
    const input = await body(
      request,
      z.object({ userIds: z.array(id).min(1).max(9), name: name.optional() }),
    );
    return json(await createDm(user.id, input.userIds, input.name));
  }
  if (area === 'mentions' && method === 'GET') {
    const before = url.searchParams.get('before');
    if (before) numeric.parse(before);
    return json(await mentionHistory(user.id, before ?? undefined));
  }
  if (area === 'notifications' && method === 'GET') {
    const afterEvent = url.searchParams.get('afterEvent');
    if (afterEvent) numeric.parse(afterEvent);
    const untilEvent = url.searchParams.get('untilEvent');
    if (untilEvent) numeric.parse(untilEvent);
    const after = numeric.parse(url.searchParams.get('after') ?? '0');
    return json(
      await notificationMessages(user.id, after, afterEvent ?? undefined, untilEvent ?? undefined),
    );
  }
  if (area === 'preferences' && method === 'PUT') {
    const input = await body(
      request,
      z.object({ scope: z.enum(['server', 'room']), targetId: id, muted: z.boolean() }),
    );
    if (input.scope === 'server') await serverAccess(user.id, input.targetId);
    else await roomAccess(user.id, input.targetId);
    const key = { userId: user.id, scope: input.scope, targetId: input.targetId };
    await db.notificationPreference.upsert({
      where: { userId_scope_targetId: key },
      create: { ...key, muted: input.muted },
      update: { muted: input.muted },
    });
    await event(db, 'user', user.id, 'preferences');
    return ok();
  }
  if (area === 'rooms' && key) {
    if (action === 'send-status' && subkey && method === 'GET')
      return json(await sendStatus(user.id, key, id.parse(subkey)));
    if (action === 'send-status' && subkey && method === 'DELETE')
      return json(await cancelSend(user.id, key, id.parse(subkey)));

    if (action === 'messages' && method === 'GET') {
      const target = url.searchParams.get('around');
      if (target) return json(await messageContext(user.id, key, id.parse(target)));
      const before = url.searchParams.get('before'),
        after = url.searchParams.get('after');
      if (before) numeric.parse(before);
      if (after) numeric.parse(after);
      return json(await history(user.id, key, before ?? undefined, after ?? undefined));
    }
    if (action === 'messages' && method === 'POST') {
      await rateLimit(`send:${user.id}`, 60, 60);
      const input = await body(
        request,
        z.object({
          content: z.string().max(10000),
          nonce: id,
          replyId: id.optional(),
          attachmentIds: z.array(id).max(20).default([]),
        }),
      );
      return json(await sendMessage(user.id, key, input), 201);
    }
    if (action === 'read' && method === 'POST') {
      const input = await body(request, z.object({ seq: numeric }));
      await markRead(user.id, key, input.seq);
      return ok();
    }
    if (
      (action === 'members' && ['POST', 'DELETE'].includes(method)) ||
      (!action && method === 'PATCH')
    ) {
      const input =
        method === 'DELETE'
          ? { userId: subkey ?? user.id }
          : await body(
              request,
              z.object({ userId: id.optional(), name: name.optional(), ownerId: id.optional() }),
            );
      await roomTransaction(key, async (tx) => {
        const { room } = await roomAccess(user.id, key, P.VIEW_CHANNEL, tx);
        assert(room.kind === 'GROUP', 400, 'Only group DMs have editable membership.');
        assert(
          room.ownerId === user.id || (method === 'DELETE' && input.userId === user.id),
          403,
          'Only the group owner can manage members.',
        );
        const affected = new Set(room.members.map((m) => m.userId));
        if (method === 'POST' && input.userId) {
          assert(room.members.length < 10, 400, 'Groups have a maximum of ten members.');
          for (const member of room.members) await canDm(member.userId, input.userId, tx);
          await tx.roomMember.create({ data: { roomId: key, userId: input.userId } });
          affected.add(input.userId);
        } else if (method === 'DELETE') {
          assert(input.userId, 400, 'Member is required.');
          const remaining = room.members.filter((m) => m.userId !== input.userId);
          if (!remaining.length) await tx.room.delete({ where: { id: key } });
          else {
            await tx.roomMember.deleteMany({ where: { roomId: key, userId: input.userId } });
            if (input.userId === room.ownerId)
              await tx.room.update({ where: { id: key }, data: { ownerId: remaining[0].userId } });
          }
        } else {
          if (input.ownerId) {
            assert(
              !(await tx.user.findFirst({ where: { id: input.ownerId, suspended: true } })),
              400,
              'A suspended account cannot own a group.',
            );
            assert(
              room.members.some((m) => m.userId === input.ownerId),
              400,
              'The new owner must be a group member.',
            );
          }
          await tx.room.update({
            where: { id: key },
            data: { name: input.name, ownerId: input.ownerId },
          });
        }
        for (const target of affected) await event(tx, 'user', target, 'conversations');
      });
      return ok();
    }
  }
  if (area === 'messages' && key) {
    if (!action && method === 'PATCH') {
      const input = await body(request, z.object({ content: z.string().max(10000) }));
      return json(await modifyMessage(user.id, key, input.content));
    }
    if (!action && method === 'DELETE') {
      await modifyMessage(user.id, key);
      return ok();
    }
    if (action === 'reactions' && method === 'POST') {
      const input = await body(request, z.object({ emoji: z.string().max(64) }));
      await react(user.id, key, input.emoji);
      return ok();
    }
  }
  if (area === 'search' && method === 'GET') {
    const q = z.string().trim().min(1).max(200).parse(url.searchParams.get('q'));
    return json(
      await searchMessages(
        user.id,
        q,
        url.searchParams.get('roomId') ?? undefined,
        url.searchParams.get('serverId') ?? undefined,
      ),
    );
  }
  if (area === 'uploads') {
    if (key === 'staged' && method === 'POST') {
      const input = await body(request, z.object({ ids: z.array(id).max(20) }));
      const files = await db.attachment.findMany({
        where: {
          id: { in: input.ids },
          ownerId: user.id,
          messageId: null,
          createdAt: { gt: new Date(Date.now() - 86400000) },
        },
        select: { id: true },
      });
      return json({ available: files.map((f) => f.id) });
    }
    if (!key && method === 'POST') {
      await rateLimit(`uploads:${user.id}`, 20, 60);
      return json(await upload(request, user.id), 201);
    }
    if (key && method === 'GET') return download(user.id, key);
  }
  if (area === 'reports') {
    if (method === 'POST') {
      const input = await body(
        request,
        z.object({ messageId: id, reason: z.string().trim().min(1).max(1000) }),
      );
      const message = await db.message.findUnique({ where: { id: input.messageId } });
      assert(message && !message.deletedAt, 404, 'Message unavailable.');
      const access = await roomAccess(user.id, message.roomId, P.READ_HISTORY);
      return json(
        await db.report.create({
          data: { ...input, reporterId: user.id, serverId: access.room.serverId },
        }),
      );
    }
    const serverId = url.searchParams.get('serverId');
    if (serverId) await requireServerPermission(user.id, serverId, P.MANAGE_MESSAGES);
    else requireAdmin(user);
    if (method === 'GET') {
      let reportIds: string[] | undefined;
      if (serverId) {
        const access = await serverAccess(user.id, serverId),
          snapshot = await accessibleRooms(user.id);
        const roomIds = snapshot.rooms
          .filter(
            (r) =>
              r.serverId === serverId &&
              (r.permissions & (P.READ_HISTORY | P.MANAGE_MESSAGES)) ===
                (P.READ_HISTORY | P.MANAGE_MESSAGES),
          )
          .map((r) => r.id);
        const ids = await db.$queryRaw<
          { id: string }[]
        >`SELECT r."id" FROM "Report" r LEFT JOIN "Message" m ON m."id" = r."messageId" WHERE r."serverId" = ${serverId} AND (m."roomId" = ANY(${roomIds}::text[]) OR (m."id" IS NULL AND ${(access.permissions & P.MANAGE_SERVER) !== 0n})) ORDER BY r."createdAt" DESC, r."id" DESC OFFSET ${pagination.skip} LIMIT 100`;
        reportIds = ids.map((r) => r.id);
      }
      const reports = await db.report.findMany({
        where: { serverId: serverId ?? null, ...(reportIds ? { id: { in: reportIds } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pagination,
        ...(reportIds ? { skip: 0 } : {}),
      });
      const messages = await db.message.findMany({
        where: { id: { in: reports.map((r) => r.messageId) } },
        select: {
          id: true,
          roomId: true,
          content: true,
          deletedAt: true,
          author: { select: personSelect },
        },
      });
      const permitted = [];
      for (const report of reports) {
        const message = messages.find((m) => m.id === report.messageId) ?? null;
        permitted.push({ ...report, message });
      }
      return json(permitted);
    }
    if (key && method === 'PATCH') {
      const report = await db.report.findFirst({ where: { id: key, serverId: serverId ?? null } });
      assert(report, 404, 'Report not found.');
      if (serverId) {
        const message = await db.message.findUnique({ where: { id: report.messageId } });
        if (message) await roomAccess(user.id, message.roomId, P.READ_HISTORY | P.MANAGE_MESSAGES);
        else await requireServerPermission(user.id, serverId, P.MANAGE_SERVER);
      }
      await db.report.updateMany({
        where: { id: key, serverId: serverId ?? null },
        data: { resolvedAt: new Date(), resolvedBy: user.id },
      });
      return ok();
    }
  }
  if (area === 'admin') {
    requireAdmin(user);
    if (key === 'settings' && method === 'GET') return json(await instance());
    if (key === 'settings' && method === 'PATCH') {
      const input = await body(
        request,
        z.object({
          name: name.optional(),
          publicRegistration: z.boolean().optional(),
          maxFileBytes: z.number().int().min(1024).max(104857600).optional(),
          maxAttachments: z.number().int().min(1).max(20).optional(),
          maxMessageLength: z.number().int().min(1).max(10000).optional(),
          maxStorageBytes: numeric.optional(),
        }),
      );
      await db.$transaction(async (tx) => {
        await tx.instance.update({
          where: { id: 'instance' },
          data: {
            ...input,
            maxStorageBytes: input.maxStorageBytes ? BigInt(input.maxStorageBytes) : undefined,
          },
        });
        await audit(tx, user.id, null, 'instance.settings');
        await event(tx, 'instance', 'instance', 'settings');
      });
      return ok();
    }
    if (key === 'users' && method === 'GET')
      return json(
        await db.user.findMany({
          select: { ...personSelect, suspended: true, isAdmin: true, createdAt: true },
          ...pagination,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    if (key === 'users' && action && method === 'PATCH') {
      const input = await body(request, z.object({ suspended: z.boolean() }));
      await db.$transaction(async (tx) => {
        const target = await tx.user.findUnique({ where: { id: action } });
        assert(
          target && !target.isAdmin,
          403,
          'Administrators cannot be suspended through the web interface.',
        );
        await tx.user.update({ where: { id: action }, data: input });
        if (input.suspended) await tx.session.deleteMany({ where: { userId: action } });
        await audit(
          tx,
          user.id,
          null,
          input.suspended ? 'account.suspend' : 'account.restore',
          action,
        );
        await event(tx, 'user', action, 'account');
      });
      return ok();
    }
    if (key === 'invites' && method === 'POST') {
      const input = await body(
        request,
        z.object({
          maxUses: z.number().int().min(1).nullable().optional(),
          expiresHours: z.number().int().min(1).max(8760).nullable().optional(),
        }),
      );
      return json(await createInvite(user.id, null, input.maxUses, input.expiresHours));
    }
    if (key === 'invites' && method === 'GET')
      return json(
        await db.invite.findMany({
          where: { serverId: null },
          orderBy: { code: 'asc' },
          ...pagination,
        }),
      );
    if (key === 'invites' && action && method === 'DELETE') {
      await db.invite.updateMany({
        where: { code: action, serverId: null },
        data: { revoked: true },
      });
      return ok();
    }
    if (key === 'audit' && method === 'GET')
      return json(
        await readableAudit(
          await db.auditLog.findMany({
            where: { serverId: null },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            ...pagination,
          }),
        ),
      );
    if (key === 'storage' && method === 'GET')
      return json({
        ...(await db.attachment.aggregate({ _sum: { size: true }, _count: true })),
        quota: (await instance()).maxStorageBytes,
      });
  }
  throw new AppError(404, 'Endpoint not found.');
}

async function readableAudit(entries: Awaited<ReturnType<typeof db.auditLog.findMany>>) {
  const ids = entries.flatMap((e) => [e.actorId, ...(e.targetId ? [e.targetId] : [])]);
  const [people, rooms, roles, categories] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids } }, select: personSelect }),
    db.room.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    db.role.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    db.category.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ]);
  return entries.map((e) => ({
    ...e,
    actor: people.find((p) => p.id === e.actorId) ?? null,
    targetName:
      people.find((p) => p.id === e.targetId)?.displayName ??
      [...rooms, ...roles, ...categories].find((p) => p.id === e.targetId)?.name ??
      e.targetId,
  }));
}
