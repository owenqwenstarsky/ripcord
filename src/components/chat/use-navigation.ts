'use client';
import { useEffect, useRef, useState } from 'react';
import type { ChatRoom, Workspace } from '@/lib/types';
export function messageLink(roomId: string, messageId: string) {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('room', roomId);
  url.searchParams.set('message', messageId);
  return url.toString();
}
export function useNavigation(workspace: Workspace | null | undefined) {
  const [serverId, setServerId] = useState<string | null>(null),
    [roomId, rawRoom] = useState<string | null>(null),
    [messageTarget, rawTarget] = useState<string | null>(null),
    [readTarget, setReadTarget] = useState(false);
  const setMessageTarget = (target: string | null) => {
    rawTarget(target);
    if (!target) setReadTarget(false);
  };
  const account = useRef<string | undefined>(undefined),
    restoring = useRef(false),
    initialized = useRef(false);
  const rooms = [...(workspace?.servers.flatMap((s) => s.rooms) ?? []), ...(workspace?.dms ?? [])];
  const setRoomId = (id: string | null) => {
    rawRoom(id);
    setMessageTarget(null);
    if (id) {
      const room = rooms.find((r) => r.id === id);
      if (room) setServerId(room.serverId);
    }
  };
  useEffect(() => {
    if (!workspace) {
      account.current = undefined;
      initialized.current = false;
      return;
    }
    if (account.current !== workspace.user.id) {
      account.current = workspace.user.id;
      const params = new URLSearchParams(location.search);
      const joined = sessionStorage.getItem('ripcord-joined');
      if (joined) {
        params.delete('room');
        params.delete('message');
        params.set('server', joined);
        sessionStorage.removeItem('ripcord-joined');
      }
      const saved =
        localStorage.getItem(`ripcord-nav:${workspace.user.id}`) ??
        localStorage.getItem('ripcord-room');
      const explicit = params.has('room') || params.has('server') || params.has('home');
      const found = rooms.find((r) => r.id === (params.get('room') ?? (!explicit ? saved : null)));
      const community =
        workspace.servers.find((s) => s.id === params.get('server')) ??
        (!explicit && !found ? workspace.servers[0] : undefined);
      initialized.current = false;
      restoring.current = true;
      setServerId(found ? found.serverId : (community?.id ?? null));
      rawRoom(found?.id ?? community?.rooms[0]?.id ?? null);
      setMessageTarget(found ? params.get('message') : null);
      setReadTarget(params.get('reading') === 'unread');
    } else if (roomId && !rooms.some((r) => r.id === roomId)) {
      restoring.current = true;
      rawRoom(null);
      setMessageTarget(null);
    }
    if (serverId && !workspace.servers.some((s) => s.id === serverId)) setServerId(null);
  }, [workspace]);
  useEffect(() => {
    const pop = () => {
      const params = new URLSearchParams(location.search),
        found = rooms.find((r) => r.id === params.get('room'));
      restoring.current = true;
      rawRoom(found?.id ?? null);
      setServerId(found?.serverId ?? params.get('server'));
      setMessageTarget(found ? params.get('message') : null);
      setReadTarget(params.get('reading') === 'unread');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [workspace]);
  useEffect(() => {
    if (!workspace || account.current !== workspace.user.id) return;
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    const url = new URL(location.href);
    url.searchParams.delete('room');
    url.searchParams.delete('server');
    url.searchParams.delete('message');
    url.searchParams.delete('reading');
    url.searchParams.delete('home');
    if (roomId) url.searchParams.set('room', roomId);
    else if (serverId) url.searchParams.set('server', serverId);
    else url.searchParams.set('home', '1');
    if (messageTarget) {
      url.searchParams.set('message', messageTarget);
      if (readTarget) url.searchParams.set('reading', 'unread');
    }
    if (restoring.current) {
      restoring.current = false;
      window.history.replaceState(null, '', url);
    } else if (url.toString() !== location.href) window.history.pushState(null, '', url);
    if (roomId) {
      localStorage.setItem(`ripcord-nav:${workspace.user.id}`, roomId);
      if (serverId) localStorage.setItem(`ripcord-last:${workspace.user.id}:${serverId}`, roomId);
    }
  }, [roomId, serverId, messageTarget, readTarget, workspace?.user.id]);
  const choose = (room: ChatRoom, target?: string | null, unread = false) => {
    setReadTarget(unread);
    rawRoom(room.id);
    setServerId(room.serverId);
    setMessageTarget(target ?? null);
  };
  const lastChannel = (id: string) =>
    rooms.find(
      (r) =>
        r.serverId === id &&
        r.id === localStorage.getItem(`ripcord-last:${workspace?.user.id}:${id}`),
    );
  return {
    serverId,
    setServerId,
    roomId,
    setRoomId,
    messageTarget,
    readTarget,
    setMessageTarget,
    choose,
    lastChannel,
  };
}
