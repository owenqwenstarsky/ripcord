// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvitationForm } from '../src/components/chat/invitation-form';
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../src/components/ui', () => ({
  api: apiMock,
  ErrorNote: ({ error }: { error: string }) => (error ? <p role="alert">{error}</p> : null),
}));
const preview = { kind: 'community', serverId: 'server', serverName: 'Weekend Club', server: null };
beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  apiMock.mockReset();
});
afterEach(cleanup);
it('previews full links, retains intent after failed acceptance, and clears it after a successful retry', async () => {
  const joined = vi.fn().mockResolvedValue(undefined);
  apiMock
    .mockResolvedValueOnce(preview)
    .mockRejectedValueOnce(new Error('Temporarily unavailable'))
    .mockResolvedValueOnce(preview);
  render(<InvitationForm onJoined={joined} />);
  fireEvent.change(screen.getByLabelText('INVITATION CODE'), {
    target: { value: 'https://example.test/?invite=code' },
  });
  await act(async () => {
    fireEvent.submit(screen.getByRole('button', { name: 'Preview invitation' }).closest('form')!);
  });
  expect(apiMock).toHaveBeenCalledWith('invites/code');
  expect(screen.getByText('Weekend Club')).toBeTruthy();
  await act(async () => {
    fireEvent.submit(screen.getByRole('button', { name: 'Join community' }).closest('form')!);
  });
  expect(sessionStorage.getItem('ripcord-invite')).toBe('code');
  expect(screen.getByRole('alert').textContent).toBe('Temporarily unavailable');
  expect(joined).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.submit(screen.getByRole('button', { name: 'Join community' }).closest('form')!);
  });
  expect(joined).toHaveBeenCalledWith(preview);
  expect(sessionStorage.getItem('ripcord-invite')).toBeNull();
});
it('guards duplicate preview submissions and supports explicit cancellation', async () => {
  let resolve!: (value: unknown) => void;
  apiMock.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render(<InvitationForm initial="code" onJoined={vi.fn()} />);
  const form = screen.getByRole('button', { name: 'Preview invitation' }).closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(apiMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(preview);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel invitation' }));
  expect(sessionStorage.getItem('ripcord-invite')).toBeNull();
  expect(screen.getByLabelText('INVITATION CODE')).toHaveProperty('value', '');
});
