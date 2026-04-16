/**
 * Unit tests for judge-ratings service lookup behavior.
 *
 * SS8.8 requirements:
 * 1. submitJudgeRating finds judge score via evaluation.entityId + evaluation.organizationId
 * 2. Returns null for judge score in a different org's evaluation (cross-org null)
 * 3. getUserJudgeRatings where clause uses evaluation.entityId + evaluation.entityType
 */
import { EntityType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  EntityType: { DOCUMENT: "DOCUMENT", FEATURE: "FEATURE" },
}));

import {
  getUserJudgeRatings,
  submitJudgeRating,
} from "@/app/documents/[id]/judge-ratings/service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_ID = "org-test";
const OTHER_ORG_ID = "org-other";
const USER_ID = "user-test";
const ARTIFACT_ID = "artifact-test";
const JUDGE_SCORE_ID = "a0000000-0000-7000-8000-000000000001";

// ---------------------------------------------------------------------------
// Scenario 1: submitJudgeRating where clause uses entityId + organizationId
// ---------------------------------------------------------------------------

describe("submitJudgeRating — where clause shape (SS8.8.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMockWithDb().tx = vi.fn();
  });

  it("finds judge score via evaluation.entityId and evaluation.organizationId", async () => {
    const db = {
      judgeScore: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    mockWithDbTx(db);

    await submitJudgeRating(ORG_ID, USER_ID, ARTIFACT_ID, JUDGE_SCORE_ID, 0.5);

    expect(db.judgeScore.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: JUDGE_SCORE_ID,
          evaluation: expect.objectContaining({
            entityId: ARTIFACT_ID,
            organizationId: ORG_ID,
          }),
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: returns null for cross-org evaluation
// ---------------------------------------------------------------------------

describe("submitJudgeRating — cross-org isolation (SS8.8.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMockWithDb().tx = vi.fn();
  });

  it("returns null when judge score belongs to a different org's evaluation", async () => {
    // Simulates the DB returning null because the org filter excludes the row
    const db = {
      judgeScore: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      OTHER_ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0.5
    );

    expect(result).toBeNull();

    // The where clause must include the caller's org so cross-org rows are excluded
    expect(db.judgeScore.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          evaluation: expect.objectContaining({
            organizationId: OTHER_ORG_ID,
          }),
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: getUserJudgeRatings where clause uses entityId + entityType
// ---------------------------------------------------------------------------

describe("getUserJudgeRatings — where clause shape (SS8.8.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes query by evaluation.entityId and evaluation.entityType", async () => {
    const db = {
      judgeHumanScore: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDbCall(db);

    await getUserJudgeRatings(ORG_ID, USER_ID, ARTIFACT_ID);

    expect(db.judgeHumanScore.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          userId: USER_ID,
          evaluation: expect.objectContaining({
            entityId: ARTIFACT_ID,
            entityType: EntityType.DOCUMENT,
          }),
        }),
      })
    );
  });
});
