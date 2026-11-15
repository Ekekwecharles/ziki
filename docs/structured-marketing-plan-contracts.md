# Structured Marketing Plan integration contracts

**Status: contract proposal for review.** This documents the existing Ziki boundary and the proposed data exchanged across it. It does not claim that Bishop's onboarding store or a downstream execution consumer exists in this repository. No route, endpoint, database table, queue, or consumer is introduced here.

## System boundary and trigger

Bishop owns the initial AI onboarding conversation, including website URL handling, business analysis, and collection of customer marketing requirements. Ziki's Structured Marketing Plan feature starts only after Bishop has persisted onboarding context and made it available to the project. Plan generation is triggered by an explicit customer action (“Generate marketing plan”) after the context passes the readiness check below. Merely finishing the conversation, saving context, or opening the plan page must not start generation or execution.

**Integration dependency:** Bishop's team must identify the persisted record, its stable identifier and revision/version, the authoritative project association, and the supported read or handoff mechanism. This repository has no Bishop conversation or onboarding-context model, read API, event, or documented endpoint. The shape below is the consumer-facing contract proposal to agree with Bishop; it is not a description of an existing Bishop payload.

## Onboarding context input

The plan generator should receive an immutable snapshot, or a stable reference that can resolve to an immutable snapshot, so a later onboarding edit cannot silently change the meaning of an existing plan.

```json
{
  "projectId": "<Ziki project id>",
  "source": {
    "system": "bishop",
    "contextId": "<Bishop context id>",
    "revision": "<Bishop context revision>",
    "capturedAt": "<ISO-8601 timestamp>"
  },
  "business": {
    "websiteUrl": "<validated URL or null>",
    "summary": "<customer-confirmed business description or null>"
  },
  "requirements": {
    "objectives": [],
    "audiences": [],
    "constraints": []
  }
}
```

This is a proposed semantic minimum, not an agreed wire format. Bishop must confirm field names, types, provenance, whether values can be absent, and how it represents corrections. Preserve provenance so customer-provided facts, derived analysis, and unknown values remain distinguishable. The marketing-plan feature must not infer that a website was successfully analyzed just because a URL is present.

### Readiness and missing context

Before generation, require a project association, a resolvable source context and revision, and enough customer-confirmed information to state at least one objective and an audience (or an explicit customer-approved “audience unknown” value). A website is optional; a business summary may be absent if the customer has not supplied one. Do not fill gaps with invented facts.

If the source cannot be resolved, belongs to another project, has an unsupported revision, or required information is missing, do not call the generator and do not create a plan. Return a field-level request for the missing information, retain the saved onboarding context, and let the customer resume or correct onboarding. Do not silently substitute a newer context revision into an existing draft.

## Structured strategy draft output

Generation returns a draft only. It does not approve activities, finalize a plan, publish content, create marketing tasks, or execute campaigns.

```json
{
  "source": { "contextId": "<id>", "revision": "<revision>" },
  "businessSummary": { "text": "...", "basis": "customer_input|derived|unknown" },
  "objectives": [{ "id": "<stable draft id>", "text": "...", "basis": "customer_input|derived|recommendation" }],
  "audiences": [{ "id": "<stable draft id>", "description": "...", "basis": "customer_input|derived|recommendation" }],
  "channels": [{ "id": "<stable draft id>", "name": "...", "rationale": "..." }],
  "activities": [{
    "id": "<stable draft id>", "channelId": "<channel id>", "title": "...",
    "description": "...", "priority": "high|medium|low",
    "budget": { "amount": null, "currency": null },
    "suggestedStart": null, "suggestedEnd": null,
    "dependencies": [], "expectedOutcome": "...", "measurements": []
  }]
}
```

This draft shape covers the agreed strategy sections: business summary, objectives, audiences, channels, activities, priorities, budget, timeline, dependencies, expected outcomes, and measurement suggestions. IDs are stable only within the draft until persistence assigns durable identifiers. Budget currency, numeric precision, timeline representation, activity decision states, and generation provenance need product confirmation before becoming a stored API contract. Unknown values remain null/empty with an explicit basis; generation must not manufacture budgets or promises.

## Authorization mapping

Existing project contribution and administration are different permissions:

| Action | Existing Ziki mapping | Contract for this feature |
| --- | --- | --- |
| Read or contribute within a project | `canContributeToProject`: accepted project member, organisation member, or site super-admin | Use the project's normal access check for plan visibility and editing; verify server-side on every request. |
| Change project marketing settings | `assertMarketingSettingsAccess` → `isAdminOfOrganisation`: organisation owner/admin or site super-admin | Existing precedent for administrative marketing controls; this does not itself authorize every plan decision. |
| Approve/reject an activity and finalize a plan | No customer-plan decision permission exists today | Proposed authority: organisation owner/admin or site super-admin, checked against the project's organisation. A project member alone is not sufficient. Team/product owner must affirm this mapping before Issue 5 implements it. |
| Accept Ziki marketing work | Existing agent workflow: manager/merger agent authority | This is an agent's acceptance of delivered marketing work, not customer approval of a strategy; do not reuse it for plan approval. |

Issue 5 implements the proposed owner/admin or site super-admin mapping by reusing `assertMarketingSettingsAccess` on every decision and finalization request. The original product contract marked this mapping for team confirmation; please confirm that policy before enabling the approval workflow for customers.

Project membership has no role field, and `Project` has no project-owner field. The feature must not invent a project-owner role or equate issue assignee/beneficiary with plan approver. Use existing organisation membership and permission helpers; keep the final customer approval authority as an explicit product decision until affirmed.

## Approval and revision invariants

- Each activity decision references both the durable activity ID and exact plan revision.
- Activity approval/rejection is distinct from final plan confirmation.
- Final confirmation is an explicit action on one revision and records the authorized actor and time.
- Only activities approved in the finalized revision are eligible for handoff.
- Editing an approved plan creates a new draft revision. Prior approved revisions and their decisions remain immutable and traceable.
- A decision or finalization request against a stale revision is rejected and returns the current revision; repeated requests must be idempotent.

These are product requirements for later persistence and approval issues, not implemented behavior in this contract-only change.

## Downstream handoff contract

The handoff is a versioned, idempotent message created only after a revision is finalized and authorized. Its conceptual envelope is:

```json
{
  "contractVersion": 1,
  "projectId": "<Ziki project id>",
  "planId": "<durable plan id>",
  "revisionId": "<finalized revision id>",
  "approvedAt": "<ISO-8601 timestamp>",
  "approvedBy": { "userId": "<authorized Ziki user id>" },
  "idempotencyKey": "<plan id>:<revision id>",
  "activities": [
    { "activityId": "<id>", "approvedAt": "<timestamp>", "approvedBy": "<user id>", "content": "<approved activity>" }
  ]
}
```

Exclude rejected and undecided activities. Include only the approved revision's customer-approved content and the budget/constraints needed by the agreed consumer. The approval record must be traceable to Ziki. Retries of the same finalized revision must not create duplicate downstream work; failures must leave a durable retryable handoff record.

**Integration dependency:** The downstream consumer, payload fields it requires, delivery transport, acknowledgement, retry owner, and idempotency-key compatibility are not identified in this repository or the supplied product decisions. The envelope above is a proposal for agreement, not an endpoint or an existing queue message. Issue 6 must not implement campaign execution, outreach, or publishing systems.

## Existing code and implementation boundaries

- `ProjectBrief` is the existing agent-facing marketing brief (`product`, `audience`, `website`, `current_focus`, `out_of_scope`); its website is read from `Project.siteUrl`. It is editable as project marketing settings and is not Bishop's persisted conversation context.
- `FeaturePlan` is a project feature-request breakdown, with private drafts and published issue/idea receipts. Its purpose and task schema differ from a customer marketing strategy.
- `Plan` in the agent API is a solver's implementation plan for a claimed issue, reviewed by the issue beneficiary. It is not customer plan approval.
- `AgentEvent` and `WebhookDelivery` support Ziki agent events and subscribed webhooks. No event type, consumer, or delivery contract for finalized customer marketing plans exists here.
- Existing marketing issue delivery/acceptance tracks work items through Ziki's issue lifecycle. It is not the strategy's approval or downstream execution workflow.

Do not repurpose these models by name alone. The persisted plan and revision model, Bishop adapter, customer approval records, and handoff worker belong to their respective follow-on issues after their contracts and owners are agreed.
