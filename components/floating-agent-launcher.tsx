"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/**
 * Floating launcher for the signed-in app: one bot button in the lower-right
 * that rolls out two actions — speak to support, view agents.
 *
 * It replaces the old "Report issue" pill in the signed-in shell (the
 * pre-login button in the auth layout is untouched). The button can be dragged
 * out of the way when it covers a view, and remembers where it was left.
 */

/** Where the drag offset is remembered between visits. */
export const LAUNCHER_OFFSET_STORAGE_KEY = "ziki.agent-launcher.offset";

/** The in-app support channel, used when no external form is configured. */
const DEFAULT_SUPPORT_URL = "/escalations";
/** The workspace agent roster. */
const DEFAULT_AGENTS_URL = "/agents";

/** Movement smaller than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;

type Offset = { x: number; y: number };

/** Stable identity so the store snapshot never changes reference. */
const EMPTY_OFFSET: Offset = { x: 0, y: 0 };

type FloatingAgentLauncherProps = {
  /** External support/report form. Falls back to the in-app support channel. */
  supportHref?: string;
  /** An in-app support action (the support guide chat) instead of a link. */
  onSupport?: () => void;
  /** Where "View agents" goes. */
  agentsHref?: string;
  /** Render inside an existing floating container instead of fixing itself. */
  embedded?: boolean;
  /** Told when the options roll out or back in. */
  onOpenChange?: (open: boolean) => void;
  /** The bot face; defaults to the launcher's own robot. */
  icon?: ReactNode;
  /** Extra classes for the round button (the support guide keeps its blue face). */
  buttonClassName?: string;
};

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Reads the remembered offset, ignoring anything malformed. */
function readStoredOffsetRaw(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAUNCHER_OFFSET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parseStoredOffset(raw: string | null): Offset | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Offset> | null;
    if (!parsed) return null;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.min(0, x), y: Math.min(0, y) };
  } catch {
    return null;
  }
}

function writeStoredOffset(next: Offset): void {
  try {
    window.localStorage.setItem(
      LAUNCHER_OFFSET_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // A browser that refuses storage just loses the position.
  }
}

/** The launcher only reads storage on the client, so SSR needs no snapshot. */
function emptySubscribe() {
  return () => {};
}

function SupportIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-5.2A7 7 0 0 1 11 5h2a7 7 0 0 1 7 7Z" />
      <path d="M9 11h6M9 14h4" />
    </svg>
  );
}

function AgentsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
      <circle cx="10" cy="8" r="3" />
      <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.6 5.3a3 3 0 0 1 0 5.4" />
    </svg>
  );
}

function BotIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4.5V2.8" />
      <circle cx="12" cy="2.2" r="1.1" fill="currentColor" stroke="none" />
      <rect x="4.5" y="4.5" width="15" height="12.5" rx="3.5" />
      <path d="M9.2 10h.01M14.8 10h.01" />
      <path d="M9.5 13.5h5" />
      <path d="M2.5 12v3M21.5 12v3" />
    </svg>
  );
}

export function FloatingAgentLauncher({
  supportHref,
  onSupport,
  agentsHref,
  embedded = false,
  onOpenChange,
  icon,
  buttonClassName,
}: FloatingAgentLauncherProps) {
  const [open, setOpen] = useState(false);
  // Live position while dragging; null when the launcher is where it was left.
  const [dragOffset, setDragOffset] = useState<Offset | null>(null);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
    offset: Offset;
  } | null>(null);
  const suppressClickRef = useRef(false);

  // Remember where the user dragged the launcher to. Reading through
  // useSyncExternalStore keeps the server render and the hydrated client
  // render in step.
  const storedRaw = useSyncExternalStore(
    emptySubscribe,
    readStoredOffsetRaw,
    () => null,
  );
  const storedOffset = useMemo(
    () => parseStoredOffset(storedRaw) ?? EMPTY_OFFSET,
    [storedRaw],
  );
  const offset = dragOffset ?? storedOffset;

  // Escape rolls the options back in.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // A fresh press starts clean: only the click that directly follows a drag
    // is swallowed, so the next click always opens the menu.
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: offset.x,
      baseY: offset.y,
      moved: false,
      offset,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (
      !drag.moved &&
      Math.abs(dx) <= DRAG_THRESHOLD_PX &&
      Math.abs(dy) <= DRAG_THRESHOLD_PX
    ) {
      return;
    }
    drag.moved = true;

    // The launcher is anchored to the lower-right, so it only moves up/left.
    const next = {
      x: Math.min(0, drag.baseX + dx),
      y: Math.min(0, drag.baseY + dy),
    };
    drag.offset = next;
    setDragOffset(next);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    if (typeof event.currentTarget.releasePointerCapture === "function") {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (drag.moved) {
      // The browser fires a click after a drag: that must not open the menu.
      suppressClickRef.current = true;
      writeStoredOffset(drag.offset);
      setDragOffset(null);
    }
  };

  const onClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };

  const options = [
    {
      key: "support",
      label: "Speak to support",
      href: supportHref ?? DEFAULT_SUPPORT_URL,
      onSelect: onSupport,
      icon: <SupportIcon />,
    },
    {
      key: "agents",
      label: "View agents",
      href: agentsHref ?? DEFAULT_AGENTS_URL,
      icon: <AgentsIcon />,
    },
  ];

  return (
    <div
      data-testid="agent-launcher"
      className={
        embedded
          ? "relative flex flex-col items-end pointer-events-auto"
          : "print:hidden fixed right-4 bottom-5 z-40 sm:right-6 lg:bottom-24"
      }
      style={
        offset.x !== 0 || offset.y !== 0
          ? { transform: `translate(${offset.x}px, ${offset.y}px)` }
          : undefined
      }
    >
      <div
        id="agent-launcher-menu"
        aria-hidden={!open}
        className={`absolute bottom-full right-0 mb-3 flex w-max origin-bottom-right flex-col items-end gap-2 ${
          open ? "pointer-events-auto" : "pointer-events-none"
        }`}
      >
        {options.map((option, index) => {
          const shared =
            "inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full border border-zk-border bg-zk-surface px-4 py-2.5 text-sm font-medium text-zk-text shadow-lg transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue focus-visible:outline-offset-2";
          const state = open
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-3 scale-90 opacity-0";
          const delay = open ? `${index * 60}ms` : `${(options.length - index) * 40}ms`;

          const content = (
            <>
              <span className="text-zk-accent">{option.icon}</span>
              <span>{option.label}</span>
            </>
          );

          const linkClass = `${shared} ${state}`;
          const linkStyle = { transitionDelay: delay };

          if (option.onSelect) {
            return (
              <button
                key={option.key}
                type="button"
                tabIndex={open ? undefined : -1}
                className={linkClass}
                style={linkStyle}
                onClick={() => {
                  setOpen(false);
                  onOpenChange?.(false);
                  option.onSelect?.();
                }}
              >
                {content}
              </button>
            );
          }

          return isExternal(option.href) ? (
            <a
              key={option.key}
              href={option.href}
              target="_blank"
              rel="noopener noreferrer"
              tabIndex={open ? undefined : -1}
              className={linkClass}
              style={linkStyle}
            >
              {content}
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : (
            <Link
              key={option.key}
              href={option.href}
              tabIndex={open ? undefined : -1}
              className={linkClass}
              style={linkStyle}
            >
              {content}
            </Link>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-expanded={open}
        aria-controls="agent-launcher-menu"
        aria-label={open ? "Close agent launcher" : "Open agent launcher"}
        className={`inline-flex h-12 w-12 touch-none select-none items-center justify-center rounded-full bg-zk-accent text-white shadow-lg transition hover:bg-electric-blue-strong focus-visible:outline-2 focus-visible:outline-electric-blue focus-visible:outline-offset-2 active:cursor-grabbing ${buttonClassName ?? ""}`}
      >
        {icon ?? <BotIcon />}
      </button>
    </div>
  );
}
