/**
 * The bulk artifact action set and the permission each member requires.
 *
 * Ruled on DOC-36 ("Bulk Artifact Actions Specification") by Cosimo Corrigan on
 * 2026-09-18: R10 names the eight actions, superseding R1's six; R16 assigns
 * their scopes. It lives beside `ApiKeyScope` because both halves have two
 * readers — `apps/app` renders a bar whose every control must state its rule,
 * and `apps/api` owns the routes that enforce it.
 *
 * THESE ARE THE BULK ACTIONS' SCOPES, not a mirror of the per-artifact routes.
 * `remove_tag` is where the two visibly differ: R16 gives the bulk action
 * `write`, while the single-artifact `DELETE /entity-tags` requires `delete`.
 * That is not drift: `POST /entity-tags/batch-remove/v2` enforces this mapping,
 * while the single-artifact DELETE keeps its separate delete-scope contract.
 */

import { ApiKeyScope } from "./api-key.ts";

/** DOC-36 R10. Every member sets a target state; none is per-row. */
export const ArtifactBulkAction = {
  ChangeFavorite: "change_favorite",
  ChangeStatus: "change_status",
  ChangePriority: "change_priority",
  AddTag: "add_tag",
  RemoveTag: "remove_tag",
  ChangeOwner: "change_owner",
  ChangeProject: "change_project",
  Delete: "delete",
} as const;
export type ArtifactBulkAction =
  (typeof ArtifactBulkAction)[keyof typeof ArtifactBulkAction];

/** Product row kinds; issue is the FEATURE document subtype in storage. */
export const ArtifactBulkKind = {
  Project: "project",
  Document: "document",
  Issue: "issue",
  Session: "session",
  Branch: "branch",
  Deployment: "deployment",
} as const;
export type ArtifactBulkKind =
  (typeof ArtifactBulkKind)[keyof typeof ArtifactBulkKind];

/**
 * Whether an action can apply to a kind at all. A route still checks the
 * caller's scope and each row's eligibility under the write transaction.
 */
export const ARTIFACT_BULK_ACTION_KINDS = {
  [ArtifactBulkAction.ChangeFavorite]: {
    [ArtifactBulkKind.Project]: true,
    [ArtifactBulkKind.Document]: true,
    [ArtifactBulkKind.Issue]: true,
    [ArtifactBulkKind.Session]: true,
    [ArtifactBulkKind.Branch]: true,
    [ArtifactBulkKind.Deployment]: true,
  },
  [ArtifactBulkAction.ChangeStatus]: {
    [ArtifactBulkKind.Project]: true,
    [ArtifactBulkKind.Document]: true,
    [ArtifactBulkKind.Issue]: true,
    // R-9107: Session lifecycle status is system-derived (active/inactive/error).
    [ArtifactBulkKind.Session]: false,
    // R-9107: Branch and Deployment lifecycle status is owned by GitHub.
    [ArtifactBulkKind.Branch]: false,
    [ArtifactBulkKind.Deployment]: false,
  },
  [ArtifactBulkAction.ChangePriority]: {
    // R-9107 A1 limits the Projects index adoption to Andy's five actions.
    [ArtifactBulkKind.Project]: false,
    [ArtifactBulkKind.Document]: true,
    [ArtifactBulkKind.Issue]: true,
    [ArtifactBulkKind.Session]: true,
    [ArtifactBulkKind.Branch]: true,
    // Deployment detail exposes no editable priority in its write contract.
    [ArtifactBulkKind.Deployment]: false,
  },
  [ArtifactBulkAction.AddTag]: {
    // Daveth's 2026-10-22 00:05Z ruling: Projects cannot add artifact tags.
    [ArtifactBulkKind.Project]: false,
    [ArtifactBulkKind.Document]: true,
    [ArtifactBulkKind.Issue]: true,
    [ArtifactBulkKind.Session]: true,
    [ArtifactBulkKind.Branch]: true,
    [ArtifactBulkKind.Deployment]: true,
  },
  [ArtifactBulkAction.RemoveTag]: {
    // Projects do not participate in the artifact tag mutation contract.
    [ArtifactBulkKind.Project]: false,
    [ArtifactBulkKind.Document]: true,
    [ArtifactBulkKind.Issue]: true,
    [ArtifactBulkKind.Session]: true,
    [ArtifactBulkKind.Branch]: true,
    [ArtifactBulkKind.Deployment]: true,
  },
  [ArtifactBulkAction.ChangeOwner]: {
    [ArtifactBulkKind.Project]: true,
    [ArtifactBulkKind.Document]: true,
    [ArtifactBulkKind.Issue]: true,
    [ArtifactBulkKind.Session]: true,
    // R-9107: Branch owner comes from the GitHub committer and is not user-editable.
    [ArtifactBulkKind.Branch]: false,
    // DeploymentDetail has no owner; placement-root-fields rejects assignee writes.
    [ArtifactBulkKind.Deployment]: false,
  },
  [ArtifactBulkAction.ChangeProject]: {
    // A Project is a placement root; it is not itself parented to another Project.
    [ArtifactBulkKind.Project]: false,
    [ArtifactBulkKind.Document]: true,
    [ArtifactBulkKind.Issue]: true,
    [ArtifactBulkKind.Session]: true,
    [ArtifactBulkKind.Branch]: true,
    [ArtifactBulkKind.Deployment]: true,
  },
  [ArtifactBulkAction.Delete]: {
    // R-9107 A1 limits the Projects index adoption to Andy's five actions.
    [ArtifactBulkKind.Project]: false,
    [ArtifactBulkKind.Document]: true,
    [ArtifactBulkKind.Issue]: true,
    // The document batch-delete route admits DOCUMENT rows only.
    [ArtifactBulkKind.Session]: false,
    [ArtifactBulkKind.Branch]: false,
    [ArtifactBulkKind.Deployment]: false,
  },
} as const satisfies Record<
  ArtifactBulkAction,
  Record<ArtifactBulkKind, boolean>
>;

/**
 * DOC-36 R16: `delete` requires the `delete` scope, the other seven `write`.
 *
 * An exhaustive `Record` rather than a list of the privileged ones, so a ninth
 * action fails `tsc` here instead of silently inheriting `withAnyAuth`'s
 * method-inferred default — R16's whole point is that an inferred default is
 * not a stated rule.
 */
export const ARTIFACT_BULK_ACTION_SCOPE = {
  [ArtifactBulkAction.ChangeFavorite]: ApiKeyScope.Write,
  [ArtifactBulkAction.ChangeStatus]: ApiKeyScope.Write,
  [ArtifactBulkAction.ChangePriority]: ApiKeyScope.Write,
  [ArtifactBulkAction.AddTag]: ApiKeyScope.Write,
  [ArtifactBulkAction.RemoveTag]: ApiKeyScope.Write,
  [ArtifactBulkAction.ChangeOwner]: ApiKeyScope.Write,
  [ArtifactBulkAction.ChangeProject]: ApiKeyScope.Write,
  [ArtifactBulkAction.Delete]: ApiKeyScope.Delete,
} as const satisfies Record<ArtifactBulkAction, ApiKeyScope>;
