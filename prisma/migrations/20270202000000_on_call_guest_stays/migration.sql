-- On-call guests stay (#on-call, 14 Nov plan D2): an on-call person's agents join a new
-- workspace as guests and stay until removed, so the flag no longer means "until first delivery".
-- A rename, not drop and add: existing guest stays keep their flag.
ALTER TABLE "AgentActivation" RENAME COLUMN "guestUntilFirstDelivery" TO "guest";
