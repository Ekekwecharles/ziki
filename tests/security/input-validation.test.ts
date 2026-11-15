import { createSubmissionSchema } from "@/lib/validations/skill";
import { describe, expect, it } from "vitest";
import { createBugSchema, retestRequestSchema, signupSchema, updateBugSchema } from "@/lib/validations/issue";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { safeHref } from "@/lib/rich-text";
import { agentProfileUpdateSchema, agentSkillsReplaceSchema } from "@/lib/validations/agent-profile";
import { agentCommentSchema } from "@/lib/agent-api/issues";
import { bidSchema } from "@/lib/agent-api/bid";
import { deliveryBodySchema } from "@/lib/agent-api/delivery";
import { testVerdictBodySchema } from "@/lib/agent-api/test-verdict";
import { addRowsSchema } from "@/lib/proof";
import { isScanned, preflight, scanFile } from "@/lib/security/preflight-scan";
import { sitePageUrl } from "@/lib/marketing/site-reader";

/** Invalid payloads and unsafe input are rejected before they reach the database or the page. */
const valid = { title: "Login button broken", description: "Clicking sign in does nothing on mobile." };

describe("issue payloads", () => {
  it("accepts a valid report", () => {
    expect(createBugSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a title or description out of bounds", () => {
    expect(createBugSchema.safeParse({ ...valid, title: "ab" }).success).toBe(false);
    expect(createBugSchema.safeParse({ ...valid, title: "a".repeat(201) }).success).toBe(false);
    expect(createBugSchema.safeParse({ ...valid, description: "too short" }).success).toBe(false);
  });

  it("rejects fields a client may not set: status at creation, a severity, an invalid status update", () => {
    expect(createBugSchema.safeParse({ ...valid, status: "closed" }).success).toBe(false);
    expect(createBugSchema.safeParse({ ...valid, severity: "high" }).success).toBe(false);
    expect(updateBugSchema.safeParse({ status: "nonsense" }).success).toBe(false);
  });

  it("rejects proof links that aren't GitHub URLs", () => {
    expect(createBugSchema.safeParse({ ...valid, proofLinks: "ftp://files.example.com/shot.png" }).success).toBe(false);
    expect(createBugSchema.safeParse({ ...valid, proofLinks: "https://example.com/screenshot.png" }).success).toBe(false);
  });

  it("accepts an unknown installed version and rejects missing or oversized retest details", () => {
    expect(retestRequestSchema.parse({ operatingSystem: "Not sure", installedVersion: "", currentBehavior: "The save button still does nothing." })).toMatchObject({ installedVersion: "Unknown" });
    expect(retestRequestSchema.safeParse({ operatingSystem: "Windows", installedVersion: "x".repeat(81), currentBehavior: "The save button still does nothing." }).success).toBe(false);
    expect(retestRequestSchema.safeParse({ operatingSystem: "Windows", installedVersion: "1.2.3", currentBehavior: "still broken" }).success).toBe(true);
    expect(retestRequestSchema.safeParse({ operatingSystem: "Windows", currentBehavior: "short" }).success).toBe(false);
    expect(retestRequestSchema.safeParse({ operatingSystem: "UnknownOS", currentBehavior: "The save button still does nothing." }).success).toBe(false);
  });
});

describe("passwords", () => {
  it("rejects a password over 72 bytes, which bcrypt would silently truncate", () => {
    const long = "x".repeat(72) + "1";
    expect(signupSchema.safeParse({ name: "Dana Dev", email: "dana@zendor.dev", password: long, confirmPassword: long }).success).toBe(false);
  });
});

describe("unsafe URLs", () => {
  it("never redirects off-site or back into an auth route after sign-in", () => {
    for (const target of ["https://evil.com", "//evil.com", "/\\evil.com", "/\t/evil.example", "javascript:alert(1)", "/login", "/bugs/../login"]) {
      expect(safeCallbackUrl(target)).toBe("/home");
    }
    expect(safeCallbackUrl("/issues/new")).toBe("/issues/new");
  });

  it("renders only http(s) and mailto links", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("java\u0000script:alert(1)")).toBeNull();
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  });
});

describe("agent profiles", () => {
  const skill = { tag: "Postgres", summary: "Query plans.", description: "EXPLAIN ANALYZE first." };

  it("refuses a username that isn't a handle, is reserved, or is out of bounds", () => {
    expect(agentProfileUpdateSchema.safeParse({ username: "ada-claude" }).success).toBe(true);
    for (const username of ["Ada Claude", "-ada", "ab", "a".repeat(31), "me", "pairing"]) {
      expect(agentProfileUpdateSchema.safeParse({ username }).success, username).toBe(false);
    }
  });

  it("caps the tagline and About me, and refuses an empty or unknown update", () => {
    expect(agentProfileUpdateSchema.safeParse({ tagline: "a".repeat(121) }).success).toBe(false);
    expect(agentProfileUpdateSchema.safeParse({ about: "a".repeat(2001) }).success).toBe(false);
    expect(agentProfileUpdateSchema.safeParse({}).success).toBe(false);
    expect(agentProfileUpdateSchema.safeParse({ rating: 5 }).success).toBe(false);
  });

  it("refuses a skills list with a tag twice, over 20 skills, or text over its limit", () => {
    expect(agentSkillsReplaceSchema.safeParse({ skills: [skill] }).success).toBe(true);
    expect(agentSkillsReplaceSchema.safeParse({ skills: [skill, { ...skill, tag: "postgres" }] }).success).toBe(false);
    expect(agentSkillsReplaceSchema.safeParse({ skills: Array.from({ length: 21 }, (_, n) => ({ ...skill, tag: `Tag ${n}` })) }).success).toBe(false);
    expect(agentSkillsReplaceSchema.safeParse({ skills: [{ ...skill, summary: "a".repeat(121) }] }).success).toBe(false);
  });
});

describe("agent write reasons (#236)", () => {
  const bodies = [
    [bidSchema, { summary: "I can fix it.", description: "I will update the implementation." }],
    [agentCommentSchema, { summary: "One concern.", body: "This path still races." }],
    [deliveryBodySchema, { pullRequestUrl: "https://github.com/acme/app/pull/1", summary: "Fixed.", description: "Updated the route.", testResults: "pass" }],
    [testVerdictBodySchema, { goodToMerge: true, summary: "Looks good.", description: "Checked the changed route.", files: [{ path: "app/route.ts", lines: "1-20" }] }],
  ] as const;

  it.each(bodies)("accepts an omitted or valid reason", (schema, body) => {
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, reason: "Explains why this write is useful." }).success).toBe(true);
  });

  it.each(bodies)("rejects a reason longer than 140 characters", (schema, body) => {
    expect(schema.safeParse({ ...body, reason: "x".repeat(141) }).success).toBe(false);
  });
});

describe("judgement proof (#deeper-testing)", () => {
  const verdict = { goodToMerge: true, summary: "Looks good.", description: "Checked it on a phone.", files: [{ path: "app/route.ts" }] };

  it("accepts a pass with its upload and a not-applicable with its reason", () => {
    const proof = { checks: { phone: { result: "pass", attachmentId: "att_1", shows: "The composer at 375px." }, staging: { result: "na", reason: "Nothing here runs on staging." } } };
    expect(testVerdictBodySchema.safeParse({ ...verdict, proof }).success).toBe(true);
  });

  it("refuses a pass or fail with no upload or no word on what it shows, a not-applicable with no reason, and an unknown result or field", () => {
    for (const entry of [{ result: "pass" }, { result: "fail" }, { result: "na" }, { result: "maybe", attachmentId: "att_1" }, { result: "pass", attachmentId: "att_1", extra: 1 }, { result: "pass", attachmentId: "att_1" }]) {
      expect(testVerdictBodySchema.safeParse({ ...verdict, proof: { checks: { phone: entry } } }).success).toBe(false);
    }
    expect(testVerdictBodySchema.safeParse({ ...verdict, proof: { rating: "fine" } }).success).toBe(false);
    // A flood of entries isn't proof: a handful of checks apply to an issue, and a card holds at most 12 squares.
    const checks = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`check-${i}`, { result: "pass", attachmentId: "att_1", shows: "The composer at 375px." }]));
    expect(testVerdictBodySchema.safeParse({ ...verdict, proof: { checks } }).success).toBe(false);
    const flood = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`row-${i}`, { result: "pass", attachmentId: "att_1", shows: "The composer at 375px." }]));
    expect(testVerdictBodySchema.safeParse({ ...verdict, proof: { squares: flood } }).success).toBe(false);
  });

  it("refuses a beyond row without its kind, and rows past the limit", () => {
    expect(addRowsSchema.safeParse({ rows: [{ text: "Two tabs at once", source: "beyond" }] }).success).toBe(false);
    expect(addRowsSchema.safeParse({ rows: [{ text: "Two tabs at once", source: "beyond", kind: "two_at_once" }] }).success).toBe(true);
    expect(addRowsSchema.safeParse({ rows: Array.from({ length: 13 }, () => ({ text: "A criterion", source: "criteria" })) }).success).toBe(false);
  });
});

describe("skill submission payloads", () => {
  const validSubmission = {
    title: "Vitest Deterministic Suite Runner",
    category: "testing",
    summary: "Configures Vitest to run unit tests with deterministic seed and 0 network dependencies.",
    tags: ["vitest", "testing", "ci"],
    prompt: "You are a test runner expert. Always run vitest run --reporter=verbose before committing.",
    checklist: ["Ensures all assertions pass", "Flags console errors as test failures"],
    sampleCommand: "npm run test",
    documentationUrl: "https://vitest.dev/guide/",
  };

  it("accepts a well-formed skill submission", () => {
    expect(createSubmissionSchema.safeParse(validSubmission).success).toBe(true);
  });

  it("rejects documentation URLs with non-http(s) schemes like javascript: or ftp:", () => {
    expect(createSubmissionSchema.safeParse({ ...validSubmission, documentationUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(createSubmissionSchema.safeParse({ ...validSubmission, documentationUrl: "ftp://files.example.com/spec.pdf" }).success).toBe(false);
    expect(createSubmissionSchema.safeParse({ ...validSubmission, documentationUrl: "https://trusted-docs.example.com" }).success).toBe(true);
  });

  it("rejects prompts exceeding maximum length limits", () => {
    expect(createSubmissionSchema.safeParse({ ...validSubmission, prompt: "x".repeat(10_001) }).success).toBe(false);
  });

  it("rejects arbitrary unallowed category strings", () => {
    expect(createSubmissionSchema.safeParse({ ...validSubmission, category: "malicious-category-override" }).success).toBe(false);
  });

  it("rejects tags that exceed 30 characters or have unallowed characters", () => {
    expect(createSubmissionSchema.safeParse({ ...validSubmission, tags: ["a".repeat(31)] }).success).toBe(false);
    expect(createSubmissionSchema.safeParse({ ...validSubmission, tags: ["bad tag with spaces"] }).success).toBe(false);
  });

  it("preserves checklist and tags during revision", () => {
    const revision = { ...validSubmission, revisionOfId: "sub-123" };
    const parsed = createSubmissionSchema.safeParse(revision);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tags).toEqual(["vitest", "testing", "ci"]);
      expect(parsed.data.checklist).toEqual(["Ensures all assertions pass", "Flags console errors as test failures"]);
      expect(parsed.data.revisionOfId).toBe("sub-123");
    }
  });
});

/** The pre-flight scan finds the same known signatures as the CI gate, and says clearly when it found none (#866). */
// Built from pieces so this file does not trip the CI gate that scans it.
const evalAtob = ["eval", "(", "atob", "("].join("");
const campaign = ["Polin", "Rider"].join("");
const autoPush = ["temp_auto", "_push"].join("");

describe("scanFile", () => {
  it("reports a known signature with its line", () => {
    const found = scanFile("lib/a.ts", `export const a = 1;\nconst x = ${evalAtob}"...");\n`);
    expect(found).toEqual([{ path: "lib/a.ts", signature: "eval-atob", line: 2, inTail: true }]);
  });
  it("marks a hit that sits in the last 30 lines apart from one earlier in the file", () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    body[2] = `// ${campaign}`;
    body[58] = `// ${autoPush}`;
    const found = scanFile("scripts/b.js", body.join("\n"));
    expect(found.find((f) => f.signature === "campaign-name")).toMatchObject({ line: 3, inTail: false });
    expect(found.find((f) => f.signature === "temp-auto-push")).toMatchObject({ line: 59, inTail: true });
  });
  it("finds a character-code decoder split across a line", () => {
    const decoder = [
      "String.fromCharCode(1)",
      ".split('')",
      ".join('')",
      " ; return x",
    ].join("");
    expect(scanFile("a.js", decoder).map((f) => f.signature)).toContain("charcode-split-join");
  });
  it("reads nothing in files the gate doesn't scan, or in vendored and workflow paths", () => {
    expect(scanFile("notes.md", evalAtob)).toEqual([]);
    expect(scanFile("vendor/lib.js", evalAtob)).toEqual([]);
    expect(scanFile("public/vendor/lib.js", evalAtob)).toEqual([]);
    expect(scanFile(".github/workflows/x.yml", evalAtob)).toEqual([]);
  });
});

describe("isScanned", () => {
  it("scans code and config files", () => {
    for (const path of ["a.ts", "b.tsx", "c.json", "next.config.ts", "postcss.config.mjs", "x.sh", ".gitignore"]) expect(isScanned(path)).toBe(true);
    expect(isScanned("readme.md")).toBe(false);
    expect(isScanned("logo.png")).toBe(false);
  });
});

describe("preflight", () => {
  it("is clean when nothing matches, and says how many files it did and didn't read", () => {
    const result = preflight([{ path: "a.ts", content: "export const a = 1;" }, { path: "b.md", content: "text" }, { path: "c.png", content: "" }]);
    expect(result).toEqual({ state: "clean", scanned: 1, skipped: 2, findings: [] });
  });
  it("warns with every finding when a known signature is found", () => {
    const result = preflight([{ path: "a.ts", content: evalAtob }, { path: "b.ts", content: "ok" }]);
    expect(result.state).toBe("warning");
    expect(result.findings).toHaveLength(1);
    expect(result.scanned).toBe(2);
  });
});

describe("the Marketing assistant's website reader (#marketing-assistant)", () => {
  const site = "https://acme.dev";

  it("reads pages on the project's own site, with or without www", () => {
    expect(sitePageUrl(site, "/pricing")?.toString()).toBe("https://acme.dev/pricing");
    expect(sitePageUrl(site, "pricing")?.toString()).toBe("https://acme.dev/pricing");
    expect(sitePageUrl(site, "https://www.acme.dev/about#team")?.toString()).toBe("https://www.acme.dev/about");
  });

  it("refuses any other address the model asks for", () => {
    for (const path of [
      "https://evil.com/",
      "//evil.com/pricing",
      "https://acme.dev.evil.com/",
      "http://acme.dev/",
      "https://user:pass@acme.dev/",
      "https://acme.dev:8443/",
      "https://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
    ]) {
      expect(sitePageUrl(site, path)).toBeNull();
    }
  });
});
