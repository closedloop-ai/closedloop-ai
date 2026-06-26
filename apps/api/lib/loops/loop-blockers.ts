import { LinkType } from "@repo/api/src/types/artifact";
import { isTerminalDocumentStatus } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";

/**
 * Dependency-aware dispatch gating (SPEC §8.2 Candidate Selection: "do not
 * dispatch when any blocker is non-terminal").
 *
 * A loop's linked artifact is "blocked" when another artifact points at it via
 * a `BLOCKS` ArtifactLink and that blocking artifact has not reached a terminal
 * status. Loops whose upstream FEAT/PLAN/issue is still unresolved are deferred
 * (status BLOCKED) at dispatch and re-evaluated on reconciliation. A blocker in
 * any non-terminal status (or a non-document artifact whose status never
 * reaches a terminal lifecycle state) counts as blocking, so gating fails
 * closed — work waits rather than racing ahead of its upstream.
 */

export type LoopBlocker = {
  id: string;
  name: string;
  status: string;
};

/**
 * Return the non-terminal artifacts blocking the given artifact (the targets of
 * inbound `BLOCKS` links whose source has not reached a terminal status). An
 * empty array means the artifact is clear to dispatch.
 */
export async function findNonTerminalBlockers(
  organizationId: string,
  artifactId: string
): Promise<LoopBlocker[]> {
  const links = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId,
        targetId: artifactId,
        linkType: LinkType.Blocks,
      },
      select: {
        source: { select: { id: true, name: true, status: true } },
      },
    })
  );

  return links
    .map((link) => link.source)
    .filter(
      (source): source is LoopBlocker =>
        source !== null && !isTerminalDocumentStatus(source.status)
    );
}
