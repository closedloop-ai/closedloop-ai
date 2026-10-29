/**
 * ISS-9485 — which fields on a Sessions or Branches row a single-row PATCH
 * writes, and the error contract for a body that names one it cannot.
 *
 * Tamsin, 2026-09-23: any user-owned field on the row is PATCH-able; a
 * collector-measured or derived value is not user-owned and is REFUSED with
 * `unsupported_field`, never silently dropped. Tags and custom fields keep
 * their own routes (Marisol, PRD-722, 2026-09-21).
 *
 * The two row maps are keyed by every field of the list-row wire type (less
 * one gated Sessions compat alias, see {@link AgentSessionRowCompatAlias}), so
 * a field added to `AgentSessionListItem` or `BranchRow` fails `tsc` here until
 * someone decides whether a user may write it.
 */

import type { AgentSessionListItem } from "./agent-session.ts";
import type { BranchRow } from "./branch.ts";
import type { JsonObject } from "./common.ts";
import { DocumentStatusMutationErrorCode } from "./document-status-mutation.ts";
import { Status } from "./result.ts";

/** The `PATCH /agent-sessions/{id}` body keys that write a row field. */
export const AgentSessionPatchField = {
  Name: "name",
  Status: "status",
  Priority: "priority",
  ProjectId: "projectId",
  OwnerUserId: "ownerUserId",
} as const;
export type AgentSessionPatchField =
  (typeof AgentSessionPatchField)[keyof typeof AgentSessionPatchField];

/** The `PATCH /branches/{id}` body keys that write a row field. */
export const BranchPatchField = {
  Priority: "priority",
} as const;
export type BranchPatchField =
  (typeof BranchPatchField)[keyof typeof BranchPatchField];

/** A row field that the single-row PATCH does not write. */
export const ArtifactRowFieldEdit = {
  /** User-owned, written through its own route (tags, custom fields). */
  OwnRoute: "own_route",
  /** Collector-measured or derived. */
  NotUserOwned: "not_user_owned",
  /** User-ownable, but no grid for this type shows it, so no edit is offered. */
  NotEditable: "not_editable",
} as const;
export type ArtifactRowFieldEdit =
  (typeof ArtifactRowFieldEdit)[keyof typeof ArtifactRowFieldEdit];

const { OwnRoute, NotUserOwned, NotEditable } = ArtifactRowFieldEdit;

/**
 * The deprecated per-dollar alias the Sessions row still carries for version
 * skew (ISS-4667). Its name is gated repo-wide (`no-kloc-per-dollar-metric`,
 * shrink-only allowlist), so it is excluded here by shape rather than named. A
 * body that sends it is stripped like any key that is not a row field.
 */
type AgentSessionRowCompatAlias = Extract<
  keyof AgentSessionListItem,
  `klocPer${string}`
>;

export const AGENT_SESSION_ROW_FIELD_EDIT = {
  id: NotUserOwned,
  slug: NotUserOwned,
  externalSessionId: NotUserOwned,
  name: AgentSessionPatchField.Name,
  rawStatus: NotUserOwned,
  status: AgentSessionPatchField.Status,
  priority: AgentSessionPatchField.Priority,
  // ISS-12197: the Artifact row's Details-tab fields. Due date is user-ownable,
  // but outside the editable set the operator ruled on 2026-10-09 (priority,
  // project, tags, custom fields), so no surface offers the write. The Owner is
  // the assignee (ISS-12251 D-1), written by `ownerUserId`.
  assignee: AgentSessionPatchField.OwnerUserId,
  createdAt: NotUserOwned,
  createdBy: NotUserOwned,
  dueDate: NotEditable,
  origin: NotUserOwned,
  harness: NotUserOwned,
  cwd: NotUserOwned,
  repositoryFullName: NotUserOwned,
  repo: NotUserOwned,
  worktreePath: NotUserOwned,
  model: NotUserOwned,
  primaryModel: NotUserOwned,
  models: NotUserOwned,
  branch: NotUserOwned,
  branchArtifactId: NotUserOwned,
  prs: NotUserOwned,
  prsMerged: NotUserOwned,
  linkedArtifacts: NotUserOwned,
  linkedArtifactsTotal: NotUserOwned,
  commentCount: NotUserOwned,
  customFields: OwnRoute,
  tags: OwnRoute,
  tagAvailability: NotUserOwned,
  tagPermissions: NotUserOwned,
  cost: NotUserOwned,
  wallClock: NotUserOwned,
  activeAgent: NotUserOwned,
  waitingUser: NotUserOwned,
  linesAdded: NotUserOwned,
  linesRemoved: NotUserOwned,
  filesChanged: NotUserOwned,
  gitDiffStats: NotUserOwned,
  branchDiffStats: NotUserOwned,
  kloc: NotUserOwned,
  locPerDollar: NotUserOwned,
  mergedAuthoredPrLinesChanged: NotUserOwned,
  authoredPrLinesChanged: NotUserOwned,
  turns: NotUserOwned,
  toolCallsTotal: NotUserOwned,
  steeringEpisodes: NotUserOwned,
  autonomy: NotUserOwned,
  tokensIn: NotUserOwned,
  tokensOut: NotUserOwned,
  cache: NotUserOwned,
  cacheWrite: NotUserOwned,
  userColor: NotUserOwned,
  activityBuckets: NotUserOwned,
  span: NotUserOwned,
  markers: NotUserOwned,
  throttles: NotUserOwned,
  phases: NotUserOwned,
  phaseIterations: NotUserOwned,
  phaseLoopbacks: NotUserOwned,
  startedAt: NotUserOwned,
  updatedAt: NotUserOwned,
  recordUpdatedAt: NotUserOwned,
  lastActivityAt: NotUserOwned,
  endedAt: NotUserOwned,
  awaitingInputSince: NotUserOwned,
  lastSyncedAt: NotUserOwned,
  transcriptDisposition: NotUserOwned,
  transcriptDispositionReason: NotUserOwned,
  cloudSyncState: NotUserOwned,
  inputTokens: NotUserOwned,
  outputTokens: NotUserOwned,
  cacheReadTokens: NotUserOwned,
  cacheWriteTokens: NotUserOwned,
  estimatedCost: NotUserOwned,
  billingMode: NotUserOwned,
  agentCount: NotUserOwned,
  toolUseCount: NotUserOwned,
  componentInvocationCount: NotUserOwned,
  errorCount: NotUserOwned,
  baseBranch: NotUserOwned,
  sourceArtifactId: NotUserOwned,
  sourceArtifact: NotUserOwned,
  sourceLoopId: NotUserOwned,
  // ISS-12251 D-2: the recording user. `ownerUserId` writes `assignee` now.
  user: NotUserOwned,
  computeTarget: NotUserOwned,
  // ISS-10995: the Session Details row files a session into a project, through
  // the type-agnostic `POST /artifact-links/batch-move` the Branch row also
  // uses (operator ruling 2026-10-12). This stays the PATCH key because the
  // route has owned that write since ISS-8648 and still does — the value here
  // is what a body sending the READ name `project` is pointed at, so losing it
  // would drop that refusal's `useFields` hint.
  project: AgentSessionPatchField.ProjectId,
} as const satisfies Record<
  Exclude<keyof AgentSessionListItem, AgentSessionRowCompatAlias>,
  AgentSessionPatchField | ArtifactRowFieldEdit
>;

/** A Sessions row field the registry classifies. */
export type AgentSessionRowField = keyof typeof AGENT_SESSION_ROW_FIELD_EDIT;

export const BRANCH_ROW_FIELD_EDIT = {
  id: NotUserOwned,
  artifactId: NotUserOwned,
  // ISS-10995: the Branch Details tab files a branch into a project, and the
  // canonical writer is `POST /artifact-links/batch-move` — type-agnostic by
  // design — so the branch PATCH deliberately gains no `projectId` arm that
  // would be a second writer for one field.
  projectId: OwnRoute,
  // ISS-12453: the project's display name, derived from `projectId` — never
  // independently writable.
  projectName: NotUserOwned,
  tags: OwnRoute,
  tagAvailability: NotUserOwned,
  tagPermissions: NotUserOwned,
  branchName: NotUserOwned,
  baseBranch: NotUserOwned,
  repoFullName: NotUserOwned,
  owner: NotUserOwned,
  ownerIdentity: NotUserOwned,
  collaborators: NotUserOwned,
  status: NotUserOwned,
  priority: BranchPatchField.Priority,
  prNumber: NotUserOwned,
  prTitle: NotUserOwned,
  prState: NotUserOwned,
  prUrl: NotUserOwned,
  mergedAt: NotUserOwned,
  multiPrWarning: NotUserOwned,
  checksStatus: NotUserOwned,
  checksPassed: NotUserOwned,
  checksTotal: NotUserOwned,
  reviewDecision: NotUserOwned,
  ahead: NotUserOwned,
  behind: NotUserOwned,
  additions: NotUserOwned,
  deletions: NotUserOwned,
  filesChanged: NotUserOwned,
  analyticsAdditions: NotUserOwned,
  analyticsDeletions: NotUserOwned,
  lastActivityAt: NotUserOwned,
  canonicalLastActiveAt: NotUserOwned,
  canonicalActivityEvidence: NotUserOwned,
  sessionIds: NotUserOwned,
  dataState: NotUserOwned,
  canonicalProjection: NotUserOwned,
  estimatedCostUsd: NotUserOwned,
  attributedCostUsd: NotUserOwned,
  // ISS-12663: written through `/branches/[id]/custom-field-values`, as the
  // Session row's `customFields` is through its own route.
  customFields: OwnRoute,
} as const satisfies Record<
  keyof BranchRow,
  BranchPatchField | ArtifactRowFieldEdit
>;

export const ArtifactRowFieldMutationErrorCode = {
  /** The canonical literal, imported so a client branches once across routes. */
  ArtifactsNotFound: DocumentStatusMutationErrorCode.ArtifactsNotFound,
  /** The body names a row field this type's PATCH does not write. */
  UnsupportedField: "unsupported_field",
  /** The caller may write the type, but not this field on this row. */
  FieldForbidden: "field_forbidden",
} as const;
export type ArtifactRowFieldMutationErrorCode =
  (typeof ArtifactRowFieldMutationErrorCode)[keyof typeof ArtifactRowFieldMutationErrorCode];

export type ArtifactRowFieldMutationErrorDetails = JsonObject & {
  unsupportedFields?: string[];
  /** The body keys this type's PATCH does write. */
  writableFields?: string[];
  /**
   * For a refused wire key that names a writable field by its READ name
   * (`project`, `assignee`), the body key that writes it (`projectId`,
   * `ownerUserId`).
   */
  useFields?: Record<string, string>;
  forbiddenFields?: string[];
};

/** Only the 400 refusal is a value; the Sessions 403/404 are rendered in place. */
export type ArtifactRowFieldMutationError = {
  status: typeof Status.BadRequest;
  code: ArtifactRowFieldMutationErrorCode;
  message: string;
  details?: ArtifactRowFieldMutationErrorDetails;
};

/**
 * The one `unsupported_field` refusal, built here so both PATCH routes send
 * the same shape and a client parsing one parses the other. The caller passes
 * the message: it is the validator's own unknown-key text, not new copy.
 */
export function unsupportedRowFieldRefusal(
  message: string,
  details: ArtifactRowFieldMutationErrorDetails
): ArtifactRowFieldMutationError {
  return {
    status: Status.BadRequest,
    code: ArtifactRowFieldMutationErrorCode.UnsupportedField,
    message,
    details,
  };
}
