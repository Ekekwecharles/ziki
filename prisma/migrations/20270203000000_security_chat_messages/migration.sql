-- One saved chat per site per person on Security (#security-checks).
CREATE TABLE "SecurityChatMessage" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecurityChatMessage_targetId_userId_createdAt_idx" ON "SecurityChatMessage"("targetId", "userId", "createdAt");

ALTER TABLE "SecurityChatMessage" ADD CONSTRAINT "SecurityChatMessage_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "SecurityTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
