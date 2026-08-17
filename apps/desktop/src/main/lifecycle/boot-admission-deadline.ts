/**
 * ISS-5990: admit boot-time background work on a clock, not on a UI event.
 *
 * `DesktopWindow.whenInitiallyShown()` reads like a bounded wait — the reveal
 * gate's readiness race has a 2s fail-open — but the bound is only ARMED by
 * `InitialWindowRevealGate.requestReveal()`, whose sole callers are the
 * renderer's `desktop:renderer-ready` IPC and an explicit user/activate show. A
 * boot where the renderer never reports ready and nobody opens the window arms
 * nothing, so that promise stays pending for the life of the process: an
 * unbounded wait wearing a timeout's clothes.
 *
 * Everything admitted behind it inherited that. The agent-dashboard runtime is
 * composed only from `startAgentCapture()`, reachable at boot only through
 * `schedulePostInitialWindowBootTasks`, which awaited that promise directly — so
 * on such a boot `getSyncSource()` returned null on every 5s lane tick and the
 * locally captured corpus was stranded for that whole process, the failure
 * `main/sync/AGENTS.md` invariant 9 calls the worst one in that file. The cloud
 * socket never started either.
 *
 * This keeps the reveal as the FAST PATH (background work should still yield the
 * first-paint window when there is one) and demotes it from a requirement to a
 * race against a deadline that is armed unconditionally, at the call, by the
 * main process itself. Nothing here is derived from renderer state.
 *
 * The decision itself ({@link whenBootAdmissionAllowed}) imports no `electron`,
 * so it is directly unit-testable rather than only AST-inspectable — same
 * reasoning as `initial-window-reveal-gate.ts`.
 */

import { gatewayLog } from "../logging/gateway-logger.js";

/**
 * How long boot admission yields to the window reveal before proceeding anyway.
 *
 * Matches `INITIAL_DASHBOARD_DATA_FAIL_OPEN_MS`, the existing grace for BACKGROUND
 * work, rather than the 2s reveal/live-DB-idle bounds: nobody is staring at the
 * work this admits, and the cost of being early is contending with first paint.
 * It is deliberately well clear of a healthy reveal (renderer-ready IPC plus the
 * gate's own 2s mount bound) so the normal boot is unaffected by it.
 */
export const BOOT_ADMISSION_DEADLINE_MS = 10_000;

/** What a boot-admission wait races, and how it reports a deadline admission. */
export type BootAdmissionOptions = {
  /**
   * The window-reveal fast path, normally `DesktopWindow.whenInitiallyShown()`.
   * May never settle — that is the whole reason this helper exists — and a
   * rejection is treated as "no reveal is coming", never as a reason to strand
   * the caller.
   */
  whenWindowRevealed: () => Promise<void>;
  /** Override for the {@link BOOT_ADMISSION_DEADLINE_MS} default. */
  deadlineMs?: number;
  /**
   * Invoked only when the deadline genuinely won — not when a reveal landed on
   * the same turn as the timer. Callers log here so a headless boot is
   * diagnosable from the gateway log rather than inferred from its absence.
   */
  onDeadline?: () => void;
};

/**
 * Resolve when the initial window reveals OR the deadline expires, whichever
 * comes first.
 *
 * Never rejects: a caller that cannot be admitted is a caller whose work never
 * runs, which is the defect this closes.
 */
export function whenBootAdmissionAllowed(
  options: BootAdmissionOptions
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? BOOT_ADMISSION_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  return new Promise<void>((resolve) => {
    const settle = (viaDeadline: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Admit first, report second. `onDeadline` is caller-supplied and the type
      // accepts any callback: reporting first means a throwing one leaves
      // `settled` already true and the timer already cleared with `resolve()`
      // never reached, so the reveal arm bails on the settled guard and the
      // promise this module documents as "never rejects" stays pending for the
      // life of the process — the exact permanent strand it exists to prevent
      // (ISS-5990 review).
      resolve();
      if (viaDeadline) {
        options.onDeadline?.();
      }
    };

    timer = setTimeout(() => settle(true), deadlineMs);
    // A reveal that never comes is the expected case here, and a reveal wait
    // that throws must not be more fatal than one that hangs: both mean "no
    // reveal", and both admit. Called synchronously — deferring it by a
    // microtask would change when the caller's getter runs — with the try/catch
    // absorbing a SYNCHRONOUS throw that would otherwise escape the executor and
    // reject a promise documented never to.
    try {
      options.whenWindowRevealed().then(
        () => settle(false),
        () => settle(false)
      );
    } catch {
      settle(false);
    }
  });
}

/**
 * Run `bootWork` once boot admission lands, reporting rather than throwing.
 *
 * Owns the defer-and-report wiring so `app.ts` — on the shrink-only grandfather
 * list — stays a single call, and so the deadline can never be reintroduced as
 * a raw `whenInitiallyShown().then(...)` at the call site. Deliberately
 * fire-and-forget: boot must not block on it, and it must not reject into boot.
 */
export function scheduleAfterBootAdmission(
  whenWindowRevealed: () => Promise<void>,
  bootWork: () => Promise<void>
): void {
  whenBootAdmissionAllowed({
    whenWindowRevealed,
    onDeadline: () =>
      gatewayLog.warn(
        "startup",
        `Admitting post-window boot tasks after ${BOOT_ADMISSION_DEADLINE_MS}ms with no window reveal`
      ),
  })
    .then(bootWork)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      gatewayLog.warn(
        "startup",
        `Post-window boot task scheduling failed: ${message}`
      );
    });
}
