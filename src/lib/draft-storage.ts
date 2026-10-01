import type { ChatMessage } from './types';
export const DRAFT_TTL = 7 * 86400000;
export type StagedFile = { id: string; name: string; createdAt?: string; expired?: boolean };
export type Draft = {
  content: string;
  reply: ChatMessage | null;
  files: StagedFile[];
  updatedAt: number;
};
export type Pending = {
  nonce: string;
  roomId: string;
  content: string;
  attachmentIds: string[];
  files?: StagedFile[];
  replyId?: string;
  reply?: ChatMessage | null;
  failed: boolean;
  ambiguous?: boolean;
  error?: string;
  updatedAt: number;
};
export type SavedWork = { drafts: Record<string, Draft>; pending: Pending[] };
const key = (userId: string) => `ripcord-work:${userId}`;
function validFiles(value: unknown): value is StagedFile[] {
  return (
    Array.isArray(value) &&
    value.every((f) => f && typeof f.id === 'string' && typeof f.name === 'string')
  );
}
function validReply(value: unknown): value is ChatMessage | null {
  if (value === null || value === undefined) return true;
  const reply = value as ChatMessage;
  return (
    typeof reply.id === 'string' &&
    typeof reply.content === 'string' &&
    !!reply.author &&
    typeof reply.author.displayName === 'string'
  );
}
function parseWork(raw: string | null): SavedWork {
  const value = JSON.parse(raw ?? '{}');
  const cutoff = Date.now() - DRAFT_TTL;
  const drafts = Object.fromEntries(
    Object.entries(value?.drafts ?? {}).filter(([, entry]) => {
      const draft = entry as Draft;
      return (
        draft &&
        typeof draft.content === 'string' &&
        draft.updatedAt > cutoff &&
        validFiles(draft.files) &&
        validReply(draft.reply)
      );
    }),
  );
  const pending = (Array.isArray(value?.pending) ? value.pending : []).filter(
    (p: Pending) =>
      p &&
      p.updatedAt > cutoff &&
      typeof p.nonce === 'string' &&
      typeof p.roomId === 'string' &&
      typeof p.content === 'string' &&
      Array.isArray(p.attachmentIds) &&
      p.attachmentIds.every((id) => typeof id === 'string') &&
      (!p.files || validFiles(p.files)) &&
      validReply(p.reply),
  );
  return { drafts: drafts as Record<string, Draft>, pending };
}
export function loadWork(userId: string, storage: Storage = localStorage): SavedWork {
  try {
    // Expire dormant accounts' work too; session expiry never exposes another account's drafts.
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (k): k is string => !!k?.startsWith('ripcord-work:'),
    );
    for (const storedKey of keys) {
      try {
        const work = parseWork(storage.getItem(storedKey));
        if (!Object.keys(work.drafts).length && !work.pending.length) storage.removeItem(storedKey);
        else storage.setItem(storedKey, JSON.stringify(work));
      } catch {
        storage.removeItem(storedKey);
      }
    }
    const work = parseWork(storage.getItem(key(userId)));
    return {
      ...work,
      pending: work.pending.map((p) => ({
        ...p,
        failed: true,
        ambiguous: true,
        error: 'Saved send. Check its status or retry using the original nonce.',
      })),
    };
  } catch {
    return { drafts: {}, pending: [] };
  }
}
export function saveWork(userId: string, work: SavedWork, storage: Storage = localStorage) {
  storage.setItem(key(userId), JSON.stringify(work));
}
export function clearWork(userId: string, storage: Storage = localStorage) {
  storage.removeItem(key(userId));
}
