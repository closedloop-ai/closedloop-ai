import { withDb } from "@repo/database";
import { vi } from "vitest";

/**
 * ISS-12552 flag-off parity: counts the `withDb.tx` calls a request makes
 * from here on, still running each one for real. `opened` counts only the
 * outermost calls (real transactions); `calls` also counts calls that joined
 * an enclosing transaction. Restored by `vi.restoreAllMocks`.
 */
export function countTransactions(): { opened: number; calls: number } {
  const counts = { opened: 0, calls: 0 };
  const original = withDb.tx;
  let depth = 0;
  vi.spyOn(withDb, "tx").mockImplementation(async (run, options) => {
    counts.calls += 1;
    if (depth === 0) {
      counts.opened += 1;
    }
    depth += 1;
    try {
      return await original(run, options);
    } finally {
      depth -= 1;
    }
  });
  return counts;
}
