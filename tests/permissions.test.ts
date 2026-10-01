import { describe, it, expect } from 'vitest';
import { P, ALL, DEFAULT, has, resolvePermissions, canTarget } from '../src/lib/permissions';
const base = {
  owner: false,
  userId: 'user',
  everyoneId: 'everyone',
  base: DEFAULT,
  roleIds: ['role-a', 'role-b'],
  overrides: [],
};
describe('Discord permission resolution', () => {
  it('starts with the combined base permissions', () =>
    expect(resolvePermissions(base)).toBe(DEFAULT));
  it('owners bypass every deny', () =>
    expect(
      resolvePermissions({
        ...base,
        owner: true,
        overrides: [{ targetType: 'MEMBER', targetId: 'user', deny: ALL, allow: 0n }],
      }),
    ).toBe(ALL));
  it('administrator bypasses channel overrides', () =>
    expect(resolvePermissions({ ...base, base: P.ADMINISTRATOR })).toBe(ALL));
  it('applies everyone overrides before role overrides', () =>
    expect(
      has(
        resolvePermissions({
          ...base,
          overrides: [
            { targetType: 'ROLE', targetId: 'everyone', deny: P.SEND_MESSAGES, allow: 0n },
            { targetType: 'ROLE', targetId: 'role-a', allow: P.SEND_MESSAGES, deny: 0n },
          ],
        }),
        P.SEND_MESSAGES,
      ),
    ).toBe(true));
  it('aggregated role allows win over aggregated role denies', () =>
    expect(
      has(
        resolvePermissions({
          ...base,
          overrides: [
            { targetType: 'ROLE', targetId: 'role-a', deny: P.VIEW_CHANNEL, allow: 0n },
            { targetType: 'ROLE', targetId: 'role-b', allow: P.VIEW_CHANNEL, deny: 0n },
          ],
        }),
        P.VIEW_CHANNEL,
      ),
    ).toBe(true));
  it('member overrides apply last', () =>
    expect(
      has(
        resolvePermissions({
          ...base,
          overrides: [
            { targetType: 'ROLE', targetId: 'role-a', allow: P.SEND_MESSAGES, deny: 0n },
            { targetType: 'MEMBER', targetId: 'user', deny: P.SEND_MESSAGES, allow: 0n },
          ],
        }),
        P.SEND_MESSAGES,
      ),
    ).toBe(false));
  it('ignores other users and unassigned roles', () =>
    expect(
      resolvePermissions({
        ...base,
        overrides: [
          { targetType: 'ROLE', targetId: 'not-assigned', deny: ALL, allow: 0n },
          { targetType: 'MEMBER', targetId: 'another-user', deny: ALL, allow: 0n },
        ],
      }),
    ).toBe(DEFAULT));
  it('checks all bits in a combined permission', () => {
    expect(has(P.VIEW_CHANNEL, P.VIEW_CHANNEL | P.READ_HISTORY)).toBe(false);
    expect(has(DEFAULT, P.VIEW_CHANNEL | P.READ_HISTORY)).toBe(true);
  });
});
describe('role hierarchy', () => {
  it('does not permit moderating the owner', () =>
    expect(canTarget(true, true, 100, 0)).toBe(false));
  it('allows the owner to target lower members', () =>
    expect(canTarget(true, false, 0, 100)).toBe(true));
  it('requires a strictly higher role for everyone else', () => {
    expect(canTarget(false, false, 3, 2)).toBe(true);
    expect(canTarget(false, false, 2, 2)).toBe(false);
    expect(canTarget(false, false, 1, 2)).toBe(false);
  });
});
