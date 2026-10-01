'use client';
import { useEffect, useRef, useState, type SetStateAction } from 'react';
import {
  loadWork,
  saveWork,
  type Draft,
  type Pending,
  type SavedWork,
  type StagedFile,
} from '@/lib/draft-storage';
import type { ChatMessage, SendStatus } from '@/lib/types';
import { api } from '../ui';
const empty = (): Draft => ({ content: '', reply: null, files: [], updatedAt: Date.now() });
export function useConversationState(
  userId: string | undefined,
  roomId: string | null,
  onError: (message: string) => void,
  onSent: (message: ChatMessage) => void,
) {
  const [, render] = useState(0);
  const owner = useRef<string | undefined>(undefined);
  const work = useRef<SavedWork>({ drafts: {}, pending: [] });
  const inFlight = useRef(new Set<string>());
  const uploads = useRef(new Set<string>());
  if (owner.current !== userId) {
    owner.current = userId;
    work.current = userId ? loadWork(userId) : { drafts: {}, pending: [] };
  }
  const persist = () => {
    if (userId && owner.current === userId) {
      try {
        saveWork(userId, work.current);
      } catch {
        onError(
          'Browser storage is full or unavailable. Keep this tab open to preserve unsent work.',
        );
      }
      render((v) => v + 1);
    }
  };
  function updateDraft(target: string, fn: (draft: Draft) => Draft) {
    if (owner.current !== userId) return;
    work.current.drafts[target] = {
      ...fn(work.current.drafts[target] ?? empty()),
      updatedAt: Date.now(),
    };
    persist();
  }
  const draft = (roomId && work.current.drafts[roomId]) || empty();
  const setContent = (value: SetStateAction<string>) =>
    roomId &&
    updateDraft(roomId, (d) => ({
      ...d,
      content: typeof value === 'function' ? value(d.content) : value,
    }));
  const setReply = (value: ChatMessage | null) =>
    roomId && updateDraft(roomId, (d) => ({ ...d, reply: value }));
  const setFiles = (value: SetStateAction<StagedFile[]>) =>
    roomId &&
    updateDraft(roomId, (d) => ({
      ...d,
      files: typeof value === 'function' ? value(d.files) : value,
    }));
  const setPending = (value: SetStateAction<Pending[]>) => {
    if (owner.current !== userId) return;
    work.current.pending = typeof value === 'function' ? value(work.current.pending) : value;
    persist();
  };
  async function transmit(p: Pending) {
    if (inFlight.current.has(p.nonce)) return;
    inFlight.current.add(p.nonce);
    setPending((old) =>
      old.map((m) => (m.nonce === p.nonce ? { ...m, failed: false, error: undefined } : m)),
    );
    try {
      const message = await api<ChatMessage>(`rooms/${p.roomId}/messages`, 'POST', {
        content: p.content,
        nonce: p.nonce,
        replyId: p.replyId,
        attachmentIds: p.attachmentIds,
      });
      // The acknowledgement is authoritative even when history is inaccessible or offline.
      setPending((old) => old.filter((m) => m.nonce !== p.nonce));
      if (owner.current === userId) onSent(message);
    } catch (error) {
      setPending((old) =>
        old.map((m) =>
          m.nonce === p.nonce
            ? {
                ...m,
                failed: true,
                ambiguous:
                  (error as { ambiguous?: boolean }).ambiguous ??
                  !(error as { status?: number }).status,
                error: (error as Error).message,
              }
            : m,
        ),
      );
    } finally {
      inFlight.current.delete(p.nonce);
    }
  }
  async function reconcile(p: Pending, intent: 'check' | 'edit' | 'discard') {
    if (inFlight.current.has(p.nonce)) return;
    if (intent === 'edit') {
      const current = work.current.drafts[p.roomId];
      if (
        current &&
        (current.content || current.files.length || current.reply) &&
        !window.confirm('Replace the draft in this conversation with this failed send?')
      )
        return;
    }
    inFlight.current.add(p.nonce);
    try {
      const result = await api<SendStatus>(
        `rooms/${p.roomId}/send-status/${encodeURIComponent(p.nonce)}`,
        intent === 'check' ? 'GET' : 'DELETE',
      );
      if (result.message) {
        setPending((old) => old.filter((m) => m.nonce !== p.nonce));
        if (owner.current === userId) onSent(result.message);
      } else if (intent === 'check')
        setPending((old) =>
          old.map((m) =>
            m.nonce === p.nonce
              ? {
                  ...m,
                  failed: true,
                  error:
                    'No acknowledgement found. Retry safely with this nonce, or edit/discard after reconciliation.',
                }
              : m,
          ),
        );
      else {
        if (intent === 'edit') {
          updateDraft(p.roomId, () => ({
            content: p.content,
            files:
              p.files ??
              p.attachmentIds.map((id) => ({ id, name: 'Attachment — reattach if unavailable' })),
            reply: p.reply ?? null,
            updatedAt: Date.now(),
          }));
        }
        setPending((old) => old.filter((m) => m.nonce !== p.nonce));
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      inFlight.current.delete(p.nonce);
    }
  }
  useEffect(() => {
    if (!userId || !roomId) return;
    const files = work.current.drafts[roomId]?.files ?? [];
    if (!files.length) return;
    let active = true;
    void api<{ available: string[] }>('uploads/staged', 'POST', { ids: files.map((f) => f.id) })
      .then((result) => {
        if (active)
          updateDraft(roomId, (d) => ({
            ...d,
            files: d.files.map((f) => ({ ...f, expired: !result.available.includes(f.id) })),
          }));
      })
      .catch((error) => {
        if (active) onError((error as Error).message);
      });
    return () => {
      active = false;
    };
  }, [userId, roomId, draft.files.map((f) => f.id).join(':')]);
  async function uploadFiles(
    list: FileList | null,
    limits: { maxAttachments: number; maxFileBytes: number },
  ) {
    if (!list || !userId || !roomId || uploads.current.has(roomId)) return;
    const target = roomId;
    uploads.current.add(target);
    render((v) => v + 1);
    try {
      if (list.length + (work.current.drafts[target]?.files.length ?? 0) > limits.maxAttachments)
        throw new Error(`Attach up to ${limits.maxAttachments} files.`);
      for (const file of Array.from(list)) {
        if (file.size > limits.maxFileBytes)
          throw new Error(
            `Files must be smaller than ${Math.round(limits.maxFileBytes / 1048576)} MB.`,
          );
        const form = new FormData();
        form.set('file', file);
        const result = await api<StagedFile>('uploads', 'POST', form);
        updateDraft(target, (d) => ({
          ...d,
          files: [...d.files, { ...result, createdAt: new Date().toISOString() }],
        }));
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      uploads.current.delete(target);
      render((v) => v + 1);
    }
  }
  return {
    content: draft.content,
    reply: draft.reply,
    files: draft.files,
    setContent,
    setReply,
    setFiles,
    pending: work.current.pending,
    setPending,
    transmit,
    reconcile,
    uploading: !!roomId && uploads.current.has(roomId),
    uploadFiles,
  };
}
