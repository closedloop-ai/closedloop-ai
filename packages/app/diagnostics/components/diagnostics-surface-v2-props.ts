import type { ReactNode } from "react";
import type { ActivityCoverageAxisLabels } from "../lib/diagnostics-payload";
import type { DiagnosticsSource } from "../lib/diagnostics-source";

/**
 * The public contract of `DiagnosticsSurfaceV2` (ISS-10004).
 *
 * EVERY PROP IS REQUIRED, by design. ISS-9218 exists because an omitted optional
 * prop renders no control and looks identical to a surface that never had one.
 * With nothing optional, `tsc` fails an under-wired host, there is nothing for
 * `surface-capability-kind.ts` to classify and no `notSupported` to hide behind
 * — which is why no capability ledger accompanies this surface. A host with
 * genuinely nothing passes the explicit `null`.
 */
export type DiagnosticsSurfaceV2Props = {
  /** What this host's diagnostics probe can currently say. */
  source: DiagnosticsSource;
  /**
   * The page heading. Host-supplied because the shell's navigation names its own
   * routes; hard-coding one would put a second name on a nav destination the
   * shell already labelled.
   */
  title: string;
  /**
   * The sentence under the heading. Host-supplied for the same reason `title`
   * is, and for one more (ISS-10006): it is a claim about what THIS page shows.
   * "Gateway health, logs, backfill state and withheld data" is true where a
   * probe runs and is the first false sentence on a page that is about to say it
   * has none of them.
   */
  description: string;
  /**
   * The host's log reader and its repair commands, or null when it has none.
   *
   * A NODE deliberately: desktop's are four privileged main-process IPC calls
   * (`getLogs`, `getLogFilePath`, `clearLogs`, `openLogFile`) that read and
   * mutate local files — nothing a browser can implement, so nothing
   * `packages/app` can own. The surface keeps the part that IS navigation: the
   * section's identity, label, order and placement. `null` removes the tab.
   */
  logs: ReactNode | null;
  /** Cohort-axis headings for the Coverage section — see the type's docstring. */
  coverageAxisLabels: ActivityCoverageAxisLabels;
};
