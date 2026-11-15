import type { Status } from "@prisma/client";
import { commentPermalinkPath } from "@/lib/comment-window";
import { statusLabel } from "@/lib/labels";

/**
 * Notifications (#151, #216). Planning is pure (and unit-tested); delivery
 * lives in lib/notify.ts so server actions can hand it to `after()`. Each
 * planned notification is shown in the in-app feed and, if the person wants
 * email and SMTP is set up, emailed.
 *
 * Rules: nobody is told about their own action, each person gets at most one
 * email per event, and deleted issues never notify (the actions that raise
 * these events already refuse to act on them).
 */

type Base = { actorId: string; actorName: string; bugId: string; bugTitle: string };

/**
 * Events raised for a person by an agent or by the platform (#443). The actor
 * may be an agent or nobody, so `actorId` is null unless a person did it, and
 * an issue is optional (a question or an invite need not be about one). Each
 * names exactly one recipient.
 */
type AgentBase = {
  actorId: string | null;
  actorName: string;
  recipientId: string;
  organisationId?: string;
  bugId?: string | null;
  bugTitle?: string | null;
};

export type NotificationEvent =
  | (Base & {
      kind: "mentioned";
      recipientIds: string[];
      /** Where the mention was written. */
      place: "description" | "comment";
      excerpt?: string;
      /** Set for mentions in a comment, so the link jumps to it. */
      commentId?: string;
    })
  | (Base & {
      kind: "comment_added";
      commentId: string;
      excerpt?: string;
      /** Author of the comment being replied to, if any. */
      parentAuthorId?: string | null;
      /**
       * Everyone to tell: the issue's watchers (resolved at delivery from
       * reporter, assignee and watch rows, see lib/watch.ts).
       */
      recipientIds: string[];
      /** Already told by a "mentioned" notification for the same comment. */
      excludeIds?: string[];
    })
  | (Base & {
      kind: "assignee_changed";
      fromUserId: string | null;
      toUserId: string | null;
    })
  | (Base & {
      kind: "status_changed";
      reporterId: string;
      from: Status;
      to: Status;
      /** What happened, written by whoever resolved or closed it (#316). */
      note?: string | null;
      /** Watchers to tell, resolved at delivery; defaults to the reporter. */
      recipientIds?: string[];
    })
  | (AgentBase & {
      /** An agent asked its owner something (#446). */
      kind: "agent_question";
      questionId: string;
      excerpt?: string;
      /** #606: the question is still unanswered and the agent's claim is paused on it. */
      reminder?: boolean;
    })
  | (AgentBase & {
      /** A redesign is waiting for this person to approve it (#431). */
      kind: "approval_needed";
      proposalId: string;
      proposalTitle: string;
    })
  | (AgentBase & {
      /** Someone invited this person to a organisation (#444). */
      kind: "organisation_invite";
      inviteId: string;
      organisationName: string;
    })
  | (AgentBase & {
      /** The platform offered this person an issue (#449). */
      kind: "claim_offered";
      claimId: string;
      bugId: string;
      bugTitle: string;
    })
  | (AgentBase & {
      /** One-time notice that this contributor is eligible to become a reviewer (#659). */
      kind: "reviewer_eligible";
    })
  | (AgentBase & {
      /** A linked pull request could not be merged after acceptance (#452). */
      kind: "merge_failed";
      /** Why the merge did not happen, already human-readable. */
      reason: string;
    })
  | (AgentBase & {
      /** An agent submitted its plan on a complex issue and its owner must approve it (#plan-review). */
      kind: "plan_submitted";
      planId: string;
      round: number;
    })
  | (AgentBase & {
      /**
       * Deeper testing (#deeper-testing): a test-card row only the project's owners
       * can settle, or an agent owner's weekly summary. `message` is the whole line.
       */
      kind: "testing";
      subject: string;
      message: string;
    });

/** The kinds raised by agents and the platform rather than by issue edits. */
export const AGENT_NOTIFICATION_KINDS = [
  "agent_question",
  "approval_needed",
  "organisation_invite",
  "claim_offered",
  "reviewer_eligible",
  "merge_failed",
  "plan_submitted",
  "testing",
] as const;

export type PlannedNotification = {
  userId: string;
  kind: NotificationEvent["kind"];
  /** Email subject. */
  subject: string;
  /** One-line summary for the in-app feed. */
  title: string;
  /** App-relative link for the in-app feed. */
  url: string;
  text: string;
};

const quote = (title: string) => `“${title.length > 80 ? `${title.slice(0, 79)}…` : title}”`;

function body(
  lines: (string | false | undefined)[],
  openUrl: string,
  settingsUrl: string,
  openLabel = "Open the issue",
) {
  return [
    ...lines.filter((line): line is string => typeof line === "string"),
    "",
    `${openLabel}: ${openUrl}`,
    "",
    `You can turn these emails off in Settings: ${settingsUrl}`,
  ].join("\n");
}

/**
 * Where an agent or platform event links to, and what to call that link.
 * `issuePath` is the event's issue address, or null when it has none.
 */
function agentTarget(event: Extract<NotificationEvent, AgentBase>, issuePath: string | null): { path: string; label: string } {
  switch (event.kind) {
    case "agent_question":
      return { path: `/questions/${event.questionId}`, label: "Answer the question" };
    case "approval_needed":
      return { path: `/redesigns/${event.proposalId}`, label: "Review the proposal" };
    case "organisation_invite":
      return { path: `/organisations?invite=${encodeURIComponent(event.inviteId)}`, label: "See the invite" };
    case "claim_offered":
      return { path: issuePath ?? "/home", label: "Open the issue" };
    case "reviewer_eligible":
      return { path: "/settings/agents", label: "Manage agents" };
    case "merge_failed":
      return { path: issuePath ?? "/home", label: "Open the issue" };
    case "plan_submitted":
      return { path: issuePath ? `${issuePath}#plan` : "/home", label: "Review the plan" };
    case "testing":
      return issuePath ? { path: `${issuePath}#test-card`, label: "Open the test card" } : { path: "/inbox", label: "Open your inbox" };
  }
}

function planAgentNotification(
  event: Extract<NotificationEvent, AgentBase>,
  base: string,
  issuePath: string | null,
): PlannedNotification[] {
  if (!event.recipientId || event.recipientId === event.actorId) return [];
  const { path, label } = agentTarget(event, issuePath);
  const about = event.bugTitle ? ` about ${quote(event.bugTitle)}` : "";
  let subject: string;
  let lines: (string | false | undefined)[];
  switch (event.kind) {
    case "agent_question":
      subject = event.reminder
        ? `Reminder: ${event.actorName} is still waiting for your answer${about}`
        : `${event.actorName} has a question for you${about}`;
      lines = [
        `${event.actorName}, an agent working for you, asked you a question${about}.`,
        event.reminder && "Its work on the issue is paused until you answer.",
        event.excerpt ? `\n> ${event.excerpt}` : undefined,
      ];
      break;
    case "approval_needed":
      subject = `${event.actorName} needs your approval for ${quote(event.proposalTitle)}`;
      lines = [
        `${event.actorName} proposed a redesign, ${quote(event.proposalTitle)}, on your behalf${about}.`,
        "It stays blocked until a person approves or rejects it.",
      ];
      break;
    case "organisation_invite":
      subject = `${event.actorName} invited you to ${event.organisationName}`;
      lines = [`${event.actorName} invited you to join ${event.organisationName} on Ziki.`];
      break;
    case "claim_offered":
      subject = `You've been offered ${quote(event.bugTitle)}`;
      lines = [
        `${event.actorName} offered you ${quote(event.bugTitle)}. Your agent has a minute to accept it, or it goes to the next person.`,
      ];
      break;
    case "reviewer_eligible":
      subject = `${event.actorName} is eligible to become a reviewer`;
      lines = [
        `${event.actorName} has reached the standing-validation threshold for reviewer eligibility. Its current role has not changed.`,
        "You can choose its role in agent settings.",
      ];
      break;
    case "merge_failed": {
      const title = event.bugTitle ?? "this issue";
      subject = `The fix for ${quote(title)} could not be merged`;
      lines = [
        `The fix for ${quote(title)} was accepted on Ziki, but the pull request could not be merged.`,
        event.reason,
        "Nothing was changed on the tracker: the acceptance and the points stay.",
      ];
      break;
    }
    case "testing":
      subject = event.subject;
      lines = [event.message];
      break;
    case "plan_submitted": {
      const title = event.bugTitle ?? "this issue";
      subject = event.round > 1
        ? `${event.actorName} revised its plan for ${quote(title)}: approve it or send it back`
        : `${event.actorName}'s plan for ${quote(title)} needs your approval`;
      lines = [
        `${event.actorName}, an agent working for you, was awarded ${quote(title)}, a complex issue, and wrote its plan.`,
        "Read how it understood the task and the steps it will take. Edit the steps if you like, then approve the plan or send it back. Nothing starts until you do, and the award lapses if the window runs out.",
      ];
      break;
    }
  }
  return [
    {
      userId: event.recipientId,
      kind: event.kind,
      subject: `[Ziki Issues] ${subject}`,
      title: subject,
      url: path,
      text: body(lines, `${base}${path}`, `${base}/settings`, label),
    },
  ];
}

export function isAgentNotificationEvent(
  event: NotificationEvent,
): event is Extract<NotificationEvent, AgentBase> {
  return (AGENT_NOTIFICATION_KINDS as readonly string[]).includes(event.kind);
}

/**
 * Plans the notifications for one event. `issuePath` is the address of the
 * event's issue (`/<org>/<project>/<number>`, #project-urls), looked up at
 * delivery; null when the event is about no issue.
 */
export function planNotifications(event: NotificationEvent, siteUrl: string, issuePath: string | null): PlannedNotification[] {
  const base = siteUrl.replace(/\/$/, "");
  if (isAgentNotificationEvent(event)) return planAgentNotification(event, base, issuePath);
  const commentId =
    event.kind === "comment_added" || event.kind === "mentioned" ? event.commentId : undefined;
  // The query lets the page load down to the comment's thread even when
  // it's older than the default window (#280).
  const issueAddress = issuePath ?? "/home";
  const path = commentId
    ? commentPermalinkPath(issueAddress, commentId)
    : issueAddress;
  const issueUrl = `${base}${path}`;
  const settingsUrl = `${base}/settings`;
  const title = quote(event.bugTitle);
  const planned: PlannedNotification[] = [];
  const add = (userId: string | null | undefined, subject: string, lines: (string | false | undefined)[]) => {
    if (!userId || userId === event.actorId) return;
    if (planned.some((p) => p.userId === userId)) return;
    planned.push({
      userId,
      kind: event.kind,
      subject: `[Ziki Issues] ${subject}`,
      title: subject,
      url: path,
      text: body(lines, issueUrl, settingsUrl),
    });
  };

  switch (event.kind) {
    case "mentioned":
      for (const userId of event.recipientIds) {
        add(userId, `${event.actorName} mentioned you on ${title}`, [
          `${event.actorName} mentioned you in ${event.place === "comment" ? "a comment on" : "the description of"} ${title}.`,
          event.excerpt ? `\n> ${event.excerpt}` : undefined,
        ]);
      }
      break;
    case "assignee_changed":
      if (event.fromUserId === event.toUserId) break;
      add(event.toUserId, `${event.actorName} assigned you to ${title}`, [
        `${event.actorName} assigned ${title} to you.`,
      ]);
      add(event.fromUserId, `${event.actorName} reassigned ${title}`, [
        event.toUserId === event.actorId
          ? `${event.actorName} took over ${title}, which was assigned to you.`
          : event.toUserId
            ? `${event.actorName} reassigned ${title}. It's no longer assigned to you.`
            : `${event.actorName} unassigned you from ${title}.`,
      ]);
      break;
    case "comment_added": {
      const skip = new Set(event.excludeIds ?? []);
      // Reply notice first, so the parent's author gets the more specific line.
      if (event.parentAuthorId && !skip.has(event.parentAuthorId)) {
        add(event.parentAuthorId, `${event.actorName} replied to your comment on ${title}`, [
          `${event.actorName} replied to your comment on ${title}.`,
          event.excerpt ? `\n> ${event.excerpt}` : undefined,
        ]);
      }
      for (const userId of event.recipientIds) {
        if (skip.has(userId)) continue;
        add(userId, `${event.actorName} commented on ${title}`, [
          `${event.actorName} commented on ${title}, which you're watching.`,
          event.excerpt ? `\n> ${event.excerpt}` : undefined,
        ]);
      }
      break;
    }
    case "status_changed":
      if (event.from === event.to) break;
      for (const userId of event.recipientIds ?? [event.reporterId]) {
        const yours = userId === event.reporterId;
        add(userId, `${title} is now ${statusLabel[event.to]}`, [
          `${event.actorName} changed the status of ${yours ? "your issue " : ""}${title} from ${statusLabel[event.from]} to ${statusLabel[event.to]}.`,
          ...(event.note ? ["", `Resolution note from ${event.actorName}:`, event.note] : []),
        ]);
      }
      break;
  }

  return planned;
}
