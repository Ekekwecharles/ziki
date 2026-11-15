-- On-call cover snapshots (#on-call, 12 Nov plan H3).
CREATE TABLE "OnCallSample" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "onCall" INTEGER NOT NULL,
    "online" INTEGER NOT NULL,
    "free" INTEGER NOT NULL,

    CONSTRAINT "OnCallSample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OnCallSample_at_idx" ON "OnCallSample"("at");
