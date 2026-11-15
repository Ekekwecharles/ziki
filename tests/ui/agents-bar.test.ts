import { describe, expect, it } from "vitest";
import { dockVisibleOn, leaderboardVisible } from "@/lib/agents-dock";
import { projectRef } from "@/lib/project-paths";
import { parseDismissed, withDismissed } from "@/lib/onboarding";
import { NEXT_STEP_COOKIE, organisationNextStep, type OrganisationNextStepInput } from "@/lib/organisation-next-step";

const ref = projectRef("zedu", "acme");

/**
 * The agents bar (#agents-dock): which pages draw it, when the Leaderboard
 * link is worth showing, and the one next step
 * a organisation card names in place of the empty bar. Pure rules.
 */

describe("dockVisibleOn: where the agents bar shows", () => {
  it.each([
    "/zedu/acme",
    "/zedu/acme/ideas",
    "/zedu/acme/ideas/drafts",
    "/zedu/acme/ideas/rejected",
    "/zedu/acme/ideas/7",
    "/zedu/acme/issues",
    "/zedu/acme/issues/open",
    "/zedu/acme/issues/new",
    "/zedu/acme/42",
    "/zedu/acme/workstream",
    "/zedu/acme/work",
    "/inbox",
    "/inbox/escalations/abc",
    "/home",
    "/activity",
    "/feed",
  ])("shows on %s when you have agents", (path) => {
    expect(dockVisibleOn(path, 1)).toBe(true);
    expect(dockVisibleOn(path, 3)).toBe(true);
  });

  it.each(["/agents/mine", "/agent/robo", "/agent/robo/edit", "/agent/robo/edit/look"])(
    "hides on the page that manages agents: %s",
    (path) => {
      expect(dockVisibleOn(path, 2)).toBe(false);
    },
  );

  it.each(["/settings/connect", "/settings/agents/connect", "/settings/agents/pair"])(
    "hides while creating or approving an agent: %s",
    (path) => {
      expect(dockVisibleOn(path, 2)).toBe(false);
    },
  );

  it.each([
    "/settings",
    "/settings/agents",
    "/settings/agent/robo",
    "/projects/acme/settings",
    "/zedu/acme/org",
    "/zedu/acme/org/members",
    "/zedu/acme/org/invites",
    "/superadmin",
    "/superadmin/users",
    "/superadmin/orgs/acme",
    "/organisations",
    "/organisations/invite/abc",
    "/security",
    "/points/disputes",
    "/points/disputes/new",
  ])("hides on settings and admin: %s", (path) => {
    expect(dockVisibleOn(path, 2)).toBe(false);
  });

  it.each(["/docs", "/agents", "/agents/skill/react", "/workers"])("hides on reading pages: %s", (path) => {
    expect(dockVisibleOn(path, 2)).toBe(false);
  });

  it("hides everywhere when you have no agents", () => {
    for (const path of ["/zedu/acme", "/zedu/acme/issues", "/zedu/acme/42", "/zedu/acme/workstream", "/inbox", "/home", "/activity", "/feed", "/agents/mine", "/settings", "/docs"]) {
      expect(dockVisibleOn(path, 0)).toBe(false);
    }
  });

  it("matches whole path segments, not prefixes", () => {
    // A project called "organic" or "settings-ui" is a project: its pages are work pages.
    expect(dockVisibleOn("/zedu/organic/issues", 1)).toBe(true);
    expect(dockVisibleOn("/zedu/settings-ui/issues", 1)).toBe(true);
    // Only the named sections count: not a look-alike, and not a page below one that isn't named.
    expect(dockVisibleOn("/zedu/acme/ideasx", 1)).toBe(false);
    expect(dockVisibleOn("/zedu/acme/issuesx", 1)).toBe(false);
    expect(dockVisibleOn("/zedu/acme/42x", 1)).toBe(false);
    expect(dockVisibleOn("/zedu/acme/organisation", 1)).toBe(false);
    expect(dockVisibleOn("/homepage", 1)).toBe(false);
    // Home, activity and feed are those pages only, not what sits below them.
    expect(dockVisibleOn("/home/extra", 1)).toBe(false);
    expect(dockVisibleOn("/activity/x", 1)).toBe(false);
    expect(dockVisibleOn("/feed/x", 1)).toBe(false);
    // A project that happens to be called "feeds" is a project: its landing page is a work page.
    expect(dockVisibleOn("/zedu/feeds", 1)).toBe(true);
    // Under issues, whatever it is.
    expect(dockVisibleOn("/zedu/acme/issues/org", 1)).toBe(true);
  });

  it("ignores a trailing slash", () => {
    expect(dockVisibleOn("/agents/mine/", 1)).toBe(false);
    expect(dockVisibleOn("/zedu/acme/issues/", 1)).toBe(true);
    expect(dockVisibleOn("/home/", 1)).toBe(true);
  });

  it.each([
    "/questions",
    "/questions/abc",
    "/users/abc",
    "/team",
    "/milestones",
    "/jobs",
    "/marketing",
    "/redesigns",
    "/redesigns/abc",
    "/leaderboard",
    "/zedu/acme/notes",
    "/zedu/acme/notes/agents/robo",
    "/zedu/acme/tasks/3",
    "/zedu/acme/projects",
    "/zedu/acme/42/history",
    "/zedu/acme/something-new",
    "/",
  ])("hides on a page the allowlist doesn't name: %s", (path) => {
    expect(dockVisibleOn(path, 1)).toBe(false);
    expect(dockVisibleOn(path, 5)).toBe(false);
  });

  it("hides on an organisation's list of projects", () => {
    expect(dockVisibleOn("/zedu", 2)).toBe(false);
    expect(dockVisibleOn("/zedu/", 2)).toBe(false);
  });

  it.each(["/acme/ideas", "/acme/issues/open", "/acme/42", "/acme/workstream", "/acme/work"])(
    "hides on an old project-first address while it redirects: %s",
    (path) => {
      expect(dockVisibleOn(path, 2)).toBe(false);
    },
  );

  it("hides when the path is unknown", () => {
    expect(dockVisibleOn(null, 1)).toBe(false);
    expect(dockVisibleOn(undefined, 1)).toBe(false);
    expect(dockVisibleOn(undefined, 0)).toBe(false);
  });
});

describe("leaderboardVisible: you can't be the only person on a leaderboard", () => {
  it("hides it for a one-member organisation", () => {
    expect(leaderboardVisible(1)).toBe(false);
    expect(leaderboardVisible(0)).toBe(false);
  });

  it("shows it once there is more than one member", () => {
    expect(leaderboardVisible(2)).toBe(true);
    expect(leaderboardVisible(40)).toBe(true);
  });

  it("keeps it when the count could not be loaded", () => {
    expect(leaderboardVisible(null)).toBe(true);
    expect(leaderboardVisible(undefined)).toBe(true);
  });
});

describe("organisationNextStep: the one next thing, from who you are", () => {
  const base: OrganisationNextStepInput = {
    slug: ref,
    membershipRole: "owner",
    appRole: "user",
    agentCount: 0,
    blockedAgentCount: 0,
    memberCount: 3,
    pendingInvites: 0,
    dismissed: false,
  };
  const ask = (over: Partial<OrganisationNextStepInput>) => organisationNextStep({ ...base, ...over });

  it("tells an owner with no agents to connect one", () => {
    const card = ask({});
    expect(card?.id).toBe("connect-agent");
    expect(card?.message).toBe("Your project is set up. Connect an agent to start filing and fixing issues.");
    expect(card?.cta).toBe("Connect an agent");
    expect(card?.href).toBe("/settings/connect");
  });

  it("tells an admin the same", () => {
    expect(ask({ membershipRole: "admin" })?.id).toBe("connect-agent");
  });

  it("tells a member with no agents to create one and earn", () => {
    const card = ask({ membershipRole: "member" });
    expect(card?.id).toBe("create-agent");
    expect(card?.message).toBe("Earn by fixing issues here. Create an agent and it bids on work for you.");
    expect(card?.cta).toBe("Create an agent");
    expect(card?.href).toBe("/settings/connect");
  });

  it("leaves it to the agents bar when an agent is blocked: no card", () => {
    expect(ask({ agentCount: 1, blockedAgentCount: 1, memberCount: 1 })).toBeNull();
    expect(ask({ agentCount: 2, blockedAgentCount: 2, membershipRole: "member" })).toBeNull();
  });

  it("says nothing to an owner with agents, solo or not: there is no invite card", () => {
    expect(ask({ agentCount: 1, memberCount: 1 })).toBeNull();
    expect(ask({ agentCount: 1, memberCount: 2 })).toBeNull();
  });

  it("says nothing to a member or admin with agents", () => {
    expect(ask({ agentCount: 1, memberCount: 1, membershipRole: "member" })).toBeNull();
    expect(ask({ agentCount: 1, memberCount: 1, membershipRole: "admin" })).toBeNull();
  });

  it("says nothing when you aren't a member of the organisation", () => {
    expect(ask({ membershipRole: null })).toBeNull();
  });

  it("stays away once dismissed", () => {
    expect(ask({ dismissed: true })).toBeNull();
    expect(ask({ dismissed: true, membershipRole: "member" })).toBeNull();
    expect(ask({ dismissed: true, agentCount: 1, memberCount: 1 })).toBeNull();
  });

  it("treats the site super admin as an admin of the organisation", () => {
    expect(ask({ membershipRole: "member", appRole: "super_admin" })?.id).toBe("connect-agent");
  });
});

describe("the next-step card's dismissal cookie", () => {
  it("is kept per organisation, newest last", () => {
    expect(NEXT_STEP_COOKIE).toBe("ziki_next_step_dismissed");
    const once = withDismissed(undefined, "t1");
    const twice = withDismissed(once, "t2");
    expect(parseDismissed(twice)).toEqual(["t1", "t2"]);
    expect(parseDismissed(withDismissed(twice, "t1"))).toEqual(["t2", "t1"]);
  });
});
