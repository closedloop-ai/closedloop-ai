import { app, dialog } from "electron";
import { CRASH_DIALOG_TITLE } from "./error-handlers.js";

// Register crash-dialog handlers BEFORE the application module graph loads.
// Static ESM imports in startup.ts (DesktopApplication and its transitive
// deps) evaluate during the dynamic import() below. If any of them throw
// during evaluation, these handlers ensure the user sees a dialog instead of
// a silent exit. Once the startup module registers its full-featured handlers
// (telemetry, spawn ENOENT suppression, log-path inclusion), these bootstrap
// versions are removed.

function bootstrapCrashDialog(message: string): void {
  try {
    dialog.showErrorBox(
      CRASH_DIALOG_TITLE,
      `An unexpected error occurred.\n\n${message}`
    );
  } catch {
    // dialog may not be available yet — fall through to exit.
  }
}

function onBootstrapUncaughtException(err: Error): void {
  bootstrapCrashDialog(err?.message ?? String(err));
  app.exit(1);
}

function onBootstrapUnhandledRejection(reason: unknown): void {
  if (!(reason instanceof Error)) {
    return;
  }
  bootstrapCrashDialog(reason.message);
  app.exit(1);
}

process.on("uncaughtException", onBootstrapUncaughtException);
process.on("unhandledRejection", onBootstrapUnhandledRejection);

try {
  const { run } = await import("./startup.js");
  process.removeListener("uncaughtException", onBootstrapUncaughtException);
  process.removeListener("unhandledRejection", onBootstrapUnhandledRejection);
  run();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  bootstrapCrashDialog(message);
  app.exit(1);
}
