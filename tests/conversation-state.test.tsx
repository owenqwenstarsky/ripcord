// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationState } from '../src/components/chat/use-conversation-state';
import { loadWork, saveWork, clearWork, DRAFT_TTL, type Pending } from '../src/lib/draft-storage';
import type { ChatMessage } from '../src/lib/types';
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../src/components/ui', () => ({ api: apiMock }));
let state: ReturnType<typeof useConversationState>;
const sent = vi.fn(),
  error = vi.fn();
function Harness({ user = 'account-a', room = 'room-a' }: { user?: string; room?: string | null }) {
  state = useConversationState(user || undefined, room, error, sent);
  return <p>{state.content}</p>;
}
const message = {
  id: 'message',
  authorId: 'account-a',
  roomId: 'room-a',
  nonce: 'stable-nonce',
  content: 'Reply target',
  author: { id: 'account-a', username: 'account_a', displayName: 'Account A', avatarId: null },
} as ChatMessage;
const pending = (): Pending => ({
  roomId: 'room-a',
  nonce: 'stable-nonce',
  content: 'Keep me',
  attachmentIds: [],
  failed: false,
  updatedAt: Date.now(),
});
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiMock.mockResolvedValue({ available: [] });
});
afterEach(cleanup);
describe('saved conversation state', () => {
  it('preserves drafts, reply targets, and attachment metadata across rooms and reload', async () => {
    apiMock.mockResolvedValue({ available: ['file'] });
    const app = render(<Harness />);
    await act(async () => {
      state.setContent('Unsent');
      state.setReply(message);
      state.setFiles([{ id: 'file', name: 'note.txt', createdAt: new Date().toISOString() }]);
    });
    app.rerender(<Harness room="room-b" />);
    expect(state.content).toBe('');
    act(() => state.setContent('Another draft'));
    app.rerender(<Harness room="room-a" />);
    expect(state.content).toBe('Unsent');
    expect(state.reply?.id).toBe('message');
    expect(state.files[0].name).toBe('note.txt');
    app.unmount();
    render(<Harness />);
    expect(state.content).toBe('Unsent');
    expect(state.reply?.id).toBe('message');
  });
  it('hides saved work after session expiry and isolates accounts until the same user returns', () => {
    const app = render(<Harness />);
    act(() => state.setContent('Account A'));
    app.rerender(<Harness user="" />);
    expect(state.content).toBe('');
    app.rerender(<Harness user="account-b" />);
    expect(state.content).toBe('');
    act(() => state.setContent('Account B'));
    app.rerender(<Harness />);
    expect(state.content).toBe('Account A');
    clearWork('account-a');
    app.unmount();
    render(<Harness />);
    expect(state.content).toBe('');
  });
  it('expires saved work after seven days', () => {
    saveWork('account-a', {
      drafts: {
        old: { content: 'Expired', reply: null, files: [], updatedAt: Date.now() - DRAFT_TTL - 1 },
        fresh: { content: 'Fresh', reply: null, files: [], updatedAt: Date.now() },
      },
      pending: [{ ...pending(), updatedAt: Date.now() - DRAFT_TTL - 1 }],
    });
    const work = loadWork('account-a');
    expect(work.drafts.old).toBeUndefined();
    expect(work.drafts.fresh.content).toBe('Fresh');
    expect(work.pending).toHaveLength(0);
  });
  it('keeps a delayed upload in its originating conversation', async () => {
    const upload = deferred<{ id: string; name: string }>();
    apiMock.mockImplementation((path: string) =>
      path === 'uploads' ? upload.promise : Promise.resolve({ available: ['file'] }),
    );
    const app = render(<Harness />);
    let operation!: Promise<void>;
    act(() => {
      operation = state.uploadFiles([new File(['hello'], 'note.txt')] as unknown as FileList, {
        maxAttachments: 5,
        maxFileBytes: 1000,
      });
    });
    app.rerender(<Harness room="room-b" />);
    expect(state.uploading).toBe(false);
    await act(async () => {
      upload.resolve({ id: 'file', name: 'note.txt' });
      await operation;
    });
    expect(state.files).toHaveLength(0);
    app.rerender(<Harness />);
    expect(state.files[0].name).toBe('note.txt');
  });
  it('does not expose upload completion to a different account', async () => {
    const upload = deferred<{ id: string; name: string }>();
    apiMock.mockReturnValue(upload.promise);
    const app = render(<Harness />);
    let operation!: Promise<void>;
    act(() => {
      operation = state.uploadFiles([new File(['a'], 'a.txt')] as unknown as FileList, {
        maxAttachments: 5,
        maxFileBytes: 1000,
      });
    });
    app.rerender(<Harness user="account-b" />);
    await act(async () => {
      upload.resolve({ id: 'file', name: 'a.txt' });
      await operation;
    });
    expect(state.files).toHaveLength(0);
    expect(loadWork('account-b').drafts).toEqual({});
  });
  it('identifies expired attachments and retains their names for reattachment', async () => {
    saveWork('account-a', {
      drafts: {
        'room-a': {
          content: 'With file',
          reply: null,
          files: [{ id: 'missing', name: 'expired.txt' }],
          updatedAt: Date.now(),
        },
      },
      pending: [],
    });
    await act(async () => {
      render(<Harness />);
    });
    expect(state.files[0]).toMatchObject({ name: 'expired.txt', expired: true });
  });
  it('never automatically resends restored pending messages', () => {
    saveWork('account-a', { drafts: {}, pending: [pending()] });
    render(<Harness />);
    expect(state.pending[0]).toMatchObject({
      nonce: 'stable-nonce',
      failed: true,
      ambiguous: true,
    });
    expect(apiMock).not.toHaveBeenCalled();
  });
  it('treats server acknowledgement as sent independently of history access', async () => {
    apiMock.mockResolvedValue(message);
    render(<Harness />);
    act(() => state.setPending([pending()]));
    await act(async () => {
      await state.transmit(pending());
    });
    expect(state.pending).toHaveLength(0);
    expect(loadWork('account-a').pending).toHaveLength(0);
    expect(sent).toHaveBeenCalledWith(message);
  });
  it('guards concurrent retries and preserves the original nonce after ambiguous failure', async () => {
    const send = deferred<ChatMessage>();
    apiMock.mockReturnValueOnce(send.promise);
    render(<Harness />);
    act(() => state.setPending([pending()]));
    let operation!: Promise<void>;
    act(() => {
      operation = state.transmit(pending());
      void state.transmit(pending());
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      send.reject(Object.assign(new Error('Network lost'), { ambiguous: true }));
      await operation;
    });
    expect(state.pending[0]).toMatchObject({
      nonce: 'stable-nonce',
      failed: true,
      ambiguous: true,
    });
    apiMock.mockResolvedValue(message);
    await act(async () => {
      await state.transmit(state.pending[0]);
    });
    expect(apiMock.mock.calls.every((call) => call[2].nonce === 'stable-nonce')).toBe(true);
    expect(state.pending).toHaveLength(0);
  });
  it('reconciles a committed ambiguous send before allowing edits or discards', async () => {
    apiMock.mockResolvedValue({ status: 'sent', message });
    render(<Harness />);
    act(() => state.setPending([{ ...pending(), failed: true, ambiguous: true }]));
    await act(async () => {
      await state.reconcile(state.pending[0], 'edit');
    });
    expect(apiMock).toHaveBeenCalledWith('rooms/room-a/send-status/stable-nonce', 'DELETE');
    expect(state.content).toBe('');
    expect(state.pending).toHaveLength(0);
    expect(sent).toHaveBeenCalledWith(message);
  });
  it('edits a cancelled send into a draft without reusing its nonce', async () => {
    apiMock.mockResolvedValue({ status: 'cancelled', message: null });
    render(<Harness />);
    act(() => state.setPending([{ ...pending(), failed: true }]));
    await act(async () => {
      await state.reconcile(state.pending[0], 'edit');
    });
    expect(state.content).toBe('Keep me');
    expect(state.pending).toHaveLength(0);
  });
});
