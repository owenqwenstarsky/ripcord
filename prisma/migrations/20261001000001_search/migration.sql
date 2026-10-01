CREATE INDEX "Message_search_idx" ON "Message" USING GIN (to_tsvector('simple', COALESCE("content", ''))) WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Role_one_everyone" ON "Role" ("serverId") WHERE "everyone" = true;
ALTER TABLE "PermissionOverride" ADD CONSTRAINT "Override_one_scope" CHECK (("roomId" IS NULL) <> ("categoryId" IS NULL));
ALTER TABLE "PermissionOverride" ADD CONSTRAINT "Override_target_type" CHECK ("targetType" IN ('ROLE', 'MEMBER'));
ALTER TABLE "Room" ADD CONSTRAINT "Room_scope" CHECK (("kind" = 'TEXT' AND "serverId" IS NOT NULL) OR ("kind" <> 'TEXT' AND "serverId" IS NULL));
