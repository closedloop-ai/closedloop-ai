import { z } from "zod";
import {
  DASHBOARD_FLAG_SET,
  dashboardTourSeenStorageKey,
  readRawFlag,
} from "../dashboard-storage-keys";

/**
 * ISS-9728 — what this install's persisted record says about the Dashboard
 * tour, as a named value rather than as a boolean's polarity.
 *
 * ABSENCE IS NOT DISMISSAL. A fresh install, a store the reader cleared, and a
 * record some other build (or a hand edit) left unreadable all mean NO ANSWER,
 * and the answer they must not be folded into is "this reader already saw the
 * tour and dismissed it": the desktop arm acts on that once and never revisits
 * it. Folding the other way costs one extra tour; folding this way costs the
 * tour permanently, for the exact cohort the run's Create-account hand-off beat
 * was written for.
 *
 * THIS PRESERVES `readFlag`'s FOLD RATHER THAN CORRECTING IT — `readFlag`
 * already answered `false` for all three, and this module is deliberately
 * equivalent to it for this key. What it adds is that the rule is now STATED:
 * a schema at the trust boundary instead of an inline `=== "1"`, and two named
 * members at the call site instead of a bare boolean whose safe direction a
 * reader has to infer. That is worth a module here and nowhere else, because
 * ISS-9728 made this the only record governing a guest's tour — no server
 * record can arrive to correct it — and the next person to touch this read must
 * not be able to "simplify" the fold without a test going red.
 */
export const DashboardTourRecord = {
  /** No trustworthy record: never shown, cleared, or unparseable. */
  FirstRun: "first-run",
  /** This install showed the tour and the reader ended it. */
  Dismissed: "dismissed",
} as const;
export type DashboardTourRecord =
  (typeof DashboardTourRecord)[keyof typeof DashboardTourRecord];

/**
 * `localStorage` hands back whatever is on disk, so this is a trust boundary and
 * gets a schema rather than a `typeof`/`===` test: the value can be from an
 * older build, a newer one, or a reader with devtools open.
 */
const dismissalSchema = z.literal(DASHBOARD_FLAG_SET);

/**
 * Read this install's tour record.
 *
 * READ-ONLY, deliberately. A value that fails the schema is left exactly as it
 * was found — normalising it here would turn an unreadable record into a
 * confident one, and the only thing that may ever write this key is the tour
 * actually closing.
 */
export function readDashboardTourRecord(): DashboardTourRecord {
  // An absent key, a store that cannot answer, and a value that is not the
  // marker all fail the parse and land on the same member — see the type above
  // for why that direction is the safe one.
  return dismissalSchema.safeParse(readRawFlag(dashboardTourSeenStorageKey))
    .success
    ? DashboardTourRecord.Dismissed
    : DashboardTourRecord.FirstRun;
}
