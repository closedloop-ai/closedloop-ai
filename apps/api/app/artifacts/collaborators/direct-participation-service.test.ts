import { ArtifactType } from "@repo/api/src/types/artifact";
import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { directParticipationService } from "./direct-participation-service";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const KNOWN_BRANCH_ID = "55555555-5555-4555-8555-555555555551";
const SCANNED_BRANCH_ID = "55555555-5555-4555-8555-555555555552";
const THREAD_ID = "66666666-6666-4666-8666-666666666661";
const AUTHOR_ID = "77777777-7777-4777-8777-777777777771";
const COMMENT_SCAN_SQL = "FROM comment_threads";

async function readSql(
  artifactIds: readonly string[],
  knownComments?: ReadonlyMap<
    string,
    readonly { threadId: string; authorId: string }[]
  >
): Promise<Prisma.Sql> {
  const queryRaw = vi.fn().mockResolvedValue([]);
  await directParticipationService.read(
    { $queryRaw: queryRaw } as never,
    ORGANIZATION_ID,
    ArtifactType.Branch,
    artifactIds,
    knownComments
  );
  return queryRaw.mock.calls[0]?.[0];
}

describe("directParticipationService known comments", () => {
  it("scans comments when the caller supplies none", async () => {
    const query = await readSql([KNOWN_BRANCH_ID]);
    expect(query.sql).toContain(COMMENT_SCAN_SQL);
  });

  it("does not scan comments when every artifact's comments are supplied", async () => {
    const query = await readSql(
      [KNOWN_BRANCH_ID],
      new Map([
        [KNOWN_BRANCH_ID, [{ threadId: THREAD_ID, authorId: AUTHOR_ID }]],
      ])
    );
    expect(query.sql).not.toContain(COMMENT_SCAN_SQL);
    expect(query.values).toEqual(
      expect.arrayContaining([[KNOWN_BRANCH_ID], [THREAD_ID], [AUTHOR_ID]])
    );
  });

  it("scans only the artifacts whose comments were not supplied", async () => {
    const query = await readSql(
      [KNOWN_BRANCH_ID, SCANNED_BRANCH_ID],
      new Map([[KNOWN_BRANCH_ID, []]])
    );
    expect(query.sql).toContain(COMMENT_SCAN_SQL);
    expect(query.sql).toContain("NOT (t.artifact_id = ANY(");
    expect(query.values).toContainEqual([KNOWN_BRANCH_ID]);
  });
});
