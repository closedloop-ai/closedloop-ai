/** Build a minimal successful GitHub status-check rollup fixture. */
export function statusRollup(state: string | null = "SUCCESS") {
  return {
    ok: true,
    state,
    checks: [],
    totalCount: 0,
    truncated: false,
  };
}
