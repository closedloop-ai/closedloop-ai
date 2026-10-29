import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
import {
  projectTranscriptIdentity,
  TRANSCRIPT_FILE_KEY_MAX_BYTES,
} from "./transcript-index-keys";
import { resolveTranscriptObjectKey } from "./transcript-plan";

/**
 * ISS-8125 (review, whitlockk) — the transcript identity is bounded by S3, not by
 * Postgres.
 *
 * `objectStorageKey` is DERIVED from the two projected strings and
 * `defaultS3Port` passes it straight through, so a key over S3's 1024-byte
 * limit is a request the API accepts and S3 then rejects: the row lands and the
 * bytes never do. Bounding each string at the shared `INDEX_KEY_MAX_BYTES`
 * built 1105 bytes for the worst shape, so ONE of them has to give — and it is
 * `fileKey`, because `externalSessionId` is the shared session identity three
 * cross-table joins depend on.
 *
 * Asserted against S3's own 1024, never against the constant under test, so a
 * regression in the budget fails here instead of moving with the bug.
 */
const S3_OBJECT_KEY_MAX_BYTES = 1024;

/** Deterministic, high-entropy, and past every budget involved. */
function overLimitValue(seed: string): string {
  let digest = seed;
  let out = "";
  while (out.length < 4096) {
    digest = createHash("sha256").update(digest).digest("hex");
    out += digest;
  }
  return out.slice(0, 4096);
}

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPUTE_TARGET = "22222222-2222-4222-8222-222222222222";

function keyForWorstShape(): string {
  const projected = projectTranscriptIdentity({
    computeTargetId: COMPUTE_TARGET,
    externalSessionId: overLimitValue("iss-8125-sid"),
    fileKey: `subagent:${overLimitValue("iss-8125-file")}`,
  });
  return resolveTranscriptObjectKey({
    organizationId: ORG,
    computeTargetId: projected.computeTargetId,
    externalSessionId: projected.externalSessionId,
    fileKey: projected.fileKey,
  });
}

describe("ISS-8125 — transcript identity fits the S3 object-key limit", () => {
  it("keeps the derived object key inside S3's 1024-byte limit for the worst key shape", () => {
    expect(Buffer.byteLength(keyForWorstShape(), "utf8")).toBeLessThanOrEqual(
      S3_OBJECT_KEY_MAX_BYTES
    );
  });

  it("stores externalSessionId under the SAME key SessionDetail holds", () => {
    // ISS-8125 (operator review) — the regression that a transcript-local budget
    // for `externalSessionId` introduced. It is ONE session identity carried by
    // two tables, and three call sites join them on it by plain equality: the
    // retention sweep and the phantom sweep reap transcripts by the expiring
    // session's stored value, and `backfillOrphanTranscriptsBatch` resolves a
    // transcript's session from the transcript's own. Two budgets make those two
    // columns hold different strings for one session, and the projection is
    // lossy in both directions, so neither key is derivable from the other: the
    // joins miss silently — an orphan that never links, and a deleted session
    // whose transcript rows and S3 archives are never reclaimed.
    const sessionId = overLimitValue("iss-8125-sid");
    const projected = projectTranscriptIdentity({
      computeTargetId: COMPUTE_TARGET,
      externalSessionId: sessionId,
      fileKey: "main",
    });
    // `projectIndexKey` at its default budget is exactly what the session ingest
    // writes into `SessionDetail.externalSessionId` (ISS-8069).
    expect(projected.externalSessionId).toBe(
      projectIndexKey(sessionId, INDEX_KEY_MAX_BYTES).value
    );
  });

  it("spends the S3 headroom on fileKey, which nothing joins on", () => {
    // The budget that IS transcript-local. `fileKey` absorbs what the shared
    // session budget leaves, so the derived object key still fits S3.
    expect(TRANSCRIPT_FILE_KEY_MAX_BYTES).toBeLessThan(INDEX_KEY_MAX_BYTES);
  });

  it("still projects both identity columns within their budgets", () => {
    const projected = projectTranscriptIdentity({
      computeTargetId: COMPUTE_TARGET,
      externalSessionId: overLimitValue("iss-8125-sid"),
      fileKey: `subagent:${overLimitValue("iss-8125-file")}`,
    });
    expect(projected.projectedCount).toBe(2);
    expect(
      Buffer.byteLength(projected.externalSessionId, "utf8")
    ).toBeLessThanOrEqual(INDEX_KEY_MAX_BYTES);
    expect(Buffer.byteLength(projected.fileKey, "utf8")).toBeLessThanOrEqual(
      TRANSCRIPT_FILE_KEY_MAX_BYTES
    );
    // The subagent namespace survives the bound: a projected file key that lost
    // its prefix would reshape the S3 key into the main-transcript namespace.
    expect(projected.fileKey.startsWith("subagent:")).toBe(true);
  });

  it("keeps distinct over-long identities on distinct keys", () => {
    const a = projectTranscriptIdentity({
      computeTargetId: COMPUTE_TARGET,
      externalSessionId: overLimitValue("seed-a"),
      fileKey: "main",
    });
    const b = projectTranscriptIdentity({
      computeTargetId: COMPUTE_TARGET,
      externalSessionId: overLimitValue("seed-b"),
      fileKey: "main",
    });
    expect(a.externalSessionId).not.toBe(b.externalSessionId);
  });
});
