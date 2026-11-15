-- Pull request preview builds (#previews): one row per issue and commit Ziki
-- started the preview builder for. Additive only: a new table.

-- CreateTable
CREATE TABLE "PreviewBuild" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "pullNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "runId" TEXT,
    "runUrl" TEXT,
    "url" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PreviewBuild_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreviewBuild_bugId_headSha_key" ON "PreviewBuild"("bugId", "headSha");

-- CreateIndex
CREATE INDEX "PreviewBuild_status_updatedAt_idx" ON "PreviewBuild"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "PreviewBuild" ADD CONSTRAINT "PreviewBuild_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreviewBuild" ADD CONSTRAINT "PreviewBuild_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
