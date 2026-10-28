import { type Prisma, type TransactionClient, withDb } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  seedBranchOwners,
  seedBranchOwnersForLogin,
} from "./branch-owner-seed";

// ISS-12463 C6: without these the seed went quadratic under stale per-org row estimates (8-30 s per statement at ~500 branches, past the 5 s transaction timeout), which CI's fresh statistics never show.
describe("branch owner seed plan fences (ISS-12463)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the per-ingest UPDATE keeps every fence and reads owners from a materialized map", async () => {
    const capture = capturingTransaction();

    await seedBranchOwners(capture.tx, ORGANIZATION_ID, [BRANCH_ID]);

    expect(capture.statements).toHaveLength(1);
    const [statement] = capture.statements;
    expect(ownerLateralFences(statement)).toEqual(ALL_OWNER_LATERAL_FENCES);
    expect(statement).toContain("seed AS MATERIALIZED (");
    expect(statement).toContain(
      "SET assignee_id = ((SELECT owners FROM seed) ->> t.id::text)::uuid"
    );
  });

  it("the connect-time page keeps every fence and filters through an InitPlan", async () => {
    const capture = capturingTransaction();
    vi.spyOn(withDb, "tx").mockImplementation(async (callback) =>
      callback(capture.tx)
    );

    await seedBranchOwnersForLogin(ORGANIZATION_ID, "octocat");

    expect(capture.statements).toHaveLength(1);
    const [statement] = capture.statements;
    expect(ownerLateralFences(statement)).toEqual(ALL_OWNER_LATERAL_FENCES);
    expect(statement).toContain("WHERE seed.user_id = ANY(ARRAY(");
  });
});

/**
 * The `OFFSET 0` fences of `branchOwnerSeedOwnerLateralSql` (the lateral and
 * its users lookup) and of every pushing-session lookup the observed-push rung
 * makes (`branchKeyedSessionEvidenceLinkJoinSql`).
 */
function ownerLateralFences(statement: string) {
  const sessionLookups = occurrences(statement, SESSION_LOOKUP);
  return {
    lateralFenced: statement.includes("OFFSET 0 ) branch_owner"),
    usersLookupFenced: statement.includes(
      "OFFSET 0 ) u WHERE b.artifact_id = a.id"
    ),
    sessionLookupsPresent: sessionLookups > 0,
    unfencedSessionLookups:
      sessionLookups -
      occurrences(statement, FENCED_SESSION_LOOKUP) +
      occurrences(statement, UNFENCED_SESSION_JOIN),
  };
}

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

/** A transaction whose raw statements are recorded, whitespace-collapsed, and answer nothing. */
function capturingTransaction(): {
  tx: TransactionClient;
  statements: string[];
} {
  const statements: string[] = [];
  const record = (query: Prisma.Sql) => {
    statements.push(query.sql.replaceAll(WHITESPACE, " ").trim());
    return Promise.resolve([]);
  };
  return {
    tx: {
      $executeRaw: record,
      $queryRaw: record,
    } as unknown as TransactionClient,
    statements,
  };
}

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const BRANCH_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_LOOKUP = "FROM artifacts linked WHERE linked.id = al.source_id";
const FENCED_SESSION_LOOKUP = `${SESSION_LOOKUP} OFFSET 0 ) session_artifact`;
const UNFENCED_SESSION_JOIN = "JOIN artifacts session_artifact";
const ALL_OWNER_LATERAL_FENCES = {
  lateralFenced: true,
  usersLookupFenced: true,
  sessionLookupsPresent: true,
  unfencedSessionLookups: 0,
};
const WHITESPACE = /\s+/g;
