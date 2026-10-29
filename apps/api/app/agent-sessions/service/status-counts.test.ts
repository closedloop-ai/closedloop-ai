import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_SESSION_COUNTED_STATUSES,
  type AgentSessionStatusCountsResponse,
} from "@repo/api/src/types/agent-session-status-counts";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import ts from "typescript6";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  installSeededSessionStatusDb,
  SEEDED_ORGANIZATION_ID,
  SEEDED_SESSION_STATUS_ROWS,
} from "@/__tests__/support/agent-sessions/session-status-population";
import {
  buildAgentSessionStatusCounts,
  STATUS_COUNTS_SNAPSHOT_TX_TIMEOUT_MS,
} from "./status-counts";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const HERE = dirname(fileURLToPath(import.meta.url));

/** The `.js` suffix a TypeScript ESM specifier may carry, stripped to reach the source. */
const JS_SUFFIX = /\.js$/;

/**
 * ISS-8858: `GET /agent-sessions/status-counts` answers a per-status count without
 * building a row projection.
 *
 * The seeded population (`session-status-population.ts`) is the same one the
 * Status-facet suite filters, executed through the same evaluator, so a count
 * asserted here is a count over rows the production predicate actually admitted —
 * not over a `where` object whose shape was eyeballed.
 */
describe("Sessions status counts (ISS-8858)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts every displayed status in ONE read, and the buckets reconcile with their own population", async () => {
    installSeededSessionStatusDb();

    const counts = await countStatuses();

    // Pinned literals over the seeded fixture, NOT re-derived from the counting
    // query — the expectation has to be able to disagree with the code.
    //
    // ISS-10629 changed the EXPECTATION twice over, and neither is a weakened
    // assertion — this is still a whole-object `toEqual`. Operator ruling
    // 2026-09-18.
    //
    // 1. Buckets are EQUALITY on the persisted column now, matching the list's
    //    filter. `active` therefore holds every row that STORES `active`,
    //    including the three that carry a recorded end. That is why `active`
    //    is 4 and `inactive`/`error` are 1 rather than 2 — the rows moved
    //    bucket, the population did not change.
    // 2. ISS-10364 retired the display-only waiting/stale/unknown buckets this
    //    used to also assert as `null` (NOT COUNTED) — the response now has
    //    exactly the three lifecycle keys, every one a real count.
    expect(counts.countsByStatus).toEqual({
      [SESSION_STATUS.ACTIVE]: 4,
      [SESSION_STATUS.INACTIVE]: 1,
      [SESSION_STATUS.ERROR]: 1,
    });

    // The reconciliation this repo tracks as its own defect class: a bucket that
    // exceeds its parent population, or a set of buckets that does not add up to
    // it. `total` is COUNTED independently (a second predicate over the
    // status-free population), so this is a real comparison and not arithmetic
    // agreeing with itself.
    expect(counts.total).toBe(6);
    expect(sumBuckets(counts)).toBe(counts.total);
    for (const count of Object.values(counts.countsByStatus)) {
      expect(count).toBeLessThanOrEqual(counts.total);
    }
    // Exactly three buckets, all counted — pinned positively so a fourth key,
    // or a reinstated permanently-`null` one, fails here.
    expect(Object.values(counts.countsByStatus)).toHaveLength(3);
  });

  it("never counts a session from another organization", async () => {
    installSeededSessionStatusDb();

    const counts = await countStatuses();

    // The seed's one out-of-org row stores `inactive`, so it would land in the
    // Inactive bucket if the org predicate were dropped: that counterfactual
    // reads `inactive` 2 (not 1) and `total` 7 (not 6). Derived from the fixture
    // rather than written as a bare literal, so a seed that gains or loses a
    // foreign row cannot leave this assertion quietly describing the old one.
    //
    // The in-org figure is 1 rather than 2 since ISS-10629 moved the buckets
    // to the persisted column: the ended row that used to badge Inactive
    // stores `active` and is counted there. The org predicate this case exists
    // to test is unaffected by that.
    const foreignRows = SEEDED_SESSION_STATUS_ROWS.filter(
      (row) => row.organizationId !== SEEDED_ORGANIZATION_ID
    );
    expect(foreignRows).toHaveLength(1);
    expect(foreignRows[0].status).toBe(SESSION_STATUS.INACTIVE);
    expect(counts.countsByStatus[SESSION_STATUS.INACTIVE]).toBe(1);
    expect(counts.total).toBe(
      SEEDED_SESSION_STATUS_ROWS.length - foreignRows.length
    );
  });

  it("issues one COUNT per bucket plus the total, and materialises no row", async () => {
    const { findMany, count } = installSeededSessionStatusDb();

    await countStatuses();

    // AC2/AC7: assert the WORK, not the number. The number is correct whether the
    // count is a `COUNT(*)` or a full list read that happens to be measured —
    // rerouting this path through `findSessions` (and so through
    // `projections.ts`) keeps every assertion above green and reddens only here.
    expect(findMany).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledTimes(
      AGENT_SESSION_COUNTED_STATUSES.length + 1
    );
    // A `count` cannot return a row even by accident, but a `select` on one would
    // mean the read was rewritten into something that can.
    for (const [args] of count.mock.calls) {
      expect(args).not.toHaveProperty("select");
      expect(args).not.toHaveProperty("include");
    }
  });

  // ISS-10742: the case pinning "the parity gate does not reach these buckets"
  // is gone because `AgentSessionScope.displayedStatusParity` is — `tsc` now
  // refuses the call it was written to make.

  it("counts every bucket inside ONE RepeatableRead snapshot", async () => {
    // `withDb` is not transactional, so each `count` used to take its own READ
    // COMMITTED snapshot: a row moving between statuses mid-read could be
    // counted in both buckets, in neither, or in a bucket while missing from the
    // independently-counted `total` (codex review; `apps/api/AGENTS.md`: "A page
    // and its total read in two statements are not one snapshot").
    const { count } = installSeededSessionStatusDb();
    const tx = (withDb as unknown as { tx: Mock }).tx;
    const runTransaction = tx.getMockImplementation();
    // The harness types its spies as bare `vi.fn()`, so the captured
    // implementation has to be re-typed to be called through.
    const evaluate = count.getMockImplementation() as
      | ((args: { where?: Record<string, unknown> }) => Promise<unknown>)
      | undefined;
    let insideTransaction = false;
    const observed: boolean[] = [];
    const runInTransaction = runTransaction as
      | ((callback: unknown, options: unknown) => Promise<unknown>)
      | undefined;
    tx.mockImplementation(async (callback: unknown, options: unknown) => {
      insideTransaction = true;
      try {
        return await runInTransaction?.(callback, options);
      } finally {
        insideTransaction = false;
      }
    });
    count.mockImplementation((args: { where?: Record<string, unknown> }) => {
      observed.push(insideTransaction);
      return evaluate?.(args);
    });

    await countStatuses();

    expect(tx).toHaveBeenCalledTimes(1);
    expect(tx.mock.calls[0]?.[1]).toEqual({
      isolationLevel: "RepeatableRead",
      timeout: STATUS_COUNTS_SNAPSHOT_TX_TIMEOUT_MS,
    });
    // The options alone would pass against a transaction that wrapped nothing,
    // so every count has to be observed from inside it — and there must be as
    // many of them as there are buckets plus the total.
    expect(observed).toHaveLength(AGENT_SESSION_COUNTED_STATUSES.length + 1);
    expect(observed.every(Boolean)).toBe(true);
  });

  it("keeps `projections.ts` out of the counts path's import graph", () => {
    // AC2 is structural: the projection IS the cost, so reaching it at all — even
    // through a module that only re-exports — reintroduces what this endpoint
    // exists to avoid. Walked over the AST, the sanctioned alternative to a raw
    // text scan.
    const reached = collectReachableLocalModules([
      join(HERE, "status-counts.ts"),
      resolve(HERE, "..", "status-counts", "route.ts"),
    ]);

    expect(
      [...reached].filter((file) => file.endsWith("/projections.ts"))
    ).toEqual([]);
    // The walk must actually be reaching modules, or the assertion above passes
    // vacuously on an empty set.
    expect(reached.size).toBeGreaterThan(5);
  });
});

/**
 * Sum of the buckets. ISS-10629 had to skip the `null` display-only buckets
 * here rather than coerce them to 0; ISS-10364 retired those keys, so every
 * bucket is a real count and the sum is over all of them.
 */
function sumBuckets(counts: AgentSessionStatusCountsResponse): number {
  return Object.values(counts.countsByStatus).reduce(
    (total, count) => total + count,
    0
  );
}

function countStatuses(): Promise<AgentSessionStatusCountsResponse> {
  return buildAgentSessionStatusCounts({
    organizationId: SEEDED_ORGANIZATION_ID,
    filters: { quality: "all" },
  });
}

/**
 * Every first-party module reachable from `entries` by relative import. Package
 * specifiers are boundaries, not nodes: `projections.ts` is a sibling of the
 * counts module, so a path to it is necessarily a chain of relative imports.
 */
function collectReachableLocalModules(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const specifier of collectImportSpecifiers(file)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveLocalModule(dirname(file), specifier);
      if (resolved !== null) {
        queue.push(resolved);
      }
    }
  }
  return seen;
}

/**
 * Resolve a relative specifier to a `.ts` file on disk, or `null` when it names
 * something this walk does not model (a directory index, a `.json`). Returning
 * `null` rather than throwing keeps the walk honest about its own reach — the
 * caller asserts the reached set is non-trivial, so a resolver that silently gave
 * up on everything cannot pass.
 */
function resolveLocalModule(fromDir: string, specifier: string): string | null {
  const base = resolve(fromDir, specifier.replace(JS_SUFFIX, ""));
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Not this shape; try the next.
    }
  }
  return null;
}

/** Parse a source file and return every static/dynamic import module specifier. */
function collectImportSpecifiers(filePath: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}
