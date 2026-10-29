import {
  type ArtifactLinkPage,
  type ArtifactLinkWithEndpoints,
  buildArtifactLinkContinuationHeaders,
  LinkQueryMode,
} from "@repo/api/src/types/artifact";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactIdentifier } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { windowForCursor } from "../resolved-page";
import { artifactLinksService } from "../service";
import { findResolvedArtifactLinksQueryValidator } from "../validators";

/**
 * GET /artifact-links/resolved — links for an artifact with both endpoints
 * hydrated.
 *
 * Returns a bare `ArtifactLinkWithEndpoints[]` by default. A caller that pages
 * passes `paginated=true` and gets an {@link ArtifactLinkPage} envelope instead
 * — the same items plus a `nextCursor` to pass back as `cursor` (ISS-10102). The
 * default shape is byte-identical to what every shipped consumer already parses,
 * so an already-installed Desktop build or an external REST client is unaffected
 * by the envelope's existence.
 *
 * What DID change for such a caller is the bound: the response is now the first
 * `ARTIFACT_LINK_PAGE_SIZE` links rather than the whole graph. That is the
 * operator ruling (2026-09-12) — this route serialized 446 MB at 42,060 links
 * and was killed at its 2,048 MB ceiling, so an unbounded response was never
 * something a consumer could keep relying on. A first page is a usable answer
 * where a memory kill was a 500.
 *
 * THAT BOUND IS NEVER SILENT. The bare-array arm states its continuation in
 * response headers ({@link ARTIFACT_LINK_CONTINUATION_HEADERS}), so a caller
 * that never opts in — including an external `sk_live_*` client, which
 * `withAnyAuth` admits and which is the one least likely to know about
 * `paginated` — can still tell a complete lineage from a capped one. The ruling
 * chose pagination because it bounds the response WITHOUT removing a
 * capability, and completeness removed silently is a capability removed.
 *
 * BOTH modes page, on the same two params. Tree mode is what ISS-10102 was filed
 * against, but a single-hop read of a hub artifact is the same unbounded shape
 * one level down, and a consumer that had to ask "which mode am I in" before it
 * knew whether to follow a cursor would be a second place for the two to drift.
 */
export const GET = withAnyAuth<
  ArtifactLinkWithEndpoints[] | ArtifactLinkPage,
  "/artifact-links/resolved"
>(async ({ user }, request) => {
  try {
    const { params, errorResponse: parseError } = parseQueryParams(
      request,
      findResolvedArtifactLinksQueryValidator
    );
    if (parseError) {
      return parseError;
    }

    const {
      artifactId,
      linkType,
      direction,
      mode,
      maxDepth,
      paginated,
      cursor,
      snapshotId,
    } = params;

    const resolvedArtifactId = await resolveArtifactIdentifier(
      artifactId,
      user.organizationId
    );
    if (!resolvedArtifactId) {
      return notFoundResponse("Artifact");
    }

    const window = windowForCursor(cursor, snapshotId);

    // Tree mode: traverse the graph via findLinkTree first (feature → plan →
    // PR → deployment) and hydrate endpoint objects for the page's link ids.
    // Direct mode keeps the single-hop behavior.
    const page =
      mode === LinkQueryMode.Tree
        ? await artifactLinksService.findResolvedLinkTreePage(
            user.organizationId,
            resolvedArtifactId,
            direction,
            maxDepth,
            window,
            linkType
          )
        : await artifactLinksService.findResolvedLinksPage(
            user.organizationId,
            resolvedArtifactId,
            direction,
            window,
            linkType
          );

    if (paginated) {
      return successResponse(page);
    }
    // The bare-array arm states its continuation in HEADERS (ISS-6941's shape).
    // `withAnyAuth` accepts `sk_live_*` keys, so an external client that never
    // learned to opt in still reaches this arm — and without these it could not
    // tell a complete lineage from one capped at ARTIFACT_LINK_PAGE_SIZE. The
    // body is unchanged, so nothing that parses it can notice.
    return successResponse<ArtifactLinkWithEndpoints[] | ArtifactLinkPage>(
      page.items,
      {
        headers: buildArtifactLinkContinuationHeaders(
          page.nextCursor,
          page.snapshotId
        ),
      }
    );
  } catch (error) {
    return errorResponse("Failed to fetch resolved artifact links", error);
  }
});
