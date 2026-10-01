# RipCord interfaces

All endpoints are under `/api`. JSON responses serialize BigInt IDs, message sequences, permission masks, and storage quotas as decimal strings. Error responses have `{ "error": "message" }` and an appropriate HTTP status. Responses are private/no-store. Mutations require an `Origin` header equal to `APP_URL` and the `ripcord_session` cookie, except authentication/registration/recovery requests which do not require a session. Upload uses multipart FormData with one `file`.

| Interface                                                         | Purpose                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /public`, `GET /health`                                      | Instance registration/bootstrap information; database health                                     |
| `POST /auth/login`, `/register`, `/logout`                        | Local authentication and session cookies; registration returns recovery codes once               |
| `POST /auth/recover`, `/forgot`, `/reset`, `/verify`              | Recovery code, verified-email reset, reset/verification token consumption                        |
| `GET /workspace`                                                  | Current profile, accessible servers/channels/DMs, unread counts, mentions, relationships, limits |
| `PATCH /me`                                                       | Display name, avatar, friends-only DM preference                                                 |
| `POST /me/password`, `/me/recovery`, `/me/email`                  | Password change, recovery-code rotation, email verification; require current password            |
| `GET /me/sessions`, `DELETE /me/sessions`                         | Session listing; revoke all sessions                                                             |
| `GET /users?q=prefix`                                             | Username lookup within the instance, at least two characters                                     |
| `POST /relationships`                                             | `{ userId, action: request / accept / remove / block / unblock }`                                |
| `POST /servers`, `GET/PATCH/DELETE /servers/:id`                  | Create/manage a community; deletion requires ownership                                           |
| `POST /servers/:id/leave`                                         | Leave after ownership is transferred if applicable                                               |
| `POST /servers/:id/categories`, `PATCH/DELETE .../categories/:id` | Ordered categories                                                                               |
| `POST /servers/:id/channels`, `PATCH/DELETE .../channels/:id`     | Ordered text channels, topics, synchronization, slow mode, optional private-role creation        |
| `POST /servers/:id/roles`, `PATCH/DELETE .../roles/:id`           | Roles, colors, hierarchy positions, decimal permission masks                                     |
| `PUT/DELETE /servers/:id/overrides`                               | `{ scope: room / category, id, targetType: ROLE / MEMBER, targetId, allow, deny }`               |
| `PUT /servers/:id/members/:userId/roles`                          | `{ roleIds: [...] }`, subject to hierarchy                                                       |
| `POST /servers/:id/members/:userId`                               | `{ action: kick / ban / timeout / nickname, reason?, seconds?, nickname? }`                      |
| `GET/POST /servers/:id/invites`, `DELETE .../invites/:code`       | List/create/revoke invitations; `{ maxUses?, expiresHours? }`, null means unlimited              |
| `GET/POST /invites/:code`                                         | Public invitation summary; authenticated acceptance                                              |
| `GET /servers/:id/bans`, `DELETE .../bans/:userId`                | Ban listing and revocation                                                                       |
| `GET /servers/:id/audit`                                          | Server administrative audit log                                                                  |
| `POST /dms`                                                       | `{ userIds: [...], name? }`; two members reuse a direct conversation, more create a group        |
| `PATCH /rooms/:id`                                                | Group owner updates name or transfers ownership                                                  |
| `POST /rooms/:id/members`, `DELETE .../members/:userId`           | Group owner adds/removes members; members can leave; ownership passes on owner departure         |
| `GET /rooms/:id/messages?before=seq` or `?after=seq`              | Fifty-message cursor pages; `after` supports reconnect recovery                                  |
| `POST /rooms/:id/messages`                                        | `{ content, nonce, replyId?, attachmentIds? }`; nonce is unique per author/conversation          |
| `POST /rooms/:id/read`                                            | `{ seq }`; existing message in this conversation; advances monotonically                         |
| `PATCH/DELETE /messages/:id`                                      | Author edit; author or authorized moderator deletion                                             |
| `POST /messages/:id/reactions`                                    | `{ emoji }`; toggles a Unicode emoji reaction                                                    |
| `GET /search?q=words&serverId=id` or `&roomId=id`                 | PostgreSQL full-text search over authorized history; optional scope                              |
| `POST /uploads`, `GET /uploads/:id`                               | Stage an upload; authorized file retrieval                                                       |
| `POST /reports`                                                   | `{ messageId, reason }`; requires access to the reported message                                 |
| `GET /reports?serverId=id`, `PATCH /reports/:id?serverId=id`      | Moderator review/resolve; omission of serverId means admin-only reported DMs                     |
| `GET/PATCH /admin/settings`                                       | Instance registration and limits                                                                 |
| `GET /admin/users`, `PATCH /admin/users/:id`                      | List/suspend/restore accounts; administrators remain CLI-controlled                              |
| `GET/POST /admin/invites`, `DELETE .../invites/:code`             | Instance invitations                                                                             |
| `GET /admin/audit`, `GET /admin/storage`                          | Instance audit and upload usage                                                                  |

## Socket.IO

The socket handshake uses the same session cookie and requires an allowed origin. Sessions and room access are revalidated during dispatch; revoked sessions disconnect. Limit: eight sockets per account.

- Client `subscribe(roomId, ack)` selects one currently viewed conversation; successful acknowledgement is `{ ok: true }`.
- Client `unsubscribe` clears the viewed conversation.
- Client `typing` sends rate-limited ephemeral typing activity in the subscribed conversation.
- Server `invalidate` sends `{ id, type, roomId? }`. Deduplicate `id`, invalidate the workspace and affected query, and fetch current authorized data. No message body is broadcast.
- Server `presence` sends `{ roomId, users }` for online members of the subscribed conversation's community/group.
- Server `typing` sends `{ roomId, user }`; clients expire it after five seconds.
- Server `access.revoked` sends `{ roomId }`; immediately remove cached conversation data and refresh navigation.
- Server `account.revoked` signals session loss before disconnect.

Clients must reconcile after reconnect and periodically; sockets are notifications, while PostgreSQL history is authoritative. Permission bits are defined in `src/lib/permissions.ts`. There are no public/federated API credentials, bots, or external webhook interfaces in this release.

## Usability additions

- `GET /rooms/:id/messages?around=messageId` returns target context with `messages`, `hasMore`, `hasNewer`, `olderCursor`, and `newerCursor`. Existing `before`/`after` pagination is unchanged.
- `GET /rooms/:id/send-status/:nonce` returns author-scoped `{ status: sent | not-found | cancelled, message }` without requiring history permission. `DELETE` atomically reconciles or cancels the nonce and returns `sent` or `cancelled`.
- `POST /uploads/staged` with `{ ids }` returns `{ available }` for the account's uncommitted uploads within their 24-hour lifetime.
- Room summaries add `readSeq`, `firstUnreadId`, `latestSeq`, `latestEvent`, `lastActivityAt`, and `muted`. Community summaries include `muted`.
- `GET /mentions?before=seq` returns `{ messages, nextCursor }` in pages of 50.
- `GET /notifications?afterEvent=id&untilEvent=id` returns `{ messages, nextCursor, hasMore }` in event pages of 100. Events include edits adding mentions. The legacy `after=seq` lookup continues to return an array. Clients must baseline initial/reconnect state and deduplicate message identities.
- `PATCH /me` accepts `notifyMentions` and `notifyDms`. `PUT /preferences` accepts `{ scope: server | room, targetId, muted }`.
- Invitation previews and acceptance include `kind`, `serverId`, `serverName`, and community identity; acceptance includes accessible rooms for navigation.
- Invitation, ban, audit, report, and admin-account lists accept zero-based `page`; existing array responses have up to 100 rows. A full page allows another fetch. Report authorization is applied before pagination.
- Socket invalidation may include `serverId` as well as `roomId`; clients can invalidate affected community detail separately.

See [conversation and management behavior](USABILITY.md) for persistence, defaults, and user-visible flows.
