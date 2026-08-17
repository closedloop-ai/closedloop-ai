/**
 * Shared row builders for the `identity.ts` suites.
 *
 * Extracted when the ISS-5009 honest-Source cases pushed `identity.test.ts` past
 * the 1,000-line ceiling and moved to their own sibling file: both suites drive
 * the real merge fold, so they need the SAME `InventoryRow` / `OrphanUsageRow`
 * defaults. Copying the builders would let the two files' notions of "a default
 * inventory row" drift apart, and a provenance test is only meaningful if its
 * baseline row is the same one every other suite reasons about.
 */

import type { InventoryRow, OrphanUsageRow } from "../identity";

/** The identity fold's row cap, as the production readers pass it. */
export const MAX_ROWS = 5000;

/**
 * One inventory row with provenance-free defaults.
 *
 * Every provenance column (`sourceUrl`, `packId`, `scope`, `projectPath`)
 * defaults to null so a case that sets ONE is unambiguously exercising that
 * branch. `installPath` is the exception — it defaults to a path precisely
 * because it is NOT provenance, so the default row proves an install path alone
 * never fabricates a source.
 */
export function inventoryRow(overrides: Partial<InventoryRow>): InventoryRow {
  return {
    id: overrides.id ?? "row-1",
    organizationId: "org-1",
    computeTargetId: overrides.computeTargetId ?? "target-1",
    componentKind: overrides.componentKind ?? "skill",
    externalComponentId: overrides.externalComponentId ?? "ext-1",
    harness: overrides.harness ?? "claude",
    name: overrides.name ?? "code-review",
    componentKey: overrides.componentKey ?? "code-review",
    contentHash: overrides.contentHash ?? null,
    definitionHash: overrides.definitionHash ?? null,
    sourceUrl: overrides.sourceUrl ?? null,
    installPath: overrides.installPath ?? "/a/SKILL.md",
    packId: overrides.packId ?? null,
    scope: overrides.scope ?? null,
    projectPath: overrides.projectPath ?? null,
    // FEA-4247: default to non-cloud provenance; cloud-authored cases override.
    metadata: overrides.metadata ?? null,
    firstSeenAt: overrides.firstSeenAt ?? new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: overrides.lastSeenAt ?? new Date("2026-01-02T00:00:00.000Z"),
    computeTarget: overrides.computeTarget ?? {
      id: overrides.computeTargetId ?? "target-1",
      userId: "user-1",
    },
  };
}

/** One null-FK usage row, as `foldOrphanUsageIntoMerged` receives it. */
export function orphanUsage(
  overrides: Partial<OrphanUsageRow>
): OrphanUsageRow {
  return {
    agentSessionId: overrides.agentSessionId ?? "session-1",
    componentKind: overrides.componentKind ?? "skill",
    componentKey: overrides.componentKey ?? "code-review",
    harness: overrides.harness ?? "claude",
    invocationCount: overrides.invocationCount ?? 3,
    errorCount: overrides.errorCount ?? 0,
    firstInvokedAt:
      overrides.firstInvokedAt ?? new Date("2026-01-05T00:00:00.000Z"),
    lastInvokedAt:
      overrides.lastInvokedAt ?? new Date("2026-01-06T00:00:00.000Z"),
    componentVersionHash: overrides.componentVersionHash ?? null,
    definitionHash: overrides.definitionHash ?? null,
  };
}
