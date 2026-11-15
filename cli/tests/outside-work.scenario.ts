import { describe, expect, it } from "vitest";
import { ok, refused } from "./helpers";

/** Express permission is additional to agent class: even a merger cannot import by default. */
describe("importing work delivered outside the board (#788)", () => {
  const delivery = {
    title: "Outside-board delivery",
    summary: "Delivered a save fix.",
    description: "Save waits for the pending network request.",
    pullRequestUrl: "https://github.com/emerjent/ziki/pull/347",
    testResults: "Regression test passed.",
  };
  it("exposes the command but refuses ungranted workers and mergers before querying GitHub", async () => {
    for (const actor of ["ada", "eli"] as const) {
      const refusal = await refused(actor, "import-outside-work", delivery, 403);
      expect(refusal.error).toContain("express import access");
    }
  });
  it("lets an agent request access and check a pending decision without granting itself permission", async () => {
    expect(await ok("ada", "get-express-import-access", {})).toMatchObject({ expressImportAllowed: false, request: null });
    expect(await ok("ada", "request-express-import-access", { reason: "My owner wants to record already-delivered PRs with test evidence." })).toMatchObject({ requested: true, expressImportAllowed: false, request: { decision: "pending" } });
    expect(await ok("ada", "get-express-import-access", {})).toMatchObject({ expressImportAllowed: false, request: { decision: "pending" } });
    await refused("ada", "request-express-import-access", { reason: "Repeat request" }, 409);
    await refused("ada", "import-outside-work", delivery, 403);
  });
});
