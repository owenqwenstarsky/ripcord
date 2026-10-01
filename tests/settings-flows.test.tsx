// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/components/settings-panel';
import { ALL, DEFAULT, P } from '../src/lib/permissions';
import type { Workspace, ServerInfo } from '../src/lib/types';
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('../src/components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/ui')>()),
  api: apiMock,
}));
const workspace: Workspace = {
  user: { id: 'owner', username: 'owner', displayName: 'Owner', avatarId: null },
  instance: { name: 'Test', maxMessageLength: 2000, maxFileBytes: 100, maxAttachments: 5 },
  servers: [],
  dms: [],
  relationships: [],
};
const details: ServerInfo = {
  id: 'server',
  name: 'Community',
  description: '',
  icon: '',
  ownerId: 'owner',
  permissions: ALL.toString(),
  position: 10,
  categories: [],
  rooms: [],
  roles: [
    {
      id: 'everyone',
      name: '@everyone',
      color: '#aaaaaa',
      permissions: DEFAULT.toString(),
      everyone: true,
      position: 0,
    },
    {
      id: 'lower',
      name: 'Lower',
      color: '#aaaaaa',
      permissions: DEFAULT.toString(),
      everyone: false,
      position: 1,
    },
    {
      id: 'peer',
      name: 'Peer',
      color: '#aaaaaa',
      permissions: P.MANAGE_ROLES.toString(),
      everyone: false,
      position: 5,
    },
  ],
  members: [
    {
      id: 'membership',
      user: { id: 'other', username: 'other', displayName: 'Other', avatarId: null },
      nickname: null,
      timeoutUntil: null,
      roles: [{ role: { id: 'peer', name: 'Peer', color: '#aaaaaa', position: 5 } }],
    },
  ],
};
let qc: QueryClient;
function start(server: ServerInfo = details, user = workspace.user) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['server', 'server'], server);
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPanel
        mode="server"
        workspace={{ ...workspace, user }}
        serverId="server"
        onNotice={vi.fn()}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ ok: true });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  qc?.clear();
  vi.restoreAllMocks();
});
it('blocks a second submission while saving and shows feedback beside the form', async () => {
  let done!: (value: unknown) => void;
  apiMock.mockReturnValue(
    new Promise((resolve) => {
      done = resolve;
    }),
  );
  start();
  const form = screen.getByLabelText('SERVER NAME').closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(apiMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    done({ ok: true });
  });
  expect(form.textContent).toContain('Changes saved.');
});
it('preserves dirty role fields and permission choices during background refresh', async () => {
  start();
  fireEvent.click(screen.getByRole('button', { name: 'Roles' }));
  fireEvent.click(screen.getByRole('button', { name: /Lower/ }));
  const input = screen.getByLabelText('ROLE NAME') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Unfinished rename' } });
  const send = screen.getByLabelText('Send messages') as HTMLInputElement;
  fireEvent.click(send);
  await act(async () => {
    qc.setQueryData(['server', 'server'], {
      ...details,
      roles: details.roles.map((r) =>
        r.id === 'lower' ? { ...r, name: 'Background name', permissions: ALL.toString() } : r,
      ),
    });
  });
  expect(screen.getByLabelText('ROLE NAME')).toBe(input);
  expect(input.value).toBe('Unfinished rename');
  expect(send.checked).toBe(false);
});
it('confirms before abandoning a dirty settings form', () => {
  start();
  fireEvent.change(screen.getByLabelText('SERVER NAME'), { target: { value: 'Draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Roles' }));
  expect(window.confirm).toHaveBeenCalledWith('Discard unsaved settings changes?');
  expect(screen.getByLabelText('SERVER NAME')).toBeTruthy();
});
it('disables hierarchy-blocked role edits for a role-only manager', () => {
  const manager = { ...workspace.user, id: 'manager' };
  start({ ...details, permissions: (DEFAULT | P.MANAGE_ROLES).toString(), position: 5 }, manager);
  fireEvent.click(screen.getByRole('button', { name: /Peer/ }));
  const input = screen.getByLabelText('ROLE NAME');
  expect((input.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  expect(screen.getByText('You can only manage roles below your highest role.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete role' })).toBeNull();
});
it('removes management controls when permissions are revoked', async () => {
  start();
  await act(async () => {
    qc.setQueryData(['server', 'server'], { ...details, permissions: DEFAULT.toString() });
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save server' })).toBeNull());
  expect(
    screen.getByText('Your permissions no longer allow managing this community.'),
  ).toBeTruthy();
});
it('shows failed mutations beside the affected action and retains the dirty form', async () => {
  apiMock.mockRejectedValue(new Error('Permission changed'));
  start();
  const input = screen.getByLabelText('SERVER NAME') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Retain me' } });
  const form = input.closest('form')!;
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(form.querySelector('[role="alert"]')?.textContent).toBe('Permission changed');
  expect(input.value).toBe('Retain me');
  expect(form.dataset.dirty).toBe('true');
});
