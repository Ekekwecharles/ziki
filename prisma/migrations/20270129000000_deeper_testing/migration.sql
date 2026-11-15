-- AlterTable
ALTER TABLE "TestVerdict" ADD COLUMN     "proof" JSONB;

-- CreateTable
CREATE TABLE "ProofRule" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "projectId" TEXT,
    "issueTypeId" TEXT,
    "projectAreaId" TEXT,
    "checks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProofRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofCheck" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "instructions" VARCHAR(1000) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProofCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProofRule_organisationId_idx" ON "ProofRule"("organisationId");

-- CreateIndex
CREATE INDEX "ProofCheck_organisationId_idx" ON "ProofCheck"("organisationId");

-- AddForeignKey
ALTER TABLE "ProofRule" ADD CONSTRAINT "ProofRule_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofRule" ADD CONSTRAINT "ProofRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofRule" ADD CONSTRAINT "ProofRule_issueTypeId_fkey" FOREIGN KEY ("issueTypeId") REFERENCES "IssueType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofRule" ADD CONSTRAINT "ProofRule_projectAreaId_fkey" FOREIGN KEY ("projectAreaId") REFERENCES "ProjectArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofCheck" ADD CONSTRAINT "ProofCheck_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
