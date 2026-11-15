import { issueHref } from "@/lib/issue-ref";
import { prisma } from "@/lib/prisma";
import { DECISION_MARKER, PLAIN, type Urgency, type YourCallAnswer, type YourCallItem } from "@/lib/your-call-shared";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * Your call (#your-call): the open issues a person has to settle
 * because the agents split on them. Two kinds:
 * - a delivered fix (Done · Requires review) whose judgements on the pull
 *   request now linked disagree: some say good to merge, some say not;
 * - a report (Open · Requires confirmation) whose confirmations disagree:
 *   some confirm it, some reject it.
 * When the agents agree, the rules move the issue on and it never shows here.
 */

const DAY = 24 * 60 * 60 * 1000;
/** A milestone due within this many days makes its stuck issues Critical. */
export const MILESTONE_SOON_DAYS = 7;
/** Split for longer than this, an issue is at least High. */
export const LONG_WAIT_DAYS = 7;

/** What urgency reads about one issue. */
export type UrgencySignals = {
  isBoosted: boolean;
  /** Importance marks (`Bug.voteCount`). */
  importance: number;
  milestone: { title: string; dueDate: Date | null } | null;
  /** When the agents split. */
  since: Date;
};

/**
 * The project's yardsticks: importance is judged against the project's other
 * open work, so a busy project doesn't turn everything Critical. Each is the
 * value an issue must reach (0 when nothing stands out).
 */
export type ProjectYardsticks = { topImportance: number; highImportance: number };

/** How many of the project's open issues sit on each importance value. */
export type ImportanceCount = { importance: number; count: number };

/**
 * The lowest value that puts an issue in the top `share` of the project's open
 * work, counted over all of it (issues with nothing marked are in the count but
 * never qualify). Ties never push more than the share in: when most issues sit
 * on the same value there is no cut-off (0) rather than a one that makes them all
 * top. 95 issues on 1 mark and 5 on 2: the top 10% is the five on 2, not all 100.
 */
export function topShare(groups: ImportanceCount[], share: number): number {
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const allowed = Math.floor(total * share);
  const values = groups.filter((g) => g.importance > 0).map((g) => g.importance).sort((x, y) => x - y);
  return values.find((v) => groups.reduce((sum, g) => sum + (g.importance >= v ? g.count : 0), 0) <= allowed) ?? 0;
}

export function yardsticksFor(groups: ImportanceCount[]): ProjectYardsticks {
  return { topImportance: topShare(groups, 0.1), highImportance: topShare(groups, 0.3) };
}

/**
 * How much the stuck issue holds the project back, and why:
 * - Critical: boosted, in a milestone due within 7 days (or overdue), or
 *   among the project's most important open issues (top 10% by importance);
 * - High: high importance (top 30%) or split for over a week;
 * - Medium: any importance marks;
 * - Low: everything else.
 */
export function urgencyOf(s: UrgencySignals, y: ProjectYardsticks, now = Date.now()): { urgency: Urgency; reasons: string[] } {
  const critical: string[] = [];
  if (s.isBoosted) critical.push("Boosted");
  if (s.milestone?.dueDate) {
    const days = Math.ceil((s.milestone.dueDate.getTime() - now) / DAY);
    if (days <= MILESTONE_SOON_DAYS) {
      critical.push(days < 0 ? `Milestone ${s.milestone.title} overdue` : days === 0 ? `Milestone ${s.milestone.title} due today` : `Milestone ${s.milestone.title} due in ${days} ${days === 1 ? "day" : "days"}`);
    }
  }
  if (s.importance > 0 && y.topImportance > 0 && s.importance >= y.topImportance) critical.push(`Among the most important (${s.importance} marks)`);
  if (critical.length) return { urgency: "critical", reasons: critical };

  const high: string[] = [];
  if (s.importance > 0 && y.highImportance > 0 && s.importance >= y.highImportance) high.push(`High importance (${s.importance} marks)`);
  const waited = Math.floor((now - s.since.getTime()) / DAY);
  if (waited > LONG_WAIT_DAYS) high.push(`Split for ${waited} days`);
  if (high.length) return { urgency: "high", reasons: high };

  const medium: string[] = [];
  if (s.importance > 0) medium.push(`${s.importance} importance ${s.importance === 1 ? "mark" : "marks"}`);
  if (medium.length) return { urgency: "medium", reasons: medium };

  return { urgency: "low", reasons: ["Nothing marks it as urgent yet"] };
}

const OPEN_WORK = ["open", "in_progress", "done", "merge"] as const;

/** Who is looking: the person, and whether they are an admin of the organisation (admins answer for any issue in it). */
export type YourCallViewer = { userId: string; isAdmin: boolean };

/** The answer written in a decision comment, read back from the words it was posted with. */
export function answerFrom(kind: "confirm" | "merge", body: string): YourCallAnswer | null {
  if (!body.startsWith(DECISION_MARKER)) return null;
  const text = body.slice(DECISION_MARKER.length).trim();
  if (text.startsWith(PLAIN[kind].yesSentence)) return "yes";
  if (text.startsWith(PLAIN[kind].noSentence)) return "no";
  return null;
}

/**
 * The issues in the project that the viewer has to settle: the ones they filed,
 * or any in the organisation when they are an admin. For each, what the agents
 * said and, when the person already answered, that answer (the issue stays
 * listed until the agents act on it, since the answer is a comment and does not
 * change a vote).
 */
export async function loadYourCall(projectId: string, viewer: YourCallViewer): Promise<YourCallItem[]> {
  const [issues, open] = await Promise.all([
    prisma.bug.findMany({
      where: {
        projectId, isDeleted: false, substatus: { in: ["requires_review", "requires_confirmation"] },
        ...(viewer.isAdmin ? {} : { OR: [{ reporterId: viewer.userId }, { beneficiaryUserId: viewer.userId }] }),
      },
      select: {
        id: true, number: true, title: true, summary: true, substatus: true, pullRequestUrl: true, pullRequestHeadSha: true, updatedAt: true,
        voteCount: true, isBoosted: true, reporterId: true, beneficiaryUserId: true,
        milestone: { select: { title: true, dueDate: true } },
        project: { select: { slug: true, organisation: { select: { slug: true } } } },
        // The people who delivered the fix: their own agents' judgements never count.
        deliveries: { select: { beneficiaryUserId: true, pullRequestUrl: true } },
        // A person's answer given here, by the one who may give it. Their words end up as a comment, and nothing else marks it.
        comments: { where: { deletedAt: null, body: { startsWith: DECISION_MARKER } }, orderBy: { createdAt: "desc" }, select: { authorId: true, body: true, createdAt: true } },
        testVerdicts: {
          orderBy: { createdAt: "asc" },
          select: {
            goodToMerge: true, summary: true, pullRequestUrl: true, headSha: true, createdAt: true, changedAt: true, updatedAt: true,
            agentId: true, onBehalfOfUserId: true, agent: { select: { name: true, ownerUserId: true } },
          },
        },
        confirmations: {
          where: { undoneAt: null, verdict: { in: ["confirm", "reject"] } },
          orderBy: { createdAt: "asc" },
          select: { verdict: true, summary: true, createdAt: true, agentId: true, agent: { select: { name: true } } },
        },
      },
    }),
    // The yardsticks: how the project's open work is spread over importance, counted in the database (one row per value).
    prisma.bug.groupBy({
      by: ["voteCount"],
      where: { projectId, isDeleted: false, status: { in: [...OPEN_WORK] } },
      _count: { _all: true },
    }),
  ]);
  const yardsticks = yardsticksFor(open.map((o) => ({ importance: o.voteCount, count: o._count._all })));

  const items: YourCallItem[] = [];
  for (const issue of issues) {
    const kind = issue.substatus === "requires_review" ? "merge" : "confirm";
    // The judgements that count are the ones on the pull request linked now, on its current head commit (a verdict on an
    // earlier commit says nothing about this one), and never from the people who delivered the fix. A changed verdict counts from when it changed.
    const credited = new Set(issue.deliveries.filter((d) => d.pullRequestUrl === issue.pullRequestUrl).map((d) => d.beneficiaryUserId));
    const votes =
      kind === "merge"
        ? issue.testVerdicts
            .filter((v) => v.pullRequestUrl === issue.pullRequestUrl)
            .filter((v) => !issue.pullRequestHeadSha || sameCommit(v.headSha, issue.pullRequestHeadSha))
            .filter((v) => !credited.has(v.agent.ownerUserId) && !credited.has(v.onBehalfOfUserId))
            .map((v) => ({ yes: v.goodToMerge, agentId: v.agentId, agentName: v.agent.name, says: v.summary, at: v.changedAt ?? v.createdAt }))
        : issue.confirmations.map((c) => ({
            yes: c.verdict === "confirm",
            agentId: c.agentId ?? `person-${c.createdAt.getTime()}`,
            agentName: c.agent?.name ?? "A person",
            says: c.summary,
            at: c.createdAt,
          }));
    const yes = votes.filter((v) => v.yes);
    const no = votes.filter((v) => !v.yes);
    if (!yes.length || !no.length) continue;
    // Waiting since the agents split: the vote that went against the one before it, in the order they were given.
    const ordered = [...votes].sort((a, b) => a.at.getTime() - b.at.getTime());
    const split = ordered.find((v) => v.yes !== ordered[0]!.yes)!;
    // An answer counts when the viewer or the one who filed the issue gave it after the split.
    const mine = issue.comments.find((c) => c.createdAt > split.at && (c.authorId === viewer.userId || c.authorId === issue.reporterId || c.authorId === issue.beneficiaryUserId));
    const { urgency, reasons } = urgencyOf(
      { isBoosted: issue.isBoosted, importance: issue.voteCount, milestone: issue.milestone, since: split.at },
      yardsticks,
    );
    items.push({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      summary: issue.summary,
      kind,
      urgency,
      reasons,
      yes: yes.map(({ agentId, agentName, says }) => ({ agentId, agentName, says })),
      no: no.map(({ agentId, agentName, says }) => ({ agentId, agentName, says })),
      since: split.at,
      href: issueHref(issue),
      answer: mine ? answerFrom(kind, mine.body) : null,
    });
  }
  return items;
}
