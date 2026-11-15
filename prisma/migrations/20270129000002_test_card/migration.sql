-- CreateEnum
CREATE TYPE "TestRowSource" AS ENUM ('criteria', 'beyond', 'suggested');

-- CreateEnum
CREATE TYPE "TestRowKind" AS ENUM ('limits', 'bad_input', 'failure', 'mid_change', 'reload', 'two_at_once', 'permissions', 'still_works', 'devices');

-- CreateEnum
CREATE TYPE "TestRowProof" AS ENUM ('screen', 'test', 'log');

-- CreateEnum
CREATE TYPE "TestRowRoute" AS ENUM ('ci', 'env');

-- CreateTable
CREATE TABLE "TestCardRow" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "agentId" TEXT,
    "text" VARCHAR(200) NOT NULL,
    "why" VARCHAR(300),
    "source" "TestRowSource" NOT NULL,
    "kind" "TestRowKind",
    "proof" "TestRowProof" NOT NULL DEFAULT 'screen',
    "envs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "needsTwo" BOOLEAN NOT NULL DEFAULT false,
    "route" "TestRowRoute",
    "routedAt" TIMESTAMP(3),
    "proofAttachmentId" TEXT,
    "decision" VARCHAR(20),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestCardRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestCardRow_bugId_idx" ON "TestCardRow"("bugId");

-- CreateIndex
CREATE INDEX "TestCardRow_route_routedAt_idx" ON "TestCardRow"("route", "routedAt");

-- AddForeignKey
ALTER TABLE "TestCardRow" ADD CONSTRAINT "TestCardRow_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCardRow" ADD CONSTRAINT "TestCardRow_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
