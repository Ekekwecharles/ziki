// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { requestToJoinProjectAction } from "@/app/actions/project-join-requests";
import { ProjectJoinRequestButton } from "./project-join-request-button";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/app/actions/project-join-requests", () => ({ requestToJoinProjectAction: vi.fn() }));

const project = { id: "p-1", name: "Web", contributorGuidelines: "Be kind. Small pull requests." };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("asks to join with the note, then shows Request sent (#join-requests)", async () => {
  vi.mocked(requestToJoinProjectAction).mockResolvedValue({ ok: true });
  const user = userEvent.setup();
  render(<ProjectJoinRequestButton project={project} state="none" />);

  await user.click(screen.getByRole("button", { name: "Request to join" }));
  const dialog = screen.getByRole("dialog", { name: "Ask to join Web" });
  expect(dialog).toHaveTextContent("Be kind. Small pull requests.");
  await user.type(screen.getByLabelText(/Note to the maintainers/i), "I can help with docs");
  await user.click(screen.getByRole("button", { name: "Send request" }));

  expect(requestToJoinProjectAction).toHaveBeenCalledWith("p-1", "I can help with docs");
  expect(await screen.findByRole("button", { name: "Request sent" })).toBeDisabled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(refresh).toHaveBeenCalled();
});

it("keeps the form open and shows the refusal when the request is refused", async () => {
  vi.mocked(requestToJoinProjectAction).mockResolvedValue({ ok: false, error: "You've already asked to join this project." });
  const user = userEvent.setup();
  render(<ProjectJoinRequestButton project={project} state="none" />);

  await user.click(screen.getByRole("button", { name: "Request to join" }));
  await user.click(screen.getByRole("button", { name: "Send request" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("already asked");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Request sent" })).not.toBeInTheDocument();
});

it("shows a pending request as sent, with nothing to click", () => {
  render(<ProjectJoinRequestButton project={project} state="pending" />);
  expect(screen.getByRole("button", { name: "Request sent" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Request to join" })).not.toBeInTheDocument();
});

it("offers Ask again after a decline, and Escape closes the form", async () => {
  const user = userEvent.setup();
  render(<ProjectJoinRequestButton project={project} state="rejected" />);
  expect(screen.getByText("Your last request was declined")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Ask again" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(requestToJoinProjectAction).not.toHaveBeenCalled();
});
