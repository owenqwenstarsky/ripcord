import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { assert } from './errors';
import { instance } from './auth';
import { roomAccess } from './access';
import { P } from './permissions';
import { lock } from './chat';

export const uploadRoot = () =>
  resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR ?? './uploads');
export function imageMime(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.subarray(0, 6).toString() === 'GIF89a' || b.subarray(0, 6).toString() === 'GIF87a')
    return 'image/gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  return 'application/octet-stream';
}
export async function upload(request: Request, userId: string) {
  const settings = await instance();
  const max = settings.maxFileBytes + 1048576;
  const length = Number(request.headers.get('content-length') ?? 0);
  assert(!length || length <= max, 413, 'Upload exceeds the file size limit.');
  assert(request.body, 400, 'A file is required.');
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      assert(size <= max, 413, 'Upload exceeds the file size limit.');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = await new Response(Buffer.concat(chunks), {
    headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
  }).formData();
  const file = data.get('file');
  assert(
    file instanceof File && file.size > 0 && file.size <= settings.maxFileBytes,
    400,
    'Choose a file within the upload limit.',
  );
  const bytes = Buffer.from(await file.arrayBuffer());
  const path = randomUUID(),
    mime = imageMime(bytes);
  await mkdir(uploadRoot(), { recursive: true });
  try {
    return await db.$transaction(async (tx) => {
      await lock(tx, 'storage');
      const total = await tx.attachment.aggregate({ _sum: { size: true } });
      assert(
        BigInt((total._sum.size ?? 0) + bytes.length) <= settings.maxStorageBytes,
        507,
        'This instance has reached its storage quota.',
      );
      await writeFile(join(/* turbopackIgnore: true */ uploadRoot(), path), bytes, {
        flag: 'wx',
        mode: 0o600,
      });
      return tx.attachment.create({
        data: {
          path,
          ownerId: userId,
          name: file.name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200),
          mime,
          size: bytes.length,
        },
        select: { id: true, name: true, mime: true, size: true },
      });
    });
  } catch (error) {
    await unlink(join(/* turbopackIgnore: true */ uploadRoot(), path)).catch(() => {});
    throw error;
  }
}
export async function download(userId: string, id: string) {
  const file = await db.attachment.findUnique({ where: { id }, include: { message: true } });
  assert(file, 404, 'File not found.');
  const avatar = await db.user.findFirst({ where: { avatarId: id } });
  if (file.message) {
    assert(!file.message.deletedAt, 404, 'File not found.');
    await roomAccess(userId, file.message.roomId, P.READ_HISTORY);
  } else assert(avatar || file.ownerId === userId, 403, 'You do not have access to this file.');
  const bytes = await readFile(join(/* turbopackIgnore: true */ uploadRoot(), file.path)).catch(
    () => null,
  );
  assert(bytes, 404, 'File not found.');
  return new Response(bytes, {
    headers: {
      'Content-Type': file.mime,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${file.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
}
export async function cleanupUploads() {
  // Take the same storage lock as upload/attachment association so an in-use file is never collected.
  await db.$transaction(
    async (tx) => {
      await lock(tx, 'storage');
      const avatars = await tx.user.findMany({
        where: { avatarId: { not: null } },
        select: { avatarId: true },
      });
      const files = await tx.attachment.findMany({
        where: {
          messageId: null,
          createdAt: { lt: new Date(Date.now() - 86400000) },
          id: { notIn: avatars.map((u) => u.avatarId!) },
        },
        take: 100,
      });
      for (const file of files) {
        await unlink(join(/* turbopackIgnore: true */ uploadRoot(), file.path)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          },
        );
        await tx.attachment.delete({ where: { id: file.id } });
      }
    },
    { timeout: 20000 },
  );
}
