import { withDb } from "@repo/database";
import { createTestOrganization, createTestUser } from "../utils/db-helpers";

/**
 * Fixtures shared by the zero-cost sessions (ISS-10833) and zero-cost branches
 * (ISS-12142) audit suites, which apply the same error-ended exclusion.
 */

// A stored-row value the desktop writes; a member of METERED_BILLING_MODES.
export const METERED_BILLING_MODE = "api";
export const RECORDED_INPUT_TOKENS = 1200;
const TURNS = 2;

export type Owner = { organizationId: string; userId: string };

export type SessionShape = {
  endsWithError: boolean | null;
  inputTokens?: number;
  estimatedCost?: number | null;
};

export type CountDelta = { label: string; shape: SessionShape; delta: number };

/** The error-flag cases both audits must still count. */
export const STILL_COUNTED_ERROR_FLAG_CASES: CountDelta[] = [
  { label: "has a NULL error flag", shape: { endsWithError: null }, delta: 1 },
  {
    label: "ended on an error but recorded tokens",
    shape: { endsWithError: true, inputTokens: RECORDED_INPUT_TOKENS },
    delta: 1,
  },
];

export async function seedOwner(): Promise<Owner> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  return { organizationId, userId: user.id };
}

/** Gives a seeded session turns, so it is substantive, and its input tokens. */
export async function recordSessionWork(
  artifactId: string,
  shape: SessionShape
): Promise<void> {
  await withDb((db) =>
    db.sessionDetail.update({
      where: { artifactId },
      data: { turns: TURNS, inputTokens: shape.inputTokens ?? 0 },
      select: { artifactId: true },
    })
  );
}
