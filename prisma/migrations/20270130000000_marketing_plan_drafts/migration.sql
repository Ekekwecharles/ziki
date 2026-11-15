CREATE TYPE "MarketingPlanRevisionStatus" AS ENUM ('draft', 'approved');

CREATE TABLE "MarketingPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "currentRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketingPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingPlanRevision" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "MarketingPlanRevisionStatus" NOT NULL DEFAULT 'draft',
    "sourceContextId" VARCHAR(191) NOT NULL,
    "sourceContextRevision" VARCHAR(191) NOT NULL,
    "strategy" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketingPlanRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingPlanActivity" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketingPlanActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingPlanActivityRevision" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    CONSTRAINT "MarketingPlanActivityRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketingPlanRevision_planId_revision_key" ON "MarketingPlanRevision"("planId", "revision");
CREATE UNIQUE INDEX "MarketingPlanActivityRevision_revisionId_activityId_key" ON "MarketingPlanActivityRevision"("revisionId", "activityId");
CREATE INDEX "MarketingPlan_projectId_updatedAt_idx" ON "MarketingPlan"("projectId", "updatedAt");
CREATE INDEX "MarketingPlan_creatorId_updatedAt_idx" ON "MarketingPlan"("creatorId", "updatedAt");
CREATE INDEX "MarketingPlanRevision_planId_status_revision_idx" ON "MarketingPlanRevision"("planId", "status", "revision");
CREATE INDEX "MarketingPlanActivity_planId_idx" ON "MarketingPlanActivity"("planId");
CREATE INDEX "MarketingPlanActivityRevision_revisionId_position_idx" ON "MarketingPlanActivityRevision"("revisionId", "position");
CREATE INDEX "MarketingPlanActivityRevision_activityId_idx" ON "MarketingPlanActivityRevision"("activityId");

ALTER TABLE "MarketingPlan" ADD CONSTRAINT "MarketingPlan_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingPlan" ADD CONSTRAINT "MarketingPlan_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingPlanRevision" ADD CONSTRAINT "MarketingPlanRevision_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "MarketingPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingPlanRevision" ADD CONSTRAINT "MarketingPlanRevision_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingPlanActivity" ADD CONSTRAINT "MarketingPlanActivity_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "MarketingPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingPlanActivityRevision" ADD CONSTRAINT "MarketingPlanActivityRevision_revisionId_fkey"
  FOREIGN KEY ("revisionId") REFERENCES "MarketingPlanRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingPlanActivityRevision" ADD CONSTRAINT "MarketingPlanActivityRevision_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "MarketingPlanActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
