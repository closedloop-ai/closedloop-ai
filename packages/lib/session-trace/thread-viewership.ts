/**
 * @file thread-viewership.ts
 * @description ISS-7830 — whether a person ever navigated INTO one thread, and
 * the one rule that lets that fact override a launch-time classification.
 *
 * Marisol Ashgrove ruled that headless classification for an agent-spawned thread is
 * DYNAMIC rather than a property of how it launched: a user who jumps into the
 * subagent's shell makes that session interactive, and a subagent thread nobody
 * ever opened stays headless. Launch attribution
 * ({@link isAgentDrivenLaunch} — `threadSource: "subagent"` / `promptSource:
 * "sdk"`) is the DEFAULT; viewership overrides it.
 *
 * THREE INVARIANTS a caller cannot infer from the signature, and each is a
 * decision with a reason rather than a preference:
 *
 *  1. NAVIGATION IS THE ACT, with no dwell threshold. The ruling names navigating
 *     into the thread, and any minimum dwell would be an invented number that
 *     changes which sessions a human sees labelled autonomous — a product
 *     judgment, not a mechanism. So the signal records the navigation itself.
 *  2. MONOTONIC. The fact recorded is "a user EVER viewed this thread", an
 *     existential over all time, so it cannot become false. It is also what keeps
 *     classification stable: the score is recomputed on every read and rebuild,
 *     and a retractable signal would flip a session between headless and attended
 *     with no user action in between. Enforced at the store
 *     (`session-viewership-store.ts` inserts `ON CONFLICT DO NOTHING`), so the
 *     FIRST view is the one kept — which is also what lets that store bump the
 *     session's sync watermark exactly once, rather than on every re-open.
 *  3. IT MUST SURVIVE RE-IMPORT. Classification is recomputed from persisted
 *     inputs on every `DATA_REVISION` rebuild, and the importer rewrites
 *     `sessions.metadata` wholesale from the transcript
 *     (`write-core-import-phases-session.ts`, `metadata = $6`). Viewership is not
 *     in the transcript and can never be re-derived from it, so it lives in its
 *     own session-keyed table that the import path does not touch.
 *
 * NOT a claim about attention or duration, and it must not be read as one: it
 * says the thread was opened, never that it was read.
 */

import type { HarnessLaunchAttribution } from "../harness/launch-attribution.js";
import { isAgentDrivenLaunch } from "../harness/launch-attribution.js";

/**
 * THE RULE. An agent-spawned thread nobody ever opened ran unattended; the same
 * thread, once a person navigated into it, did not.
 *
 * Scoped to the LAUNCH-ATTRIBUTION default deliberately. It does not override the
 * entrypoint rules (`isHeadlessEntrypoint`), which are evidenced against the
 * signed golden dossiers and describe how the process was started rather than who
 * spawned the thread. The ruling is about the spawn fact, and this widens nothing
 * beyond it.
 */
export function isUnattendedAgentThread(
  attribution: HarnessLaunchAttribution | undefined,
  viewedByUser: boolean
): boolean {
  return !viewedByUser && isAgentDrivenLaunch(attribution);
}
