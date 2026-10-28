import type { ArtifactLink } from "@repo/api/src/types/artifact";
import type { Result } from "@repo/api/src/types/result";
import type { CreateArtifactLinkFailure } from "@/app/artifact-links/service";

/**
 * Narrows a `createLink` result for suites whose subject is a later read, not
 * the create's own failure branches. Throwing on `!ok` keeps a regression that
 * turns a seeded link into a rejection loud instead of surfacing it several
 * assertions later as an empty query result.
 */
export function unwrapCreatedLink(
  result: Result<ArtifactLink, CreateArtifactLinkFailure>
): ArtifactLink {
  if (!result.ok) {
    throw new Error(
      `Expected createLink to succeed, got failure ${result.error}`
    );
  }
  return result.value;
}
