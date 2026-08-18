/**
 * @file opencode-diff-stats.ts
 * @description Build a session's aggregate `diffStats`, preferring the
 * `session` table's `summary_*` columns and falling back to patch-part
 * accumulation. Extracted from `opencode-parser.ts` (grandfathered shrink-only
 * under the root AGENTS.md line-count contract) when ISS-5238 F5 added the
 * validation this path never had.
 *
 * ISS-5238 (F5): the summary columns used to be read with a bare
 * `Number(cell || 0)`. A non-numeric TEXT/BLOB cell yields `NaN` and `"-3"`
 * yields `-3`, and neither was validated, clamped, or floored — in sharp
 * contrast to the token path, which routes every counter through
 * `readStorageTokenCount` and THROWS on exactly these values. A `NaN` reached
 * `buildOpencodeSessionRecord`, `JSON.stringify(NaN)` emitted `null`, and the
 * cloud reader's `diffStatsSchema` (`z.number()`) rejected the session HEADER
 * line — so `parse-opencode.ts` discarded the ENTIRE session, every valid
 * message/tool/token line with it. The desktop write "succeeded", so the
 * materializer fingerprint advanced and the projection froze in a state the
 * cloud can never render.
 *
 * So the summary columns are now validated through the SAME canonical reader the
 * token path uses. A column that is present but is not a non-negative safe
 * integer makes the whole summary triple untrustworthy: it is reported on the
 * monitored channel and the read falls through to the patch-part accumulation,
 * which is an independently derived value rather than a fabricated one. Nothing
 * non-finite or negative can be emitted from here.
 */
import { clampStorageTokenCount } from "../../cost/token-counts.js";
import {
  computeUnifiedDiffDelta,
  countDiffFiles,
} from "../parsing/parser-utils.js";
import type { NormalizedDiffStats } from "../types.js";
import { describeOpencodeCell } from "./opencode-parse-failure.js";

/** A raw `session` row as read back from the foreign `opencode.db`. */
type DiffStatsSourceRow = Record<string, unknown>;

/** Patch-part accumulated diff counters, the fallback source. */
export type OpencodePatchDiffTotals = {
  added: number;
  removed: number;
  filesChanged: number;
};

/** The validated `summary_additions` / `summary_deletions` / `summary_files` triple. */
type SummaryCounts = {
  adds: number;
  dels: number;
  files: number;
};

/**
 * Read one `summary_*` column as a non-negative safe integer, or `null` when the
 * cell is present but unusable (reported to `report`).
 *
 * A FALSY cell (`null`, `undefined`, `0`, `""`, `0n`) — or a string that is blank
 * once trimmed — reads as `0`, preserving the pre-ISS-5238 `Number(cell || 0)`
 * semantics for the legitimately-empty case. Everything else is validated by
 * `clampStorageTokenCount` — the canonical storage-counter reader — whose
 * `clamped` flag is used here as "this cell is not a count", NOT as a licence to
 * persist the clamped `0`.
 */
function readSummaryCount(
  value: unknown,
  field: string,
  report: (message: string) => void
): number | null {
  if (!value) {
    return 0;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return 0;
  }
  const read = clampStorageTokenCount(value, field);
  if (read.clamped) {
    report(
      `${field} is not a non-negative integer (${describeOpencodeCell(value)}); ignoring the summary_* diff columns and falling back to patch-accumulated diff stats`
    );
    return null;
  }
  return read.value;
}

/**
 * Validate the whole summary triple, returning `null` when ANY column is
 * unusable. Partial trust is not on the table: a session whose additions parsed
 * but whose deletions did not would otherwise publish a half-real diff.
 */
function readSummaryCounts(
  sessionRow: DiffStatsSourceRow,
  report: (message: string) => void
): SummaryCounts | null {
  const adds = readSummaryCount(
    sessionRow.summary_additions,
    "opencode.session.summary_additions",
    report
  );
  const dels = readSummaryCount(
    sessionRow.summary_deletions,
    "opencode.session.summary_deletions",
    report
  );
  const files = readSummaryCount(
    sessionRow.summary_files,
    "opencode.session.summary_files",
    report
  );
  if (adds === null || dels === null || files === null) {
    return null;
  }
  return { adds, dels, files };
}

/**
 * Resolve the summary-column branch, or `null` to fall through to the patch
 * accumulation. `summary_diffs` (unified diff TEXT) supplies line counts only
 * where the explicit columns are zeroed out; the explicit columns stay
 * authoritative when they carry data.
 */
function diffStatsFromSummary(
  sessionRow: DiffStatsSourceRow,
  summary: SummaryCounts
): NormalizedDiffStats | null {
  const summaryDiffsRaw = sessionRow.summary_diffs;
  if (typeof summaryDiffsRaw === "string" && summaryDiffsRaw.length > 0) {
    const diffDelta = computeUnifiedDiffDelta(summaryDiffsRaw);
    const diffFiles = countDiffFiles(summaryDiffsRaw);
    const effectiveAdds = summary.adds || diffDelta.add;
    const effectiveDels = summary.dels || diffDelta.del;
    const effectiveFiles = summary.files || diffFiles;
    if (effectiveAdds || effectiveDels || effectiveFiles) {
      return {
        filesChanged: effectiveFiles,
        linesAdded: effectiveAdds,
        linesRemoved: effectiveDels,
      };
    }
    return null;
  }
  if (summary.adds || summary.dels || summary.files) {
    return {
      filesChanged: summary.files,
      linesAdded: summary.adds,
      linesRemoved: summary.dels,
    };
  }
  return null;
}

/**
 * CR-4/CR-9: build aggregate `diffStats`. Prefers the session row's validated
 * `summary_*` columns and falls back to patch-part accumulation.
 */
export function resolveOpencodeDiffStats(
  sessionRow: DiffStatsSourceRow,
  hasSummaryCols: boolean,
  patch: OpencodePatchDiffTotals,
  report: (message: string) => void
): NormalizedDiffStats | null {
  if (hasSummaryCols) {
    const summary = readSummaryCounts(sessionRow, report);
    const fromSummary = summary
      ? diffStatsFromSummary(sessionRow, summary)
      : null;
    if (fromSummary) {
      return fromSummary;
    }
  }
  if (patch.added || patch.removed || patch.filesChanged) {
    return {
      filesChanged: patch.filesChanged,
      linesAdded: patch.added,
      linesRemoved: patch.removed,
    };
  }
  return null;
}
