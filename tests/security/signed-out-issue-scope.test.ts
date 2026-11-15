import { beforeEach, describe, expect, it, vi } from "vitest";

/** Signed out, an issue address resolves only in a public project (#access-control). */

const bugFindMany = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ viewerBugScope: vi.fn(), resolveSessionUserId: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { bug: { findMany: bugFindMany, findFirst: vi.fn() } } }));
vi.mock("@/lib/organisation-viewer", () => ({ viewerBugScope: session.viewerBugScope }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: session.resolveSessionUserId }));

import { findProjectIssue } from "@/lib/project-issue";

const row = { id: "b-1", number: 7, organisationId: "org-1", isDeleted: false, project: { slug: "web", organisation: { slug: "acme" } } };

beforeEach(() => {
  vi.clearAllMocks();
  session.viewerBugScope.mockResolvedValue({});
  session.resolveSessionUserId.mockResolvedValue({ error: "no session" });
});

describe("findProjectIssue, signed out", () => {
  it("asks only for issues in a public project", async () => {
    bugFindMany.mockResolvedValue([row]);
    const found = await findProjectIssue("acme", "web", 7);
    expect(found).toMatchObject({ kind: "found", issue: { id: "b-1" } });
    expect(bugFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          number: 7,
          isDeleted: false,
          project: expect.objectContaining({ slug: "web", visibility: "public", archivedAt: null }),
        }),
      }),
    );
  });

  it("finds nothing in a private project (the query, filtered to public, returns no rows)", async () => {
    bugFindMany.mockResolvedValue([]);
    expect(await findProjectIssue("acme", "secret-project", 8)).toBeNull();
  });
});
