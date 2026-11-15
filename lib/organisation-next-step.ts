import { isOrganisationAdmin, type OrganisationRole } from "@/lib/organisation-role";
import type { ProjectRef } from "@/lib/project-paths";
import type { AppRole } from "@/lib/roles";

/**
 * The next-step card (#agents-dock): where the empty agents bar used to be, one
 * short card that tells this person the single next thing to do, from their role
 * and what the organisation already has. Not an ad, and not tracking: only roles
 * and counts the app already reads. The card is for the organisation; the per-issue
 * "who acts next" bar is components/next-step-bar.tsx, a different thing.
 */

/** Dismissals are remembered per organisation, on this device, for a year (lib/onboarding.ts). */
export const NEXT_STEP_COOKIE = "ziki_next_step_dismissed";
export const NEXT_STEP_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type OrganisationNextStepId = "connect-agent" | "create-agent" | "invite-teammate";

export type OrganisationNextStep = {
  id: OrganisationNextStepId;
  message: string;
  /** The primary pill. */
  cta: string;
  href: string;
};

export type OrganisationNextStepInput = {
  /** The project the card is shown in, for its links (#project-urls). */
  slug: ProjectRef;
  /** The person's role in this organisation; null when they aren't a member of it. */
  membershipRole: OrganisationRole | null;
  appRole?: AppRole | null;
  /** The person's own agents in this organisation (not revoked). */
  agentCount: number;
  /** Of those, the ones that can't work yet because their profile isn't set up (the agents bar marks them "Set up"). */
  blockedAgentCount: number;
  memberCount: number;
  pendingInvites: number;
  /** This organisation's card was dismissed on this device. */
  dismissed: boolean;
};

/** The card to show, or null for none. One at a time. */
export function organisationNextStep(input: OrganisationNextStepInput): OrganisationNextStep | null {
  if (input.dismissed || !input.membershipRole) return null;
  // Blocked agents are already marked "Set up" in the agents bar: no card for them.
  if (input.blockedAgentCount > 0) return null;

  return cardFor(input, input.membershipRole);
}

/** Which card this person's role and the organisation's counts call for, before dismissal is considered. */
function cardFor(
  { appRole, agentCount }: OrganisationNextStepInput,
  membershipRole: OrganisationRole,
): OrganisationNextStep | null {
  if (agentCount === 0) {
    return isOrganisationAdmin(membershipRole, appRole)
      ? {
          id: "connect-agent",
          message: "Your project is set up. Connect an agent to start filing and fixing issues.",
          cta: "Connect an agent",
          href: "/settings/connect",
        }
      : {
          id: "create-agent",
          message: "Earn by fixing issues here. Create an agent and it bids on work for you.",
          cta: "Create an agent",
          href: "/settings/connect",
        };
  }
  return null;
}
