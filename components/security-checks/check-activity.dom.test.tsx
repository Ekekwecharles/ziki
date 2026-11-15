// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { CheckActivity } from "./check-activity";
import { ReportProgress } from "./report-progress";

describe("a security check at work (#security-checks)", () => {
  beforeEach(() => cleanup());

  it("says what phase the check is in, with the numbers for a screen reader, and never what a part found", () => {
    const { rerender } = render(<CheckActivity site="shop.ng" phase="planning" done={0} total={0} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ziki is checking shop.ng");
    expect(screen.getByRole("status")).toHaveTextContent("Planning the checks.");
    expect(screen.getByRole("status")).not.toHaveTextContent("parts done");

    rerender(<CheckActivity site="shop.ng" phase="checking" done={3} total={15} />);
    expect(screen.getByRole("status")).toHaveTextContent("Agents are on it. 3 of 15 parts done.");

    rerender(<CheckActivity site="shop.ng" phase="writing" done={15} total={15} />);
    expect(screen.getByRole("status")).toHaveTextContent("Writing your report.");
  });

  it("keeps the bar moving while parts are still being checked, and stops when the check is over", () => {
    const parts = [{ id: "p1", title: "Headers", status: "checking" as const }];
    const { container, rerender } = render(<ReportProgress progress={{ done: 0, total: 1, percent: 0 }} parts={parts} working />);
    expect(container.querySelector('[class*="zk-check-slide"]')).not.toBeNull();

    rerender(<ReportProgress progress={{ done: 0, total: 1, percent: 0 }} parts={parts} />);
    expect(container.querySelector('[class*="zk-check-slide"]')).toBeNull();
  });
});
