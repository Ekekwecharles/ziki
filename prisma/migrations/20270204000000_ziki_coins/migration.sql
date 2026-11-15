-- Ziki Coins (#ziki-coins): the Ziks ledger, Stripe purchases and withdrawals.

-- CreateEnum
CREATE TYPE "CoinAccount" AS ENUM ('wallet', 'escrow', 'revenue');

-- CreateEnum
CREATE TYPE "CoinKind" AS ENUM ('purchase', 'fund_issue', 'release', 'fee', 'refund', 'withdrawal', 'withdrawal_reversal', 'check_payment');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('pending', 'paid', 'failed');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "stripeAccountId" TEXT,
ADD COLUMN "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CoinEntry" (
    "id" TEXT NOT NULL,
    "account" "CoinAccount" NOT NULL,
    "userId" TEXT,
    "bugId" TEXT,
    "kind" "CoinKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "purchaseId" TEXT,
    "withdrawalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CoinEntry_amount_nonzero" CHECK ("amount" <> 0),
    CONSTRAINT "CoinEntry_account_owner" CHECK (
      ("account" = 'wallet' AND "userId" IS NOT NULL)
      OR ("account" = 'escrow' AND "bugId" IS NOT NULL)
      OR ("account" = 'revenue')
    )
);

-- CreateTable
CREATE TABLE "CoinPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "packId" TEXT NOT NULL,
    "zik" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "stripeFeeCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "zik" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "stripeTransferId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeAccountId_key" ON "User"("stripeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinEntry_sourceKey_key" ON "CoinEntry"("sourceKey");

-- CreateIndex
CREATE INDEX "CoinEntry_account_userId_idx" ON "CoinEntry"("account", "userId");

-- CreateIndex
CREATE INDEX "CoinEntry_account_bugId_idx" ON "CoinEntry"("account", "bugId");

-- CreateIndex
CREATE INDEX "CoinEntry_kind_idx" ON "CoinEntry"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "CoinPurchase_stripeSessionId_key" ON "CoinPurchase"("stripeSessionId");

-- CreateIndex
CREATE INDEX "CoinPurchase_userId_idx" ON "CoinPurchase"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_idempotencyKey_key" ON "Withdrawal"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_stripeTransferId_key" ON "Withdrawal"("stripeTransferId");

-- CreateIndex
CREATE INDEX "Withdrawal_userId_idx" ON "Withdrawal"("userId");

-- CreateIndex
CREATE INDEX "Withdrawal_status_idx" ON "Withdrawal"("status");

-- AddForeignKey
ALTER TABLE "CoinEntry" ADD CONSTRAINT "CoinEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinEntry" ADD CONSTRAINT "CoinEntry_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinPurchase" ADD CONSTRAINT "CoinPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The ledger is append-only: a row is never edited or deleted, a correction is a new row.
CREATE FUNCTION "CoinEntry_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CoinEntry is append-only: add a correcting row instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CoinEntry_no_update" BEFORE UPDATE ON "CoinEntry"
  FOR EACH ROW EXECUTE FUNCTION "CoinEntry_append_only"();

CREATE TRIGGER "CoinEntry_no_delete" BEFORE DELETE ON "CoinEntry"
  FOR EACH ROW EXECUTE FUNCTION "CoinEntry_append_only"();
