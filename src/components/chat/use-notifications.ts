'use client';
import { useEffect, useRef } from 'react';
import type { ChatMessage, ChatRoom, Workspace } from '@/lib/types';
import { api } from '../ui';
type NotificationPage = { messages: ChatMessage[]; nextCursor: string; hasMore: boolean };
export function useNotifications(
  workspace: Workspace | null | undefined,
  connected: boolean,
  roomId: string | null,
  onOpen: (room: ChatRoom, target?: string) => void,
  reconciliation: unknown = workspace,
) {
  const state = useRef({
    account: '',
    cursor: 0n,
    latest: 0n,
    connected: false,
    baseline: true,
    revision: reconciliation,
    epoch: 0,
    running: false,
    seen: new Set<string>(),
  });
  const context = useRef({ workspace, roomId, onOpen });
  context.current = { workspace, roomId, onOpen };
  useEffect(() => {
    const current = state.current;
    if (!workspace || current.account !== workspace.user.id || !connected) {
      current.epoch++;
      current.running = false;
      current.baseline = true;
      current.revision = reconciliation;
      if (current.account !== workspace?.user.id) current.seen.clear();
      current.account = workspace?.user.id ?? '';
    }
    if (!workspace) return;
    const rooms = [...workspace.servers.flatMap((s) => s.rooms), ...workspace.dms];
    current.latest = rooms.reduce((max, room) => {
      const value = BigInt(room.latestEvent ?? room.latestSeq ?? 0);
      return value > max ? value : max;
    }, 0n);
    if (!connected || !current.connected) {
      current.cursor = current.latest;
      current.revision = reconciliation;
      current.connected = connected;
      return;
    }
    if (current.baseline) {
      // Wait for the completed reconnect workspace fetch, even when its data is structurally shared.
      if (current.revision === reconciliation) return;
      current.baseline = false;
      current.cursor = current.latest;
      return;
    }
    if (current.running || current.latest <= current.cursor) return;
    const epoch = current.epoch;
    current.running = true;
    void (async () => {
      try {
        while (epoch === current.epoch && current.cursor < current.latest) {
          const until = current.latest;
          const response = await api<NotificationPage>(
            `notifications?afterEvent=${current.cursor}&untilEvent=${until}`,
          );
          if (epoch !== current.epoch) return;
          // Accept legacy responses during rolling client/server upgrades.
          const messages = Array.isArray(response)
            ? (response as ChatMessage[])
            : response.messages;
          const latestContext = context.current;
          const snapshot = latestContext.workspace;
          if (!snapshot || snapshot.user.id !== current.account) return;
          const available = [...snapshot.servers.flatMap((s) => s.rooms), ...snapshot.dms];
          const blocked = new Set(
            snapshot.relationships
              .filter((r) => r.kind === 'BLOCK' && r.fromId === snapshot.user.id)
              .map((r) => r.toId),
          );
          for (const message of messages) {
            if (current.seen.has(message.id)) continue;
            current.seen.add(message.id);
            const room = available.find((r) => r.id === message.roomId);
            if (
              !room ||
              room.muted ||
              blocked.has(message.authorId) ||
              snapshot.servers.find((s) => s.id === room.serverId)?.muted
            )
              continue;
            const mention = message.mentions?.some((m) => m.userId === snapshot.user.id);
            if (
              !(mention && snapshot.user.notifyMentions !== false) &&
              !(room.kind !== 'TEXT' && snapshot.user.notifyDms !== false)
            )
              continue;
            if (!('Notification' in window) || Notification.permission !== 'granted') continue;
            if (
              latestContext.roomId === room.id &&
              document.visibilityState === 'visible' &&
              document.hasFocus()
            )
              continue;
            const notification = new Notification(
              mention ? 'You were mentioned on RipCord' : 'New direct message on RipCord',
              {
                body: `${message.author.displayName} in ${room.name}`,
                tag: message.id,
                icon: '/icon.svg',
              },
            );
            notification.onclick = () => {
              window.focus();
              context.current.onOpen(room, message.id);
              notification.close();
            };
          }
          if (current.seen.size > 1000) current.seen = new Set([...current.seen].slice(-500));
          const next =
            Array.isArray(response) || !response.hasMore ? until : BigInt(response.nextCursor);
          if (next <= current.cursor) throw new Error('Notification cursor did not advance');
          current.cursor = next;
        }
      } catch {
        // Keep the cursor so the next workspace refresh retries the failed page.
      } finally {
        if (epoch === current.epoch) current.running = false;
      }
    })();
  }, [workspace, connected, reconciliation]);
  useEffect(
    () => () => {
      state.current.epoch++;
    },
    [],
  );
}
