import type { Prisma, User } from '@prisma/client';
import { db } from './db';
import { assert } from './errors';
import { ALL, P, has, resolvePermissions, canTarget } from './permissions';
type Client = Prisma.TransactionClient;
export async function serverAccess(userId: string, serverId: string, client: Client = db) {
  const server = await client.server.findUnique({
    where: { id: serverId },
    include: { roles: true },
  });
  const member = await client.membership.findUnique({
    where: { userId_serverId: { userId, serverId } },
    include: { roles: { include: { role: true } } },
  });
  assert(server && member, 403, 'You do not have access to this server.');
  const everyone = server.roles.find((r) => r.everyone)!;
  const roles = member.roles.map((r) => r.role);
  const base = roles.reduce((bits, r) => bits | r.permissions, everyone.permissions);
  const owner = server.ownerId === userId;
  return {
    server,
    member,
    everyone,
    roles,
    base,
    owner,
    permissions: owner || has(base, P.ADMINISTRATOR) ? ALL : base,
    position: Math.max(0, ...roles.map((r) => r.position)),
  };
}
export async function roomAccess(
  userId: string,
  roomId: string,
  permission = P.VIEW_CHANNEL,
  client: Client = db,
) {
  const room = await client.room.findUnique({
    where: { id: roomId },
    include: { overrides: true, category: { include: { overrides: true } }, members: true },
  });
  assert(room, 404, 'Conversation not found.');
  if (room.kind !== 'TEXT') {
    assert(
      room.members.some((m) => m.userId === userId),
      403,
      'You do not have access to this conversation.',
    );
    return { room, permissions: ALL, server: null };
  }
  const access = await serverAccess(userId, room.serverId!, client);
  let permissions = resolvePermissions({
    owner: access.owner,
    userId,
    everyoneId: access.everyone.id,
    base: access.base,
    roleIds: access.roles.map((r) => r.id),
    overrides: room.synchronized && room.category ? room.category.overrides : room.overrides,
  });
  if (
    access.member.timeoutUntil &&
    access.member.timeoutUntil > new Date() &&
    !access.owner &&
    !has(access.base, P.ADMINISTRATOR)
  ) {
    permissions &= ~(P.SEND_MESSAGES | P.ADD_REACTIONS | P.ATTACH_FILES | P.MENTION_EVERYONE);
  }
  assert(
    has(permissions, P.VIEW_CHANNEL) && has(permissions, permission),
    403,
    'You do not have permission to do that in this channel.',
  );
  return { room, permissions, server: access };
}
export async function requireServerPermission(
  userId: string,
  serverId: string,
  permission: bigint,
  client: Client = db,
) {
  const access = await serverAccess(userId, serverId, client);
  assert(
    has(access.permissions, permission),
    403,
    'You do not have permission to do that in this server.',
  );
  return access;
}
export async function targetMember(
  actorId: string,
  serverId: string,
  targetId: string,
  permission: bigint,
  client: Client = db,
) {
  const actor = await requireServerPermission(actorId, serverId, permission, client);
  const target = await serverAccess(targetId, serverId, client);
  assert(
    actorId !== targetId && canTarget(actor.owner, target.owner, actor.position, target.position),
    403,
    'Role hierarchy prevents this action.',
  );
  return { actor, target };
}
export async function isBlocked(a: string, b: string, client: Client = db) {
  return !!(await client.relationship.findFirst({
    where: {
      kind: 'BLOCK',
      OR: [
        { fromId: a, toId: b },
        { fromId: b, toId: a },
      ],
    },
  }));
}
export async function canDm(a: string, b: string, client: Client = db) {
  const target = await client.user.findUnique({ where: { id: b } });
  assert(target && !target.suspended && a !== b, 400, 'This user is unavailable.');
  assert(!(await isBlocked(a, b, client)), 403, 'Messaging is unavailable between these users.');
  const friend = await client.relationship.findFirst({
    where: {
      kind: 'FRIEND',
      OR: [
        { fromId: a, toId: b },
        { fromId: b, toId: a },
      ],
    },
  });
  if (friend) return;
  assert(!target.friendsOnly, 403, 'This user only accepts messages from friends.');
  const memberships = await client.membership.findMany({
    where: { userId: a },
    select: { serverId: true },
  });
  assert(
    await client.membership.findFirst({
      where: { userId: b, serverId: { in: memberships.map((m) => m.serverId) } },
    }),
    403,
    'You must be friends or share a server to send messages.',
  );
}
export async function dmSendAccess(userId: string, memberIds: string[], client: Client = db) {
  for (const memberId of memberIds.filter((id) => id !== userId))
    await canDm(userId, memberId, client);
}
export function requireAdmin(user: User) {
  assert(user.isAdmin, 403, 'Instance administrator access is required.');
}

// Batch the same resolver used by HTTP access checks. This snapshot lives for one dispatch only.
export async function roomAudience(roomId: string, userIds: string[]) {
  const room = await db.room.findUnique({
    where: { id: roomId },
    include: {
      overrides: true,
      category: { include: { overrides: true } },
      members: true,
      server: { include: { roles: true } },
    },
  });
  const allowed = new Set<string>(),
    members = new Set<string>();
  if (!room) return { allowed, members };
  if (!room.server) {
    for (const member of room.members) {
      members.add(member.userId);
      if (userIds.includes(member.userId)) allowed.add(member.userId);
    }
    return { allowed, members };
  }
  const memberships = await db.membership.findMany({
    where: { serverId: room.serverId!, userId: { in: userIds } },
    include: { roles: true },
  });
  const roles = new Map(room.server.roles.map((role) => [role.id, role]));
  const everyone = room.server.roles.find((role) => role.everyone)!;
  for (const member of memberships) {
    members.add(member.userId);
    const roleIds = member.roles.map((role) => role.roleId);
    const base = roleIds.reduce(
      (bits, roleId) => bits | (roles.get(roleId)?.permissions ?? 0n),
      everyone.permissions,
    );
    const permissions = resolvePermissions({
      owner: room.server.ownerId === member.userId,
      userId: member.userId,
      everyoneId: everyone.id,
      base,
      roleIds,
      overrides: room.synchronized && room.category ? room.category.overrides : room.overrides,
    });
    if (has(permissions, P.VIEW_CHANNEL)) allowed.add(member.userId);
  }
  return { allowed, members };
}
