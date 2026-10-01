'use client';
import { useEffect, useRef, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import {
  Hash,
  Plus,
  Users,
  Search,
  Settings,
  LogOut,
  MessageCircle,
  ChevronDown,
  ChevronRight,
  PanelRight,
  Menu as MenuIcon,
  Smile,
  Paperclip,
  ArrowUp,
  X,
  Reply,
  Pencil,
  Trash2,
  Flag,
  MoreHorizontal,
  Sun,
  Moon,
  Shield,
  Bell,
  Check,
  Link as LinkIcon,
  LoaderCircle,
  UserPlus,
  WifiOff,
  LockKeyhole,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { P, has } from '@/lib/permissions';
import { createMessageNonce } from '@/lib/message-nonce';
import type { ChatMessage, ChatRoom, Community, Person, Workspace } from '@/lib/types';
import { AuthScreen } from './auth-screen';
import { api, Logo, Avatar, Modal, Menu, MenuItem, ErrorNote, Empty } from './ui';
import { SettingsPanel } from './settings-panel';
import { Friends } from './friends';

export function RipCord() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, error) =>
              (error as Error & { status?: number }).status !== 401 && count < 1,
            staleTime: 5000,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <RipCordApp />
    </QueryClientProvider>
  );
}
type PublicInfo = {
  name: string;
  publicRegistration: boolean;
  needsBootstrap: boolean;
  smtp: boolean;
};
type Pending = {
  nonce: string;
  roomId: string;
  content: string;
  attachmentIds: string[];
  replyId?: string;
  failed: boolean;
  error?: string;
};
function RipCordApp() {
  const qc = useQueryClient();
  const [accountReset, setAccountReset] = useState<boolean | null>(null);
  const publicInfo = useQuery({ queryKey: ['public'], queryFn: () => api<PublicInfo>('public') });
  const data = useQuery({
    queryKey: ['workspace'],
    queryFn: async (): Promise<Workspace | null> => {
      try {
        return await api<Workspace>('workspace');
      } catch (error) {
        // Signed out is a stable result, so refetching cannot reset the authentication form.
        if ((error as Error & { status?: number }).status === 401) return null;
        throw error;
      }
    },
    enabled: accountReset === false,
    refetchInterval: (query) => (query.state.data ? 30000 : false),
    refetchOnWindowFocus: (query) => !!query.state.data,
    refetchOnReconnect: (query) => !!query.state.data,
    retry: false,
  });
  const [serverId, setServerId] = useState<string | null>(null),
    [roomId, setRoomId] = useState<string | null>(null),
    [initialized, setInitialized] = useState(false);
  const [modal, setModal] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [showMembers, setShowMembers] = useState(true),
    [navOpen, setNavOpen] = useState(false),
    [theme, setTheme] = useState('dark');
  const [selectedUser, setSelectedUser] = useState<Person | null>(null),
    [connected, setConnected] = useState(false),
    [online, setOnline] = useState<Person[]>([]),
    [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  const [content, setContent] = useState(''),
    [reply, setReply] = useState<ChatMessage | null>(null),
    [files, setFiles] = useState<{ id: string; name: string }[]>([]),
    [uploading, setUploading] = useState(false),
    [pending, setPending] = useState<Pending[]>([]);
  const [search, setSearch] = useState(''),
    [searchQuery, setSearchQuery] = useState(''),
    [collapsed, setCollapsed] = useState<string[]>([]);
  const socket = useRef<Socket | null>(null),
    currentRoom = useRef(roomId),
    scroller = useRef<HTMLDivElement>(null),
    inputRef = useRef<HTMLTextAreaElement>(null),
    pinned = useRef(true),
    fileInput = useRef<HTMLInputElement>(null);
  currentRoom.current = roomId;
  const workspace = data.data,
    user = workspace?.user;
  const server = workspace?.servers.find((s) => s.id === serverId);
  const allRooms = [
    ...(workspace?.servers.flatMap((s) => s.rooms) ?? []),
    ...(workspace?.dms ?? []),
  ];
  const room = allRooms.find((r) => r.id === roomId);
  const canSend = !!room && has(BigInt(room.permissions), P.SEND_MESSAGES);
  const details = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => api<ServerInfo>(`servers/${serverId}`),
    enabled: !!serverId,
  });
  const history = useInfiniteQuery({
    queryKey: ['messages', roomId],
    queryFn: ({ pageParam }) =>
      api<{ messages: ChatMessage[]; hasMore: boolean }>(
        `rooms/${roomId}/messages${pageParam ? `?before=${pageParam}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.seq : undefined),
    enabled: !!roomId && !!room && has(BigInt(room.permissions), P.READ_HISTORY),
    refetchInterval: 20000,
  });
  const messageMap = new Map<string, ChatMessage>();
  if (room && has(BigInt(room.permissions), P.READ_HISTORY) && !history.isError)
    for (const page of [...(history.data?.pages ?? [])].reverse())
      for (const m of page.messages) messageMap.set(m.id, m);
  const messages = [...messageMap.values()];
  const results = useQuery({
    queryKey: ['search', searchQuery, serverId, roomId],
    queryFn: () =>
      api<ChatMessage[]>(
        `search?q=${encodeURIComponent(searchQuery)}${serverId ? `&serverId=${serverId}` : roomId ? `&roomId=${roomId}` : ''}`,
      ),
    enabled: !!searchQuery && modal === 'search',
  });
  const related = workspace?.relationships ?? [];
  const blocked = new Set(
    related.filter((r) => r.kind === 'BLOCK' && r.fromId === user?.id).map((r) => r.toId),
  );
  function notify(message: string) {
    setNotice(message);
  }
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    setAccountReset(new URLSearchParams(window.location.search).has('reset'));
    const value = localStorage.getItem('ripcord-theme') ?? 'dark';
    setTheme(value);
    document.documentElement.dataset.theme = value;
  }, []);
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search),
      invite = params.get('invite'),
      verify = params.get('verify');
    if (!invite && !verify) return;
    window.history.replaceState(null, '', '/');
    const operation = invite
      ? api(`invites/${encodeURIComponent(invite)}`, 'POST', {})
      : api('auth/verify', 'POST', { token: verify });
    void operation
      .then(() => {
        notify(invite ? 'Invitation accepted. Welcome in.' : 'Email verified.');
        return qc.invalidateQueries({ queryKey: ['workspace'] });
      })
      .catch((e) => setError((e as Error).message));
  }, [user?.id]);
  function toggleTheme() {
    const value = theme === 'dark' ? 'light' : 'dark';
    setTheme(value);
    document.documentElement.dataset.theme = value;
    localStorage.setItem('ripcord-theme', value);
  }
  useEffect(() => {
    if (!workspace) return;
    if (!initialized) {
      const saved = localStorage.getItem('ripcord-room'),
        found = allRooms.find((r) => r.id === saved);
      setServerId(found?.serverId ?? workspace.servers[0]?.id ?? null);
      setRoomId(found?.id ?? workspace.servers[0]?.rooms[0]?.id ?? null);
      setInitialized(true);
    } else if (roomId && !room) {
      setRoomId(null);
      qc.removeQueries({ queryKey: ['messages', roomId] });
    }
    if (serverId && !server) setServerId(null);
  }, [workspace]); // Server responses govern available navigation.
  useEffect(() => {
    setContent('');
    setReply(null);
    setFiles([]);
    setTyping({});
    setOnline([]);
    pinned.current = true;
    if (roomId) localStorage.setItem('ripcord-room', roomId);
    if (socket.current?.connected && roomId) socket.current.emit('subscribe', roomId);
    else socket.current?.emit('unsubscribe');
  }, [roomId]);
  useEffect(() => {
    if (!user || accountReset) return;
    const s = io({ transports: ['websocket', 'polling'] });
    socket.current = s;
    const events = new Set<string>();
    s.on('connect', () => {
      setConnected(true);
      if (currentRoom.current) s.emit('subscribe', currentRoom.current);
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    });
    s.on('disconnect', () => {
      setConnected(false);
      setOnline([]);
    });
    s.on('invalidate', (e: { id: string; type: string; roomId?: string }) => {
      if (events.has(e.id)) return;
      events.add(e.id);
      if (events.size > 500) events.delete(events.values().next().value!);
      void qc.invalidateQueries({ queryKey: ['workspace'] });
      if (e.type === 'permissions' || e.type === 'membership' || e.type === 'conversations') {
        qc.removeQueries({ queryKey: ['messages'] });
        qc.removeQueries({ queryKey: ['search'] });
      } else void qc.invalidateQueries({ queryKey: ['search'] });
      if (e.roomId) void qc.invalidateQueries({ queryKey: ['messages', e.roomId] });
      else {
        void qc.invalidateQueries({ queryKey: ['server'] });
        void qc.invalidateQueries({ queryKey: ['messages'] });
      }
    });
    s.on('access.revoked', (e: { roomId: string }) => {
      qc.removeQueries({ queryKey: ['messages', e.roomId] });
      if (currentRoom.current === e.roomId) {
        setRoomId(null);
        notify('Your access to that conversation changed.');
      }
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    });
    s.on('account.revoked', () => {
      qc.clear();
      window.location.reload();
    });
    s.on('presence', (e: { roomId: string; users: Person[] }) => {
      if (e.roomId === currentRoom.current) setOnline(e.users);
    });
    s.on('typing', (e: { roomId: string; user: Person }) => {
      if (e.roomId === currentRoom.current)
        setTyping((t) => ({
          ...t,
          [e.user.id]: { name: e.user.displayName, until: Date.now() + 5000 },
        }));
    });
    const t = setInterval(
      () =>
        setTyping((old) =>
          Object.fromEntries(Object.entries(old).filter(([, v]) => v.until > Date.now())),
        ),
      2000,
    );
    return () => {
      s.disconnect();
      socket.current = null;
      clearInterval(t);
    };
  }, [user?.id, qc, accountReset]);
  useEffect(() => {
    const box = scroller.current;
    if (box && pinned.current) box.scrollTop = box.scrollHeight;
    const last = messages.at(-1);
    if (
      last &&
      roomId &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      pinned.current
    )
      void api(`rooms/${roomId}/read`, 'POST', { seq: last.seq })
        .then(() => qc.invalidateQueries({ queryKey: ['workspace'] }))
        .catch(() => {});
    setPending((old) =>
      old.filter((p) => !messages.some((m) => m.nonce === p.nonce && m.authorId === user?.id)),
    );
  }, [history.data, roomId, pending.length]);
  const previousMentions = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!workspace) return;
    const now = new Map(allRooms.map((r) => [r.id, r.mentions]));
    if (
      previousMentions.current &&
      'Notification' in window &&
      Notification.permission === 'granted'
    )
      for (const r of allRooms) {
        if (
          r.mentions > (previousMentions.current.get(r.id) ?? r.mentions) &&
          (r.id !== roomId || document.visibilityState !== 'visible')
        ) {
          const n = new Notification('You were mentioned on RipCord', {
            body: `New mention in ${r.name}`,
            tag: r.id,
            icon: '/icon.svg',
          });
          n.onclick = () => {
            window.focus();
            chooseRoom(r);
            n.close();
          };
        }
      }
    previousMentions.current = now;
  }, [workspace]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setModal('search');
      }
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
  function chooseRoom(r: ChatRoom) {
    setRoomId(r.id);
    setServerId(r.serverId);
    setNavOpen(false);
    setError('');
  }
  function chooseServer(s: Community) {
    setServerId(s.id);
    setRoomId(s.rooms[0]?.id ?? null);
    setNavOpen(false);
  }
  async function action(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['workspace'] });
      await qc.invalidateQueries({ queryKey: ['server'] });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function transmit(p: Pending) {
    setPending((old) => old.map((m) => (m.nonce === p.nonce ? { ...m, failed: false } : m)));
    try {
      await api(`rooms/${p.roomId}/messages`, 'POST', {
        content: p.content,
        nonce: p.nonce,
        replyId: p.replyId,
        attachmentIds: p.attachmentIds,
      });
      await qc.invalidateQueries({ queryKey: ['messages', p.roomId] });
      await qc.invalidateQueries({ queryKey: ['workspace'] });
    } catch (e) {
      setPending((old) =>
        old.map((m) =>
          m.nonce === p.nonce ? { ...m, failed: true, error: (e as Error).message } : m,
        ),
      );
    }
  }
  function send() {
    if (
      !room ||
      !canSend ||
      (!content.trim() && !files.length) ||
      uploading ||
      content.length > workspace!.instance.maxMessageLength
    )
      return;
    const p = {
      nonce: createMessageNonce(),
      roomId: room.id,
      content,
      attachmentIds: files.map((f) => f.id),
      replyId: reply?.id,
      failed: false,
    };
    setPending((old) => [...old, p]);
    pinned.current = true;
    setContent('');
    setReply(null);
    setFiles([]);
    void transmit(p);
    inputRef.current?.focus();
  }
  async function uploadFiles(list: FileList | null) {
    if (!list || !workspace) return;
    setUploading(true);
    setError('');
    try {
      if (list.length + files.length > workspace.instance.maxAttachments)
        throw new Error(`Attach up to ${workspace.instance.maxAttachments} files.`);
      for (const file of Array.from(list)) {
        if (file.size > workspace.instance.maxFileBytes)
          throw new Error(
            `Files must be smaller than ${Math.round(workspace.instance.maxFileBytes / 1048576)} MB.`,
          );
        const form = new FormData();
        form.set('file', file);
        const result = await api<{ id: string; name: string }>('uploads', 'POST', form);
        setFiles((old) => [...old, result]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function startDm(person: Person) {
    await action(async () => {
      const dm = await api<ChatRoom>('dms', 'POST', { userIds: [person.id] });
      await qc.invalidateQueries({ queryKey: ['workspace'] });
      setRoomId(dm.id);
      setServerId(null);
      setSelectedUser(null);
    });
  }
  const loadingScreen = (
    <div className="loading-screen">
      <Logo />
      <LoaderCircle className="spin" size={25} />
      <span>Finding your conversations…</span>
    </div>
  );
  if (publicInfo.isPending) return loadingScreen;
  if (!publicInfo.data)
    return (
      <div className="loading-screen">
        <Logo />
        <ErrorNote error={publicInfo.error?.message} />
        <button className="primary-button" onClick={() => void publicInfo.refetch()}>
          Try again
        </button>
      </div>
    );
  if (accountReset || workspace === null)
    return (
      <AuthScreen
        info={publicInfo.data}
        onLogin={() => {
          setInitialized(false);
          // Explicit refetch also works while the reset flow has automatic fetching paused.
          void data.refetch().then((result) => {
            if (result.data) setAccountReset(false);
          });
        }}
      />
    );
  if (data.isPending) return loadingScreen;
  if (!workspace)
    return (
      <div className="loading-screen">
        <Logo />
        <ErrorNote error={data.error?.message} />
        <button className="primary-button" onClick={() => void data.refetch()}>
          Try again
        </button>
      </div>
    );
  const dmTitle = (r: ChatRoom) =>
    r.kind === 'DIRECT'
      ? (r.members?.find((m) => m.user.id !== user!.id)?.user.displayName ?? r.name)
      : r.name;
  const displayedMembers = serverId
    ? (details.data?.members.map((m) => ({
        ...m.user,
        nickname: m.nickname,
        roles: m.roles.map((r) => r.role),
      })) ?? [])
    : (room?.members?.map((m) => m.user) ?? []);
  const onlineIds = new Set(online.map((p) => p.id));
  const typingNames = Object.values(typing).map((t) => t.name);
  const mention = content.match(/(?:^|\s)@([\w]*)$/)?.[1];
  const mentionPeople =
    mention !== undefined
      ? displayedMembers.filter((p) => p.username.startsWith(mention)).slice(0, 5)
      : [];
  const closeModal = () => {
    setModal('');
    setSearchQuery('');
    setError('');
  };
  return (
    <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
      <div className="app-top">
        <button
          className="mobile-menu icon-button"
          aria-label="Open navigation"
          onClick={() => setNavOpen((v) => !v)}
        >
          <MenuIcon size={19} />
        </button>
        <Logo />
      </div>
      {navOpen && (
        <button
          className="nav-backdrop"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <nav className="server-rail" aria-label="Servers">
        <button
          className={`rail-home ${!serverId ? 'selected' : ''}`}
          aria-label="Direct messages and friends"
          onClick={() => {
            setServerId(null);
            setRoomId(null);
            setNavOpen(false);
          }}
        >
          <MessageCircle size={24} />
          {workspace.dms.some((r) => r.unread) && <i className="rail-dot" />}
        </button>
        <div className="rail-divider" />
        {workspace.servers.map((s) => (
          <button
            key={s.id}
            className={`server-icon ${serverId === s.id ? 'selected' : ''}`}
            title={s.name}
            aria-label={s.name}
            onClick={() => chooseServer(s)}
          >
            {s.icon ||
              s.name
                .split(/\s+/)
                .map((w) => w[0])
                .join('')
                .slice(0, 2)}
            {s.rooms.some((r) => r.unread) && <i className="rail-dot" />}
            {s.rooms.some((r) => r.mentions) && (
              <span className="rail-badge">{s.rooms.reduce((a, r) => a + r.mentions, 0)}</span>
            )}
          </button>
        ))}
        <button
          className="rail-add"
          aria-label="Create or join a server"
          title="Create or join a server"
          onClick={() => setModal('community')}
        >
          <Plus size={25} />
        </button>
        <div className="rail-bottom">
          <button
            className="icon-button"
            aria-label="Switch theme"
            title="Switch theme"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
          </button>
        </div>
      </nav>
      <aside className="channel-sidebar">
        <header className="sidebar-header">
          {server ? (
            <Menu label={server.name}>
              <MenuItem onClick={() => setModal('invite')}>
                <UserPlus size={16} /> Invite people
              </MenuItem>
              {(BigInt(server.permissions) &
                (P.MANAGE_SERVER |
                  P.MANAGE_ROLES |
                  P.MANAGE_CHANNELS |
                  P.MANAGE_MESSAGES |
                  P.VIEW_AUDIT_LOG |
                  P.KICK_MEMBERS |
                  P.BAN_MEMBERS |
                  P.MODERATE_MEMBERS |
                  P.MANAGE_NICKNAMES)) !==
                0n && (
                <MenuItem onClick={() => setModal('server-settings')}>
                  <Settings size={16} /> Server settings
                </MenuItem>
              )}
              <MenuItem onClick={() => setModal('leave-server')} danger>
                <LogOut size={16} /> Leave server
              </MenuItem>
            </Menu>
          ) : (
            <strong>Your conversations</strong>
          )}
        </header>
        <div className="sidebar-scroll">
          {server ? (
            <>
              <div className="community-summary">
                <span className="community-glyph">{server.icon || <Users size={24} />}</span>
                <strong>{server.name}</strong>
                <p>{server.description || 'A good place to call your own.'}</p>
                <span>
                  <span className="live-dot" />
                  {details.data?.members.length ?? '—'} members
                </span>
              </div>
              <div className="sidebar-section-label">
                CHANNELS
                {has(BigInt(server.permissions), P.MANAGE_CHANNELS) && (
                  <button
                    className="icon-button"
                    aria-label="Create a channel"
                    onClick={() => setModal('create-channel')}
                  >
                    <Plus size={15} />
                  </button>
                )}
              </div>
              {[
                ...server.categories,
                ...(server.rooms.some((r) => !r.categoryId)
                  ? [{ id: '', name: 'Uncategorized', position: 0 }]
                  : []),
              ].map((category) => (
                <div className="channel-category" key={category.id}>
                  <button
                    className="category-name"
                    onClick={() =>
                      setCollapsed((v) =>
                        v.includes(category.id)
                          ? v.filter((c) => c !== category.id)
                          : [...v, category.id],
                      )
                    }
                  >
                    {collapsed.includes(category.id) ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    {category.name}
                  </button>
                  {!collapsed.includes(category.id) &&
                    server.rooms
                      .filter((r) => (r.categoryId ?? '') === category.id)
                      .map((r) => (
                        <button
                          key={r.id}
                          className={`channel-item ${roomId === r.id ? 'active' : ''} ${r.unread ? 'unread' : ''}`}
                          onClick={() => chooseRoom(r)}
                        >
                          <Hash size={19} />
                          <span>{r.name}</span>
                          {r.mentions > 0 ? (
                            <span className="count-badge">{r.mentions}</span>
                          ) : (
                            r.unread > 0 && <i className="unread-dot" />
                          )}
                        </button>
                      ))}
                </div>
              ))}
              <button className="invite-nudge" onClick={() => setModal('invite')}>
                <span>
                  <UserPlus size={17} />
                  <strong>Better together</strong>
                </span>
                <p>Bring your people into the conversation.</p>
                <span className="nudge-link">
                  Invite a friend <ArrowUp size={13} />
                </span>
              </button>
            </>
          ) : (
            <>
              <button
                className={`friends-nav ${!roomId ? 'active' : ''}`}
                onClick={() => setRoomId(null)}
              >
                <Users size={20} /> Friends
                {related.filter((r) => r.kind === 'REQUEST' && r.toId === user!.id).length > 0 && (
                  <span className="count-badge">
                    {related.filter((r) => r.kind === 'REQUEST' && r.toId === user!.id).length}
                  </span>
                )}
              </button>
              <button className="find-conversation" onClick={() => setModal('search')}>
                <Search size={15} /> Find a conversation <kbd>⌘ K</kbd>
              </button>
              <div className="sidebar-section-label">
                DIRECT MESSAGES
                <button
                  className="icon-button"
                  aria-label="New direct message"
                  onClick={() => setModal('new-dm')}
                >
                  <Plus size={16} />
                </button>
              </div>
              {workspace.dms.map((r) => {
                const person = r.members?.find((m) => m.user.id !== user!.id)?.user;
                return (
                  <button
                    className={`dm-item ${roomId === r.id ? 'active' : ''}`}
                    key={r.id}
                    onClick={() => chooseRoom(r)}
                  >
                    {r.kind === 'DIRECT' && person ? (
                      <Avatar user={person} size="small" />
                    ) : (
                      <span className="group-avatar">
                        <Users size={17} />
                      </span>
                    )}
                    <span>{dmTitle(r)}</span>
                    {r.unread > 0 && <span className="count-badge">{r.unread}</span>}
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="user-dock">
          <Avatar user={user!} size="small" online={connected} />
          <div>
            <strong>{user!.displayName}</strong>
            {!connected && <span>Reconnecting…</span>}
          </div>
          <Menu label="Account menu" trigger={<Settings size={18} />}>
            <MenuItem onClick={() => setModal('account-settings')}>
              <Settings size={16} /> Account settings
            </MenuItem>
            {user!.isAdmin && (
              <MenuItem onClick={() => setModal('admin-settings')}>
                <Shield size={16} /> Instance administration
              </MenuItem>
            )}
            <MenuItem onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />} Switch theme
            </MenuItem>
            <MenuItem
              onClick={() =>
                void action(async () => {
                  await api('auth/logout', 'POST', {});
                  qc.clear();
                  window.location.reload();
                })
              }
              danger
            >
              <LogOut size={16} /> Sign out
            </MenuItem>
          </Menu>
        </div>
      </aside>
      <main className="main-pane">
        <header className="chat-header">
          {room ? (
            <>
              <span className="header-channel-icon">
                {room.kind === 'TEXT' ? (
                  <Hash size={24} />
                ) : room.kind === 'GROUP' ? (
                  <Users size={22} />
                ) : (
                  <MessageCircle size={22} />
                )}
              </span>
              <strong>{room.kind === 'TEXT' ? room.name : dmTitle(room)}</strong>
              {room.topic && (
                <>
                  <span className="header-divider" />
                  <span className="channel-topic">{room.topic}</span>
                </>
              )}
            </>
          ) : (
            <>
              <Users size={22} />
              <strong>{server ? server.name : 'Friends'}</strong>
              {server && (
                <>
                  <span className="header-divider" />
                  <span className="channel-topic">Make yourself at home.</span>
                </>
              )}
            </>
          )}
          <div className="header-actions">
            {room?.kind === 'GROUP' && (
              <button
                className="icon-button"
                aria-label="Manage group"
                onClick={() => setModal('group')}
              >
                <Settings size={19} />
              </button>
            )}
            <button
              className="icon-button"
              title="Notifications"
              aria-label="Enable browser notifications"
              onClick={async () => {
                if (!('Notification' in window))
                  return notify('Browser notifications are unavailable.');
                const result = await Notification.requestPermission();
                notify(
                  result === 'granted'
                    ? 'Mention notifications enabled while RipCord is open.'
                    : 'Notifications are disabled in your browser.',
                );
              }}
            >
              <Bell size={19} />
            </button>
            <button
              className={`icon-button ${showMembers ? 'active' : ''}`}
              title="Toggle members"
              aria-label="Toggle member list"
              onClick={() => setShowMembers((v) => !v)}
            >
              <PanelRight size={20} />
            </button>
            <button className="header-search" onClick={() => setModal('search')}>
              <span>Search</span>
              <kbd>⌘ K</kbd>
              <Search size={15} />
            </button>
          </div>
        </header>
        {!connected && (
          <div className="connection-banner">
            <WifiOff size={14} /> Reconnecting. Your messages are saved on this instance.
          </div>
        )}
        <ErrorNote error={error} />
        {room ? (
          <div className="chat-body">
            <div className="conversation">
              <div
                ref={scroller}
                className="message-scroll"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                }}
              >
                <div className="channel-welcome">
                  <div className="welcome-hash">
                    {room.kind === 'TEXT' ? <Hash size={39} /> : <MessageCircle size={37} />}
                  </div>
                  <span className="eyebrow">
                    {room.kind === 'TEXT' ? 'YOUR CONVERSATION STARTS HERE' : 'A LITTLE CLOSER'}
                  </span>
                  <h1>{room.kind === 'TEXT' ? `Welcome to #${room.name}` : dmTitle(room)}</h1>
                  <p>
                    {room.topic ||
                      (room.kind === 'TEXT'
                        ? `This is the beginning of ${room.name}. Say something good.`
                        : 'Just you and your people. Say hello.')}
                  </p>
                  {server && has(BigInt(server.permissions), P.MANAGE_CHANNELS) && (
                    <button className="text-button" onClick={() => setModal('server-settings')}>
                      <Pencil size={13} /> Edit channel
                    </button>
                  )}
                </div>
                {history.hasNextPage && (
                  <button
                    className="load-history"
                    disabled={history.isFetchingNextPage}
                    onClick={() => {
                      pinned.current = false;
                      void history.fetchNextPage();
                    }}
                  >
                    {history.isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}
                  </button>
                )}
                {history.isPending && has(BigInt(room.permissions), P.READ_HISTORY) && (
                  <div className="message-loading">
                    <LoaderCircle className="spin" size={19} /> Loading messages…
                  </div>
                )}
                {history.isError ? (
                  <ErrorNote error={history.error.message} />
                ) : (
                  messages.map((message, i) => (
                    <Message
                      key={message.id}
                      message={message}
                      previous={messages[i - 1]}
                      userId={user!.id}
                      blocked={blocked.has(message.authorId)}
                      canModerate={
                        room.kind === 'TEXT' && has(BigInt(room.permissions), P.MANAGE_MESSAGES)
                      }
                      canReact={has(BigInt(room.permissions), P.ADD_REACTIONS)}
                      canSend={canSend}
                      onReply={() => {
                        setReply(message);
                        inputRef.current?.focus();
                      }}
                      onProfile={() => setSelectedUser(message.author)}
                      onChanged={() =>
                        void qc.invalidateQueries({ queryKey: ['messages', roomId] })
                      }
                      onError={setError}
                    />
                  ))
                )}
                {pending
                  .filter((p) => p.roomId === roomId)
                  .map((p) => (
                    <div className={`pending-message ${p.failed ? 'failed' : ''}`} key={p.nonce}>
                      <Avatar user={user!} />
                      <div>
                        <strong>{user!.displayName}</strong>
                        <p>{p.content || `${p.attachmentIds.length} attachment(s)`}</p>
                        {p.failed ? (
                          <span>
                            {p.error}{' '}
                            <button className="text-button" onClick={() => void transmit(p)}>
                              Retry
                            </button>
                            <button
                              className="text-button"
                              onClick={() =>
                                setPending((old) => old.filter((m) => m.nonce !== p.nonce))
                              }
                            >
                              Dismiss
                            </button>
                          </span>
                        ) : (
                          <span>Sending…</span>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
              <div className="composer-area">
                {reply && (
                  <div className="reply-strip">
                    <Reply size={14} /> Replying to <strong>{reply.author.displayName}</strong>
                    <span>{reply.content?.slice(0, 80) ?? 'Attachment'}</span>
                    <button
                      className="icon-button"
                      onClick={() => setReply(null)}
                      aria-label="Cancel reply"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                {files.length > 0 && (
                  <div className="attachment-strip">
                    {files.map((f) => (
                      <span key={f.id}>
                        <Paperclip size={14} />
                        {f.name}
                        <button
                          aria-label={`Remove ${f.name}`}
                          onClick={() => setFiles((old) => old.filter((v) => v.id !== f.id))}
                        >
                          <X size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {mentionPeople.length > 0 && (
                  <div className="mention-menu">
                    {mentionPeople.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setContent((c) => c.replace(/@[\w]*$/, `@${p.username} `));
                          inputRef.current?.focus();
                        }}
                      >
                        <Avatar user={p} size="tiny" />
                        {p.displayName}
                        <span>@{p.username}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className={`composer ${!canSend ? 'disabled' : ''}`}>
                  <button
                    className="composer-attach"
                    aria-label="Attach a file"
                    disabled={
                      !canSend || uploading || !has(BigInt(room.permissions), P.ATTACH_FILES)
                    }
                    onClick={() => fileInput.current?.click()}
                  >
                    {uploading ? <LoaderCircle className="spin" size={19} /> : <Plus size={20} />}
                  </button>
                  <input
                    className="sr-only"
                    tabIndex={-1}
                    type="file"
                    multiple
                    ref={fileInput}
                    onChange={(e) => void uploadFiles(e.target.files)}
                  />
                  <textarea
                    ref={inputRef}
                    aria-label={`Message ${room.name}`}
                    rows={1}
                    disabled={!canSend}
                    value={content}
                    placeholder={
                      canSend
                        ? `Message ${room.kind === 'TEXT' ? '#' + room.name : dmTitle(room)}`
                        : 'You don’t have permission to send messages here.'
                    }
                    onChange={(e) => {
                      setContent(e.target.value);
                      socket.current?.emit('typing');
                      e.target.style.height = 'auto';
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        send();
                        e.currentTarget.style.height = 'auto';
                      }
                    }}
                  />
                  <Menu label="Insert emoji" trigger={<Smile size={21} />}>
                    {['🙂', '✨', '🎉', '💜', '👋', '🔥', '👍', '❤️'].map((emoji) => (
                      <MenuItem
                        key={emoji}
                        onClick={() => {
                          setContent((c) => c + emoji);
                          inputRef.current?.focus();
                        }}
                      >
                        {emoji}
                      </MenuItem>
                    ))}
                  </Menu>
                  <button
                    className="send-button"
                    aria-label="Send message"
                    disabled={
                      !canSend ||
                      (!content.trim() && !files.length) ||
                      uploading ||
                      content.length > workspace.instance.maxMessageLength
                    }
                    onClick={send}
                  >
                    <ArrowUp size={18} />
                  </button>
                </div>
                <div className="composer-meta">
                  <span>
                    {typingNames.length ? (
                      <>
                        <span className="typing-dots">
                          <i />
                          <i />
                          <i />
                        </span>
                        <strong>{typingNames.join(', ')}</strong>{' '}
                        {typingNames.length === 1 ? 'is' : 'are'} typing
                      </>
                    ) : (
                      <>
                        <strong>Enter</strong> to send <span>·</span> <strong>Shift + Enter</strong>{' '}
                        for a new line
                      </>
                    )}
                  </span>
                  <span>
                    {content.length > workspace.instance.maxMessageLength * 0.8 ? (
                      `${content.length}/${workspace.instance.maxMessageLength}`
                    ) : room.slowMode > 0 ? (
                      `${room.slowMode}s slow mode`
                    ) : (
                      <>
                        <LockKeyhole size={11} /> On your instance
                      </>
                    )}
                  </span>
                </div>
              </div>
            </div>
            {showMembers && (
              <aside className="members-sidebar">
                <div className="members-title">
                  MEMBERS <span>{displayedMembers.length}</span>
                  <button
                    className="icon-button members-close"
                    aria-label="Close members"
                    onClick={() => setShowMembers(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                {[true, false].map((isOnline) => {
                  const group = displayedMembers.filter((p) => onlineIds.has(p.id) === isOnline);
                  return (
                    group.length > 0 && (
                      <section key={String(isOnline)}>
                        <h3>
                          {isOnline ? 'ONLINE' : 'OFFLINE'} <span>— {group.length}</span>
                        </h3>
                        {group.map((person) => {
                          const member = person as Person & {
                            nickname?: string;
                            roles?: { name: string; color: string; position: number }[];
                          };
                          const role = member.roles?.sort((a, b) => b.position - a.position)[0];
                          return (
                            <button
                              className={`member-row ${!isOnline ? 'offline' : ''}`}
                              key={person.id}
                              onClick={() => setSelectedUser(person)}
                            >
                              <Avatar user={person} size="small" online={isOnline} />
                              <span>
                                <strong style={role ? { color: role.color } : undefined}>
                                  {member.nickname || person.displayName}
                                  {person.id === server?.ownerId && (
                                    <span className="owner-crown" title="Server owner">
                                      ♛
                                    </span>
                                  )}
                                </strong>
                                <small>
                                  {role?.name ||
                                    (person.id === user!.id ? 'That’s you' : '@' + person.username)}
                                </small>
                              </span>
                            </button>
                          );
                        })}
                      </section>
                    )
                  );
                })}
                <div className="member-footer">
                  <span className="live-dot" /> A space of your own.
                </div>
              </aside>
            )}
          </div>
        ) : server ? (
          <Empty icon={<Hash size={34} />} title="Your next conversation starts here.">
            <p>
              {server.rooms.length
                ? 'Pick a channel and say hello.'
                : 'No channels are visible to you in this server.'}
            </p>
            {has(BigInt(server.permissions), P.MANAGE_CHANNELS) && (
              <button className="primary-button" onClick={() => setModal('create-channel')}>
                <Plus size={16} /> Create a channel
              </button>
            )}
          </Empty>
        ) : (
          <Friends
            workspace={workspace}
            onDm={startDm}
            onProfile={setSelectedUser}
            onNewDm={() => setModal('new-dm')}
            onCreateServer={() => setModal('community')}
            onError={setError}
          />
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
      {['account-settings', 'server-settings', 'admin-settings'].includes(modal) && (
        <Modal
          title={
            modal === 'server-settings'
              ? `${server?.name} settings`
              : modal === 'admin-settings'
                ? 'Instance administration'
                : 'Your settings'
          }
          open
          onClose={closeModal}
          wide
        >
          <SettingsPanel
            mode={modal.split('-')[0] as 'account' | 'server' | 'admin'}
            workspace={workspace}
            serverId={serverId}
            onNotice={notify}
            onClose={closeModal}
          />
        </Modal>
      )}
      <Modal
        title="A place for your people"
        description="Create your own server or join one with an invitation."
        open={modal === 'community'}
        onClose={closeModal}
      >
        <div className="modal-body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(async () => {
                const s = await api<Community>('servers', 'POST', {
                  name: f.get('name'),
                  description: f.get('description'),
                });
                await qc.invalidateQueries({ queryKey: ['workspace'] });
                setServerId(s.id);
                setRoomId(null);
                closeModal();
              });
            }}
          >
            <label>
              SERVER NAME
              <input name="name" required maxLength={80} placeholder="The Weekend Club" />
            </label>
            <label>
              DESCRIPTION
              <textarea
                name="description"
                maxLength={500}
                placeholder="What brings your people together?"
              />
            </label>
            <button className="primary-button full">
              <Plus size={16} /> Create server
            </button>
          </form>
          <div className="form-divider">ALREADY HAVE AN INVITATION?</div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const code =
                String(f.get('invite')).split('invite=')[1]?.split('&')[0] ??
                String(f.get('invite'));
              void action(async () => {
                await api(`invites/${encodeURIComponent(code)}`, 'POST', {});
                closeModal();
                notify('You joined the server.');
              });
            }}
          >
            <label>
              INVITATION CODE
              <input name="invite" required placeholder="Paste a code or invitation link" />
            </label>
            <button className="secondary-button full">
              <LinkIcon size={16} /> Join server
            </button>
          </form>
          <ErrorNote error={error} />
        </div>
      </Modal>
      <Modal
        title="Invite your people"
        description="A server invitation can also create an account when registration is closed."
        open={modal === 'invite'}
        onClose={closeModal}
      >
        <InviteForm serverId={serverId} onError={setError} />
        <ErrorNote error={error} />
      </Modal>
      <Modal title="Create a channel" open={modal === 'create-channel'} onClose={closeModal}>
        <div className="modal-body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(async () => {
                const r = await api<ChatRoom>(`servers/${serverId}/channels`, 'POST', {
                  name: f.get('name'),
                  topic: f.get('topic'),
                  categoryId: f.get('categoryId') || null,
                  ...(f.get('privateRoleId') ? { privateRoleId: f.get('privateRoleId') } : {}),
                });
                await qc.invalidateQueries({ queryKey: ['workspace'] });
                setRoomId(r.id);
                closeModal();
              });
            }}
          >
            <label>
              CHANNEL NAME
              <input name="name" required pattern="[a-zA-Z0-9_-]+" placeholder="the-good-stuff" />
            </label>
            <label>
              TOPIC
              <input name="topic" maxLength={500} placeholder="What’s this channel for?" />
            </label>
            <label>
              CATEGORY
              <select name="categoryId">
                <option value="">Uncategorized</option>
                {server?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              VISIBILITY
              <select name="privateRoleId">
                <option value="">Everyone in the server</option>
                {details.data?.roles
                  .filter((r) => !r.everyone)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      Private: {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <ErrorNote error={error} />
            <button className="primary-button full">Create channel</button>
          </form>
        </div>
      </Modal>
      <Modal
        title="Start a conversation"
        description="Find people by username. Choose one for a DM, or several for a group."
        open={modal === 'new-dm'}
        onClose={closeModal}
      >
        <NewDm
          userId={user!.id}
          onCreated={async (dm) => {
            await qc.invalidateQueries({ queryKey: ['workspace'] });
            setServerId(null);
            setRoomId(dm.id);
            closeModal();
          }}
        />
      </Modal>
      <Modal
        title="Search conversations"
        description="Search the messages you have access to."
        open={modal === 'search'}
        onClose={closeModal}
        wide
      >
        <div className="modal-body">
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              setSearchQuery(search);
            }}
          >
            <Search size={19} />
            <input
              value={search}
              autoFocus
              placeholder={
                server
                  ? `Search in ${server.name}`
                  : room
                    ? 'Search this conversation'
                    : 'Search all your conversations'
              }
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="primary-button">Search</button>
          </form>
          {results.isFetching && <p className="muted">Searching…</p>}
          <ErrorNote error={results.error?.message} />
          {results.data?.length === 0 && (
            <Empty title="No messages found.">
              <p>Try a different word or phrase.</p>
            </Empty>
          )}
          <div className="search-results">
            {results.data?.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  const r = allRooms.find((v) => v.id === m.roomId);
                  if (r) chooseRoom(r);
                  closeModal();
                  notify(
                    'Conversation opened. Older results are available through Load earlier messages.',
                  );
                }}
              >
                <Avatar user={m.author} size="small" />
                <span>
                  <strong>{m.author.displayName}</strong>
                  <small>
                    {allRooms.find((r) => r.id === m.roomId)?.name} ·{' '}
                    {new Date(m.createdAt).toLocaleDateString()}
                  </small>
                  <p>{m.content}</p>
                </span>
              </button>
            ))}
          </div>
        </div>
      </Modal>
      <Modal
        title={selectedUser?.displayName ?? 'Profile'}
        open={!!selectedUser}
        onClose={() => setSelectedUser(null)}
      >
        {selectedUser && (
          <div className="modal-body profile-body">
            <Avatar user={selectedUser} size="large" />
            <h2>{selectedUser.displayName}</h2>
            <p>@{selectedUser.username}</p>
            {server &&
              selectedUser.id === user!.id &&
              has(BigInt(server.permissions), P.CHANGE_NICKNAME) && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget);
                    void action(async () => {
                      await api(`servers/${server.id}/members/${user!.id}`, 'POST', {
                        action: 'nickname',
                        nickname: form.get('nickname') || null,
                      });
                      notify('Server nickname updated.');
                      setSelectedUser(null);
                    });
                  }}
                >
                  <label>
                    SERVER NICKNAME
                    <input
                      name="nickname"
                      maxLength={32}
                      defaultValue={
                        details.data?.members.find((m) => m.user.id === user!.id)?.nickname ?? ''
                      }
                    />
                  </label>
                  <button className="secondary-button full">Save nickname</button>
                </form>
              )}
            {selectedUser.id !== user!.id && (
              <>
                <button className="primary-button full" onClick={() => void startDm(selectedUser)}>
                  <MessageCircle size={17} /> Message
                </button>
                <button
                  className="secondary-button full"
                  onClick={() =>
                    void action(async () => {
                      await api('relationships', 'POST', {
                        userId: selectedUser.id,
                        action: 'request',
                      });
                      notify('Friend request sent.');
                    })
                  }
                >
                  <UserPlus size={17} /> Add friend
                </button>
                <button
                  className="text-button danger-text"
                  onClick={() =>
                    void action(async () => {
                      await api('relationships', 'POST', {
                        userId: selectedUser.id,
                        action: blocked.has(selectedUser.id) ? 'unblock' : 'block',
                      });
                      setSelectedUser(null);
                    })
                  }
                >
                  {blocked.has(selectedUser.id) ? 'Unblock user' : 'Block user'}
                </button>
              </>
            )}
            <ErrorNote error={error} />
          </div>
        )}
      </Modal>
      <Modal title="Leave this server?" open={modal === 'leave-server'} onClose={closeModal}>
        <div className="modal-body">
          <p>
            You’ll need another invitation to rejoin. Owners must transfer ownership in server
            settings first.
          </p>
          <ErrorNote error={error} />
          <button
            className="danger-button full"
            onClick={() =>
              void action(async () => {
                await api(`servers/${serverId}/leave`, 'POST', {});
                setRoomId(null);
                setServerId(null);
                closeModal();
              })
            }
          >
            Leave server
          </button>
        </div>
      </Modal>
      <Modal title="Group conversation" open={modal === 'group'} onClose={closeModal}>
        <div className="modal-body">
          {room?.ownerId === user!.id && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void action(async () => {
                    await api(`rooms/${roomId}`, 'PATCH', { name: f.get('name') });
                    notify('Group updated.');
                  });
                }}
              >
                <label>
                  GROUP NAME
                  <input name="name" defaultValue={room.name} required />
                </label>
                <button className="primary-button">Save name</button>
              </form>
              <GroupMemberForm
                room={room}
                onChanged={() => void qc.invalidateQueries({ queryKey: ['workspace'] })}
                onError={setError}
              />
            </>
          )}
          {room?.members?.map((m) => (
            <div className="management-row" key={m.user.id}>
              <Avatar user={m.user} size="small" />
              <span>
                {m.user.displayName}
                {m.user.id === room.ownerId && ' · Owner'}
              </span>
              {room.ownerId === user!.id && m.user.id !== user!.id && (
                <>
                  <button
                    className="text-button"
                    onClick={() =>
                      void action(() => api(`rooms/${roomId}`, 'PATCH', { ownerId: m.user.id }))
                    }
                  >
                    Make owner
                  </button>
                  <button
                    className="text-button danger-text"
                    onClick={() =>
                      void action(() => api(`rooms/${roomId}/members/${m.user.id}`, 'DELETE'))
                    }
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
          ))}
          <button
            className="secondary-button full"
            onClick={() =>
              void action(async () => {
                await api(`rooms/${roomId}/members/${user!.id}`, 'DELETE');
                setRoomId(null);
                closeModal();
              })
            }
          >
            Leave group
          </button>
          <ErrorNote error={error} />
        </div>
      </Modal>
    </div>
  );
}
export type ServerInfo = Omit<Community, 'rooms' | 'categories'> & {
  position: number;
  roles: {
    id: string;
    name: string;
    color: string;
    position: number;
    permissions: string;
    everyone: boolean;
  }[];
  members: {
    id: string;
    user: Person;
    nickname: string | null;
    timeoutUntil: string | null;
    roles: { role: { id: string; name: string; color: string; position: number } }[];
  }[];
  rooms: (ChatRoom & { overrides: OverrideData[] })[];
  categories: { id: string; name: string; position: number; overrides: OverrideData[] }[];
};
export type OverrideData = { targetType: string; targetId: string; allow: string; deny: string };
function InviteForm({
  serverId,
  onError,
}: {
  serverId: string | null;
  onError: (value: string) => void;
}) {
  const [link, setLink] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="modal-body">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = new FormData(e.currentTarget);
          try {
            const result = await api<{ code: string }>(
              serverId ? `servers/${serverId}/invites` : 'admin/invites',
              'POST',
              {
                maxUses: Number(f.get('uses')) || null,
                expiresHours: Number(f.get('hours')) || null,
              },
            );
            setLink(`${window.location.origin}/?invite=${result.code}`);
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-columns">
          <label>
            EXPIRES AFTER
            <select name="hours">
              <option value="168">7 days</option>
              <option value="24">24 hours</option>
              <option value="">Never</option>
            </select>
          </label>
          <label>
            MAXIMUM USES
            <input name="uses" type="number" min={1} defaultValue={10} placeholder="Unlimited" />
          </label>
        </div>
        <button className="primary-button full" disabled={busy}>
          {busy ? 'Creating…' : 'Create invitation'}
        </button>
      </form>
      {link && (
        <div className="invite-result">
          <label>
            INVITATION LINK
            <input value={link} readOnly onFocus={(e) => e.target.select()} />
          </label>
          <button
            className="secondary-button full"
            onClick={() => void navigator.clipboard.writeText(link)}
          >
            Copy invitation link
          </button>
        </div>
      )}
    </div>
  );
}
function NewDm({
  userId: _userId,
  onCreated,
}: {
  userId: string;
  onCreated: (room: ChatRoom) => void;
}) {
  const [q, setQ] = useState(''),
    [selected, setSelected] = useState<Person[]>([]),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const users = useQuery({
    queryKey: ['users', q],
    queryFn: () => api<Person[]>(`users?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  });
  return (
    <div className="modal-body">
      <label>
        FIND BY USERNAME
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type at least two characters"
        />
      </label>
      <div className="selected-people">
        {selected.map((p) => (
          <button key={p.id} onClick={() => setSelected((s) => s.filter((v) => v.id !== p.id))}>
            {p.displayName}
            <X size={12} />
          </button>
        ))}
      </div>
      {users.data?.map((p) => (
        <button
          className="person-result"
          key={p.id}
          onClick={() => {
            if (selected.length < 9 && !selected.some((v) => v.id === p.id))
              setSelected((s) => [...s, p]);
          }}
        >
          <Avatar user={p} size="small" />
          <span>
            <strong>{p.displayName}</strong>
            <small>@{p.username}</small>
          </span>
          {selected.some((v) => v.id === p.id) ? <Check size={17} /> : <Plus size={17} />}
        </button>
      ))}
      {selected.length > 1 && (
        <label>
          GROUP NAME
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="The good company"
          />
        </label>
      )}
      <ErrorNote error={error || users.error?.message} />
      <button
        className="primary-button full"
        disabled={!selected.length || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const room = await api<ChatRoom>('dms', 'POST', {
              userIds: selected.map((p) => p.id),
              ...(name ? { name } : {}),
            });
            onCreated(room);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? 'Starting…'
          : selected.length > 1
            ? 'Create group conversation'
            : 'Start conversation'}
      </button>
    </div>
  );
}
function GroupMemberForm({
  room,
  onChanged,
  onError,
}: {
  room: ChatRoom;
  onChanged: () => void;
  onError: (v: string) => void;
}) {
  const [q, setQ] = useState('');
  const users = useQuery({
    queryKey: ['users', q],
    queryFn: () => api<Person[]>(`users?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  });
  return (
    <>
      <label>
        ADD A MEMBER
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find by username" />
      </label>
      {users.data
        ?.filter((p) => !room.members?.some((m) => m.user.id === p.id))
        .map((p) => (
          <button
            key={p.id}
            className="person-result"
            onClick={async () => {
              try {
                await api(`rooms/${room.id}/members`, 'POST', { userId: p.id });
                setQ('');
                onChanged();
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            <Avatar user={p} size="small" />
            {p.displayName}
            <Plus size={16} />
          </button>
        ))}
    </>
  );
}
function Message({
  message: m,
  previous,
  userId,
  blocked,
  canModerate,
  canReact,
  canSend,
  onReply,
  onProfile,
  onChanged,
  onError,
}: {
  message: ChatMessage;
  previous?: ChatMessage;
  userId: string;
  blocked: boolean;
  canModerate: boolean;
  canReact: boolean;
  canSend: boolean;
  onReply: () => void;
  onProfile: () => void;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [editing, setEditing] = useState(false),
    [content, setContent] = useState(m.content ?? ''),
    [confirm, setConfirm] = useState(''),
    [expanded, setExpanded] = useState(false);
  const date = new Date(m.createdAt),
    prior = previous ? new Date(previous.createdAt) : null;
  const newDay = !prior || date.toDateString() !== prior.toDateString();
  const grouped =
    !newDay &&
    previous?.authorId === m.authorId &&
    date.getTime() - prior!.getTime() < 300000 &&
    !m.reply;
  const reactions = new Map<string, { count: number; own: boolean }>();
  for (const r of m.reactions) {
    const current = reactions.get(r.emoji) ?? { count: 0, own: false };
    reactions.set(r.emoji, { count: current.count + 1, own: current.own || r.userId === userId });
  }
  async function mutate(path: string, method: string, data?: unknown) {
    try {
      await api(path, method, data);
      onChanged();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  }
  return (
    <>
      {newDay && (
        <div className="day-divider">
          <span>
            {date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
          </span>
        </div>
      )}
      <article
        className={`message ${grouped ? 'grouped' : ''} ${m.reply ? 'has-reply' : ''} ${m.deletedAt ? 'deleted' : ''}`}
      >
        {m.reply && (
          <div className="message-reply">
            <Reply size={13} />
            <strong>{m.reply.author.displayName}</strong>
            <span>
              {m.reply.deletedAt
                ? 'Original message deleted'
                : m.reply.content?.slice(0, 120) || 'Attachment'}
            </span>
          </div>
        )}
        {!grouped ? (
          <Avatar user={m.author} onClick={onProfile} />
        ) : (
          <time className="grouped-time">
            {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        )}
        <div className="message-content">
          {!grouped && (
            <div className="message-byline">
              <button onClick={onProfile}>{m.author.displayName}</button>
              <time dateTime={m.createdAt}>
                {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </time>
            </div>
          )}
          {m.deletedAt ? (
            <p className="deleted-label">Message deleted</p>
          ) : blocked && !expanded ? (
            <button className="text-button muted" onClick={() => setExpanded(true)}>
              Message from a blocked user · Show
            </button>
          ) : editing ? (
            <form
              className="edit-message"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await mutate(`messages/${m.id}`, 'PATCH', { content })) setEditing(false);
              }}
            >
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                autoFocus
                required
              />
              <span>
                <button type="button" className="text-button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button className="primary-button">Save</button>
              </span>
            </form>
          ) : (
            <>
              <div className="markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={{
                    img: () => null,
                    a: (props) => (
                      <a href={props.href} target="_blank" rel="noopener noreferrer">
                        {props.children}
                      </a>
                    ),
                    p: (props) => (
                      <p>
                        {Array.isArray(props.children) ? (
                          props.children.map((child, i) =>
                            typeof child === 'string' ? (
                              <MentionText key={i} value={child} />
                            ) : (
                              child
                            ),
                          )
                        ) : typeof props.children === 'string' ? (
                          <MentionText value={props.children} />
                        ) : (
                          props.children
                        )}
                      </p>
                    ),
                  }}
                >
                  {m.content}
                </ReactMarkdown>
                {m.editedAt && <span className="edited-label">(edited)</span>}
              </div>
              {m.attachments.length > 0 && (
                <div className="message-attachments">
                  {m.attachments.map((f) => (
                    <a
                      href={`/api/uploads/${f.id}`}
                      target="_blank"
                      rel="noreferrer"
                      key={f.id}
                      className={
                        f.mime.startsWith('image/') ? 'image-attachment' : 'file-attachment'
                      }
                    >
                      {f.mime.startsWith('image/') ? (
                        <img src={`/api/uploads/${f.id}`} alt={f.name} loading="lazy" />
                      ) : (
                        <>
                          <Paperclip size={22} />
                          <span>
                            <strong>{f.name}</strong>
                            <small>{(f.size / 1024).toFixed(1)} KB</small>
                          </span>
                        </>
                      )}
                    </a>
                  ))}
                </div>
              )}
              <div className="reaction-row">
                {[...reactions].map(([emoji, r]) => (
                  <button
                    key={emoji}
                    disabled={!canReact}
                    className={r.own ? 'own' : ''}
                    aria-label={`React ${emoji}, ${r.count} reactions`}
                    onClick={() => void mutate(`messages/${m.id}/reactions`, 'POST', { emoji })}
                  >
                    {emoji}
                    <span>{r.count}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {!m.deletedAt && (
          <div className="message-actions">
            {canReact && (
              <Menu label="Add reaction" trigger={<Smile size={16} />}>
                {['👍', '❤️', '😂', '🎉', '🔥', '👀', '✨', '💜'].map((emoji) => (
                  <MenuItem
                    key={emoji}
                    onClick={() => void mutate(`messages/${m.id}/reactions`, 'POST', { emoji })}
                  >
                    {emoji}
                  </MenuItem>
                ))}
              </Menu>
            )}
            {canSend && (
              <button className="icon-button" aria-label="Reply to message" onClick={onReply}>
                <Reply size={16} />
              </button>
            )}
            <Menu label="Message actions" trigger={<MoreHorizontal size={16} />}>
              {m.authorId === userId && canSend && (
                <MenuItem
                  onClick={() => {
                    setContent(m.content ?? '');
                    setEditing(true);
                  }}
                >
                  <Pencil size={15} /> Edit message
                </MenuItem>
              )}
              <MenuItem onClick={() => setConfirm('report')}>
                <Flag size={15} /> Report message
              </MenuItem>
              {(m.authorId === userId || canModerate) && (
                <MenuItem onClick={() => setConfirm('delete')} danger>
                  <Trash2 size={15} /> Delete message
                </MenuItem>
              )}
            </Menu>
          </div>
        )}
      </article>
      <Modal
        title={confirm === 'delete' ? 'Delete this message?' : 'Report message'}
        open={!!confirm}
        onClose={() => setConfirm('')}
      >
        <div className="modal-body">
          {confirm === 'delete' ? (
            <>
              <p>The message content and its attachments will be removed. This cannot be undone.</p>
              <button
                className="danger-button full"
                onClick={async () => {
                  if (await mutate(`messages/${m.id}`, 'DELETE')) setConfirm('');
                }}
              >
                Delete message
              </button>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                if (await mutate('reports', 'POST', { messageId: m.id, reason: f.get('reason') }))
                  setConfirm('');
              }}
            >
              <label>
                WHAT HAPPENED?
                <textarea
                  name="reason"
                  required
                  maxLength={1000}
                  placeholder="Tell the moderators what they should know."
                />
              </label>
              <button className="primary-button full">Submit report</button>
            </form>
          )}
        </div>
      </Modal>
    </>
  );
}
function MentionText({ value }: { value: string }) {
  return (
    <>
      {value.split(/(@[a-zA-Z0-9_]+)/g).map((p, i) =>
        p.startsWith('@') ? (
          <span key={i} className="mention">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}
