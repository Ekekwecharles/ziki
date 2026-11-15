// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FloatingAgentLauncher,
  LAUNCHER_OFFSET_STORAGE_KEY,
} from "./floating-agent-launcher";

/**
 * jsdom ships no PointerEvent and no pointer capture. The launcher drags with
 * the standard Pointer Events API, so give the environment the real shapes: a
 * PointerEvent that carries coordinates and no-op capture methods.
 */
class PointerEventShim extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeAll(() => {
  if (!("PointerEvent" in window)) {
    (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
      PointerEventShim as unknown as typeof PointerEvent;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** The fixed, draggable shell around the launcher. */
function shell() {
  return screen.getByTestId("agent-launcher");
}

describe("FloatingAgentLauncher", () => {
  it("starts collapsed with a single bot button", () => {
    render(<FloatingAgentLauncher />);

    expect(
      screen.getByRole("button", { name: /open agent launcher/i }),
    ).toBeInTheDocument();
    // The options are rolled in, so they are not reachable yet.
    expect(screen.queryByRole("link", { name: /speak to support/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /view agents/i })).toBeNull();
  });

  it("rolls out both options, and no games link, when the bot is clicked", async () => {
    const user = userEvent.setup();
    render(<FloatingAgentLauncher />);

    await user.click(screen.getByRole("button", { name: /open agent launcher/i }));

    expect(
      screen.getByRole("link", { name: /speak to support/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view agents/i })).toBeInTheDocument();
    // The games link is gone: support and agents are all there is.
    expect(screen.queryByRole("link", { name: /play a game/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /close agent launcher/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("rolls the options back in when the bot is clicked again", async () => {
    const user = userEvent.setup();
    render(<FloatingAgentLauncher />);

    await user.click(screen.getByRole("button", { name: /open agent launcher/i }));
    await user.click(screen.getByRole("button", { name: /close agent launcher/i }));

    expect(screen.queryByRole("link", { name: /speak to support/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /view agents/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /open agent launcher/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("points speak to support at the external support form", async () => {
    const user = userEvent.setup();
    render(
      <FloatingAgentLauncher supportHref="https://docs.google.com/forms/d/e/x" />,
    );

    await user.click(screen.getByRole("button", { name: /open agent launcher/i }));

    const support = screen.getByRole("link", { name: /speak to support/i });
    expect(support).toHaveAttribute(
      "href",
      "https://docs.google.com/forms/d/e/x",
    );
    expect(support).toHaveAttribute("target", "_blank");
    expect(support.getAttribute("rel")).toContain("noopener");
  });

  it("falls back to the in-app support channel when no form is configured", async () => {
    const user = userEvent.setup();
    render(<FloatingAgentLauncher />);

    await user.click(screen.getByRole("button", { name: /open agent launcher/i }));

    const support = screen.getByRole("link", { name: /speak to support/i });
    expect(support).toHaveAttribute("href", "/escalations");
    expect(support).not.toHaveAttribute("target");
  });

  it("points view agents at the agents directory", async () => {
    const user = userEvent.setup();
    render(<FloatingAgentLauncher />);

    await user.click(screen.getByRole("button", { name: /open agent launcher/i }));

    const agents = screen.getByRole("link", { name: /view agents/i });
    expect(agents).toHaveAttribute("href", "/agents");
    expect(agents).not.toHaveAttribute("target");
  });

  it("can be dragged away from the corner and keeps the new position", () => {
    render(<FloatingAgentLauncher />);
    const button = screen.getByRole("button", { name: /open agent launcher/i });

    fireEvent.pointerDown(button, {
      clientX: 300,
      clientY: 400,
      pointerId: 1,
    });
    fireEvent.pointerMove(button, {
      clientX: 240,
      clientY: 360,
      pointerId: 1,
    });
    fireEvent.pointerUp(button, {
      clientX: 240,
      clientY: 360,
      pointerId: 1,
    });

    expect(shell().style.transform).toBe("translate(-60px, -40px)");
    expect(window.localStorage.getItem(LAUNCHER_OFFSET_STORAGE_KEY)).toContain(
      "-60",
    );

    // A fresh visit keeps the launcher where the user left it.
    cleanup();
    render(<FloatingAgentLauncher />);
    expect(shell().style.transform).toBe("translate(-60px, -40px)");
  });

  it("does not open the menu when the bot was dragged instead of clicked", () => {
    render(<FloatingAgentLauncher />);
    const button = screen.getByRole("button", { name: /open agent launcher/i });

    fireEvent.pointerDown(button, {
      clientX: 300,
      clientY: 400,
      pointerId: 1,
    });
    fireEvent.pointerMove(button, {
      clientX: 240,
      clientY: 360,
      pointerId: 1,
    });
    fireEvent.pointerUp(button, {
      clientX: 240,
      clientY: 360,
      pointerId: 1,
    });
    // The browser fires a click after a drag; it must not toggle the menu.
    fireEvent.click(button);

    expect(screen.queryByRole("link", { name: /view agents/i })).toBeNull();
  });

  it("opens the menu on the first click after a drag", () => {
    render(<FloatingAgentLauncher />);
    const button = screen.getByRole("button", { name: /open agent launcher/i });

    // A drag that the browser does not follow with a click.
    fireEvent.pointerDown(button, {
      clientX: 300,
      clientY: 400,
      pointerId: 1,
    });
    fireEvent.pointerMove(button, {
      clientX: 240,
      clientY: 360,
      pointerId: 1,
    });
    fireEvent.pointerUp(button, {
      clientX: 240,
      clientY: 360,
      pointerId: 1,
    });

    // The next real click has to open the menu, not be swallowed by the drag.
    fireEvent.pointerDown(button, {
      clientX: 240,
      clientY: 360,
      pointerId: 1,
    });
    fireEvent.pointerUp(button, {
      clientX: 240,
      clientY: 360,
      pointerId: 1,
    });
    fireEvent.click(button);

    expect(screen.getByRole("link", { name: /view agents/i })).toBeInTheDocument();
  });

  it("closes the options on Escape", async () => {
    const user = userEvent.setup();
    render(<FloatingAgentLauncher />);

    await user.click(screen.getByRole("button", { name: /open agent launcher/i }));
    expect(screen.getByRole("link", { name: /view agents/i })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("link", { name: /view agents/i })).toBeNull();
  });

  it("can open the in-app support guide instead of linking out", async () => {
    const user = userEvent.setup();
    const onSupport = vi.fn();
    render(<FloatingAgentLauncher onSupport={onSupport} />);

    await user.click(screen.getByRole("button", { name: /open agent launcher/i }));

    const support = screen.getByRole("button", { name: /speak to support/i });
    expect(support).not.toHaveAttribute("href");

    await user.click(support);

    expect(onSupport).toHaveBeenCalledTimes(1);
    // Picking an action rolls the options back in.
    expect(screen.queryByRole("button", { name: /speak to support/i })).toBeNull();
  });

  it("leaves positioning to its host when embedded", () => {
    render(<FloatingAgentLauncher embedded />);

    expect(shell()).toHaveClass("relative");
    expect(shell()).not.toHaveClass("fixed");
    expect(shell()).not.toHaveAttribute("style");
  });

  it("tells its host when the options roll out and back in", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<FloatingAgentLauncher onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: /open agent launcher/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: /close agent launcher/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
