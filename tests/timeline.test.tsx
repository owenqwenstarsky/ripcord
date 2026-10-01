// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTimeline } from '../src/components/chat/use-timeline';
import { DEFAULT } from '../src/lib/permissions';
import type { ChatMessage, ChatRoom } from '../src/lib/types';
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../src/components/ui', () => ({ api: apiMock }));
const room: ChatRoom = {
  id: 'room',
  name: 'Room',
  kind: 'TEXT',
  topic: '',
  serverId: 'server',
  categoryId: null,
  ownerId: null,
  position: 0,
  slowMode: 0,
  synchronized: false,
  permissions: DEFAULT.toString(),
  unread: 10,
  mentions: 0,
  readSeq: '0',
};
const message = (seq: string): ChatMessage => ({
  id: `m${seq}`,
  seq,
  roomId: 'room',
  authorId: 'other',
  author: { id: 'other', username: 'other', displayName: 'Other', avatarId: null },
  content: `Message ${seq}`,
  nonce: seq,
  reply: null,
  editedAt: null,
  deletedAt: null,
  createdAt: new Date().toISOString(),
  attachments: [],
  reactions: [],
});
let state: ReturnType<typeof useTimeline>, qc: QueryClient;
function Harness({
  target = null,
  unread = false,
  account,
  permissions = room.permissions,
}: {
  target?: string | null;
  unread?: boolean;
  account?: string;
  permissions?: string;
}) {
  state = useTimeline({ ...room, permissions }, target, vi.fn(), unread, account);
  return (
    <div ref={state.scroller} onScroll={state.onScroll}>
      {state.messages.map((m) => (
        <article key={m.id} tabIndex={-1} data-message-id={m.id} data-seq={m.seq}>
          {m.content}
        </article>
      ))}
    </div>
  );
}
function start(target: string | null = null, unread = false) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness target={target} unread={unread} />
    </QueryClientProvider>,
  );
}
const rect = (top: number, bottom: number) => ({
  top,
  bottom,
  left: 0,
  right: 100,
  width: 100,
  height: bottom - top,
  x: 0,
  y: top,
  toJSON() {},
});
beforeEach(() => {
  apiMock.mockReset();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === 'ARTICLE') {
      const siblings = [...this.parentElement!.children];
      const i = siblings.indexOf(this);
      return rect(
        i * 40 - (this.parentElement?.scrollTop ?? 0),
        i * 40 + 40 - (this.parentElement?.scrollTop ?? 0),
      );
    }
    return rect(0, 90);
  });
});
afterEach(() => {
  cleanup();
  qc?.clear();
  vi.restoreAllMocks();
});
it('loads old target context, focuses it, and does not mark newer messages read', async () => {
  apiMock.mockResolvedValue({
    messages: [message('1'), message('2'), message('3')],
    hasMore: false,
    hasNewer: true,
  });
  start('m2');
  await waitFor(() => expect(state.messages).toHaveLength(3));
  expect(apiMock).toHaveBeenCalledWith('rooms/room/messages?around=m2');
  expect(document.activeElement?.getAttribute('data-message-id')).toBe('m2');
  window.dispatchEvent(new Event('focus'));
  expect(apiMock.mock.calls.some((c) => String(c[0]).endsWith('/read'))).toBe(false);
});
it('marks only reached messages on scroll, focus return, and tab visibility', async () => {
  apiMock.mockImplementation((path: string) =>
    path.endsWith('/read')
      ? Promise.resolve({ ok: true })
      : Promise.resolve({ messages: [message('1'), message('2'), message('3')], hasMore: false }),
  );
  start();
  await waitFor(() => expect(state.messages).toHaveLength(3));
  expect(apiMock.mock.calls.filter((c) => c[0] === 'rooms/room/read').at(-1)?.[2]).toEqual({
    seq: '2',
  });
  state.scroller.current!.scrollTop = 40;
  act(() => state.onScroll());
  expect(apiMock.mock.calls.filter((c) => c[0] === 'rooms/room/read').at(-1)?.[2]).toEqual({
    seq: '3',
  });
});
it('marks visible unread context but excludes unreached newer messages', async () => {
  apiMock.mockImplementation((path: string) =>
    path.endsWith('/read')
      ? Promise.resolve({ ok: true })
      : Promise.resolve({
          messages: [message('1'), message('2'), message('3')],
          hasMore: false,
          hasNewer: true,
        }),
  );
  start('m1', true);
  await waitFor(() => expect(state.messages).toHaveLength(3));
  expect(apiMock.mock.calls.filter((c) => c[0] === 'rooms/room/read').at(-1)?.[2]).toEqual({
    seq: '2',
  });
});
it('preserves the visible message when older messages are prepended', async () => {
  apiMock.mockImplementation((path: string) =>
    path.includes('?before=')
      ? Promise.resolve({ messages: [message('1'), message('2')], hasMore: false })
      : path.endsWith('/read')
        ? Promise.resolve({ ok: true })
        : Promise.resolve({ messages: [message('3'), message('4')], hasMore: true }),
  );
  start('m3');
  await waitFor(() => expect(state.messages).toHaveLength(2));
  state.scroller.current!.scrollTop = 10;
  const anchor = state.scroller.current!.querySelector('[data-message-id="m3"]')!;
  const before = anchor.getBoundingClientRect().top;
  await act(async () => {
    await state.loadEarlier();
  });
  await waitFor(() => expect(state.messages).toHaveLength(4));
  expect(anchor.getBoundingClientRect().top).toBe(before);
});
it('follows newer context cursors without loading a disconnected latest page', async () => {
  apiMock.mockImplementation((path: string) =>
    Promise.resolve(
      path.includes('?after=')
        ? { messages: [message('4')], hasMore: false }
        : { messages: [message('1'), message('2'), message('3')], hasMore: false, hasNewer: true },
    ),
  );
  start('m1');
  await waitFor(() => expect(state.messages).toHaveLength(3));
  await act(async () => {
    await state.loadNewer();
  });
  await waitFor(() => expect(state.messages).toHaveLength(4));
  expect(apiMock).toHaveBeenCalledWith('rooms/room/messages?after=3');
  expect(state.hasNewer).toBe(false);
});

it('isolates cached history and read progress when the signed-in account changes', async () => {
  apiMock.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/read')
        ? { ok: true }
        : { messages: [message('1'), message('2')], hasMore: false },
    ),
  );
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = render(
    <QueryClientProvider client={qc}>
      <Harness account="a" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(state.messages).toHaveLength(2));
  expect(apiMock.mock.calls.filter((c) => c[0] === 'rooms/room/read')).toHaveLength(1);
  app.rerender(
    <QueryClientProvider client={qc}>
      <Harness account="b" permissions="1" />
    </QueryClientProvider>,
  );
  expect(state.messages).toHaveLength(0);
  app.rerender(
    <QueryClientProvider client={qc}>
      <Harness account="b" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(state.messages).toHaveLength(2));
  expect(apiMock.mock.calls.filter((c) => c[0] === 'rooms/room/read')).toHaveLength(2);
});
