-- #deeper-testing: one proof rule per scope (organisation, project, issue type, area).
-- Postgres treats NULLs as distinct, so the empty scopes are folded to '' first.
CREATE UNIQUE INDEX "ProofRule_one_per_scope_key"
  ON "ProofRule" ("organisationId", COALESCE("projectId", ''), COALESCE("issueTypeId", ''), COALESCE("projectAreaId", ''));
