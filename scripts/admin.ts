import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../src/lib/db';
import { passwordHash, recoveryCodes, instance } from '../src/lib/auth';
import { lock, audit } from '../src/lib/chat';
import { createInvite } from '../src/lib/community';
import { assert } from '../src/lib/errors';

async function promptPassword() {
  if (process.env.RIPCORD_ADMIN_PASSWORD) return process.env.RIPCORD_ADMIN_PASSWORD;
  assert(
    stdin.isTTY,
    400,
    'Use an interactive terminal or supply RIPCORD_ADMIN_PASSWORD in the environment.',
  );
  stdout.write('Password (at least 10 characters): ');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const listener = (chunk: Buffer) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', listener);
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', listener);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on('data', listener);
  });
}
async function main() {
  const [command, usernameArg] = process.argv.slice(2);
  if (command === 'bootstrap' || command === 'reset-password') {
    let username = usernameArg;
    if (!username) {
      const rl = createInterface({ input: stdin, output: stdout });
      username = await rl.question('Username: ');
      rl.close();
    }
    username = username.toLowerCase();
    assert(
      /^[a-z0-9_]{3,32}$/.test(username),
      400,
      'Use a 3–32 character username containing letters, numbers, and underscores.',
    );
    const password = await promptPassword();
    assert(
      password.length >= 10 && password.length <= 128,
      400,
      'Password must be 10–128 characters.',
    );
    const pass = await passwordHash(password);
    const result = await db.$transaction(async (tx) => {
      await lock(tx, 'bootstrap');
      let user;
      if (command === 'bootstrap') {
        assert(
          !(await tx.user.findFirst({ where: { isAdmin: true } })),
          409,
          'An administrator already exists. Bootstrap is single-use.',
        );
        user = await tx.user.create({
          data: { username, displayName: username, passwordHash: pass, isAdmin: true },
        });
      } else {
        user = await tx.user.findUnique({ where: { username } });
        assert(user, 404, 'Account not found.');
        await tx.user.update({ where: { id: user.id }, data: { passwordHash: pass } });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.accountToken.deleteMany({ where: { userId: user.id } });
      }
      await audit(
        tx,
        'operator',
        null,
        command === 'bootstrap' ? 'account.bootstrap' : 'account.reset',
        user.id,
      );
      return { user, codes: await recoveryCodes(tx, user.id) };
    });
    await instance();
    console.log(
      `${command === 'bootstrap' ? 'Administrator created' : 'Password reset'}: ${result.user.username}`,
    );
    console.log('Save these one-time recovery codes. They will not be shown again:');
    console.log(result.codes.join('\n'));
  } else if (command === 'invite') {
    const admin = await db.user.findFirst({ where: { isAdmin: true, suspended: false } });
    assert(admin, 400, 'Bootstrap an administrator first.');
    const invite = await createInvite(admin.id, null, 10, 168);
    console.log(`Invitation code (10 uses, 7 days): ${invite.code}`);
  } else if (command === 'promote' || command === 'demote') {
    assert(usernameArg, 400, 'Supply a username.');
    await db.$transaction(async (tx) => {
      await lock(tx, 'bootstrap');
      const user = await tx.user.findUnique({ where: { username: usernameArg.toLowerCase() } });
      assert(user, 404, 'Account not found.');
      if (command === 'demote' && user.isAdmin)
        assert(
          (await tx.user.count({ where: { isAdmin: true } })) > 1,
          400,
          'Cannot demote the last administrator.',
        );
      await tx.user.update({
        where: { id: user.id },
        data: {
          isAdmin: command === 'promote',
          ...(command === 'promote' ? { suspended: false } : {}),
        },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await audit(tx, 'operator', null, `account.${command}`, user.id);
    });
    console.log(`Account ${command === 'promote' ? 'promoted' : 'demoted'}: ${usernameArg}`);
  } else {
    console.log(
      'Usage: npm run admin -- bootstrap [username]\n       npm run admin -- reset-password [username]\n       npm run admin -- invite\n       npm run admin -- promote <username>\n       npm run admin -- demote <username>',
    );
    process.exitCode = 1;
  }
}
void main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
