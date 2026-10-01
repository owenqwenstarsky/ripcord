'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  Shield,
  Users,
  Hash,
  Settings,
  ScrollText,
  Flag,
  UserPlus,
  LockKeyhole,
  HardDrive,
} from 'lucide-react';
import type { Workspace, Person } from '@/lib/types';
import { P, has } from '@/lib/permissions';
import { api, Avatar, ErrorNote, Modal } from './ui';
import type { ServerInfo, OverrideData } from './ripcord';
type Role = ServerInfo['roles'][number];
const labels: Record<string, string> = {
  VIEW_CHANNEL: 'View channel',
  READ_HISTORY: 'Read message history',
  SEND_MESSAGES: 'Send messages',
  ATTACH_FILES: 'Attach files',
  ADD_REACTIONS: 'Add reactions',
  MENTION_EVERYONE: 'Mention everyone / here',
  CREATE_INVITES: 'Create invitations',
  CHANGE_NICKNAME: 'Change own nickname',
  MANAGE_NICKNAMES: 'Manage nicknames',
  MANAGE_CHANNELS: 'Manage channels and categories',
  MANAGE_SERVER: 'Manage server',
  MANAGE_ROLES: 'Manage roles and overrides',
  MANAGE_MESSAGES: 'Moderate messages and reports',
  KICK_MEMBERS: 'Kick members',
  BAN_MEMBERS: 'Ban members',
  MODERATE_MEMBERS: 'Timeout members',
  VIEW_AUDIT_LOG: 'View audit log',
  ADMINISTRATOR: 'Administrator (bypass channel overrides)',
};
type SettingsAction = (
  path: string,
  method: string,
  data?: unknown,
  message?: string,
) => Promise<boolean>;
export function SettingsPanel({
  mode,
  workspace,
  serverId,
  onNotice,
  onClose,
}: {
  mode: 'account' | 'server' | 'admin';
  workspace: Workspace;
  serverId: string | null;
  onNotice: (v: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient(),
    [tab, setTab] = useState('overview'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const detail = useQuery({
    queryKey: ['server', serverId],
    queryFn: () => api<ServerInfo>(`servers/${serverId}`),
    enabled: mode === 'server' && !!serverId,
  });
  const allTabs =
    mode === 'account'
      ? [
          ['overview', 'Profile', Users],
          ['security', 'Security', LockKeyhole],
        ]
      : mode === 'admin'
        ? [
            ['overview', 'Instance', Settings],
            ['users', 'Accounts', Users],
            ['invites', 'Invitations', UserPlus],
            ['reports', 'DM reports', Flag],
            ['audit', 'Audit log', ScrollText],
            ['storage', 'Storage', HardDrive],
          ]
        : [
            ['overview', 'Overview', Settings],
            ['channels', 'Channels', Hash],
            ['roles', 'Roles', Shield],
            ['permissions', 'Overrides', LockKeyhole],
            ['members', 'Members', Users],
            ['invites', 'Invitations', UserPlus],
            ['bans', 'Bans', Shield],
            ['reports', 'Reports', Flag],
            ['audit', 'Audit log', ScrollText],
          ];
  const tabPermissions: Record<string, bigint> = {
    overview: P.MANAGE_SERVER,
    channels: P.MANAGE_CHANNELS,
    roles: P.MANAGE_ROLES,
    permissions: P.MANAGE_ROLES,
    members:
      P.MANAGE_ROLES | P.MANAGE_NICKNAMES | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MODERATE_MEMBERS,
    invites: P.MANAGE_SERVER,
    bans: P.BAN_MEMBERS,
    reports: P.MANAGE_MESSAGES,
    audit: P.VIEW_AUDIT_LOG,
  };
  const bits = BigInt(detail.data?.permissions ?? 0);
  const tabs =
    mode === 'server'
      ? allTabs.filter(([key]) => (bits & tabPermissions[String(key)]) !== 0n)
      : allTabs;
  const activeTab = tabs.some(([id]) => id === tab) ? tab : String(tabs[0]?.[0] ?? 'overview');
  const act: SettingsAction = async (path, method, data, message = 'Changes saved.') => {
    setError('');
    setBusy(true);
    try {
      await api(path, method, data);
      await qc.invalidateQueries();
      onNotice(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {tabs.map(([id, label, Icon]) => {
          const Component = Icon as typeof Settings;
          return (
            <button
              className={activeTab === id ? 'active' : ''}
              key={String(id)}
              onClick={() => {
                setTab(String(id));
                setError('');
              }}
            >
              <Component size={16} />
              {String(label)}
            </button>
          );
        })}
      </nav>
      <div className="settings-content" aria-busy={busy}>
        <ErrorNote error={error} />
        {mode === 'account' ? (
          <AccountSettings tab={tab} workspace={workspace} act={act} />
        ) : mode === 'admin' ? (
          <AdminSettings tab={tab} act={act} />
        ) : detail.data ? (
          <ServerSettings
            tab={activeTab}
            server={detail.data}
            user={workspace.user}
            act={act}
            onClose={onClose}
          />
        ) : (
          <p className="muted">{detail.error?.message ?? 'Loading server settings…'}</p>
        )}
      </div>
    </div>
  );
}
function AccountSettings({
  tab,
  workspace,
  act,
}: {
  tab: string;
  workspace: Workspace;
  act: SettingsAction;
}) {
  const [codes, setCodes] = useState<string[]>([]),
    [error, setError] = useState('');
  const user = workspace.user;
  if (tab === 'overview')
    return (
      <>
        <h2>Your profile</h2>
        <p className="muted">A familiar face in every conversation.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act('me', 'PATCH', {
              displayName: f.get('displayName'),
              friendsOnly: f.get('friendsOnly') === 'on',
            });
          }}
        >
          <div className="profile-settings">
            <Avatar user={user} size="large" />
            <label className="upload-label">
              Change avatar
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const form = new FormData();
                    form.set('file', file);
                    const upload = await api<{ id: string }>('uploads', 'POST', form);
                    await act('me', 'PATCH', { avatarId: upload.id });
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              />
            </label>
            {user.avatarId && (
              <button
                type="button"
                className="text-button"
                onClick={() => void act('me', 'PATCH', { avatarId: null })}
              >
                Remove
              </button>
            )}
          </div>
          <label>
            USERNAME
            <input value={user.username} disabled />
          </label>
          <label>
            DISPLAY NAME
            <input name="displayName" defaultValue={user.displayName} required maxLength={80} />
          </label>
          <label className="checkbox-line">
            <input type="checkbox" name="friendsOnly" defaultChecked={user.friendsOnly} />
            <span>
              Only allow direct messages from friends
              <small>Otherwise, people who share a server can also message you.</small>
            </span>
          </label>
          <ErrorNote error={error} />
          <button className="primary-button">Save profile</button>
        </form>
      </>
    );
  return (
    <>
      <h2>Account security</h2>
      <p className="muted">Manage your password, recovery codes, and sessions.</p>
      <h3>Change password</h3>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (
            await act(
              'me/password',
              'POST',
              { currentPassword: f.get('current'), password: f.get('password') },
              'Password changed. Please sign in again.',
            )
          )
            window.location.reload();
        }}
      >
        <label>
          CURRENT PASSWORD
          <input name="current" type="password" autoComplete="current-password" required />
        </label>
        <label>
          NEW PASSWORD
          <input
            name="password"
            type="password"
            minLength={10}
            maxLength={128}
            autoComplete="new-password"
            required
          />
        </label>
        <button className="primary-button">Change password</button>
      </form>
      <div className="settings-divider" />
      <h3>Recovery codes</h3>
      <p className="muted">Generating new codes invalidates all previous codes.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            const result = await api<{ codes: string[] }>('me/recovery', 'POST', {
              password: f.get('password'),
            });
            setCodes(result.codes);
            setError('');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          CONFIRM YOUR PASSWORD
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button className="secondary-button">Generate new recovery codes</button>
      </form>
      {codes.length > 0 && (
        <>
          <div className="recovery-grid">
            {codes.map((code) => (
              <code key={code}>{code}</code>
            ))}
          </div>
          <button
            className="text-button"
            onClick={() => {
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([codes.join('\n')], { type: 'text/plain' }));
              a.download = 'ripcord-recovery-codes.txt';
              a.click();
              URL.revokeObjectURL(a.href);
            }}
          >
            Download codes
          </button>
        </>
      )}
      <ErrorNote error={error} />
      <div className="settings-divider" />
      <h3>Email recovery</h3>
      <p className="muted">
        Optional. Your host must configure SMTP.{' '}
        {user.emailVerified ? `Verified: ${user.email}` : 'No verified recovery email.'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void act(
            'me/email',
            'POST',
            { email: f.get('email'), password: f.get('password') },
            'Verification email sent.',
          );
        }}
      >
        <label>
          EMAIL ADDRESS
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            defaultValue={user.email ?? ''}
          />
        </label>
        <label>
          CONFIRM YOUR PASSWORD
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        <button className="secondary-button">Send verification email</button>
      </form>
      <div className="settings-divider" />
      <h3>Sessions</h3>
      <p className="muted">Sign out every device, including this browser.</p>
      <button
        className="danger-button"
        onClick={async () => {
          if (await act('me/sessions', 'DELETE', undefined, 'All sessions revoked.'))
            window.location.reload();
        }}
      >
        Sign out everywhere
      </button>
    </>
  );
}
function ServerSettings({
  tab,
  server,
  user,
  act,
  onClose,
}: {
  tab: string;
  server: ServerInfo;
  user: Person;
  act: SettingsAction;
  onClose: () => void;
}) {
  const base = `servers/${server.id}`,
    [confirmDelete, setConfirmDelete] = useState(false);
  if (tab === 'overview')
    return (
      <>
        <h2>Server overview</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(base, 'PATCH', {
              name: f.get('name'),
              description: f.get('description'),
              icon: f.get('icon'),
            });
          }}
        >
          <label>
            SERVER NAME
            <input name="name" defaultValue={server.name} required maxLength={80} />
          </label>
          <label>
            DESCRIPTION
            <textarea name="description" defaultValue={server.description} maxLength={500} />
          </label>
          <label>
            SERVER INITIALS OR EMOJI
            <input name="icon" defaultValue={server.icon} maxLength={4} placeholder="RC" />
          </label>
          <button className="primary-button">Save server</button>
        </form>
        {server.ownerId === user.id && (
          <>
            <div className="settings-divider" />
            <h3>Transfer ownership</h3>
            <p className="muted">The new owner receives full control. You’ll remain a member.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void act(base, 'PATCH', { ownerId: f.get('ownerId') });
              }}
            >
              <label>
                NEW OWNER
                <select name="ownerId" required>
                  <option value="">Choose a member</option>
                  {server.members
                    .filter((m) => m.user.id !== user.id)
                    .map((m) => (
                      <option key={m.id} value={m.user.id}>
                        {m.user.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <button className="secondary-button">Transfer ownership</button>
            </form>
            <div className="settings-divider" />
            <h3 className="danger-text">Delete server</h3>
            <p className="muted">Permanently remove this server, its channels, and its messages.</p>
            <button className="danger-button" onClick={() => setConfirmDelete(true)}>
              Delete server
            </button>
            <Modal
              title="Permanently delete server?"
              open={confirmDelete}
              onClose={() => setConfirmDelete(false)}
            >
              <div className="modal-body">
                <p>
                  Type <strong>{server.name}</strong> to confirm.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    if (
                      f.get('name') === server.name &&
                      (await act(base, 'DELETE', undefined, 'Server deleted.'))
                    ) {
                      setConfirmDelete(false);
                      onClose();
                    }
                  }}
                >
                  <label>
                    SERVER NAME
                    <input
                      name="name"
                      required
                      pattern={server.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}
                    />
                  </label>
                  <button className="danger-button full">Delete permanently</button>
                </form>
              </div>
            </Modal>
          </>
        )}
      </>
    );
  if (tab === 'channels') return <ChannelSettings server={server} act={act} />;
  if (tab === 'roles') return <RoleSettings server={server} act={act} />;
  if (tab === 'permissions') return <OverrideSettings server={server} act={act} />;
  if (tab === 'members') return <MemberSettings server={server} user={user} act={act} />;
  if (tab === 'invites') return <Invites base={base} act={act} />;
  if (tab === 'audit') return <Audit path={`${base}/audit`} />;
  if (tab === 'reports') return <Reports serverId={server.id} act={act} />;
  return <Bans serverId={server.id} act={act} />;
}
function ChannelSettings({ server, act }: { server: ServerInfo; act: SettingsAction }) {
  const [tab, setTab] = useState('channels'),
    [confirm, setConfirm] = useState<{ kind: string; id: string; name: string } | null>(null);
  const base = `servers/${server.id}`;
  return (
    <>
      <h2>Channels & categories</h2>
      <div className="settings-subtabs">
        <button className={tab === 'channels' ? 'active' : ''} onClick={() => setTab('channels')}>
          Channels
        </button>
        <button
          className={tab === 'categories' ? 'active' : ''}
          onClick={() => setTab('categories')}
        >
          Categories
        </button>
      </div>
      {tab === 'categories' ? (
        <>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget,
                f = new FormData(form);
              if (
                await act(`${base}/categories`, 'POST', {
                  name: f.get('name'),
                  position: server.categories.length,
                })
              )
                form.reset();
            }}
          >
            <input
              name="name"
              required
              aria-label="New category name"
              placeholder="New category name"
            />
            <button className="primary-button">
              <Plus size={16} /> Add
            </button>
          </form>
          {server.categories.map((c) => (
            <form
              className="management-form"
              key={c.id}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void act(`${base}/categories/${c.id}`, 'PATCH', {
                  name: f.get('name'),
                  position: Number(f.get('position')),
                });
              }}
            >
              <label>
                CATEGORY
                <input name="name" defaultValue={c.name} required />
              </label>
              <label>
                ORDER
                <input type="number" name="position" min={0} defaultValue={c.position} />
              </label>
              <div className="row-actions">
                <button className="secondary-button">Save</button>
                <button
                  type="button"
                  className="icon-button danger-text"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => setConfirm({ kind: 'categories', id: c.id, name: c.name })}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </form>
          ))}
        </>
      ) : (
        <>
          {server.rooms.map((r) => (
            <form
              className="channel-management"
              key={`${r.id}:${r.synchronized}`}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void act(`${base}/channels/${r.id}`, 'PATCH', {
                  name: f.get('name'),
                  topic: f.get('topic'),
                  categoryId: f.get('categoryId') || null,
                  position: Number(f.get('position')),
                  slowMode: Number(f.get('slowMode')),
                  synchronized: f.get('synchronized') === 'on',
                });
              }}
            >
              <div className="channel-management-heading">
                <Hash size={19} />
                <strong>{r.name}</strong>
                <button
                  type="button"
                  className="icon-button danger-text"
                  aria-label={`Delete ${r.name}`}
                  onClick={() => setConfirm({ kind: 'channels', id: r.id, name: r.name })}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="form-columns">
                <label>
                  NAME
                  <input name="name" defaultValue={r.name} required pattern="[a-zA-Z0-9_-]+" />
                </label>
                <label>
                  CATEGORY
                  <select name="categoryId" defaultValue={r.categoryId ?? ''}>
                    <option value="">Uncategorized</option>
                    {server.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                TOPIC
                <input name="topic" defaultValue={r.topic} maxLength={500} />
              </label>
              <div className="form-columns">
                <label>
                  ORDER
                  <input type="number" name="position" min={0} defaultValue={r.position ?? 0} />
                </label>
                <label>
                  SLOW MODE (SECONDS)
                  <input
                    type="number"
                    name="slowMode"
                    min={0}
                    max={21600}
                    defaultValue={r.slowMode}
                  />
                </label>
              </div>
              <label className="checkbox-line">
                <input type="checkbox" name="synchronized" defaultChecked={r.synchronized} />
                <span>
                  Synchronize category permissions
                  <small>Enabling this removes independent channel overrides.</small>
                </span>
              </label>
              <button className="secondary-button">Save channel</button>
            </form>
          ))}
        </>
      )}
      <Modal title={`Delete ${confirm?.name}?`} open={!!confirm} onClose={() => setConfirm(null)}>
        <div className="modal-body">
          <p>
            {confirm?.kind === 'channels'
              ? 'This permanently removes the channel and its messages.'
              : 'Channels remain, and their current category permissions are preserved.'}
          </p>
          <button
            className="danger-button full"
            onClick={async () => {
              if (confirm && (await act(`${base}/${confirm.kind}/${confirm.id}`, 'DELETE')))
                setConfirm(null);
            }}
          >
            Delete
          </button>
        </div>
      </Modal>
    </>
  );
}
function RoleSettings({ server, act }: { server: ServerInfo; act: SettingsAction }) {
  const [selected, setSelected] = useState(server.roles[0]?.id ?? 'new'),
    [confirm, setConfirm] = useState(false);
  const role = server.roles.find((r) => r.id === selected);
  return (
    <>
      <h2>Roles & permissions</h2>
      <p className="muted">
        Higher roles can manage lower roles. Members combine permissions from all their roles.
      </p>
      <div className="role-picker">
        {[...server.roles]
          .sort((a, b) => b.position - a.position)
          .map((r) => (
            <button
              key={r.id}
              className={selected === r.id ? 'active' : ''}
              onClick={() => setSelected(r.id)}
            >
              <i style={{ background: r.color }} />
              {r.name}
              <small>{r.position}</small>
            </button>
          ))}
        <button onClick={() => setSelected('new')}>
          <Plus size={14} /> New role
        </button>
      </div>
      <RoleForm
        key={`${selected}:${role?.permissions}`}
        role={role}
        onSave={async (data) => {
          if (
            await act(
              `servers/${server.id}/roles${role ? '/' + role.id : ''}`,
              role ? 'PATCH' : 'POST',
              data,
            )
          )
            if (!role) setSelected(server.roles[0]?.id ?? 'new');
        }}
      />
      {role && !role.everyone && (
        <>
          <button className="text-button danger-text" onClick={() => setConfirm(true)}>
            Delete role
          </button>
          <Modal title={`Delete ${role.name}?`} open={confirm} onClose={() => setConfirm(false)}>
            <div className="modal-body">
              <p>This removes the role from members and permission overrides.</p>
              <button
                className="danger-button full"
                onClick={async () => {
                  if (await act(`servers/${server.id}/roles/${role.id}`, 'DELETE')) {
                    setConfirm(false);
                    setSelected(server.roles[0].id);
                  }
                }}
              >
                Delete role
              </button>
            </div>
          </Modal>
        </>
      )}
    </>
  );
}
function RoleForm({ role, onSave }: { role?: Role; onSave: (data: unknown) => void }) {
  const [bits, setBits] = useState(BigInt(role?.permissions ?? '0'));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSave({
          name: f.get('name'),
          color: f.get('color'),
          permissions: bits.toString(),
          ...(!role?.everyone ? { position: Number(f.get('position')) } : {}),
        });
      }}
    >
      <div className="form-columns">
        <label>
          ROLE NAME
          <input
            name="name"
            defaultValue={role?.name ?? ''}
            readOnly={role?.everyone}
            required
            maxLength={80}
          />
        </label>
        <label>
          COLOR
          <input name="color" type="color" defaultValue={role?.color ?? '#8580ff'} />
        </label>
      </div>
      {!role?.everyone && (
        <label>
          HIERARCHY POSITION
          <input
            name="position"
            type="number"
            min={1}
            max={10000}
            defaultValue={role?.position ?? 1}
          />
        </label>
      )}
      <div className="permission-list">
        {Object.entries(P).map(([key, bit]) => (
          <label className="checkbox-line" key={key}>
            <input
              type="checkbox"
              checked={has(bits, bit)}
              onChange={(e) => setBits((v) => (e.target.checked ? v | bit : v & ~bit))}
            />
            <span>{labels[key]}</span>
          </label>
        ))}
      </div>
      <button className="primary-button">{role ? 'Save role' : 'Create role'}</button>
    </form>
  );
}
function OverrideSettings({ server, act }: { server: ServerInfo; act: SettingsAction }) {
  const [scope, setScope] = useState('room'),
    [scopeId, setScopeId] = useState(server.rooms[0]?.id ?? ''),
    [target, setTarget] = useState(`ROLE:${server.roles.find((r) => r.everyone)?.id ?? ''}`);
  const options = scope === 'room' ? server.rooms : server.categories;
  const selected = options.find((o) => o.id === scopeId);
  const [targetType, targetId] = target.split(':');
  const room = scope === 'room' ? server.rooms.find((r) => r.id === scopeId) : undefined;
  const effective =
    room?.synchronized && room.categoryId
      ? (server.categories.find((c) => c.id === room.categoryId)?.overrides ?? [])
      : (selected?.overrides ?? []);
  const existing = effective.find((o) => o.targetType === targetType && o.targetId === targetId);
  return (
    <>
      <h2>Permission overrides</h2>
      <p className="muted">
        Set permissions for a role or member in a channel or category. Editing a synchronized
        channel makes it independent.
      </p>
      <div className="form-columns">
        <label>
          LOCATION TYPE
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setScopeId(
                e.target.value === 'room'
                  ? (server.rooms[0]?.id ?? '')
                  : (server.categories[0]?.id ?? ''),
              );
            }}
          >
            <option value="room">Channel</option>
            <option value="category">Category</option>
          </select>
        </label>
        <label>
          LOCATION
          <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        ROLE OR MEMBER
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <optgroup label="Roles">
            {server.roles.map((r) => (
              <option key={r.id} value={`ROLE:${r.id}`}>
                {r.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Members">
            {server.members.map((m) => (
              <option key={m.id} value={`MEMBER:${m.user.id}`}>
                {m.user.displayName}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {room?.synchronized && (
        <p className="success-note">Currently synchronized with category permissions.</p>
      )}
      {scopeId && (
        <OverrideForm
          key={`${scope}:${scopeId}:${target}:${existing?.allow}:${existing?.deny}`}
          existing={existing}
          onSave={(allow, deny) =>
            void act(`servers/${server.id}/overrides`, 'PUT', {
              scope,
              id: scopeId,
              targetType,
              targetId,
              allow,
              deny,
            })
          }
          onReset={() =>
            void act(`servers/${server.id}/overrides`, 'DELETE', {
              scope,
              id: scopeId,
              targetType,
              targetId,
              allow: '0',
              deny: '0',
            })
          }
        />
      )}
    </>
  );
}
function OverrideForm({
  existing,
  onSave,
  onReset,
}: {
  existing?: OverrideData;
  onSave: (allow: string, deny: string) => void;
  onReset: () => void;
}) {
  const [allow, setAllow] = useState(BigInt(existing?.allow ?? 0)),
    [deny, setDeny] = useState(BigInt(existing?.deny ?? 0));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(allow.toString(), deny.toString());
      }}
    >
      <div className="override-list">
        {Object.entries(P)
          .filter(([key]) => key !== 'ADMINISTRATOR')
          .map(([key, bit]) => (
            <label key={key}>
              <span>{labels[key]}</span>
              <select
                value={has(allow, bit) ? 'allow' : has(deny, bit) ? 'deny' : 'inherit'}
                onChange={(e) => {
                  setAllow((v) => (e.target.value === 'allow' ? v | bit : v & ~bit));
                  setDeny((v) => (e.target.value === 'deny' ? v | bit : v & ~bit));
                }}
              >
                <option value="inherit">Inherit</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </label>
          ))}
      </div>
      <div className="row-actions">
        <button className="primary-button">Save overrides</button>
        <button type="button" className="secondary-button" onClick={onReset}>
          Reset to inherited
        </button>
      </div>
    </form>
  );
}
function MemberSettings({
  server,
  user,
  act,
}: {
  server: ServerInfo;
  user: Person;
  act: SettingsAction;
}) {
  const [selected, setSelected] = useState('');
  const member = server.members.find((m) => m.user.id === selected);
  return (
    <>
      <h2>Members</h2>
      <p className="muted">Roles and moderation actions follow the server hierarchy.</p>
      {server.members.map((m) => (
        <button
          className="person-result"
          key={m.id}
          onClick={() => setSelected((v) => (v === m.user.id ? '' : m.user.id))}
        >
          <Avatar user={m.user} size="small" />
          <span>
            <strong>{m.nickname || m.user.displayName}</strong>
            <small>
              @{m.user.username}
              {m.user.id === server.ownerId && ' · Owner'}
            </small>
          </span>
          <span>{m.roles.map((r) => r.role.name).join(', ') || 'Member'}</span>
        </button>
      ))}
      {member && (
        <div className="member-management" key={member.id}>
          <h3>{member.user.displayName}</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(`servers/${server.id}/members/${member.user.id}/roles`, 'PUT', {
                roleIds: f.getAll('roles'),
              });
            }}
          >
            <div className="permission-list">
              {server.roles
                .filter((r) => !r.everyone)
                .map((r) => (
                  <label className="checkbox-line" key={r.id}>
                    <input
                      type="checkbox"
                      name="roles"
                      value={r.id}
                      defaultChecked={member.roles.some((m) => m.role.id === r.id)}
                    />
                    <span style={{ color: r.color }}>{r.name}</span>
                  </label>
                ))}
            </div>
            <button className="primary-button">Save member roles</button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(`servers/${server.id}/members/${member.user.id}`, 'POST', {
                action: 'nickname',
                nickname: f.get('nickname') || null,
              });
            }}
          >
            <label>
              SERVER NICKNAME
              <input name="nickname" defaultValue={member.nickname ?? ''} maxLength={32} />
            </label>
            <button className="secondary-button">Save nickname</button>
          </form>
          {member.user.id !== user.id && member.user.id !== server.ownerId && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void act(`servers/${server.id}/members/${member.user.id}`, 'POST', {
                  action: f.get('action'),
                  seconds: Number(f.get('seconds')),
                  reason: f.get('reason'),
                });
              }}
            >
              <h3>Moderation</h3>
              {member.timeoutUntil && (
                <p className="muted">
                  Timeout until {new Date(member.timeoutUntil).toLocaleString()}
                </p>
              )}
              <div className="form-columns">
                <label>
                  ACTION
                  <select name="action">
                    <option value="timeout">Timeout / remove timeout</option>
                    <option value="kick">Kick</option>
                    <option value="ban">Ban</option>
                  </select>
                </label>
                <label>
                  TIMEOUT DURATION
                  <select name="seconds">
                    <option value="300">5 minutes</option>
                    <option value="3600">1 hour</option>
                    <option value="86400">1 day</option>
                    <option value="0">Remove timeout</option>
                  </select>
                </label>
              </div>
              <label>
                REASON
                <input name="reason" maxLength={500} placeholder="Recorded in the audit log" />
              </label>
              <button className="danger-button">Apply moderation action</button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
function Invites({ base, act }: { base: string; act: SettingsAction }) {
  const invites = useQuery({
    queryKey: ['invites', base],
    queryFn: () =>
      api<
        {
          code: string;
          uses: number;
          maxUses: number | null;
          expiresAt: string | null;
          revoked: boolean;
        }[]
      >(`${base}/invites`),
  });
  return (
    <>
      <h2>Invitations</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void act(
            `${base}/invites`,
            'POST',
            {
              expiresHours: Number(f.get('hours')) || null,
              maxUses: Number(f.get('uses')) || null,
            },
            'Invitation created. Copy it from the list below.',
          );
        }}
      >
        <div className="form-columns">
          <label>
            EXPIRATION (HOURS)
            <input
              name="hours"
              type="number"
              min={1}
              max={8760}
              defaultValue={168}
              placeholder="Never"
            />
          </label>
          <label>
            MAXIMUM USES
            <input name="uses" type="number" min={1} defaultValue={10} placeholder="Unlimited" />
          </label>
        </div>
        <button className="primary-button">
          <Plus size={16} /> Create invitation
        </button>
      </form>
      <ErrorNote error={invites.error?.message} />
      {invites.data?.map((i) => (
        <div className="invite-management" key={i.code}>
          <code>{i.code}</code>
          <small>
            {i.uses}/{i.maxUses ?? '∞'} uses ·{' '}
            {i.revoked
              ? 'Revoked'
              : i.expiresAt
                ? new Date(i.expiresAt).toLocaleString()
                : 'Never expires'}
          </small>
          <div className="row-actions">
            <button
              className="text-button"
              onClick={() =>
                void navigator.clipboard.writeText(`${location.origin}/?invite=${i.code}`)
              }
            >
              Copy link
            </button>
            {!i.revoked && (
              <button
                className="text-button danger-text"
                onClick={() => void act(`${base}/invites/${i.code}`, 'DELETE')}
              >
                Revoke
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
function Audit({ path }: { path: string }) {
  const query = useQuery({
    queryKey: ['audit', path],
    queryFn: () =>
      api<
        {
          id: string;
          action: string;
          actorId: string;
          targetId: string | null;
          createdAt: string;
          detail: Record<string, unknown>;
        }[]
      >(path),
  });
  return (
    <>
      <h2>Audit log</h2>
      <p className="muted">Administrative actions. Message contents are never recorded here.</p>
      <ErrorNote error={query.error?.message} />
      {query.data?.map((a) => (
        <div className="audit-row" key={a.id}>
          <Shield size={17} />
          <span>
            <strong>{a.action.replaceAll('.', ' → ')}</strong>
            <small>
              {new Date(a.createdAt).toLocaleString()} · Actor {a.actorId}
            </small>
            {a.targetId && <small>Target {a.targetId}</small>}
            {typeof a.detail.reason === 'string' && a.detail.reason && <p>{a.detail.reason}</p>}
          </span>
        </div>
      ))}
      {query.data?.length === 0 && <p className="muted">No actions recorded.</p>}
    </>
  );
}
function Reports({ serverId, act }: { serverId?: string; act: SettingsAction }) {
  const suffix = serverId ? `?serverId=${serverId}` : '';
  const query = useQuery({
    queryKey: ['reports', serverId],
    queryFn: () =>
      api<
        {
          id: string;
          reason: string;
          resolvedAt: string | null;
          message: { content: string | null; author: Person; deletedAt: string | null } | null;
          createdAt: string;
        }[]
      >(`reports${suffix}`),
  });
  return (
    <>
      <h2>{serverId ? 'Community reports' : 'Reported direct messages'}</h2>
      <p className="muted">Only reported messages appear here. Deleted messages are unavailable.</p>
      <ErrorNote error={query.error?.message} />
      {query.data?.map((r) => (
        <div className="report-row" key={r.id}>
          <span className={`report-state ${r.resolvedAt ? 'resolved' : ''}`}>
            {r.resolvedAt ? 'Resolved' : 'Open'}
          </span>
          <small>{new Date(r.createdAt).toLocaleString()}</small>
          <p>
            <strong>Reason:</strong> {r.reason}
          </p>
          {r.message && !r.message.deletedAt ? (
            <blockquote>
              <strong>{r.message.author.displayName}</strong>
              <p>{r.message.content || 'Attachment-only message'}</p>
            </blockquote>
          ) : (
            <p className="muted">Message deleted or unavailable.</p>
          )}
          {!r.resolvedAt && (
            <button
              className="secondary-button"
              onClick={() => void act(`reports/${r.id}${suffix}`, 'PATCH', {})}
            >
              Mark resolved
            </button>
          )}
        </div>
      ))}
      {query.data?.length === 0 && <p className="muted">No reports.</p>}
    </>
  );
}
function Bans({ serverId, act }: { serverId: string; act: SettingsAction }) {
  const q = useQuery({
    queryKey: ['bans', serverId],
    queryFn: () => api<{ userId: string; reason: string }[]>(`servers/${serverId}/bans`),
  });
  return (
    <>
      <h2>Server bans</h2>
      <ErrorNote error={q.error?.message} />
      {q.data?.map((b) => (
        <div className="management-row" key={b.userId}>
          <span>
            <strong>{b.userId}</strong>
            <small>{b.reason || 'No reason provided'}</small>
          </span>
          <button
            className="secondary-button"
            onClick={() => void act(`servers/${serverId}/bans/${b.userId}`, 'DELETE')}
          >
            Revoke ban
          </button>
        </div>
      ))}
      {q.data?.length === 0 && <p className="muted">No banned members.</p>}
    </>
  );
}
type InstanceSettings = {
  name: string;
  publicRegistration: boolean;
  maxFileBytes: number;
  maxAttachments: number;
  maxMessageLength: number;
  maxStorageBytes: string;
};
function AdminSettings({ tab, act }: { tab: string; act: SettingsAction }) {
  const q = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<InstanceSettings>('admin/settings'),
  });
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<(Person & { suspended: boolean; isAdmin: boolean })[]>('admin/users'),
    enabled: tab === 'users',
  });
  const storage = useQuery({
    queryKey: ['storage'],
    queryFn: () =>
      api<{ _sum: { size: number | null }; _count: number; quota: string }>('admin/storage'),
    enabled: tab === 'storage',
  });
  if (tab === 'invites') return <Invites base="admin" act={act} />;
  if (tab === 'audit') return <Audit path="admin/audit" />;
  if (tab === 'reports') return <Reports act={act} />;
  if (tab === 'storage')
    return (
      <>
        <h2>Instance storage</h2>
        <p className="muted">
          Persistent local uploads. Unreferenced uploads are collected after 24 hours.
        </p>
        <ErrorNote error={storage.error?.message} />
        {storage.data && (
          <div className="storage-meter">
            <strong>{((storage.data._sum.size ?? 0) / 1048576).toFixed(1)} MB</strong>
            <span>
              of {(Number(storage.data.quota) / 1073741824).toFixed(1)} GB · {storage.data._count}{' '}
              files
            </span>
            <progress value={storage.data._sum.size ?? 0} max={Number(storage.data.quota)} />
          </div>
        )}
      </>
    );
  if (tab === 'users')
    return (
      <>
        <h2>Instance accounts</h2>
        <p className="muted">
          Suspension revokes all sessions. Administrators are managed through the host CLI.
        </p>
        <ErrorNote error={users.error?.message} />
        {users.data?.map((u) => (
          <div className="management-row" key={u.id}>
            <Avatar user={u} size="small" />
            <span>
              <strong>{u.displayName}</strong>
              <small>
                @{u.username}
                {u.isAdmin ? ' · Administrator' : u.suspended ? ' · Suspended' : ''}
              </small>
            </span>
            {!u.isAdmin && (
              <button
                className={u.suspended ? 'secondary-button' : 'danger-button'}
                onClick={() =>
                  void act(`admin/users/${u.id}`, 'PATCH', { suspended: !u.suspended })
                }
              >
                {u.suspended ? 'Restore' : 'Suspend'}
              </button>
            )}
          </div>
        ))}
      </>
    );
  if (!q.data) return <p className="muted">{q.error?.message ?? 'Loading settings…'}</p>;
  const settings = q.data;
  return (
    <>
      <h2>Instance settings</h2>
      <p className="muted">
        One instance. Your rules. Communities keep their own roles and permissions.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void act('admin/settings', 'PATCH', {
            name: f.get('name'),
            publicRegistration: f.get('publicRegistration') === 'on',
            maxFileBytes: Math.round(Number(f.get('maxFileMB')) * 1048576),
            maxAttachments: Number(f.get('maxAttachments')),
            maxMessageLength: Number(f.get('maxMessageLength')),
            maxStorageBytes: Math.round(Number(f.get('storageGB')) * 1073741824).toString(),
          });
        }}
      >
        <label>
          INSTANCE NAME
          <input name="name" defaultValue={settings.name} required />
        </label>
        <label className="checkbox-line">
          <input
            type="checkbox"
            name="publicRegistration"
            defaultChecked={settings.publicRegistration}
          />
          <span>
            Enable public account registration
            <small>When disabled, a valid invitation is required.</small>
          </span>
        </label>
        <div className="form-columns">
          <label>
            FILE LIMIT (MB)
            <input
              type="number"
              name="maxFileMB"
              min={1}
              max={100}
              defaultValue={settings.maxFileBytes / 1048576}
            />
          </label>
          <label>
            FILES PER MESSAGE
            <input
              type="number"
              name="maxAttachments"
              min={1}
              max={20}
              defaultValue={settings.maxAttachments}
            />
          </label>
        </div>
        <div className="form-columns">
          <label>
            MESSAGE LENGTH
            <input
              type="number"
              name="maxMessageLength"
              min={1}
              max={10000}
              defaultValue={settings.maxMessageLength}
            />
          </label>
          <label>
            STORAGE QUOTA (GB)
            <input
              type="number"
              name="storageGB"
              min={1}
              max={100000}
              defaultValue={Number(settings.maxStorageBytes) / 1073741824}
            />
          </label>
        </div>
        <button className="primary-button">Save instance settings</button>
      </form>
    </>
  );
}
