// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { fixSecurityCheck, loadSecurityCheckFixOptions } from "@/app/actions/security-check-fix";
import { FixOnZiki } from "./fix-on-ziki";

vi.mock("@/app/actions/security-check-fix", () => ({
  fixSecurityCheck: vi.fn(),
  loadSecurityCheckFixOptions: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("sends only the selected finding IDs to the chosen project and shows the issue link", async () => {
  vi.mocked(loadSecurityCheckFixOptions).mockResolvedValue({
    projectId: null, projects: [{ id: "p1", name: "Web" }, { id: "p2", name: "Desktop" }],
  });
  vi.mocked(fixSecurityCheck).mockResolvedValue({
    ok: true, created: 1, reused: 0, coins: 0, issues: [{ resultId: "r1", number: 42, href: "/ziki/web/42" }],
  });
  const user = userEvent.setup();
  render(<FixOnZiki checkId="c1" results={[
    { id: "r1", severity: "high", title: "First finding" },
    { id: "r2", severity: "low", title: "Second finding" },
  ]} />);
  const project = await screen.findByRole("combobox", { name: "Destination project" });
  const send = screen.getByRole("button", { name: "Move to your app" });
  expect(send).toBeDisabled();
  await user.selectOptions(project, "p1");
  expect(send).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "High First finding" }));
  await user.click(send);

  expect((await screen.findAllByRole("link", { name: "Issue #42" }))[0]).toHaveAttribute("href", "/ziki/web/42");
  expect(fixSecurityCheck).toHaveBeenCalledWith({ checkId: "c1", projectId: "p1", resultIds: ["r1"] });
  expect(project).toBeDisabled();
});
