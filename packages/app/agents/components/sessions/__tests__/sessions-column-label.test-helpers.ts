import { SESSIONS_COLUMN_SPECS } from "../../../lib/sessions-table-columns";

export function sessionsColumnLabel(columnId: string): string {
  const spec = SESSIONS_COLUMN_SPECS.find((entry) => entry.id === columnId);
  if (!spec) {
    throw new Error(`no column spec for "${columnId}"`);
  }
  return spec.label;
}
