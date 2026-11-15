"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireUser } from "@/lib/auth-helpers";
import { isAdminOfOrganisation } from "@/lib/agents/membership";
import { organisationAccessFor } from "@/lib/organisation-access";
import { currentOrganisationIdFor, NO_ORGANISATION_MESSAGE } from "@/lib/organisation-context";
import { prisma } from "@/lib/prisma";
import { BUILT_IN_CHECKS } from "@/lib/proof";
import { decideTestCardRow } from "@/lib/agent-api/test-card";

/**
 * Settings for deeper testing (#deeper-testing, lib/proof.ts). The
 * organisation's checks (every issue, per issue type, and the checks owners
 * write) are its owners' alone. A project's checks per area are its owners'
 * and admins', as the rest of project settings are.
 */

export type ProofActionResult = { ok: true } | { ok: false; error: string };

type Access = { ok: true; userId: string; organisationId: string } | { ok: false; error: string };

/** Who may change these rules: `projectId` null is the organisation's (owners only), else that project's (owners and admins). */
async function access(projectId: string | null): Promise<Access> {
  const user = await requireUser();
  const organisationId = await currentOrganisationIdFor(user.id);
  if (!organisationId) return { ok: false, error: NO_ORGANISATION_MESSAGE };
  if (projectId === null) {
    const { membershipRole } = await organisationAccessFor(user.id, organisationId, user.role);
    if (membershipRole !== "owner") return { ok: false, error: "Only the organisation's owners can change its checks." };
  } else {
    if (!(await isAdminOfOrganisation(user, organisationId))) return { ok: false, error: "Only organisation owners and admins can change a project's checks." };
    const project = await prisma.project.findFirst({ where: { id: projectId, organisationId }, select: { id: true } });
    if (!project) return { ok: false, error: "Project not found." };
  }
  return { ok: true, userId: user.id, organisationId };
}

async function done(a: Extract<Access, { ok: true }>, projectId: string | null, action: string, changes: object): Promise<ProofActionResult> {
  if (projectId) {
    await prisma.projectAuditEvent.create({ data: { organisationId: a.organisationId, projectId, actorUserId: a.userId, action, changes } });
  }
  revalidatePath("/[org]/[project]", "layout");
  revalidatePath("/projects/[slug]/settings", "page");
  return { ok: true };
}

const id = z.string().trim().min(1).max(191);

/** A rule for every issue (no type), one issue type, or one of a project's areas; one rule per scope. */
export async function addProofRuleAction(input: { projectId: string | null; issueTypeId?: string | null; projectAreaId?: string | null }): Promise<ProofActionResult> {
  const a = await access(input.projectId);
  if (!a.ok) return a;
  const issueTypeId = input.projectId ? null : (input.issueTypeId ?? null);
  const projectAreaId = input.projectId ? (input.projectAreaId ?? null) : null;
  if (input.projectId && !projectAreaId) return { ok: false, error: "A project's checks are per area." };
  if (issueTypeId && !(await prisma.issueType.findFirst({ where: { id: issueTypeId, organisationId: a.organisationId }, select: { id: true } }))) {
    return { ok: false, error: "Issue type not found." };
  }
  if (projectAreaId && !(await prisma.projectArea.findFirst({ where: { id: projectAreaId, projectId: input.projectId! }, select: { id: true } }))) {
    return { ok: false, error: "Area not found." };
  }
  const taken = await prisma.proofRule.findFirst({ where: { organisationId: a.organisationId, projectId: input.projectId, issueTypeId, projectAreaId }, select: { id: true } });
  if (taken) return { ok: false, error: "There is already a rule for that." };
  // Two people adding the same rule at once: the index keeps one (migration 20270129000001).
  const rule = await prisma.proofRule
    .create({ data: { organisationId: a.organisationId, projectId: input.projectId, issueTypeId, projectAreaId }, select: { id: true } })
    .catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
      throw error;
    });
  if (!rule) return { ok: false, error: "There is already a rule for that." };
  return done(a, input.projectId, "proof_rule.created", { ruleId: rule.id, issueTypeId, projectAreaId });
}

/** Set a rule's checks: built-in ids, or checks the organisation's owners wrote. */
export async function setProofRuleChecksAction(ruleId: string, checks: string[]): Promise<ProofActionResult> {
  const rule = await prisma.proofRule.findUnique({ where: { id: id.parse(ruleId) }, select: { id: true, projectId: true, organisationId: true, checks: true } });
  if (!rule) return { ok: false, error: "Rule not found." };
  const a = await access(rule.projectId);
  if (!a.ok || a.organisationId !== rule.organisationId) return a.ok ? { ok: false, error: "Rule not found." } : a;
  const custom = new Set((await prisma.proofCheck.findMany({ where: { organisationId: a.organisationId }, select: { id: true } })).map((c) => c.id));
  const next = [...new Set(checks)].filter((c) => c in BUILT_IN_CHECKS || custom.has(c));
  await prisma.proofRule.update({ where: { id: rule.id }, data: { checks: next } });
  return done(a, rule.projectId, "proof_rule.checks", { ruleId: rule.id, from: rule.checks, to: next });
}

export async function deleteProofRuleAction(ruleId: string): Promise<ProofActionResult> {
  const rule = await prisma.proofRule.findUnique({ where: { id: id.parse(ruleId) }, select: { id: true, projectId: true, organisationId: true } });
  if (!rule) return { ok: false, error: "Rule not found." };
  const a = await access(rule.projectId);
  if (!a.ok || a.organisationId !== rule.organisationId) return a.ok ? { ok: false, error: "Rule not found." } : a;
  await prisma.proofRule.delete({ where: { id: rule.id } });
  return done(a, rule.projectId, "proof_rule.deleted", { ruleId: rule.id });
}

const checkSchema = z.object({
  name: z.string().trim().min(2, "Name the check.").max(40),
  instructions: z.string().trim().min(10, "Say what the tester should do and what proof to attach.").max(1000),
  required: z.boolean(),
});

/**
 * A check in your own words. Written into a rule, it needs that rule's access
 * (the organisation's owners, or the project's owners and admins); on its own,
 * the organisation's owners. Either way it joins the organisation's checks.
 */
export async function writeProofCheckAction(input: { name: string; instructions: string; required: boolean; ruleId?: string }): Promise<ProofActionResult> {
  const target = input.ruleId ? await prisma.proofRule.findUnique({ where: { id: id.parse(input.ruleId) }, select: { projectId: true } }) : null;
  if (input.ruleId && !target) return { ok: false, error: "Rule not found." };
  const a = await access(target?.projectId ?? null);
  if (!a.ok) return a;
  const parsed = checkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
  const check = await prisma.proofCheck.create({ data: { organisationId: a.organisationId, ...parsed.data }, select: { id: true } });
  if (input.ruleId) {
    const rule = await prisma.proofRule.findFirst({ where: { id: input.ruleId, organisationId: a.organisationId }, select: { id: true, checks: true } });
    if (rule) await prisma.proofRule.update({ where: { id: rule.id }, data: { checks: [...rule.checks, check.id] } });
  }
  return done(a, target?.projectId ?? null, "proof_check.created", { checkId: check.id, ruleId: input.ruleId ?? null });
}

export async function setProofCheckRequiredAction(checkId: string, required: boolean): Promise<ProofActionResult> {
  const a = await access(null);
  if (!a.ok) return a;
  await prisma.proofCheck.updateMany({ where: { id: id.parse(checkId), organisationId: a.organisationId }, data: { required } });
  return done(a, null, "proof_check.updated", { checkId, required });
}

/** Delete a written check and take it out of every rule. */
export async function deleteProofCheckAction(checkId: string): Promise<ProofActionResult> {
  const a = await access(null);
  if (!a.ok) return a;
  const rules = await prisma.proofRule.findMany({ where: { organisationId: a.organisationId, checks: { has: checkId } }, select: { id: true, checks: true } });
  await prisma.$transaction([
    ...rules.map((r) => prisma.proofRule.update({ where: { id: r.id }, data: { checks: r.checks.filter((c) => c !== checkId) } })),
    prisma.proofCheck.deleteMany({ where: { id: checkId, organisationId: a.organisationId } }),
  ]);
  return done(a, null, "proof_check.deleted", { checkId });
}

/** A project's owner or admin settles a test-card row nobody can prove: waive it, or file it as an idea. */
export async function decideTestCardRowAction(bugId: string, rowId: string, decision: "waived" | "idea"): Promise<ProofActionResult> {
  const bug = await prisma.bug.findUnique({ where: { id: id.parse(bugId) }, select: { id: true, projectId: true, organisationId: true } });
  if (!bug) return { ok: false, error: "Issue not found." };
  const a = await access(bug.projectId);
  if (!a.ok) return a;
  if (a.organisationId !== bug.organisationId) return { ok: false, error: "Issue not found." };
  await decideTestCardRow(bug.id, id.parse(rowId), decision === "idea" ? "idea" : "waived");
  revalidatePath("/[org]/[project]", "layout");
  return { ok: true };
}
