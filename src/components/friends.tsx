'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MessageCircle,
  Users,
  UserPlus,
  Check,
  X,
  Plus,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import type { Person, Workspace } from '@/lib/types';
import { Avatar, api, Empty, ErrorNote } from './ui';
export function Friends({
  workspace,
  onDm,
  onProfile,
  onNewDm,
  onCreateServer,
  onError,
}: {
  workspace: Workspace;
  onDm: (p: Person) => void;
  onProfile: (p: Person) => void;
  onNewDm: () => void;
  onCreateServer: () => void;
  onError: (e: string) => void;
}) {
  const qc = useQueryClient(),
    [tab, setTab] = useState('all'),
    [q, setQ] = useState(''),
    [notice, setNotice] = useState('');
  const users = useQuery({
    queryKey: ['users', q],
    queryFn: () => api<Person[]>(`users?q=${encodeURIComponent(q)}`),
    enabled: tab === 'add' && q.length >= 2,
  });
  const relationships = workspace.relationships.filter((r) =>
    tab === 'all'
      ? r.kind === 'FRIEND'
      : tab === 'pending'
        ? r.kind === 'REQUEST'
        : r.kind === 'BLOCK' && r.fromId === workspace.user.id,
  );
  async function act(userId: string, action: string) {
    try {
      await api('relationships', 'POST', { userId, action });
      await qc.invalidateQueries({ queryKey: ['workspace'] });
      if (action === 'request') setNotice('Friend request sent.');
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <div className="friends-workspace">
      <div className="friends-tabs">
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
          All friends
        </button>
        <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>
          Pending
          {workspace.relationships.filter(
            (r) => r.kind === 'REQUEST' && r.toId === workspace.user.id,
          ).length > 0 && (
            <span className="count-badge">
              {
                workspace.relationships.filter(
                  (r) => r.kind === 'REQUEST' && r.toId === workspace.user.id,
                ).length
              }
            </span>
          )}
        </button>
        <button className={tab === 'blocked' ? 'active' : ''} onClick={() => setTab('blocked')}>
          Blocked
        </button>
        <button className="add-friend-tab" onClick={() => setTab('add')}>
          <UserPlus size={15} /> Add friend
        </button>
      </div>
      <div className="friends-content">
        {tab === 'add' ? (
          <>
            <span className="eyebrow">GOOD CONVERSATIONS START HERE</span>
            <h1>Add a friend.</h1>
            <p>Find someone on this instance by their username.</p>
            <label>
              USERNAME
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setNotice('');
                }}
                placeholder="Type at least two characters"
              />
            </label>
            {notice && <div className="success-note">{notice}</div>}
            <ErrorNote error={users.error?.message} />
            {users.data?.map((p) => (
              <div className="friend-row" key={p.id}>
                <Avatar user={p} onClick={() => onProfile(p)} />
                <span>
                  <strong>{p.displayName}</strong>
                  <small>@{p.username}</small>
                </span>
                <button className="secondary-button" onClick={() => void act(p.id, 'request')}>
                  <UserPlus size={16} /> Add friend
                </button>
              </div>
            ))}
          </>
        ) : relationships.length ? (
          <>
            <div className="list-heading">
              {tab === 'all'
                ? 'ALL FRIENDS'
                : tab === 'pending'
                  ? 'FRIEND REQUESTS'
                  : 'BLOCKED USERS'}{' '}
              — {relationships.length}
            </div>
            {relationships.map((r) => (
              <div className="friend-row" key={r.id}>
                <Avatar user={r.user} onClick={() => onProfile(r.user)} />
                <span>
                  <strong>{r.user.displayName}</strong>
                  <small>
                    {tab === 'pending'
                      ? r.fromId === workspace.user.id
                        ? 'Outgoing friend request'
                        : 'Incoming friend request'
                      : '@' + r.user.username}
                  </small>
                </span>
                {tab === 'all' ? (
                  <>
                    <button
                      className="circle-button"
                      aria-label={`Message ${r.user.displayName}`}
                      onClick={() => onDm(r.user)}
                    >
                      <MessageCircle size={19} />
                    </button>
                    <button
                      className="circle-button"
                      aria-label={`Remove ${r.user.displayName} as a friend`}
                      onClick={() => void act(r.user.id, 'remove')}
                    >
                      <X size={18} />
                    </button>
                  </>
                ) : tab === 'pending' ? (
                  <>
                    {r.toId === workspace.user.id && (
                      <button
                        className="circle-button"
                        aria-label="Accept request"
                        onClick={() => void act(r.user.id, 'accept')}
                      >
                        <Check size={19} />
                      </button>
                    )}
                    <button
                      className="circle-button"
                      aria-label="Decline or cancel request"
                      onClick={() => void act(r.user.id, 'remove')}
                    >
                      <X size={18} />
                    </button>
                  </>
                ) : (
                  <button
                    className="secondary-button"
                    onClick={() => void act(r.user.id, 'unblock')}
                  >
                    Unblock
                  </button>
                )}
              </div>
            ))}
          </>
        ) : (
          <Empty
            icon={tab === 'all' ? <Users size={37} /> : <ShieldCheck size={35} />}
            title={
              tab === 'all'
                ? 'Your people are out there.'
                : tab === 'pending'
                  ? 'All caught up.'
                  : 'No blocked users.'
            }
          >
            <p>
              {tab === 'all'
                ? 'Find a friend, start a conversation, or make a space for your community.'
                : tab === 'pending'
                  ? 'New friend requests will appear here.'
                  : 'People you block will appear here.'}
            </p>
            {tab === 'all' && (
              <div className="empty-actions">
                <button className="primary-button" onClick={() => setTab('add')}>
                  <UserPlus size={16} /> Find a friend
                </button>
                <button className="secondary-button" onClick={onNewDm}>
                  Start a conversation <ArrowRight size={16} />
                </button>
              </div>
            )}
          </Empty>
        )}
        {!workspace.servers.length && tab === 'all' && (
          <button className="create-community-row" onClick={onCreateServer}>
            <span className="community-glyph">
              <Users size={24} />
            </span>
            <span>
              <strong>A space to call your own.</strong>
              <small>Create a server for your friends, your project, or your community.</small>
            </span>
            <Plus size={22} />
          </button>
        )}
      </div>
    </div>
  );
}
