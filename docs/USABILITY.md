# Conversation and management behavior

The October 2026 usability migration is additive. Run `npm run db:migrate` before starting the updated application; the normal build regenerates Prisma Client. It adds persisted exact mention recipients, account notification defaults, scoped mute preferences, send cancellation tombstones, and message identities on notification events. Historical mention backfill emits no events or alerts. The deployment remains a single custom-server instance with PostgreSQL and the existing upload volume.

## Saved work and sends

Drafts, reply targets, staged attachment metadata, and failed or ambiguous sends are stored in this browser by account and conversation for seven days. Explicit sign-out clears that account's work. Session expiration hides it until the same account signs in. Expired work from dormant accounts is pruned when saved work is loaded. Browser storage failures are reported; browser data clearing removes these local saves.

Uploads complete into their original conversation. Staged uploads still expire after 24 hours; unavailable files are labeled for reattachment. Saved sends never retry automatically on reload. A retry retains its original nonce. An acknowledgement clears the pending send even if history refresh fails or the sender cannot read history. Editing or discarding first reconciles with the server; an atomic nonce cancellation prevents a delayed original request from committing afterward.

## Navigation and catching up

Conversation and message URLs support copied links and browser back/forward. Each account remembers its conversation and the last channel of each community. Direct conversations restore their own sidebar and search context. Cmd/Ctrl+K opens the keyboard quick switcher; message search remains separate. Search results and replies load message context and highlight the destination. Earlier history preserves the visible message; jump-to-latest restores live reading.

Unread opens at the first unread message. Reads advance only as messages are reached in the visible, focused timeline, including scroll, focus, and visibility events. Historical targets suppress automatic read advancement until the reader interacts with the timeline. Mentions use exact, case-insensitive username tokens and persist recipients on send and edit. Direct conversations sort by activity.

Account mention/DM preferences default to enabled. Browser permission is opt-in and device-specific; notifications require the app to remain open. Community and conversation mutes suppress alerts while retaining unread information. Blocked content is collapsed and its alerts suppressed. Live alerts are deduplicated by message identity, paginated by event cursor, and suppressed during initial/reconnect reconciliation.

## Communities and groups

Category moves and deletion preserve a channel's effective overrides and leave it unsynchronized. Explicit synchronization adopts destination-category overrides. Role managers can inspect overrides independently of channel-management permission. Management actions still enforce permissions and hierarchy on the server; unavailable controls explain their restrictions.

Invitation codes and full links can be previewed before joining. Intent survives authentication and recovery-code acknowledgement, remains on failed acceptance, and clears on successful acceptance or cancellation. Joining selects the first accessible channel. Friendship searches show relationship states, loading, empty, and failure states.

Group invitation eligibility is checked when participants enter. Existing membership authorizes messages, edits, reactions, and typing after relationship changes. Direct conversations retain their privacy checks. Group removal revokes access immediately; ownership transfer requires an existing, active member.

Settings guard duplicate submissions, show action feedback, preserve dirty forms through refresh, and confirm abandonment. Ordering supports accessible move-up/down buttons. Management lists use 100-row pages, resolve readable identities, and filter reports for authorization before pagination. Community moderators can open reported content and take permitted actions before resolving it; instance DM report review remains limited to the reported message.

## Verification

Automated checks cover category moves, role hierarchy, drafts/account transitions, delayed uploads, ambiguous sends and cancellation races, send-only channels, navigation, context pagination, read tracking, notification reconciliation, invitation recovery, settings revocation/dirty forms, group ownership/removal, and bounded workspace query growth.

The shared browser exercised registration and recovery acknowledgement, saved DM restoration, drafts across channels, keyboard switching, old search/reply targets and links, Unread/Mentions, group creation/removal/transfer, and report timeout/resolution/opening. At measured phone widths of 427 and 513 CSS pixels, navigation/member overlays dismissed, reply and reaction actions worked, group management was reachable, and there was no horizontal overflow. Earlier-history anchoring moved the visible message by zero pixels. Opening an old target retained all three newer unread messages and the existing read position.

Native browser-alert delivery was not exercised on the non-secure HTTP fixture. Notification behavior is verified with mocked browser notifications; deployed HTTPS/browser permissions remain necessary. Fixtures used an isolated disposable database schema and upload directory.
