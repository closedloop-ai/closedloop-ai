import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  MAX_SYNCED_COMPONENT_USAGE,
  type SyncedAgentSession,
  type SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { POSTGRES_MAX_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import { persistSessionComponentUsage } from "./component-usage";
import type { AgentSessionUpsertTx } from "./records";

/**
 * ISS-8185 wiring coverage for `persistSessionComponentUsage`: every statement
 * it emits — the FK lookup, the branch-bucket prune, and the usage INSERT — is
 * bounded, so none of them can present more bind parameters than the database
 * accepts. The lookup and the prune are bounded by SHAPE (`unnest` over array
 * binds), and the INSERT is bounded by CHUNKING. The prune specifically cannot
 * be bounded by chunking because slicing an intersective `notIn` changes what
 * it deletes.
 *
 * SIZED AT THE CAP THE ROUTE ENFORCES, deliberately. `components` is validated
 * at `MAX_SYNCED_COMPONENT_USAGE` on the session-sync payload, so a larger
 * fixture would only describe a population the service cannot be handed. At
 * that cap the widest of the three statements is the INSERT at 13 parameters
 * per row, which is well inside the ceiling — this lane's chunking is a BOUND
 * that survives a cap change or a new column, not a split that happens today,
 * and these assertions say only what they can prove. The splitting behaviour
 * itself, and the fixed-bind reservation, are covered against real over-budget
 * populations in `write-chunking.test.ts`; the reachable over-limit lane is the
 * activity tiling, covered in `activity-segment-persistence.test.ts`.
 */
const COMPUTE_TARGET_ID = "019fa000-0000-7000-8000-000000000000";
const AGENT_SESSION_ID = "019fa111-1111-7111-8111-111111111111";
const USAGE_INSERT_BIND_PARAMETERS_PER_ROW = 13;

describe("component-usage writes stay inside the bind ceiling (ISS-8185)", () => {
  it("keeps every usage INSERT inside the limit and persists all rows at the wire cap", async () => {
    const { tx, executeRaw } = makeTx();

    await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWithUsages(MAX_SYNCED_COMPONENT_USAGE)
    );

    const bindCounts = insertBindParameterCounts(executeRaw);
    expect(bindCounts.length).toBeGreaterThan(0);
    for (const count of bindCounts) {
      expect(count).toBeLessThanOrEqual(POSTGRES_MAX_BIND_PARAMETERS);
    }
    // Bounding the write must not drop rows: every distinct component key the
    // payload carried still reaches a statement, exactly once.
    expect(insertedComponentKeys(executeRaw)).toEqual(
      expectedComponentKeys(MAX_SYNCED_COMPONENT_USAGE)
    );
  });

  it("binds a fixed three parameters for the FK lookup at the wire cap", async () => {
    const { findMany, queryRaw, tx } = makeTx();

    await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWithUsages(MAX_SYNCED_COMPONENT_USAGE)
    );

    expect(findMany).not.toHaveBeenCalled();
    expect(rawBindCountsMatching(queryRaw, "FROM agent_components")).toEqual([
      3,
    ]);
  });

  /**
   * ISS-8062: the prune is bounded by SHAPE, not by slicing — it binds the
   * session id plus five `text[]` arrays however large the payload is. Asserted
   * across two very different populations because a fixed count is the whole
   * claim: a per-group `notIn` would have grown with both the group count and
   * each group's branch set, and no slice size could have bounded it (splitting
   * an intersective `notIn` changes what the delete matches).
   */
  it("binds a fixed six parameters for the branch-bucket prune at any payload size", async () => {
    const bindCounts: number[] = [];
    for (const usageCount of [1, MAX_SYNCED_COMPONENT_USAGE]) {
      const { tx, executeRaw } = makeTx();

      await persistSessionComponentUsage(
        tx,
        COMPUTE_TARGET_ID,
        AGENT_SESSION_ID,
        sessionWithUsages(usageCount)
      );

      const pruneBinds = rawBindCountsMatching(executeRaw, "DELETE FROM");
      expect(pruneBinds).toHaveLength(1);
      bindCounts.push(pruneBinds[0]);
    }

    expect(bindCounts).toEqual([6, 6]);
  });
});

/**
 * BIND VALUES, not template slots. A nested `Prisma.Sql` — what `Prisma.join`
 * builds — occupies ONE interpolation while carrying one bind per joined item,
 * so counting slots would report a constant for the very regression this file
 * exists to catch (a prune whose binds scale with the payload again). An array
 * interpolation is the opposite case and genuinely is one bind: Postgres takes a
 * whole `text[]` as a single parameter, which is what makes the `unnest` form
 * payload-independent.
 */
function bindValueCount(values: readonly unknown[]): number {
  let total = 0;
  for (const value of values) {
    total += value instanceof Prisma.Sql ? bindValueCount(value.values) : 1;
  }
  return total;
}

/** Bind counts of each `$executeRaw` tagged-template call whose SQL matches. */
function rawBindCountsMatching(
  executeRaw: ReturnType<typeof vi.fn>,
  sqlFragment: string
): number[] {
  const matched: number[] = [];
  for (const [strings, ...values] of executeRaw.mock.calls as [
    TemplateStringsArray,
    ...unknown[],
  ][]) {
    if (strings.join("").includes(sqlFragment)) {
      matched.push(bindValueCount(values));
    }
  }
  return matched;
}

function makeTx() {
  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn().mockResolvedValue([]);
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const findMany = vi.fn().mockResolvedValue([]);
  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    agentComponent: { findMany },
    agentComponentSessionUsage: { deleteMany },
  } as unknown as AgentSessionUpsertTx;
  return { deleteMany, executeRaw, findMany, queryRaw, tx };
}

/** Bind values actually carried by each emitted `INSERT ... VALUES` statement. */
function insertBindParameterCounts(executeRaw: ReturnType<typeof vi.fn>) {
  return insertValues(executeRaw).map((values) => values.length);
}

/**
 * The INSERT's own bind values. Filtered rather than mapped over every call:
 * the branch-bucket prune shares `$executeRaw` with the INSERT and interpolates
 * bare strings and arrays, so reading `.values` off every call would fault on
 * it — and silently counting its binds as the INSERT's would let an unchunked
 * INSERT pass.
 */
function insertValues(executeRaw: ReturnType<typeof vi.fn>): unknown[][] {
  const inserts: unknown[][] = [];
  for (const [strings, joined] of executeRaw.mock.calls as [
    TemplateStringsArray,
    Prisma.Sql,
  ][]) {
    if (strings.join("").includes("INSERT INTO")) {
      inserts.push(joined.values);
    }
  }
  return inserts;
}

/**
 * The `component_key` bound by every emitted row, read positionally off the
 * VALUES tuple (id, agent_session_id, component_kind, component_key, ...).
 */
function insertedComponentKeys(executeRaw: ReturnType<typeof vi.fn>): string[] {
  const keys: string[] = [];
  for (const values of insertValues(executeRaw)) {
    for (
      let index = 3;
      index < values.length;
      index += USAGE_INSERT_BIND_PARAMETERS_PER_ROW
    ) {
      keys.push(values[index] as string);
    }
  }
  return keys.sort();
}

function expectedComponentKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    componentKey(index)
  ).sort();
}

function componentKey(index: number): string {
  return `skill-${index}`;
}

function sessionWithUsages(count: number): SyncedAgentSession {
  const components: SyncedComponentUsage[] = Array.from(
    { length: count },
    (_, index) => ({
      componentKind: AgentComponentKind.Skill,
      componentKey: componentKey(index),
      externalComponentId: `skill::${index}`,
      harness: "claude",
      invocations: 1,
      errorCount: 0,
      gitBranch: `feat/${index}`,
      firstInvokedAt: "2026-05-01T10:00:00.000Z",
      lastInvokedAt: "2026-05-01T10:30:00.000Z",
    })
  );
  return { components } as unknown as SyncedAgentSession;
}
