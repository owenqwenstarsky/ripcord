ALTER TABLE "User" ADD COLUMN "notifyMentions" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "notifyDms" BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE "MessageMention" (
  "messageId" TEXT NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX "MessageMention_userId_messageId_idx" ON "MessageMention"("userId", "messageId");
CREATE TABLE "NotificationPreference" (
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "scope" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "muted" BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY ("userId", "scope", "targetId")
);
-- Historical recipients are recorded without creating real-time events or alerts.
INSERT INTO "MessageMention" ("messageId", "userId")
SELECT DISTINCT m."id", u."id" FROM "Message" m
JOIN "Room" r ON r."id" = m."roomId"
JOIN "User" u ON u."id" <> m."authorId"
WHERE m."deletedAt" IS NULL AND (
  EXISTS (SELECT 1 FROM "Membership" x WHERE x."userId" = u."id" AND x."serverId" = r."serverId")
  OR EXISTS (SELECT 1 FROM "RoomMember" x WHERE x."userId" = u."id" AND x."roomId" = r."id")
) AND EXISTS (
  SELECT 1 FROM regexp_matches(COALESCE(m."content", ''), '(^|[^a-zA-Z0-9_@])@([a-zA-Z0-9_]+)', 'g') t
  WHERE lower(t[2]) IN (u."username", 'everyone', 'here')
);

CREATE TABLE "SendCancellation" ("authorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE, "roomId" TEXT NOT NULL REFERENCES "Room"("id") ON DELETE CASCADE, "nonce" TEXT NOT NULL, PRIMARY KEY ("authorId", "roomId", "nonce"));

ALTER TABLE "Event" ADD COLUMN "messageId" TEXT;
CREATE INDEX "Event_scope_targetId_id_idx" ON "Event"("scope", "targetId", "id");
