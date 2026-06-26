import { app, nativeTheme, protocol } from "electron";
import { DesktopApplication } from "./app.js";
import { handleActivateEvent } from "./app-lifecycle.js";
import {
  handleUncaughtException,
  handleUnhandledRejection,
} from "./error-handlers.js";
import { gatewayLog } from "./gateway-logger.js";
import { initializePersistentLogging } from "./persistent-log.js";
import { processExceptionTelemetryBridge } from "./process-exception-telemetry-bridge.js";
import { createBeforeQuitHandler } from "./shutdown-lifecycle.js";
import { migrateLegacyUserDataDirectory } from "./userdata-migration.js";

app.setName("Closedloop");
// Brand rename (FEA-2101): `setName("Closedloop")` moves Electron's userData
// directory from `<appData>/ClosedLoop` to `<appData>/Closedloop`. Migrate any
// pre-rename data dir BEFORE the first store or log file is opened so existing
// installs keep their persisted state. Best-effort: a failure here must not stop
// the app from booting (a fresh data dir is recoverable; a crash loop is not).
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
initializePersistentLogging();
app.setAboutPanelOptions({
  applicationName: "Closedloop",
  applicationVersion: app.getVersion(),
});

process.on("uncaughtException", (err) =>
  handleUncaughtException(err, {
    emitException: (error) =>
      processExceptionTelemetryBridge.emitProcessException(error),
    log: (msg) => gatewayLog.error("uncaught", msg),
    exit: (code) => app.exit(code),
  })
);

process.on("unhandledRejection", (reason) =>
  handleUnhandledRejection(reason, {
    emitException: (error) =>
      processExceptionTelemetryBridge.emitProcessException(error),
    log: (msg) => gatewayLog.warn("unhandled-rejection", msg),
    exit: (code) => app.exit(code),
  })
);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const desktopApplication = new DesktopApplication();

app.on("ready", () => {
  nativeTheme.themeSource = "system";
  void desktopApplication.boot().catch((error) => {
    const message =
      error instanceof Error ? error.message : "unknown startup error";
    gatewayLog.error("startup", `desktop boot failed: ${message}`);
    app.exit(1);
  });
});

app.on("activate", () => {
  void handleActivateEvent({
    handleActivate: () => desktopApplication.handleActivate(),
    log: (message) => gatewayLog.warn("activate", message),
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
