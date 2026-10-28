import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
// Branches -> github: the github slice owns the canonical pull request
// lifecycle labels.
import { pullRequestLifecycleLabel } from "@repo/app/github/lib/pull-request-lifecycle";
import type { LinkedArtifactTableGroup } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-linked-artifacts-table";
import { linkedArtifactGroups } from "@repo/app/shared/components/generic-artifact-surface/preview/components/linked-artifact-groups";

export type BranchLinkedArtifactHosts = {
  detail: BranchPageDetail;
  /** The page's slug route builder, as "What was delivered" uses it. */
  getArtifactHref?: (slug: string) => string | null;
  getSessionHref?: (sessionArtifactId: string) => string;
};

/**
 * The branch's resolved links as grouped rows (PLN-2175 M3): its documents and
 * every linked session (Kerensa Whitlock 2026-10-09, reversing ISS-10792). The
 * branch's own pull request is the page's field, never a row. Only stored links
 * draw: a document the branch name merely mentions stays out of this table
 * (Kerensa Whitlock 2026-10-09, after #8683).
 */
export function branchLinkedArtifactGroups(
  { getArtifactHref, getSessionHref }: BranchLinkedArtifactHosts,
  links: readonly ArtifactLinkWithEndpoints[],
  pageArtifactId: string
): LinkedArtifactTableGroup[] {
  return linkedArtifactGroups({
    hrefFor: (endpoint) =>
      endpointHref(endpoint, getArtifactHref, getSessionHref),
    links,
    pageArtifactId,
    pullRequestStatus: pullRequestLifecycleLabel,
  });
}

function endpointHref(
  endpoint: ArtifactLinkEndpoint,
  getArtifactHref: BranchLinkedArtifactHosts["getArtifactHref"],
  getSessionHref: BranchLinkedArtifactHosts["getSessionHref"]
): string | null {
  switch (endpoint.type) {
    case ArtifactType.Document:
      return endpoint.slug ? (getArtifactHref?.(endpoint.slug) ?? null) : null;
    case ArtifactType.Session:
      return getSessionHref ? getSessionHref(endpoint.id) : null;
    default:
      return null;
  }
}
