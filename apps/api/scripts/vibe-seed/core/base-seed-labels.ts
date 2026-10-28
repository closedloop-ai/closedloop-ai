import { DocumentType } from "@repo/api/src/types/document";

/**
 * ISS-12056 (Seed quality): the team-authored names and text that replace the
 * `@repo/database` base seed's generated labels ("Scaled Seed Project 3",
 * "Seed Document (DRAFT)", "Scaled seed comment 12.") in the vibe org. Seeded
 * data, not product copy. The base seed keeps its own names because e2e specs
 * and its non-empty-org guard key on them.
 */

/** Template names follow the product's own default ("Product Requirements Document Template"). */
export const TEMPLATE_TITLES: Readonly<Record<string, string>> = {
  [DocumentType.Prd]: "Product Requirements Document Template",
  [DocumentType.ImplementationPlan]: "Implementation Plan Template",
  [DocumentType.Feature]: "Issue Template",
  [DocumentType.Doc]: "Doc Template",
};

const PRD_BODY = `## Problem

Teams told us this is one of the slowest parts of their week, and support tickets about it doubled last quarter.

## Goals

- Halve the time it takes to finish the flow
- Ship to the beta cohort behind a flag before general release

## Non-goals

- Changing how existing data is stored

## Open questions

- Is a per-user default enough, or do admins need an org setting?
`;

const PLAN_BODY = `## Approach

1. Add the new fields to the API as optional, so older clients keep working.
2. Backfill existing rows in batches with a resumable job.
3. Switch reads over once the backfill reports complete.
4. Remove the old code path after one release.

## Risks

- The backfill competes with nightly exports; schedule it outside that window.

## Rollout

Behind a flag for internal workspaces first, then the beta cohort.
`;

const DOC_BODY = `## Summary

What we decided, why, and who to ask.

## Decision

We keep the current behavior for existing workspaces and apply the new rule to workspaces created after the release.

## Owners

Product and the platform team share this; changes go through the weekly review.
`;

const ISSUE_BODY = `## What happens

Steps to reproduce are in the linked support ticket; it happens on every attempt.

## Expected

The action completes and the list updates without a reload.

## Notes

Started after the last release; nothing in the logs beyond a timeout.
`;

const TEMPLATE_BODY = `## Problem

## Goals

## Non-goals

## Open questions
`;

/** Body text per document subtype, written under the document's own title. */
export const DOCUMENT_BODIES: Readonly<Record<string, string>> = {
  [DocumentType.Prd]: PRD_BODY,
  [DocumentType.ImplementationPlan]: PLAN_BODY,
  [DocumentType.Doc]: DOC_BODY,
  [DocumentType.Feature]: ISSUE_BODY,
  [DocumentType.Template]: TEMPLATE_BODY,
};

/** Review comments by the kind of document they sit on, used in rotation. */
export const COMMENT_TEXTS_BY_SUBTYPE: Readonly<
  Record<string, readonly string[]>
> = {
  [DocumentType.Prd]: [
    "Do we have numbers on how many workspaces this affects?",
    "Agree with the direction. Let's confirm the API change with the mobile team.",
    "Can we get a quick screenshot of the empty state before this goes to review?",
    "The non-goals help. Can we say what happens to existing data?",
    "Support has three open tickets on this; linking them would help the review.",
    "Is the beta cohort the same one we used for the last launch?",
    "I'd like design to look at the second flow before we approve.",
    "Looks good to me. Approving once the open question has an owner.",
    "What will we check two weeks after launch to know this worked?",
    "Small thing: the second goal reads like two goals.",
  ],
  [DocumentType.ImplementationPlan]: [
    "I'd split the migration into its own step so we can ship it separately.",
    "Who owns the backfill? I can pair on it Thursday.",
    "Step 3 needs a rollback path if the backfill stalls halfway.",
    "Can we keep the old endpoint for one more release so older clients keep working?",
    "This touches the same tables as the nightly export; let's check the schedule.",
    "Estimate looks right to me. The risky part is step 2.",
    "Should this go behind a flag for internal workspaces first?",
    "We need an index before the read switch, or the list page will crawl.",
    "We should mention the rate limit in the changelog.",
  ],
  [DocumentType.Doc]: [
    "Let's keep the old behavior for existing workspaces, as discussed Tuesday.",
    "The mobile layout in the second frame cuts off the button label.",
    "Can we add the empty and error states to the frames?",
    "Agree with this. Linking it from the plan so it's easy to find.",
    "Who signs off on changes to this after launch?",
    "The secondary button looks low contrast in dark mode.",
    "This matches what we told the two enterprise customers.",
    "Moved the copy questions to the design review.",
  ],
  [DocumentType.Feature]: [
    "Picked this up; I'll have a pull request up tomorrow.",
    "Repro steps are in the support ticket. Happens on every attempt.",
    "Waiting on the API change; I'll pick it back up once that merges.",
    "Pull request is up for review.",
    "Moved to review. Checked on Chrome and Safari.",
    "Nice. This also fixes the export timeout we saw last week.",
    "Following up: the analytics event names are final now.",
    "Closing this out; verified on production.",
    "Can we cover the archived-project case before this closes?",
  ],
};

/** Replies from the document's owner to a reviewer's comment. */
export const REPLY_TEXTS: readonly string[] = [
  "Good catch, updated the doc.",
  "Agreed. I'll update that section today.",
  "Thanks, fixed in the latest version.",
  "Let's take this to Thursday's sync.",
  "Makes sense, changing it.",
  "Added a note on this.",
];

/** Comments that ask the signed-in person for something, by first name. */
export const MENTION_TEXTS: readonly ((name: string) => string)[] = [
  (name) => `@${name} can you sign off on the rollout order?`,
  (name) =>
    `@${name} do you want to look at the migration step before we approve?`,
  (name) =>
    `@${name} could you confirm the rate limit numbers with the platform team?`,
  (name) => `@${name} flagging this for the billing review on Thursday.`,
];

/** Replies a teammate leaves on the signed-in person's own comments. */
export const REPLY_TO_ADMIN_TEXTS: readonly string[] = [
  "Makes sense, I'll update it this afternoon.",
  "Agreed, moving it to the next sprint.",
  "Done. Can you take another look?",
];

export const ATTACHMENT_NAMES: Readonly<Record<string, string>> = {
  "seed-spec.pdf": "rollout-plan.pdf",
  "seed-screenshot.png": "projects-list-empty-state.png",
};

export const CUSTOM_FIELD_TEXTS: Readonly<Record<string, string>> = {
  "Seed notes for this project.":
    "Reviewed every sprint by the platform team; scope changes need a PRD update.",
  "Seed notes for this document.":
    "Needs a security review before the beta release.",
};
