import { isRendererRecentlyActive } from "../renderer-activity-window.js";
import { delay, yieldToMainLoop } from "../util/main-loop-scheduling.js";
import { WindowRevealReason } from "./initial-window-reveal-gate.js";

const RENDERER_INPUT_QUIET_WINDOW_MS = 750;
const RENDERER_BACKGROUND_SLOT_MAX_DEFER_MS = 2000;
const RENDERER_LIVE_DB_IDLE_FAIL_OPEN_MS = 2000;
const CLOUD_SOCKET_DASHBOARD_READY_FAIL_OPEN_MS = 2000;
/**
 * ISS-5346: how long the initial window reveal holds for the renderer mount.
 *
 * Matches its 2s siblings above rather than the 10s
 * `INITIAL_DASHBOARD_DATA_FAIL_OPEN_MS` on purpose. That 10s grace exists for
 * BACKGROUND work, which nobody is staring at; the reveal is the one consumer a
 * user watches. A window held invisible for 10s reads as a failed launch, which
 * is worse than the early reveal being fixed here.
 */
const INITIAL_WINDOW_REVEAL_FAIL_OPEN_MS = 2000;
// Longer than the 2s sibling fail-opens: collector start is the heaviest boot
// consumer, so the renderer's first data load gets a wider grace window before
// we conclude no local read is coming (fresh/empty DB, cloud-hydrated screens)
// and start the import anyway.
const INITIAL_DASHBOARD_DATA_FAIL_OPEN_MS = 10_000;

/**
 * The boot-time renderer readiness gates: the first-data-served, first-live-DB-
 * idle, and first-collector-import signals plus the renderer-activity quiet
 * window that background work yields to.
 *
 * Every wait here is bounded — a signal that never arrives must never wedge
 * boot work behind it (the fresh-DB deadlock: a renderer sitting on
 * cloud-hydrated screens never issues a local DB read).
 */
export class RendererReadinessGates {
  private initialDashboardDataServed = false;
  private readonly initialDashboardDataResolvers = new Set<() => void>();
  private initialRendererLiveDbIdle = false;
  private readonly initialRendererLiveDbIdleResolvers = new Set<() => void>();
  private lastRendererUserInputAtMs = 0;
  // ISS-4711: last time a trusted renderer DB IPC read was served. Distinct from
  // `lastRendererUserInputAtMs` (mouse/keyboard input) because a Sessions/Branches
  // list can auto-refresh or poll the local DB with the user's hands off the
  // keyboard — that IS active UI serving and must hold the rebuild's full pause,
  // even though it stamps no user-input event. Stamped from the design-system
  // `withDb` choke point via `notifyRendererDbRead`.
  private lastRendererDbReadAtMs = 0;
  private initialCollectorImportComplete = false;
  // ISS-5346: the renderer's React entry committed its first render. The ONLY
  // gate here that is upstream of the window reveal — see
  // `waitForInitialWindowRevealReadiness` for why the data gates cannot be.
  private initialRendererMounted = false;
  private readonly initialRendererMountedResolvers = new Set<() => void>();

  private readonly log: RendererReadinessGatesLog;

  constructor(log: RendererReadinessGatesLog) {
    this.log = log;
  }

  /** Resolves once the renderer has successfully read from live dashboard IPC. */
  whenInitialDashboardDataServed(): Promise<void> {
    if (this.initialDashboardDataServed) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.initialDashboardDataResolvers.add(resolve);
    });
  }

  notifyInitialDashboardDataServed(): void {
    if (this.initialDashboardDataServed) {
      return;
    }

    this.initialDashboardDataServed = true;
    this.log.info("startup", "Initial dashboard DB data served");
    for (const resolve of this.initialDashboardDataResolvers) {
      resolve();
    }
    this.initialDashboardDataResolvers.clear();
  }

  /**
   * Bounded variant of `whenInitialDashboardDataServed` for background-work
   * gates. The unbounded wait deadlocks on a fresh/empty local DB — nothing
   * gated behind it (collector start, dashboard background work) would ever
   * run, and the first-launch import never began until the user happened to
   * open a locally-backed view. Yield the boot window to the renderer's first
   * data load, but fail open after a bounded grace period.
   */
  waitForInitialDashboardDataServedOrTimeout(context: string): Promise<void> {
    return this.raceWithFailOpen(
      () => this.whenInitialDashboardDataServed(),
      INITIAL_DASHBOARD_DATA_FAIL_OPEN_MS,
      () => this.initialDashboardDataServed,
      () =>
        this.log.warn(
          "startup",
          `${context} continuing after ${INITIAL_DASHBOARD_DATA_FAIL_OPEN_MS}ms initial dashboard data timeout`
        )
    );
  }

  /**
   * Resolves after the renderer has received live DB data and yielded an idle
   * opportunity. Startup work that competes with first interaction waits here.
   */
  whenInitialRendererLiveDbIdle(): Promise<void> {
    if (this.initialRendererLiveDbIdle) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.initialRendererLiveDbIdleResolvers.add(resolve);
    });
  }

  notifyInitialRendererLiveDbIdle(): void {
    if (this.initialRendererLiveDbIdle) {
      return;
    }

    this.initialRendererLiveDbIdle = true;
    // First live DB idle is the first-interaction boundary: hold heavy
    // background work for the same quiet window we use after scroll/input.
    this.lastRendererUserInputAtMs = Date.now();
    this.log.info("startup", "Renderer live DB idle reached");
    for (const resolve of this.initialRendererLiveDbIdleResolvers) {
      resolve();
    }
    this.initialRendererLiveDbIdleResolvers.clear();
  }

  waitForInitialRendererLiveDbIdleOrTimeout(context: string): Promise<void> {
    return this.raceWithFailOpen(
      () => this.whenInitialRendererLiveDbIdle(),
      RENDERER_LIVE_DB_IDLE_FAIL_OPEN_MS,
      () => this.initialRendererLiveDbIdle,
      () =>
        this.log.warn(
          "startup",
          `${context} continuing after ${RENDERER_LIVE_DB_IDLE_FAIL_OPEN_MS}ms renderer live DB idle timeout`
        )
    );
  }

  async whenInitialDashboardBackgroundWorkAllowed(): Promise<void> {
    await this.waitForInitialDashboardDataServedOrTimeout(
      "initial dashboard background work"
    );
    await this.waitForInitialRendererLiveDbIdleOrTimeout(
      "initial dashboard background work"
    );
    await this.waitForRendererBackgroundSlot();
  }

  notifyRendererUserInput(): void {
    this.lastRendererUserInputAtMs = Date.now();
  }

  /**
   * ISS-4711: stamp the last trusted renderer DB IPC read. Invoked from the
   * design-system `withDb` choke point after every trusted read is served, so a
   * programmatic/polling/auto-refresh read (which fires no user-input event)
   * still marks the renderer as actively served and holds the rebuild's full
   * cooperative pause. Trust is enforced upstream in `withDb`
   * (`isTrustedSender`); this only records the timestamp.
   */
  notifyRendererDbRead(): void {
    this.lastRendererDbReadAtMs = Date.now();
  }

  /**
   * ISS-4711: synchronous "is the renderer actively being served within the
   * recent quiet window?" probe for the DATA_REVISION rebuild's adaptive write
   * pause. True when EITHER a trusted DB IPC read (`lastRendererDbReadAtMs`) OR a
   * user-input event (`lastRendererUserInputAtMs`) landed inside
   * `RENDERER_INPUT_QUIET_WINDOW_MS`. The DB-read arm is the one that matters for
   * a hands-off-keyboard auto-refreshing list reading the same DB the rebuild is
   * writing; the user-input arm keeps parity with the
   * `waitForRendererBackgroundSlot` background-slot policy.
   */
  hasRecentRendererRead(): boolean {
    return isRendererRecentlyActive(
      Date.now(),
      this.lastRendererDbReadAtMs,
      this.lastRendererUserInputAtMs,
      RENDERER_INPUT_QUIET_WINDOW_MS
    );
  }

  async waitForRendererBackgroundSlot(): Promise<void> {
    const startedAt = Date.now();
    await yieldToMainLoop();
    while (true) {
      const now = Date.now();
      const msSinceInput = now - this.lastRendererUserInputAtMs;
      const remainingQuietMs = RENDERER_INPUT_QUIET_WINDOW_MS - msSinceInput;
      if (remainingQuietMs <= 0) {
        return;
      }
      const remainingDeferralMs =
        RENDERER_BACKGROUND_SLOT_MAX_DEFER_MS - (now - startedAt);
      if (remainingDeferralMs <= 0) {
        return;
      }
      await delay(Math.min(remainingQuietMs, remainingDeferralMs));
    }
  }

  /**
   * The first collector boot import and its post-import maintenance settled.
   *
   * ISS-4717 removed the `whenInitialCollectorImportComplete()` promise that
   * used to accompany this. It was the one UNBOUNDED wait in this class, and it
   * is unwaitable-on by construction: the only thing that fires it is post-boot
   * maintenance settling for the still-active generation, so a boot import the
   * FEA-4156 watchdog gave up on, a runtime closed first, or collectors that
   * never start leave it pending for the life of the process. Its last caller
   * gated the cloud sync lanes on it. **Read the boolean below; do not
   * reintroduce a promise.** Anything that must eventually run needs a bounded
   * wait like this class's `raceWithFailOpen` siblings.
   */
  notifyInitialCollectorImportComplete(): void {
    this.initialCollectorImportComplete = true;
  }

  /** The renderer-facing "dashboard ready" signal (first collector import done). */
  isInitialCollectorImportComplete(): boolean {
    return this.initialCollectorImportComplete;
  }

  /**
   * Bounded wait for BOTH dashboard-readiness signals before the cloud socket
   * starts, so the socket's first burst does not contend with the renderer's
   * first paint. Fails open on the same never-arrives grounds as its siblings.
   */
  waitForDashboardReadinessBeforeCloudSocket(): Promise<void> {
    return this.raceWithFailOpen(
      () =>
        Promise.all([
          this.whenInitialDashboardDataServed(),
          this.whenInitialRendererLiveDbIdle(),
        ]).then(() => undefined),
      CLOUD_SOCKET_DASHBOARD_READY_FAIL_OPEN_MS,
      () => this.initialDashboardDataServed && this.initialRendererLiveDbIdle,
      () =>
        this.log.warn(
          "cloud-socket",
          `Starting cloud socket after ${CLOUD_SOCKET_DASHBOARD_READY_FAIL_OPEN_MS}ms dashboard readiness timeout`
        )
    );
  }

  /** ISS-5346: resolves once the renderer's React entry has mounted. */
  whenInitialRendererMounted(): Promise<void> {
    if (this.initialRendererMounted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.initialRendererMountedResolvers.add(resolve);
    });
  }

  /**
   * ISS-5346: the renderer's React entry committed its first render. Sent from
   * `main.tsx` as the `Mounted` phase of `desktop:renderer-ready`, distinct from
   * the pre-mount `Shell` phase that `renderer-ready-signal.ts` sends.
   */
  notifyRendererMounted(): void {
    if (this.initialRendererMounted) {
      return;
    }

    this.initialRendererMounted = true;
    this.log.info("startup", "Renderer app mounted");
    for (const resolve of this.initialRendererMountedResolvers) {
      resolve();
    }
    this.initialRendererMountedResolvers.clear();
  }

  /**
   * ISS-5346: bounded wait for the renderer to MOUNT before the initial window
   * is revealed, resolving to the reveal reason.
   *
   * The reveal used to fire on the bare `desktop:renderer-ready` IPC, which
   * `renderer-ready-signal.ts` sends BEFORE the React entry mounts — so the
   * window was exposed on a static shell that was mounted but not live.
   *
   * **Why not the two dashboard-readiness gates.** They read like the stronger
   * signal, but they are DOWNSTREAM of the reveal and gating on them is
   * circular: `initialDashboardDataServed` is produced only by
   * `onFirstDbIpcServed` on the live `withDb` wrapper, and
   * `initialRendererLiveDbIdle` only after the renderer receives
   * `desktop:db:ready` — both of which need the agent-dashboard runtime, which
   * `schedulePostInitialWindowBootTasks` creates only after
   * `whenInitiallyShown()`. Gating the reveal on them would make every first
   * boot hit the fail-open below. The mount signal has no such dependency: a
   * hidden `BrowserWindow` still loads and renders.
   *
   * Bounded on the same never-arrives grounds as its siblings: a renderer that
   * never mounts (a crashed React entry) must still get its window, or the fix
   * trades an early window for a permanently invisible one.
   */
  async waitForInitialWindowRevealReadiness(): Promise<WindowRevealReason> {
    if (this.initialRendererMounted) {
      return WindowRevealReason.AppMounted;
    }

    const result = await Promise.race([
      this.whenInitialRendererMounted().then(() => "ready" as const),
      delay(INITIAL_WINDOW_REVEAL_FAIL_OPEN_MS).then(() => "timeout" as const),
    ]);
    // Both arms can settle in the same turn; treat a mount that landed just as
    // the timer fired as a genuine gated reveal, not a fail-open.
    if (result === "ready" || this.initialRendererMounted) {
      return WindowRevealReason.AppMounted;
    }

    this.log.warn(
      "startup",
      `Revealing desktop window after ${INITIAL_WINDOW_REVEAL_FAIL_OPEN_MS}ms renderer mount timeout`
    );
    return WindowRevealReason.MountFailOpen;
  }

  /**
   * Race a renderer readiness signal against a bounded fail-open. Boot work
   * that yields to the renderer must never wait forever on a signal that may
   * not come (the fresh-DB deadlock: a renderer sitting on cloud-hydrated
   * screens never issues a local DB read): resolve when `whenReady` fires or
   * after `failOpenMs`, invoking `onTimeout` only when the signal genuinely
   * never arrived (not when it landed just as the timer fired).
   */
  private async raceWithFailOpen(
    whenReady: () => Promise<void>,
    failOpenMs: number,
    isReady: () => boolean,
    onTimeout: () => void
  ): Promise<void> {
    if (isReady()) {
      return;
    }

    const result = await Promise.race([
      whenReady().then(() => "ready" as const),
      delay(failOpenMs).then(() => "timeout" as const),
    ]);
    if (result === "timeout" && !isReady()) {
      onTimeout();
    }
  }
}

/** The main-process logger surface the gates report their fail-opens through. */
export type RendererReadinessGatesLog = {
  info: (scope: string, message: string) => void;
  warn: (scope: string, message: string) => void;
};
