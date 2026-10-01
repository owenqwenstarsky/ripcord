// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { DRAFT_TTL, loadWork, saveWork } from '../src/lib/draft-storage';
beforeEach(() => localStorage.clear());
it('prunes expired work for dormant accounts while keeping current work isolated', () => {
  saveWork('old', {
    drafts: {
      room: { content: 'expired', reply: null, files: [], updatedAt: Date.now() - DRAFT_TTL - 1 },
    },
    pending: [],
  });
  saveWork('current', {
    drafts: { room: { content: 'saved', reply: null, files: [], updatedAt: Date.now() } },
    pending: [],
  });
  expect(loadWork('current').drafts.room.content).toBe('saved');
  expect(localStorage.getItem('ripcord-work:old')).toBeNull();
  expect(loadWork('other').drafts).toEqual({});
});
it('rejects malformed stored attachments and pending sends', () => {
  localStorage.setItem(
    'ripcord-work:user',
    JSON.stringify({
      drafts: { room: { content: 'text', files: null, reply: null, updatedAt: Date.now() } },
      pending: [{ nonce: 'nonce', updatedAt: Date.now() }],
    }),
  );
  expect(loadWork('user')).toEqual({ drafts: {}, pending: [] });
});
