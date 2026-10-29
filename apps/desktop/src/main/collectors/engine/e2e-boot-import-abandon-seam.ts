/**
 * @file e2e-boot-import-abandon-seam.ts
 * @description ISS-8982 — a TEST-ONLY seam that abandons a harness's first N
 * historical import passes with a recoverable `DbHostExitError`, so the
 * launched-app E2E can reach `RetriesExhausted` by counting instead of by
 * racing.
 *
 * `RetriesExhausted` needs `MAX_CONSECUTIVE_ABANDON_REDRIVES + 1` CONSECUTIVE
 * passes to abandon with a recoverable db-host exit. ISS-8025 induced that by
 * SIGKILLing this launch's real db-host over and over and hoping enough kills
 * landed on an in-flight write; ISS-9079 re-bounded that drive in kills rather
 * than milliseconds, but the drive stayed a wager on a landing rate ("twelve
 * kills produced three abandons … twenty-four is that rate with headroom"),
 * sized against a restart ladder whose backoff the fixture does not control. A
 * count of attempts is not a count of abandons, and the gap between them is the
 * flake: 17 `E2E Tests` runs across 8 merge groups died in it, on PRs that never
 * touched desktop.
 *
 * ISS-8025 decided against exactly this seam ("no test-only production seam, and
 * none is needed"). ISS-8982's Remedy §2 revisits that on the strength of those
 * numbers and proposes it; this file is that reversal, argued there rather than
 * here.
 *
 * WHAT IS STILL REAL, WHICH IS THE POINT. Only the *first* link is injected. The
 * error is the production class the production classifier reads
 * (`isRecoverableDbHostExitError` → `passCompleted: false`), thrown from the
 * production pass, so every link the spec exists to prove still runs for real:
 * `abandonPass`'s consecutive-abandon budget, `importOutcomeForAbandonedPass`,
 * the watcher's own re-drive loop, `abandonedPassEndsBootImport`,
 * `BootImportLifecycle.settle`, `getIngestProgress`, the runtime-status IPC,
 * preload, `useIngestProgress`, `isBootImportDegraded`, the rendered surface. A
 * seam that instead set `retriesExhausted` directly would delete that chain and
 * leave a spec that cannot fail; this one deletes only the SIGKILL. What it no
 * longer exercises is a real db-host death under an import — the replacement
 * fork, the parked ops, the restart ladder. That was the old fixture's
 * mechanism, never the contract the spec asserts, and `db-host-client.ts` owns
 * its own coverage for it.
 *
 * BUDGETED PER HARNESS, because the budget it drives is.
 * `IngestProgressTracker.consecutiveAbandons` is keyed by `collector.key`, and
 * `scanImportPass` runs once per collector, so a single shared counter would
 * scatter its injections across whichever harnesses happened to open a pass and
 * leave no key reaching the terminal. Keying the countdown the same way the
 * budget is keyed makes the drive a function of how many passes a HARNESS runs
 * and of nothing else — the same on an idle laptop and a saturated CI runner,
 * and the same whether one harness has sources or five do.
 *
 * ⚠️ GATED BEHIND THE E2E LAUNCH ENV *AND* AN UNPACKAGED BUILD, on the same two
 * dimensions as `e2e-parse-quarantine-seam.ts` and for the same reason (PR #4085
 * review): `process.env` is inherited, so an env sentinel alone would let a
 * PACKAGED client launched with the variable abandon its real first-launch
 * import. The caller passes `isPackaged` from `app.isPackaged` at the
 * main-process composition root, and both dimensions fail closed — a packaged
 * build, an absent variable, a non-numeric or out-of-range value all yield
 * `null` and the manager is handed no fault at all. Unlike that sibling the
 * accepted value is a small integer rather than one exact sentinel, because the
 * seam needs a count; the packaging gate is what keeps that out of a shipped
 * build. Nothing here crosses a process boundary — the fault is a closure on the
 * manager's options, never an env var a forked child could read — so this seam
 * needs no equivalent of that sibling's explicit worker capability.
 *
 * This is NOT an operator knob. A production launch never sets the variable, so
 * `e2eBootImportAbandonPasses` returns `null` and the option is `undefined`,
 * which is the only state `scanImportPass` can observe in a real run.
 */

import { DbHostExitError } from "../../../shared/db-host-exit-error.js";

/**
 * ISS-8982: the test-only launch env var the E2E harness sets, holding how many
 * consecutive passes to abandon per harness. Read only through
 * {@link e2eBootImportAbandonPasses}.
 */
export const E2E_BOOT_IMPORT_ABANDON_ENV =
  "CLOSEDLOOP_E2E_BOOT_IMPORT_ABANDON_PASSES";

/**
 * Ceiling on the requested pass count.
 *
 * A bound on untrusted env TEXT, not a budget anyone needs: four is what the
 * production terminal takes and three is the sub-budget case, so every value a
 * spec has a use for is well under this. It exists so a fat-fingered
 * `CLOSEDLOOP_E2E_BOOT_IMPORT_ABANDON_PASSES=40000` is refused at the gate with
 * the seam closed, rather than accepted and then silently harmless — the
 * watcher stops re-driving at `RetriesExhausted`, so injections past the
 * terminal are never consumed and a nonsense count would otherwise look exactly
 * like a correct one.
 */
export const E2E_BOOT_IMPORT_ABANDON_MAX_PASSES = 16;

/**
 * The exit code the injected error carries.
 *
 * Deliberately the ordinary one a real exit reports, so the fault travels the
 * same classification path as a genuine crash rather than a special-cased
 * value; nothing in `src/` reads `DbHostExitError.exitCode`, and
 * `isRecoverableDbHostExitError` decides on `restartScheduled` alone. What makes
 * the injected fault identifiable in `main.log` is the message suffix below,
 * which names the env var that asked for it.
 */
const INJECTED_EXIT_CODE = 0;

/**
 * A pass-opened hook that throws while the calling harness's budget lasts, and
 * does nothing once that harness has spent it.
 *
 * Takes the harness key because the budget it mirrors
 * (`IngestProgressTracker.consecutiveAbandons`) is keyed by it. Returns `void`
 * and throws rather than returning an error for the call site to throw: the call
 * site's only job is to let a test-only fault through, and a returned-error
 * shape would put a branch there that production can never take.
 */
export type E2eAbandonHistoricalPass = (collectorKey: string) => void;

/**
 * How many consecutive passes per harness the environment asks to abandon, or
 * `null` when the seam is closed.
 *
 * Fail-closed on every dimension: a packaged build, an absent or empty variable,
 * a value that is not a base-10 integer, and a value outside
 * `1..{@link E2E_BOOT_IMPORT_ABANDON_MAX_PASSES}` all return `null`. `isPackaged`
 * defaults to `true` so a caller that cannot prove the build is unpackaged never
 * arms the seam.
 *
 * The parse is deliberately strict rather than `parseInt`, which reads `"4x"` as
 * 4 and `"4.9"` as 4 — a spec that mistyped its own budget would then run
 * against a different one, and its author would read the green as evidence about
 * the number they wrote.
 */
export function e2eBootImportAbandonPasses(
  env: NodeJS.ProcessEnv = process.env,
  isPackaged = true
): number | null {
  if (isPackaged) {
    return null;
  }
  const raw = env[E2E_BOOT_IMPORT_ABANDON_ENV];
  if (raw === undefined || !STRICT_POSITIVE_INTEGER.test(raw)) {
    return null;
  }
  const passes = Number(raw);
  return passes <= E2E_BOOT_IMPORT_ABANDON_MAX_PASSES ? passes : null;
}

/**
 * A hook that throws a RECOVERABLE `DbHostExitError` for each harness's first
 * `passes` invocations, and is inert for that harness afterwards.
 *
 * `restartScheduled: true` is what makes the error recoverable to
 * `isRecoverableDbHostExitError`, and therefore what makes
 * `describeCollectorImportFailure` report `passCompleted: false` and
 * `abandonPass` count the pass against its consecutive-abandon budget. An error
 * with `restartScheduled: false` would classify as a completed pass and drive
 * nothing, which is why the flag is stated here rather than defaulted.
 *
 * Inert AFTERWARDS rather than permanent, so the app the spec asserts against is
 * a working app once the terminal has been reached: the next pass imports the
 * seeded corpus normally, exactly as it would after a real db-host crash the
 * supervisor recovered from.
 *
 * The per-harness map is bounded by the collector roster (five harnesses), not
 * by anything external, so it needs no eviction.
 */
export function createE2eBootImportAbandonFault(
  passes: number
): E2eAbandonHistoricalPass {
  const remainingByKey = new Map<string, number>();
  return (collectorKey: string) => {
    const remaining = remainingByKey.get(collectorKey) ?? passes;
    if (remaining <= 0) {
      return;
    }
    remainingByKey.set(collectorKey, remaining - 1);
    throw new DbHostExitError(
      INJECTED_EXIT_CODE,
      true,
      `db-host exited (code: ${INJECTED_EXIT_CODE}) — injected for ${collectorKey} by ${E2E_BOOT_IMPORT_ABANDON_ENV}, ${remaining - 1} injection(s) left`
    );
  };
}

/** Base-10 digits only, so `"4x"`, `"4.9"`, `" 4"`, `"-4"` and `"0"` all fail. */
const STRICT_POSITIVE_INTEGER = /^[1-9]\d*$/;
