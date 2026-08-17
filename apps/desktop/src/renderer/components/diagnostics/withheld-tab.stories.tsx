import type { DiagnosticsWithheldRow } from "../../../shared/diagnostics-contract";
import { WithheldTab } from "./withheld-tab";

/**
 * ISS-5266: the Diagnostics → Withheld tab, one story per state.
 *
 * The tab exists to keep three answers apart — nothing is withheld, N sessions
 * are withheld, and we cannot tell you — so the states are worth seeing side by
 * side. In the running app it is behind a Labs toggle (default off) and only
 * reachable when an OpenCode store has actually failed to parse a root row,
 * which is not something you can arrange on demand.
 */
const meta = {
  title: "Desktop/Diagnostics/Withheld Tab",
  component: WithheldTab,
};

export default meta;

/** A store with a completed scan, so an empty set is a real completeness claim. */
const SCANS = [
  {
    sourcePath: "/Users/example/.local/share/opencode/opencode.db",
    observedAt: "2026-08-06T09:14:02.000Z",
  },
];

const SHORT_REASON =
  "Invalid token count for opencode.session.input: expected a safe non-negative integer";

/** A realistic parse message: they quote the offending cell, so they run long. */
const LONG_REASON =
  'Invalid token count for opencode.session.cache_read: expected a safe non-negative integer, got string "1,204,553 (recovered from partial write at 2026-08-04T11:22:31Z)"';

function row(overrides: Partial<DiagnosticsWithheldRow> = {}) {
  return {
    rootRawId: "ses_7f3c9a1e2b",
    sourcePath: "/Users/example/.local/share/opencode/opencode.db",
    withheldCount: 2,
    reason: SHORT_REASON,
    withheldTokens: 4321,
    withheldCacheTokens: 51_884,
    earliestChildStartedAt: "2026-08-01T00:00:00.000Z",
    latestChildEndedAt: "2026-08-01T05:00:00.000Z",
    windowPartial: false,
    observedAt: "2026-08-06T09:14:02.000Z",
    ...overrides,
  };
}

/** Nothing withheld. The quiet state — nothing is owed to the reader. */
export const Complete = {
  args: { scans: SCANS, withheld: [] },
};

/** One subtree withheld, with the exact shortfall stated. */
export const OneWithheldSubtree = {
  args: { scans: SCANS, withheld: [row()] },
};

/** Several subtrees, including a long reason and a half-known window. */
export const SeveralWithheldSubtrees = {
  args: {
    scans: SCANS,
    withheld: [
      row(),
      row({
        rootRawId: "ses_0a11bc9d4f",
        sourcePath: "/Users/example/work/scratch/opencode.db",
        withheldCount: 7,
        withheldTokens: 918_402,
        reason: LONG_REASON,
        latestChildEndedAt: null,
      }),
      row({
        rootRawId: "ses_ee20d7c115",
        withheldCount: 1,
        withheldTokens: 88,
        withheldCacheTokens: 0,
        earliestChildStartedAt: null,
        latestChildEndedAt: null,
        windowPartial: true,
      }),
    ],
  },
};

/**
 * A child carried no instants, so the window bounds are a LOWER bound. The row
 * has to say so; a bare span would claim an exactness it does not have.
 */
export const PartialWindow = {
  args: {
    scans: SCANS,
    withheld: [
      row({
        withheldCount: 4,
        latestChildEndedAt: null,
        windowPartial: true,
      }),
    ],
  },
};

/**
 * The token aggregate left the JS-safe integer range, so its size is no longer
 * known. It must render as "Unavailable", never as a rounded number under a
 * label that claims an exact shortfall, and never as a zero.
 */
export const TokenTotalUnavailable = {
  args: {
    scans: SCANS,
    withheld: [
      row({ withheldTokens: null, withheldCacheTokens: null }),
      row({ rootRawId: "ses_0a11bc9d4f", withheldCount: 3 }),
    ],
  },
};

/**
 * The field is absent from the payload. This must NOT read as "none withheld":
 * that conflation is the defect this tab was built to remove.
 */
export const Unavailable = {
  args: { scans: SCANS, withheld: undefined },
};

/**
 * Nothing withheld AND no store has completed a scan. Ambiguous three ways
 * (nothing withheld, nothing imported, failed reconcile), so it must read as
 * unknown rather than borrow the complete state's reassurance.
 */
export const NotYetScanned = {
  args: { scans: [], withheld: [] },
};
