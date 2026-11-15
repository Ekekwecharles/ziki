CREATE TABLE "ExpressImportGrant" (
    "agentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpressImportGrant_pkey" PRIMARY KEY ("agentId", "projectId")
);

CREATE TABLE "OutsideWorkImport" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "pullRequestKey" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "initialState" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutsideWorkImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExpressImportGrant_projectId_idx" ON "ExpressImportGrant"("projectId");
CREATE UNIQUE INDEX "OutsideWorkImport_bugId_key" ON "OutsideWorkImport"("bugId");
CREATE UNIQUE INDEX "OutsideWorkImport_projectId_pullRequestKey_key" ON "OutsideWorkImport"("projectId", "pullRequestKey");
CREATE UNIQUE INDEX "OutsideWorkImport_agentId_projectId_requestKey_key" ON "OutsideWorkImport"("agentId", "projectId", "requestKey");

ALTER TABLE "ExpressImportGrant" ADD CONSTRAINT "ExpressImportGrant_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpressImportGrant" ADD CONSTRAINT "ExpressImportGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExpressImportGrant" ADD CONSTRAINT "ExpressImportGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutsideWorkImport" ADD CONSTRAINT "OutsideWorkImport_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutsideWorkImport" ADD CONSTRAINT "OutsideWorkImport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutsideWorkImport" ADD CONSTRAINT "OutsideWorkImport_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
