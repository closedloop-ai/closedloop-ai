/**
 * @description ISS-6207 — the boot-import terminal state reported on
 * `IngestProgress`: the pure predicates over it, and the ISS-4779
 * closed-by-default Labs gate that decides whether its DEGRADED half is
 * surfaced at all.
 *
 * Deliberately a sibling of `use-ingest-progress.ts` rather than an export on
 * it. That module is the renderer's shared runtime-status POLL, and a dozen
 * component suites replace it with an exhaustive `vi.mock` factory that lists
 * only the hooks they need. A pure predicate exported from there is therefore
 * absent from every one of those mocks, and the first component to import it
 * takes the whole shell down at module load. Only the TYPE is imported here, and
 * type imports are erased, so this module has no runtime dependency on the
 * mocked one.
 */
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DESKTOP_BOOT_IMPORT_DEGRADED_TERMINAL_FEATURE_FLAG_KEY } from "../../shared/feature-flags-labs-surfaces";
import type { IngestProgress } from "./use-ingest-progress";

/**
 * Has the boot import reached a DEGRADED terminal — it stopped, and it did not
 * finish? Two distinct ways to get there, reported separately by the main
 * process because they are different claims (`timedOut`: the bound elapsed on an
 * import still running; `retriesExhausted`: it settled with source files left
 * behind after their automatic re-drive budget was spent). They are folded only
 * here, for the one question they answer identically: the boot import will not
 * advance further on its own, so a surface waiting on it must resolve into its
 * graceful partial-import state instead of claiming work is still in flight.
 *
 * `complete` is deliberately NOT folded in — a finished import is not degraded.
 */
export function isBootImportDegraded(ingest: IngestProgress): boolean {
  return ingest.timedOut === true || ingest.retriesExhausted === true;
}

/**
 * ISS-6207 (ISS-4779 closed-by-default) — is the Labs gate over the SECOND
 * degraded terminal open? Resolved with the OPTIONAL adapter hook, which yields
 * `false` rather than throwing when no `FeatureFlagAdapterProvider` is mounted
 * (Storybook, a bare component subtree in a unit test). For a closed-by-default
 * gate that is the correct degradation: no provider means the feature is off,
 * never that it leaks on.
 */
export function useBootImportDegradedTerminalEnabled(): boolean {
  return useFeatureFlagEnabledOptional(
    DESKTOP_BOOT_IMPORT_DEGRADED_TERMINAL_FEATURE_FLAG_KEY
  );
}

/**
 * ISS-6207 (ISS-4779 closed-by-default) — has the boot import given up, for a
 * surface that RENDERS NEW COPY about it? Only the first-launch splash's give-up
 * decision reads this; everything else reads {@link isBootImportDegraded}
 * directly.
 *
 * The gate deliberately stops at copy. An earlier revision applied it at the
 * renderer's ingest projection, dropping `retriesExhausted` from the snapshot
 * itself, on the theory that this reproduced "the shape an older main process
 * sends". It does not: this ticket's main-process half is UNCONDITIONAL, so an
 * older main process sent `complete: true` in this scenario while the new one
 * sends `complete: false` plus the degraded terminal. Deleting the field left a
 * stopped import that reads as still running — a shape no producer emits — and
 * `useSessionsImportProgress`, whose 1s poll latches off on `isImportSettled`
 * and is on every Sessions render, then never terminated. Gating a FACT the
 * producer states is how the closed default acquired its own false-completeness
 * bug; gating the SENTENCE the user reads does not.
 */
export function isBootImportGiveUpVisible(
  ingest: IngestProgress | null,
  degradedTerminalEnabled: boolean
): boolean {
  if (ingest === null) {
    return false;
  }
  // FEA-4156's `timedOut` is NOT gated: it shipped long before this flag, and
  // the splash has surfaced its partial-import state on it ever since. Only the
  // terminal this ticket ADDS is new UI, so only it answers to the gate.
  if (ingest.timedOut === true) {
    return true;
  }
  return degradedTerminalEnabled && ingest.retriesExhausted === true;
}

/**
 * ISS-6207 — the Sessions/Dashboard READ GATE's terminal question: has the boot
 * import stopped, by any of its three terminals? UNGATED, for the same reason
 * {@link isBootImportGiveUpVisible}'s docstring gives above.
 *
 * An earlier revision took the flag and, closed, returned `ingest.complete`
 * alone — the pre-ticket predicate. That reads like a faithful restoration and
 * is not one, because the value it reads changed underneath it: this ticket's
 * main-process half is unconditional, so where an older main process sent
 * `complete: true` on a retry-exhausted boot import, the new one sends
 * `complete: false` plus `retriesExhausted`. `complete` alone therefore never
 * goes true in that launch, `useSessionsReadGate`'s heal arm never latches, and
 * the Sessions page-data query stays disabled for the rest of the session — a
 * regression the closed default INTRODUCED rather than avoided (whitlockk).
 *
 * Restoring behaviour under a closed gate means restoring the ANSWER, not
 * copying the old expression. Folding both degraded terminals is what keeps the
 * gate answering as it did; it renders no new copy, so ISS-4779 does not reach
 * it.
 */
export function isBootImportSettled(ingest: IngestProgress | null): boolean {
  if (ingest === null) {
    return false;
  }
  return ingest.complete || isBootImportDegraded(ingest);
}
