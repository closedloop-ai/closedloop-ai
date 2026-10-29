/**
 * @file rehearsal-verify-checks-iss11285.test.ts
 * @description ISS-11285 — the id sample in a violation message is capped at
 * ten ids and marks the truncation with a trailing ellipsis.
 */
import { describe, expect, it } from "vitest";
import {
  collectRehearsalViolations,
  type RehearsalSessionState,
} from "../scripts/rehearsal-verify-checks.js";

const CURRENT_REVISION = 7;
const PENDING_SENTINEL = -1;
const FIXTURE_ID = "fx1";
const PENDING_PREFIX =
  /^11 session\(s\) left at DATA_REVISION_IMPORT_PENDING: /;

function session(id: string, dataRevision: number): RehearsalSessionState {
  return {
    id,
    dataRevision,
    projections: { sessions: 3, branches: 2, owner: 2, aggregate: 1 },
    ownerIdentity: { userId: "owner-user", organizationId: "owner-org" },
  };
}

function pendingViolation(count: number): string | undefined {
  const pending = Array.from({ length: count }, (_, i) =>
    session(`p${i + 1}`, PENDING_SENTINEL)
  );
  const fixturePre = {
    ...session(FIXTURE_ID, 1),
    projections: { sessions: 0, branches: 2, owner: 2, aggregate: 0 },
  };
  const violations = collectRehearsalViolations({
    manifest: {
      rehearsalManifestVersion: 4,
      sessions: [...pending.map((s) => session(s.id, 6)), fixturePre],
      missingSourceFixtureIds: [FIXTURE_ID],
    },
    postSessions: [
      ...pending,
      {
        ...session(FIXTURE_ID, CURRENT_REVISION),
        projections: { sessions: 4, branches: 2, owner: 2, aggregate: 1 },
      },
    ],
    outcome: {
      errors: 0,
      parseErrors: 0,
      missingSource: 1,
      unmatchedSource: 0,
    },
    currentRevision: CURRENT_REVISION,
    importPendingSentinel: PENDING_SENTINEL,
  });
  return violations.find((v) => v.includes("DATA_REVISION_IMPORT_PENDING"));
}

describe("violation id sample", () => {
  it("lists the first ten ids and appends an ellipsis past ten", () => {
    const message = pendingViolation(11);
    expect(message).toMatch(PENDING_PREFIX);
    expect(
      message?.endsWith("p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, …")
    ).toBe(true);
    expect(message).not.toContain("p11");
  });

  it("lists exactly ten ids with no ellipsis at the cap", () => {
    const message = pendingViolation(10);
    expect(message?.endsWith("p8, p9, p10")).toBe(true);
    expect(message).not.toContain("…");
  });
});
