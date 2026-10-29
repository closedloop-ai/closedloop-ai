import { LinkType } from "@repo/api/src/types/artifact";

/**
 * `artifact_links` row fixtures for the project-tree suites.
 *
 * `createdAt` and `id` are load-bearing rather than incidental: canonical-parent
 * resolution orders links by that pair (ISS-5732), so a fixture that omits them
 * exercises a different code path than production and cannot detect an
 * arrival-order dependency.
 */
export type ProducesLinkFixture = {
  createdAt: Date;
  id: string;
  linkType: typeof LinkType.Produces;
  sortOrder: number | null;
  metadata: null;
  sourceId: string;
  targetId: string;
};

/** Base instant every project-tree fixture is offset from. */
export const FIXTURE_INSTANT = new Date("2026-08-05T12:00:00.000Z");

/** One PRODUCES link, `createdAtOffsetMs` after {@link FIXTURE_INSTANT}. */
export function makeProducesLink(
  id: string,
  sourceId: string,
  targetId: string,
  createdAtOffsetMs: number
): ProducesLinkFixture {
  return {
    createdAt: new Date(FIXTURE_INSTANT.getTime() + createdAtOffsetMs),
    id,
    linkType: LinkType.Produces,
    sortOrder: createdAtOffsetMs,
    metadata: null,
    sourceId,
    targetId,
  };
}

/**
 * Sequenced PRODUCES links for suites that only care that the ordering keys are
 * present and distinct, not what they are.
 */
export function makeSequencedProducesLinkFactory(): (
  sourceId: string,
  targetId: string
) => ProducesLinkFixture {
  let sequence = 0;
  return (sourceId, targetId) => {
    sequence += 1;
    return makeProducesLink(
      `link-${String(sequence).padStart(4, "0")}`,
      sourceId,
      targetId,
      sequence * 1000
    );
  };
}
