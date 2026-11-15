import { describe, expect, it } from "vitest";
import { mergeChecklist, type ChecklistIssue } from "@/lib/merge-checklist";
import type { GateReport } from "@/lib/agent-api/pr-gate";

const REPO = { owner: "emerjent", repo: "ziki" };
const PR = "https://github.com/emerjent/ziki/pull/123";
const HEAD = "abc1234567890abcdef1234567890abcdef1234";

const ISSUE: ChecklistIssue = {
  pullRequestUrl: PR,
  pullRequestHeadSha: HEAD,
  repo: REPO,
};

function sampleReport(
  overrides: Partial<
    GateReport & { createdAt: Date; checkedAt?: Date | null }
  > = {},
): GateReport & { createdAt: Date; checkedAt?: Date | null } {
   return {
    pullRequestUrl: PR,
    headSha: HEAD,
    state: "open",
    checks: "passing",
    mergeable: true,
    mergedInto: null,
    inDefaultBranch: null,
    createdAt: new Date("2026-11-06T10:00:00Z"),
    ...overrides,
  };
}

describe("mergeChecklist (#merge-checklist)", () => {
  const now = new Date("2026-11-06T12:00:00Z").getTime();

  it("is ready when every automated check passes", () => {
    const list = mergeChecklist(sampleReport(), ISSUE, now);
    expect(list.passed).toBe(6);
    expect(list.total).toBe(6);
    expect(list.verdict).toBe("ready");
    expect(list.headline).toBe("Ready for a good-to-merge judgement.");
    expect(list.items.every((it) => it.state === "pass")).toBe(true);
  });

  it("considers no CI checks (none) as passing", () => {
    const list = mergeChecklist(sampleReport({ checks: "none" }), ISSUE, now);
    expect(list.verdict).toBe("ready");
    expect(list.items.find((it) => it.key === "checks")?.state).toBe("pass");
  });

  it("waits when no report exists yet", () => {
    const list = mergeChecklist(null, ISSUE, now);
    expect(list.verdict).toBe("waiting");
    expect(list.headline).toBe(
      "Waiting for an agent to check the pull request on GitHub.",
    );
    expect(list.items.find((it) => it.key === "repository")?.state).toBe(
      "pass",
    );
    expect(list.items.find((it) => it.key === "open")?.state).toBe("wait");
  });

  it("blocks when the pull request is closed without merging", () => {
    const list = mergeChecklist(sampleReport({ state: "closed" }), ISSUE, now);
    expect(list.verdict).toBe("blocked");
    expect(list.headline).toBe("Not ready: Closed without merging.");
    expect(list.items.find((it) => it.key === "open")?.state).toBe("fail");
  });

  it("blocks when the delivered commit differs from the checked commit", () => {
    const list = mergeChecklist(
      sampleReport({ headSha: "fedcba9876543210fedcba9876543210fedcba98" }),
      ISSUE,
      now,
    );
    expect(list.verdict).toBe("blocked");
    expect(list.headline).toContain("Head moved");
    expect(list.items.find((it) => it.key === "head")?.state).toBe("fail");
  });

  it("passes the head check when the delivery sent a short ID of the reported commit (#921)", () => {
    const list = mergeChecklist(sampleReport(), { ...ISSUE, pullRequestHeadSha: HEAD.slice(0, 8) }, now);
    const head = list.items.find((it) => it.key === "head");
    expect(head?.state).toBe("pass");
    expect(head?.detail).toBeNull();
    expect(list.headline).not.toContain("Head moved");
  });

  it("still fails the head check when a short delivered ID names another commit (#921)", () => {
    const list = mergeChecklist(sampleReport(), { ...ISSUE, pullRequestHeadSha: "fedcba98" }, now);
    expect(list.items.find((it) => it.key === "head")?.state).toBe("fail");
  });

  it("blocks when CI checks are failing", () => {
    const list = mergeChecklist(
      sampleReport({ checks: "failing" }),
      ISSUE,
      now,
    );
    expect(list.verdict).toBe("blocked");
    expect(list.headline).toBe("Not ready: Checks are failing.");
    expect(list.items.find((it) => it.key === "checks")?.state).toBe("fail");
  });

  it("waits when CI checks are still running (pending)", () => {
    const list = mergeChecklist(
      sampleReport({ checks: "pending" }),
      ISSUE,
      now,
    );
    expect(list.verdict).toBe("waiting");
    expect(list.items.find((it) => it.key === "checks")?.state).toBe("wait");
  });

  it("blocks when there are merge conflicts", () => {
    const list = mergeChecklist(sampleReport({ mergeable: false }), ISSUE, now);
    expect(list.verdict).toBe("blocked");
    expect(list.headline).toBe("Not ready: Conflicts with its base branch.");
    expect(list.items.find((it) => it.key === "conflicts")?.state).toBe("fail");
  });

  it("waits when the report is older than REPORT_STALE_HOURS (6h)", () => {
    const staleTime = new Date("2026-11-06T03:00:00Z"); // 9 hours before `now`
    const list = mergeChecklist(
      sampleReport({ createdAt: staleTime }),
      ISSUE,
      now,
    );
    expect(list.verdict).toBe("waiting");
    expect(list.items.find((it) => it.key === "fresh")?.state).toBe("wait");
    expect(list.items.find((it) => it.key === "fresh")?.detail).toBe(
      "Last checked 9 hours ago",
    );
  });

  it("recognizes refreshed checkedAt timestamp even if createdAt is older than 6 hours", () => {
    const oldCreated = new Date("2026-11-06T02:00:00Z"); // 10h ago
    const refreshedChecked = new Date("2026-11-06T11:00:00Z"); // 1h ago
    const list = mergeChecklist(
      sampleReport({ createdAt: oldCreated, checkedAt: refreshedChecked }),
      ISSUE,
      now,
    );
    expect(list.verdict).toBe("ready");
    expect(list.items.find((it) => it.key === "fresh")?.state).toBe("pass");
  });

  it("blocks when the pull request URL points outside the project's repository", () => {
    const foreignIssue: ChecklistIssue = {
      pullRequestUrl: "https://github.com/other-org/other-repo/pull/999",
      pullRequestHeadSha: HEAD,
      repo: REPO,
    };
    const list = mergeChecklist(
      sampleReport({
        pullRequestUrl: "https://github.com/other-org/other-repo/pull/999",
      }),
      foreignIssue,
      now,
    );
    expect(list.verdict).toBe("blocked");
    expect(list.headline).toBe("Not ready: Points somewhere else.");
    expect(list.items.find((it) => it.key === "repository")?.state).toBe(
      "fail",
    );
  });
});
