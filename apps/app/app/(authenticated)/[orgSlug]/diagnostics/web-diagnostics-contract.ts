import { DiagnosticsSectionId } from "@repo/app/diagnostics/lib/diagnostics-sections";

/**
 * ISS-10006 — everything the WEB Diagnostics host decides, in one module.
 *
 * Host-owned by construction: `PRD-730` leaves transport, auth, routing, flags
 * and copy about THIS host with the shell, and every value here is a statement
 * about what a browser can reach. The surface owns the sections, their order and
 * their labels, and nothing below restates any of them.
 *
 * It is a plain `.ts` module so the route's E2E and unit tests assert against
 * the same strings the page renders, rather than a transcription of them.
 */

/** The page heading. Host-supplied because the shell names its own routes. */
export const DIAGNOSTICS_ROUTE_TITLE = "Diagnostics";

/**
 * The sentence under the heading. Desktop's names what its probe reports;
 * web has no probe, so naming those four things would be the first false
 * sentence on a page that is about to say it has none of them.
 */
export const WEB_DIAGNOSTICS_DESCRIPTION =
  "What the desktop app collects about the machine that runs your agents.";

/**
 * The route-level notice. It describes the HOST — you are on the wrong machine
 * for this — and deliberately not a failure, because nothing failed.
 */
export const WEB_PROBE_UNAVAILABLE_MESSAGE =
  "Diagnostics are collected by the desktop app on the machine that runs your agents. This browser has no record of them.";

/**
 * The per-section reason. SHORT, and deliberately not a second copy of the route
 * notice (parkerbowen review): the notice above has already named the machine,
 * and the section title already names the section, so re-explaining both two
 * boxes apart is a stutter rather than a second honest statement. "Gateway
 * store" is gone for the same reason — it is repo vocabulary, and it was the
 * only noun here a reader could not be expected to know.
 */
export const WEB_SECTION_UNSERVABLE_REASON =
  "Only the desktop app on that machine has it.";

export const WEB_GATEWAY_LOGS_TITLE = "Gateway logs stay on your machine";

/**
 * The Gateway Logs treatment: the tab exists, opening it explains where the logs
 * are, and there is nothing to press. Offering a control would mean offering a
 * local file operation — `getLogs`, `getLogFilePath`, `clearLogs`,
 * `openLogFile` are four privileged main-process calls — which is exactly what a
 * browser cannot do. The reason that belongs in the CODE stays in this comment;
 * the sentence the reader sees says only what is true for them.
 */
export const WEB_GATEWAY_LOGS_DESCRIPTION =
  "The gateway writes them to disk on the machine that runs your agents. Nothing reaches this browser.";

/**
 * The OPTIONAL sections web offers. Both of them, on purpose.
 *
 * Withheld and Coverage are the only two a host may decline, and declining them
 * removes their tabs with nothing said in their place. The 2026-09-22 ruling
 * requires explicit absence instead, so web keeps both tabs and lets the
 * surface's unservable body speak for them — the same treatment the
 * non-optional sections get, which is what stops the tab strip from encoding a
 * distinction the reader has no way to interpret.
 *
 * Gateway Logs is absent here because the surface offers that tab iff its `logs`
 * node was supplied, and reads this list for the other two only.
 */
export const WEB_DIAGNOSTICS_AVAILABLE_SECTIONS: readonly DiagnosticsSectionId[] =
  [DiagnosticsSectionId.Withheld, DiagnosticsSectionId.Coverage];

/**
 * Cohort-axis headings for the Coverage section — EMPTY on this host, and that
 * is the honest value (tamsinb review).
 *
 * `DiagnosticsSurfaceV2`'s `sectionBody` short-circuits to `UnservableSection`
 * whenever `unservableReason` is set, and this host sets it unconditionally, so
 * Coverage never reaches the point of labelling an axis. A populated map here
 * would be a THIRD hand-copy of desktop's `ACTIVITY_COVERAGE_AXIS_LABELS` — and
 * the only one nothing reconciles, because `apps/desktop/test/
 * activity-coverage-axis-labels.test.ts` holds desktop's copy against
 * `COHORT_AXIS_VALUES` in both directions precisely because `tsc` cannot (the
 * wire field is `axis: string`). Unread and drifting is worse than empty.
 *
 * The prop stays REQUIRED and is passed explicitly, per the surface's
 * every-prop-required rule: a host with genuinely nothing says so.
 */
export const WEB_COVERAGE_AXIS_LABELS: Readonly<Record<string, string>> = {};
