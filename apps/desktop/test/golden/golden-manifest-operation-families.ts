/**
 * ISS-12552: every operation family the Closedloop MCP tool
 * table names must have a `test-cases.csv` row, collected or needed, so the
 * manifest cannot silently omit a family. A row names its family as
 * `[operation family: <OperationKind>]` inside `test_case`.
 */
import type { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { CLOSEDLOOP_MCP_TOOL_SEMANTICS } from "@repo/api/src/types/closedloop-operation-semantics";

const OPERATION_FAMILY_RE = /\[operation family: ([A-Za-z]+)\]/g;

/** The families in the tool table that no row of `rows` (header first) names. */
export function uncoveredOperationFamilies(
  rows: readonly string[][]
): OperationKind[] {
  const families = new Set<OperationKind>(
    Object.values(CLOSEDLOOP_MCP_TOOL_SEMANTICS).map((entry) => entry.kind)
  );
  const testCaseIdx = rows[0]?.indexOf("test_case") ?? -1;
  if (testCaseIdx === -1) {
    return [...families].sort();
  }
  const cited = new Set<string>();
  for (const row of rows.slice(1)) {
    for (const match of (row[testCaseIdx] ?? "").matchAll(
      OPERATION_FAMILY_RE
    )) {
      cited.add(match[1] ?? "");
    }
  }
  return [...families].filter((family) => !cited.has(family)).sort();
}
