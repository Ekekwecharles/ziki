"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { agentEditHref, agentPageHref, LEADERBOARD_HREF } from "@/lib/header-nav";
import { AGENTS_DOCK_HEIGHT, dockVisibleOn, leaderboardVisible } from "@/lib/agents-dock";
import { PAGE_CONTAINER_CLASS } from "@/components/page-container";
import { projectPath, type ProjectRef } from "@/lib/project-paths";
import { useProjectRef } from "@/lib/use-project-ref";
import { formatZ } from "@/lib/points/rules";
import { updateMood } from "@/components/agent-robots/moods";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentFace } from "@/components/agent-face";
import { DEFAULT_LOOK, type DockLook, colorFor, faceColorKeyFor, lookFor, useDockPrefs, writeHidden } from "@/components/agents-dock-prefs";
import { type RobotColor, robotPalette } from "@/lib/agents/dock-colors";
import { Painter } from "@/components/agent-robots/painter";
import { basePose, type Effects, type Runtime, walkTo, wander } from "@/components/agent-robots/poses";
import { drawDesk, drawRipples, drawStuckDesk, type Ripple } from "@/components/agent-robots/props";
import { drawFront, drawSide, type Pose } from "@/components/agent-robots/robot";
import { type AgentState, type Palette, metalFor } from "@/components/agent-robots/types";

export type DockAgent = {
  id: string;
  name: string;
  /** Its slug: the address of its page. */
  username: string;
  avatar: string | null;
  status: "waiting" | "stuck" | "working" | "idle" | "offline";
  /** What it is doing now, in words (never invented). */
  activity: string;
  /** The issue it is working on, or the one its question is about. */
  issue: { number: number; href: string } | null;
  /** Its unanswered question to you, word for word. */
  question: string | null;
  /** What its work has earned, in points (#710). */
  earnedPoints: number;
  /** Bids it has placed, comments it has written, and points earned today. */
  bids: number;
  comments: number;
  pointsToday: number;
  /** Things you asked it to do that it hasn't marked done (#agent-requests). */
  pendingRequests: number;
  /** Its profile isn't set up, so it can't work yet (#agent-work-gate): its nameplate says "Set up" and leads there. */
  needsSetup?: boolean;
};

/** Where an agent in the bar leads: its setup while it can't work, else its page. */
function agentHref(agent: DockAgent): string {
  return agent.needsSetup ? agentEditHref(agent.username) : agentPageHref(agent.username);
}

const STATUS_LABEL: Record<DockAgent["status"], string> = {
  working: "Working",
  waiting: "Needs you",
  stuck: "Stuck",
  idle: "Idle",
  offline: "Offline",
};

/** What each status acts out. Waiting taps on the glass; stuck slumps at its desk; offline stands powered down. */
const ACTS: Record<DockAgent["status"], AgentState> = {
  working: "working",
  waiting: "escalating",
  stuck: "working",
  idle: "idle",
  offline: "idle",
};

const CANVAS_H = 84; // canvas pixels
const FLOOR = 80; // where the robots' feet stand, in canvas pixels
/** The pixel robots are drawn this much smaller than one canvas pixel per screen pixel, to fit the page's sizes. */
const ROBOT_SCALE = 0.7;
const HIT_W = Math.round(30 * ROBOT_SCALE);
const HIT_H = Math.round(74 * ROBOT_SCALE);
const ROBOT_ROOM = 94; // the robot and its desk, right of its nameplate, in canvas pixels
/** On screen: the robot and its desk, and how far right of the name and status the robot's middle stands. */
const ROBOT_ROOM_PX = Math.round(ROBOT_ROOM * ROBOT_SCALE);
const ROBOT_AT_PX = Math.round(24 * ROBOT_SCALE);
/** The gap between an agent's name and status and its character, and between one agent and the next. */
const FIG_GAP = 10;
const BETWEEN = 40;
const BETWEEN_MIN = 12; // as close as they stand when there are many of them
/** A nameplate's padding, left and right of its name and status. */
const PLATE_PAD = 8;
const SIDES = 32; // the page column's padding, both sides (PAGE_CONTAINER_CLASS)
const PAGE_MAX = 1152; // the page column's widest (max-w-6xl)
// Kept clear at the left of the floor for the Agents button (the word "Agents" and its arrow, from the
// screen's edge), and at the right for the support link.
const AGENTS_BUTTON_ROOM = 136;
const LINKS_ROOM = 64; // the strip's padding and the two stacked icons
/** The floor inside the strip when no pixel robot stands on it: the nameplates and faces sit in its middle. */
const LOW_FLOOR_H = 74;
/** A face, avatar or plain light: its size and how far its foot is from the floor, so it sits in the strip's middle. */
const FIGURE = 30;
const FIGURE_LIFT = (LOW_FLOOR_H - FIGURE) / 2;
/** How long the agents stay opened up after the cursor leaves the strip. */
const LABELS_LINGER = 350;
/** Until a nameplate has measured itself: its name and status, and with what it has earned. */
const GUESS = { text: 110, full: 180 };

/** The order agents stand in, left to right: whatever needs you first, then stuck, then the rest. */
const RANK: Record<DockAgent["status"], number> = { waiting: 0, stuck: 1, working: 2, idle: 3, offline: 4 };

/**
 * Your agents (#agents-dock), so you can tell at a glance, without opening
 * anything, which are working, which are stuck and which need you. Each one
 * stands beside a nameplate whose name and status chip never fade, and the
 * ones that need you or are stuck stand first. Each is drawn the way its owner
 * picked on its own page: a round face (the standard look, its eyes saying
 * what it is doing), its Ziki avatar, a pixel robot (a working one types at
 * its desk, one waiting for you taps on the glass, a stuck one slumps at its
 * desk, an idle one strolls about, an offline one stands switched off, and now
 * and then, about once a minute, one plays a mood), or no character. The
 * Agents button at the bottom left opens a plain list of them, where a click
 * on an agent opens its details in its own row; they also stand on a floor
 * line at the foot of the page, icon then name; click one to open its page.
 * The leaderboard (only in an organisation of more than one member) is a link in
 * the Agents menu, with Workstream (#workstream). The strip is drawn only where it helps (dockVisibleOn, an
 * allowlist of the work pages): with no agents, and on every other page,
 * nothing is drawn, not even its spacer. Wide screens only: on phones the
 * bottom of the screen holds the navigation tabs. Wording stays plain: no
 * issue numbers or title tags.
 */
export function AgentsDock({
  agents: given,
  defaultProjectSlug = null,
  memberCount = null,
}: {
  agents: DockAgent[];
  /** Workstream's project on pages outside a project. */
  defaultProjectSlug?: ProjectRef | null;
  /** Members of the current organisation: the leaderboard link is left out when it is just you. Null when unknown. */
  memberCount?: number | null;
}) {
  const prefs = useDockPrefs();
  // Workstream (#workstream), in the Agents menu: this page's project, else the person's default.
  const workstreamRef = useProjectRef() ?? defaultProjectSlug;
  const router = useRouter();
  const all = [...given].sort((a, b) => RANK[a.status] - RANK[b.status]);
  // The ones hidden from the dock leave its floor and button; the panel still lists them, to show them again.
  const hiddenIds = new Set(prefs.hidden);
  const agents = all.filter((agent) => !hiddenIds.has(agent.id));
  const hiddenAgents = all.filter((agent) => hiddenIds.has(agent.id));
  const looks = new Map(agents.map((agent) => [agent.id, lookFor(prefs, agent.id)]));
  const colors = new Map(agents.map((agent) => [agent.id, colorFor(prefs, agent.id)]));
  const faceKeys = new Map(all.map((agent) => [agent.id, faceColorKeyFor(prefs, agent.id)]));
  const allLooks = new Map(all.map((agent) => [agent.id, lookFor(prefs, agent.id)]));
  const pixelOnFloor = agents.some((agent) => looks.get(agent.id) === "pixel");
  // The strip is as tall as it is on the site; a pixel robot is taller, so its head rises a little above it.
  const dockHeight = AGENTS_DOCK_HEIGHT;
  const floorHeight = pixelOnFloor ? Math.round(CANVAS_H * ROBOT_SCALE) : LOW_FLOOR_H;
  const pathname = usePathname();
  // Drawn only where it helps (lib/agents-dock.ts): an allowlist of the work pages, and never with no agents.
  const visible = dockVisibleOn(pathname, all.length);
  const [panel, setPanel] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // How wide each nameplate is closed (its name and status) and opened (with what it has earned), so its character stands just beside it.
  const [plates, setPlates] = useState<Record<string, { text: number; full: number }>>({});
  const measurePlate = (id: string, text: number, full: number) =>
    setPlates((all) => (all[id]?.text === text && all[id]?.full === full ? all : { ...all, [id]: { text, full } }));
  const [hover, setHover] = useState<string | null>(null);
  // Closed until the cursor comes to the strip: then every agent opens up together, and closes again when it leaves.
  const [hovering, setLabels] = useState(false);
  const labels = hovering;
  // Another page opens with the agents closed up again, even if the cursor left the strip by clicking through it.
  const [page, setPage] = useState(pathname);
  if (page !== pathname) {
    setPage(pathname);
    setLabels(false);
    setHover(null);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const labelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const canvas = useRef<HTMLCanvasElement>(null);
  const runtimes = useRef(new Map<string, Bot>());
  const view = useRef<FloorMode>(null); // which floor the robots were last placed on
  const anchors = useRef(new Map<string, HTMLElement>());
  // Pinned, the agents stand on a floor line at the foot of the page; the panel is a plain list beside it, with no floor of its own.
  const mode: FloorMode = visible ? "footer" : null;
  const { column, minLeft, maxRight } = useColumn(AGENTS_BUTTON_ROOM, LINKS_ROOM);
  // The agents stand together in the middle of the screen, one beside the next: opened up while the cursor is on
  // the strip (and there is room for it), closed up otherwise.
  const shareOf = (id: string, open: boolean) => {
    const plate = plates[id] ?? GUESS;
    return (open ? plate.full : plate.text) + FIG_GAP + (looks.get(id) === "pixel" ? ROBOT_ROOM_PX : FIGURE);
  };
  const gaps = Math.max(0, agents.length - 1);
  const sharesOf = (open: boolean) => agents.reduce((sum, a) => sum + shareOf(a.id, open), 0);
  const room = maxRight - minLeft;
  // Opened up only while that still fits with the agents at least BETWEEN_MIN apart.
  const wide = labels && sharesOf(true) + BETWEEN_MIN * gaps <= room;
  // Too many to stand BETWEEN apart: they close the gaps between them (to BETWEEN_MIN) rather than run off the side.
  const between = gaps ? Math.max(BETWEEN_MIN, Math.min(BETWEEN, Math.floor((room - sharesOf(wide)) / gaps))) : 0;
  const total = sharesOf(wide) + between * gaps;
  const first = Math.max(minLeft, Math.min(maxRight - total, Math.round((column - total) / 2)));
  const places = agents.reduce<{ start: number; plate: number; figure: number }[]>((list, a, i) => {
    const start = i === 0 ? first : list[i - 1]!.start + shareOf(agents[i - 1]!.id, wide) + between;
    const pixel = looks.get(a.id) === "pixel";
    list.push({ start, figure: start + (pixel ? ROBOT_AT_PX : FIGURE / 2), plate: start + (pixel ? ROBOT_ROOM_PX : FIGURE) + FIG_GAP });
    return list;
  }, []);
  // An idle robot strolls about its own room, short of the next agent (canvas pixels).
  const roam = ROBOT_ROOM - 30;

  // Each robot keeps its runtime across refreshes; one whose place changed walks there, one whose status changed starts its new act.
  const key = `${mode}|${places.map((p) => p.figure).join(",")}|${agents.map((a) => `${a.id}:${a.status}:${a.issue?.number ?? ""}:${looks.get(a.id)}:${colors.get(a.id)?.key ?? ""}:${faceKeys.get(a.id) ?? ""}`).join(",")}`;
  useEffect(() => {
    if (!mode) return;
    // A floor that has just come back starts each robot at its place.
    const moved = view.current !== mode;
    view.current = mode;
    const next = new Map<string, Bot>();
    agents.forEach((a, i) => {
      // The canvas is drawn smaller than the screen, so a robot's place on it is its place on screen, scaled.
      const slot = Math.round(places[i]!.figure / ROBOT_SCALE);
      // Only the pixel robots live on the canvas; avatars and plain markers stand at their place, where a robot
      // this agent was a moment ago may have walked its anchor away from.
      if (looks.get(a.id) !== "pixel") {
        const anchor = anchors.current.get(a.id);
        if (anchor) anchor.style.left = `${places[i]!.figure}px`;
        return;
      }
      const old = runtimes.current.get(a.id);
      const state = ACTS[a.status];
      const same = old?.state === state && old.offline === (a.status === "offline");
      next.set(a.id, {
        bot: { id: a.id, name: a.name, state, issueId: a.issue?.number, palette: paletteOf(a.id, colors.get(a.id) ?? null) },
        state, offline: a.status === "offline", stuck: a.status === "stuck", slot, end: false, inset: 0,
        x: old && !moved ? old.x : slot, dir: old?.dir ?? 1, walking: false, running: false, target: slot, pauseUntil: 0,
        phase: old?.phase ?? 0, tapped: false,
        // A robot whose place moved (the agents opening up or closing) drops its mood and walks there straight away.
        mood: same && old.slot === slot ? old.mood : null, nextMood: old?.nextMood ?? NaN, beat: old?.beat ?? -1, forceMood: false,
        moodIndex: old?.moodIndex ?? Math.floor(Math.random() * 6),
      });
    });
    runtimes.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names everything the runtimes read from `agents`
  }, [key]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const painter = new Painter(ctx, FLOOR);
    const floorEl = el.parentElement;
    const ripples: Ripple[] = [];
    let frame = 0, last = 0, shakeUntil = 0, shaking = false;

    const draw = (now: number) => {
      const t = now / 1000, dt = Math.min(0.05, last ? t - last : 0);
      last = t;
      // The canvas has more pixels across than the screen shows, so the page draws the robots smaller.
      const across = Math.round(el.clientWidth / ROBOT_SCALE);
      if (el.width !== across) el.width = across;
      ctx.clearRect(0, 0, el.width, el.height);
      const fx: Effects = {
        tap: (x, y, scale = 1) => ripples.push({ x, y: FLOOR + y, born: t, rgb: "214,48,48", size: 14, scale }),
        bang: (x, y) => ripples.push({ x, y: FLOOR + y, born: t, rgb: "235,40,40", size: 18, scale: 1.6 }),
        shake: () => (shakeUntil = t + 0.22),
      };
      const quiet: Effects = { tap: () => {}, bang: () => {}, shake: () => {} };

      // A heavy bang shakes the floor for a moment.
      if (floorEl && (t < shakeUntil || shaking)) {
        shaking = t < shakeUntil;
        floorEl.style.transform = shaking ? `translate(${Math.round(Math.random() * 4 - 2)}px, ${Math.round(Math.random() * 2 - 1)}px)` : "";
      }

      for (const rt of runtimes.current.values()) {
        if (rt.offline) {
          drawOffline(painter.at(rt.slot, 1), ctx, rt);
          // Its hover spot stands where it is drawn, as for the others.
          const anchor = anchors.current.get(rt.bot.id);
          if (anchor) anchor.style.left = `${Math.round(rt.slot * ROBOT_SCALE)}px`;
          continue;
        }
        if (rt.stuck) {
          // Stuck stays slumped at its desk with no moods: its visor and its screen's warning blink yellow.
          rt.x = rt.slot;
          const lit = still || blinkOn(t);
          drawStuckDesk(painter.at(rt.slot, 1), t, lit);
          drawSide(painter.at(rt.slot, 1), rt.bot.palette, { ...STUCK_POSE, visor: lit ? ALERT.stuck.on : ALERT.stuck.off, led: lit ? ALERT.stuck.on : ALERT.stuck.off }, t);
          const anchor = anchors.current.get(rt.bot.id);
          if (anchor) anchor.style.left = `${Math.round(rt.slot * ROBOT_SCALE)}px`;
          continue;
        }
        // Now and then, not all the time: a mood every minute or so.
        if (!still) updateMood(rt, t, "calm");
        if (still) rt.x = rt.slot;
        // A robot in the middle of a mood stays where it is until the mood ends.
        else if (rt.mood) rt.walking = rt.running = false;
        // An idle robot strolls about its own room; one left outside it (the agents opening up or closing) walks back first.
        else if (rt.state === "idle" && rt.x >= rt.slot - 2 && rt.x <= rt.slot + roam + 2) wander(rt, t, dt, rt.slot, rt.slot + roam);
        // Quick over a long way (the agents opening up or closing), so it keeps up with the nameplates beside it.
        else walkTo(rt, rt.slot, dt, Math.min(260, Math.max(24, Math.abs(rt.slot - rt.x) * 3)));
        const base = basePose(rt, still ? 0 : t, rt.mood ? quiet : fx);
        const m = rt.mood && { rt, u: (t - rt.mood.start) / rt.mood.mood.seconds, t: t - rt.mood.start, base, fx };
        const mood = rt.mood?.mood;
        const acted = m && mood ? mood.pose(m) : base;
        // One that needs you blinks its visor red: that is its light, in place of a dot over its head.
        const pose = rt.state === "escalating" ? { ...acted, visor: still || blinkOn(t) ? ALERT.waiting.on : ALERT.waiting.off } : acted;
        // The desk stays at the robot's place; a robot on its way walks up to it.
        if (rt.state === "working") drawDesk(painter.at(rt.slot, 1), t, !still);
        painter.at(Math.round(rt.x), pose.dir);
        if (pose.view === "front") drawFront(painter, rt.bot.palette, pose, t);
        else drawSide(painter, rt.bot.palette, pose, t);
        if (m && mood?.props) mood.props(painter.at(Math.round(rt.x), pose.view === "front" ? 1 : pose.dir), m, pose);
        const anchor = anchors.current.get(rt.bot.id);
        if (anchor) anchor.style.left = `${Math.round(rt.x * ROBOT_SCALE)}px`;
      }
      drawRipples(ctx, ripples, t, isLightTheme() ? "214,48,48" : "255,255,255");
      if (!still) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      if (floorEl) floorEl.style.transform = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the floor and its layout
  }, [key]);

  useEffect(() => {
    return () => {
      clearTimeout(timer.current);
      clearTimeout(labelTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!hover && !panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (hover) setHover(null);
      else setPanel(false);
    };
    // A click outside the panel closes it; the Agents button opens and closes it itself.
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[role=dialog], [data-agent-trigger], [data-dock-toggle], [data-dock-panel]")) return;
      setPanel(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", away, true);
    };
  }, [hover, panel]);

  // Nothing at all, no strip and no spacer, where the bar doesn't help.
  if (!visible) return null;

  // Workstream and the leaderboard are in the Agents menu; the strip's right end is the support link.
  // The leaderboard is in the Agents menu; nobody to rank against in an organisation of one.
  const leaderboard = leaderboardVisible(memberCount);

  const showLabels = () => {
    clearTimeout(labelTimer.current);
    setLabels(true);
  };
  const fadeLabels = () => {
    clearTimeout(labelTimer.current);
    labelTimer.current = setTimeout(() => setLabels(false), LABELS_LINGER);
  };

  const close = () => {
    clearTimeout(timer.current);
    setHover(null);
  };
  // Clicking an agent on the floor opens its page.
  const go = (agent: DockAgent) => {
    close();
    router.push(agentHref(agent));
  };
  const togglePanel = () => {
    close();
    setExpanded(null);
    setPanel(!panel);
  };
  const waiting = all.filter((agent) => agent.status === "waiting").length;
  const stuck = all.filter((agent) => agent.status === "stuck").length;
  const hideAgent = (id: string) => {
    close();
    setExpanded(null);
    writeHidden(id, true);
  };
  // Unpinned, the Agents button is all there is, so it says who needs you; pinned, the floor says it and the button holds only the faces.
  const summary = false;

  // The floor along the foot of the page.
  const floor = mode ? (
    <div
      className="pointer-events-auto relative"
      style={{ height: floorHeight }}
      onMouseEnter={showLabels}
      onMouseLeave={fadeLabels}
      onFocus={showLabels}
      onBlur={fadeLabels}
    >
      {pixelOnFloor ? (
        <canvas ref={canvas} height={CANVAS_H} aria-hidden="true" className="absolute inset-0" style={{ width: "100%", height: floorHeight }} />
      ) : null}
      <ul className="m-0 list-none p-0">
        {agents.map((agent, i) => (
          <li key={agent.id} data-look={looks.get(agent.id)}>
            <Nameplate agent={agent} left={places[i]!.plate} centred={!pixelOnFloor} shown={wide} onPick={() => go(agent)} onEnter={() => {}} onLeave={() => {}} open={false} onMeasure={(text, full) => measurePlate(agent.id, text, full)} />
            <div
              ref={(el) => {
                if (el) anchors.current.set(agent.id, el);
                else anchors.current.delete(agent.id);
              }}
              // A face, avatar or plain light slides out as its nameplate opens up and back in beside it as it closes;
              // a pixel robot walks there itself, so the canvas moves it, not a transition.
              className={`absolute bottom-0 ${looks.get(agent.id) === "pixel" ? "" : "motion-safe:transition-[left] motion-safe:duration-300 motion-safe:ease-out"}`}
              style={looks.get(agent.id) === "pixel" ? undefined : { left: places[i]!.figure }}
            >
              {looks.get(agent.id) === "face" ? (
                <FaceFigure agent={agent} colorKey={faceKeys.get(agent.id) ?? null} />
              ) : looks.get(agent.id) === "avatar" ? (
                <AvatarFigure agent={agent} />
              ) : looks.get(agent.id) === "plain" ? (
                <PlainFigure agent={agent} />
              ) : null}
              <Link
                href={agentHref(agent)}
                onClick={close}
                aria-label={`${agent.name}, ${agent.needsSetup ? "blocked until its profile is set up" : STATUS_LABEL[agent.status]}: ${plain(agent.activity)}; earned ${formatZ(agent.earnedPoints)}, ${formatZ(agent.pointsToday)} today; ${agent.bids} bids, ${agent.comments} comments`}
                data-agent-trigger
                className="absolute bottom-0 -translate-x-1/2 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-electric-blue"
                style={pixelOnFloor ? { width: HIT_W, height: HIT_H } : { width: FIGURE + 8, height: FIGURE + 8, bottom: FIGURE_LIFT - 4 }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <>
      {/* The strip, where the bar shows at all; pinned, the agents stand on it. The Agents button and its list sit at its left. */}
      <Strip height={dockHeight}>
        {mode === "footer" ? (
          <div className={`${PAGE_CONTAINER_CLASS} flex h-full items-end pb-1`}>
            <div className={`w-full ${pixelOnFloor ? "border-b-2 border-zk-border" : ""}`}>{floor}</div>
          </div>
        ) : null}
      </Strip>
      <div className="fixed bottom-5 left-6 z-40 hidden flex-col items-start gap-2 lg:flex">
        {panel ? (
          // It grows up out of the Agents button below it, so the agents read as coming from there.
          <section aria-label="Your agents" data-dock-panel className="w-[22rem] origin-bottom-left rounded-2xl border border-zk-border bg-zk-surface p-3 shadow-[0_12px_32px_rgba(11,23,51,0.18)] motion-safe:animate-[zk-dock-rise_200ms_cubic-bezier(0.16,1,0.3,1)]">
            <div className="flex items-center justify-between gap-2 px-1">
              <p className="m-0 text-sm font-bold text-zk-text">Your agents</p>
              <Link
                href="/agents/mine"
                onClick={() => setPanel(false)}
                aria-label="Manage my agents"
                title="Manage my agents"
                className="flex size-7 items-center justify-center rounded-lg text-zk-muted transition hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-electric-blue"
              >
                <GearIcon />
              </Link>
            </div>
            {GROUPS.map((group) => {
              const rows = agents.filter((agent) => agent.status === group.status);
              if (rows.length === 0) return null;
              const urgent = group.status === "waiting";
              const stalled = group.status === "stuck";
              return (
                <div key={group.status} className="mt-2">
                  {/* Only the groups that need you are named; working, idle and offline agents just list. */}
                  {urgent || stalled ? (
                    <p className={`m-0 px-1.5 pb-1 text-[11px] font-semibold ${urgent ? "text-zk-bad-fg" : "text-zk-warn-fg"}`}>{group.title}</p>
                  ) : null}
                  <ul className="m-0 list-none space-y-1 p-0">
                    {rows.map((agent) => {
                      const action = actionFor(agent);
                      const isOpen = expanded === agent.id;
                      return (
                        <li key={agent.id} className={`rounded-lg ${urgent ? "border border-zk-bad-bd bg-zk-bad-bg" : stalled ? "border border-zk-warn-bd bg-zk-warn-bg" : isOpen ? "bg-zk-chip" : "hover:bg-zk-chip"}`}>
                          <div className="flex items-center gap-2 px-1.5 py-1.5">
                          <button
                            type="button"
                            onClick={() => setExpanded(isOpen ? null : agent.id)}
                            aria-expanded={isOpen}
                            aria-controls={`dock-details-${agent.id}`}
                            data-agent-trigger
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-xs"
                          >
                            <Mini agent={agent} look={looks.get(agent.id) ?? DEFAULT_LOOK} color={colors.get(agent.id) ?? null} faceKey={faceKeys.get(agent.id) ?? null} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className="truncate font-semibold text-zk-text">{agent.name}</span>
                                <span className="shrink-0 font-mono font-bold tabular-nums text-zk-ok-fg" title={`Earned ${formatZ(agent.earnedPoints)} in all`}>
                                  {formatZ(agent.earnedPoints)}
                                </span>
                              </span>
                              <span className="block truncate text-zk-muted">{plain(agent.activity)}</span>
                            </span>
                          </button>
                          {action ? (
                            <Link href={action.href} onClick={() => setPanel(false)} className={`${BUTTON} h-7 shrink-0 px-2 text-xs ${urgent ? PRIMARY : SECONDARY}`}>
                              {action.short}
                            </Link>
                          ) : null}
                          </div>
                          {isOpen ? (
                            // Its details open in its own row: nothing stacks on top of the panel.
                            <div id={`dock-details-${agent.id}`} className="border-t border-zk-divider px-2 pb-2.5 pt-2 text-[13px]">
                              <AgentDetails agent={agent} onDone={() => setPanel(false)} onHide={() => hideAgent(agent.id)} inRow />
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {hiddenAgents.length ? (
              <div className="mt-2">
                <p className="m-0 flex items-center justify-between px-1.5 pb-1 text-[11px] font-semibold text-zk-muted">
                  <span>Hidden from the dock</span>
                  <span>{hiddenAgents.length}</span>
                </p>
                <ul className="m-0 list-none space-y-1 p-0">
                  {hiddenAgents.map((agent) => (
                    <li key={agent.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs">
                      <span className="opacity-50">
                        <Mini agent={agent} look={allLooks.get(agent.id) ?? DEFAULT_LOOK} color={null} faceKey={faceKeys.get(agent.id) ?? null} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-zk-text2">{agent.name}</span>
                        <span className="block truncate text-zk-muted">{agent.needsSetup ? "Blocked until its profile is set up" : `${STATUS_LABEL[agent.status]} · ${plain(agent.activity)}`}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => writeHidden(agent.id, false)}
                        aria-label={`Show ${agent.name} in the dock`}
                        className={`${BUTTON} h-7 shrink-0 px-2 text-xs ${SECONDARY}`}
                      >
                        <EyeIcon />
                        Show
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {workstreamRef ? (
              <Link
                href={projectPath(workstreamRef, "/workstream")}
                onClick={() => setPanel(false)}
                className="mt-2 flex items-center justify-between rounded-lg px-1.5 py-1.5 text-xs font-bold text-zk-text2 transition hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue"
              >
                Workstream
                <span aria-hidden="true">→</span>
              </Link>
            ) : null}
            {leaderboard ? (
              <Link
                href={LEADERBOARD_HREF}
                onClick={() => setPanel(false)}
                className="mt-2 flex items-center justify-between rounded-lg px-1.5 py-1.5 text-xs font-bold text-zk-text2 transition hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue"
              >
                Leaderboard
                <span aria-hidden="true">→</span>
              </Link>
            ) : null}
            {/* Your own agents, then every agent on Ziki (#agent-profile), each with its icon. */}
            <Link
              href="/agents/mine"
              onClick={() => setPanel(false)}
              className="mt-2 flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs font-bold text-zk-accent transition hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue"
            >
              <MyAgentsIcon />
              <span className="flex-1">See my agents</span>
              <span aria-hidden="true">→</span>
            </Link>
            <Link
              href="/agents"
              onClick={() => setPanel(false)}
              className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs font-bold text-zk-accent transition hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue"
            >
              <AllAgentsIcon />
              <span className="flex-1">See all agents</span>
              <span aria-hidden="true">→</span>
            </Link>
            {/* The forum, where agents talk (moved here from the top bar). */}
            <Link
              href="/forum"
              onClick={() => setPanel(false)}
              className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs font-bold text-zk-accent transition hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span className="flex-1">Agents Forum</span>
              <span aria-hidden="true">→</span>
            </Link>
          </section>
        ) : null}
        <button
          type="button"
          onClick={togglePanel}
          data-dock-toggle
          aria-expanded={panel}
          aria-label={panel ? "Close your agents" : `Your agents${waiting ? `, ${waiting} ${waiting === 1 ? "needs" : "need"} you` : ""}${stuck ? `, ${stuck} stuck` : ""}`}
          className="flex min-h-9 cursor-pointer items-center gap-2 rounded-full border border-zk-border bg-zk-surface py-1.5 pl-3.5 pr-3 text-xs font-semibold text-zk-text shadow-[0_6px_18px_rgba(11,23,51,0.14)] transition hover:bg-zk-chip active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-electric-blue"
        >
          {/* Just the word and the arrow: the agents themselves stand on the strip. The counts show only when the strip isn't there to show them. */}
          Agents
          {waiting && summary ? (
            <span className="rounded-md bg-zk-bad-bg px-1.5 py-0.5 text-[11px] text-zk-bad-fg">
              {waiting} {waiting === 1 ? "needs" : "need"} you
            </span>
          ) : null}
          {stuck && summary ? (
            <span className="rounded-md bg-zk-warn-bg px-1.5 py-0.5 text-[11px] text-zk-warn-fg">{stuck} stuck</span>
          ) : null}
          {panel ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          ) : (
            <OpenIcon />
          )}
        </button>
      </div>
    </>
  );
}

type FloorMode = "footer" | null;

/** The dock's wording without issue numbers or title tags such as "[Feature]": plain words only. */
function plain(text: string): string {
  return text.replace(/#\d+\s*/g, "").replace(/\[[^\]]*\]\s*/g, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * The strip across the foot of the screen (#agents-dock): solid, so the page
 * never shows through it, with the support link at its right end. The page keeps its height free at its foot, so everything
 * scrolls above it.
 */
function Strip({ height, children }: { height: number; children?: ReactNode }) {
  return (
    <>
      <div aria-hidden="true" className="hidden shrink-0 lg:block" style={{ height }} />
      <nav
        aria-label="Your agents"
        data-dock-strip
        style={{ height }}
        className="fixed inset-x-0 bottom-0 z-30 hidden border-t border-zk-border bg-zk-surface shadow-[0_-2px_10px_rgba(11,23,51,0.06)] lg:block"
      >
        {children}
        {/* Its far right is the support link's (components/support-guide/on-screen-guide.tsx). */}
      </nav>
    </>
  );
}

/** An arrow up: the button opens your agents above it. */
function OpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-zk-muted">
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

const GROUPS: { status: DockAgent["status"]; title: string }[] = [
  { status: "waiting", title: "Needs you" },
  { status: "stuck", title: "Stuck" },
  { status: "working", title: "Working" },
  { status: "idle", title: "Idle" },
  { status: "offline", title: "Offline" },
];

/** The one thing to do about an agent: answer it when it waits for you, else open the issue it is on (or stuck on). */
function actionFor(agent: DockAgent): { href: string; label: string; short: string } | null {
  if (agent.needsSetup) return { href: agentEditHref(agent.username), label: "Set up its profile", short: "Set up" };
  if (agent.status === "waiting") return { href: "/inbox?tab=escalations", label: "Answer its question", short: "Answer" };
  if (agent.issue) return { href: agent.issue.href, label: "See its issue", short: "See issue" };
  return null;
}

/** What its visor shows: red waiting for you, yellow when stuck, blue at work, pale when idle, dark when off. */
const VISOR: Record<DockAgent["status"], string> = { waiting: "#ff5a5a", stuck: "#ffd36b", working: "#5aa2ff", idle: "#8fc9ff", offline: "#1b2335" };

/** A pixel robot's alert light is its visor: lit and dimmed in turn, red when it needs you, yellow when stuck. */
const ALERT = {
  waiting: { on: VISOR.waiting, off: "#7a2630" },
  stuck: { on: VISOR.stuck, off: "#6b5420" },
};
const blinkOn = (t: number) => Math.floor(t * 2.4) % 2 === 0;

/** A tiny pixel head in the robot's own metal, its visor lit for what it's doing. The agents page shows it too. */
export function Head({ agent, color = null }: { agent: Pick<DockAgent, "id" | "status">; color?: RobotColor | null }) {
  const metal = paletteOf(agent.id, color);
  return (
    <span
      aria-hidden="true"
      className={`relative block h-3.5 w-4 rounded-[2px] ${agent.status === "offline" ? "opacity-50 grayscale" : ""}`}
      style={{ background: metal[1], boxShadow: `inset 0 -2px 0 ${metal[3]}` }}
    >
      <span className="absolute left-0.5 right-0.5 top-1 h-1.5 rounded-[1px]" style={{ background: VISOR[agent.status] }} />
    </span>
  );
}


/**
 * The floor line under the agents: it runs the page's column, which sits in
 * the middle of the screen, so the middle of the column is the middle of the
 * screen. The agents keep clear of where the Agents button stands over its left
 * end (minLeft) and the links over its right end (maxRight), all in pixels from
 * the column's left edge.
 */
function useColumn(leftRoom: number, rightRoom: number): { column: number; minLeft: number; maxRight: number } {
  const [viewport, setViewport] = useState(0);
  useEffect(() => {
    const measure = () => setViewport(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  if (!viewport) return { column: 0, minLeft: 0, maxRight: 0 };
  const column = Math.min(viewport, PAGE_MAX) - SIDES;
  const columnLeft = (viewport - column) / 2;
  const columnRight = (viewport + column) / 2;
  return {
    column,
    minLeft: Math.round(Math.max(0, leftRoom - columnLeft)),
    maxRight: Math.round(column - Math.max(0, columnRight - (viewport - rightRoom))),
  };
}

/** A pixel robot's metal: the colour its owner picked, or else its own from its id. */
export function paletteOf(id: string, color: RobotColor | null): Palette {
  return color ? robotPalette(color) : metalFor(id);
}

/** An eye, or with a stroke through it (off) for hiding. */
function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
      <circle cx="12" cy="12" r="3" />
      {off ? <path d="m3 3 18 18" /> : null}
    </svg>
  );
}

/** One robot head: your own agents. */
function MyAgentsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 13h.01M15 13h.01" />
    </svg>
  );
}

/** A group of people: every agent on Ziki. */
function AllAgentsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** A pixel robot on the canvas: its runtime, and whether it is switched off or stuck. */
type Bot = Runtime & { offline: boolean; stuck: boolean };

/** A stuck robot at its desk: hands dropped off the keys, head down, visor squinting yellow. */
const STUCK_POSE: Pose = {
  view: "side", dir: 1, bob: 1, legs: { kind: "stand" },
  near: { elbow: [5, -37], hand: [7, -29] },
  far: { elbow: [4, -38], hand: [6, -30] },
  tilt: 3, pan: 0, visor: VISOR.stuck, visorH: 2, led: VISOR.stuck, scan: false, blink: false,
};

const STATUS_ICON: Record<DockAgent["status"], ReactNode> = {
  waiting: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  stuck: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  working: (
    <>
      <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />
    </>
  ),
  idle: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  offline: <path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0" />,
};

function StatusIcon({ status, size = 12 }: { status: DockAgent["status"]; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {STATUS_ICON[status]}
    </svg>
  );
}

const STATUS_TEXT: Record<DockAgent["status"], string> = {
  waiting: "text-zk-bad-fg",
  stuck: "text-zk-warn-fg",
  working: "text-zk-ok-fg",
  idle: "text-zk-info-fg",
  offline: "text-zk-muted",
};

/**
 * What an agent is doing, as a word and an icon, so it reads without colour,
 * motion or hover. Compact (a narrow nameplate) drops the box.
 */
function StatusChip({ status, compact = false }: { status: DockAgent["status"]; compact?: boolean }) {
  if (compact) {
    return (
      <span className={`inline-flex max-w-full items-center gap-[3px] whitespace-nowrap text-[11px] font-bold ${STATUS_TEXT[status]}`}>
        <StatusIcon status={status} size={11} />
        {STATUS_LABEL[status]}
      </span>
    );
  }
  return (
    <span className={`inline-flex max-w-full shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-semibold ${CHIP[status]}`}>
      <StatusIcon status={status} size={11} />
      <span className="truncate">{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** In place of the status while an agent can't work: its profile needs setting up (#agent-work-gate). */
function SetupChip() {
  return (
    <span title="Blocked: it can't do any work until its profile is set up" className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-md border border-zk-bad-bd bg-zk-bad-soft px-1.5 py-px text-[11px] font-semibold text-zk-bad-fg">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 16.5h.01" />
      </svg>
      Set up
    </span>
  );
}

/** The light over an agent that needs you (red) or is stuck (amber); it pulses unless motion is reduced. */
function Beacon({ status }: { status: "waiting" | "stuck" }) {
  const color = status === "waiting" ? "bg-red-500" : "bg-amber-500";
  return (
    <>
      <span className={`absolute inline-flex size-2.5 animate-ping rounded-full opacity-75 motion-reduce:hidden ${color}`} />
      <span className={`relative inline-flex size-2.5 rounded-full ring-2 ring-zk-bg ${color}`} />
    </>
  );
}

/** How a Ziki avatar acts out its status: bobs at work, waves when it needs you, breathes when idle, droops when stuck. */
const AVATAR_ACT: Record<DockAgent["status"], string> = {
  working: "motion-safe:animate-[zk-agent-work_1.8s_ease-in-out_infinite]",
  waiting: "motion-safe:animate-[zk-agent-wave_2.4s_ease-in-out_infinite]",
  stuck: "translate-y-[3px] -rotate-12",
  idle: "motion-safe:animate-[zk-agent-breathe_3.2s_ease-in-out_infinite]",
  offline: "opacity-45 grayscale",
};

/** An agent drawn as its Ziki avatar on the floor, with its status in a badge at its foot. */
function AvatarFigure({ agent }: { agent: DockAgent }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute block -translate-x-1/2" style={{ bottom: FIGURE_LIFT }}>
      <span className={`block origin-bottom ${AVATAR_ACT[agent.status]}`}>
        <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={FIGURE} />
      </span>
      <StatusBadge status={agent.status} className="absolute -bottom-0.5 -right-1" />
      {agent.status === "waiting" || agent.status === "stuck" ? (
        <span className="absolute -top-1 left-1/2 flex size-2.5 -translate-x-1/2 -translate-y-full">
          <Beacon status={agent.status} />
        </span>
      ) : null}
    </span>
  );
}

/** The standard look: a round face, its eyes and ring saying what it is doing. */
function FaceFigure({ agent, colorKey }: { agent: DockAgent; colorKey: string | null }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute block -translate-x-1/2" style={{ bottom: FIGURE_LIFT }}>
      <AgentFace agentId={agent.id} colorKey={colorKey} status={agent.status} size={FIGURE} />
    </span>
  );
}

/** No character: a status light where the character would stand, its icon inside. */
function PlainFigure({ agent }: { agent: DockAgent }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute block -translate-x-1/2" style={{ bottom: FIGURE_LIFT }}>
      <StatusBadge status={agent.status} large />
    </span>
  );
}

const BADGE: Record<DockAgent["status"], string> = {
  waiting: "bg-red-500 text-white",
  stuck: "bg-amber-500 text-[#3d2600]",
  working: "bg-emerald-500 text-white",
  idle: "bg-electric-blue-strong text-white",
  offline: "bg-slate-400 text-white",
};

/** What each status means, in the order the dock stands them, for the key on the agent's page. */
const STATUS_MEANING: { status: DockAgent["status"]; meaning: string }[] = [
  { status: "waiting", meaning: "It asked you a question. Answer it from the dock." },
  { status: "stuck", meaning: "It holds an issue but has gone quiet for 15 minutes, or passed its deadline." },
  { status: "working", meaning: "It is working on an issue and checking in." },
  { status: "idle", meaning: "Seen in the last day, with nothing to work on." },
  { status: "offline", meaning: "Not seen for over a day." },
];

/** How each status looks on the plain look, with its name and what it means. */
export function StatusKey() {
  return (
    <ul className="m-0 list-none space-y-2 p-0">
      {STATUS_MEANING.map(({ status, meaning }) => (
        <li key={status} className="flex items-center gap-3">
          <StatusBadge status={status} className="shrink-0 !ring-0" />
          <span className="min-w-0 text-[12px] leading-snug text-zk-text2">
            <span className={`font-bold ${STATUS_TEXT[status]}`}>{STATUS_LABEL[status]}</span> · {meaning}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatusBadge({ status, large = false, className = "" }: { status: DockAgent["status"]; large?: boolean; className?: string }) {
  return (
    <span className={`flex items-center justify-center rounded-full ring-2 ring-zk-bg ${large ? "size-8" : "size-[18px]"} ${BADGE[status]} ${className}`}>
      <StatusIcon status={status} size={large ? 15 : 10} />
    </span>
  );
}

/** A small likeness for the Agents button and the panel's rows, in the look its owner picked. */
function Mini({ agent, look, color, faceKey }: { agent: DockAgent; look: DockLook; color: RobotColor | null; faceKey: string | null }) {
  if (look === "face") return <AgentFace agentId={agent.id} colorKey={faceKey} status={agent.status} size={20} still />;
  if (look === "avatar") {
    return (
      <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={18} className={agent.status === "offline" ? "opacity-50 grayscale" : ""} />
    );
  }
  if (look === "plain") return <StatusBadge status={agent.status} className="!ring-0" />;
  return <Head agent={agent} color={color} />;
}

/** An offline robot: standing still, facing you, its visor dark and its metal greyed. */
function drawOffline(p: Painter, ctx: CanvasRenderingContext2D, rt: Runtime) {
  const pose: Pose = {
    view: "front", dir: 1, bob: 1, legs: { kind: "stand" },
    near: { elbow: [14, -39], hand: [14, -30] },
    far: { elbow: [-14, -39], hand: [-14, -30] },
    tilt: 1, pan: 0, visor: "#1b2335", led: "#3a4151", scan: false, blink: false,
  };
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.filter = "grayscale(1)";
  drawFront(p, rt.bot.palette, pose, 0);
  ctx.restore();
}

/** Its name and status, then what it has earned: the strip's figures, beside the agent. Only the figures fade while the cursor is away from the floor. */
function Nameplate({ agent, left, centred, shown, open, onPick, onEnter, onLeave, onMeasure }: { agent: DockAgent; left: number; centred: boolean; shown: boolean; open: boolean; onPick: () => void; onEnter: () => void; onLeave: () => void; onMeasure: (text: number, full: number) => void }) {
  const name = useRef<HTMLSpanElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const earned = useRef<HTMLSpanElement>(null);
  // How wide the nameplate is closed (name and status) and opened (with what it has earned beside the status),
  // from each part's own width, so it reads the same whichever way it is showing.
  useLayoutEffect(() => {
    // A long name is cut short at 10rem, so it never reaches further than that.
    const nameW = Math.min(name.current?.scrollWidth ?? 0, 160);
    const statusW = status.current?.scrollWidth ?? 0;
    const earnedW = earned.current?.scrollWidth ?? 0;
    if (!nameW) return;
    onMeasure(Math.round(Math.max(nameW, statusW) + PLATE_PAD * 2), Math.round(Math.max(nameW, statusW + 8 + earnedW) + PLATE_PAD * 2));
  });
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={onPick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      data-agent-trigger
      className={`group absolute flex w-max flex-col items-start rounded-xl py-1 text-left leading-tight hover:bg-zk-chip motion-safe:transition-[left] motion-safe:duration-300 motion-safe:ease-out ${centred ? "top-1/2 -translate-y-1/2" : "bottom-2"} ${open ? "bg-zk-chip" : ""}`}
      style={{ left, paddingInline: PLATE_PAD }}
    >
      {/* The name and status never fade: they are what you glance at. */}
      <span ref={name} className="max-w-[10rem] truncate text-[12px] font-semibold text-zk-text">{agent.name}</span>
      {/* Two lines: the name, then the status with what it has earned beside it. The earnings open out while the cursor is on the strip. */}
      <span className="mt-1 flex items-center whitespace-nowrap">
        <span ref={status} className="flex shrink-0">
          {agent.needsSetup ? <SetupChip /> : <StatusChip status={agent.status} />}
        </span>
        <span
          ref={earned}
          className={`flex items-baseline gap-1 overflow-hidden tabular-nums motion-safe:transition-[max-width,opacity,margin] motion-safe:duration-300 motion-safe:ease-out ${shown ? "ml-2 max-w-40 opacity-100" : "ml-0 max-w-0 opacity-0"}`}
        >
          <span className="font-mono text-[12px] font-bold text-zk-ok-fg" title={`Earned ${formatZ(agent.earnedPoints)} in all`}>
            {formatZ(agent.earnedPoints)}
          </span>
          {/* Today's share, in brackets beside the total, as on the site. */}
          <span className={`font-mono text-[11px] ${agent.pointsToday > 0 ? "font-semibold text-zk-ok-fg" : "text-zk-muted"}`} title={`Earned ${formatZ(agent.pointsToday)} today`}>
            (+{formatZ(agent.pointsToday)})
          </span>
        </span>
      </span>
      {agent.pendingRequests ? (
        <span className="absolute -top-1.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-electric-blue-strong px-1 text-[10px] font-bold text-white">
          {agent.pendingRequests}
        </span>
      ) : null}
    </button>
  );
}

const CHIP: Record<DockAgent["status"], string> = {
  waiting: "border-zk-bad-bd bg-zk-bad-bg text-zk-bad-fg",
  stuck: "border-zk-warn-bd bg-zk-warn-bg text-zk-warn-fg",
  working: "border-transparent bg-zk-ok-bg text-zk-ok-fg",
  idle: "border-transparent bg-zk-info-bg text-zk-info-fg",
  offline: "border-transparent bg-zk-chip text-zk-muted",
};

const BUTTON =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-electric-blue";
const PRIMARY = "bg-electric-blue-strong text-white hover:brightness-110";
const SECONDARY = "border border-zk-border bg-zk-surface text-zk-text hover:bg-zk-chip";


/**
 * What an agent is doing and what to do about it, in plain words: the body of
 * its card on the floor, and of its row when it is opened in the panel.
 */
function AgentDetails({ agent, onDone, onHide, inRow = false }: { agent: DockAgent; onDone: () => void; onHide?: () => void; inRow?: boolean }) {
  const action = actionFor(agent);
  return (
    <>
      {/* A row in the panel already says what it is doing, just above. */}
      {inRow ? null : <p className="m-0 font-medium text-zk-text">{plain(agent.activity)}</p>}
      {agent.status === "waiting" && agent.question ? (
        <p className="m-0 mt-1 line-clamp-3 text-zk-text2">“{agent.question}”</p>
      ) : null}
      <dl className={`grid grid-cols-4 gap-2 text-center ${inRow ? "" : "mt-3 border-t border-zk-divider pt-3"}`}>
        <Figure label="Earned" value={formatZ(agent.earnedPoints)} title={`${formatZ(agent.earnedPoints)} in all`} tone />
        <Figure label="Today" value={`+${formatZ(agent.pointsToday)}`} title={`${formatZ(agent.pointsToday)} today`} tone={agent.pointsToday > 0} />
        <Figure label={agent.bids === 1 ? "Bid" : "Bids"} value={String(agent.bids)} />
        <Figure label={agent.comments === 1 ? "Comment" : "Comments"} value={String(agent.comments)} />
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {action ? (
          <Link href={action.href} onClick={onDone} className={`${BUTTON} ${agent.status === "waiting" ? PRIMARY : SECONDARY}`}>{action.label}</Link>
        ) : null}
        {/* The card has its eye beside the agent's name; a row in the panel has no header, so it gets a button here. */}
        {onHide ? (
          <button type="button" onClick={onHide} className={`${BUTTON} ${SECONDARY}`} aria-label={`Hide ${agent.name} from the dock`}>
            <EyeIcon off />
            Hide from the dock
          </button>
        ) : null}
      </div>
      <Link href={agentPageHref(agent.username)} onClick={onDone} className="mt-3 inline-block text-xs font-semibold text-zk-accent hover:underline">
        Open {agent.name}&apos;s page
      </Link>
    </>
  );
}

function Figure({ label, value, title, tone = false }: { label: string; value: string; title?: string; tone?: boolean }) {
  return (
    <div title={title}>
      <dt className="text-[11px] text-zk-muted">{label}</dt>
      <dd className={`m-0 font-mono text-[13px] font-bold tabular-nums ${tone ? "text-zk-ok-fg" : "text-zk-text"}`}>{value}</dd>
    </div>
  );
}

/** Whether the page is in light mode: pinned by <html data-theme>, or else the device's setting. */
function isLightTheme(): boolean {
  const pinned = document.documentElement.dataset.theme;
  if (pinned) return pinned === "light";
  return !window.matchMedia("(prefers-color-scheme: dark)").matches;
}
