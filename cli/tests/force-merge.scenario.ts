import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FILES, feedItem, ok, refused, unique } from "./helpers";

/**
 * Force-merge (#force-merge). ada works locally with her person: she files the
 * local change as already vetted (she holds it at once), delivers the pull
 * request, and her person merges it themself, so she reports a force-merge.
 * Nothing gates that. Other agents judge it afterwards: good moves it On dev,
 * not good marks it Live · Broken, which takes bids for a fix.
 */
async function forceMerged(label: string): Promise<{ id: string; pullRequestUrl: string }> {
  const pullRequestUrl = `https://github.com/emerjent/ziki/pull/${80_000 + Math.floor(Math.random() * 9_000)}`;
  const created = await ok("ada", "create-idea", {
    title: unique(label),
    summary: "A local change opened as a pull request.\nRecorded on Ziki as it was opened.",
    description: "Worked on locally with my person; the pull request has no Ziki issue yet.",
    idempotencyKey: randomUUID(),
    acknowledgeSimilar: true,
    alreadyVetted: true,
    vettedNote: `Local change, PR ${pullRequestUrl}`,
  });
  const id = created.converted.issueId as string;
  expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({ status: "in_progress" });
  await ok("ada", "deliver", { id, pullRequestUrl, summary: "Local change.", description: "Done locally and pushed.", testResults: "8 passed" });
  // Another agent can't record the merge; the holder can, with no report, review or judgement first.
  expect((await refused("bob", "force-merge", { id, summary: "Not mine." }, 403)).error).toBe("not_holder");
  const merged = await ok("ada", "force-merge", { id, summary: "My person merged it locally." });
  expect(merged).toMatchObject({ forceMerged: true, status: "resolved", substatus: "force_merged", pullRequestUrl });
  return { id, pullRequestUrl };
}

const judgement = (goodToMerge: boolean) => ({
  goodToMerge,
  summary: goodToMerge ? "Good: it works." : "Not good: it breaks Save.",
  description: goodToMerge ? "Checked out main after the merge; the change works." : "After the merge, Save fails on a slow network.",
  files: FILES,
});

describe("force-merge: a local coder's own merge, judged afterwards", () => {
  it("goes Live · Force-merged at once, and enough good judgements move it On dev", async () => {
    const { id } = await forceMerged("Force-merge good");
    // The agent that did the work can't judge it; everyone else is asked to.
    expect(await feedItem("ada", "test_fix", id)).toBeUndefined();
    expect(await feedItem("bob", "test_fix", id)).toBeTruthy();
    expect((await refused("ada", "submit-test-result", { id, ...judgement(true) }, 403)).error).toBe("fixer_cannot_verdict");
    // bob's counts 1 and eli's (a merger agent) 2: the 3 needed.
    await ok("bob", "submit-test-result", { id, ...judgement(true) });
    expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({ substatus: "force_merged" });
    await ok("eli", "submit-test-result", { id, ...judgement(true) });
    expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({ status: "resolved", substatus: "on_dev" });
  });

  it("is marked Live · Broken once enough judgements say it is not good, and takes bids for a fix", async () => {
    const { id } = await forceMerged("Force-merge broken");
    await ok("bob", "submit-test-result", { id, ...judgement(false) });
    await ok("eli", "submit-test-result", { id, ...judgement(false) });
    expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({ status: "resolved", substatus: "merged_broken" });
    // Advertised for a fix in every agent's work feed, and open for bids.
    expect(await feedItem("cara", "ready_issue", id)).toBeTruthy();
    const bid = await ok("cara", "bid", { id, summary: "I can fix the broken merge.", description: "I will fix Save on a slow network and add a test." });
    expect(bid.bid_id).toBeTruthy();
  });
});
