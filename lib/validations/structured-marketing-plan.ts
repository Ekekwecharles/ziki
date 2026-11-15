import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const stableId = z.uuid();

export const marketingPlanSourceSchema = z.object({
  contextId: text(191),
  revision: text(191),
}).strict();

const sourcedTextSchema = z.object({
  id: stableId,
  text: text(1000),
  basis: z.enum(["customer_input", "derived", "recommendation", "unknown"]),
}).strict();

const audienceSchema = z.object({
  id: stableId,
  description: text(1000),
  basis: z.enum(["customer_input", "derived", "recommendation", "unknown"]),
}).strict();

const channelSchema = z.object({
  id: stableId,
  name: text(120),
  rationale: text(1000),
  basis: z.enum(["customer_input", "derived", "recommendation", "unknown"]),
}).strict();

export const marketingPlanActivitySchema = z.object({
  /** Omit for a new activity; the store assigns an id that remains stable across revisions. */
  id: stableId.optional(),
  channelId: stableId.nullable(),
  title: text(160),
  description: text(4000),
  basis: z.enum(["customer_input", "derived", "recommendation", "unknown"]),
  priority: z.enum(["high", "medium", "low"]),
  budget: z.object({
    amount: z.number().finite().nonnegative().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  }).strict().superRefine((budget, ctx) => {
    if ((budget.amount === null) !== (budget.currency === null)) {
      ctx.addIssue({ code: "custom", message: "Set both a budget amount and currency, or leave both unknown." });
    }
  }),
  suggestedStart: z.iso.date().nullable(),
  suggestedEnd: z.iso.date().nullable(),
  dependencies: z.array(text(240)).max(20),
  expectedOutcome: text(1000),
  measurements: z.array(text(240)).max(20),
}).strict().superRefine((activity, ctx) => {
  if (activity.suggestedStart && activity.suggestedEnd && activity.suggestedEnd < activity.suggestedStart) {
    ctx.addIssue({ code: "custom", path: ["suggestedEnd"], message: "The suggested end date must not be before the start date." });
  }
});

export const marketingPlanStrategySchema = z.object({
  businessSummary: z.object({
    text: text(2000),
    basis: z.enum(["customer_input", "derived", "unknown"]),
  }).strict(),
  assumptions: z.array(text(500)).max(20),
  objectives: z.array(sourcedTextSchema).max(20),
  audiences: z.array(audienceSchema).max(20),
  channels: z.array(channelSchema).max(20),
  activities: z.array(marketingPlanActivitySchema).max(100),
}).strict().superRefine((strategy, ctx) => {
  const activityIds = strategy.activities.flatMap((activity) => activity.id ? [activity.id] : []);
  if (new Set(activityIds).size !== activityIds.length) {
    ctx.addIssue({ code: "custom", path: ["activities"], message: "Each activity id can appear only once in a revision." });
  }
  const channelIds = new Set(strategy.channels.map((channel) => channel.id));
  strategy.activities.forEach((activity, index) => {
    if (activity.channelId && !channelIds.has(activity.channelId)) {
      ctx.addIssue({ code: "custom", path: ["activities", index, "channelId"], message: "Choose a channel in this plan." });
    }
  });
});

export const marketingPlanDraftSchema = z.object({
  title: text(160),
  source: marketingPlanSourceSchema,
  strategy: marketingPlanStrategySchema,
}).strict();

export const saveMarketingPlanDraftSchema = marketingPlanDraftSchema.extend({
  expectedRevision: z.number().int().min(1),
  expectedVersion: z.number().int().min(1),
});

export type MarketingPlanDraftInput = z.infer<typeof marketingPlanDraftSchema>;
export type MarketingPlanStrategyInput = z.infer<typeof marketingPlanStrategySchema>;
export type MarketingPlanActivityInput = z.infer<typeof marketingPlanActivitySchema>;
export type SaveMarketingPlanDraftInput = z.infer<typeof saveMarketingPlanDraftSchema>;
