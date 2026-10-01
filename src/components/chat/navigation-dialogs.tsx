'use client';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ChatMessage, ChatRoom, Workspace } from '@/lib/types';
import { api, Avatar, Empty, ErrorNote, Modal } from '../ui';
export function roomTitle(room: ChatRoom, userId: string) {
  return room.kind === 'DIRECT'
    ? (room.members?.find((m) => m.user.id !== userId)?.user.displayName ?? room.name)
    : room.name;
}
export function QuickSwitcher({
  workspace,
  open,
  onClose,
  onChoose,
}: {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
  onChoose: (room: ChatRoom) => void;
}) {
  const [query, setQuery] = useState(''),
    [index, setIndex] = useState(0);
  const rooms = [...workspace.servers.flatMap((s) => s.rooms), ...workspace.dms];
  const matches = rooms
    .filter((r) =>
      `${roomTitle(r, workspace.user.id)} ${workspace.servers.find((s) => s.id === r.serverId)?.name ?? 'Direct messages'}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 30);
  const choose = (r: ChatRoom) => {
    onChoose(r);
    onClose();
    setQuery('');
  };
  return (
    <Modal title="Switch conversation" open={open} onClose={onClose}>
      <div className="modal-body">
        <label>
          FIND A CONVERSATION
          <input
            autoFocus
            value={query}
            role="combobox"
            aria-expanded={true}
            aria-controls="switcher-results"
            aria-activedescendant={matches[index] ? `switch-${matches[index].id}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, matches.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              }
              if (e.key === 'Enter' && matches[index]) {
                e.preventDefault();
                choose(matches[index]);
              }
            }}
            placeholder="Channel, community, or person"
          />
        </label>
        <div id="switcher-results" role="listbox">
          {matches.map((r, i) => (
            <button
              role="option"
              aria-selected={i === index}
              id={`switch-${r.id}`}
              className={`person-result ${i === index ? 'active' : ''}`}
              key={r.id}
              onClick={() => choose(r)}
            >
              <span>
                <strong>{roomTitle(r, workspace.user.id)}</strong>
                <small>
                  {workspace.servers.find((s) => s.id === r.serverId)?.name ?? 'Direct messages'}
                </small>
              </span>
              {r.unread > 0 && <span className="count-badge">{r.unread}</span>}
            </button>
          ))}
        </div>
        {!matches.length && <p className="muted">No conversations match.</p>}
      </div>
    </Modal>
  );
}
export function CatchUp({
  workspace,
  mode,
  onClose,
  onChoose,
}: {
  workspace: Workspace;
  mode: 'unread' | 'mentions' | null;
  onClose: () => void;
  onChoose: (room: ChatRoom, target?: string | null, unread?: boolean) => void;
}) {
  const rooms = [...workspace.servers.flatMap((s) => s.rooms), ...workspace.dms];
  const mentions = useInfiniteQuery({
    queryKey: ['mentions'],
    queryFn: ({ pageParam }) =>
      api<{ messages: ChatMessage[]; nextCursor: string | null }>(
        `mentions${pageParam ? `?before=${pageParam}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: mode === 'mentions',
  });
  const open = (r: ChatRoom, target?: string | null) => {
    onChoose(r, target, mode === 'unread');
    onClose();
  };
  const blocked = new Set(
    workspace.relationships
      .filter((r) => r.kind === 'BLOCK' && r.fromId === workspace.user.id)
      .map((r) => r.toId),
  );
  const unread = rooms.filter((r) => r.unread > 0);
  return (
    <Modal
      title={mode === 'mentions' ? 'Mentions' : 'Unread conversations'}
      open={!!mode}
      onClose={onClose}
    >
      <div className="modal-body">
        {mode === 'unread' ? (
          unread.length ? (
            unread.map((r) => (
              <button className="person-result" key={r.id} onClick={() => open(r, r.firstUnreadId)}>
                <span>
                  <strong>{roomTitle(r, workspace.user.id)}</strong>
                  <small>
                    {workspace.servers.find((s) => s.id === r.serverId)?.name ?? 'Direct messages'}
                    {r.muted && ' · Muted'}
                  </small>
                </span>
                <span className="count-badge">{r.unread}</span>
              </button>
            ))
          ) : (
            <Empty title="All caught up." />
          )
        ) : (
          <>
            {mentions.isPending && <p className="muted">Loading mentions…</p>}
            <ErrorNote error={mentions.error?.message} />
            {mentions.data?.pages
              .flatMap((p) => p.messages)
              .map((m) => (
                <button
                  className="person-result"
                  key={m.id}
                  onClick={() => {
                    const r = rooms.find((r) => r.id === m.roomId);
                    if (r) open(r, m.id);
                  }}
                >
                  <Avatar user={m.author} size="small" />
                  <span>
                    <strong>{m.author.displayName}</strong>
                    <small>
                      {rooms.find((r) => r.id === m.roomId)?.name} ·{' '}
                      {new Date(m.createdAt).toLocaleString()}
                    </small>
                    <p>{blocked.has(m.authorId) ? 'Message from a blocked user' : m.content}</p>
                  </span>
                </button>
              ))}
            {mentions.data?.pages[0]?.messages.length === 0 && <Empty title="No mentions yet." />}
            {mentions.hasNextPage && (
              <button
                className="secondary-button"
                disabled={mentions.isFetchingNextPage}
                onClick={() => void mentions.fetchNextPage()}
              >
                Load older mentions
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
