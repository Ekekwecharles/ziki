-- Pull request preview settings for a project's main repository (#previews).
-- Additive only: a new table, off by default, one row per project.

-- CreateTable
CREATE TABLE "ProjectPreviewSettings" (
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rootDir" TEXT NOT NULL DEFAULT '.',
    "installCommand" TEXT,
    "buildCommand" TEXT NOT NULL DEFAULT 'npm run build',
    "outputDir" TEXT NOT NULL DEFAULT 'dist',
    "nodeVersion" TEXT NOT NULL DEFAULT '22',
    "buildVariables" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectPreviewSettings_pkey" PRIMARY KEY ("projectId")
);

-- AddForeignKey
ALTER TABLE "ProjectPreviewSettings" ADD CONSTRAINT "ProjectPreviewSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
