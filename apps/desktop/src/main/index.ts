import { app } from "electron";
import {
  type BootstrapErrorHandlerDeps,
  CRASH_DIALOG_TITLE,
  formatCrashDialogBody,
  handleBootstrapUncaughtException,
  registerBootstrapErrorHandlers,
} from "./lifecycle/error-handlers.js";
import { showNativeErrorBox } from "./lifecycle/native-error-box.js";
import { processExceptionTelemetryBridge } from "./telemetry/process-exception-telemetry-bridge.js";

// Register crash-dialog handlers BEFORE the application module graph loads.
// Static ESM module loads in startup.ts (DesktopApplication and its transitive
// deps) evaluate during the dynamic load below. If any of them throw during
// evaluation, these handlers ensure the user sees a dialog instead of a silent
// exit. Once the startup module registers its full-featured handlers
// (telemetry, spawn ENOENT suppression, log-path inclusion), these bootstrap
// versions are removed.
//
// The telemetry bridge is reached from here on purpose (ISS-6330): it must be
// live strictly earlier than the runtime whose absence defines a pre-init crash,
// so routing capture through anything that needs the OTel runtime would move the
// bootstrap problem rather than solve it. What that costs is four modules on the
// eager path — the bridge, the exception sanitizer, and the two contract modules
// they read constants from. All are pure data and regex construction: no OTel, no
// relay, no database, no I/O. Keep it that way — a comment cannot hold that
// line, so `test/bootstrap-entry-import-safety.test.ts` walks this graph
// transitively and fails when one of those surfaces becomes reachable. Every
// one of them is an ESM static load hoisted ABOVE the registration below, so
// anything added here that can throw at evaluation time exits silently, with no
// dialog and no telemetry — strictly worse than having no handler at all.

function bootstrapCrashDialog(message: string): void {
  try {
    showNativeErrorBox(CRASH_DIALOG_TITLE, formatCrashDialogBody(message));
  } catch {
    // dialog may not be available yet — fall through to exit.
  }
}

const bootstrapDeps: BootstrapErrorHandlerDeps = {
  emitException: (error) =>
    processExceptionTelemetryBridge.emitPreInitException(error),
  showDialog: bootstrapCrashDialog,
  exit: (code) => app.exit(code),
};

const bootstrapErrorHandlers = registerBootstrapErrorHandlers(
  process,
  bootstrapDeps
);

try {
  const { run } = await import("./startup.js");
  bootstrapErrorHandlers.dispose();
  run();
} catch (error: unknown) {
  handleBootstrapUncaughtException(error, bootstrapDeps);
}
