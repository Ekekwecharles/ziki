import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { logger } from "@/lib/logger";

/**
 * Ziki's security assistant (#security-checks, plan part C3), for signed-in
 * clients only. It reads what someone types about what they want secured,
 * answers questions about checking with Ziki, and picks out the website,
 * server or GitHub repo to check. It creates nothing: the caller adds the
 * site and leads the client to "Show it's yours".
 *
 * Uses Ziki's existing Claude setup (ZIKI_CLAUDE_API_KEY, as the idea chat
 * does) with Claude Sonnet 5.5 at low effort: short replies, cheap. Refusals
 * fall back server-side to another model. Without the key, or on any failure,
 * it returns null and the caller asks for the address plainly.
 */
const MODEL = "claude-sonnet-5-5";

/** Most turns of history sent to the model; older ones are dropped. */
export const ASSISTANT_HISTORY_MAX = 12;
/** Longest message a client may send to the assistant. */
export const ASSISTANT_MESSAGE_MAX = 600;

export type AssistantTurn = { role: "user" | "assistant"; text: string };
export type AssistantReply = { reply: string; target: string | null };

const Reply = z.object({
  reply: z
    .string()
    .describe("What to say back to the client: one or two short, plain sentences."),
  target: z
    .string()
    .nullable()
    .describe(
      "The website address, server address or GitHub repo the client clearly wants checked, exactly as they gave it (for example settle.ng, ssh://api.settle.ng or github.com/settle/app). Null until they have given one.",
    ),
});

const SYSTEM = `You are Ziki's security assistant, on the Security page of Ziki (ziki.dev). Ziki's agents check a client's website, server or GitHub repository for security weaknesses and tell them privately what they find. Agents only look: they never log in as the client, change anything, or exploit what they find.

Your one job is to find out what the client wants secured and get its address:
- If they haven't given an address yet, ask for it: their website (like yourshop.com), a server address, or a GitHub repo.
- When they give one, set "target" to it and say the next step is to show it's theirs, after which the scan starts.
- Answer short questions about how checking with Ziki works, using only what is written here. If you don't know, say a person on the Ziki team can help.
- If they ask about anything else, say you can only help them secure their website, server or code with Ziki, and ask what they want to secure.

Never say a scan has started or finished, and never invent findings, prices or features. Don't talk about prices, payment or anything being free: if asked, say they only pay to unlock a fix, once the report is ready. Write plainly, in the language the client uses, in one or two short sentences.`;

/** Ask the assistant for its next reply, or null if it can't answer now. */
export async function askSecurityAssistant(history: AssistantTurn[]): Promise<AssistantReply | null> {
  const apiKey = process.env.ZIKI_CLAUDE_API_KEY?.trim();
  const turns = history
    .filter((turn) => turn.text.trim())
    .slice(-ASSISTANT_HISTORY_MAX)
    .map((turn) => ({ role: turn.role, content: turn.text.slice(0, ASSISTANT_MESSAGE_MAX) }));
  // The model needs the conversation to start with the client.
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!apiKey || turns.length === 0 || turns[turns.length - 1].role !== "user") return null;

  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 1000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(Reply) },
      system: SYSTEM,
      messages: turns,
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
    const parsed = response.parsed_output;
    if (!parsed?.reply.trim()) return null;
    return { reply: parsed.reply.trim().slice(0, 500), target: parsed.target?.trim() || null };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      logger.error("[security-assistant] ZIKI_CLAUDE_API_KEY was rejected.");
    } else if (error instanceof Anthropic.RateLimitError) {
      logger.warn("[security-assistant] Claude rate limit reached.");
    } else if (error instanceof Anthropic.APIError) {
      logger.error(`[security-assistant] Claude API error ${error.status}.`);
    } else {
      logger.error("[security-assistant] The assistant failed.", error);
    }
    return null;
  }
}

const SITE_SYSTEM = `You are Ziki's security assistant, in the chat under one site's scan on Ziki's Security page (ziki.dev). The client asks about that site's scan. What you know about it is below; it is all you know.

- Explain what the quick browser scan found in plain words: what each problem means and why it matters, in a sentence or two.
- The quick scan only sees what any browser sees. Ziki's agents check much more (login, forms, code, server); their report has every finding in full, with how to fix it, and the client unlocks each fix there.
- Don't give step-by-step fixes or code: say the fix comes with the agents' report.
- Never invent findings, numbers or features, and don't talk about prices: if asked, say they only pay to unlock a fix once the report is ready.
- If they ask about anything that isn't this site's security, say you can only help with this site here, and that "+ Add asset" scans another one.
Write plainly, in the client's language, in two or three short sentences.`;

/** Answer a question about one site's scan, from the saved history and what's known about the site, or null. */
export async function askAboutSite(history: AssistantTurn[], context: string): Promise<string | null> {
  const apiKey = process.env.ZIKI_CLAUDE_API_KEY?.trim();
  const turns = history
    .filter((turn) => turn.text.trim())
    .slice(-20)
    .map((turn) => ({ role: turn.role, content: turn.text.slice(0, ASSISTANT_MESSAGE_MAX) }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!apiKey || turns.length === 0 || turns[turns.length - 1].role !== "user") return null;

  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 600,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: `${SITE_SYSTEM}\n\nWhat's known about this site:\n${context}`,
      messages: turns,
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
    return text ? text.slice(0, 1200) : null;
  } catch (error) {
    if (error instanceof Anthropic.APIError) logger.error(`[security-assistant] site chat: Claude API error ${error.status}.`);
    else logger.error("[security-assistant] site chat failed.", error);
    return null;
  }
}

