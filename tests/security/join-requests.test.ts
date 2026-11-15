import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Request-to-join for public projects that aren't open for contributors (#join-requests), and the
 * maintainers' accept / decline: who may ask, duplicates, the declined cooldown, and that a request is
 * decided only once and an accepted one grants a project membership (nothing wider).
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpsert: vi.fn(),
  requestUpdateMany: vi.fn(),
  membershipFindMany: vi.fn(),
  membershipUpsert: vi.fn(),
  projectMembershipUpsert: vi.fn(),
  notificationCreate: vi.fn(),
  notificationCreateMany: vi.fn(),
}));
const perms = vi.hoisted(() => ({ canContributeToProject: vi.fn(), canManageProject: vi.fn() }));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const tx = {
    projectJoinRequest: { updateMany: db.requestUpdateMany },
    projectMembership: { upsert: db.projectMembershipUpsert },
    membership: { upsert: db.membershipUpsert },
    notification: { create: db.notificationCreate },
  };
  return {
    prisma: {
      project: { findFirst: db.projectFindFirst },
      projectJoinRequest: { findUnique: db.requestFindUnique, upsert: db.requestUpsert },
      membership: { findMany: db.membershipFindMany },
      notification: { createMany: db.notificationCreateMany },
      $transaction: async (run: (t: typeof tx) => Promise<unknown>) => run(tx),
    },
  };
});
vi.mock("@/lib/project-permissions", () => perms);
vi.mock("@/lib/auth-helpers", () => auth);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/points/signup-bonus", () => ({ awardSignupBonus: vi.fn() }));
vi.mock("@/lib/marketing/project-home", () => ({ projectHomePath: vi.fn() }));

import { DECLINED_REQUEST_COOLDOWN_MS } from "@/lib/join-requests";
import {
  acceptJoinRequestAction,
  rejectJoinRequestAction,
  requestToJoinProjectAction,
} from "@/app/actions/project-join-requests";

const closedPublic = {
  id: "p-1",
  slug: "web",
  name: "Web",
  organisationId: "org-1",
  isOpenForContributors: false,
  organisation: { slug: "acme" },
};

function form(requestId: string) {
  const data = new FormData();
  data.set("requestId", requestId);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "user-1", name: "Alice", role: "user" });
  perms.canContributeToProject.mockResolvedValue(false);
  db.membershipFindMany.mockResolvedValue([{ userId: "owner-1" }, { userId: "admin-1" }]);
  db.notificationCreateMany.mockResolvedValue({ count: 2 });
  db.requestFindUnique.mockResolvedValue(null);
  db.requestUpsert.mockResolvedValue({});
});

describe("requestToJoinProjectAction", () => {
  it("only looks at public, unarchived projects, so a private project answers like one that doesn't exist", async () => {
    db.projectFindFirst.mockResolvedValue(null);
    expect(await requestToJoinProjectAction("private-1", "")).toEqual({ ok: false, error: "Project not found." });
    expect(db.projectFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "private-1", visibility: "public", archivedAt: null, organisation: { archivedAt: null } }),
      }),
    );
    expect(db.requestUpsert).not.toHaveBeenCalled();
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("files a pending request on a public project that isn't open, and tells the organisation's owners and admins", async () => {
    db.projectFindFirst.mockResolvedValue(closedPublic);
    expect(await requestToJoinProjectAction("p-1", "  I'd like to help with docs  ")).toEqual({ ok: true });
    expect(db.requestUpsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: "p-1", userId: "user-1" } },
      create: { projectId: "p-1", userId: "user-1", message: "I'd like to help with docs", status: "pending" },
      update: { message: "I'd like to help with docs", status: "pending", reviewedBy: null, reviewedAt: null },
    });
    expect(db.membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: "org-1", role: { in: ["owner", "admin"] } } }),
    );
    const { data } = db.notificationCreateMany.mock.calls[0][0];
    expect(data.map((n: { userId: string }) => n.userId)).toEqual(["owner-1", "admin-1"]);
    expect(data[0]).toMatchObject({ kind: "join_request", url: "/acme/web/org/invites" });
    // Requesting never grants anything by itself.
    expect(db.projectMembershipUpsert).not.toHaveBeenCalled();
  });

  it("caps the note at 1000 characters", async () => {
    db.projectFindFirst.mockResolvedValue(closedPublic);
    await requestToJoinProjectAction("p-1", "x".repeat(5000));
    expect(db.requestUpsert.mock.calls[0][0].create.message).toHaveLength(1000);
  });

  it("sends people to Join on a project that is open to everyone", async () => {
    db.projectFindFirst.mockResolvedValue({ ...closedPublic, isOpenForContributors: true });
    expect(await requestToJoinProjectAction("p-1", "")).toEqual({ ok: false, error: expect.stringContaining("Join") });
    expect(db.requestUpsert).not.toHaveBeenCalled();
  });

  it("refuses someone who is already a member", async () => {
    db.projectFindFirst.mockResolvedValue(closedPublic);
    perms.canContributeToProject.mockResolvedValue(true);
    expect(await requestToJoinProjectAction("p-1", "")).toEqual({ ok: false, error: expect.stringContaining("already a member") });
    expect(db.requestUpsert).not.toHaveBeenCalled();
  });

  it("refuses a duplicate while the first request is pending", async () => {
    db.projectFindFirst.mockResolvedValue(closedPublic);
    db.requestFindUnique.mockResolvedValue({ status: "pending", reviewedAt: null, updatedAt: new Date() });
    expect(await requestToJoinProjectAction("p-1", "")).toEqual({ ok: false, error: expect.stringContaining("already asked") });
    expect(db.requestUpsert).not.toHaveBeenCalled();
  });

  it("treats a simultaneous duplicate (unique-key clash) as already asked", async () => {
    db.projectFindFirst.mockResolvedValue(closedPublic);
    db.requestUpsert.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    expect(await requestToJoinProjectAction("p-1", "")).toEqual({ ok: false, error: expect.stringContaining("already asked") });
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("makes someone who was declined wait a day before asking again, then lets them", async () => {
    db.projectFindFirst.mockResolvedValue(closedPublic);
    db.requestFindUnique.mockResolvedValue({ status: "rejected", reviewedAt: new Date(Date.now() - 60_000), updatedAt: new Date() });
    expect(await requestToJoinProjectAction("p-1", "")).toEqual({ ok: false, error: expect.stringContaining("declined") });
    expect(db.requestUpsert).not.toHaveBeenCalled();

    db.requestFindUnique.mockResolvedValue({
      status: "rejected",
      reviewedAt: new Date(Date.now() - DECLINED_REQUEST_COOLDOWN_MS - 60_000),
      updatedAt: new Date(),
    });
    expect(await requestToJoinProjectAction("p-1", "")).toEqual({ ok: true });
    expect(db.requestUpsert.mock.calls[0][0].update).toMatchObject({ status: "pending", reviewedBy: null, reviewedAt: null });
  });

  it("lets someone whose accepted membership was later removed ask again straight away", async () => {
    db.projectFindFirst.mockResolvedValue(closedPublic);
    db.requestFindUnique.mockResolvedValue({ status: "accepted", reviewedAt: new Date(), updatedAt: new Date() });
    expect(await requestToJoinProjectAction("p-1", "")).toEqual({ ok: true });
  });
});

describe("accepting and declining a request", () => {
  const pending = {
    id: "r-1",
    projectId: "p-1",
    userId: "user-1",
    status: "pending",
    project: { id: "p-1", slug: "web", name: "Web", organisationId: "org-1", organisation: { slug: "acme" } },
  };

  beforeEach(() => {
    auth.requireUser.mockResolvedValue({ id: "owner-1", name: "Olu", role: "user" });
    db.requestFindUnique.mockResolvedValue(pending);
    db.requestUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("lets an owner or admin accept, which adds a project membership (not an organisation one) and tells the applicant", async () => {
    perms.canManageProject.mockResolvedValue(true);
    await acceptJoinRequestAction(form("r-1"));
    expect(perms.canManageProject).toHaveBeenCalledWith(expect.objectContaining({ id: "owner-1" }), "org-1");
    expect(db.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r-1", status: "pending" }, data: expect.objectContaining({ status: "accepted", reviewedBy: "owner-1" }) }),
    );
    expect(db.projectMembershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { projectId: "p-1", userId: "user-1" } }),
    );
    expect(db.membershipUpsert).not.toHaveBeenCalled();
    expect(db.notificationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", kind: "join_request_accepted" }) });
  });

  it("refuses anyone who can't manage the project: nothing changes", async () => {
    perms.canManageProject.mockResolvedValue(false);
    await acceptJoinRequestAction(form("r-1"));
    await rejectJoinRequestAction(form("r-1"));
    expect(db.requestUpdateMany).not.toHaveBeenCalled();
    expect(db.projectMembershipUpsert).not.toHaveBeenCalled();
    expect(db.notificationCreate).not.toHaveBeenCalled();
  });

  it("decides a request only once: when another admin got there first, nothing more happens", async () => {
    perms.canManageProject.mockResolvedValue(true);
    db.requestUpdateMany.mockResolvedValue({ count: 0 });
    await acceptJoinRequestAction(form("r-1"));
    expect(db.projectMembershipUpsert).not.toHaveBeenCalled();
    expect(db.notificationCreate).not.toHaveBeenCalled();
    await rejectJoinRequestAction(form("r-1"));
    expect(db.notificationCreate).not.toHaveBeenCalled();
  });

  it("ignores a request that isn't pending any more", async () => {
    perms.canManageProject.mockResolvedValue(true);
    db.requestFindUnique.mockResolvedValue({ ...pending, status: "accepted" });
    await acceptJoinRequestAction(form("r-1"));
    await rejectJoinRequestAction(form("r-1"));
    expect(db.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("declining grants nothing and tells the applicant", async () => {
    perms.canManageProject.mockResolvedValue(true);
    await rejectJoinRequestAction(form("r-1"));
    expect(db.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r-1", status: "pending" }, data: expect.objectContaining({ status: "rejected" }) }),
    );
    expect(db.projectMembershipUpsert).not.toHaveBeenCalled();
    expect(db.notificationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", kind: "join_request_rejected" }) });
  });
});
