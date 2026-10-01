import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@prisma/client';
import { P, ALL, DEFAULT } from '../src/lib/permissions';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')(
  'PostgreSQL application boundaries (isolated schema)',
  () => {
    let db: (typeof import('../src/lib/db'))['db'];
    let auth: typeof import('../src/lib/auth'),
      community: typeof import('../src/lib/community'),
      chat: typeof import('../src/lib/chat'),
      security: typeof import('../src/lib/access'),
      http: typeof import('../src/lib/api'),
      uploads: typeof import('../src/lib/uploads');
    let users: User[], serverId: string, roomId: string, everyoneId: string, folder: string;
    const schema = `ripcord_test_${randomUUID().replaceAll('-', '')}`;
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.searchParams.set('schema', schema);
      process.env.DATABASE_URL = url.toString();
      folder = await mkdtemp(join(tmpdir(), 'ripcord-test-'));
      process.env.UPLOAD_DIR = folder;
      execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
        env: process.env,
        stdio: 'pipe',
      });
      ({ db } = await import('../src/lib/db'));
      auth = await import('../src/lib/auth');
      community = await import('../src/lib/community');
      chat = await import('../src/lib/chat');
      security = await import('../src/lib/access');
      http = await import('../src/lib/api');
      uploads = await import('../src/lib/uploads');
      const pass = await auth.passwordHash('test-password-long-enough');
      users = await Promise.all(
        ['owner', 'member', 'moderator', 'outsider'].map((username, i) =>
          db.user.create({
            data: {
              username,
              displayName: username,
              passwordHash: pass,
              isAdmin: i === 0 || i === 3,
            },
          }),
        ),
      );
      await auth.instance();
    }, 60000);
    beforeEach(async () => {
      const server = await community.createServer(users[0].id, 'Test community');
      serverId = server.id;
      await db.membership.createMany({
        data: [
          { serverId, userId: users[1].id },
          { serverId, userId: users[2].id },
        ],
      });
      roomId = (await db.room.findFirstOrThrow({ where: { serverId, name: 'general' } })).id;
      everyoneId = (await db.role.findFirstOrThrow({ where: { serverId, everyone: true } })).id;
    });
    afterAll(async () => {
      if (db) {
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.$disconnect();
      }
      if (folder) await rm(folder, { recursive: true, force: true });
    });
    function send(
      userId = users[1].id,
      content = 'A searchable constellation',
      nonce = randomUUID(),
    ) {
      return chat.sendMessage(userId, roomId, { content, nonce, attachmentIds: [] });
    }
    async function request(
      path: string,
      method = 'GET',
      input?: unknown,
      userId = users[0].id,
      origin = auth.appUrl(),
    ) {
      const token = await auth.newSession(userId);
      return http.handleRequest(
        new Request(`${auth.appUrl()}/api/${path}`, {
          method,
          headers: {
            origin,
            cookie: `ripcord_session=${token}`,
            'Content-Type': 'application/json',
          },
          body: input === undefined ? undefined : JSON.stringify(input),
        }),
      );
    }
    it('deduplicates simultaneous retries and commits one durable event', async () => {
      const nonce = randomUUID();
      const before = await db.event.count({ where: { scope: 'room', targetId: roomId } });
      const result = await Promise.all(
        Array.from({ length: 8 }, () => send(users[1].id, 'A searchable constellation', nonce)),
      );
      expect(new Set(result.map((m) => m.id)).size).toBe(1);
      expect(await db.message.count({ where: { roomId } })).toBe(1);
      expect(await db.event.count({ where: { scope: 'room', targetId: roomId } })).toBe(before + 1);
    });
    it('paginates without duplicates and returns new history for reconnects', async () => {
      const sent = [];
      for (let i = 0; i < 55; i++) sent.push(await send(users[0].id, `History ${i}`));
      const page = await chat.history(users[1].id, roomId);
      expect(page.messages).toHaveLength(50);
      expect(page.hasMore).toBe(true);
      const older = await chat.history(users[1].id, roomId, page.messages[0].seq.toString());
      expect(older.messages).toHaveLength(5);
      const fresh = await chat.history(users[1].id, roomId, undefined, sent[53].seq.toString());
      expect(fresh.messages.map((m) => m.id)).toEqual([sent[54].id]);
    });
    it('enforces private channels across history, search, unread data, and uploads', async () => {
      const form = new FormData();
      form.set('file', new File(['private'], 'secret.txt'));
      const file = await uploads.upload(
        new Request(`${auth.appUrl()}/api/uploads`, { method: 'POST', body: form }),
        users[0].id,
      );
      await chat.sendMessage(users[0].id, roomId, {
        content: 'Private constellation',
        nonce: randomUUID(),
        attachmentIds: [file.id],
      });
      await community.setOverride(users[0].id, serverId, 'room', roomId, {
        targetType: 'ROLE',
        targetId: everyoneId,
        allow: '0',
        deny: P.VIEW_CHANNEL.toString(),
      });
      await expect(chat.history(users[1].id, roomId)).rejects.toMatchObject({ status: 403 });
      expect(await chat.searchMessages(users[1].id, 'constellation', undefined, serverId)).toEqual(
        [],
      );
      expect(
        (await chat.workspace(users[1].id)).servers
          .find((s) => s.id === serverId)
          ?.rooms.some((r) => r?.id === roomId),
      ).toBe(false);
      await expect(uploads.download(users[1].id, file.id)).rejects.toMatchObject({ status: 403 });
      await expect(uploads.download(users[3].id, file.id)).rejects.toMatchObject({ status: 403 });
      expect((await uploads.download(users[0].id, file.id)).status).toBe(200);
    });
    it('does not let instance administration bypass server membership', async () => {
      await expect(security.serverAccess(users[3].id, serverId)).rejects.toMatchObject({
        status: 403,
      });
      await expect(chat.history(users[3].id, roomId)).rejects.toMatchObject({ status: 403 });
    });
    it('preserves category permissions when unsynchronizing or deleting a category', async () => {
      const room = await db.room.findUniqueOrThrow({ where: { id: roomId } });
      await community.setOverride(users[0].id, serverId, 'category', room.categoryId!, {
        targetType: 'ROLE',
        targetId: everyoneId,
        allow: '0',
        deny: P.VIEW_CHANNEL.toString(),
      });
      await expect(security.roomAccess(users[1].id, roomId)).rejects.toMatchObject({ status: 403 });
      await community.channelMutation(users[0].id, serverId, { synchronized: false }, roomId);
      await expect(security.roomAccess(users[1].id, roomId)).rejects.toMatchObject({ status: 403 });
      await community.channelMutation(users[0].id, serverId, { synchronized: true }, roomId);
      await community.categoryMutation(users[0].id, serverId, {}, room.categoryId!, true);
      await expect(security.roomAccess(users[1].id, roomId)).rejects.toMatchObject({ status: 403 });
    });
    it('enforces role hierarchy even for server administrators', async () => {
      const role = await community.roleMutation(users[0].id, serverId, {
        name: 'Admin',
        permissions: P.ADMINISTRATOR.toString(),
        position: 5,
      });
      await community.assignRoles(users[0].id, serverId, users[2].id, [role!.id]);
      await expect(
        community.moderate(users[2].id, serverId, users[0].id, 'kick', ''),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        community.roleMutation(users[2].id, serverId, { name: 'Admin renamed' }, role!.id),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        community.assignRoles(users[2].id, serverId, users[2].id, [role!.id]),
      ).rejects.toMatchObject({ status: 403 });
      await community.moderate(users[2].id, serverId, users[1].id, 'timeout', '', 60);
      await expect(send()).rejects.toMatchObject({ status: 403 });
      await db.membership.update({
        where: { userId_serverId: { userId: users[1].id, serverId } },
        data: { timeoutUntil: new Date(Date.now() - 1) },
      });
      expect((await send()).content).toBeTruthy();
    });
    it('rejects role permission escalation and cross-server role assignment', async () => {
      const manager = await community.roleMutation(users[0].id, serverId, {
        name: 'Role manager',
        permissions: (DEFAULT | P.MANAGE_ROLES).toString(),
        position: 5,
      });
      await community.assignRoles(users[0].id, serverId, users[2].id, [manager!.id]);
      await expect(
        community.roleMutation(users[2].id, serverId, {
          name: 'Escalation',
          permissions: ALL.toString(),
          position: 1,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const foreign = await community.createServer(users[0].id, 'Another server');
      const foreignRole = await db.role.findFirstOrThrow({
        where: { serverId: foreign.id, everyone: false },
      });
      await expect(
        community.assignRoles(users[0].id, serverId, users[1].id, [foreignRole.id]),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('serializes slow mode, supports deletion tombstones, and removes reaction data', async () => {
      await community.channelMutation(users[0].id, serverId, { slowMode: 60 }, roomId);
      const result = await Promise.allSettled([send(), send()]);
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const message = (
        result.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
          Awaited<ReturnType<typeof send>>
        >
      ).value;
      await chat.react(users[0].id, message.id, '👍');
      const reply = await chat.sendMessage(users[0].id, roomId, {
        content: 'A reply',
        nonce: randomUUID(),
        replyId: message.id,
        attachmentIds: [],
      });
      await chat.modifyMessage(users[0].id, message.id);
      const stored = await db.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(stored.content).toBeNull();
      expect(stored.deletedAt).toBeTruthy();
      expect(await db.reaction.count({ where: { messageId: message.id } })).toBe(0);
      expect(
        (await chat.history(users[0].id, roomId)).messages.find((m) => m.id === reply.id)?.reply
          ?.content,
      ).toBeNull();
      const log = await db.auditLog.findFirstOrThrow({ where: { targetId: message.id } });
      expect(JSON.stringify(log.detail)).not.toContain('searchable');
    });
    it('rejects mass mentions, cross-room replies, and unauthorized edits', async () => {
      await expect(send(users[1].id, '@everyone hi')).rejects.toMatchObject({ status: 403 });
      const message = await send();
      await expect(chat.modifyMessage(users[2].id, message.id, 'Changed')).rejects.toMatchObject({
        status: 403,
      });
      const other = await db.room.findFirstOrThrow({ where: { serverId, name: 'introductions' } });
      await expect(
        chat.sendMessage(users[1].id, other.id, {
          content: 'reply',
          nonce: randomUUID(),
          replyId: message.id,
          attachmentIds: [],
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('keeps read positions monotonic and rejects future or foreign positions', async () => {
      const a = await send(),
        b = await send();
      await chat.markRead(users[1].id, roomId, b.seq.toString());
      await chat.markRead(users[1].id, roomId, a.seq.toString());
      expect(
        (
          await db.readPosition.findUniqueOrThrow({
            where: { userId_roomId: { userId: users[1].id, roomId } },
          })
        ).seq,
      ).toBe(b.seq);
      await expect(chat.markRead(users[1].id, roomId, '999999999')).rejects.toMatchObject({
        status: 400,
      });
    });
    it('consumes a limited invitation exactly once under concurrent registration', async () => {
      const invite = await community.createInvite(users[0].id, serverId, 1, 1);
      const results = await Promise.allSettled(
        ['invite_a', 'invite_b'].map((username) =>
          auth.register({
            username,
            displayName: username,
            password: 'test-password-long-enough',
            invite: invite.code,
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await db.invite.findUniqueOrThrow({ where: { code: invite.code } })).uses).toBe(1);
      expect(await db.user.count({ where: { username: { in: ['invite_a', 'invite_b'] } } })).toBe(
        1,
      );
    });
    it('handles invitation expiration, revocation, and bans', async () => {
      const invite = await community.createInvite(users[0].id, serverId, 10, 1);
      await db.invite.update({ where: { code: invite.code }, data: { expiresAt: new Date(0) } });
      await expect(
        db.$transaction((tx) => auth.consumeInvite(tx, invite.code, users[3].id)),
      ).rejects.toMatchObject({ status: 400 });
      await db.invite.update({
        where: { code: invite.code },
        data: { expiresAt: null, revoked: true },
      });
      await expect(
        db.$transaction((tx) => auth.consumeInvite(tx, invite.code, users[3].id)),
      ).rejects.toMatchObject({ status: 400 });
      await db.invite.update({ where: { code: invite.code }, data: { revoked: false } });
      await community.moderate(users[0].id, serverId, users[1].id, 'ban', 'test');
      await expect(
        db.$transaction((tx) => auth.consumeInvite(tx, invite.code, users[1].id)),
      ).rejects.toMatchObject({ status: 403 });
    });
    it('uses recovery codes once and revokes all existing sessions', async () => {
      const codes = await db.$transaction((tx) => auth.recoveryCodes(tx, users[1].id));
      const token = await auth.newSession(users[1].id);
      const attempts = await Promise.allSettled([
        auth.recover('member', codes[0], 'replacement-password-long'),
        auth.recover('member', codes[0], 'replacement-password-long'),
      ]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await auth.sessionUser(token)).toBeNull();
      await expect(auth.recover('member', codes[0], 'another-password-long')).rejects.toMatchObject(
        { status: 400 },
      );
      expect((await auth.login('member', 'replacement-password-long')).length).toBeGreaterThan(20);
    });
    it('blocks DMs, enforces friends-only settings, and revokes group history after removal', async () => {
      await db.user.update({ where: { id: users[1].id }, data: { friendsOnly: true } });
      await expect(community.createDm(users[0].id, [users[1].id])).rejects.toMatchObject({
        status: 403,
      });
      await db.relationship.create({
        data: { fromId: users[0].id, toId: users[1].id, kind: 'FRIEND' },
      });
      const dm = await community.createDm(users[0].id, [users[1].id]);
      expect((await community.createDm(users[1].id, [users[0].id])).id).toBe(dm.id);
      await db.relationship.create({
        data: { fromId: users[1].id, toId: users[0].id, kind: 'BLOCK' },
      });
      await expect(
        chat.sendMessage(users[0].id, dm.id, {
          content: 'Blocked',
          nonce: randomUUID(),
          attachmentIds: [],
        }),
      ).rejects.toMatchObject({ status: 403 });
      await db.relationship.deleteMany();
      await db.user.update({ where: { id: users[1].id }, data: { friendsOnly: false } });
      const group = await community.createDm(users[0].id, [users[1].id, users[2].id]);
      await db.roomMember.delete({
        where: { roomId_userId: { roomId: group.id, userId: users[1].id } },
      });
      await expect(chat.history(users[1].id, group.id)).rejects.toMatchObject({ status: 403 });
    });
    it('keeps batched socket authorization consistent with HTTP permission checks', async () => {
      await community.setOverride(users[0].id, serverId, 'room', roomId, {
        targetType: 'MEMBER',
        targetId: users[1].id,
        allow: '0',
        deny: P.VIEW_CHANNEL.toString(),
      });
      const audience = await security.roomAudience(
        roomId,
        users.map((u) => u.id),
      );
      for (const user of users) {
        const httpAllowed = await security.roomAccess(user.id, roomId).then(
          () => true,
          () => false,
        );
        expect(audience.allowed.has(user.id)).toBe(httpAllowed);
      }
    });
    it('does not expose private channel reports to moderators without channel access', async () => {
      const role = await db.role.findFirstOrThrow({ where: { serverId, name: 'Moderator' } });
      await community.assignRoles(users[0].id, serverId, users[2].id, [role.id]);
      const message = await send(users[0].id, 'Private report contents');
      const response = await request('reports', 'POST', {
        messageId: message.id,
        reason: 'Private report',
      });
      expect(response.status).toBe(200);
      await community.setOverride(users[0].id, serverId, 'room', roomId, {
        targetType: 'ROLE',
        targetId: everyoneId,
        allow: '0',
        deny: P.VIEW_CHANNEL.toString(),
      });
      expect(
        await (await request(`reports?serverId=${serverId}`, 'GET', undefined, users[2].id)).json(),
      ).toEqual([]);
      expect(await (await request(`reports?serverId=${serverId}`)).json()).toHaveLength(1);
    });
    it('consumes email tokens once, rejects expiration, and invalidates older account links', async () => {
      const verifyToken = auth.secret(),
        resetToken = auth.secret(),
        expired = auth.secret();
      await db.accountToken.createMany({
        data: [
          {
            hash: auth.digest(verifyToken),
            userId: users[1].id,
            purpose: 'verify',
            email: 'member@example.test',
            expiresAt: new Date(Date.now() + 60000),
          },
          {
            hash: auth.digest(resetToken),
            userId: users[1].id,
            purpose: 'reset',
            expiresAt: new Date(Date.now() + 60000),
          },
          {
            hash: auth.digest(expired),
            userId: users[1].id,
            purpose: 'verify',
            email: 'old@example.test',
            expiresAt: new Date(0),
          },
        ],
      });
      expect((await request('auth/verify', 'POST', { token: expired })).status).toBe(400);
      expect((await request('auth/verify', 'POST', { token: verifyToken })).status).toBe(200);
      expect((await db.user.findUniqueOrThrow({ where: { id: users[1].id } })).emailVerified).toBe(
        true,
      );
      expect((await request('auth/verify', 'POST', { token: verifyToken })).status).toBe(400);
      expect(
        (
          await request('auth/reset', 'POST', {
            token: resetToken,
            password: 'old-link-password-long',
          })
        ).status,
      ).toBe(400);
    });
    it('protects HTTP mutations from foreign origins and account suspension revokes sessions', async () => {
      expect(
        (await request('servers', 'POST', { name: 'CSRF' }, users[0].id, 'https://attacker.test'))
          .status,
      ).toBe(403);
      expect((await request('admin/settings', 'GET', undefined, users[1].id)).status).toBe(403);
      const token = await auth.newSession(users[2].id);
      expect(
        (await request(`admin/users/${users[2].id}`, 'PATCH', { suspended: true })).status,
      ).toBe(200);
      expect(await auth.sessionUser(token)).toBeNull();
      await db.user.update({ where: { id: users[2].id }, data: { suspended: false } });
    });
    it('limits DM report review to explicitly reported message contents', async () => {
      const dm = await community.createDm(users[0].id, [users[1].id]);
      const m = await chat.sendMessage(users[1].id, dm.id, {
        content: 'Reported message',
        nonce: randomUUID(),
        attachmentIds: [],
      });
      await chat.sendMessage(users[1].id, dm.id, {
        content: 'Other private message',
        nonce: randomUUID(),
        attachmentIds: [],
      });
      const report = await request(
        'reports',
        'POST',
        { messageId: m.id, reason: 'Review this message' },
        users[0].id,
      );
      expect(report.status).toBe(200);
      const review = await request('reports', 'GET', undefined, users[3].id);
      const text = await review.text();
      expect(text).toContain('Reported message');
      expect(text).not.toContain('Other private message');
      expect((await request('reports', 'GET', undefined, users[1].id)).status).toBe(403);
    });
    it('detects safe image types and collects abandoned uploads without removing avatars', async () => {
      const form = new FormData();
      form.set(
        'file',
        new File(['<svg onload="alert(1)"></svg>'], 'active.svg', { type: 'image/svg+xml' }),
      );
      const file = await uploads.upload(
        new Request(`${auth.appUrl()}/api/uploads`, { method: 'POST', body: form }),
        users[0].id,
      );
      expect(file.mime).toBe('application/octet-stream');
      expect(
        (await uploads.download(users[0].id, file.id)).headers.get('content-disposition'),
      ).toContain('attachment');
      await db.attachment.update({
        where: { id: file.id },
        data: { createdAt: new Date(Date.now() - 2 * 86400000) },
      });
      await uploads.cleanupUploads();
      expect(await db.attachment.findUnique({ where: { id: file.id } })).toBeNull();
      expect(uploads.imageMime(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png');
    });
  },
);
