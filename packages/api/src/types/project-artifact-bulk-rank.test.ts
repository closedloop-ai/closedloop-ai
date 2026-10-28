import { describe, expect, it } from "vitest";
import { NUL_CHARACTER, PostgresTextRejection } from "./postgres-text.ts";
import {
  BulkRankMutationSource,
  bulkRankArtifactsValidator,
} from "./project-artifact-bulk-rank.ts";

const ROOT_A = "22222222-2222-7222-8222-222222222222";
const ROOT_B = "33333333-3333-7333-8333-333333333333";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    orderedArtifactIds: [ROOT_A, ROOT_B],
    expectedRankEpoch: "a".repeat(32),
    source: BulkRankMutationSource.DependencyRank,
    idempotencyKey: "rank-run-1",
    ...overrides,
  };
}

describe("bulkRankArtifactsValidator idempotencyKey (ISS-10436)", () => {
  it("parses a valid body to an equal object", () => {
    const body = validBody();

    const parsed = bulkRankArtifactsValidator.safeParse(body);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(body);
  });

  it("rejects a key carrying a NUL with the canonical issue at the key's path", () => {
    const parsed = bulkRankArtifactsValidator.safeParse(
      validBody({ idempotencyKey: `rank${NUL_CHARACTER}run` })
    );

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["idempotencyKey"],
        message: PostgresTextRejection.ContainsNul,
      }),
    ]);
  });

  it("rejects a key carrying a lone surrogate with the canonical issue", () => {
    const parsed = bulkRankArtifactsValidator.safeParse(
      validBody({ idempotencyKey: "rank\uD800run" })
    );

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["idempotencyKey"],
        message: PostgresTextRejection.ContainsLoneSurrogate,
      }),
    ]);
  });

  it("keeps the length bounds: 255 characters pass, 256 do not", () => {
    expect(
      bulkRankArtifactsValidator.safeParse(
        validBody({ idempotencyKey: "k".repeat(255) })
      ).success
    ).toBe(true);
    expect(
      bulkRankArtifactsValidator.safeParse(
        validBody({ idempotencyKey: "k".repeat(256) })
      ).success
    ).toBe(false);
  });
});
