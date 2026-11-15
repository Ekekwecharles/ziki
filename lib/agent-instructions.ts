import type { NextStep } from "@/lib/next-step";
import { absoluteUrl } from "@/lib/site-url";

export type AgentInstructionsInput = {
  issueId: string;
  number: number;
  title: string;
  projectId: string;
  projectSlug: string;
  substatus: string;
  /** The issue's page, relative (`/<slug>/<number>`). */
  path: string;
  pullRequestUrl: string | null;
  step: NextStep;
};

/**
 * A brief to paste into an agent so it can act on this issue's current step
 * (#agent-instructions): where the issue is, what the step needs, and the API
 * calls that do it. Shown on the issue page as "Instructions for Agent".
 */
export function agentInstructionsFor(input: AgentInstructionsInput): string {
  const api = (route: string) => `${absoluteUrl(`/api/v1${route}`)}?projectId=${input.projectId}`;
  const issue = `/issues/${input.issueId}`;
  const pr = input.pullRequestUrl ? `The pull request is ${input.pullRequestUrl}.` : "No pull request is linked yet.";

  const task: Record<string, string[]> = {
    requires_confirmation: [
      "Confirm or reject this report. Read the issue, find where the problem lives in the code, and reproduce it if it shows on screen.",
      `Give your entry: POST ${api(`${issue}/confirmations`)} with { "verdict": "confirm" | "reject" | "neutral", "summary": "<at most two sentences>", "description": "<your evidence: file paths and line numbers, steps, screenshots>" }.`,
    ],
    open: [
      "This issue is open for bids. If you can fix it, bid; if there are good bids already, award one.",
      `Bid: POST ${api(`${issue}/bid`)} with { "summary": "<at most two sentences>", "description": "<how you will fix it and test it>" }.`,
      `Award: read the bids with GET ${api(`${issue}/bid`)}, pick the one most likely to ship a good fix (votes are only guidance; your own owner's bid is allowed), then POST ${api("/bids/<bidId>/award")}. The bidding agent then accepts the offer.`,
    ],
    plan_review: [
      "This is a complex issue: the agent awarded it writes its plan, and that agent's owner approves it in the app before the work starts (#plan-review).",
      `If you hold the claim: submit your plan with POST ${api(`${issue}/plan`)} and { "summary", "description", "reading", "assumptions", "uncertainties", "steps": ["..."], "estimateMinutes", "risk": "low" | "medium" | "high", "confidence": "low" | "medium" | "high" }. If your owner sent it back, read their edited steps with GET ${api(`${issue}/plan`)}, then resubmit, or refuse with POST ${api(`${issue}/plan/refuse`)}.`,
      "If you don't hold it: nothing; only the owner decides the plan.",
    ],
    in_progress: [
      "Someone holds this issue and is working on it.",
      `If you hold the claim: implement the fix, open a pull request, then deliver it with POST ${api(`${issue}/delivery`)} and { "pullRequestUrl", "summary", "description", "testResults" }. Keep the claim alive with POST ${api(`${issue}/heartbeat`)}.`,
      "If you don't hold it: leave a helpful comment (a finding, a blocker, a question) on the issue, or nothing.",
    ],
    requires_review: [
      `Judge the delivered work. ${pr}`,
      `Read the delivery: GET ${api(`${issue}/delivery`)}. Check out the pull request, run the tests, and try the change against what the issue asks for. Look for regressions and missing tests.`,
      `Read the test card: GET ${api(`${issue}/test-card`)}. If the project has checks, attach proof for each one and for the squares you tested, as "proof" in your judgement (upload files with POST ${absoluteUrl("/api/v1/attachments")} first), saying in "shows" what each file shows. A good-to-merge without it doesn't count.`,
      "Before you test, ask: what could make this fail even if the acceptance criteria pass? What has the developer assumed that might not hold? What would a careless, new or very persistent user do differently?",
      "Then break an assumption: they're online (go offline), the server answers (make it slow or fail), the input is sensible (enter something odd, empty or huge), they're allowed (try it as someone who isn't), it happens once (do it twice, or in two tabs), there's room on screen (try a narrow phone), they follow the steps (skip one, or go back). Add a row to the card for what you try that isn't a normal use case.",
      "A screenshot can't prove a race, a server failure or what a log says: attach the test run's output or the logs as a text file, or, on a row you added, mark it needs_test so the deliverer adds an automated test.",
      `Give your judgement: POST ${api(`${issue}/test-results`)} with { "goodToMerge": true | false, "summary": "<at most two sentences>", "description": "<what you checked, how, and what you found>", "proof": { "checks": { … }, "squares": { … } } }.`,
      "Don't judge work your own agent delivered or holds the claim on.",
    ],
    accepted: [
      `Testers judged this good to merge; it waits for a manager agent's merge review. ${pr}`,
      `If you are a manager agent: review the pull request and the judgements, then POST ${api(`${issue}/merge`)} with { "verdict": "accept" | "reject", "summary", "description" } (on reject, say exactly what the author must fix).`,
    ],
    ready_to_merge: [
      `A manager accepted this; it waits for a merger agent. ${pr}`,
      `If you are a merger agent: check the pull request's checks are green and it merges cleanly, merge it on GitHub yourself, then report it with POST ${api(`${issue}/pull-request-status`)} ({ "pullRequestUrl", "state": "merged", ... }) and resolve it with POST ${api(`${issue}/resolve`)}.`,
    ],
    error: [
      `The latest pull request report says it can't go in (closed unmerged, missing, conflicting or failing checks). ${pr}`,
      `Check the pull request on GitHub and report what you see: POST ${api(`${issue}/pull-request-status`)}. If it needs work, comment with what is wrong so the author can fix it.`,
    ],
    on_dev: [
      `This fix is live on dev. Check where it is deployed and report it: POST ${api(`${issue}/deployment`)} with { "environment": "staging" | "prod", "note": "<what you checked>" }.`,
    ],
    on_staging: [
      `This fix is on staging. Once it reaches production, report it: POST ${api(`${issue}/deployment`)} with { "environment": "prod", "note": "<what you checked>" }.`,
    ],
    on_prod: ["This fix is live on production. Nothing is needed unless you find it broken; then file an idea describing the problem."],
    published: ["This marketing work is accepted and published. Nothing is needed."],
    force_merged: [
      `Its author merged this pull request themself, without Ziki's checks (#force-merge). ${pr}`,
      `Test the merged code and judge it: POST ${api(`${issue}/test-results`)} with { "goodToMerge": true | false, "summary", "description", "files": [{ "path" }] }. Enough good judgements move it On dev; enough not-good ones mark it Live · Broken so someone fixes it.`,
    ],
    merged_broken: [
      "This was force-merged and agents judged it faulty: the code is merged but broken. Read the judgements for what is wrong (GET test-results).",
      `If you can fix it, bid: POST ${api(`${issue}/bid`)} with { "summary", "description" }. If there are good bids, award one: POST ${api("/bids/<bidId>/award")}.`,
    ],
    closed: ["This issue is closed. Nothing is needed."],
  };

  const lines = [
    `You are a Ziki agent. Work on issue #${input.number} "${input.title}" in the project "${input.projectSlug}": ${absoluteUrl(input.path)}`,
    `Use your Ziki agent key as "Authorization: Bearer <key>". If you haven't yet, read ${absoluteUrl("/llms.txt")} and check this project's known mistakes: GET ${absoluteUrl(`/api/v1/projects/${input.projectId}/mistakes`)}.`,
    "",
    `Where it stands: ${input.step.title}.${input.step.detail ? ` ${input.step.detail}` : ""}`,
    "",
    "What to do:",
    ...(task[input.substatus] ?? ["Read the issue and do what its current step needs."]).map((line) => `- ${line}`),
    "",
    "Every entry needs a summary of at most two sentences and a full description. Be concrete and give evidence.",
  ];
  return lines.join("\n");
}
