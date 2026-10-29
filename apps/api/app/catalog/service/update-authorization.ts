import { CatalogItemSource } from "@repo/api/src/types/distribution";
import type { StatusCode } from "@repo/api/src/types/result";
import type { Prisma } from "@repo/database";
import {
  OrgAdminDenialReason,
  orgAdminDenialStatus,
} from "@/lib/auth/org-admin-denial";
import { CatalogTargetKind } from "../validators";

/**
 * Who may update a `CatalogItem`, and what status a refusal wears.
 *
 * Split out of `service.ts` because the update path answers two different
 * questions with one verdict: whether the row is editable AT ALL (no org role
 * changes that), and whether THIS caller may edit it (a role does). Keeping
 * both halves and the status they map to in one module is what stops the
 * ISS-8661 distinction collapsing back into a single 403.
 */

export type UpdateCatalogInput = {
  id: string;
  organizationId: string;
  userId: string;
  canUpdateAny?: boolean;
  /**
   * Why the caller's admin verdict came back negative, when it did. Absent for
   * an admitted admin and for callers that never asked. `ProviderError` means
   * the role was never resolved, which is what lets an authorization-dependent
   * refusal below be reported as undecided rather than denied (ISS-8661).
   */
  adminDenialReason?: OrgAdminDenialReason;
  name?: string;
  description?: string;
  sortOrder?: number;
  enabled?: boolean;
  coaching?: boolean;
  coachingConfig?: Record<string, unknown>;
  /** New authored body; appended as a new CatalogItemVersion when present. */
  content?: string;
};

export type UpdateCatalogError = StatusCode;

export type UpdateCatalogAuthorizationRow = {
  source: string;
  archived: boolean;
  targetKind: string;
  organizationId: string | null;
  createdById: string | null;
};

/**
 * The refusals no org role can overturn: a read-only catalog source, an
 * archived row, or an authored-body edit on a target kind that carries no
 * content. An org admin is refused all three, so the caller's role is not an
 * input to this answer (ISS-8661).
 */
export function isImmutableCatalogItemUpdate(
  row: UpdateCatalogAuthorizationRow,
  input: UpdateCatalogInput
): boolean {
  return (
    row.source !== CatalogItemSource.OrgCustom ||
    row.archived ||
    (input.content !== undefined && !canUpdateContent(row.targetKind))
  );
}

/**
 * The authorization half, which the caller's org role CAN change: an admin may
 * update any org-owned custom item, a creator only their own and only fields
 * that are not admin-only.
 *
 * Call it only after {@link isImmutableCatalogItemUpdate} has cleared the
 * role-independent refusals, so that a `false` here always names a refusal an
 * admin would have survived.
 */
export function canUpdateCatalogItem(
  row: UpdateCatalogAuthorizationRow,
  input: UpdateCatalogInput
): boolean {
  if (input.canUpdateAny === true) {
    return true;
  }
  if (row.createdById !== input.userId) {
    return false;
  }
  return !hasAdminOnlyUpdateFields(input);
}

/**
 * The status an authorization-dependent refusal wears, given what the caller's
 * admin lookup actually returned. Reads the canonical gate mapping so this
 * route's 503 cannot drift from every other gate's.
 */
export function updateRefusalStatus(
  input: UpdateCatalogInput
): UpdateCatalogError {
  return orgAdminDenialStatus(
    input.adminDenialReason ?? OrgAdminDenialReason.NotAdmin
  );
}

export function catalogItemUpdateWhere(
  input: UpdateCatalogInput
): Prisma.CatalogItemWhereInput {
  const where: Prisma.CatalogItemWhereInput = {
    id: input.id,
    organizationId: input.organizationId,
    source: CatalogItemSource.OrgCustom,
    archived: false,
  };
  if (input.canUpdateAny !== true) {
    where.createdById = input.userId;
  }
  return where;
}

function hasAdminOnlyUpdateFields(input: UpdateCatalogInput): boolean {
  return (
    input.sortOrder !== undefined ||
    input.enabled !== undefined ||
    input.coaching !== undefined ||
    input.coachingConfig !== undefined
  );
}

function canUpdateContent(targetKind: string): boolean {
  switch (targetKind) {
    case CatalogTargetKind.Agent:
    case CatalogTargetKind.Command:
    case CatalogTargetKind.Hook:
    case CatalogTargetKind.Mcp:
    case CatalogTargetKind.Plugin:
    case CatalogTargetKind.Skill:
      return true;
    default:
      return false;
  }
}
