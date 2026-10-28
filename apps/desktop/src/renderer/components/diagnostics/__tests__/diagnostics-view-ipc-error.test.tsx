/**
 * ISS-7599: the diagnostics load catch renders the caught message. ISS-10004
 * moved this body behind the `diagnostics-complete-surface` gate without
 * changing it; `diagnostics-both-host-contract.test.tsx` asserts the same
 * contract on the surface branch. Its read
 * crosses `ipcRenderer.invoke`, so an untreated catch shows the user the
 * private `getDiagnostics` channel name on the one screen they were sent to
 * because something else was already broken.
 *
 * The tabs and the page shell are mocked to markers — this asserts the view's
 * failure-message contract, not the diagnostics tab render graph.
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IPC_WRAPPER_PHRASE,
  ipcWrappedError,
  LEAKY_IPC_CHANNEL,
} from "../../../__tests__/ipc-wrapper-error-fixture";

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("../../layout/page-shell", () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@repo/app/diagnostics/components/backfill-section", () => ({
  BackfillSection: () => null,
}));
vi.mock("@repo/app/diagnostics/components/coverage-section", () => ({
  CoverageSection: () => null,
}));
vi.mock("@repo/app/diagnostics/components/links-section", () => ({
  LinksSection: () => null,
}));
vi.mock("@repo/app/diagnostics/components/repos-section", () => ({
  ReposSection: () => null,
}));
vi.mock("@repo/app/diagnostics/components/withheld-section", () => ({
  WithheldSection: () => null,
}));
vi.mock("../LogsPanel", () => ({ LogsPanel: () => null }));

import { DiagnosticsLegacyBody } from "../diagnostics-legacy-body";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installDiagnosticsApi(getDiagnostics: () => Promise<unknown>): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { db: { getDiagnostics: vi.fn(getDiagnostics) } },
  });
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.restoreAllMocks();
});

describe("DiagnosticsLegacyBody — Electron IPC wrapper never reaches the user", () => {
  it("cleans a wrapped getDiagnostics rejection", async () => {
    installDiagnosticsApi(() =>
      Promise.reject(ipcWrappedError("diagnostics table missing"))
    );

    render(<DiagnosticsLegacyBody />);

    const message = await screen.findByText("diagnostics table missing");
    expect(message.textContent).not.toContain(LEAKY_IPC_CHANNEL);
    expect(message.textContent).not.toContain(IPC_WRAPPER_PHRASE);
    expect(screen.queryByText(new RegExp(LEAKY_IPC_CHANNEL))).toBeNull();
  });

  it("still reports the generic message when the rejection is not an Error", async () => {
    installDiagnosticsApi(() => Promise.reject("nope"));

    render(<DiagnosticsLegacyBody />);

    expect(await screen.findByText("Failed to load diagnostics")).toBeTruthy();
  });
});
