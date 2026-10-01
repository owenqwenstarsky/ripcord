import { randomBytes, createHash } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Prisma, User } from '@prisma/client';
import nodemailer from 'nodemailer';
import { db } from './db';
import { assert } from './errors';

export const personSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarId: true,
} as const;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(24).toString('base64url');
export const passwordHash = (password: string) =>
  hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export function cookieToken(header: string | null | undefined) {
  return header
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('ripcord_session='))
    ?.slice(16);
}
export async function sessionUser(token: string | undefined) {
  if (!token || token.length > 200) return null;
  const session = await db.session.findUnique({
    where: { id: digest(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date() || session.user.suspended) return null;
  return session.user;
}
export async function requireUser(request: Request) {
  const user = await sessionUser(cookieToken(request.headers.get('cookie')));
  assert(user, 401, 'Please sign in to continue.');
  return user;
}
export function sessionCookie(token: string, clear = false) {
  const secure = new URL(appUrl()).protocol === 'https:';
  return `ripcord_session=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 2592000}${secure ? '; Secure' : ''}`;
}
export async function newSession(userId: string) {
  const token = secret();
  await db.session.create({
    data: { id: digest(token), userId, expiresAt: new Date(Date.now() + 30 * 86400000) },
  });
  return token;
}
export async function login(username: string, password: string) {
  const user = await db.user.findUnique({ where: { username: username.toLowerCase() } });
  // Verify a real hash even for unknown accounts to reduce username timing leakage.
  const fallback =
    '$argon2id$v=19$m=19456,t=2,p=1$cmlwY29yZHRpbWluZ3NhbHQ$dKaPyxzUK/XoiTYcq+RfO42sdzh/iHDbuCpUkRoEDM4';
  const valid = await verify(user?.passwordHash ?? fallback, password).catch(() => false);
  assert(user && valid && !user.suspended, 401, 'Invalid username or password.');
  return newSession(user.id);
}
export function checkOrigin(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  assert(request.headers.get('origin') === appUrl(), 403, 'Request origin is not allowed.');
}
export async function rateLimit(key: string, limit: number, seconds: number) {
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateBucket" ("key", "count", "expiresAt") VALUES (${key}, 1, NOW() + ${seconds} * INTERVAL '1 second')
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateBucket"."expiresAt" <= NOW() THEN 1 ELSE "RateBucket"."count" + 1 END,
      "expiresAt" = CASE WHEN "RateBucket"."expiresAt" <= NOW() THEN NOW() + ${seconds} * INTERVAL '1 second' ELSE "RateBucket"."expiresAt" END
    RETURNING "count"`;
  assert(rows[0].count <= limit, 429, 'Too many requests. Please try again shortly.');
}
export const instance = () =>
  db.instance.upsert({ where: { id: 'instance' }, update: {}, create: {} });
export async function recoveryCodes(tx: Prisma.TransactionClient, userId: string) {
  const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex'));
  await tx.recoveryCode.deleteMany({ where: { userId } });
  await tx.recoveryCode.createMany({ data: codes.map((code) => ({ userId, hash: digest(code) })) });
  return codes;
}
export async function consumeInvite(tx: Prisma.TransactionClient, code: string, userId?: string) {
  const initial = await tx.invite.findUnique({ where: { code } });
  if (initial?.serverId)
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`server:${initial.serverId}`}))::text`;
  await tx.$queryRaw`SELECT "code" FROM "Invite" WHERE "code" = ${code} FOR UPDATE`;
  const invite = await tx.invite.findUnique({ where: { code } });
  assert(
    invite &&
      !invite.revoked &&
      (!invite.expiresAt || invite.expiresAt > new Date()) &&
      (invite.maxUses === null || invite.uses < invite.maxUses),
    400,
    'This invitation is invalid, expired, or fully used.',
  );
  if (invite.serverId && userId) {
    assert(
      !(await tx.ban.findUnique({
        where: { serverId_userId: { serverId: invite.serverId, userId } },
      })),
      403,
      'You are banned from this server.',
    );
    const member = await tx.membership.findUnique({
      where: { userId_serverId: { userId, serverId: invite.serverId } },
    });
    if (member) return invite;
    await tx.membership.create({ data: { userId, serverId: invite.serverId } });
    await tx.event.create({
      data: { scope: 'server', targetId: invite.serverId, type: 'membership' },
    });
  }
  await tx.invite.update({ where: { code }, data: { uses: { increment: 1 } } });
  return invite;
}
export async function register(input: {
  username: string;
  displayName: string;
  password: string;
  invite?: string;
}) {
  const settings = await instance();
  assert(
    settings.publicRegistration || input.invite,
    403,
    'An invitation is required to register.',
  );
  const pass = await passwordHash(input.password);
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: input.username.toLowerCase(),
        displayName: input.displayName,
        passwordHash: pass,
      },
    });
    if (input.invite) await consumeInvite(tx, input.invite, user.id);
    const codes = await recoveryCodes(tx, user.id);
    return { user, codes };
  });
}
export async function recover(username: string, code: string, password: string) {
  const pass = await passwordHash(password);
  await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { username: username.toLowerCase() } });
    assert(user && !user.suspended, 400, 'Invalid recovery credentials.');
    const used = await tx.recoveryCode.deleteMany({
      where: { userId: user.id, hash: digest(code.trim()) },
    });
    assert(used.count === 1, 400, 'Invalid or already used recovery code.');
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: pass } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.accountToken.deleteMany({ where: { userId: user.id } });
  });
}
export async function sendAccountEmail(user: User, purpose: 'verify' | 'reset', email: string) {
  assert(
    process.env.SMTP_URL && process.env.SMTP_FROM,
    503,
    'Email delivery is not configured on this instance.',
  );
  const token = secret();
  await db.accountToken.create({
    data: {
      hash: digest(token),
      userId: user.id,
      purpose,
      email,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const link = `${appUrl()}/?${purpose}=${encodeURIComponent(token)}`;
  await nodemailer.createTransport(process.env.SMTP_URL).sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: purpose === 'verify' ? 'Verify your RipCord email' : 'Reset your RipCord password',
    text: `${purpose === 'verify' ? 'Verify your email' : 'Reset your password'} using this link (valid for one hour):\n${link}\n\nIf you did not request this, ignore this email.`,
  });
}
