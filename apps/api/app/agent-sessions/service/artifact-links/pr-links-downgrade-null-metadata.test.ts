/**
 * ISS-11280: `branchOnlyMetadata`'s `parseJsonObject(metadata) ?? {}` fallback.
 * The sibling `pr-links-convergence.test.ts` downgrade tests all pass a
 * real, parseable stored metadata object; this drives the same downgrade
 * path with a link whose stored `metadata` is `null` (a shape a corrupt or
 * legacy row can carry), proving the fallback — not a crash reading a
 * property off `null` — produces the downgrade.
 */

import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { persistSessionPrArtifactLinks } from "./pr-links";

const ORG = "org-1";
const SESSION_ARTIFACT_ID = "session-1";

/** The downgrade's own statement, picked out of the flow's other raw writes. */
function downgradeCalls(
  executeRaw: ReturnType<typeof vi.fn>
): [unknown, string[], string[], string][] {
  return executeRaw.mock.calls.filter((call) =>
    (call[0] as string[]).join("").includes("UPDATE artifact_links")
  ) as [unknown, string[], string[], string][];
}

function downgradeWrites(
  executeRaw: ReturnType<typeof vi.fn>
): { id: string; metadata: unknown; organizationId: string }[] {
  const calls = downgradeCalls(executeRaw);
  return calls.flatMap(([, ids, metadata, organizationId]) =>
    ids.map((id, index) => ({
      id,
      metadata: JSON.parse(metadata[index]),
      organizationId,
    }))
  );
}

describe("branchOnlyMetadata — unparseable stored metadata fallback", () => {
  it("downgrades a branchLinked row to Branch-only metadata even when its stored metadata is null", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifactLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([{ id: "link-1", metadata: null }]),
        update: vi.fn().mockResolvedValue({ id: "link-1" }),
      },
    } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [],
      new Map()
    );

    expect(downgradeWrites(executeRaw)).toEqual([
      {
        id: "link-1",
        organizationId: ORG,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          linkKinds: [SessionArtifactLinkKind.SessionBranch],
        },
      },
    ]);
  });
});
