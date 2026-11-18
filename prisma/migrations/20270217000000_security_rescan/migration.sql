-- CreateEnum
CREATE TYPE "SecurityRecheckState" AS ENUM ('still_there', 'fixed');

-- AlterTable
ALTER TABLE "SecurityCheck" ADD COLUMN     "previousCheckId" TEXT;

-- AlterTable
ALTER TABLE "SecurityCheckResult" ADD COLUMN     "recheckCheckId" TEXT,
ADD COLUMN     "recheckItemId" TEXT,
ADD COLUMN     "recheckNote" TEXT,
ADD COLUMN     "recheckState" "SecurityRecheckState",
ADD COLUMN     "recheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "SecurityCheck_previousCheckId_key" ON "SecurityCheck"("previousCheckId");

-- CreateIndex
CREATE INDEX "SecurityCheckResult_recheckCheckId_idx" ON "SecurityCheckResult"("recheckCheckId");

-- CreateIndex
CREATE INDEX "SecurityCheckResult_recheckItemId_idx" ON "SecurityCheckResult"("recheckItemId");

-- AddForeignKey
ALTER TABLE "SecurityCheck" ADD CONSTRAINT "SecurityCheck_previousCheckId_fkey" FOREIGN KEY ("previousCheckId") REFERENCES "SecurityCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityCheckResult" ADD CONSTRAINT "SecurityCheckResult_recheckCheckId_fkey" FOREIGN KEY ("recheckCheckId") REFERENCES "SecurityCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityCheckResult" ADD CONSTRAINT "SecurityCheckResult_recheckItemId_fkey" FOREIGN KEY ("recheckItemId") REFERENCES "SecurityCheckItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

