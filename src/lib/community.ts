import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { assert, AppError } from './errors';
import {
  requireServerPermission,
  serverAccess,
  targetMember,
  canDm,
  accessibleRooms,
} from './access';
import { ALL, DEFAULT, P, has } from './permissions';
import { lock, audit, event } from './chat';
import { personSelect } from './auth';

export async function serverTransaction<T>(
  serverId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return db.$transaction(
    async (tx) => {
      await lock(tx, `server:${serverId}`);
      return fn(tx);
    },
    { timeout: 20000 },
  );
}
export async function createServer(userId: string, name: string, description = '') {
  return db.$transaction(async (tx) => {
    const server = await tx.server.create({
      data: {
        name,
        description,
        ownerId: userId,
        members: { create: { userId } },
        roles: {
          create: [
            { name: '@everyone', everyone: true, permissions: DEFAULT },
            {
              name: 'Moderator',
              position: 1,
              color: '#51c5ad',
              permissions:
                DEFAULT |
                P.MANAGE_MESSAGES |
                P.KICK_MEMBERS |
                P.BAN_MEMBERS |
                P.MODERATE_MEMBERS |
                P.VIEW_AUDIT_LOG,
            },
          ],
        },
      },
    });
    const category = await tx.category.create({
      data: { serverId: server.id, name: 'Text channels' },
    });
    await tx.room.createMany({
      data: [
        {
          serverId: server.id,
          categoryId: category.id,
          name: 'general',
          topic: 'A place for everyone to connect.',
        },
        {
          serverId: server.id,
          categoryId: category.id,
          name: 'introductions',
          position: 1,
          topic: 'Say hello. Make yourself at home.',
        },
      ],
    });
    await audit(tx, userId, server.id, 'server.create', server.id);
    return server;
  });
}
export async function serverDetails(userId: string, serverId: string) {
  const access = await serverAccess(userId, serverId);
  const members = await db.membership.findMany({
    where: { serverId },
    include: { user: { select: personSelect }, roles: { include: { role: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  const categories = await db.category.findMany({
    where: { serverId },
    include: { overrides: true },
    orderBy: { position: 'asc' },
  });
  const rooms = await db.room.findMany({
    where: { serverId },
    include: { overrides: true },
    orderBy: { position: 'asc' },
  });
  const manager = (access.permissions & (P.MANAGE_CHANNELS | P.MANAGE_ROLES)) !== 0n;
  const snapshot = await accessibleRooms(userId);
  const visibleIds = new Set(snapshot.rooms.map((r) => r.id));
  const visible = rooms
    .filter((r) => visibleIds.has(r.id))
    .map((room) => (manager ? room : { ...room, overrides: undefined }));
  return {
    ...access.server,
    permissions: access.permissions,
    position: access.position,
    members,
    rooms: visible,
    categories: manager ? categories : categories.map((c) => ({ ...c, overrides: undefined })),
  };
}
export async function updateServer(
  userId: string,
  serverId: string,
  data: { name?: string; description?: string; icon?: string; ownerId?: string },
) {
  return serverTransaction(serverId, async (tx) => {
    const access = await requireServerPermission(userId, serverId, P.MANAGE_SERVER, tx);
    if (data.ownerId) {
      assert(access.owner, 403, 'Only the owner can transfer ownership.');
      await serverAccess(data.ownerId, serverId, tx);
      assert(
        !(await tx.user.findFirst({ where: { id: data.ownerId, suspended: true } })),
        400,
        'A suspended account cannot own a server.',
      );
    }
    const result = await tx.server.update({ where: { id: serverId }, data });
    await audit(tx, userId, serverId, data.ownerId ? 'server.transfer' : 'server.update', serverId);
    await event(tx, 'server', serverId, 'permissions');
    return result;
  });
}
export async function deleteServer(userId: string, serverId: string) {
  return serverTransaction(serverId, async (tx) => {
    const access = await serverAccess(userId, serverId, tx);
    assert(access.owner, 403, 'Only the owner can delete the server.');
    const members = await tx.membership.findMany({ where: { serverId }, select: { userId: true } });
    for (const member of members) await event(tx, 'user', member.userId, 'permissions');
    await tx.server.delete({ where: { id: serverId } });
  });
}
export async function categoryMutation(
  userId: string,
  serverId: string,
  data: { name?: string; position?: number },
  categoryId?: string,
  remove = false,
) {
  return serverTransaction(serverId, async (tx) => {
    await requireServerPermission(userId, serverId, P.MANAGE_CHANNELS, tx);
    if (categoryId)
      assert(
        await tx.category.findFirst({ where: { id: categoryId, serverId } }),
        404,
        'Category not found.',
      );
    if (remove) {
      // Preserve effective permissions when a synchronized channel loses its category.
      const category = await tx.category.findUniqueOrThrow({
        where: { id: categoryId! },
        include: { overrides: true, rooms: true },
      });
      for (const room of category.rooms.filter((r) => r.synchronized)) {
        await tx.permissionOverride.deleteMany({ where: { roomId: room.id } });
        await tx.permissionOverride.createMany({
          data: category.overrides.map((o) => ({
            roomId: room.id,
            targetType: o.targetType,
            targetId: o.targetId,
            allow: o.allow,
            deny: o.deny,
          })),
        });
        await tx.room.update({ where: { id: room.id }, data: { synchronized: false } });
      }
      await tx.category.delete({ where: { id: categoryId! } });
    } else if (categoryId) {
      if (data.position !== undefined)
        data.position = await reorderPositions(tx, 'category', serverId, categoryId, data.position);
      await tx.category.update({ where: { id: categoryId }, data });
    } else {
      assert(data.name, 400, 'Category name is required.');
      await tx.category.create({ data: { ...data, name: data.name, serverId } });
    }
    await audit(tx, userId, serverId, remove ? 'category.delete' : 'category.update', categoryId);
    await event(tx, 'server', serverId, 'permissions');
  });
}
export async function channelMutation(
  userId: string,
  serverId: string,
  data: {
    name?: string;
    topic?: string;
    categoryId?: string | null;
    position?: number;
    slowMode?: number;
    synchronized?: boolean;
    privateRoleId?: string;
  },
  roomId?: string,
  remove = false,
) {
  return serverTransaction(serverId, async (tx) => {
    await requireServerPermission(userId, serverId, P.MANAGE_CHANNELS, tx);
    if (roomId)
      assert(
        await tx.room.findFirst({ where: { id: roomId, serverId, kind: 'TEXT' } }),
        404,
        'Channel not found.',
      );
    if (data.categoryId)
      assert(
        await tx.category.findFirst({ where: { id: data.categoryId, serverId } }),
        400,
        'Category does not belong to this server.',
      );
    const { privateRoleId, ...values } = data;
    let result;
    if (remove) await tx.room.delete({ where: { id: roomId! } });
    else if (roomId) {
      const current = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: { category: { include: { overrides: true } } },
      });
      const moving = values.categoryId !== undefined && values.categoryId !== current.categoryId;
      // A category move never implicitly adopts the destination permissions.
      if (moving) values.synchronized = false;
      if (values.synchronized === false) {
        if (current.synchronized && current.category) {
          await tx.permissionOverride.deleteMany({ where: { roomId } });
          await tx.permissionOverride.createMany({
            data: current.category.overrides.map((o) => ({
              roomId,
              targetType: o.targetType,
              targetId: o.targetId,
              allow: o.allow,
              deny: o.deny,
            })),
          });
        }
      }
      if (values.synchronized) {
        assert(
          values.categoryId ?? current.categoryId,
          400,
          'Choose a category before synchronizing.',
        );
        await tx.permissionOverride.deleteMany({ where: { roomId } });
      }
      if (values.position !== undefined && values.position !== current.position)
        values.position = await reorderPositions(tx, 'room', serverId, roomId, values.position);
      result = await tx.room.update({ where: { id: roomId }, data: values });
    } else {
      assert(values.name, 400, 'Channel name is required.');
      result = await tx.room.create({ data: { ...values, name: values.name, serverId } });
      if (privateRoleId) {
        const actor = await requireServerPermission(userId, serverId, P.MANAGE_ROLES, tx);
        const role = await tx.role.findFirst({
          where: { id: privateRoleId, serverId, everyone: false },
        });
        assert(role, 400, 'Choose a role from this server.');
        assert(
          actor.owner || role.position < actor.position,
          403,
          'You can only create overrides for roles below your highest role.',
        );
        assert(
          has(actor.permissions, P.VIEW_CHANNEL),
          403,
          'You cannot override permissions you do not have.',
        );
        const everyone = await tx.role.findFirstOrThrow({ where: { serverId, everyone: true } });
        await tx.room.update({ where: { id: result.id }, data: { synchronized: false } });
        await tx.permissionOverride.createMany({
          data: [
            { roomId: result.id, targetType: 'ROLE', targetId: everyone.id, deny: P.VIEW_CHANNEL },
            { roomId: result.id, targetType: 'ROLE', targetId: role.id, allow: P.VIEW_CHANNEL },
          ],
        });
      }
    }
    await audit(
      tx,
      userId,
      serverId,
      remove ? 'channel.delete' : 'channel.update',
      roomId ?? result?.id,
    );
    await event(tx, 'server', serverId, 'permissions');
    return result;
  });
}
export async function roleMutation(
  userId: string,
  serverId: string,
  data: { name?: string; color?: string; position?: number; permissions?: string },
  roleId?: string,
  remove = false,
) {
  return serverTransaction(serverId, async (tx) => {
    const actor = await requireServerPermission(userId, serverId, P.MANAGE_ROLES, tx);
    const role = roleId ? await tx.role.findFirst({ where: { id: roleId, serverId } }) : null;
    if (roleId) assert(role, 404, 'Role not found.');
    assert(
      actor.owner || !role || role.everyone || role.position < actor.position,
      403,
      'You can only manage roles below your highest role.',
    );
    assert(
      !role?.everyone ||
        (!remove &&
          data.position === undefined &&
          (data.name === undefined || data.name === '@everyone')),
      400,
      'The everyone role cannot be removed, renamed, or reordered.',
    );
    const permissions = data.permissions === undefined ? undefined : BigInt(data.permissions);
    if (permissions !== undefined)
      assert(
        (permissions & ~ALL) === 0n && (actor.owner || (permissions & ~actor.permissions) === 0n),
        403,
        'You cannot grant permissions you do not have.',
      );
    const position = role?.everyone ? 0 : (data.position ?? role?.position ?? 1);
    assert(
      actor.owner || position < actor.position,
      403,
      'The role must stay below your highest role.',
    );
    const values = { ...data, position, permissions };
    let result;
    if (remove) {
      await tx.permissionOverride.deleteMany({ where: { targetType: 'ROLE', targetId: roleId } });
      await tx.role.delete({ where: { id: roleId! } });
    } else if (roleId) result = await tx.role.update({ where: { id: roleId }, data: values });
    else {
      assert(data.name, 400, 'Role name is required.');
      result = await tx.role.create({ data: { ...values, name: data.name, serverId } });
    }
    await audit(tx, userId, serverId, remove ? 'role.delete' : 'role.update', roleId ?? result?.id);
    await event(tx, 'server', serverId, 'permissions');
    return result;
  });
}
export async function setOverride(
  userId: string,
  serverId: string,
  scope: 'room' | 'category',
  id: string,
  input: { targetType: 'ROLE' | 'MEMBER'; targetId: string; allow: string; deny: string },
  remove = false,
) {
  return serverTransaction(serverId, async (tx) => {
    const actor = await requireServerPermission(userId, serverId, P.MANAGE_ROLES, tx);
    const entity =
      scope === 'room'
        ? await tx.room.findFirst({ where: { id, serverId } })
        : await tx.category.findFirst({ where: { id, serverId } });
    assert(entity, 404, 'Channel or category not found.');
    if (input.targetType === 'ROLE') {
      const role = await tx.role.findFirst({ where: { id: input.targetId, serverId } });
      assert(role, 400, 'Role does not belong to this server.');
      assert(
        actor.owner || role.everyone || role.position < actor.position,
        403,
        'You can only override roles below your highest role.',
      );
    } else {
      const target = await serverAccess(input.targetId, serverId, tx);
      assert(
        actor.owner ||
          input.targetId === userId ||
          (!target.owner && target.position < actor.position),
        403,
        'Role hierarchy prevents this member override.',
      );
    }
    const allow = BigInt(input.allow),
      deny = BigInt(input.deny);
    assert(
      ((allow | deny) & ~ALL) === 0n && !(allow & deny),
      400,
      'Invalid or conflicting permission overrides.',
    );
    if (scope === 'room') {
      const room = await tx.room.findUniqueOrThrow({
        where: { id },
        include: { category: { include: { overrides: true } } },
      });
      if (room.synchronized && room.category) {
        await tx.permissionOverride.deleteMany({ where: { roomId: id } });
        await tx.permissionOverride.createMany({
          data: room.category.overrides.map((o) => ({
            roomId: id,
            targetType: o.targetType,
            targetId: o.targetId,
            allow: o.allow,
            deny: o.deny,
          })),
        });
      }
      await tx.room.update({ where: { id }, data: { synchronized: false } });
    }
    const where = {
      ...(scope === 'room' ? { roomId: id } : { categoryId: id }),
      targetType: input.targetType,
      targetId: input.targetId,
    };
    const existing = await tx.permissionOverride.findFirst({ where });
    const changed =
      ((remove ? 0n : allow) ^ (existing?.allow ?? 0n)) |
      ((remove ? 0n : deny) ^ (existing?.deny ?? 0n));
    assert(
      actor.owner || (changed & ~actor.permissions) === 0n,
      403,
      'You cannot change overrides for permissions you do not have.',
    );
    await tx.permissionOverride.deleteMany({ where });
    if (!remove) await tx.permissionOverride.create({ data: { ...where, allow, deny } });
    await audit(tx, userId, serverId, 'permissions.update', id);
    await event(tx, 'server', serverId, 'permissions');
  });
}
export async function assignRoles(
  userId: string,
  serverId: string,
  targetId: string,
  roleIds: string[],
) {
  return serverTransaction(serverId, async (tx) => {
    const actor = await requireServerPermission(userId, serverId, P.MANAGE_ROLES, tx);
    const target = await serverAccess(targetId, serverId, tx);
    assert(
      actor.owner || (userId !== targetId && !target.owner && target.position < actor.position),
      403,
      'Role hierarchy prevents changing this member.',
    );
    const roles = await tx.role.findMany({
      where: { id: { in: roleIds }, serverId, everyone: false },
    });
    assert(
      roles.length === roleIds.length && new Set(roleIds).size === roleIds.length,
      400,
      'Invalid role selection.',
    );
    const changed = [
      ...roles.filter((r) => !target.roles.some((t) => t.id === r.id)),
      ...target.roles.filter((r) => !roleIds.includes(r.id)),
    ];
    assert(
      actor.owner || changed.every((r) => r.position < actor.position),
      403,
      'You can only assign or remove roles below your highest role.',
    );
    await tx.memberRole.deleteMany({ where: { memberId: target.member.id } });
    await tx.memberRole.createMany({
      data: roles.map((r) => ({ memberId: target.member.id, roleId: r.id })),
    });
    await audit(tx, userId, serverId, 'member.roles', targetId);
    await event(tx, 'server', serverId, 'permissions');
  });
}
export async function moderate(
  userId: string,
  serverId: string,
  targetId: string,
  action: 'kick' | 'ban' | 'timeout' | 'nickname',
  reason: string,
  seconds?: number,
  nickname?: string | null,
) {
  return serverTransaction(serverId, async (tx) => {
    if (action === 'nickname' && targetId === userId)
      await requireServerPermission(userId, serverId, P.CHANGE_NICKNAME, tx);
    else
      await targetMember(
        userId,
        serverId,
        targetId,
        action === 'kick'
          ? P.KICK_MEMBERS
          : action === 'ban'
            ? P.BAN_MEMBERS
            : action === 'timeout'
              ? P.MODERATE_MEMBERS
              : P.MANAGE_NICKNAMES,
        tx,
      );
    if (action === 'timeout')
      await tx.membership.update({
        where: { userId_serverId: { userId: targetId, serverId } },
        data: { timeoutUntil: seconds ? new Date(Date.now() + seconds * 1000) : null },
      });
    else if (action === 'nickname')
      await tx.membership.update({
        where: { userId_serverId: { userId: targetId, serverId } },
        data: { nickname },
      });
    else {
      if (action === 'ban')
        await tx.ban.upsert({
          where: { serverId_userId: { serverId, userId: targetId } },
          create: { serverId, userId: targetId, reason },
          update: { reason },
        });
      await tx.membership.delete({ where: { userId_serverId: { userId: targetId, serverId } } });
      await event(tx, 'user', targetId, 'permissions');
    }
    await audit(tx, userId, serverId, `member.${action}`, targetId, { reason });
    await event(tx, 'server', serverId, 'permissions');
  });
}
export async function createInvite(
  userId: string,
  serverId: string | null,
  maxUses?: number | null,
  expiresHours?: number | null,
) {
  if (serverId) await requireServerPermission(userId, serverId, P.CREATE_INVITES);
  return db.invite.create({
    data: {
      code: randomBytes(12).toString('base64url'),
      creatorId: userId,
      serverId,
      maxUses,
      expiresAt: expiresHours ? new Date(Date.now() + expiresHours * 3600000) : null,
    },
  });
}
export async function createDm(userId: string, userIds: string[], name = '') {
  const ids = [...new Set([userId, ...userIds])];
  assert(
    ids.length >= 2 && ids.length <= 10,
    400,
    'Conversations require between two and ten members.',
  );
  const directKey = ids.length === 2 ? ids.sort().join(':') : undefined;
  return db.$transaction(async (tx) => {
    await lock(tx, directKey ? `direct:${directKey}` : `group:${userId}`);
    if (directKey)
      await canDm(
        userId,
        ids.find((id) => id !== userId)!,
        tx,
      );
    else for (const from of ids) for (const to of ids) if (from !== to) await canDm(from, to, tx);
    if (directKey) {
      const existing = await tx.room.findUnique({ where: { directKey } });
      if (existing) return existing;
    }
    const room = await tx.room.create({
      data: {
        kind: directKey ? 'DIRECT' : 'GROUP',
        directKey,
        ownerId: directKey ? null : userId,
        name: name || (directKey ? 'Direct message' : 'Group conversation'),
        members: { create: ids.map((id) => ({ userId: id })) },
      },
    });
    for (const id of ids) await event(tx, 'user', id, 'conversations');
    return room;
  });
}

async function reorderPositions(
  tx: Prisma.TransactionClient,
  kind: 'room' | 'category',
  serverId: string,
  targetId: string,
  position: number,
) {
  const entities =
    kind === 'room'
      ? await tx.room.findMany({
          where: { serverId, kind: 'TEXT' },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        })
      : await tx.category.findMany({
          where: { serverId },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        });
  const target = entities.find((e) => e.id === targetId)!;
  const ordered = entities.filter((e) => e.id !== targetId);
  const index = Math.min(position, ordered.length);
  ordered.splice(index, 0, target);
  for (let i = 0; i < ordered.length; i++)
    if (ordered[i].id !== targetId && ordered[i].position !== i) {
      if (kind === 'room')
        await tx.room.update({ where: { id: ordered[i].id }, data: { position: i } });
      else await tx.category.update({ where: { id: ordered[i].id }, data: { position: i } });
    }
  return index;
}
