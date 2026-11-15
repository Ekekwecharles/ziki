import { describe, expect, it } from "vitest";
import { CLI_TOOLS } from "@/cli/catalog";
import { apiNotFound, createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { mergeReviewBodySchema } from "@/lib/agent-api/merge";
import { z } from "zod";
import { TOOLS } from "@/packages/mcp-server/src/tools";
import { agentEscalationSchema, agentQuestionSchema } from "@/lib/agent-questions";
import { agentCommentSchema } from "@/lib/agent-api/issues";
import { createGoalSchema, splitGoalPoolSchema, updateGoalStatusSchema } from "@/lib/validations/goal";
import { createJobSchema, jobReviewSchema, submitJobSchema } from "@/lib/validations/job";
import { redesignSchema } from "@/lib/redesigns";
import { missionCoverageSchema, nextMissionSchema } from "@/lib/missions";
import { bidSchema } from "@/lib/agent-api/bid";
import { addRowsSchema, rowActionSchema } from "@/lib/proof";
import { extendSchema } from "@/lib/agent-api/deadline";
import { releaseSchema } from "@/lib/agent-api/offer";
import { structureInputSchema } from "@/lib/agent-api/structure";
import { testVerdictBodySchema } from "@/lib/agent-api/test-verdict";
import { forceMergeBodySchema } from "@/lib/agent-api/force-merge";
import { deliveryBodySchema } from "@/lib/agent-api/delivery";
import { outsideWorkSchema } from "@/lib/agent-api/outside-work";
import { expressImportRequestSchema } from "@/lib/agents/express-import";
import { confirmationSchema } from "@/lib/agent-api/confirmations";
import { penaltySchema } from "@/lib/agent-api/confirmation-penalties";
import { ideaVerdictFields } from "@/lib/agent-api/idea-verdicts";
import { recordMistakeSchema } from "@/lib/agent-api/mistakes";
import { createIdeaSchema } from "@/lib/agent-api/ideas";
import { stakeSchema } from "@/lib/agent-api/stakes";
import { estimateSchema } from "@/lib/agent-api/reward-estimates";
import { abandonVoteSchema } from "@/lib/agent-api/abandon";
import { closeIssueSchema, closeSuggestionSchema, reopenIssueSchema, withdrawIssueSchema } from "@/lib/agent-api/close-suggestions";
import { repairPullRequestSchema } from "@/lib/agent-api/repair-pull-request";
import { pullRequestReportSchema } from "@/lib/validations/pull-request-report";
import { deploymentSchema } from "@/lib/agent-api/deployment";
import { archiveIdeaSchema, withdrawIdeaSchema } from "@/lib/idea-archive";
import { rejectIdeaSchema } from "@/lib/idea-rejection";
import { createMarketingTaskTypeSchema, updateMarketingTaskTypeSchema } from "@/lib/marketing/task-types";
import { agentProfileUpdateSchema, agentSkillsReplaceSchema, agentSkillUpsertSchema } from "@/lib/validations/agent-profile";
import { agentPreferenceCreateSchema, agentPreferenceUpdateSchema } from "@/lib/validations/agent-preferences";

/** The HTTP contract agents rely on: unknown routes and methods answer JSON errors with the allowed methods, and every MCP/CLI tool sends exactly the fields its route accepts. */
describe("agent API HTTP errors", () => {
  it("returns a JSON 404 for unknown API routes", async () => {
    const response = apiNotFound();

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ error: "not_found" });
  });

  it("returns a JSON 405 and the route's allowed methods", async () => {
    const handler = createMethodNotAllowed(["GET", "HEAD", "OPTIONS"]);
    const response = handler(new Request("https://ziki.dev/api/v1/issues", { method: "PATCH" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: "method_not_allowed",
      message: "Method not allowed.",
    });
  });

  it("returns the route's actual methods for OPTIONS", () => {
    const handler = createOptions(["GET", "HEAD", "OPTIONS"]);
    const response = handler();

    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(response.body).toBeNull();
  });
});

/**
 * The MCP server (packages/mcp-server) builds its tool inputs from its own zod
 * shapes. These checks fail when a route's body schema gains, renames or
 * requires a field the matching tool doesn't have, so the tools can't drift
 * from the API (#612).
 */
const ROUTE_SCHEMAS: Record<string, z.ZodType> = {
  ziki_update_profile: agentProfileUpdateSchema,
  ziki_add_test_card_rows: addRowsSchema,
  ziki_test_card_row: rowActionSchema,
  ziki_set_skills: agentSkillsReplaceSchema,
  ziki_set_skill: agentSkillUpsertSchema,
  ziki_add_preference: agentPreferenceCreateSchema,
  ziki_update_preference: agentPreferenceUpdateSchema,
  ziki_deliver: deliveryBodySchema,
  ziki_create_idea: createIdeaSchema,
  ziki_stake_issue: stakeSchema,
  ziki_stake_idea: stakeSchema,
  ziki_estimate_reward: estimateSchema,
  // The route's own schema: the shared comment fields plus summary (#730), projectId and attachmentIds.
  ziki_comment: agentCommentSchema,
  ziki_bid: bidSchema,
  ziki_import_outside_work: outsideWorkSchema,
  ziki_request_express_import_access: expressImportRequestSchema,
  ziki_extend_deadline: extendSchema,
  ziki_confirm_issue: confirmationSchema,
  ziki_penalise_confirmation: penaltySchema,
  ziki_give_idea_verdict: ideaVerdictFields,
  ziki_submit_test_result: testVerdictBodySchema,
  ziki_force_merge: forceMergeBodySchema,
  ziki_merge_fix: mergeReviewBodySchema,
  ziki_ask_owner: agentQuestionSchema,
  ziki_escalate: agentEscalationSchema,
  ziki_release_claim: releaseSchema,
  ziki_structure_issue: structureInputSchema,
  ziki_create_goal: createGoalSchema,
  ziki_update_goal: updateGoalStatusSchema,
  ziki_split_goal: splitGoalPoolSchema,
  ziki_create_job: createJobSchema,
  ziki_submit_job: submitJobSchema,
  ziki_review_job_submission: jobReviewSchema,
  ziki_propose_redesign: redesignSchema,
  ziki_next_mission: nextMissionSchema,
  ziki_cover_mission: missionCoverageSchema.extend({ projectId: z.string().trim().min(1) }),
  ziki_record_project_mistake: recordMistakeSchema,
  ziki_vote_abandoned: abandonVoteSchema,
  ziki_suggest_close: closeSuggestionSchema,
  ziki_close_issue: closeIssueSchema,
  ziki_reopen_issue: reopenIssueSchema,
  ziki_withdraw_issue: withdrawIssueSchema,
  ziki_repair_pull_request: repairPullRequestSchema,
  ziki_report_pr_status: pullRequestReportSchema,
  ziki_report_deployment: deploymentSchema,
  ziki_archive_idea: archiveIdeaSchema,
  ziki_withdraw_idea: withdrawIdeaSchema,
  ziki_reject_idea: rejectIdeaSchema,
  ziki_create_marketing_task_type: createMarketingTaskTypeSchema,
  ziki_update_marketing_task_type: updateMarketingTaskTypeSchema,
};

// The agent comment route extends the shared comment schema with attachmentIds; idea
// creation's own schema (lib/agent-api/ideas.ts `createIdeaSchema`) already has both.
const AGENT_LAYER_FIELDS = new Set(["attachmentIds", "acknowledgeSimilar"]);

// Fields on the shared schema that the agent route deliberately does not take (it picks only some of
// them), so a tool must not offer them.
const NOT_OFFERED_TO_AGENTS: Record<string, readonly string[]> = {
  ziki_create_idea: ["typeId"],
  // `action` is the older name for `verdict`, kept for old clients only.
  ziki_merge_fix: ["action"],
  ziki_reject_idea: ["rejectReason"],
};

// Fields the route doesn't take from the body: the tool puts them in the path or query.
const NOT_BODY = new Set(["projectId", "id"]);

/** Zod objects and objects wrapped in superRefine both expose the field map. */
const shapeOf = (schema: z.ZodType) => {
  let current: unknown = schema;
  for (let hop = 0; hop < 4 && current && typeof current === "object" && !("shape" in current); hop += 1) {
    current = (current as { def?: { schema?: unknown }; _def?: { schema?: unknown } }).def?.schema
      ?? (current as { _def?: { schema?: unknown } })._def?.schema;
  }
  return (current as { shape: Record<string, z.ZodType> }).shape;
};
const isRequired = (field: z.ZodType) => !field.safeParse(undefined).success;

describe("MCP tools match the route body schemas", () => {
  it("exposes issue-list search and track filters in MCP and CLI", () => {
    const describedAs = (field: unknown) => (field as z.ZodType | undefined)?.description;
    for (const tools of [TOOLS, CLI_TOOLS]) {
      const list = tools.find((tool) => tool.name === "ziki_list_issues")!;
      expect(list.query).toEqual(expect.arrayContaining(["track", "q"]));
      expect(describedAs(list.input.track)).toBeTruthy();
      expect(describedAs(list.input.q)).toBeTruthy();

      const counts = tools.find((tool) => tool.name === "ziki_count_issues")!;
      expect(counts.query).toContain("track");
      expect(describedAs(counts.input.track)).toBeTruthy();
    }
  });

  for (const [name, schema] of Object.entries(ROUTE_SCHEMAS)) {
    const tool = TOOLS.find((candidate) => candidate.name === name)!;

    it(`${name} only sends fields the route accepts`, () => {
      const routeKeys = [...Object.keys(shapeOf(schema)), ...AGENT_LAYER_FIELDS];
      for (const key of tool.body ?? []) {
        expect(routeKeys, `${name} sends ${key}, which the route rejects`).toContain(key);
      }
    });

    it(`${name} requires everything the route requires`, () => {
      for (const [key, field] of Object.entries(shapeOf(schema))) {
        if (NOT_BODY.has(key) || !isRequired(field)) continue;
        expect(tool.body ?? [], `${name} never sends required ${key}`).toContain(key);
        expect(isRequired(tool.input[key] as z.ZodType), `${name} must require ${key}`).toBe(true);
      }
    });
  }

  for (const [name, schema] of Object.entries(ROUTE_SCHEMAS)) {
    it(`${name} offers every field the route accepts, optional ones too (#969)`, () => {
      const tool = TOOLS.find((candidate) => candidate.name === name)!;
      const left = Object.keys(shapeOf(schema)).filter(
        (key) => !NOT_BODY.has(key) && !(NOT_OFFERED_TO_AGENTS[name] ?? []).includes(key) && !(tool.body ?? []).includes(key),
      );
      expect(left, `${name} cannot send ${left.join(", ")}`).toEqual([]);
    });
  }

  it("covers every tool that posts a JSON body to a route with an exported schema", () => {
    const bodyTools = TOOLS.filter((tool) => tool.body?.length).map((tool) => tool.name);
    // These bodies are declared on the route file, not as an exported schema.
    const unchecked = bodyTools.filter((name) => !(name in ROUTE_SCHEMAS));
    expect(unchecked.sort()).toEqual([
      "ziki_collect_pairing_token",
      "ziki_convert_idea",
      "ziki_create_webhook",
      "ziki_mark_inbox_read",
      "ziki_pair",
      "ziki_update_webhook",
    ]);
  });
});
