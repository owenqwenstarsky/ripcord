// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../src/lib/types';
import { RipCord } from '../src/components/ripcord';

const { apiMock, socket, listeners } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  socket: { on: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), connected: true },
  listeners: new Map<string, (payload?: unknown) => void>(),
}));
vi.mock('../src/components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/ui')>()),
  api: apiMock,
}));
vi.mock('socket.io-client', () => ({ io: () => socket }));

const workspace: Workspace = {
  user: { id: 'test-user', username: 'tester', displayName: 'Test User', avatarId: null },
  instance: {
    name: 'Test instance',
    maxMessageLength: 2000,
    maxFileBytes: 1024,
    maxAttachments: 5,
  },
  servers: [],
  dms: [],
  relationships: [],
};
const recoveryCodes = ['first-recovery-code', 'second-recovery-code'];
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
let signedIn: boolean;
let fetchWorkspace: () => Promise<Workspace>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}
async function backgroundActivity() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await vi.advanceTimersByTimeAsync(10);
    });
  }
}
function workspaceRequests() {
  return apiMock.mock.calls.filter(([path]) => path === 'workspace').length;
}
function input(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement;
}
function submit(formInput: HTMLInputElement) {
  fireEvent.submit(formInput.closest('form')!);
}
async function renderApp() {
  render(<RipCord />);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  listeners.clear();
  socket.on.mockImplementation((event, handler) => {
    listeners.set(event, handler);
    return socket;
  });
  signedIn = false;
  fetchWorkspace = async () => {
    if (!signedIn) throw httpError(401);
    return workspace;
  };
  apiMock.mockImplementation(async (path: string) => {
    if (path === 'public')
      return { name: 'Test instance', publicRegistration: true, needsBootstrap: false, smtp: true };
    if (path === 'workspace') return fetchWorkspace();
    if (path === 'auth/login' || path === 'auth/register') {
      signedIn = true;
      return path === 'auth/register' ? { codes: recoveryCodes } : { ok: true };
    }
    if (path === 'auth/recover' || path === 'auth/reset') return { ok: true };
    throw new Error(`Unexpected API call: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe('authentication lifecycle', () => {
  it('preserves login inputs, focus, and selection during polling, focus, and reconnect', async () => {
    await renderApp();
    const username = input('USERNAME');
    const password = input('PASSWORD');
    fireEvent.change(username, { target: { value: 'unfinished_username' } });
    fireEvent.change(password, { target: { value: 'unfinished_password' } });
    username.focus();
    username.setSelectionRange(4, 8);

    await backgroundActivity();

    expect(input('USERNAME')).toBe(username);
    expect(input('PASSWORD')).toBe(password);
    expect(username.value).toBe('unfinished_username');
    expect(password.value).toBe('unfinished_password');
    expect(document.activeElement).toBe(username);
    expect([username.selectionStart, username.selectionEnd]).toEqual([4, 8]);
    expect(workspaceRequests()).toBe(1);
  });

  it.each([
    ['Create an account', 'DISPLAY NAME', 'Find your people.'],
    ['Use a recovery code', 'RECOVERY CODE', 'Let’s get you back in.'],
    ['Reset by email', 'EMAIL ADDRESS', 'Forgot your password?'],
  ])('preserves the %s mode and draft', async (button, label, heading) => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: button }));
    const draft = input(label);
    fireEvent.change(draft, { target: { value: 'unfinished-draft' } });

    await backgroundActivity();

    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(input(label)).toBe(draft);
    expect(draft.value).toBe('unfinished-draft');
    expect(workspaceRequests()).toBe(1);
  });

  it('preserves recovery success notices during background activity', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    submit(input('RECOVERY CODE'));
    await flush();

    await backgroundActivity();

    expect(screen.getByText('Password updated. Sign in with your new password.')).toBeTruthy();
    expect(workspaceRequests()).toBe(1);
  });

  it('keeps the login form mounted until an explicit workspace refresh finishes', async () => {
    await renderApp();
    const username = input('USERNAME');
    fireEvent.change(username, { target: { value: 'tester' } });
    const nextWorkspace = deferred<Workspace>();
    fetchWorkspace = () => nextWorkspace.promise;
    submit(username);
    await flush();

    expect(workspaceRequests()).toBe(2);
    expect(input('USERNAME')).toBe(username);
    expect(username.value).toBe('tester');
    expect(screen.queryByText('Finding your conversations…')).toBeNull();

    nextWorkspace.resolve(workspace);
    await flush();

    expect(screen.queryByRole('heading', { name: 'Welcome back.' })).toBeNull();
    expect(screen.getByText('Test User')).toBeTruthy();
  });

  it('retains recovery codes until acknowledged, including during the workspace refresh', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    submit(input('DISPLAY NAME'));
    await flush();
    const code = screen.getByText(recoveryCodes[0]);

    await backgroundActivity();

    expect(screen.getByText(recoveryCodes[0])).toBe(code);
    expect(workspaceRequests()).toBe(1);
    const nextWorkspace = deferred<Workspace>();
    fetchWorkspace = () => nextWorkspace.promise;
    fireEvent.click(screen.getByRole('button', { name: /I’ve saved them/ }));
    await flush();
    expect(screen.getByText(recoveryCodes[0])).toBe(code);
    expect(workspaceRequests()).toBe(2);

    nextWorkspace.resolve(workspace);
    await flush();
    expect(screen.queryByText(recoveryCodes[0])).toBeNull();
    expect(screen.getByText('Test User')).toBeTruthy();
  });

  it('pauses workspace fetching throughout password reset and refreshes after login', async () => {
    window.history.replaceState(null, '', '/?reset=reset-token');
    await renderApp();
    const password = input('NEW PASSWORD');
    fireEvent.change(password, { target: { value: 'a-new-password' } });
    await backgroundActivity();

    expect(input('NEW PASSWORD')).toBe(password);
    expect(password.value).toBe('a-new-password');
    expect(workspaceRequests()).toBe(0);
    submit(password);
    await flush();
    expect(apiMock).toHaveBeenCalledWith('auth/reset', 'POST', {
      password: 'a-new-password',
      token: 'reset-token',
    });
    await backgroundActivity();
    expect(screen.getByText('Password updated. Sign in with your new password.')).toBeTruthy();
    expect(workspaceRequests()).toBe(0);

    const username = input('USERNAME');
    const nextWorkspace = deferred<Workspace>();
    fetchWorkspace = () => nextWorkspace.promise;
    submit(username);
    await flush();
    expect(input('USERNAME')).toBe(username);
    expect(workspaceRequests()).toBe(1);
    nextWorkspace.resolve(workspace);
    await flush();
    expect(screen.getByText('Test User')).toBeTruthy();
    expect(listeners.has('connect')).toBe(true);
  });

  it.each([403, 500])('keeps initial HTTP %i failures on the retry screen', async (status) => {
    fetchWorkspace = async () => {
      throw httpError(status);
    };
    await renderApp();
    expect(screen.getByRole('alert').textContent).toBe(`HTTP ${status}`);
    expect(screen.queryByRole('heading', { name: 'Welcome back.' })).toBeNull();

    fetchWorkspace = async () => {
      throw httpError(401);
    };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(screen.getByRole('heading', { name: 'Welcome back.' })).toBeTruthy();
  });

  it('preserves public-info error handling and its retry button', async () => {
    const defaultImplementation = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path, ...args) => {
      if (path === 'public') throw httpError(500);
      return defaultImplementation(path, ...args);
    });
    await renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('alert').textContent).toBe('HTTP 500');
    apiMock.mockImplementation(defaultImplementation);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(screen.getByRole('heading', { name: 'Welcome back.' })).toBeTruthy();
  });

  it('continues signed-in polling, focus/reconnect reconciliation, and socket invalidation', async () => {
    signedIn = true;
    await renderApp();
    expect(screen.getByText('Test User')).toBeTruthy();
    expect(workspaceRequests()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(workspaceRequests()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await flush();
    expect(workspaceRequests()).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flush();
    expect(workspaceRequests()).toBe(4);

    act(() => listeners.get('connect')!());
    await flush();
    expect(workspaceRequests()).toBe(5);
    act(() => listeners.get('invalidate')!({ id: 'event-1', type: 'profiles' }));
    await flush();
    expect(workspaceRequests()).toBe(6);
    act(() => listeners.get('invalidate')!({ id: 'event-1', type: 'profiles' }));
    await flush();
    expect(workspaceRequests()).toBe(6);
  });
});
