/**
 * ISS-5346: why the initial desktop window became visible.
 *
 * `showInitialWindow` logs `[startup] Desktop window visible reason=...`, so
 * these values are the diagnosable record of WHICH path revealed the window on
 * any given boot — a healthy readiness-gated reveal, a bounded fail-open, or
 * (only when no readiness waiter is wired) the bare renderer-ready IPC.
 */
export const WindowRevealReason = {
  /**
   * The pre-ISS-5346 trigger: the renderer reported nonblank shell content.
   * That fires from `renderer-ready-signal.ts` BEFORE the React entry mounts,
   * so it means "index.html painted", not "the app is initialized". Retained
   * only as the no-waiter default for bare `new DesktopWindow()` constructions.
   */
  RendererReady: "renderer-ready",
  /** The React entry mounted and committed its first render. The healthy path. */
  AppMounted: "app-mounted",
  /** The mount signal never arrived; the bounded fail-open revealed the window. */
  MountFailOpen: "mount-fail-open",
  /** The mount wait itself threw. Reveal anyway — never strand the window. */
  MountWaitFailed: "mount-wait-failed",
  /**
   * A user explicitly asked for the window (tray "Open", a notification click, a
   * deep link, an onboarding prompt) before the gated reveal landed. Revealing
   * on the splash beats leaving them staring at nothing — see
   * {@link WindowShowIntent.UserRequested}.
   */
  UserRequested: "user-requested",
} as const;

export type WindowRevealReason =
  (typeof WindowRevealReason)[keyof typeof WindowRevealReason];

/**
 * Why something is asking for the window, which is what decides whether the
 * initial reveal can be taken early.
 *
 * The distinction is NOT decoration. `DesktopApplication.boot()` inits the
 * window but never shows it (`app.ts`), so on macOS the cold-launch `activate`
 * event IS the launch-time show call — treating every show request as a user
 * request would hand every macOS boot the pre-mount shell that ISS-5346 exists
 * to hide.
 */
export const WindowShowIntent = {
  /**
   * An unambiguous, user-initiated open: the tray "Open" item, a notification
   * click, a deep link, an onboarding prompt. None of these have a boot-time
   * source, so when one arrives the math flips — somebody told us they want the
   * window, and the splash ("Starting Closedloop", with a spinner) answers
   * "heard you, it's coming" where the held-back void answers nothing. Reveals
   * immediately.
   */
  UserRequested: "user-requested",
  /**
   * The macOS `activate` / `second-instance` event. Electron emits `activate` on
   * the FIRST launch as well as on a dock click, and the two are
   * indistinguishable at the event, so this path stays gated: it arms the
   * bounded wait and QUEUES its show/focus rather than revealing.
   */
  AppActivated: "app-activated",
} as const;

export type WindowShowIntent =
  (typeof WindowShowIntent)[keyof typeof WindowShowIntent];

/**
 * Sequences the one-shot initial reveal of the desktop window behind the boot
 * readiness gates (ISS-5346).
 *
 * Lives apart from `DesktopWindow` — and imports no `electron` — so the reveal
 * decision is directly unit-testable rather than only AST-inspectable.
 *
 * Two invariants this exists to hold:
 *
 * 1. **`requestReveal` never blocks its caller.** It is driven from the
 *    `desktop:renderer-ready` IPC handler, which goes on to send
 *    `desktop:db:ready`/`desktop:db:changed` — the messages that trigger the
 *    renderer's FIRST live DB read, which is what makes the readiness gates
 *    fire. Awaiting readiness inline there would deadlock the very signal being
 *    waited on, and every boot would reveal on the fail-open instead.
 * 2. **The window is always revealed.** A readiness wait that rejects still
 *    reveals, because an unrevealed window is strictly worse than an early one.
 */
export class InitialWindowRevealGate {
  private requested = false;

  /**
   * Whether the initial reveal has actually happened for this generation. Owned
   * here rather than read off the window so {@link requestShow} — the guard on
   * the macOS `activate` path — is decidable without Electron, and therefore
   * testable.
   */
  private revealed = false;

  /**
   * The in-flight readiness wait. Held rather than dropped so the deliberately
   * un-awaited chain is not a floating promise, and so `whenRevealSettled()`
   * can hand callers a handle on it.
   */
  private pendingReveal: Promise<void> = Promise.resolve();

  /**
   * Which window generation the in-flight wait belongs to. `reset()` bumps it,
   * so a continuation still parked on the PREVIOUS window's readiness wait
   * (whose bound had not yet expired when the window was disposed) finds a
   * stale generation and drops its reveal instead of exposing the REPLACEMENT
   * window ahead of that window's own readiness cycle.
   */
  private generation = 0;

  /**
   * Show/focus callbacks from explicit opens that arrived DURING the hold, run
   * once the reveal lands.
   *
   * Queued rather than dropped because {@link InitialWindowRevealGateDeps.reveal}
   * only shows the window — it does not focus it — so without this a tray or
   * notification open during boot left the caller's `show()`+`focus()` unrun for
   * the rest of that boot, and the user got an unfocused window they never got
   * to the front.
   */
  private readonly pendingShows = new Set<() => void>();

  private readonly deps: InitialWindowRevealGateDeps;

  constructor(deps: InitialWindowRevealGateDeps) {
    this.deps = deps;
  }

  /**
   * Start the (already bounded) wait for boot readiness and reveal when it
   * settles. Idempotent: repeat renderer-ready signals — `main.tsx` fires one
   * post-mount on top of the pre-mount `renderer-ready-signal.ts` one — do not
   * start a second wait.
   */
  requestReveal(): void {
    if (this.requested) {
      return;
    }

    this.requested = true;
    const generation = this.generation;
    this.pendingReveal = this.deps
      .waitForReadiness()
      .then((reason) => {
        if (generation !== this.generation) {
          return;
        }
        this.markRevealed(reason);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) {
          return;
        }
        this.deps.onReadinessError?.(
          error instanceof Error ? error.message : String(error)
        );
        this.markRevealed(WindowRevealReason.MountWaitFailed);
      });
  }

  /**
   * A show request, routed by {@link WindowShowIntent}.
   *
   * Once the window has been revealed, every intent simply runs `showNow`.
   * Before that:
   *
   * - {@link WindowShowIntent.UserRequested} reveals NOW and runs `showNow`. A
   *   user who asked for the window gets it; holding it back would answer an
   *   explicit request with nothing for up to the gate's whole bound, and they
   *   would just click again. The splash is the honest answer here.
   * - {@link WindowShowIntent.AppActivated} arms the bounded wait and queues
   *   `showNow` for the reveal. It cannot reveal early: Electron emits
   *   `activate` on the macOS cold launch too, and `boot()` never shows the
   *   window itself, so an early reveal here is the pre-ISS-5346 dead-shell
   *   reveal on every macOS boot. Queuing is what keeps the request from being
   *   dropped — the reveal path shows the window but does not focus it.
   */
  requestShow(intent: WindowShowIntent, showNow: () => void): void {
    if (this.revealed) {
      showNow();
      return;
    }

    if (intent === WindowShowIntent.UserRequested) {
      // Mark requested so a later renderer-ready does not start a second wait
      // for a window that is already on screen.
      this.requested = true;
      this.markRevealed(WindowRevealReason.UserRequested);
      showNow();
      return;
    }

    this.pendingShows.add(showNow);
    this.requestReveal();
  }

  /**
   * Resolves once the requested reveal has settled (revealed, failed open, or
   * revealed after an error). Never rejects — the chain above absorbs failures.
   */
  whenRevealSettled(): Promise<void> {
    return this.pendingReveal;
  }

  /**
   * Re-arm for a rebuilt window (`DesktopWindow.dispose`).
   *
   * Bumping the generation INVALIDATES any wait still in flight for the
   * disposed window: without it, a reveal parked on the old (bounded) wait
   * would settle later and expose the replacement window before that window's
   * own renderer had mounted — the exact early reveal this gate exists to stop.
   */
  reset(): void {
    this.requested = false;
    this.revealed = false;
    this.generation += 1;
    this.pendingReveal = Promise.resolve();
    // Drop queued show/focus callbacks with the window they were queued for:
    // they close over the DISPOSED window, and running them against the
    // replacement would show it ahead of its own readiness cycle.
    this.pendingShows.clear();
  }

  /**
   * Perform the one-shot reveal and release anything that was waiting on it.
   * Idempotent: a user-requested reveal and the readiness wait can both land,
   * and only the first one reveals or flushes.
   */
  private markRevealed(reason: WindowRevealReason): void {
    if (this.revealed) {
      return;
    }

    this.revealed = true;
    this.deps.reveal(reason);
    const shows = [...this.pendingShows];
    this.pendingShows.clear();
    for (const show of shows) {
      show();
    }
  }
}

/** The collaborators the reveal gate sequences. */
export type InitialWindowRevealGateDeps = {
  /**
   * Bounded wait for the app to be genuinely initialized, resolving to the
   * reveal reason. MUST be bounded by its implementer — this gate adds no
   * timeout of its own, so an unbounded wait here leaves the window invisible.
   */
  waitForReadiness: () => Promise<WindowRevealReason>;
  /** Reveal the window. Idempotent in `DesktopWindow.showInitialWindow`. */
  reveal: (reason: WindowRevealReason) => void;
  /** Report a readiness wait that threw, before revealing anyway. */
  onReadinessError?: (message: string) => void;
};
