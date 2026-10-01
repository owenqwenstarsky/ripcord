export const P = {
  VIEW_CHANNEL: 1n << 0n,
  READ_HISTORY: 1n << 1n,
  SEND_MESSAGES: 1n << 2n,
  ATTACH_FILES: 1n << 3n,
  ADD_REACTIONS: 1n << 4n,
  MENTION_EVERYONE: 1n << 5n,
  CREATE_INVITES: 1n << 6n,
  CHANGE_NICKNAME: 1n << 7n,
  MANAGE_NICKNAMES: 1n << 8n,
  MANAGE_CHANNELS: 1n << 9n,
  MANAGE_SERVER: 1n << 10n,
  MANAGE_ROLES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 12n,
  KICK_MEMBERS: 1n << 13n,
  BAN_MEMBERS: 1n << 14n,
  MODERATE_MEMBERS: 1n << 15n,
  VIEW_AUDIT_LOG: 1n << 16n,
  ADMINISTRATOR: 1n << 17n,
} as const;
export const ALL = Object.values(P).reduce((a, b) => a | b, 0n);
export const DEFAULT =
  P.VIEW_CHANNEL |
  P.READ_HISTORY |
  P.SEND_MESSAGES |
  P.ATTACH_FILES |
  P.ADD_REACTIONS |
  P.CREATE_INVITES |
  P.CHANGE_NICKNAME;
export type Override = { targetType: string; targetId: string; allow: bigint; deny: bigint };
export function has(bits: bigint, permission: bigint) {
  return (bits & permission) === permission;
}
export function resolvePermissions(input: {
  owner: boolean;
  userId: string;
  everyoneId: string;
  base: bigint;
  roleIds: string[];
  overrides: Override[];
}) {
  if (input.owner || has(input.base, P.ADMINISTRATOR)) return ALL;
  let bits = input.base;
  const apply = (allow: bigint, deny: bigint) => {
    bits = (bits & ~deny) | allow;
  };
  const everyone = input.overrides.find(
    (o) => o.targetType === 'ROLE' && o.targetId === input.everyoneId,
  );
  if (everyone) apply(everyone.allow, everyone.deny);
  const roles = input.overrides.filter(
    (o) =>
      o.targetType === 'ROLE' &&
      input.roleIds.includes(o.targetId) &&
      o.targetId !== input.everyoneId,
  );
  apply(
    roles.reduce((a, o) => a | o.allow, 0n),
    roles.reduce((a, o) => a | o.deny, 0n),
  );
  const member = input.overrides.find(
    (o) => o.targetType === 'MEMBER' && o.targetId === input.userId,
  );
  if (member) apply(member.allow, member.deny);
  return bits;
}
export function canTarget(
  actorOwner: boolean,
  targetOwner: boolean,
  actorPosition: number,
  targetPosition: number,
) {
  return !targetOwner && (actorOwner || actorPosition > targetPosition);
}
