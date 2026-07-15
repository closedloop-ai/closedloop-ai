import { app, dialog, nativeTheme, protocol, session } from "electron";
import { DesktopApplication } from "./app.js";
import { handleActivateEvent } from "./app-lifecycle.js";
import { installAppContentSecurityPolicy } from "./content-security-policy.js";
import {
  handleUncaughtException,
  handleUnhandledRejection,
  showStartupCrashDialog,
} from "./error-handlers.js";
import { gatewayLog } from "./gateway-logger.js";
import {
  type GoldenModeConfig,
  resolveGoldenModeConfig,
} from "./golden-mode.js";
import {
  getMainLogFilePath,
  initializePersistentLogging,
} from "./persistent-log.js";
import { processExceptionTelemetryBridge } from "./process-exception-telemetry-bridge.js";
import { createBeforeQuitHandler } from "./shutdown-lifecycle.js";
import { migrateLegacyUserDataDirectory } from "./userdata-migration.js";

const sharedDialogDeps = {
  showDialog: (title: string, body: string) => dialog.showErrorBox(title, body),
  getLogFilePath: () => getMainLogFilePath(),
};

export function run(): void {
  app.setName("Closedloop");

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
    app.quit();
    return;
  }

  const realUserDataDir = app.getPath("userData");
  let golden: GoldenModeConfig | null;
  try {
    golden = resolveGoldenModeConfig(process.env, { realUserDataDir });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "invalid golden mode config";
    dialog.showErrorBox("Closedloop golden mode configuration error", message);
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
  initializePersistentLogging();
  app.setAboutPanelOptions({
    applicationName: golden ? "Closedloop (GOLDEN)" : "Closedloop",
    applicationVersion: app.getVersion(),
  });

  process.on("uncaughtException", (err) =>
    handleUncaughtException(err, {
      emitException: (error) =>
        processExceptionTelemetryBridge.emitProcessException(error),
      log: (msg) => gatewayLog.error("uncaught", msg),
      exit: (code) => app.exit(code),
      ...sharedDialogDeps,
    })
  );

  process.on("unhandledRejection", (reason) =>
    handleUnhandledRejection(reason, {
      emitException: (error) =>
        processExceptionTelemetryBridge.emitProcessException(error),
      log: (msg) => gatewayLog.warn("unhandled-rejection", msg),
      exit: (code) => app.exit(code),
      ...sharedDialogDeps,
    })
  );

  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);

  try {
    const desktopApplication = new DesktopApplication(
      golden ? { golden } : undefined
    );

    app.on("ready", () => {
      nativeTheme.themeSource = "system";
      installAppContentSecurityPolicy(session.defaultSession);
      void desktopApplication.boot().catch((error) => {
        const message =
          error instanceof Error ? error.message : "unknown startup error";
        gatewayLog.error("startup", `desktop boot failed: ${message}`);
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

    // FEA-3132 (E5): a second launch (blocked from booting by the
    // single-instance lock above) fires this on the primary instead. Reuse the
    // activate path to focus/re-create the existing window rather than starting
    // a competing db-host.
    app.on("second-instance", () => {
      void handleActivateEvent({
        handleActivate: () => desktopApplication.handleActivate(),
        log: (message) => gatewayLog.warn("second-instance", message),
      });
    });

    app.on(
      "before-quit",
      createBeforeQuitHandler({
        application: desktopApplication,
        exit: (code) => app.exit(code),
        logInfo: (message) => gatewayLog.info("shutdown", message),
        logError: (message) => gatewayLog.error("shutdown", message),
      })
    );

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown initialization error";
    gatewayLog.error("startup", `desktop initialization failed: ${message}`);
    showStartupCrashDialog(
      "Closedloop failed to initialize",
      message,
      sharedDialogDeps
    );
    app.exit(1);
  }
}
