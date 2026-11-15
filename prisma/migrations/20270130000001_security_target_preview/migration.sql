-- The quick scan's counts, saved on the asset when the client adds it (#security-checks).
ALTER TABLE "SecurityTarget" ADD COLUMN "previewSummary" JSONB;
ALTER TABLE "SecurityTarget" ADD COLUMN "previewAt" TIMESTAMP(3);
