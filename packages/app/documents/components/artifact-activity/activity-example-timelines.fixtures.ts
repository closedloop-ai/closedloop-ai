import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ATLAS,
  AUTH_TAG,
  activity,
  ago,
  assignment,
  BACKEND_TAG,
  bulk,
  comment,
  DESIGN_TAG,
  derivationRow,
  EMILY,
  evaluationRow,
  FRONTEND_TAG,
  field,
  fieldChange,
  HOUR,
  JAKE,
  MINUTE,
  ORION,
  PRD_751,
  RELEASE_TAG,
  RYAN,
  status,
  versionRow,
} from "./activity-catalog.fixtures";
import type { ActivityTimelineRow } from "./activity-timeline";

/**
 * The Document, Session and Branch example timelines (ISS-12117), built only
 * from what ISS-10994's capture report says each feed can return (Nerys,
 * 2026-10-08). Each row names its catalog row (C01–C31) or projection;
 * comments come from the host's own comment source, as the report says.
 * Every Session and Branch row is one of the three stored edit actions the
 * V1 Session/Branch reads return, so C30/C31 (retained monitored evidence,
 * excluded from the Session feed) are not here, and no Branch row is a PR,
 * CI or commit event. Each feed has a human, an agent (an API key, shown as
 * its owner with the API badge) and System.
 *
 * Oldest first; hosts and stories render them newest first (`newestFirst`),
 * as the read API pages. Times are working-hours wall-clock times in the
 * viewer's timezone, so "Sep 16, 09:12" reads the same everywhere.
 */

/** A wall-clock time in 2026, in the viewer's timezone. */
function at(month: number, day: number, hour: number, minute: number): Date {
  return new Date(2026, month - 1, day, hour, minute);
}

const SEP = 9;
const OCT = 10;

/** Document "ISS-1234 Activity tab V1" (Issue). */
export const DOCUMENT_EXAMPLE_ROWS: readonly ActivityTimelineRow[] = [
  // C01: created.
  activity(EMILY, at(SEP, 16, 9, 12), {
    action: ArtifactActivityAction.Creation,
    before: null,
    after: { status: "DRAFT", title: "Activity tab" },
  }),
  // version_created projection: the initial version.
  versionRow(EMILY, at(SEP, 16, 9, 13), 1),
  // C12: title.
  activity(EMILY, at(SEP, 16, 9, 20), {
    action: fieldChange,
    before: field("title", "Activity tab"),
    after: field("title", "Activity tab V1"),
  }),
  // C08: assignee set.
  activity(EMILY, at(SEP, 16, 9, 24), {
    action: assignment,
    before: field("assigneeId", null),
    after: field("assigneeId", JAKE.id),
  }),
  // C09: approver set.
  activity(EMILY, at(SEP, 16, 9, 25), {
    action: assignment,
    before: field("approverId", null),
    after: field("approverId", RYAN.id),
  }),
  // C14: priority set.
  activity(EMILY, at(SEP, 16, 9, 26), {
    action: fieldChange,
    before: field("priority", null),
    after: field("priority", "HIGH"),
  }),
  // C13: due date set.
  activity(EMILY, at(SEP, 16, 9, 27), {
    action: fieldChange,
    before: field("dueDate", null),
    after: field("dueDate", "2026-10-12T00:00:00.000Z"),
  }),
  comment(
    JAKE,
    at(SEP, 16, 11, 2),
    "doc-1",
    "I can take this. Do we show agent edits with the owner's name?"
  ),
  // C25: tags added in a batch (no single Document tag receipt exists).
  activity(EMILY, at(SEP, 17, 10, 15), {
    action: fieldChange,
    before: null,
    after: field("tag", DESIGN_TAG.id),
  }),
  activity(EMILY, at(SEP, 17, 10, 15), {
    action: fieldChange,
    before: null,
    after: field("tag", FRONTEND_TAG.id),
  }),
  // C19: project changed singly.
  activity(JAKE, at(SEP, 18, 14, 40), {
    action: fieldChange,
    before: field("projectId", ATLAS.id),
    after: field("projectId", ORION.id),
  }),
  // C02: status, by a person.
  activity(EMILY, at(SEP, 22, 16, 5), {
    action: status,
    before: "DRAFT",
    after: "IN_REVIEW",
  }),
  // version_created projection: a later version.
  versionRow(RYAN, at(SEP, 23, 10, 31), 2),
  comment(
    RYAN,
    at(SEP, 23, 10, 48),
    "doc-2",
    "Yes: the owner's name with an API badge, so it never reads as their own edit."
  ),
  // evaluation projection.
  evaluationRow(at(SEP, 24, 13, 12)),
  // derivation projection: a PRODUCES link.
  derivationRow(at(SEP, 25, 9, 0), "produced", PRD_751),
  // C04: unblocked automatically.
  activity("system", at(SEP, 29, 8, 30), {
    action: status,
    before: "BLOCKED",
    after: "TODO",
  }),
  // C02: status, by an agent (Jake's API key).
  activity({ apiKeyOwner: JAKE }, at(SEP, 29, 9, 5), {
    action: status,
    before: "TODO",
    after: "IN_PROGRESS",
  }),
  // C03: bulk status move.
  activity(JAKE, at(OCT, 2, 15, 20), {
    action: status,
    before: field("status", "IN_PROGRESS"),
    after: bulk("status", "IN_REVIEW"),
  }),
  // C15: bulk priority.
  activity(EMILY, at(OCT, 5, 11, 0), {
    action: fieldChange,
    before: field("priority", "HIGH"),
    after: bulk("priority", "URGENT"),
  }),
  // C20: moved between projects in a batch.
  activity(EMILY, at(OCT, 6, 10, 30), {
    action: fieldChange,
    before: field("projectId", ORION.id),
    after: bulk("projectId", ATLAS.id),
  }),
  // C13: due date changed.
  activity(JAKE, at(OCT, 6, 16, 45), {
    action: fieldChange,
    before: field("dueDate", "2026-10-12T00:00:00.000Z"),
    after: field("dueDate", "2026-10-19T00:00:00.000Z"),
  }),
  // C08: reassigned.
  activity(EMILY, at(OCT, 7, 9, 20), {
    action: assignment,
    before: field("assigneeId", JAKE.id),
    after: field("assigneeId", EMILY.id),
  }),
];

/**
 * An issue's history, oldest first: filed in Triage, picked up, worked by a
 * person and an agent, reviewed and closed Done. The issue statuses only, no
 * versions and no approver (an issue has neither, ISS-12576), and it ends on
 * the move to Done, so the Issue page's Activity brief closes on its latest
 * state.
 */
export const ISSUE_EXAMPLE_ROWS: readonly ActivityTimelineRow[] = [
  // C01: created, in Triage.
  activity(EMILY, at(SEP, 16, 9, 12), {
    action: ArtifactActivityAction.Creation,
    before: null,
    after: { status: "TRIAGE", title: "Activity tab" },
  }),
  // C08: owner set.
  activity(EMILY, at(SEP, 16, 9, 24), {
    action: assignment,
    before: field("assigneeId", null),
    after: field("assigneeId", JAKE.id),
  }),
  // C14: priority set.
  activity(EMILY, at(SEP, 16, 9, 26), {
    action: fieldChange,
    before: field("priority", null),
    after: field("priority", "HIGH"),
  }),
  // C13: due date set.
  activity(EMILY, at(SEP, 16, 9, 27), {
    action: fieldChange,
    before: field("dueDate", null),
    after: field("dueDate", "2026-10-12T00:00:00.000Z"),
  }),
  comment(
    JAKE,
    at(SEP, 16, 11, 2),
    "issue-1",
    "I can take this. Do we show agent edits with the owner's name?"
  ),
  // C25: a tag added.
  activity(EMILY, at(SEP, 17, 10, 15), {
    action: fieldChange,
    before: null,
    after: field("tag", DESIGN_TAG.id),
  }),
  // C02: out of Triage, by a person.
  activity(EMILY, at(SEP, 18, 9, 40), {
    action: status,
    before: "TRIAGE",
    after: "TODO",
  }),
  // C19: project changed.
  activity(JAKE, at(SEP, 18, 14, 40), {
    action: fieldChange,
    before: field("projectId", ATLAS.id),
    after: field("projectId", ORION.id),
  }),
  // C02: status, by an agent (Jake's API key).
  activity({ apiKeyOwner: JAKE }, at(SEP, 29, 9, 5), {
    action: status,
    before: "TODO",
    after: "IN_PROGRESS",
  }),
  comment(
    RYAN,
    at(SEP, 30, 10, 48),
    "issue-2",
    "Yes: the owner's name with an API badge, so it never reads as their own edit."
  ),
  // C02: into review, by a person.
  activity(JAKE, at(OCT, 2, 15, 20), {
    action: status,
    before: "IN_PROGRESS",
    after: "IN_REVIEW",
  }),
  // C13: due date changed.
  activity(JAKE, at(OCT, 6, 16, 45), {
    action: fieldChange,
    before: field("dueDate", "2026-10-12T00:00:00.000Z"),
    after: field("dueDate", "2026-10-19T00:00:00.000Z"),
  }),
  // C08: reassigned.
  activity(EMILY, at(OCT, 7, 9, 20), {
    action: assignment,
    before: field("assigneeId", JAKE.id),
    after: field("assigneeId", EMILY.id),
  }),
  // C02: closed Done.
  activity(EMILY, at(OCT, 8, 11, 5), {
    action: status,
    before: "IN_REVIEW",
    after: "DONE",
  }),
];

/** Session "Refactor auth middleware". */
export const SESSION_EXAMPLE_ROWS: readonly ActivityTimelineRow[] = [
  // C24: name seeded by sync.
  activity("system", at(SEP, 18, 8, 2), {
    action: fieldChange,
    before: field("name", null),
    after: field("name", "Refactor auth middleware"),
  }),
  // C18: priority seeded by sync.
  activity("system", at(SEP, 18, 8, 2), {
    action: fieldChange,
    before: field("priority", null),
    after: field("priority", "MEDIUM"),
  }),
  // C22: project set by ingest.
  activity("system", at(SEP, 18, 8, 3), {
    action: fieldChange,
    before: field("projectId", null),
    after: field("projectId", ORION.id),
  }),
  // C23: renamed by a person.
  activity(EMILY, at(SEP, 18, 9, 40), {
    action: fieldChange,
    before: field("name", "Refactor auth middleware"),
    after: field("name", "Auth middleware: token refresh"),
  }),
  // C10: owner changed singly.
  activity(EMILY, at(SEP, 18, 9, 42), {
    action: assignment,
    before: field("ownerUserId", EMILY.id),
    after: field("ownerUserId", JAKE.id),
  }),
  // C26: tag added singly.
  activity(JAKE, at(SEP, 19, 11, 15), {
    action: fieldChange,
    before: field("tag", null),
    after: field("tag", BACKEND_TAG.id),
  }),
  // C16: priority, by a person.
  activity(JAKE, at(SEP, 19, 11, 16), {
    action: fieldChange,
    before: field("priority", "MEDIUM"),
    after: field("priority", "HIGH"),
  }),
  comment(
    EMILY,
    at(SEP, 22, 14, 30),
    "session-1",
    "Jake, the refresh path still logs the token. Can you check before the release?"
  ),
  // C21: project changed singly.
  activity(JAKE, at(SEP, 23, 10, 5), {
    action: fieldChange,
    before: field("projectId", ORION.id),
    after: field("projectId", ATLAS.id),
  }),
  // C16: priority, by an agent (Jake's API key).
  activity({ apiKeyOwner: JAKE }, at(SEP, 24, 17, 20), {
    action: fieldChange,
    before: field("priority", "HIGH"),
    after: field("priority", "URGENT"),
  }),
  // C11: owners assigned in bulk.
  activity(EMILY, at(SEP, 26, 10, 0), {
    action: assignment,
    before: field("ownerUserId", JAKE.id),
    after: bulk("ownerUserId", EMILY.id),
  }),
  // C25: tag added in a batch.
  activity(EMILY, at(SEP, 29, 10, 12), {
    action: fieldChange,
    before: null,
    after: field("tag", AUTH_TAG.id),
  }),
  // C27: tag removed singly.
  activity(EMILY, at(SEP, 29, 10, 13), {
    action: fieldChange,
    before: field("tag", BACKEND_TAG.id),
    after: field("tag", null),
  }),
  // C20: moved between projects in a batch.
  activity(EMILY, at(OCT, 1, 15, 45), {
    action: fieldChange,
    before: field("projectId", ATLAS.id),
    after: bulk("projectId", ORION.id),
  }),
  // C05: status, by a person.
  activity(JAKE, at(OCT, 5, 18, 30), {
    action: status,
    before: "active",
    after: "inactive",
  }),
  // C06: status changed by ingest.
  activity("system", at(OCT, 6, 8, 55), {
    action: status,
    before: "inactive",
    after: "active",
  }),
  // C07: stale session reaped, ending with an error.
  activity("system", at(OCT, 7, 14, 20), {
    action: status,
    before: "active",
    after: "error",
  }),
];

/**
 * Branch "feature/auth-refactor". A Branch feed returns only stored edits
 * (priority, tags, project) and the host's comments: no PR, CI or commit rows.
 */
export const BRANCH_EXAMPLE_ROWS: readonly ActivityTimelineRow[] = [
  // C28: tag added singly.
  activity(EMILY, at(SEP, 21, 10, 5), {
    action: fieldChange,
    before: field("tag", null),
    after: field("tag", FRONTEND_TAG.id),
  }),
  // C17: priority, by a person.
  activity(EMILY, at(SEP, 21, 10, 6), {
    action: fieldChange,
    before: field("priority", "MEDIUM"),
    after: field("priority", "HIGH"),
  }),
  // C25: tag added in a batch.
  activity(JAKE, at(SEP, 24, 16, 30), {
    action: fieldChange,
    before: null,
    after: field("tag", RELEASE_TAG.id),
  }),
  comment(
    JAKE,
    at(SEP, 25, 9, 15),
    "branch-1",
    "Rebased on main; the release tag is for the 10/09 cut."
  ),
  // C17: priority, by an agent (Emily's API key).
  activity({ apiKeyOwner: EMILY }, at(OCT, 1, 11, 40), {
    action: fieldChange,
    before: field("priority", "HIGH"),
    after: field("priority", "URGENT"),
  }),
  // C20: moved between projects in a batch.
  activity(JAKE, at(OCT, 2, 14, 0), {
    action: fieldChange,
    before: field("projectId", ATLAS.id),
    after: bulk("projectId", ORION.id),
  }),
  // C29: tag removed singly.
  activity(EMILY, at(OCT, 6, 17, 25), {
    action: fieldChange,
    before: field("tag", FRONTEND_TAG.id),
    after: field("tag", null),
  }),
];

/**
 * Document "ISS-1240 Session export" (Issue), mostly machines (ISS-12330):
 * agent runs with each command and status, an agent's API-key edits, System
 * projections (evaluation, derivation) and an automatic unblock, between a
 * few rows by people. Shows the cog (System) and robot (agent) avatars on the
 * line beside people's photos and initials.
 */
export const SYSTEM_AND_AGENT_ROWS: readonly ActivityTimelineRow[] = [
  // C01: created.
  activity(RYAN, at(SEP, 30, 9, 0), {
    action: ArtifactActivityAction.Creation,
    before: null,
    after: { status: "DRAFT", title: "Session export" },
  }),
  // evaluation projection.
  evaluationRow(at(SEP, 30, 9, 31)),
  // derivation projection: a PRODUCES link.
  derivationRow(at(SEP, 30, 9, 32), "produced", PRD_751),
  // C02: status, by an agent (Ryan's API key).
  activity({ apiKeyOwner: RYAN }, at(SEP, 30, 9, 33), {
    action: status,
    before: "DRAFT",
    after: "BLOCKED",
  }),
  // C04: unblocked automatically.
  activity("system", at(OCT, 1, 8, 15), {
    action: status,
    before: "BLOCKED",
    after: "TODO",
  }),
  // C08: assignee set.
  activity(EMILY, at(OCT, 1, 9, 2), {
    action: assignment,
    before: field("assigneeId", null),
    after: field("assigneeId", JAKE.id),
  }),
  // C14: priority, by an agent (Jake's API key).
  activity({ apiKeyOwner: JAKE }, at(OCT, 1, 11, 48), {
    action: fieldChange,
    before: field("priority", "MEDIUM"),
    after: field("priority", "HIGH"),
  }),
  comment(
    JAKE,
    at(OCT, 1, 12, 5),
    "doc-3",
    "The first run timed out on the fixture upload. Retrying with the smaller set."
  ),
];

/** One person's continuous run: repeated rows are expected in V1. */
export const SINGLE_ACTOR_ROWS: readonly ActivityTimelineRow[] = [
  activity(EMILY, ago(5 * HOUR), {
    action: fieldChange,
    before: field("title", "Activity tab"),
    after: field("title", "Activity tab V1"),
  }),
  activity(EMILY, ago(5 * HOUR - 4 * MINUTE), {
    action: fieldChange,
    before: field("priority", "MEDIUM"),
    after: field("priority", "HIGH"),
  }),
  activity(EMILY, ago(4 * HOUR), {
    action: assignment,
    before: field("assigneeId", null),
    after: field("assigneeId", JAKE.id),
  }),
  activity(EMILY, ago(3 * HOUR), {
    action: fieldChange,
    before: null,
    after: field("tag", DESIGN_TAG.id),
  }),
  activity(EMILY, ago(2 * HOUR), {
    action: status,
    before: "DRAFT",
    after: "IN_REVIEW",
  }),
];
