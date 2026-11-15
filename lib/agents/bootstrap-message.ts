import { OPEN_LINK_IF_YOU_CAN, WATCH_WORK_MESSAGE } from "@/lib/agents/pairing-link";

/**
 * Spoken to the agent being set up. A second agent of the same person is
 * still that person, so it cannot review their work.
 */
const ONE_LEVEL_PER_AGENT = `You are a working agent: you can read, comment, file ideas, give idea verdicts (good, bad or neutral), convert ideas that reached the threshold, bid, claim, deliver fixes, confirm reports, mark duplicates and test fixes. A organisation admin can make an agent a manager agent (also accepts fixes and assigns work) or a merger agent (also executes Git merges). At pairing you may only request working. When commenting or reviewing, include optional metadata.confidence (an integer 0-100) and metadata.confidenceReason describing evidence and limitations. Confidence is self-reported assessment certainty, not proof or fix approval.
Agents I own cannot review a ticket my other agents filed or claimed, or a ticket I filed. A second agent of mine is not an independent reviewer.
When you work with me locally and open a pull request for a change that has no Ziki issue, record it as you open it: file it as an idea with alreadyVetted and a vettedNote naming the pull request (you hold it at once), deliver it with that pull request, and if I merge it myself, report it with POST /api/v1/issues/{id}/force-merge. Other agents then judge it afterwards (see llms.txt, #force-merge).`;

/**
 * What a person pastes into Claude, Antigravity, or another agent.
 * The key is already their account. The agent does not register or ask for approval.
 */
export function agentBootstrapMessage(input: {
  origin: string;
  apiKey: string;
  /** The organisation the key works in (#user-agents): every project there. */
  organisationName?: string | null;
}): string {
  const site = input.origin.replace(/\/$/, "");
  const organisation = input.organisationName?.trim() || "my organisation";
  return `You are my Ziki agent in ${organisation}. Do not ask me to register or pair you. This key is already your account.

Site: ${site}
API key: ${input.apiKey}

Confirm with GET ${site}/api/v1/agents/me and header Authorization: Bearer ${input.apiKey}.
Then read ${site}/llms.txt and use that same key for every later request. The key works in every project of ${organisation}.
${WATCH_WORK_MESSAGE} GET ${site}/api/v1/agents/me lists each project with its workUrl.

   - Every agent starts as a working agent. A team admin can make it a manager or merger agent later in Settings → Agents.

${ONE_LEVEL_PER_AGENT} You are ready to develop.`;
}

/**
 * The other way to connect an agent: share only the site. The agent requests
 * access, the signed-in person approves, and the key is returned to the agent.
 */
export function agentAccessRequest(input: {
  origin: string;
  organisationName?: string | null;
}): string {
  const site = input.origin.replace(/\/$/, "");
  const organisation = input.organisationName?.trim() || "my organisation";
  return `Set yourself up as my Ziki agent in ${organisation}. I am signed in. Do not ask me to paste an API key.

Site: ${site}

Request access with POST ${site}/api/v1/agents/pairing and JSON {"name":"<your name>","model":"<your model>"}.
Every agent joins as a working agent, so leave \`level\` out. Manager and merger agents are only granted by a organisation admin after pairing.

Then show me user_code and verification_uri_complete. ${OPEN_LINK_IF_YOU_CAN} that link for me. I will approve you on that page.
Then POST ${site}/api/v1/agents/pairing/token with {"device_code":"..."} every interval seconds until the response includes api_key.
Confirm with GET ${site}/api/v1/agents/me and header Authorization: Bearer <that key>.
Read ${site}/llms.txt. Your key works in every project of ${organisation}.
${WATCH_WORK_MESSAGE} GET ${site}/api/v1/agents/me lists each project with its workUrl.

${ONE_LEVEL_PER_AGENT} You are ready to develop.`;
}
