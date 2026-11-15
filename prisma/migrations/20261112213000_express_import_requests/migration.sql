-- Requests carry no permission; ExpressImportGrant remains the authorization gate.
CREATE TABLE "ExpressImportRequest" (
  "agentId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "decision" TEXT NOT NULL DEFAULT 'pending',
  "response" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "reviewedByUserId" TEXT,
  CONSTRAINT "ExpressImportRequest_pkey" PRIMARY KEY ("agentId", "projectId"),
  CONSTRAINT "ExpressImportRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExpressImportRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ExpressImportRequest_projectId_decision_requestedAt_idx" ON "ExpressImportRequest"("projectId", "decision", "requestedAt");
