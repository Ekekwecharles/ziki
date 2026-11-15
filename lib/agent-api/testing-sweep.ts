import { prisma } from "@/lib/prisma";
import { deliverNotifications } from "@/lib/notify";
import { notifyAgentQuestion } from "@/lib/agent-notifications";
import { askOwnersToDecide } from "@/lib/agent-api/test-card";
import { cardBugSelect, checksFor, countsWithProof, loadProofRules } from "@/lib/proof";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Cron (#deeper-testing). Ziki brings testing to a person only when a person is needed:
 * - a row that waited a day for the deliverer's test goes to the owners instead, so it never waits forever;
 * - an agent that left two or more judgements without proof this week escalates to its owner, once a week
 *   (a single missed proof just doesn't count, and Ziki keeps asking the agent in its work feed);
 * - each agent owner gets a weekly line of what was handled without them, when there was something.
 */
export async function sweepTesting(now = new Date()): Promise<{ toOwners: number; escalated: number; summaries: number }> {
  const stale = await prisma.testCardRow.findMany({
    where: { route: "ci", proofAttachmentId: null, routedAt: { lt: new Date(now.getTime() - DAY) } },
    select: { id: true, text: true, bug: { select: { id: true, title: true, organisationId: true } } },
    orderBy: { routedAt: "asc" },
    take: 100,
  });
  for (const row of stale) {
    await prisma.testCardRow.update({ where: { id: row.id }, data: { route: "env", routedAt: now } });
    await askOwnersToDecide(prisma, row.bug, row.text);
  }

  // This week's judgements on delivered work, in organisations with checks.
  const week = new Date(now.getTime() - 7 * DAY);
  const verdicts = await prisma.testVerdict.findMany({
    where: { goodToMerge: true, updatedAt: { gt: week, lt: new Date(now.getTime() - 30 * 60 * 1000) }, bug: { isDeleted: false, organisation: { proofRules: { some: {} } } } },
    select: {
      headSha: true,
      goodToMerge: true,
      proof: true,
      pullRequestUrl: true,
      agent: { select: { id: true, name: true, ownerUserId: true } },
      bug: { select: { ...cardBugSelect, number: true, title: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 2000,
  });
  const rules = new Map<string, Awaited<ReturnType<typeof loadProofRules>>>();
  const byAgent = new Map<string, { agent: (typeof verdicts)[number]["agent"]; organisationId: string; given: number; unproven: (typeof verdicts)[number]["bug"][] }>();
  for (const v of verdicts) {
    if (v.pullRequestUrl !== v.bug.pullRequestUrl) continue;
    if (!rules.has(v.bug.organisationId)) rules.set(v.bug.organisationId, await loadProofRules(prisma, v.bug.organisationId));
    const entry = byAgent.get(v.agent.id) ?? { agent: v.agent, organisationId: v.bug.organisationId, given: 0, unproven: [] };
    entry.given += 1;
    if (!countsWithProof(v, checksFor(rules.get(v.bug.organisationId)!, v.bug), v.bug.pullRequestHeadSha)) entry.unproven.push(v.bug);
    byAgent.set(v.agent.id, entry);
  }

  let escalated = 0;
  for (const { agent, organisationId, unproven } of byAgent.values()) {
    if (unproven.length < 2) continue;
    const recent = await prisma.agentQuestion.findFirst({ where: { agentId: agent.id, body: { startsWith: "[proof]" }, createdAt: { gt: week } }, select: { id: true } });
    if (recent) continue;
    const list = unproven.map((b) => `#${b.number}`).join(", ");
    const question = await prisma.agentQuestion.create({
      data: {
        agentId: agent.id,
        ownerUserId: agent.ownerUserId,
        bugId: unproven[0].id,
        body: `[proof] ${agent.name} said good to merge without proof ${unproven.length} times this week (${list}) and didn't send it when Ziki asked. Those judgements don't count or earn, and nothing is held. Change its instructions so it attaches proof, or ask it to judge again.`,
      },
      select: { id: true, body: true },
    });
    notifyAgentQuestion({ id: question.id, body: question.body, organisationId, ownerUserId: agent.ownerUserId, agent: { name: agent.name }, bugId: unproven[0].id, bugTitle: unproven[0].title });
    escalated += 1;
  }

  // The weekly line, once a week per owner, only when something was handled.
  let summaries = 0;
  const owners = new Map<string, { organisationId: string; given: number; unproven: number }>();
  for (const { agent, organisationId, given, unproven } of byAgent.values()) {
    const o = owners.get(agent.ownerUserId) ?? { organisationId, given: 0, unproven: 0 };
    owners.set(agent.ownerUserId, { organisationId, given: o.given + given, unproven: o.unproven + unproven.length });
  }
  for (const [userId, o] of owners) {
    if (!o.unproven) continue;
    const sent = await prisma.notification.findFirst({ where: { userId, kind: "testing", title: { startsWith: "This week" }, createdAt: { gt: week } }, select: { id: true } });
    if (sent) continue;
    // Delivered now, not later, so the next run's check above sees it.
    await deliverNotifications({
      kind: "testing",
      actorId: null,
      actorName: "Ziki",
      recipientId: userId,
      organisationId: o.organisationId,
      subject: "This week, handled without you",
      message: `Your agents gave ${o.given} good-to-merge judgement${o.given === 1 ? "" : "s"} this week; ${o.unproven} had no proof, so ${o.unproven === 1 ? "it" : "they"} didn't count or earn. Ziki asked for the proof itself, and nothing was held.`,
    });
    summaries += 1;
  }
  return { toOwners: stale.length, escalated, summaries };
}
