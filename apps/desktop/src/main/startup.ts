import { app, nativeTheme, protocol, session } from "electron";
import { DesktopApplication } from "./app.js";
import { APP_SCHEME_PRIVILEGES } from "./app-scheme.js";
import { consumeBrowserBridgeHostToken } from "./browser-bridge-host-token.js";
import { startHarnessResultRetentionSweep } from "./cost/harness-result-retention-sweep.js";
import { handleActivateEvent } from "./lifecycle/app-lifecycle.js";
import {
  createDeepLinkListeners,
  registerDeepLinkProtocolClient,
  reportInitialDeepLink,
} from "./lifecycle/deep-link.js";
import {
  handleUncaughtException,
  handleUnhandledRejection,
  showStartupCrashDialog,
} from "./lifecycle/error-handlers.js";
import { notifyFatalExit } from "./lifecycle/fatal-exit-notice.js";
import { showNativeErrorBox } from "./lifecycle/native-error-box.js";
import { createBeforeQuitHandler } from "./lifecycle/shutdown-lifecycle.js";
import { migrateLegacyUserDataDirectory } from "./lifecycle/userdata-migration.js";
import {
  ConsoleChannel,
  gatewayLog,
  installConsoleStreamErrorGuard,
} from "./logging/gateway-logger.js";
import {
  getMainLogFilePath,
  initializePersistentLogging,
} from "./logging/persistent-log.js";
import {
  startMainContentTracing,
  startMainProfiling,
  withProfilingExit,
} from "./profiling/main-profiling-session.js";
import { installAppContentSecurityPolicy } from "./settings/content-security-policy.js";
import {
  type GoldenModeConfig,
  resolveGoldenModeConfig,
} from "./settings/golden-mode.js";
import { processExceptionTelemetryBridge } from "./telemetry/process-exception-telemetry-bridge.js";

const sharedDialogDeps = {
  showDialog: showNativeErrorBox,
  getLogFilePath: () => getMainLogFilePath(),
};

export function run(): void {
  // ISS-8412: before anything this process spawns can inherit it. The dev
  // launcher hands the browser-bridge host token over the environment rather
  // than in argv, and the environment is inherited by default — the db-host
  // utilityProcess, and every CLI the Engineer gateway later runs, would each
  // carry a copy of a credential that mints an authorized bridge host.
  consumeBrowserBridgeHostToken();
  app.setName("Closedloop");
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("class", "Closedloop");
  }
  if (process.platform === "win32") {
    app.setAppUserModelId("ai.closedloop.desktop");
  }

  // ISS-4916 (codex review): the first durable line of a launch, stamped before
  // any redirect decision is made. Every write from here until
  // initializePersistentLogging below is BUFFERED by the persistent-log module
  // rather than written, because the file transport still resolves the
  // production path — so this line, the single-instance-lock line and the
  // migration lines all land in whichever profile this launch turns out to own.
  gatewayLog.info(
    "startup",
    `Desktop launch: pid=${process.pid} platform=${process.platform}`
  );

  // FEA-3132 (E5): single-instance lock. Multiple app instances sharing one
  // userData each fork their own db-host utilityProcess against the SAME SQLite
  // file; their heaps + reader snapshots multiply memory/WAL pressure and were a
  // direct contributor to the db-host OOM (exit code 5) incident. The lock keys
  // off the userData path, which app.setName above finalizes (the legacy-dir
  // migration below does not change it), so acquire it immediately after
  // setName and BEFORE the migration, any window, or db-host is created. This
  // also gates migrateLegacyUserDataDirectory behind the lock so a genuine
  // concurrent double-launch no longer has both processes race the legacy-dir
  // renameSync. A second launch focuses the existing window (via the
  // "second-instance" handler below) and quits here.
  // FEA-2648: golden mode acquires the SAME lock (keyed on the real userData —
  // the golden redirect happens below): golden and normal launches would fight
  // over the gateway port anyway, so concurrent instances stay excluded.
  if (!app.requestSingleInstanceLock()) {
    gatewayLog.info(
      "startup",
      "another Closedloop instance holds the single-instance lock; quitting this launch"
    );
    // This launch never reaches the golden redirect, so its buffered lines
    // belong to the profile it was actually started against. Flush them there
    // rather than dropping the record of why the launch quit.
    initializeLoggingForCurrentProfile();
    app.quit();
    return;
  }

  // ISS-4430 — start the main-process CPU profiler as early as this launch is
  // known to be the one that actually boots (a second instance quits above
  // without ever profiling). No-op unless CLOSEDLOOP_PROFILE_DIR is set.
  startMainProfiling();

  const realUserDataDir = app.getPath("userData");
  let golden: GoldenModeConfig | null;
  try {
    golden = resolveGoldenModeConfig(process.env, { realUserDataDir });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "invalid golden mode config";
    showNativeErrorBox("Closedloop golden mode configuration error", message);
    // Golden mode never resolved, so there is no redirect to wait for: flush the
    // buffered launch lines into the real profile before exiting.
    initializeLoggingForCurrentProfile();
    app.exit(1);
    return;
  }

  if (golden) {
    // Redirect the profile to the validated throwaway golden dir BEFORE any
    // persistent store is constructed, and skip the legacy migration entirely —
    // the golden profile has no legacy layout to migrate.
    app.setPath("userData", golden.userDataDir);
  } else {
    try {
      migrateLegacyUserDataDirectory({
        appDataPath: app.getPath("appData"),
        userDataPath: app.getPath("userData"),
        // ISS-8955: `appData` above is NOT redirected by `--user-data-dir` while
        // `userData` is, so the migration needs the default it would otherwise
        // have resolved in order to notice it is looking at someone else's
        // profile. `app.getName()` is the same value `app.setName` set at the
        // top of `run()`, which is what Electron joins onto `appData`. Pinned by
        // `userdata-migration-wire.test.ts` — a literal here would silently
        // disable the migration for every legacy install.
        appName: app.getName(),
        log: (message) => gatewayLog.info("userdata-migration", message),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown migration error";
      gatewayLog.warn(
        "userdata-migration",
        `userData migration failed: ${message}`
      );
    }
  }
  // ISS-4916: resolve the log location AFTER the golden redirect above and the
  // legacy migration (which does not move userData), so a throwaway profile —
  // golden mode here, an Electron e2e `--user-data-dir` temp dir, any operator
  // override — keeps its log inside that profile instead of interleaving boot,
  // migration-replay, and teardown lines into the operator's production
  // main.log. A default-profile launch is left on electron-log's own default.
  initializeLoggingForCurrentProfile();
  app.setAboutPanelOptions({
    applicationName: golden ? "Closedloop (GOLDEN)" : "Closedloop",
    applicationVersion: app.getVersion(),
  });

  // ISS-5089: register BEFORE the uncaughtException handler below. Once the
  // terminal that owns stdout/stderr closes (Ctrl-C on `just desktop-dev`, or a
  // supervisor whose pipe dies first), a console write raises EPIPE on the
  // stream itself; without a durable listener Node escalates it to an uncaught
  // exception and the handler below — which logs through gatewayLog, i.e. back
  // through console — reports an expected shutdown as an application crash.
  installConsoleStreamErrorGuard([
    { channel: ConsoleChannel.Stdout, stream: process.stdout },
    { channel: ConsoleChannel.Stderr, stream: process.stderr },
  ]);

  // ISS-6328: both handlers are async because they await a time-capped
  // telemetry flush before `app.exit()`, which skips `before-quit` and so
  // drains nothing on its own. `void` because a listener's return value is
  // ignored; the process stays alive until the handler calls exit itself.
  process.on("uncaughtException", (err) => {
    void handleUncaughtException(err, {
      emitException: (error) =>
        processExceptionTelemetryBridge.emitProcessException(error),
      flushTelemetry: () => processExceptionTelemetryBridge.flushTelemetry(),
      log: (msg) => gatewayLog.error("uncaught", msg),
      exit: (code) => app.exit(code),
      // ISS-8776: `app.exit()` below skips `before-quit`, so the graceful
      // shutdown that opens the db-host intentional-teardown window never runs.
      // Tell the in-process supervisors directly, or they read this teardown's
      // own child exits as crashes and re-fork into a dying process.
      beginShutdown: notifyFatalExit,
      ...sharedDialogDeps,
    });
  });

  process.on("unhandledRejection", (reason) => {
    void handleUnhandledRejection(reason, {
      emitException: (error) =>
        processExceptionTelemetryBridge.emitProcessException(error),
      flushTelemetry: () => processExceptionTelemetryBridge.flushTelemetry(),
      log: (msg) => gatewayLog.warn("unhandled-rejection", msg),
      exit: (code) => app.exit(code),
      // ISS-8776 — see the uncaughtException handler above. This is the branch
      // the observed crash actually took: an unhandled `DbHostExitError`.
      beginShutdown: notifyFatalExit,
      ...sharedDialogDeps,
    });
  });

  // Register `app://` as a privileged scheme (fetch + CORS + stream) BEFORE app
  // `ready` so the renderer can `fetch()` prepared transcripts over it. See
  // {@link APP_SCHEME_PRIVILEGES} for why each privilege is needed (FEA-3549 /
  // FEA-3548). The response's ACAO is still scoped to the loopback dev origin in
  // window.ts, and every served path stays validated/traversal-guarded.
  protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

  // ISS-6109: claim the OS-level `closedloop://` scheme so the web app's "Launch
  // Desktop App" control can start or focus this app. Unrelated to the internal
  // `app://` scheme above, which only ever serves the packaged renderer and never
  // leaves this process. Registration must happen before `ready` and is
  // best-effort — a refusal degrades to a logged no-op, never a failed launch.
  registerDeepLinkProtocolClient({
    argv: process.argv,
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    log: (message) => gatewayLog.info("deep-link", message),
    platform: process.platform,
    setAsDefaultProtocolClient: (scheme, path, args) =>
      app.setAsDefaultProtocolClient(scheme, path, args),
  });

  // The `second-instance` listener below only ever sees a LATER launch's argv,
  // so the first instance is the one delivery path whose link nothing would
  // classify. Report it here so a cold-start refusal is visible to an operator
  // with the same reason code every other path emits.
  reportInitialDeepLink({
    argv: process.argv,
    logAccepted: (message) => gatewayLog.info("deep-link", message),
    logRefused: (message) => gatewayLog.warn("deep-link", message),
  });

  try {
    const desktopApplication = new DesktopApplication(
      golden ? { golden } : undefined
    );

    app.on("ready", () => {
      nativeTheme.themeSource = "system";
      // ISS-4430 — `contentTracing` is only available after `ready`. Opt-in via
      // CLOSEDLOOP_PROFILE_TRACE=1 on top of the profile dir; no-op otherwise.
      startMainContentTracing();
      installAppContentSecurityPolicy(session.defaultSession);
      // ISS-7332 — expiry for retained raw harness result envelopes is owned by
      // app lifetime, not by loop traffic. The store prunes on construction and
      // on each retain, both driven by a loop finishing, so a user who stops
      // running eligible loops keeps plaintext envelopes on disk past the 90-day
      // window they were promised. Started after `ready` because the store
      // resolves its directory through Electron's `app`; stopped on `will-quit`
      // so the interval never outlives the app.
      const harnessResultRetentionSweep = startHarnessResultRetentionSweep();
      app.on("will-quit", () => harnessResultRetentionSweep.stop());
      void desktopApplication.boot().catch((error) => {
        const message =
          error instanceof Error ? error.message : "unknown startup error";
        gatewayLog.error("startup", `desktop boot failed: ${message}`);
        // ISS-8776: the THIRD `app.exit()` in this file, and it skips
        // `before-quit` exactly like the two process handlers above. `boot()`
        // starts the capture stack (and with it the db-host fork) before its
        // later awaits, so a rejection here can land while the child is live —
        // reproducing the same "exited unexpectedly (code: 0)" re-fork loop.
        notifyFatalExit();
        showStartupCrashDialog(
          "Closedloop failed to start",
          message,
          sharedDialogDeps
        );
        app.exit(1);
      });
    });

    app.on("activate", () => {
      void handleActivateEvent({
        handleActivate: () => desktopApplication.handleActivate(),
        log: (message) => gatewayLog.warn("activate", message),
      });
    });

    // ISS-6109: `closedloop://` delivery. macOS routes a link through `open-url`;
    // Windows/Linux append it to the argv of the second launch that the
    // single-instance lock above already turns into a `second-instance` event
    // (FEA-3132 E5) — which is why both paths reuse the activate path and never
    // start a competing db-host. The decisions inside these listeners live in
    // deep-link.ts so they are testable without booting Electron.
    const deepLinkListeners = createDeepLinkListeners({
      activate: () => desktopApplication.handleActivate(),
      isReady: () => app.isReady(),
      logDeepLink: (message) => gatewayLog.warn("deep-link", message),
      logDeepLinkInfo: (message) => gatewayLog.info("deep-link", message),
      logSecondInstance: (message) =>
        gatewayLog.warn("second-instance", message),
    });
    app.on("open-url", deepLinkListeners.onOpenUrl);
    app.on("second-instance", deepLinkListeners.onSecondInstance);

    app.on(
      "before-quit",
      createBeforeQuitHandler({
        application: desktopApplication,
        // ISS-4430 — flush the CPU profile, content trace, and JSONL sinks
        // before the process goes away. `withProfilingExit` returns the callback
        // it was handed, UNWRAPPED, when profiling is off, so the production
        // quit path is unchanged.
        exit: withProfilingExit((code) => app.exit(code)),
        logInfo: (message) => gatewayLog.info("shutdown", message),
        logError: (message) => gatewayLog.error("shutdown", message),
      })
    );

    // The Desktop app is tray-resident on every platform. Closing its only
    // BrowserWindow releases the renderer while main-process services continue;
    // the tray's explicit Quit action still enters the before-quit path above.
    app.on("window-all-closed", () => undefined);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown initialization error";
    gatewayLog.error("startup", `desktop initialization failed: ${message}`);
    // ISS-8776: the fourth and last `app.exit()` here. Reached when
    // construction itself threw, so a db-host is unlikely to be live — the call
    // is a no-op with no hooks registered, and having every `app.exit()` in this
    // file honor one contract is what stops the next one from forgetting.
    notifyFatalExit();
    showStartupCrashDialog(
      "Closedloop failed to initialize",
      message,
      sharedDialogDeps
    );
    app.exit(1);
  }
}

/**
 * Point the durable main log at THIS launch's profile and flush everything
 * buffered since `run()` started (ISS-4916). Idempotent — the persistent-log
 * module initializes once — so the early-exit paths above can call it safely
 * even though the normal path calls it again after the golden redirect.
 */
function initializeLoggingForCurrentProfile(): void {
  initializePersistentLogging({
    userDataPath: app.getPath("userData"),
    appDataPath: app.getPath("appData"),
    appName: app.getName(),
  });
}
