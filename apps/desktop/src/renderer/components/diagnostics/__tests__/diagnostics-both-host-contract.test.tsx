/**
 * ISS-10004 — the DESKTOP half of `DIAGNOSTICS_BOTH_HOST_CONTRACT`, run against
 * the shell's real mount: the flag read, the adapter, the probe over
 * `window.desktopApi`, and the surface it feeds.
 *
 * The shared fixtures and expectations live in `@repo/app`; this file supplies
 * only what is desktop's — the gate mock and the IPC stand-in.
 */
import {
  DIAGNOSTICS_BOTH_HOST_CONTRACT,
  type DiagnosticsHostFixture,
} from "@repo/app/diagnostics/__tests__/diagnostics-both-host-contract";
import {
  DESKTOP_HOST,
  runBothHostContract,
} from "@repo/app/shared/testing/both-host-render-contract";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, vi } from "vitest";
import { ipcWrappedError } from "../../../__tests__/ipc-wrapper-error-fixture";

// The gate this route is behind, forced ON. ISS-9218's bar on mocking a desktop
// Labs entry beside a shared key does not apply: there is none, and the two
// Labs keys mocked to `false` here are the SECTION gates that predate this
// ticket, not a second half of the surface's gate.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) =>
    key === "diagnostics-complete-surface",
}));

// Desktop page chrome and the host's own log reader, which this contract does
// not speak for — logs come from a source the probe never touches.
vi.mock("../../layout/page-shell", () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../LogsPanel", () => ({ LogsPanel: () => null }));

import { DiagnosticsView } from "../diagnostics-view";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

function installProbe(fixture: DiagnosticsHostFixture): void {
  const getDiagnostics =
    fixture.kind === "payload"
      ? () => Promise.resolve(fixture.payload)
      : // Wrapped the way Electron wraps a main-process throw, so the adapter's
        // `cleanIpcError` is exercised rather than bypassed.
        () => Promise.reject(ipcWrappedError(fixture.message));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { db: { getDiagnostics: vi.fn(getDiagnostics) } },
  });
}

runBothHostContract({
  contract: DIAGNOSTICS_BOTH_HOST_CONTRACT,
  host: DESKTOP_HOST,
  mount: (fixture) => {
    installProbe(fixture);
    render(<DiagnosticsView />);
  },
});
