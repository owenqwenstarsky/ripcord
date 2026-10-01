import { expect, it } from 'vitest';
import { mentionTokens } from '../src/lib/mentions';
import { invitationCode } from '../src/lib/invitations';
it('matches complete mention tokens without email and prefix matches', () => {
  expect([
    ...mentionTokens('@alice, @alice_extra email@alice @@alice @ALICE @hereish @here'),
  ]).toEqual(['alice', 'alice_extra', 'hereish', 'here']);
});
it('accepts pasted codes and full invitation links', () => {
  expect(invitationCode(' code ')).toBe('code');
  expect(invitationCode('https://chat.test/?invite=code&other=1')).toBe('code');
  expect(invitationCode('https://chat.test/invites/code')).toBe('code');
});
