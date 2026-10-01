// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useNavigation, messageLink } from '../src/components/chat/use-navigation';
import type { ChatRoom, Workspace } from '../src/lib/types';
const room = (id: string, serverId: string | null): ChatRoom => ({
  id,
  serverId,
  kind: serverId ? 'TEXT' : 'DIRECT',
  name: id,
  topic: '',
  categoryId: null,
  ownerId: null,
  permissions: '131071',
  position: 0,
  slowMode: 0,
  synchronized: false,
  unread: 0,
  mentions: 0,
});
const a = room('a', 'server'),
  b = room('b', 'server'),
  dm = room('dm', null);
const workspace: Workspace = {
  user: { id: 'user', username: 'user', displayName: 'User', avatarId: null },
  instance: { name: 'Test', maxMessageLength: 2000, maxFileBytes: 100, maxAttachments: 5 },
  servers: [
    {
      id: 'server',
      ownerId: 'user',
      name: 'Community',
      icon: '',
      description: '',
      permissions: '131071',
      categories: [],
      rooms: [a, b],
    },
  ],
  dms: [dm],
  relationships: [],
};
let nav: ReturnType<typeof useNavigation>;
function Harness() {
  nav = useNavigation(workspace);
  return <p>{nav.roomId}</p>;
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(cleanup);
it('restores a saved DM with its own sidebar context', () => {
  localStorage.setItem('ripcord-nav:user', 'dm');
  render(<Harness />);
  expect(nav.roomId).toBe('dm');
  expect(nav.serverId).toBeNull();
  expect(location.search).toContain('room=dm');
});
it('restores copyable message deep links without choosing a default server channel', () => {
  history.replaceState(null, '', '/?room=dm&message=old');
  render(<Harness />);
  expect(nav.roomId).toBe('dm');
  expect(nav.serverId).toBeNull();
  expect(nav.messageTarget).toBe('old');
  expect(messageLink('dm', 'old')).toBe(`${location.origin}/?room=dm&message=old`);
});
it('remembers the last channel independently per server and honors browser history', () => {
  render(<Harness />);
  act(() => nav.choose(b));
  expect(nav.lastChannel('server')?.id).toBe('b');
  act(() => nav.choose(dm));
  expect(nav.serverId).toBeNull();
  expect(nav.lastChannel('server')?.id).toBe('b');
  act(() => {
    history.replaceState(null, '', '/?room=b&message=target');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(nav.roomId).toBe('b');
  expect(nav.serverId).toBe('server');
  expect(nav.messageTarget).toBe('target');
});
it('selects the joined community after recovery-code acknowledgement', () => {
  localStorage.setItem('ripcord-nav:user', 'dm');
  sessionStorage.setItem('ripcord-joined', 'server');
  render(<Harness />);
  expect(nav.serverId).toBe('server');
  expect(nav.roomId).toBe('a');
  expect(sessionStorage.getItem('ripcord-joined')).toBeNull();
});
