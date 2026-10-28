import { vi } from "vitest";
import type { DesktopUpdateLifecycleReporter } from "../../src/main/update/update-lifecycle-telemetry.js";

/**
 * Every lifecycle reporter arm, so a call to an unexpected one is visible.
 *
 * Shared because two suites drive production code that holds a
 * {@link DesktopUpdateLifecycleReporter} — the update IPC handlers and the
 * auto-update wiring — and a second hand-written copy is how one of them ends up
 * missing an arm that was added to the type.
 */
export function createUpdateTelemetryDouble() {
  return {
    checked: vi.fn(),
    checkFailed: vi.fn(),
    available: vi.fn(),
    downloadStarted: vi.fn(),
    downloadSucceeded: vi.fn(),
    downloadFailed: vi.fn(),
    installBlocked: vi.fn(),
    installStarted: vi.fn(),
    restartInitiated: vi.fn(),
    onBoot: vi.fn(),
    flushPendingTerminalRecord: vi.fn(),
  } satisfies DesktopUpdateLifecycleReporter;
}
