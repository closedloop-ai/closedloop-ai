import {
  type DocumentVersion,
  isValidVersionNumber,
} from "@repo/api/src/types/document-version";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { isUuid } from "@/lib/is-uuid";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { documentVersionService } from "../../../document-version-service";

/**
 * Fetch a single historical version of an artifact, WITH its content.
 *
 * `versionRef` is either the ordinal version number (`/versions/18`) or the
 * version row's own id (`/versions/01a0240a-...`). The list endpoint returns
 * both, so either identifier a caller already holds resolves here.
 */
export const GET = withAnyAuth<
  DocumentVersion,
  "/documents/[id]/versions/[versionRef]"
>(async ({ user }, _, params) => {
  try {
    const { id, versionRef } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    // Confirms the artifact exists AND belongs to the caller's org before any
    // version row is read, so this route cannot leak another org's content.
    const artifact = await documentService.findByIdSimple(
      resolvedId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    const lookup = resolveVersionLookup(versionRef, user.organizationId);
    if (lookup === null) {
      return badRequestResponse(
        "Version reference must be a positive version number or a version id"
      );
    }

    const version = await lookup(resolvedId);
    if (!version) {
      return notFoundResponse(`Artifact version ${versionRef}`);
    }

    return successResponse(version);
  } catch (error) {
    return errorResponse("Failed to fetch artifact version", error);
  }
});

const VERSION_NUMBER_PATTERN = /^\d+$/;

/**
 * Classifies the path segment, returning null when it is neither an in-range
 * positive ordinal nor a version id. A malformed segment must be rejected
 * BEFORE a query, and both columns punish a bad comparand the same way:
 * `DocumentVersion.id` is `@db.Uuid`, so Postgres raises P2023 on a non-UUID,
 * and `DocumentVersion.version` is a Prisma `Int`, which rejects an ordinal
 * past int4. Either would reach the handler's catch and be reported as a 500 —
 * a caller's typo dressed up as a server fault.
 */
function resolveVersionLookup(
  versionRef: string,
  organizationId: string
): ((documentId: string) => Promise<DocumentVersion | null>) | null {
  if (VERSION_NUMBER_PATTERN.test(versionRef)) {
    const versionNumber = Number(versionRef);
    if (!isValidVersionNumber(versionNumber)) {
      return null;
    }
    return (documentId) =>
      documentVersionService.getByVersion(documentId, versionNumber);
  }

  // A UUID is never all digits, so the two namespaces cannot collide.
  if (!isUuid(versionRef)) {
    return null;
  }

  return (documentId) =>
    documentVersionService.getByVersionId(
      documentId,
      organizationId,
      versionRef
    );
}
