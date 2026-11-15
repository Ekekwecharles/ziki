CREATE TYPE "MarketingPlanActivityDecisionValue" AS ENUM ('approved', 'rejected');

ALTER TABLE "MarketingPlanRevision"
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedById" TEXT;

CREATE TABLE "MarketingPlanActivityDecision" (
  "id" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "decision" "MarketingPlanActivityDecisionValue" NOT NULL,
  "decidedById" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingPlanActivityDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingPlanActivityDecisionEvent" (
  "id" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "decision" "MarketingPlanActivityDecisionValue" NOT NULL,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingPlanActivityDecisionEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketingPlanActivityDecision_revisionId_activityId_key"
  ON "MarketingPlanActivityDecision"("revisionId", "activityId");
CREATE INDEX "MarketingPlanActivityDecision_revisionId_decision_idx"
  ON "MarketingPlanActivityDecision"("revisionId", "decision");
CREATE INDEX "MarketingPlanActivityDecisionEvent_decisionId_createdAt_idx"
  ON "MarketingPlanActivityDecisionEvent"("decisionId", "createdAt");

ALTER TABLE "MarketingPlanRevision"
  ADD CONSTRAINT "MarketingPlanRevision_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingPlanActivityDecision"
  ADD CONSTRAINT "MarketingPlanActivityDecision_revisionId_fkey"
  FOREIGN KEY ("revisionId") REFERENCES "MarketingPlanRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MarketingPlanActivityDecision_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "MarketingPlanActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MarketingPlanActivityDecision_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingPlanActivityDecisionEvent"
  ADD CONSTRAINT "MarketingPlanActivityDecisionEvent_decisionId_fkey"
  FOREIGN KEY ("decisionId") REFERENCES "MarketingPlanActivityDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MarketingPlanActivityDecisionEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
