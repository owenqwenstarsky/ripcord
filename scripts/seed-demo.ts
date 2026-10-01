import type { User } from '@prisma/client';
import { db } from '../src/lib/db';
import { passwordHash, recoveryCodes } from '../src/lib/auth';
import { createServer } from '../src/lib/community';
import { DEFAULT } from '../src/lib/permissions';
import { assert } from '../src/lib/errors';

async function main() {
  const host = new URL(process.env.DATABASE_URL!).hostname;
  assert(
    ['localhost', '127.0.0.1', '::1'].includes(host) && process.env.NODE_ENV !== 'production',
    400,
    'Demo data is only allowed in a local development database.',
  );
  assert(
    !(await db.user.findFirst()),
    409,
    'Demo seeding requires an empty database. It never replaces existing accounts.',
  );
  const pass = process.env.DEMO_PASSWORD;
  assert(
    pass && pass.length >= 10 && pass.length <= 128,
    400,
    'Supply a 10–128 character DEMO_PASSWORD environment variable.',
  );
  const hashed = await passwordHash(pass);
  const people = [
    ['demo', 'Alex Morgan'],
    ['june', 'June Park'],
    ['sam', 'Sam Rivera'],
    ['leo', 'Leo Chen'],
    ['maya', 'Maya Patel'],
    ['eli', 'Eli Brooks'],
  ];
  const users: User[] = [];
  for (const [username, displayName] of people)
    users.push(
      await db.user.create({
        data: { username, displayName, passwordHash: hashed, isAdmin: username === 'demo' },
      }),
    );
  await db.$transaction((tx) => recoveryCodes(tx, users[0].id));
  const server = await createServer(
    users[0].id,
    'The Commons',
    'A home for curious minds, good ideas, and the occasional tangent.',
  );
  await db.server.update({ where: { id: server.id }, data: { icon: '✳' } });
  for (const user of users.slice(1))
    await db.membership.create({ data: { userId: user.id, serverId: server.id } });
  const builder = await db.role.create({
    data: {
      serverId: server.id,
      name: 'Builder',
      position: 2,
      permissions: DEFAULT,
      color: '#a49cff',
    },
  });
  for (const user of users.slice(0, 3)) {
    const member = await db.membership.findUniqueOrThrow({
      where: { userId_serverId: { userId: user.id, serverId: server.id } },
    });
    await db.memberRole.create({ data: { memberId: member.id, roleId: builder.id } });
  }
  const studio = await db.category.create({
    data: { serverId: server.id, name: 'The studio', position: 1 },
  });
  await db.room.createMany({
    data: [
      {
        serverId: server.id,
        categoryId: studio.id,
        name: 'design-lab',
        topic: 'A little room for big ideas.',
        position: 2,
      },
      {
        serverId: server.id,
        categoryId: studio.id,
        name: 'build-log',
        topic: 'Make something. Share the process.',
        position: 3,
      },
      {
        serverId: server.id,
        categoryId: studio.id,
        name: 'off-topic',
        topic: 'The scenic route.',
        position: 4,
      },
    ],
  });
  const general = await db.room.findFirstOrThrow({
    where: { serverId: server.id, name: 'general' },
  });
  await db.room.update({
    where: { id: general.id },
    data: { topic: 'A little bit of everything. A whole lot of good company.' },
  });
  const texts = [
    [1, 'Morning, everyone! Welcome to our little corner of the internet. 👋'],
    [1, 'No algorithms, no noise. Just us. Make yourself at home.'],
    [2, 'Okay, having a space that’s actually ours feels pretty great.'],
    [
      0,
      'Agreed. Everything lives right here on our own instance.\n\nI set up **#design-lab** for ideas and **#build-log** for whatever we’re making.',
    ],
    [4, 'Already claiming a spot in the design lab ✨'],
    [3, 'First important question: what’s everyone working on this week?'],
    [2, 'A tiny weather station for my balcony. It’s mostly an excuse to overengineer something.'],
    [1, 'The best kind of project, honestly. 😂'],
    [
      0,
      'This is exactly what this place is for. Good people, interesting things.\nDrop your projects in here — I’d love to see what you’re making. 💜',
    ],
  ] as const;
  const messages = [];
  for (const [i, [author, content]] of texts.entries())
    messages.push(
      await db.message.create({
        data: {
          roomId: general.id,
          authorId: users[author].id,
          content,
          nonce: `demo-${i}`,
          createdAt: new Date(Date.now() - (texts.length - i) * 180000),
        },
      }),
    );
  await db.reaction.createMany({
    data: [
      { messageId: messages[0].id, userId: users[0].id, emoji: '👋' },
      { messageId: messages[0].id, userId: users[2].id, emoji: '👋' },
      { messageId: messages[0].id, userId: users[4].id, emoji: '💜' },
      { messageId: messages[3].id, userId: users[1].id, emoji: '✨' },
      { messageId: messages[3].id, userId: users[4].id, emoji: '✨' },
      { messageId: messages[6].id, userId: users[0].id, emoji: '😂' },
    ],
  });
  await db.readPosition.create({
    data: { userId: users[0].id, roomId: general.id, seq: messages.at(-1)!.seq },
  });
  const other = await createServer(
    users[0].id,
    'Weekend Crew',
    'For the plans that actually make it out of the group chat.',
  );
  await db.server.update({ where: { id: other.id }, data: { icon: 'W' } });
  const dm = await db.room.create({
    data: {
      kind: 'DIRECT',
      name: 'Direct message',
      directKey: [users[0].id, users[1].id].sort().join(':'),
      members: { create: [{ userId: users[0].id }, { userId: users[1].id }] },
    },
  });
  await db.relationship.create({
    data: { fromId: users[0].id, toId: users[1].id, kind: 'FRIEND' },
  });
  await db.message.create({
    data: {
      roomId: dm.id,
      authorId: users[1].id,
      content: 'Hey! The new place is looking good. See you in the Commons. ✨',
      nonce: 'demo-dm',
    },
  });
  console.log(
    'Local demo created. Sign in as demo using DEMO_PASSWORD. The other fixture accounts use the same development password.',
  );
}
void main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
