import { describe, expect, it } from "vitest";
import { sameCommit } from "@/lib/github/commit-sha";

const FULL = "5d65ad148f547748eef71071dfbbb7e3a97567db";

describe("sameCommit", () => {
  it("matches a short ID with the full ID of the same commit, either way round", () => {
    expect(sameCommit("5d65ad14", FULL)).toBe(true);
    expect(sameCommit(FULL, "5d65ad1")).toBe(true);
  });

  it("matches equal IDs and ignores case and spaces", () => {
    expect(sameCommit(FULL, FULL)).toBe(true);
    expect(sameCommit(" 5D65AD14 ", FULL)).toBe(true);
  });

  it("never matches two different commits", () => {
    expect(sameCommit("5d65ad15", FULL)).toBe(false);
    expect(sameCommit("fedcba9876543210fedcba9876543210fedcba98", FULL)).toBe(false);
  });

  it("needs at least 7 characters to call a short ID the same commit", () => {
    expect(sameCommit("5d65ad", FULL)).toBe(false);
  });

  it("is false when either side is missing or not hex", () => {
    expect(sameCommit(null, FULL)).toBe(false);
    expect(sameCommit(FULL, undefined)).toBe(false);
    expect(sameCommit("", FULL)).toBe(false);
    expect(sameCommit("5d65ad1z", FULL)).toBe(false);
  });
});
