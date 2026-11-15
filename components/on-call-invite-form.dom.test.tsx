// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ search: vi.fn(), invite: vi.fn() }));
vi.mock("@/app/actions/on-call", () => ({ searchOnCallPeopleAction: mocks.search, inviteOnCallAction: mocks.invite }));

import { OnCallInviteForm } from "./on-call-invite-form";

describe("the on-call invite box (#on-call)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("searches as you type and fills in the email of the person you pick; someone already on call can't be picked", async () => {
    mocks.search.mockResolvedValue([
      { id: "u1", name: "Hamzat Adebayo", email: "hamzat@example.com", state: "on_call" },
      { id: "u2", name: "Hamza Bello", email: "hbello@example.com", state: null },
    ]);
    const user = userEvent.setup();
    render(<OnCallInviteForm primary="" />);
    const box = screen.getByRole("combobox");

    await user.type(box, "h");
    expect(mocks.search).not.toHaveBeenCalled();

    await user.type(box, "am");
    const bello = await screen.findByRole("option", { name: /Hamza Bello/ }, { timeout: 3000 });
    // One search for the whole word, not one per letter.
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith("ham");
    expect(screen.getByRole("option", { name: /Hamzat Adebayo/ })).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByRole("option", { name: /Hamzat Adebayo/ }));
    expect(box).toHaveValue("ham");

    await user.click(bello);
    expect(box).toHaveValue("hbello@example.com");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("still lets staff invite an email nobody has searched for", async () => {
    mocks.search.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<OnCallInviteForm primary="" />);
    const box = screen.getByRole("combobox");
    await user.type(box, "new@example.com");
    expect(await screen.findByText(/No account with that email yet/, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(box).toHaveValue("new@example.com");
  });
});
