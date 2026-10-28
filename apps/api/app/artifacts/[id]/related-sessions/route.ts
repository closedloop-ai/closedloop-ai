import {
  RELATED_SESSIONS_DISPLAY_CAP,
  type RelatedSessionsResult,
  supportsRelatedSessionsField,
} from "@repo/api/src/types/related-session";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactIdentifier, uuidOrSlug } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { artifactService } from "../../artifact-service";

/**
 * GET /artifacts/[id]/related-sessions — the read-only Related Sessions field
 * (ISS-7235).
 *
 * Deliberately mounted on `/artifacts` rather than `/documents`: the field is
 * inherited by every non-Session artifact TYPE, and a `/documents` route would
 * have made that inheritance an accident of which service happened to resolve
 * the id. `supportsRelatedSessionsField` is the one place the exception lives.
 *
 * Org-scoped twice on purpose. The artifact is resolved inside the caller's org
 * before any provenance is read, and every underlying query in
 * `provenance-eligibility.ts` filters the link row, its source session, and its
 * target on that same org. A provenance answer names which sessions touched
 * which artifact, so a single unscoped endpoint here is a cross-tenant
 * disclosure, not a wrong count.
 *
 * Eligibility is NOT computed here. It is `listEligibleSessionContributions`,
 * the one exported provenance query — this route chooses a subject, never a
 * rule.
 */
export const GET = withAnyAuth<
  RelatedSessionsResult,
  "/artifacts/[id]/related-sessions"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    // The path segment is untrusted. `Artifact.id` is `@db.Uuid`, so handing a
    // malformed segment to a lookup keyed on it is a driver-level P2023 that the
    // catch below would have reported as a 500 — a caller's typo dressed up as a
    // server fault, and one that pages whoever owns the route's error rate.
    // Validating here answers it as the caller error it is, and does so before
    // any query runs.
    const identifier = uuidOrSlug().safeParse(id);
    if (!identifier.success) {
      return badRequestResponse(
        "Artifact id must be a UUID or a slug (e.g. PRD-42)."
      );
    }
    // The same org-scoped resolver the sibling `/artifact-links` routes use, so
    // this path gains slug addressing without a second bespoke id rule. A
    // non-null result is guaranteed to name a row in the caller's org.
    const artifactId = await resolveArtifactIdentifier(
      identifier.data,
      user.organizationId
    );
    if (!artifactId) {
      return notFoundResponse("Artifact");
    }
    const artifact = await artifactService.findById(
      artifactId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }
    if (!supportsRelatedSessionsField(artifact.type)) {
      return badRequestResponse(
        "Related Sessions is not available on Session artifacts."
      );
    }

    const result = await agentSessionsService.listRelatedSessions(
      user.organizationId,
      artifact.id,
      RELATED_SESSIONS_DISPLAY_CAP
    );
    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch related sessions", error);
  }
});
