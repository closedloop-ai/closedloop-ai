// Group-by band construction for the Sessions table (PRD-557 FEA-4200). Turns a
// flat, already-filtered/sorted row list into the `GridTableGroup` bands
// GridTable renders under collapsible section headers. "None" is handled by the
// caller (it passes the flat list instead of groups).

import type { GridTableGroup } from "@repo/design-system/components/ui/grid-table";
import {
  GroupBy,
  HARNESS_CONFIG,
  SESSION_STATUS_CONFIG,
  type SessionRow,
} from "../mock";
import { OWNER_UNATTRIBUTED } from "./sessions-toolbar";

type GroupKeyed = { key: string; label: string };

function groupKeyFor(row: SessionRow, groupBy: GroupBy): GroupKeyed {
  if (groupBy === GroupBy.Status) {
    return { key: row.status, label: SESSION_STATUS_CONFIG[row.status].label };
  }
  if (groupBy === GroupBy.Harness) {
    return { key: row.harness, label: HARNESS_CONFIG[row.harness].label };
  }
  const owner = row.user?.name ?? OWNER_UNATTRIBUTED;
  return { key: owner, label: owner };
}

/**
 * Build ordered group bands, preserving the incoming row order within and
 * across groups (a group's position is where its first member appears), so the
 * caller's sort still governs ordering inside each band.
 */
export function buildSessionGroups(
  rows: readonly SessionRow[],
  groupBy: GroupBy
): GridTableGroup<SessionRow>[] {
  const groups = new Map<string, GridTableGroup<SessionRow>>();
  for (const row of rows) {
    const { key, label } = groupKeyFor(row, groupBy);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(row);
    } else {
      groups.set(key, { key, label, items: [row] });
    }
  }
  return [...groups.values()];
}
