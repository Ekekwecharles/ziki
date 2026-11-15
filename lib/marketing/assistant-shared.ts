/** What the Marketing assistant's page and server both read (#marketing-assistant). */

/** Longest message someone may send. */
export const MARKETING_ASSISTANT_MESSAGE_MAX = 4000;

export type MarketingTurn = { role: "user" | "assistant"; text: string };

/** A task the assistant drafted. Nothing is filed until the person files it. */
export type MarketingDraft = {
  title: string;
  typeId: string;
  typeName: string;
  description: string;
  rationale: string;
};

export type MarketingAnswer =
  | {
      ok: true;
      reply: string;
      /** What it looked at or did on the way, in plain words ("Read /pricing"). */
      activity: string[];
      drafts: MarketingDraft[];
    }
  | { ok: false; error: string };
