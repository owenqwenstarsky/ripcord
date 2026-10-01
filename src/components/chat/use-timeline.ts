'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { P, has } from '@/lib/permissions';
import type { ChatRoom, HistoryPage } from '@/lib/types';
import { api } from '../ui';
export function useTimeline(
  room: ChatRoom | undefined,
  target: string | null,
  onError: (error: string) => void,
  readTarget = false,
  accountId?: string,
) {
  const qc = useQueryClient(),
    scroller = useRef<HTMLDivElement>(null),
    pinned = useRef(!target);
  const [atLatest, setAtLatest] = useState(!target),
    [loadingNewer, setLoadingNewer] = useState(false);
  const anchor = useRef<{ id: string; top: number } | null>(null),
    jumped = useRef(''),
    readSent = useRef(new Map<string, bigint>()),
    allowRead = useRef(!target || readTarget);
  const reader = useRef(accountId);
  if (reader.current !== accountId) {
    reader.current = accountId;
    readSent.current.clear();
  }
  const roomId = room?.id;
  const selection = useRef('');
  if (selection.current !== `${roomId}:${target}:${readTarget}`) {
    selection.current = `${roomId}:${target}:${readTarget}`;
    pinned.current = !target;
    allowRead.current = !target || readTarget;
    jumped.current = '';
    anchor.current = null;
  }
  const key = ['messages', roomId, accountId, target];
  const history = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) =>
      api<HistoryPage>(
        `rooms/${roomId}/messages${pageParam ? `?before=${pageParam}` : target ? `?around=${encodeURIComponent(target)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.seq : undefined),
    enabled: !!room && has(BigInt(room.permissions), P.READ_HISTORY),
    refetchInterval: target ? false : 20000,
  });
  const map = new Map(history.data?.pages.flatMap((p) => p.messages).map((m) => [m.id, m]));
  const messages = [...map.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  const hasNewer = !!history.data?.pages[0]?.hasNewer;
  useEffect(() => {
    pinned.current = !target;
    allowRead.current = !target || readTarget;
    jumped.current = '';
    anchor.current = null;
    setAtLatest(!target);
  }, [roomId, target, readTarget]);
  function markVisible() {
    const box = scroller.current;
    if (
      !roomId ||
      !box ||
      !allowRead.current ||
      document.visibilityState !== 'visible' ||
      !document.hasFocus()
    )
      return;
    const bounds = box.getBoundingClientRect();
    const visible = Array.from(box.querySelectorAll<HTMLElement>('[data-message-id]')).filter(
      (el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.bottom <= bounds.bottom + 1;
      },
    );
    const seq = visible.at(-1)?.dataset.seq;
    if (!seq || BigInt(seq) <= (readSent.current.get(roomId) ?? BigInt(room?.readSeq ?? 0))) return;
    readSent.current.set(roomId, BigInt(seq));
    void api(`rooms/${roomId}/read`, 'POST', { seq })
      .then(() => qc.invalidateQueries({ queryKey: ['workspace'] }))
      .catch(() => {
        readSent.current.delete(roomId);
      });
  }
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    if (anchor.current) {
      const saved = anchor.current;
      const el = Array.from(box.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (el) => el.dataset.messageId === saved.id,
      );
      if (el) box.scrollTop += el.getBoundingClientRect().top - saved.top;
      anchor.current = null;
    } else if (target && jumped.current !== `${roomId}:${target}`) {
      const el = Array.from(box.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (el) => el.dataset.messageId === target,
      );
      if (el) {
        el.scrollIntoView?.({ block: 'center' });
        el.focus({ preventScroll: true });
        jumped.current = `${roomId}:${target}`;
      }
    } else if (pinned.current && !hasNewer) box.scrollTop = box.scrollHeight;
    markVisible();
  }, [history.data, roomId, target]);
  useEffect(() => {
    const focus = () => markVisible();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [roomId, target, history.data]);
  async function loadEarlier() {
    if (history.isFetchingNextPage) return;
    const box = scroller.current;
    const el =
      box &&
      Array.from(box.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (el) => el.getBoundingClientRect().bottom > box.getBoundingClientRect().top,
      );
    if (el) anchor.current = { id: el.dataset.messageId!, top: el.getBoundingClientRect().top };
    pinned.current = false;
    try {
      await history.fetchNextPage({ throwOnError: true });
    } catch (error) {
      anchor.current = null;
      onError((error as Error).message);
    }
  }
  async function loadNewer() {
    if (loadingNewer || !messages.length) return;
    setLoadingNewer(true);
    try {
      const page = await api<HistoryPage>(`rooms/${roomId}/messages?after=${messages.at(-1)!.seq}`);
      qc.setQueryData<InfiniteData<HistoryPage>>(
        key,
        (old) =>
          old && {
            ...old,
            pages: [
              {
                ...old.pages[0],
                messages: [...old.pages[0].messages, ...page.messages],
                hasNewer: page.hasMore,
              },
              ...old.pages.slice(1),
            ],
          },
      );
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoadingNewer(false);
    }
  }
  const onScroll = () => {
    const box = scroller.current;
    if (box) {
      pinned.current = !hasNewer && box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      setAtLatest(pinned.current);
      markVisible();
    }
  };
  return {
    history,
    messages,
    scroller,
    pinned,
    atLatest,
    hasNewer,
    loadingNewer,
    loadEarlier,
    loadNewer,
    onScroll,
    enableReads: () => {
      allowRead.current = true;
    },
  };
}
