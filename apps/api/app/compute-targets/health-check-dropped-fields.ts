import type { UpsertComputeTargetHealthCheckSnapshotInput } from "@repo/api/src/types/compute-target";
import { HarnessType } from "@repo/api/src/types/compute-target";

/**
 * Which guarded fields `healthCheckSnapshotValidator` actually discarded.
 *
 * The four `z.preprocess` guards on a check row degrade an unusable value to
 * "absent" rather than failing the whole snapshot PUT (ISS-5811, ISS-5868).
 * That is the right failure mode — rejection is not row-scoped, so one bad
 * field would discard the entire refresh — but a value silently coerced away
 * is a corrupt producer nobody is told about, which is how `severity` went
 * missing for days. A `preprocess` swallows the value before `safeParse` can
 * raise an issue, so the parse error path never sees it either.
 *
 * This diffs the RAW body against the PARSED result so the route can report
 * the drop against the target it happened on, where the context is richest.
 */
export const GUARDED_CHECK_FIELDS = [
  "enableOutcome",
  "updateOutcome",
  "severity",
  "blockedBy",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getRawChecks(rawBody: unknown): unknown[] {
  const result = asRecord(asRecord(rawBody)?.result);
  return Array.isArray(result?.checks) ? result.checks : [];
}

/**
 * `<checkId>.<field>` for every guarded field the gateway sent a value for and
 * the validator dropped, plus `mcpServers.<harness>.repair.action` for the MCP
 * provider entries, which carry the same dropping guard outside `checks[]`.
 * Empty when nothing was discarded — the common case, so callers should stay
 * silent on an empty list rather than log a no-op.
 *
 * Index-aligned: `z.array` preserves order and length, so the Nth parsed row is
 * the Nth raw row.
 */
export function getDroppedHealthCheckFields(
  rawBody: unknown,
  parsed: UpsertComputeTargetHealthCheckSnapshotInput
): string[] {
  const rawChecks = getRawChecks(rawBody);
  const dropped: string[] = [];
  parsed.result.checks.forEach((parsedCheck, index) => {
    const rawCheck = asRecord(rawChecks[index]);
    if (!rawCheck) {
      return;
    }
    for (const field of GUARDED_CHECK_FIELDS) {
      if (rawCheck[field] !== undefined && parsedCheck[field] === undefined) {
        dropped.push(`${parsedCheck.id}.${field}`);
      }
    }
    const rawAction = asRecord(rawCheck.repair)?.action;
    if (rawAction !== undefined && parsedCheck.repair?.action === undefined) {
      dropped.push(`${parsedCheck.id}.repair.action`);
    }
  });
  dropped.push(...getDroppedMcpRepairActions(rawBody, parsed));
  return dropped;
}

/**
 * `mcpServers.<harness>.repair.action` for each MCP provider whose repair action
 * the boundary discarded.
 *
 * The MCP provider entries reuse the SAME `healthCheckRepairValidator` the check
 * rows do, so the unknown-action `z.preprocess` drops a value here exactly as it
 * does there — and these rows are not in `result.checks`, so the index-aligned
 * loop above never sees them. That silence is the ISS-5811 shape: the web
 * synthesizes a `<provider>-mcp` row from this entry and `repair.action` is the
 * only place the gateway can say Repair is drivable on it, so losing it renders
 * a repairable MCP row as "Repair unsupported" with nothing said anywhere.
 *
 * Keyed off `HarnessType` rather than a local `["claude", "codex"]`: those are
 * the same two providers `mcpServers` is keyed by, so a third harness reaches
 * this sweep with the rest of the codebase instead of being forgotten here.
 */
function getDroppedMcpRepairActions(
  rawBody: unknown,
  parsed: UpsertComputeTargetHealthCheckSnapshotInput
): string[] {
  const rawMcpServers = asRecord(
    asRecord(asRecord(rawBody)?.result)?.mcpServers
  );
  if (!rawMcpServers) {
    return [];
  }
  const dropped: string[] = [];
  for (const harness of Object.values(HarnessType)) {
    const rawAction = asRecord(
      asRecord(rawMcpServers[harness])?.repair
    )?.action;
    const parsedAction = parsed.result.mcpServers?.[harness]?.repair?.action;
    if (rawAction !== undefined && parsedAction === undefined) {
      dropped.push(`mcpServers.${harness}.repair.action`);
    }
  }
  return dropped;
}
