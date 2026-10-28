import { AgentComponentSortKey } from "@repo/api/src/types/agent-component";

/**
 * `AgentsTable` column id → the sort key the inventory read applies.
 *
 * Shared by both branches of `agent-ops-complete-surface` (ISS-9398). Two copies
 * would not fail: the `Name` fallback swallows an unmapped id, so a column added
 * to the shared table and mapped in one fork only would sort by the real key on
 * one shell and silently by Name on the other — the collapse the fallback makes
 * invisible.
 *
 * No `collaborators` entry: the Collaborators column is the authors people-set
 * and is unsortable (FEA-4098), so it never reaches here.
 */
const AGENTS_COLUMN_SORT_KEYS: Record<string, AgentComponentSortKey> = {
  harness: AgentComponentSortKey.Harness,
  invocations: AgentComponentSortKey.Invocations,
  metric: AgentComponentSortKey.Metric,
  name: AgentComponentSortKey.Name,
  sessions: AgentComponentSortKey.Sessions,
  source: AgentComponentSortKey.Source,
  type: AgentComponentSortKey.Type,
};

/** The sort key a column header click applies; an unmapped id sorts by Name. */
export function agentsColumnSortKey(columnId: string): AgentComponentSortKey {
  return AGENTS_COLUMN_SORT_KEYS[columnId] ?? AgentComponentSortKey.Name;
}
