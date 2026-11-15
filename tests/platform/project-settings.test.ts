import { beforeEach, describe, expect, it, vi } from "vitest";

/** Project settings (#595, #vote-governance): only organisation admins change a project's workflow, values are range-checked, and a saved change takes effect at once. The marketing settings actions (M-UI-7) share the area, at the bottom. */
const requireUser = vi.hoisted(() => vi.fn());
const requireProject = vi.hoisted(() => vi.fn());
const isAdminOfOrganisation = vi.hoisted(() => vi.fn());
const assertMarketingSettingsAccess = vi.hoisted(() => vi.fn());
const updateMarketingSettings = vi.hoisted(() => vi.fn());
const typeFindFirst = vi.hoisted(() => vi.fn());
const typeCreate = vi.hoisted(() => vi.fn());
const typeUpdate = vi.hoisted(() => vi.fn());
const typeDelete = vi.hoisted(() => vi.fn());
const bugCount = vi.hoisted(() => vi.fn());
const ideaCount = vi.hoisted(() => vi.fn());
const bugActivityCreateMany = vi.hoisted(() => vi.fn());
const currentOrganisationIdFor = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const updateTag = vi.hoisted(() => vi.fn());
const invalidateWorkflow = vi.hoisted(() => vi.fn());
const projectFindMany = vi.hoisted(() => vi.fn());
const projectCreate = vi.hoisted(() => vi.fn());
const projectUpdate = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());
const organisationFindUnique = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn((to: string) => { throw new Error(`redirect:${to}`); }));
const findFirst = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn());
const previewUpsert = vi.hoisted(() => vi.fn());
const previewSettingsFindUnique = vi.hoisted(() => vi.fn());
const previewBuildCreate = vi.hoisted(() => vi.fn());
const previewBuildUpdate = vi.hoisted(() => vi.fn());
const githubSend = vi.hoisted(() => vi.fn());
const installationIdForRepo = vi.hoisted(() => vi.fn());
const auditCreate = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("not-found"); }));
const readinessGitHub = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath, updateTag }));
vi.mock("next/navigation", () => ({ redirect, notFound }));
vi.mock("@/lib/github/client", async (original) => ({ ...await original<typeof import("@/lib/github/client")>(), githubClientFor: readinessGitHub }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/project-route", () => ({ requireProject }));
vi.mock("@/lib/marketing/settings", () => ({ assertMarketingSettingsAccess, updateMarketingSettings }));
vi.mock("@/lib/agents/membership", () => ({
  isAdminOfOrganisation,
  isOrganisationAdminRole: vi.fn(),
}));
vi.mock("@/lib/organisation-context", () => ({
  currentOrganisationIdFor,
  NO_ORGANISATION_MESSAGE: "You're not a member of a organisation yet.",
}));
vi.mock("@/lib/workflow", () => ({ invalidateWorkflow }));
vi.mock("@/lib/github/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/client")>()),
  installationIdForRepo,
  githubClientFor: vi.fn(async () => ({ auth: "app", canWrite: true, get: vi.fn(), getOrNull: vi.fn(), send: githubSend })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst, findUnique: projectFindUnique, findMany: projectFindMany, create: projectCreate, update: projectUpdate },
    organisation: { findUnique: organisationFindUnique },
    projectWorkflow: { upsert },
    projectPreviewSettings: { upsert: previewUpsert, findUnique: previewSettingsFindUnique },
    previewBuild: { create: previewBuildCreate, update: previewBuildUpdate },
    projectAuditEvent: { create: auditCreate },
    issueType: { findFirst: typeFindFirst, create: typeCreate, update: typeUpdate, delete: typeDelete },
    bug: { count: bugCount },
    idea: { count: ideaCount },
    bugActivity: { createMany: bugActivityCreateMany },
    $transaction: transaction,
  },
}));

import { createProjectAction, updateProjectAction } from "@/app/(app)/projects/actions";
import { updateProjectWorkflowAction } from "@/app/(app)/projects/[slug]/settings/workflow-actions";
import { updateProjectPreviewSettingsAction } from "@/app/(app)/projects/[slug]/settings/preview-actions";
import { previewSettingsSchema } from "@/lib/validations/preview-settings";
import { startPreviewBuildIfDue } from "@/lib/previews/builds";
import { Prisma } from "@prisma/client";
import {
  createMarketingIssueTypeAction,
  deleteMarketingIssueTypeAction,
  updateMarketingRevisionLimitAction,
} from "@/app/(app)/[org]/[project]/marketing/settings/actions";
import { askMarketingAssistantAction, saveMarketingSiteAction } from "@/app/(app)/[org]/[project]/marketing/actions";
import { IssueApiError } from "@/lib/agent-api/errors";
import {
  DEFAULT_PROJECT_WORKFLOW,
  revisionLimitSchema,
  workflowSettingsSchema,
  workflowValues } from "@/lib/workflow-config";
import { projectRef } from "@/lib/project-paths";
import { recheckRepositories, checkDelivery } from "@/app/(app)/projects/readiness/actions";
import { loadRepositoryReadiness } from "@/lib/github/repository-readiness-query";

function form(values: Record<string, string | number | boolean> = {}) {
  const data = new FormData();
  data.set("slug", "web");
  const merged = {
    ideaThreshold: 3,
    // One more than the default (3), so a plain save is a change.
    confirmationsNeeded: 4,
    verdictsNeeded: 3,
    offerWindowSeconds: 1800,
    heartbeatMinutes: 240,
    deliveryMinutes: 240,
    maxActiveClaims: 10,
    volunteerWindowSeconds: 120,
    autoMerge: true,
    abandonCheckMinutes: 120,
    abandonThreshold: 3,
    closeThreshold: 3,
    governance: "manager",
    managerVoteWeight: 3,
    awardThreshold: 3,
    acceptThreshold: 3,
    stakeLimit: 2,
    stakeInProgressLimit: 2,
    planReviewSeconds: 7200,
    ...values,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "boolean") {
      if (value) data.set(key, "on");
    } else {
      data.set(key, String(value));
    }
  }
  return data;
}

const WEB = projectRef("acme", "web");

describe("organisation repository readiness access", () => {
  const input = { projectId: "p1", pullRequestUrl: "https://github.com/acme/mobile/pull/9" };
  const project = { id: "p1", name: "Mobile", slug: "mobile", repoUrl: "https://github.com/acme/mobile", githubInstallationId: "17", repositories: [], bugs: [] };
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "admin" });
    currentOrganisationIdFor.mockResolvedValue("org1");
    isAdminOfOrganisation.mockResolvedValue(true);
    projectFindMany.mockResolvedValue([]);
    findFirst.mockResolvedValue(null);
    readinessGitHub.mockRejectedValue(new Error("unexpected GitHub request"));
  });

  it("requires a signed-in user for the page and both actions before reading projects", async () => {
    requireUser.mockRejectedValue(new Error("redirect:/login"));
    for (const run of [loadRepositoryReadiness, recheckRepositories, () => checkDelivery(input)]) {
      await expect(run()).rejects.toThrow("redirect:/login");
    }
    expect(currentOrganisationIdFor).not.toHaveBeenCalled();
    expect(projectFindMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(readinessGitHub).not.toHaveBeenCalled();
  });

  it("denies non-admin members on the page, recheck and delivery actions before reading data", async () => {
    isAdminOfOrganisation.mockResolvedValue(false);
    for (const run of [loadRepositoryReadiness, recheckRepositories, () => checkDelivery(input)]) {
      await expect(run()).rejects.toThrow("not-found");
    }
    expect(projectFindMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(readinessGitHub).not.toHaveBeenCalled();
  });

  it("redirects a user with no organisation before any repository lookup", async () => {
    currentOrganisationIdFor.mockResolvedValue(null);
    await expect(loadRepositoryReadiness()).rejects.toThrow("redirect:/organisations");
    expect(projectFindMany).not.toHaveBeenCalled();
  });

  it("loads only active projects of the current organisation and returns a safe empty report", async () => {
    await expect(recheckRepositories()).resolves.toMatchObject({ ok: true, report: { organisationId: "org1", projects: [] } });
    expect(projectFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organisationId: "org1", archivedAt: null } }));
  });

  it("keeps remote failures on their project instead of losing the entire report", async () => {
    projectFindMany.mockResolvedValue([project, { ...project, id: "p2", repoUrl: null }]);
    const result = await loadRepositoryReadiness();
    expect(result).toMatchObject({ ok: true, report: { projects: [
      { id: "p1", repositories: [{ checks: expect.arrayContaining([expect.objectContaining({ state: "fail" })]) }] },
      { id: "p2", repositories: [{ checks: [expect.objectContaining({ code: "invalid_repository" })] }] },
    ] } });
    expect(JSON.stringify(result)).not.toContain("unexpected GitHub request");
  });

  it("does not allow an archived or different organisation's project ID to reach GitHub", async () => {
    await expect(checkDelivery(input)).resolves.toMatchObject({ ok: false });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1", organisationId: "org1", archivedAt: null } }));
    expect(readinessGitHub).not.toHaveBeenCalled();
  });

  it("rejects malformed action input before querying a project", async () => {
    await expect(checkDelivery({ projectId: "", pullRequestUrl: "" })).resolves.toMatchObject({ ok: false });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("checks a delivery against the organisation-scoped project's configuration", async () => {
    findFirst.mockResolvedValue({ ...project, repoUrl: "https://github.com/acme/desktop" });
    await expect(checkDelivery(input)).resolves.toMatchObject({ ok: true, delivery: { check: { code: "wrong_repository", state: "fail" } } });
    expect(readinessGitHub).not.toHaveBeenCalled();
  });

  it("does not expose database errors through either action", async () => {
    projectFindMany.mockRejectedValue(new Error("private database details"));
    findFirst.mockRejectedValue(new Error("private database details"));
    const results = [await recheckRepositories(), await checkDelivery(input)];
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(JSON.stringify(results)).not.toContain("private database details");
  });
});

describe("updateProjectWorkflowAction (#595)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "admin" });
    isAdminOfOrganisation.mockResolvedValue(true);
    currentOrganisationIdFor.mockResolvedValue("organisation-1");
    findFirst.mockResolvedValue({ id: "project-1", slug: "web", workflow: null });
    transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
      run({
        projectWorkflow: { upsert },
        projectAuditEvent: { create: auditCreate },
      }),
    );
  });

  it("refuses a member who is not an admin", async () => {
    isAdminOfOrganisation.mockResolvedValue(false);
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toMatchObject({ ok: false });
    expect(findFirst).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range value without writing", async () => {
    await expect(updateProjectWorkflowAction(undefined, form({ confirmationsNeeded: 6 }))).resolves.toMatchObject({
      ok: false,
      fieldErrors: { confirmationsNeeded: expect.stringContaining("at most 5") },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("saves a change, audits it and invalidates the cache", async () => {
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith({
      where: { projectId: "project-1" },
      update: expect.objectContaining({ confirmationsNeeded: 4 }),
      create: expect.objectContaining({ projectId: "project-1", confirmationsNeeded: 4 }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organisationId: "organisation-1",
        projectId: "project-1",
        actorUserId: "admin",
        action: "workflow.updated",
        changes: { confirmationsNeeded: { from: 3, to: 4 } },
      }),
    });
    expect(invalidateWorkflow).toHaveBeenCalledWith("project-1");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
  });

  it("saves the vote governance settings, and refuses an unknown mode (#vote-governance)", async () => {
    await expect(
      updateProjectWorkflowAction(undefined, form({ governance: "threshold", managerVoteWeight: 4, awardThreshold: 5, acceptThreshold: 6 })),
    ).resolves.toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ governance: "threshold", managerVoteWeight: 4, awardThreshold: 5, acceptThreshold: 6 }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changes: expect.objectContaining({
          governance: { from: "manager", to: "threshold" },
          managerVoteWeight: { from: 3, to: 4 },
          awardThreshold: { from: 3, to: 5 },
          acceptThreshold: { from: 3, to: 6 },
        }),
      }),
    });
    transaction.mockClear();
    await expect(updateProjectWorkflowAction(undefined, form({ governance: "anarchy" }))).resolves.toMatchObject({
      ok: false,
      fieldErrors: { governance: expect.any(String) },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not report success when persistence fails", async () => {
    transaction.mockRejectedValueOnce(new Error("database down"));
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toMatchObject({ ok: false });
    expect(invalidateWorkflow).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("leaves the marketing revision limit alone when the product settings are saved", async () => {
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toEqual({ ok: true });
    const saved = upsert.mock.calls[0][0];
    expect(saved.update).not.toHaveProperty("revisionLimit");
    expect(saved.create).not.toHaveProperty("revisionLimit");
  });

  it("does not touch a project outside the organisation", async () => {
    findFirst.mockResolvedValue(null);
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toMatchObject({
      ok: false,
      error: expect.any(String),
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("createProjectAction", () => {
  it("creates a project when the contributor guidelines are left empty", async () => {
    requireUser.mockResolvedValue({ id: "owner", role: "user" });
    currentOrganisationIdFor.mockResolvedValue("org");
    isAdminOfOrganisation.mockResolvedValue(true);
    projectFindMany.mockResolvedValue([]);
    projectCreate.mockResolvedValue({ id: "p1" });
    organisationFindUnique.mockResolvedValue({ slug: "acme" });
    const data = new FormData();
    data.set("name", "Mobile app");
    data.set("visibility", "private");
    await expect(createProjectAction(undefined, data)).rejects.toThrow("redirect:");
    expect(projectCreate).toHaveBeenCalledOnce();
    expect(projectCreate.mock.calls[0][0].data).toMatchObject({ name: "Mobile app", slug: "mobile-app", contributorGuidelines: null });
  });
});

describe("public issue intake project setting (#3464)", () => {
  function settingsForm(visibility: "public" | "private") {
    const data = new FormData();
    data.set("slug", "web");
    data.set("name", "Web");
    data.set("goal", "Build the public web application.");
    data.set("repoUrl", "https://github.com/acme/web");
    data.set("stagingUrl", "https://staging.acme.test");
    data.set("siteUrl", "https://acme.test");
    data.set("visibility", visibility);
    data.set("acceptsGuestIdeas", "true");
    data.set("contributorGuidelines", "Read CONTRIBUTING.md first.");
    return data;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "admin", role: "user" });
    currentOrganisationIdFor.mockResolvedValue("organisation-1");
    isAdminOfOrganisation.mockResolvedValue(true);
    findFirst.mockResolvedValue({
      id: "project-1",
      name: "Web",
      goal: "Build the public web application.",
      repoUrl: "https://github.com/acme/web",
      stagingUrl: "https://staging.acme.test",
      siteUrl: "https://acme.test",
      visibility: "private",
      isOpenForContributors: false,
      acceptsGuestIdeas: false,
      contributorGuidelines: "Read CONTRIBUTING.md first.",
      rewardConfig: null,
    });
    transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({
      project: { update: projectUpdate },
      projectAuditEvent: { create: auditCreate },
    }));
  });

  it("lets an admin opt a public project into signed-out reports and audits the change", async () => {
    await expect(updateProjectAction(undefined, settingsForm("public"))).resolves.toEqual({});

    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ visibility: "public", acceptsGuestIdeas: true }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "settings.updated",
        changes: expect.objectContaining({
          visibility: { from: "private", to: "public" },
          acceptsGuestIdeas: { from: false, to: true },
        }),
      }),
    });
  });

  it("forces signed-out reporting off when a project becomes private", async () => {
    findFirst.mockResolvedValueOnce({
      id: "project-1",
      name: "Web",
      goal: "Build the public web application.",
      repoUrl: "https://github.com/acme/web",
      stagingUrl: "https://staging.acme.test",
      siteUrl: "https://acme.test",
      visibility: "public",
      isOpenForContributors: false,
      acceptsGuestIdeas: true,
      contributorGuidelines: "Read CONTRIBUTING.md first.",
      rewardConfig: null,
    });

    await expect(updateProjectAction(undefined, settingsForm("private"))).resolves.toEqual({});
    expect(projectUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ visibility: "private", acceptsGuestIdeas: false }),
    }));
  });
});

describe("project workflow defaults (#595)", () => {

  it("uses defaults for a missing row", () => {
    expect(workflowValues(null)).toEqual(DEFAULT_PROJECT_WORKFLOW);
    expect(workflowValues({ confirmationsNeeded: 4 })).toMatchObject({
      confirmationsNeeded: 4,
      verdictsNeeded: 3,
      autoMerge: true,
    });
  });
});

describe("workflowSettingsSchema (#595)", () => {
  const valid = { ...DEFAULT_PROJECT_WORKFLOW };

  it("refuses values outside the documented ranges", () => {
    for (const [field, value] of [
      ["confirmationsNeeded", 0],
      ["confirmationsNeeded", 6],
      ["verdictsNeeded", 0],
      ["verdictsNeeded", 6],
      ["offerWindowSeconds", 29],
      ["offerWindowSeconds", 3601],
      ["abandonCheckMinutes", -1],
      ["abandonCheckMinutes", 10081],
      ["abandonThreshold", 0],
      ["abandonThreshold", 101],
      ["closeThreshold", 0],
      ["closeThreshold", 101],
    ] as const) {
      expect(workflowSettingsSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
    }
  });

});

describe("the marketing revision limit", () => {
  it("is 2 until a project sets its own", () => {
    expect(workflowValues(null).revisionLimit).toBe(2);
    expect(workflowValues({ revisionLimit: 4 }).revisionLimit).toBe(4);
  });

  it("refuses a limit outside 1 to 10", () => {
    for (const value of [0, 11, 1.5]) expect(revisionLimitSchema.safeParse(value).success).toBe(false);
    for (const value of [1, 10]) expect(revisionLimitSchema.safeParse(value).success).toBe(true);
  });

  it("reads the project's stored limit", async () => {
    const { workflowFor } = await vi.importActual<typeof import("@/lib/workflow")>("@/lib/workflow");
    const stored = { projectWorkflow: { findUnique: vi.fn(async () => ({ revisionLimit: 5 })) } };
    await expect(workflowFor("project-1", stored as never)).resolves.toMatchObject({ revisionLimit: 5 });
    expect(stored.projectWorkflow.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ revisionLimit: true }) }),
    );
  });
});

describe("the marketing settings actions (M-UI-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireProject.mockResolvedValue({
      user: { id: "admin", role: null },
      organisationId: "organisation-1",
      project: { id: "project-1", slug: "web", name: "Web", organisationId: "organisation-1" },
    });
    assertMarketingSettingsAccess.mockResolvedValue(undefined);
    typeFindFirst.mockResolvedValue(null);
  });

  function revisionForm(value: string | number) {
    const data = new FormData();
    data.set("revisionLimit", String(value));
    return data;
  }

  function typeForm(values: Record<string, string> = {}) {
    const data = new FormData();
    data.set("name", values.name ?? "Email newsletter");
    data.set("description", values.description ?? "");
    data.set("isActive", "true");
    return data;
  }

  it("saves the revision limit through the marketing lib and revalidates the section", async () => {
    updateMarketingSettings.mockResolvedValue({ projectId: "project-1", slug: "web", name: "Web", revisionLimit: 3 });
    await expect(updateMarketingRevisionLimitAction(WEB, revisionForm(3))).resolves.toEqual({ ok: true });
    expect(updateMarketingSettings).toHaveBeenCalledWith("organisation-1", "project-1", "admin", { revisionLimit: 3 });
    expect(revalidatePath).toHaveBeenCalledWith("/acme/web/marketing/settings");
  });

  it("refuses a limit outside 1 to 10 without saving", async () => {
    await expect(updateMarketingRevisionLimitAction(WEB, revisionForm(11))).resolves.toMatchObject({
      error: expect.any(String),
    });
    expect(updateMarketingSettings).not.toHaveBeenCalled();
  });

  it("refuses a member before saving", async () => {
    assertMarketingSettingsAccess.mockRejectedValue(
      new IssueApiError(403, "Only organisation owners and admins can change marketing settings."),
    );
    await expect(updateMarketingRevisionLimitAction(WEB, revisionForm(3))).resolves.toMatchObject({
      error: expect.stringContaining("owners and admins"),
    });
    expect(updateMarketingSettings).not.toHaveBeenCalled();
  });

  it("stores a new type on the marketing track", async () => {
    await expect(createMarketingIssueTypeAction(WEB, typeForm({ name: "Email newsletter" }))).resolves.toEqual({
      ok: true,
    });
    expect(typeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organisationId: "organisation-1", name: "Email newsletter", track: "marketing" }),
      }),
    );
  });

  it("stores a type as inactive when the Active box is unticked", async () => {
    const form = typeForm({ name: "Email newsletter" });
    form.delete("isActive");
    await expect(createMarketingIssueTypeAction(WEB, form)).resolves.toEqual({ ok: true });
    expect(typeCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }));
  });

  it("refuses a name a type already uses, across tracks", async () => {
    typeFindFirst.mockResolvedValueOnce({ name: "Blog post" });
    await expect(createMarketingIssueTypeAction(WEB, typeForm({ name: "blog post" }))).resolves.toMatchObject({
      error: expect.stringContaining("Blog post"),
    });
    expect(typeCreate).not.toHaveBeenCalled();
  });

  it("refuses to delete a type marketing tasks still use, and says to deactivate instead", async () => {
    typeFindFirst.mockResolvedValue({ id: "type-1" });
    bugCount.mockResolvedValue(2);
    ideaCount.mockResolvedValue(0);
    await expect(deleteMarketingIssueTypeAction(WEB, "type-1")).resolves.toMatchObject({
      error: expect.stringContaining("Deactivate it instead"),
    });
    expect(typeDelete).not.toHaveBeenCalled();
  });

  it("deletes a type no task uses", async () => {
    typeFindFirst.mockResolvedValue({ id: "type-1" });
    bugCount.mockResolvedValue(0);
    ideaCount.mockResolvedValue(0);
    await expect(deleteMarketingIssueTypeAction(WEB, "type-1")).resolves.toEqual({ ok: true });
    expect(typeDelete).toHaveBeenCalledWith({ where: { id: "type-1" } });
  });

  it("creating a type never writes task activity", async () => {
    await expect(createMarketingIssueTypeAction(WEB, typeForm({ name: "Social post" }))).resolves.toEqual({
      ok: true,
    });
    expect(bugActivityCreateMany).not.toHaveBeenCalled();
  });
});

function previewForm(values: Record<string, string | boolean> = {}) {
  const data = new FormData();
  data.set("slug", "web");
  const merged: Record<string, string | boolean> = {
    enabled: true,
    rootDir: ".",
    installCommand: "",
    buildCommand: "npm run build",
    outputDir: "dist",
    nodeVersion: "22",
    buildVariables: "VITE_API_URL=https://staging.example.com",
    ...values,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "boolean") {
      if (value) data.set(key, "on");
    } else {
      data.set(key, value);
    }
  }
  return data;
}

describe("updateProjectPreviewSettingsAction (#previews)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "admin" });
    isAdminOfOrganisation.mockResolvedValue(true);
    currentOrganisationIdFor.mockResolvedValue("organisation-1");
    findFirst.mockResolvedValue({ id: "project-1", slug: "web", repoUrl: "https://github.com/acme/web", previewSettings: null });
    transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
      run({ projectPreviewSettings: { upsert: previewUpsert }, projectAuditEvent: { create: auditCreate } }),
    );
  });

  it("refuses a member who is not an admin before reading the project", async () => {
    isAdminOfOrganisation.mockResolvedValue(false);
    await expect(updateProjectPreviewSettingsAction(undefined, previewForm())).resolves.toMatchObject({ ok: false });
    expect(findFirst).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses to turn previews on for a project with no main repository", async () => {
    findFirst.mockResolvedValue({ id: "project-1", slug: "web", repoUrl: null, previewSettings: null });
    await expect(updateProjectPreviewSettingsAction(undefined, previewForm())).resolves.toMatchObject({
      ok: false,
      fieldErrors: { enabled: expect.any(String) },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("saves the settings with their build variables, and audits the change", async () => {
    await expect(updateProjectPreviewSettingsAction(undefined, previewForm())).resolves.toEqual({ ok: true });
    const saved = previewUpsert.mock.calls[0][0];
    expect(saved.where).toEqual({ projectId: "project-1" });
    expect(saved.create).toMatchObject({
      projectId: "project-1",
      enabled: true,
      installCommand: null,
      outputDir: "dist",
      buildVariables: { VITE_API_URL: "https://staging.example.com" },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organisationId: "organisation-1",
        projectId: "project-1",
        actorUserId: "admin",
        action: "previews.updated",
        changes: {
          enabled: { from: false, to: true },
          buildVariables: { from: {}, to: { VITE_API_URL: "https://staging.example.com" } },
        },
      }),
    });
    expect(revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
  });

  it("does not touch a project outside the organisation", async () => {
    findFirst.mockResolvedValue(null);
    await expect(updateProjectPreviewSettingsAction(undefined, previewForm())).resolves.toMatchObject({ ok: false });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("saveMarketingSiteAction (#marketing-home)", () => {
  const slug = projectRef("acme", "web");
  const site = (siteUrl: string) => form({ siteUrl });

  beforeEach(() => {
    vi.clearAllMocks();
    requireProject.mockResolvedValue({ user: { id: "admin" }, organisationId: "organisation-1", project: { id: "project-1" }, isOrgAdmin: true });
    projectFindUnique.mockResolvedValue({ siteUrl: null });
    transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
      run({ project: { update: projectUpdate }, projectAuditEvent: { create: auditCreate } }),
    );
  });

  it("refuses a member who is not an organisation admin", async () => {
    requireProject.mockResolvedValue({ user: { id: "member" }, organisationId: "organisation-1", project: { id: "project-1" }, isOrgAdmin: false });
    await expect(saveMarketingSiteAction(slug, undefined, site("https://acme.dev"))).resolves.toMatchObject({ error: expect.any(String) });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses an empty, plain-http or example address", async () => {
    for (const address of ["", "http://acme.dev", "https://example.com"]) {
      await expect(saveMarketingSiteAction(slug, undefined, site(address))).resolves.toMatchObject({ error: expect.any(String) });
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("lets only organisation admins talk to the marketing assistant", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    requireProject.mockResolvedValue({ user: { id: "member" }, organisationId: "organisation-1", project: { id: "project-1" }, isOrgAdmin: false });
    await expect(askMarketingAssistantAction(slug, [{ role: "user", text: "Why don't people sign up?" }])).resolves.toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(projectFindUnique).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("sets the project's site and audits the change", async () => {
    await expect(saveMarketingSiteAction(slug, undefined, site("https://acme.dev"))).resolves.toEqual({ ok: true });
    expect(projectUpdate).toHaveBeenCalledWith({ where: { id: "project-1" }, data: { siteUrl: "https://acme.dev" } });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: "project-1", actorUserId: "admin", changes: { siteUrl: { from: null, to: "https://acme.dev" } } }),
    });
  });
});

describe("previewSettingsSchema (#previews)", () => {
  const valid = {
    enabled: true,
    rootDir: ".",
    installCommand: "",
    buildCommand: "npm run build",
    outputDir: "dist",
    nodeVersion: "22",
    buildVariables: "",
  };

  it("refuses folders that leave the repository", () => {
    expect(previewSettingsSchema.safeParse({ ...valid, outputDir: "../secrets" }).success).toBe(false);
    expect(previewSettingsSchema.safeParse({ ...valid, rootDir: "/etc" }).success).toBe(false);
  });

  it("refuses a malformed or repeated build variable", () => {
    expect(previewSettingsSchema.safeParse({ ...valid, buildVariables: "not a variable" }).success).toBe(false);
    expect(previewSettingsSchema.safeParse({ ...valid, buildVariables: "A=1\nA=2" }).success).toBe(false);
  });

  it("refuses a build variable the build machine owns", () => {
    expect(previewSettingsSchema.safeParse({ ...valid, buildVariables: "GITHUB_TOKEN=x" }).success).toBe(false);
    expect(previewSettingsSchema.safeParse({ ...valid, buildVariables: "PATH=/tmp" }).success).toBe(false);
  });
});

describe("startPreviewBuildIfDue (#previews)", () => {
  const HEAD = "a".repeat(40);
  const trigger = {
    bugId: "bug1",
    projectId: "p1",
    issueStatus: "done",
    repoUrl: "https://github.com/acme/web",
    pullRequestUrl: "https://github.com/acme/web/pull/7",
    state: "open",
    headSha: HEAD,
  };
  const enabled = {
    enabled: true, rootDir: ".", installCommand: null, buildCommand: "npm run build",
    outputDir: "dist", nodeVersion: "22", buildVariables: { VITE_API_URL: "https://api.example.com" },
  };

  beforeEach(() => {
    vi.stubEnv("PREVIEW_BUILDER_REPO", "ziki/ziki-preview-builder");
    previewSettingsFindUnique.mockReset().mockResolvedValue(enabled);
    previewBuildCreate.mockReset().mockResolvedValue({ id: "build1" });
    previewBuildUpdate.mockReset().mockResolvedValue({});
    githubSend.mockReset().mockResolvedValue({ workflow_run_id: 99, html_url: "https://github.com/ziki/ziki-preview-builder/actions/runs/99" });
    installationIdForRepo.mockReset().mockResolvedValue("555");
  });

  it("starts the builder for a new commit with the project's settings", async () => {
    expect(await startPreviewBuildIfDue(trigger)).toBe("started");
    expect(previewBuildCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bugId: "bug1", repository: "acme/web", pullNumber: 7, headSha: HEAD }),
    }));
    expect(installationIdForRepo).toHaveBeenCalledWith("ziki", "ziki-preview-builder");
    const [, path, body] = githubSend.mock.calls[0];
    expect(path).toBe("/repos/ziki/ziki-preview-builder/actions/workflows/preview.yml/dispatches");
    expect(body.inputs).toMatchObject({
      build_id: "build1", repository: "acme/web", ref: HEAD, pr: "7", install_command: "",
      build_variables: JSON.stringify({ VITE_API_URL: "https://api.example.com" }),
    });
    expect(previewBuildUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "building", runId: "99" }) }));
  });

  it("builds nothing while previews are off, or for another repository or a closed pull request", async () => {
    previewSettingsFindUnique.mockResolvedValueOnce({ ...enabled, enabled: false });
    expect(await startPreviewBuildIfDue(trigger)).toBe("skipped");
    expect(await startPreviewBuildIfDue({ ...trigger, pullRequestUrl: "https://github.com/acme/api/pull/7" })).toBe("skipped");
    expect(await startPreviewBuildIfDue({ ...trigger, state: "closed" })).toBe("skipped");
    expect(previewBuildCreate).not.toHaveBeenCalled();
    expect(githubSend).not.toHaveBeenCalled();
  });

  it("starts one build per commit", async () => {
    previewBuildCreate.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }));
    expect(await startPreviewBuildIfDue(trigger)).toBe("skipped");
    expect(githubSend).not.toHaveBeenCalled();
  });

  it("records the build as failed when the builder can't be started", async () => {
    installationIdForRepo.mockResolvedValueOnce(null);
    expect(await startPreviewBuildIfDue(trigger)).toBe("failed");
    expect(previewBuildUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
  });
});
