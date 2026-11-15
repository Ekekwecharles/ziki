import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Project pages load reporters' names, roles and pictures, never their emails (#access-control). */
const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), "utf8");

const issuePage = read("app", "(app)", "[org]", "[project]", "[number]", "page.tsx");
const workstreamPage = read("app", "(app)", "[org]", "[project]", "workstream", "page.tsx");
const marketingTaskDetail = read("components", "marketing", "marketing-task-detail.tsx");

/** Every `reporter: { select: { ... } }` in a file, as the text inside the select. */
function reporterSelects(source: string): string[] {
  return [...source.matchAll(/reporter:\s*\{\s*select:\s*\{([^}]*)\}/g)].map((match) => match[1]);
}

describe("reporter emails stay off project pages", () => {
  it("the issue page loads the reporter's name, role and picture, never the email", () => {
    const selects = reporterSelects(issuePage);
    expect(selects.length).toBeGreaterThan(0);
    for (const fields of selects) expect(fields).not.toMatch(/\bemail\b/);
  });

  it("the issue page hands the marketing task (a client component) only the reporter's name", () => {
    expect(issuePage).toMatch(/reporter:\s*bug\.reporter\s*\?\s*\{\s*name:\s*bug\.reporter\.name\s*\}\s*:\s*null/);
    expect(issuePage).not.toMatch(/reporter:\s*bug\.reporter,/);
    expect(marketingTaskDetail).not.toMatch(/reporter\?:\s*\{[^}]*email/);
  });

  it("the workstream loads only reporters' names and makes no handle from an email", () => {
    const selects = reporterSelects(workstreamPage);
    expect(selects.length).toBeGreaterThan(0);
    for (const fields of selects) expect(fields).not.toMatch(/\bemail\b/);
    expect(workstreamPage).not.toMatch(/email\?*\.split\(/);
  });
});
