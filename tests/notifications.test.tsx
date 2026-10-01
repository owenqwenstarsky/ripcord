// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNotifications } from '../src/components/chat/use-notifications';
import type { ChatMessage, ChatRoom, Workspace } from '../src/lib/types';
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../src/components/ui', () => ({ api: apiMock }));
const room: ChatRoom = {
  id: 'dm',
  kind: 'DIRECT',
  name: 'DM',
  topic: '',
  serverId: null,
  categoryId: null,
  ownerId: null,
  permissions: '131071',
  position: 0,
  slowMode: 0,
  synchronized: false,
  unread: 1,
  mentions: 0,
  latestSeq: '10',
};
const base: Workspace = {
  user: {
    id: 'user',
    username: 'user',
    displayName: 'User',
    avatarId: null,
    notifyDms: true,
    notifyMentions: true,
  },
  instance: { name: 'Test', maxMessageLength: 2000, maxFileBytes: 100, maxAttachments: 5 },
  servers: [],
  dms: [room],
  relationships: [],
};
const notification = vi.fn();
const snapshot = (seq = '10', muted = false): Workspace => ({
  ...base,
  dms: [{ ...room, latestSeq: seq, muted }],
});
const message = (id = 'new', seq = '11'): ChatMessage => ({
  id,
  seq,
  roomId: 'dm',
  authorId: 'other',
  author: { id: 'other', username: 'other', displayName: 'Other', avatarId: null },
  content: 'Hello',
  nonce: id,
  createdAt: new Date().toISOString(),
  editedAt: null,
  deletedAt: null,
  reply: null,
  attachments: [],
  reactions: [],
  mentions: [],
});
function Harness({
  workspace = base,
  connected = true,
}: {
  workspace?: Workspace;
  connected?: boolean;
}) {
  useNotifications(workspace, connected, null, vi.fn());
  return null;
}
beforeEach(() => {
  apiMock.mockReset();
  notification.mockReset();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  class BrowserNotification {
    static permission = 'granted';
    onclick = null;
    constructor(...args: unknown[]) {
      notification(...args);
    }
    close() {}
  }
  vi.stubGlobal('Notification', BrowserNotification);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function prime() {
  const app = render(<Harness />);
  await act(async () => {
    app.rerender(<Harness workspace={snapshot()} />);
  });
  return app;
}
it('does not alert for initial loading or reconnect reconciliation', async () => {
  const app = render(<Harness connected={false} />);
  app.rerender(<Harness connected />);
  await act(async () => {
    app.rerender(<Harness workspace={snapshot('100')} />);
  });
  expect(notification).not.toHaveBeenCalled();
  expect(apiMock).not.toHaveBeenCalled();
});
it('alerts for incoming DMs and deduplicates by message identity', async () => {
  const app = await prime();
  apiMock.mockResolvedValue([message()]);
  await act(async () => {
    app.rerender(<Harness workspace={snapshot('11')} />);
  });
  expect(notification).toHaveBeenCalledTimes(1);
  apiMock.mockResolvedValue([message(), message('next', '12')]);
  await act(async () => {
    app.rerender(<Harness workspace={snapshot('12')} />);
  });
  expect(notification).toHaveBeenCalledTimes(2);
  expect(notification.mock.calls[0][1].tag).toBe('new');
});
it.each(['muted', 'blocked', 'disabled', 'permission'])(
  'suppresses alerts when %s without clearing unread',
  async (reason) => {
    const app = await prime();
    apiMock.mockResolvedValue([message()]);
    const next = snapshot('11', reason === 'muted');
    if (reason === 'blocked')
      next.relationships = [
        { id: 'block', kind: 'BLOCK', fromId: 'user', toId: 'other', user: message().author },
      ];
    if (reason === 'disabled') next.user = { ...next.user, notifyDms: false };
    if (reason === 'permission')
      (Notification as unknown as { permission: string }).permission = 'denied';
    await act(async () => {
      app.rerender(<Harness workspace={next} />);
    });
    expect(notification).not.toHaveBeenCalled();
    expect(next.dms[0].unread).toBe(1);
  },
);
it('honors exact persisted mention recipients and account mention preference', async () => {
  const textRoom = { ...room, id: 'channel', kind: 'TEXT' as const, serverId: 'server' };
  const community = {
    id: 'server',
    name: 'Server',
    description: '',
    icon: '',
    ownerId: 'user',
    permissions: '131071',
    categories: [],
    rooms: [textRoom],
  };
  const first = { ...base, dms: [], servers: [community] };
  const app = render(<Harness workspace={first} />);
  await act(async () => {
    app.rerender(<Harness workspace={{ ...first }} />);
  });
  apiMock.mockResolvedValue([{ ...message(), roomId: 'channel', mentions: [{ userId: 'user' }] }]);
  await act(async () => {
    app.rerender(
      <Harness
        workspace={{
          ...first,
          servers: [{ ...community, rooms: [{ ...textRoom, latestSeq: '11' }] }],
        }}
      />,
    );
  });
  expect(notification.mock.calls[0][0]).toBe('You were mentioned on RipCord');
});
it('keeps an in-flight request through workspace refreshes and drains paginated bursts', async () => {
  const app = await prime();
  let resolve!: (value: unknown) => void;
  apiMock.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  apiMock.mockResolvedValueOnce({
    messages: [message('second', '12')],
    nextCursor: '12',
    hasMore: false,
  });
  await act(async () => {
    app.rerender(<Harness workspace={snapshot('11')} />);
  });
  await act(async () => {
    app.rerender(<Harness workspace={snapshot('12')} />);
  });
  await act(async () => {
    resolve({ messages: [message()], nextCursor: '11', hasMore: true });
  });
  expect(notification).toHaveBeenCalledTimes(2);
  expect(apiMock.mock.calls[1][0]).toContain('afterEvent=11');
});
it('retries a failed fetch from the unadvanced cursor', async () => {
  const app = await prime();
  apiMock.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    app.rerender(<Harness workspace={snapshot('11')} />);
  });
  apiMock.mockResolvedValueOnce({ messages: [message()], nextCursor: '11', hasMore: false });
  await act(async () => {
    app.rerender(<Harness workspace={snapshot('11')} />);
  });
  expect(apiMock.mock.calls[1][0]).toContain('afterEvent=10');
  expect(notification).toHaveBeenCalledTimes(1);
});
