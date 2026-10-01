# Implementation validation

Checked October 1, 2026 on this workspace with Node 22.22.3, local PostgreSQL 17.10, and the Docker runtime image.

- TypeScript, including unused import/parameter checks: passed.
- Unit tests: 11 passed.
- PostgreSQL integration tests: 20 passed, using an isolated schema and temporary upload directory.
- Dependency audit: no reported vulnerabilities, including production dependencies.
- Production Next.js/custom-server build and Docker image build: passed.
- 100 authenticated socket connections: subscribed and received committed events; repeated sends created one message. Batched presence removed the initial subscription bottleneck. One measured local run had delivery p95 of 35 ms; timings depend on the machine and workload.
- Live channel-access revocation blocked the existing subscription and HTTP history. Session revocation disconnected an active socket. Reconnect recovered missed history.
- Fresh Docker database migration and administrator bootstrap: passed.
- Docker invitation registration, protected attachment upload, and send retry: passed.
- Docker app restart preserved messages, sessions, and uploaded files.
- Backup of PostgreSQL and the upload volume, followed by deletion/restoration of the isolated verification stack's data, recovered the message and its attachment.
- Shared-browser desktop checks: sign-in, sending, message persistence, full-text search, account settings, role permission controls, category/channel override controls, dialog focus, and light/dark switching passed. A desktop screenshot was captured and inspected.

Phone layouts are implemented with responsive CSS, but phone-sized browser verification could not be completed because the shared preview's resize operation repeatedly timed out. SMTP token behavior is covered by integration tests; delivery through a real configured SMTP service was not exercised.

Reproduce server checks with `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run test:load`, `npm run build`, and `npm audit`. See the README for Docker installation and backup/restore commands. The load test requires a running local instance matching the shell's database URL and APP_URL and cleans up its own fixtures.
