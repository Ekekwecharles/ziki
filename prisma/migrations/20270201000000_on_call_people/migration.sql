-- On call is a person, not an agent (#on-call, 14 Nov plan H0b).
-- Moves Agent.onCallAt / Agent.securityClearedAt to the owner (User), and invites from an
-- agent to an email. Nothing is deleted before it is copied; no row cascades from what is dropped.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "onCallAt" TIMESTAMP(3),
ADD COLUMN "securityClearedAt" TIMESTAMP(3);

-- A person is on call, and cleared, from the earliest of their agents'.
UPDATE "User" u SET "onCallAt" = a.first_at
FROM (SELECT "ownerUserId", MIN("onCallAt") AS first_at FROM "Agent" WHERE "onCallAt" IS NOT NULL GROUP BY "ownerUserId") a
WHERE u."id" = a."ownerUserId";
UPDATE "User" u SET "securityClearedAt" = a.first_at
FROM (SELECT "ownerUserId", MIN("securityClearedAt") AS first_at FROM "Agent" WHERE "securityClearedAt" IS NOT NULL GROUP BY "ownerUserId") a
WHERE u."id" = a."ownerUserId";

-- Invites: the agent's owner's email.
ALTER TABLE "OnCallInvite" ADD COLUMN "email" TEXT;
UPDATE "OnCallInvite" i SET "email" = LOWER(u."email")
FROM "Agent" a JOIN "User" u ON u."id" = a."ownerUserId"
WHERE i."agentId" = a."id";
ALTER TABLE "OnCallInvite" ALTER COLUMN "email" SET NOT NULL;

-- One pending invite per person: keep the newest, withdraw the rest.
UPDATE "OnCallInvite" i SET "status" = 'cancelled', "respondedAt" = NOW()
WHERE i."status" = 'pending' AND EXISTS (
  SELECT 1 FROM "OnCallInvite" j
  WHERE j."email" = i."email" AND j."status" = 'pending'
    AND (j."createdAt" > i."createdAt" OR (j."createdAt" = i."createdAt" AND j."id" > i."id"))
);

-- DropForeignKey
ALTER TABLE "OnCallInvite" DROP CONSTRAINT "OnCallInvite_agentId_fkey";
-- DropIndex
DROP INDEX "OnCallInvite_agentId_status_idx";
-- AlterTable
ALTER TABLE "OnCallInvite" DROP COLUMN "agentId";
-- CreateIndex
CREATE INDEX "OnCallInvite_email_status_idx" ON "OnCallInvite"("email", "status");

-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "onCallAt",
DROP COLUMN "securityClearedAt";
