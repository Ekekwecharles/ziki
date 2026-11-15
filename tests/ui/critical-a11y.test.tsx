// @vitest-environment jsdom
"use client";

import Link from "next/link";

import axe from "axe-core";
import { NewMarketingTaskForm } from "@/components/marketing/tasks/new-marketing-task-form";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { labelInNameMismatches } from "@/lib/a11y/label-in-name";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketingSettings } from "@/components/marketing/settings/settings";
import { EntryReplyForm } from "@/components/entry-reply-form";
import { CreateBugForm } from "@/components/create-issue-form";
import { UserSearch } from "@/components/user-search";
import { VoteButton } from "@/components/vote-button";
import { WebhookManagement } from "@/components/webhook-management";
import { Library } from "@/components/marketing/library/library";
import { deliveryFiles } from "@/components/marketing/library/model";
import { TasksBoard } from "@/components/marketing/tasks/tasks-board";
import { TASK_TABS } from "@/components/marketing/tasks/model";
import { RejectedIdeas } from "@/components/marketing/rejected-ideas/rejected-ideas";
import type { RejectedIdea } from "@/components/marketing/rejected-ideas/model";
import { MarketingDeliverablesPanel } from "@/components/marketing/marketing-deliverables-panel";
import { MarketingReviewsPanel } from "@/components/marketing/marketing-reviews-panel";
import { createWebhookAction, listWebhooksAction } from "@/app/actions/webhooks";
import { OnScreenGuide } from "@/components/support-guide/on-screen-guide";
import { getPageGuidance, searchSupportAnswers } from "@/components/support-guide/support-guide-data";
import { ActiveSessions } from "@/components/active-sessions";
import { LoginHistory } from "@/components/login-history";
import { projectRef } from "@/lib/project-paths";
import { AgentSideCard, type AgentProfileData } from "@/app/(app)/agent/[username]/agent-profile";
import { RepositoryReadiness } from "@/components/repository-readiness";
import RepositoryReadinessLoading from "@/app/(app)/projects/readiness/loading";
import RepositoryReadinessError from "@/app/(app)/projects/readiness/error";
import { checkDelivery, recheckRepositories } from "@/app/(app)/projects/readiness/actions";
import type { DeliveryReadinessResult, ReadinessResult } from "@/lib/github/repository-readiness-types";

vi.mock("@/app/(app)/projects/readiness/actions", () => ({ checkDelivery: vi.fn(), recheckRepositories: vi.fn() }));

vi.mock("@/app/actions/settings", () => ({
  signOutSessionAction: vi.fn(async () => ({ ok: true })),
  signOutOtherSessionsAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/app/(app)/[org]/[project]/marketing/settings/actions", () => ({
  createMarketingIssueTypeAction: vi.fn(),
  deleteMarketingIssueTypeAction: vi.fn(),
  toggleMarketingIssueTypeActiveAction: vi.fn(),
  updateMarketingIssueTypeAction: vi.fn(),
  updateMarketingRevisionLimitAction: vi.fn(),
  updateMarketingBriefAction: vi.fn(),
}));
vi.mock("@/app/actions/issues", () => ({
  addCommentAction: vi.fn(),
  createBugAction: vi.fn(),
  toggleVoteAction: vi.fn(),
}));
vi.mock("@/app/(app)/[org]/[project]/marketing/output-box/actions", () => ({ refreshLibrary: vi.fn() }));
vi.mock("@/lib/project-route", () => ({
  requireProject: vi.fn(async () => ({
    organisationId: "organisation-1",
    project: { id: "project-1", slug: "acme", name: "Acme" },
    user: { id: "user-1" },
  })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { pointEntry: { aggregate: vi.fn(async () => ({ _sum: { points: 120 } })) } },
}));
vi.mock("@/app/actions/idea-verdicts", () => ({
  giveIdeaVerdictAction: vi.fn(),
  quickIdeaVerdictAction: vi.fn(),
  withdrawIdeaFromPage: vi.fn(),
  withdrawIdeaAction: vi.fn(),
  approveIdeaAction: vi.fn(),
  rejectIdeaAction: vi.fn(),
}));
vi.mock("@/app/(app)/[org]/[project]/notes/actions", () => ({ voteNoteCommentAction: vi.fn() }));

vi.mock("@/app/(app)/points/disputes/actions", () => ({
  openDisputeAction: vi.fn(),
}));

vi.mock("@/app/(app)/questions/actions", () => ({
  answerQuestionAction: vi.fn(),
}));

vi.mock("@/app/actions/webhooks", () => ({
  createWebhookAction: vi.fn(),
  deleteWebhookAction: vi.fn(),
  listWebhooksAction: vi.fn(),
  reEnableWebhookAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/acme/acme/marketing",
  useParams: () => ({ org: "acme", project: "acme" }),
}));

beforeAll(() => {
  // axe probes a canvas to detect icon-font ligatures. jsdom's getContext
  // throws "Not implemented" and floods stderr; a minimal stub lets the check
  // degrade quietly instead of erroring.
  window.HTMLCanvasElement.prototype.getContext = (() =>
    ({
      font: "",
      measureText: () => ({ width: 0 }),
    })) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("repository readiness administration", () => {
  const initial: ReadinessResult = { ok: true, report: { organisationId: "org1", checkedAt: "2026-11-07T10:00:00.000Z", projects: [{
    id: "p1", name: "Mobile", slug: "mobile", repositories: [{ label: "Main repository", name: "acme/mobile", url: "https://github.com/acme/mobile", defaultBranch: "main", deliveryBranch: "main", checks: [
      { key: "repository", code: "repository_exists", state: "pass", message: "Repository is accessible on GitHub." },
    ] }], deliveries: [],
  }] } };
  const wrongDelivery: DeliveryReadinessResult = { ok: true, delivery: { url: "https://github.com/acme/desktop/pull/9", check: { key: "delivery repository", state: "fail", code: "wrong_repository", message: "Delivery would fail with 422 wrong_repository." } } };
  beforeEach(() => {
    vi.mocked(recheckRepositories).mockReset();
    vi.mocked(checkDelivery).mockReset();
  });

  it("announces initial loading and exposes no delivery controls before a report exists", () => {
    render(<RepositoryReadinessLoading />);
    expect(screen.getByRole("status")).toHaveTextContent(/Checking/);
    expect(screen.queryByRole("button", { name: "Check delivery" })).not.toBeInTheDocument();
  });

  it("does not offer a delivery check for an empty organisation", () => {
    render(<RepositoryReadiness initial={{ ok: true, report: { organisationId: "org1", checkedAt: "2026-11-07T10:00:00.000Z", projects: [] } }} />);
    expect(screen.getByRole("heading", { name: "No active projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open projects" })).toHaveAttribute("href", "/home");
    expect(screen.queryByLabelText("Pull request URL")).not.toBeInTheDocument();
  });

  it("recovers from an initial error through Recheck", async () => {
    vi.mocked(recheckRepositories).mockResolvedValue(initial);
    render(<RepositoryReadiness initial={{ ok: false, error: "Could not load repository readiness." }} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    expect(await screen.findByRole("heading", { name: "Mobile" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Pull request URL")).toBeEnabled();
  });

  it("preserves previous evidence while refreshing, locks duplicate requests and then replaces the report", async () => {
    let finish!: (value: ReadinessResult) => void;
    vi.mocked(recheckRepositories).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<RepositoryReadiness initial={initial} />);
    const button = screen.getByRole("button", { name: "Recheck" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole("status")).toHaveTextContent("Previous results remain");
    expect(screen.getByRole("heading", { name: "Mobile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check delivery" })).toBeDisabled();
    expect(recheckRepositories).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, report: { ...initial.report, projects: [] } }));
    expect(screen.queryByRole("heading", { name: "Mobile" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No active projects" })).toBeInTheDocument();
  });

  it("retains previous results on refresh failure and allows retry", async () => {
    vi.mocked(recheckRepositories).mockRejectedValueOnce(new Error("private details")).mockResolvedValueOnce(initial);
    render(<RepositoryReadiness initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private details");
    expect(screen.getByRole("heading", { name: "Mobile" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("reports a safe server-side refresh error without discarding the previous report", async () => {
    vi.mocked(recheckRepositories).mockResolvedValue({ ok: false, error: "Could not load repository readiness. Recheck to try again." });
    render(<RepositoryReadiness initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recheck to try again");
    expect(screen.getByRole("heading", { name: "Mobile" })).toBeInTheDocument();
  });

  it("locks delivery checks against double submission and shows the wrong-repository evidence", async () => {
    let finish!: (value: DeliveryReadinessResult) => void;
    vi.mocked(checkDelivery).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<RepositoryReadiness initial={initial} />);
    fireEvent.change(screen.getByLabelText("Pull request URL"), { target: { value: "https://github.com/acme/desktop/pull/9" } });
    const form = screen.getByLabelText("Pull request URL").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: "Recheck" })).toBeDisabled();
    expect(screen.getByLabelText("Pull request URL")).toBeDisabled();
    expect(checkDelivery).toHaveBeenCalledExactlyOnceWith({ projectId: "p1", pullRequestUrl: "https://github.com/acme/desktop/pull/9" });
    await act(async () => finish(wrongDelivery));
    expect(screen.getByRole("alert")).toHaveTextContent("422 wrong_repository");
    expect(screen.getByRole("button", { name: "Check delivery" })).toBeEnabled();
  });

  it("recovers from a delivery failure without exposing a thrown error", async () => {
    vi.mocked(checkDelivery).mockRejectedValueOnce(new Error("private details")).mockResolvedValueOnce({ ok: true, delivery: { url: "https://github.com/acme/mobile/pull/9", check: { key: "delivery", state: "pass", code: "delivery_ready", message: "Repository and installation verified." } } });
    render(<RepositoryReadiness initial={initial} />);
    fireEvent.change(screen.getByLabelText("Pull request URL"), { target: { value: "https://github.com/acme/mobile/pull/9" } });
    fireEvent.click(screen.getByRole("button", { name: "Check delivery" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private details");
    fireEvent.click(screen.getByRole("button", { name: "Check delivery" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Repository and installation verified");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets a failed route retry through its error boundary", () => {
    const retry = vi.fn();
    render(<RepositoryReadinessError retry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

/** Accessibility of the primary flows (axe): reporting an issue, voting, replying to an entry and finding a person have no violations. */
/**
 * axe-core needs a layout engine for two checks, and jsdom has none:
 * - `color-contrast` needs real computed colours and canvas.
 * - `region` assumes a full page with landmarks; these are isolated widgets.
 * - `label-content-name-mismatch` needs layout to decide which text is visible,
 *   so expectNoA11yViolations checks that from the text instead.
 * Everything else runs normally.
 */
const AXE_OPTIONS: axe.RunOptions = {
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
};

/** Render a node, run axe over it, and fail with the readable violation list. */
async function expectNoA11yViolations(node: HTMLElement) {
  const results = await axe.run(node, AXE_OPTIONS);
  const violations = results.violations.map(
    (v) => `${v.id} (${v.impact ?? "n/a"}): ${v.help}`,
  );
  // axe skips label-in-name here: jsdom reports no visible text. Check it from the text.
  for (const mismatch of labelInNameMismatches(node)) {
    violations.push(
      `label-content-name-mismatch (serious): visible text "${mismatch.visible}" is not in the accessible name "${mismatch.name}"`,
    );
  }
  expect(violations).toEqual([]);
}

const users = [{ id: "u1", name: "Alice", role: "user" as const }];

describe("component accessibility (axe)", () => {
  it("shows the stuck context first in an agent profile sidebar and omits it when the agent is not stuck", () => {
    const agent: AgentProfileData = {
      id: "agent-1", name: "Build agent", model: "Test model", avatar: null, level: "working", revokedAt: null,
      createdAt: new Date("2026-11-01T00:00:00Z"), ownerName: null, lastActiveAt: null, activeNow: false,
      organisations: ["Acme"], counts: { filed: 0, claims: 1, comments: 0, delivered: 0 }, reputation: 0,
      username: "build-agent", tagline: null, about: null, services: null, rating: null, pictureUrl: null, skills: [],
    };
    const stuckContext = {
      summary: "No word on #42 Fix the login for 20 min",
      issue: { number: 42, title: "Fix the login", href: "/acme/platform/42" },
      lastHeartbeatAt: new Date("2026-11-07T10:00:00Z"),
      deliverBy: null,
      deadlinePassed: false,
    };
    const { container, rerender } = render(
      <AgentSideCard
        agent={agent}
        stuckContext={stuckContext}
        editControl={<Link href="/edit">Edit Profile</Link>}
        keyPanel={<Link href="/connect">Connect Agent</Link>}
        showActivity
        blocked
      />,
    );
    const sidebar = container.querySelector("aside");
    expect(sidebar?.firstElementChild).toHaveAttribute("aria-label", "Stuck status");
    expect(sidebar?.children[1]).toHaveTextContent("Edit Profile");
    expect(sidebar?.children[2]).toHaveTextContent("Connect Agent");
    expect(sidebar?.children[3]).toHaveTextContent("See its activity");
    expect(sidebar?.children[4]).toHaveTextContent("Not allowed to work yet");
    expect(screen.getByText(stuckContext.summary)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#42 Fix the login" })).toHaveAttribute("href", stuckContext.issue.href);
    expect(screen.getByRole("link", { name: "Open issue" })).toHaveAttribute("href", stuckContext.issue.href);
    expect(screen.getByText(/Last heard from/)).toBeInTheDocument();

    rerender(<AgentSideCard agent={agent} />);
    expect(screen.queryByRole("status", { name: "Stuck status" })).not.toBeInTheDocument();
  });
  it("keeps the new marketing task form accessible, with and without task types", async () => {
    const withTypes = render(<NewMarketingTaskForm projectId="project-1" types={[{ id: "blog", name: "Blog post" }]} />);
    await expectNoA11yViolations(withTypes.container);
    withTypes.unmount();
    const withoutTypes = render(<NewMarketingTaskForm projectId="project-1" types={[]} />);
    await expectNoA11yViolations(withoutTypes.container);
  });
  it("keeps approved-work selection and attachment actions accessible", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const { container } = render(<Library slug={projectRef("acme", "acme")} initial={{ ok: true, items: [{
      id: "published", number: 42, title: "Welcome email", agent: "Content agent", summary: "An approved email sequence.", publishedAt: "2026-11-04T12:00:00Z",
      files: deliveryFiles(["https://example.com/welcome.docx"]),
    }] }} />);
    await expectNoA11yViolations(container);
  });
  it("keeps marketing settings accessible, for an admin and read-only for a member", async () => {
    const data = {
      revisionLimit: 2,
      canManage: true,
      types: [{ id: "blog", name: "Blog post", description: null, isActive: true, usage: 1 }],
      brief: { product: "Acme", audience: "", currentFocus: "", outOfScope: "" },
    };
    const admin = render(<MarketingSettings slug={projectRef("acme", "acme")} data={data} />);
    await expectNoA11yViolations(admin.container);
    admin.unmount();
    const member = render(<MarketingSettings slug={projectRef("acme", "acme")} data={{ ...data, canManage: false }} />);
    await expectNoA11yViolations(member.container);
  });

  it("keeps the marketing tasks board's stages, steps and rows accessible", async () => {
    const { container } = render(<TasksBoard slug={projectRef("acme", "acme")} board={{
      tab: TASK_TABS[1],
      counts: { ideas: 2, open: 1, "in-progress": 0, closed: 0, done: 3, live: 0 },
      sortParam: null,
      list: { kind: "tasks", sort: "importance", rows: [{
        id: "task-1", number: 41, title: "Write the launch post", href: "/acme/41", status: "open", substatus: "open", closeReason: null,
        importance: 0, reward: 4, rewardEstimates: 2, rewardFixed: false, typeName: "Blog post", agentName: null, work: null, offeredTo: null,
        revision: null, bids: 2, comments: 1, updatedAt: new Date("2026-11-01T10:00:00Z"),
      }] },
      pagination: { page: 1, totalPages: 1, totalCount: 1, from: 1, to: 1 },
    }} />);
    await expectNoA11yViolations(container);
  });
  it("keeps rejected marketing ideas and their verdicts accessible", async () => {
    const item: RejectedIdea = {
      id: "idea1", number: 7, title: "Write a launch post", summary: "A post about the launch.",
      rationale: "People keep asking what changed.",
      typeName: "Blog post", reporterName: "Ada", createdAt: new Date("2026-11-04"),
      score: 1, threshold: 3, votes: { good: 1, bad: 0, neutral: 0 },
      verdicts: [{
        id: "v1", opinion: "good", votes: 1, summary: "Worth doing.",
        description: "It serves the current focus.", by: "Bola", agentName: "Bola's agent",
        updatedAt: new Date("2026-11-04"),
      }],
      status: "rejected", rejectedAt: new Date("2026-11-05"), rejectedBy: "a manager agent", archivedAt: null, archivedBy: null,
      archiveReason: null,
    };
    const { container } = render(<RejectedIdeas slug={projectRef("acme", "acme")} initial={{ ok: true, items: [item], total: 1, page: 1, totalPages: 1, from: 1, to: 1 }} />);
    await expectNoA11yViolations(container);
  });
  it("keeps a marketing task's deliverables and reviews accessible, full and empty", async () => {
    const at = new Date("2026-11-04");
    const panels = (full: boolean) => (
      <>
        <MarketingDeliverablesPanel
          bugId="task-1"
          canReply={false}
          deliveries={full ? [{
            id: "d1", agentName: "Ada's agent", by: "Ada", summary: "The post is live.", description: "Published on the blog.",
            deliverableUrls: ["https://example.com/post"], current: true, updatedAt: at, replies: [],
          }] : []}
        />
        <MarketingReviewsPanel
          bugId="task-1"
          canReply={false}
          revisionCount={1}
          maxRevisions={2}
          reviews={full ? [{
            id: "r1", agentName: "Bola's agent", by: "Bola", summary: "Reads well.", description: "Checked the links.",
            goodToMerge: true, updatedAt: at, replies: [],
          }] : []}
        />
      </>
    );
    const full = render(panels(true));
    await expectNoA11yViolations(full.container);
    full.unmount();
    const empty = render(panels(false));
    await expectNoA11yViolations(empty.container);
  });

  it("VoteButton has no violations", async () => {
    const { container } = render(<VoteButton bugId="b1" voteCount={3} />);
    await expectNoA11yViolations(container);
  });

  it("EntryReplyForm has no violations", async () => {
    const { container } = render(<EntryReplyForm bugId="b1" target={{ bidId: "bid1" }} label="Reply to this bid" />);
    await expectNoA11yViolations(container);
  });

  it("CreateBugForm has no violations", async () => {
    const { container } = render(
      <CreateBugForm projectSlug={projectRef("zedu", "acme")}
        users={users}
        types={[{ id: "t1", name: "Bug" }]}
        isAdmin
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("CreateBugForm quick report in the modal has no violations (#report-modal)", async () => {
    const { container } = render(
      <CreateBugForm projectSlug={projectRef("zedu", "acme")}
        users={users}
        types={[{ id: "t1", name: "Bug" }]}
        isAdmin={false}
        currentUserId="u1"
        variant="modal"
        reportedFrom="/acme/issues/open"
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("UserSearch has no violations", async () => {
    const { container } = render(<UserSearch />);
    await expectNoA11yViolations(container);
  });

  it("keeps ActiveSessions and LoginHistory accessible across populated and empty states", async () => {
    const populated = render(
      <div>
        <ActiveSessions
          initialSessions={[
            {
              id: "s1",
              device: "Chrome on Windows 11",
              deviceType: "laptop",
              ipAddress: "102.89.xx.xx",
              location: "Ikorodu, Lagos, Nigeria",
              isCurrent: true,
              lastActiveText: "Active now",
            },
            {
              id: "s2",
              device: "Chrome on Android (Oppo)",
              deviceType: "mobile",
              ipAddress: "105.112.xx.xx",
              location: "Ikorodu, Lagos, Nigeria",
              isCurrent: false,
              lastActiveText: "Last active 5 minutes ago",
            },
            {
              id: "s3",
              device: "Firefox on Ubuntu 24.04",
              deviceType: "desktop",
              ipAddress: "197.210.xx.xx",
              location: "Lagos, Nigeria",
              isCurrent: false,
              lastActiveText: "Last active 3 days ago",
            },
          ]}
        />
        <LoginHistory
          totalCount={48}
          items={[
            {
              id: "h1",
              dateTime: "Nov 4, 2026 · 09:37",
              status: "successful",
              statusLabel: "Successful",
              device: "Chrome · Windows 11",
              ipAddress: "102.89.xx.xx",
              location: "Ikorodu, NG",
            },
            {
              id: "h2",
              dateTime: "Nov 2, 2026 · 21:15",
              status: "failed_password",
              statusLabel: "Failed · wrong password",
              device: "Unknown · Linux",
              ipAddress: "45.134.xx.xx",
              location: "Amsterdam, NL",
            },
          ]}
        />
      </div>,
    );
    expect(screen.getByRole("region", { name: "Login history" })).toHaveAttribute("tabindex", "0");
    await expectNoA11yViolations(populated.container);
    populated.unmount();

    const empty = render(<LoginHistory items={[]} totalCount={0} />);
    expect(screen.getByRole("region", { name: "Login history" })).toHaveAttribute("tabindex", "0");
    await expectNoA11yViolations(empty.container);
  });

  it("keeps the signing-secret dialog modal and restores focus when it closes", async () => {
    const originalShowModal = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      "showModal",
    );
    const originalClose = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      "close",
    );
    let previousFocus: HTMLElement | null = null;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        previousFocus = document.activeElement as HTMLElement | null;
        this.setAttribute("open", "");
        this.querySelector<HTMLElement>("button")?.focus();
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
        previousFocus?.focus();
      },
    });

    try {
      vi.mocked(listWebhooksAction).mockResolvedValue({
        ok: true,
        subscriptions: [],
        agents: [{ id: "agent-1", name: "Test agent", avatar: null }],
      });
      vi.mocked(createWebhookAction).mockResolvedValue({
        ok: true,
        secret: "secret-for-test",
        subscription: {
          id: "webhook-1",
          url: "https://example.test/hooks/ziki",
          enabled: true,
          failureCount: 0,
          disabledAt: null,
          createdAt: new Date(),
          lastError: null,
          lastErrorAt: null,
          lastDeliveredAt: null,
          agent: { id: "agent-1", name: "Test agent", avatar: null },
        },
      });

      const user = userEvent.setup();
      render(<WebhookManagement />);
      await user.click(await screen.findByRole("radio", { name: "Test agent" }));
      await user.type(
        screen.getByRole("textbox", { name: "HTTPS endpoint URL" }),
        "https://example.test/hooks/ziki",
      );
      await user.click(screen.getByRole("button", { name: "Add webhook" }));

      const dialog = await screen.findByRole("dialog", {
        name: "Copy your signing secret now",
      });
      expect(dialog).toHaveAttribute("open");
      expect(dialog.contains(document.activeElement)).toBe(true);

      fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "HTTPS endpoint URL" }),
      );
    } finally {
      if (originalShowModal) {
        Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
      }
      if (originalClose) {
        Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
      }
    }
  }, 15000);

  describe("Customer Support Guide", () => {
    it("resolves route context guidance for homepage, issues, ideas, and tickets", () => {
      const home = getPageGuidance("/");
      expect(home.contextKey).toBe("home");
      expect(home.pageName).toContain("Homepage");

      const issues = getPageGuidance("/acme/issues");
      expect(issues.contextKey).toBe("issues");
      expect(issues.pageName).toContain("Issues");

      const ideas = getPageGuidance("/acme/ideas");
      expect(ideas.contextKey).toBe("ideas");
      expect(ideas.pageName).toContain("Ideas");

      const ticket = getPageGuidance("/acme/123");
      expect(ticket.contextKey).toBe("issue-detail");
    });

    it("answers user questions about agents, issues, your call, and feeling lost", () => {
      expect(searchSupportAnswers("I feel lost where do I start?").text).toContain("Ziki is designed for humans");
      expect(searchSupportAnswers("What are agents doing?").text).toContain("Autonomous agents in Ziki");
      expect(searchSupportAnswers("What does Your Call mean?").text).toContain("Your Call");
      expect(searchSupportAnswers("How do points and rewards work?").text).toContain("Rewards in Ziki");
    });

    it("returns direct page navigation shortcuts for page queries", () => {
      const issuesNav = searchSupportAnswers("take me to issues", projectRef("demo", "demo"));
      expect(issuesNav.actions).toBeDefined();
      expect(issuesNav.actions?.[0].href).toBe("/demo/demo/issues/all");

      const ideasNav = searchSupportAnswers("take me to ideas", projectRef("demo", "demo"));
      expect(ideasNav.actions).toBeDefined();
      expect(ideasNav.actions?.[0].href).toBe("/demo/demo/ideas");
    });

    it("renders the support guide with accessible ARIA label and toggle button", async () => {
      render(<OnScreenGuide />);
      const guide = screen.getByRole("complementary", { name: "Customer Support Guide" });
      expect(guide).toBeInTheDocument();

      const toggleBtn = screen.getByRole("button", { name: /ask support/i });
      expect(toggleBtn).toBeInTheDocument();

      fireEvent.click(toggleBtn);
      expect(screen.getAllByText(/Ziki Support Guide/i).length).toBeGreaterThanOrEqual(1);
    });
  });

});
