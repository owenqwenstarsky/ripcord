# RipCord

A self-hosted community chat app built with Next.js, TypeScript, Prisma, PostgreSQL, and Socket.IO. One independent instance can host multiple Discord-style servers and private conversations. AGPL-3.0-only.

## Included

- Local accounts, secure revocable sessions, invitation-based registration, optional public registration, recovery codes, and optional verified email recovery.
- Servers, categories, text channels, multiple roles, hierarchy, category synchronization, and role/member permission overrides.
- One-to-one and group DMs, friends, blocking, Markdown, mentions, replies, edits, deletion, reactions, uploads, full-text search, unread positions, typing, and online presence.
- Kicks, bans, timeouts, slow mode, message moderation, reports, audit logs, and instance account suspension.
- Dark/light themes, responsive navigation, keyboard-accessible dialogs, and browser mention notifications while the page is running.
- Docker Compose, PostgreSQL migrations, operator commands, health checks, durable event dispatch, rate limits, and local upload storage.

This is an initial release implementation. Voice/video, screen sharing, threads, custom emoji, bots, webhooks, federation, native apps, background push, and two-factor authentication are intentionally deferred. Messages are not end-to-end encrypted: database operators can access them. Instance administration does not bypass server permissions or expose general DM browsing.

## Local development

Requirements: Node.js 22.22+ and PostgreSQL 17. PostgreSQL must already be running.

```sh
npm ci
cp .env.example .env
# Set DATABASE_URL to a database owned by your development PostgreSQL user.
createdb ripcord
npm run db:migrate
npm run admin -- bootstrap
npm run dev
```

Open `http://localhost:3000` (or the port configured in `.env`). `APP_URL` must match the browser origin exactly, including scheme and port. There are no preconfigured production passwords. Bootstrap prompts for a username and a password without echoing it. Save the generated recovery codes.

To populate **an empty local development database** with example conversations:

```sh
# Run instead of bootstrap; never use this against a production database.
DEMO_PASSWORD='choose-a-development-password' npm run seed:demo
```

Sign in as `demo` with that password. The script also creates `june`, `sam`, `leo`, `maya`, and `eli` using the same development password. It refuses remote databases, production mode, and databases containing accounts.

## Docker deployment

Copy `.env.example` to `.env`. Set `POSTGRES_PASSWORD` to a long random **hexadecimal** password (for example, generate it with `openssl rand -hex 32`), and set `APP_URL=https://chat.example.com`. Compose builds its database URL from `POSTGRES_PASSWORD`; the standalone `DATABASE_URL` is for non-Docker development. `HOST_PORT` defaults to 3000.

```sh
docker compose up -d --build
docker compose exec -it app npm run admin -- bootstrap
```

The app binds to `127.0.0.1:3000` on the host. Put a TLS reverse proxy in front of it with WebSocket support and an upload body limit of at least 26 MB (or your configured upload limit plus 1 MB). For example, Caddy on the host:

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

When Caddy runs in the same Docker network, proxy to `app:3000` instead. Both HTTP and Socket.IO must reach the same app process. `APP_URL` controls origin validation and Secure cookies. Production refuses plain HTTP unless `ALLOW_INSECURE_HTTP=1` is explicitly set for **local testing**.

`TRUST_PROXY=1` enables IP-based authentication throttling using the first forwarded address. Enable it only when the app can be reached exclusively through a trusted reverse proxy that overwrites incoming `X-Forwarded-For`. Otherwise authentication requests share the direct connection's IP bucket.

Optional SMTP configuration:

```dotenv
SMTP_URL=smtp://username:password@mail.example.com:587
SMTP_FROM=RipCord <noreply@example.com>
```

Recovery codes and the emergency CLI work without SMTP. Users verify a recovery address in Account settings → Security before email reset links are available. Token links expire after one hour and are single-use.

## Operator commands

```sh
npm run admin -- bootstrap [username]       # single-use first administrator
npm run admin -- invite                     # instance invite, 10 uses / 7 days
npm run admin -- reset-password [username]  # revokes sessions and old recovery codes
npm run admin -- promote <username>         # also revokes sessions
npm run admin -- demote <username>          # refuses to demote the last administrator
```

Inside Docker, prefix these commands with `docker compose exec -it app`. Automated operation can provide `RIPCORD_ADMIN_PASSWORD` as an environment variable instead of an interactive password; do not put passwords in command arguments or source control. Administrator creation/changes are deliberately host-controlled.

Instance settings configure registration, file size, attachment count, message length, and a total upload quota. Defaults: 25 MB/file, five attachments/message, 2,000 characters/message, 10 GB upload quota, invite-only registration. Group DMs allow ten members.

## Architecture

The custom Node server serves Next.js and Socket.IO in one process. HTTP mutations and real-time subscriptions use the same server-side permission services. Channel and DM storage share a conversation model.

Messages and invalidation events commit atomically. A PostgreSQL-backed outbox dispatcher publishes event IDs, not message contents. Clients deduplicate those events, fetch authorized history, periodically reconcile, and reload history on reconnect. Send nonces prevent duplicate messages on retries. Read positions are monotonic and backed by PostgreSQL.

Permissions resolve in Discord order: combined base roles → everyone override → aggregated role overrides (allows win within that stage) → member override. Server owners and server Administrator roles bypass channel overrides. Role hierarchy constrains role changes and moderation. A synchronized channel uses its category overrides; making it independent copies those overrides, and deleting a category preserves effective channel permissions.

Uploads are randomized files outside the public directory. Every download is authorized. Only recognized raster image signatures render inline; other files download with sandbox/nosniff headers. Message deletion removes its body, detaches uploads, removes reactions, and leaves a reply tombstone. The background job collects unreferenced uploads after 24 hours while preserving avatars. Reports contain references and reporter explanations, not copies of message bodies; deleted reported messages become unavailable. Audit logs exclude message bodies.

Run **one app replica**. Multiple replicas need shared upload storage and a distributed Socket.IO adapter/dispatcher, which this release does not provide. PostgreSQL and local volumes are required; this app is not intended for serverless hosting. Dependency versions and the npm lockfile are pinned. See [API.md](docs/API.md) for the HTTP/socket interfaces.

## Checks

```sh
npm run typecheck
npm test
npm run test:integration
npm run build
npm audit
```

Integration tests create and migrate a randomly named **isolated PostgreSQL schema** in `DATABASE_URL`, then remove it and their temporary upload directory. The database role needs schema-creation permission. They cover permission leaks, hierarchy, category synchronization, concurrent invite use and message retries, pagination, recovery-code reuse, blocking, moderation, sessions, search, and upload authorization. They do not delete application data.

For real-time load testing, run an instance using the same database URL and app URL as the shell, then:

```sh
npm run test:load
```

The load script creates isolated fixture accounts and a private test server, checks 100 authenticated socket connections, mutation delivery, reconnect recovery, permission revocation, and session revocation, then removes its fixtures. Run on a development/staging instance, not production. It reports connection/delivery timings; these are evidence for the tested machine, not a universal throughput guarantee.

## Backup, restore, and upgrades

Back up **both** PostgreSQL and the upload volume. Pause the app, including its upload cleanup job, during capture so both copies represent the same state:

```sh
mkdir -p backups
docker compose stop app
docker compose exec -T db pg_dump -U ripcord -d ripcord -Fc > backups/ripcord.dump
docker compose run --rm --no-deps --entrypoint tar app -C /app/uploads -czf - . > backups/uploads.tar.gz
docker compose start app
```

Restore into an empty database and upload volume using the same application version:

```sh
docker compose stop app
docker compose exec -T db pg_restore -U ripcord -d ripcord --clean --if-exists < backups/ripcord.dump
docker compose run --rm -T --no-deps --entrypoint tar app -C /app/uploads -xzf - < backups/uploads.tar.gz
docker compose start app
```

Restore uploads into an empty volume to avoid leftover files. Keep backup files private: they contain account hashes and message contents. Test restoration before relying on a backup. For upgrades, take this backup first, inspect migration changes, and run `docker compose up -d --build`; startup runs `prisma migrate deploy`. Do not use `prisma db push` or `migrate reset` on production.

`GET /api/health` checks PostgreSQL connectivity. Logs are structured JSON for startup, failed requests, event dispatch, and maintenance. Monitor container health, disk space, database backups, and outbox errors. Preserve the upload volume when replacing containers.

## License

AGPL-3.0-only. See [LICENSE](LICENSE). Modified versions offered over a network must meet the AGPL's corresponding-source requirements. Set your deployment's source-code location when distributing or operating a modified version.
