import { beforeEach, describe, expect, it, vi } from "vitest";

const claude = vi.hoisted(() => ({ parse: vi.fn() }));
const store = vi.hoisted(() => ({ assertAccess: vi.fn(), create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic { messages = { parse: claude.parse }; },
}));
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({ zodOutputFormat: (schema: unknown) => schema }));
vi.mock("@/lib/structured-marketing-plans", () => ({
  assertMarketingPlanProjectAccess: store.assertAccess,
  createMarketingPlan: store.create,
  MarketingPlanStoreError: class MarketingPlanStoreError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));

import { generateAndSaveMarketingPlan, generateMarketingStrategy, MarketingContextIncompleteError } from "@/lib/structured-marketing-plan-generation";
import type { SessionAppUser } from "@/lib/auth-helpers";

const user = { id: "member", role: "user" } as SessionAppUser;
const channel = { name: "Email", rationale: "Reach returning customers.", basis: "recommendation" };
const generated = {
  businessSummary: { text: "A local bakery serving nearby residents.", basis: "customer_input" },
  assumptions: ["The business can send a monthly email."],
  objectives: [{ text: "Increase repeat visits.", basis: "customer_input" }],
  audiences: [{ description: "Nearby residents.", basis: "customer_input" }],
  channels: [channel],
  activities: [{
    channelIndex: 0, title: "Monthly newsletter", description: "Send a seasonal update.", basis: "recommendation", priority: "medium",
    budget: { amount: null, currency: null }, suggestedStart: null, suggestedEnd: null,
    dependencies: [], expectedOutcome: "More repeat visits.", measurements: ["Redemptions"],
  }],
};
const context = {
  projectId: "project",
  source: { system: "bishop" as const, contextId: "ctx-1", revision: "4", capturedAt: "2026-11-13T12:00:00.000Z" },
  business: { websiteUrl: "https://bakery.example", summary: "A neighborhood bakery." },
  requirements: { objectives: ["Increase repeat visits"], audiences: ["Nearby residents"], constraints: ["No paid ads"] },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ZIKI_CLAUDE_API_KEY", "test-key");
  claude.parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: structuredClone(generated) });
  store.assertAccess.mockResolvedValue({ id: "project" });
  store.create.mockResolvedValue({ planId: "plan-1", revision: 1, status: "draft" });
});

describe("structured marketing strategy generation", () => {
  it("uses the supplied onboarding context and converts channel references to stable ids", async () => {
    const result = await generateMarketingStrategy(context);
    expect(claude.parse).toHaveBeenCalledOnce();
    const request = claude.parse.mock.calls[0][0];
    expect(request.messages[0].content).toContain("No paid ads");
    expect(request.system).toContain("Do not invent business facts");
    expect(request.system).toContain("Do not browse");
    expect(result?.assumptions).toEqual(["The business can send a monthly email."]);
    expect(result?.activities[0].channelId).toBe(result?.channels[0].id);
    expect(result?.objectives[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result?.audiences[0].id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("does not generate when objective or audience context is missing", async () => {
    await expect(generateMarketingStrategy({ ...context, requirements: { ...context.requirements, audiences: [] } }))
      .rejects.toBeInstanceOf(MarketingContextIncompleteError);
    expect(claude.parse).not.toHaveBeenCalled();
  });

  it("refuses a non-http website URL before calling the model", async () => {
    await expect(generateMarketingStrategy({ ...context, business: { ...context.business, websiteUrl: "ftp://bakery.example" } }))
      .rejects.toThrow(/http or https/);
    expect(claude.parse).not.toHaveBeenCalled();
  });

  it("returns no draft when the model output is invalid or incomplete", async () => {
    claude.parse.mockResolvedValueOnce({ stop_reason: "end_turn", parsed_output: { ...generated, activities: [{ ...generated.activities[0], channelIndex: 3 }] } });
    await expect(generateMarketingStrategy(context)).resolves.toBeNull();
    claude.parse.mockResolvedValueOnce({ stop_reason: "max_tokens", parsed_output: generated });
    await expect(generateMarketingStrategy(context)).resolves.toBeNull();
  });

  it("does not call the model when AI credentials are unavailable", async () => {
    vi.stubEnv("ZIKI_CLAUDE_API_KEY", " ");
    await expect(generateMarketingStrategy(context)).resolves.toBeNull();
    expect(claude.parse).not.toHaveBeenCalled();
  });

  it("persists only a valid generated draft and preserves the onboarding reference", async () => {
    await expect(generateAndSaveMarketingPlan(user, "project", "Bakery marketing plan", context)).resolves.toMatchObject({ planId: "plan-1" });
    expect(store.assertAccess).toHaveBeenCalledWith(user, "project");
    expect(store.create).toHaveBeenCalledWith(user, "project", expect.objectContaining({
      title: "Bakery marketing plan", source: { contextId: "ctx-1", revision: "4" },
    }));
  });

  it("rejects a context from another project before generation", async () => {
    await expect(generateAndSaveMarketingPlan(user, "project", "Plan", { ...context, projectId: "other-project" }))
      .rejects.toMatchObject({ status: 404 });
    expect(claude.parse).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });

  it("does not create a persisted plan when generation is unavailable", async () => {
    vi.stubEnv("ZIKI_CLAUDE_API_KEY", "");
    await expect(generateAndSaveMarketingPlan(user, "project", "Plan", context)).resolves.toBeNull();
    expect(store.create).not.toHaveBeenCalled();
  });

  it("does not persist a plan when the model call fails", async () => {
    claude.parse.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(generateAndSaveMarketingPlan(user, "project", "Plan", context)).resolves.toBeNull();
    expect(store.create).not.toHaveBeenCalled();
  });

  it("checks project access before invoking the model", async () => {
    store.assertAccess.mockRejectedValue(new Error("not a member"));
    await expect(generateAndSaveMarketingPlan(user, "project", "Plan", context)).rejects.toThrow("not a member");
    expect(claude.parse).not.toHaveBeenCalled();
  });
});
