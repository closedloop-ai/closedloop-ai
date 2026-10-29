import { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  type DocumentDetail,
  statusOptionsForSubtype,
} from "@repo/api/src/types/document";
import {
  type DocumentStatusMutationCapability,
  DocumentStatusMutationOperation,
  type DocumentStatusMutationPermissions,
} from "@repo/api/src/types/document-status-mutation";
import { hasApiKeyScopes } from "@/lib/auth/api-key-scopes";
import type { AuthContext } from "@/lib/auth/with-auth";

/**
 * The scopes each status write demands, keyed exhaustively by operation so a
 * new one cannot ship without stating its requirement.
 *
 * Neither route imports this table, which is deliberate rather than duplication
 * nobody noticed: `undo-registry-routes.test.ts` reads `requiredScopes` off the
 * route's AST and understands only string literals, so an imported constant
 * there parses as zero scopes and the route reads as enforcing none. Drift is
 * caught instead by a route-scope test PER OPERATION, each pinning the same
 * hand-written `["write"]` this table states —
 * `document-status-single-route-scope.test.ts` on `PUT /documents/[id]`,
 * `document-status-bulk-route-scope.test.ts` on the bulk route — alongside
 * `document-status-mutation-capability.test.ts` on the table itself, so the
 * advertisement and the enforcement cannot move apart unnoticed.
 */
export const DOCUMENT_STATUS_MUTATION_REQUIRED_SCOPES: Record<
  DocumentStatusMutationOperation,
  readonly ApiKeyScope[]
> = {
  [DocumentStatusMutationOperation.Single]: [ApiKeyScope.Write],
  [DocumentStatusMutationOperation.Bulk]: [ApiKeyScope.Write],
};

export function withDocumentStatusMutation<
  T extends Omit<DocumentDetail, "statusMutation">,
>(
  document: T,
  permissions?: DocumentStatusMutationPermissions
): T & { statusMutation: DocumentStatusMutationCapability } {
  return {
    ...document,
    statusMutation: buildDocumentStatusMutation(document.type, permissions),
  };
}

export function buildDocumentStatusMutation(
  subtype: string | null | undefined,
  permissions?: DocumentStatusMutationPermissions
): DocumentStatusMutationCapability {
  return {
    allowedStatuses: [...statusOptionsForSubtype(subtype)],
    expectedStatusField: "expectedStatus" as const,
    expectedStatusByIdField: "expectedStatusById" as const,
    ...(permissions ? { permissions } : {}),
  };
}

/**
 * What the caller holding this credential may actually do, resolved through the
 * same fail-closed scope check the routes enforce with — never a second
 * resolver that could drift back to fail-open.
 */
export function documentStatusMutationPermissionsForAuth(
  context: AuthContext
): DocumentStatusMutationPermissions {
  return {
    [DocumentStatusMutationOperation.Single]: hasApiKeyScopes(context, [
      ...DOCUMENT_STATUS_MUTATION_REQUIRED_SCOPES[
        DocumentStatusMutationOperation.Single
      ],
    ]),
    [DocumentStatusMutationOperation.Bulk]: hasApiKeyScopes(context, [
      ...DOCUMENT_STATUS_MUTATION_REQUIRED_SCOPES[
        DocumentStatusMutationOperation.Bulk
      ],
    ]),
  };
}
