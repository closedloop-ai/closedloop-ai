import type { NormalizedSession } from "../collectors/types.js";
import { InvalidTokenCountError } from "../cost/token-counts.js";
import { normalizeTokenUsageCounts } from "./db-helpers.js";
import type { TokenEventRecord } from "./token-event-contract.js";
import { normalizeTokenEventRecord } from "./token-event-identity.js";

/**
 * FEA-2027: validate every token counter the import would persist BEFORE any
 * record group commits, reusing the exact write-path normalizers so the check
 * can never drift from what the token groups enforce. Returns the first
 * {@link InvalidTokenCountError} found, or null when all counts are safe.
 *
 * Each record group commits in its own isolated transaction, so an unsafe counter
 * (negative, fractional, JS-unsafe) that threw mid-import would leave the session
 * and its events committed while a corrupt count still reached token_events. So
 * the isolated path detects the unsafe count up front and skips the whole session
 * (writing nothing), while the rest of the source still imports.
 */
export function findUnsafeImportTokenCount(ctx: {
  session: NormalizedSession;
  tokenEventsRecords: TokenEventRecord[];
}): InvalidTokenCountError | null {
  try {
    for (const counts of Object.values(ctx.session.tokensByModel ?? {})) {
      normalizeTokenUsageCounts(counts, "token_usage");
    }
    for (const rec of ctx.tokenEventsRecords) {
      normalizeTokenEventRecord(rec, "token_events");
    }
    return null;
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      return error;
    }
    throw error;
  }
}
