-- Live · Force-merged and Live · Broken (#force-merge): work the local coder
-- merged outside Ziki's checks, and such work judged faulty afterwards.
-- Its own migration: Postgres can't use a new enum value in the transaction
-- that adds it. Nothing here uses them.
ALTER TYPE "Substatus" ADD VALUE IF NOT EXISTS 'force_merged' AFTER 'published';
ALTER TYPE "Substatus" ADD VALUE IF NOT EXISTS 'merged_broken' AFTER 'force_merged';
