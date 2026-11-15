// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanEditor } from "@/components/marketing/plans/plan-editor";

vi.mock("@/app/(app)/[org]/[project]/marketing/plans/actions", () => ({ saveMarketingPlanDraftAction: vi.fn() }));
vi.mock("@/app/(app)/[org]/[project]/marketing/plans/[planId]/approval-actions", () => ({ decideMarketingActivityAction: vi.fn(), finalizeMarketingPlanAction: vi.fn() }));
afterEach(cleanup);

const strategy = {
  businessSummary: { text: "A team issue tracker", basis: "customer_input" as const }, assumptions: ["Small teams need focus"],
  objectives: [{ id: "11111111-1111-4111-8111-111111111111", text: "Reach ten teams", basis: "derived" as const }],
  audiences: [{ id: "22222222-2222-4222-8222-222222222222", description: "Engineering teams", basis: "customer_input" as const }],
  channels: [{ id: "33333333-3333-4333-8333-333333333333", name: "Community", rationale: "Trust", basis: "recommendation" as const }],
  activities: [{ id: "44444444-4444-4444-8444-444444444444", channelId: "33333333-3333-4333-8333-333333333333", title: "Write a guide", description: "A starter guide", basis: "recommendation" as const, priority: "medium" as const, budget: { amount: null, currency: null }, suggestedStart: null, suggestedEnd: null, dependencies: [], expectedOutcome: "More signups", measurements: [] }],
};
const plan = { id: "plan-1", title: "Launch plan", revisions: [{ revision: 1, version: 1, status: "draft", source: { contextId: "context-1", revision: "r1" }, strategy, createdAt: new Date(), updatedAt: new Date(), decisions: [] as Array<{ activityId: string; decision: "approved" | "rejected"; decidedById: string; decidedAt: Date; history: Array<{ decision: string; actorId: string; createdAt: Date }> }> }] };

describe("PlanEditor", () => {
  it("preserves edits while moving between sections and exposes draft-only save intent", async () => {
    const user = userEvent.setup();
    render(<PlanEditor slug={"acme/ziki" as never} plan={plan} revision={plan.revisions[0]} canApprove />);
    const summary = screen.getByLabelText("Business summary");
    await user.clear(summary);
    await user.type(summary, "Updated strategy");
    await user.click(screen.getByRole("button", { name: /objectives/i }));
    expect((screen.getByLabelText("Objective 1") as HTMLTextAreaElement).value).toBe("Reach ten teams");
    await user.click(screen.getByRole("button", { name: /overview/i }));
    expect((screen.getByLabelText("Business summary") as HTMLTextAreaElement).value).toBe("Updated strategy");
    expect(screen.getByText(/does not approve the plan.*launch campaigns/i)).toBeTruthy();
  });

  it("allows activities to be assigned to a selected channel", async () => {
    const user = userEvent.setup();
    render(<PlanEditor slug={"acme/ziki" as never} plan={plan} revision={plan.revisions[0]} canApprove />);
    await user.click(screen.getByRole("button", { name: /activities$/i }));
    expect((screen.getByRole("combobox", { name: "Channel for activity 1" }) as HTMLSelectElement).value).toBe("33333333-3333-4333-8333-333333333333");
  });
});
