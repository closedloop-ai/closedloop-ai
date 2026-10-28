/**
 * ISS-10004 AC1 — the desktop Diagnostics route mounts the SHARED surface when
 * `diagnostics-complete-surface` is on, and keeps its superseded composition
 * when it is off, with the same navigation either way.
 *
 * WHAT MAKES THIS NOT VACUOUS. A port's characteristic false green is a test
 * that passes identically against the old body and the new surface. So the ON
 * case asserts the heading is rendered INSIDE the surface's own root — a shell
 * still composing the page around a borrowed tab strip fails it — and the OFF
 * case asserts that root is absent, which a host that mounted the surface
 * unconditionally would fail.
 *
 * The tab strip is pinned as a LITERAL list and asserted against BOTH branches.
 * Derived from the section registry it guards, it could not fail when a section
 * is dropped or reordered by the port; transcribed from the pre-port body, it is
 * the anchor set this ticket promised to preserve.
 */
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Verbatim from the pre-port `diagnostics-view.tsx`, Labs sections included. */
const TABS_WITH_LABS_SECTIONS = [
  "Repos",
  "Backfill",
  "Links",
  "Withheld",
  "Coverage",
  "Gateway Logs",
];
const TABS_WITHOUT_LABS_SECTIONS = [
  "Repos",
  "Backfill",
  "Links",
  "Gateway Logs",
];

const enabledFlags = new Set<string>();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
}));
vi.mock("../LogsPanel", () => ({ LogsPanel: () => null }));

/**
 * Imported for real, not restated. The desktop E2E spec pins these same three
 * strings as literals because a `@repo/app/...` subpath does not resolve under
 * Playwright's ESM loader — and it names this file as what catches their drift,
 * so this file has to be the place they actually resolve.
 */
import {
  DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID,
  DIAGNOSTICS_SURFACE_V2_TEST_ID,
  DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID,
} from "@repo/app/diagnostics/components/diagnostics-surface-v2";
import { DIAGNOSTICS_COMPLETE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  IPC_WRAPPER_PHRASE,
  ipcWrappedError,
  LEAKY_IPC_CHANNEL,
} from "../../../__tests__/ipc-wrapper-error-fixture";
import { pageTitleForNav } from "../../../navigation/nav-config";
import { NavId } from "../../../navigation/route-table";
import { DiagnosticsView } from "../diagnostics-view";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installRejectingProbe(message: string): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getDiagnostics: vi.fn(() => Promise.reject(ipcWrappedError(message))),
      },
    },
  });
}

function installProbe(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getDiagnostics: vi.fn(() =>
          Promise.resolve({
            backfill: {
              artifactLinks: { lastScannedAt: null, totalScanned: 0 },
              prBackfill: { lastScannedAt: null, totalScanned: 0 },
            },
            linkStats: [],
            linkTotals: {
              linkedArtifacts: 0,
              linkedSessions: 0,
              totalLinks: 0,
            },
            repos: [],
          })
        ),
      },
    },
  });
}

afterEach(() => {
  enabledFlags.clear();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

function tabLabels(): string[] {
  return screen
    .getAllByRole("tab")
    .map((tab) => (tab.textContent ?? "").trim());
}

describe("desktop Diagnostics route — the complete-surface gate", () => {
  it("mounts DiagnosticsSurfaceV2, heading and all, when the flag is on", async () => {
    enabledFlags.add(DIAGNOSTICS_COMPLETE_SURFACE_FEATURE_FLAG_KEY);
    installProbe();

    render(<DiagnosticsView />);

    const surface = await screen.findByTestId(DIAGNOSTICS_SURFACE_V2_TEST_ID);
    expect(
      within(surface).getByRole("heading", {
        name: pageTitleForNav(NavId.Diagnostics),
      })
    ).toBeTruthy();
    expect(tabLabels()).toStrictEqual(TABS_WITHOUT_LABS_SECTIONS);
  });

  it("keeps the superseded composition when the flag is off", async () => {
    installProbe();

    render(<DiagnosticsView />);

    expect(
      await screen.findByRole("heading", {
        name: pageTitleForNav(NavId.Diagnostics),
      })
    ).toBeTruthy();
    expect(screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_TEST_ID)).toBeNull();
    expect(tabLabels()).toStrictEqual(TABS_WITHOUT_LABS_SECTIONS);
  });

  it("offers the same Labs sections on both branches", async () => {
    installProbe();
    enabledFlags.add("opencode-withheld-diagnostics");
    enabledFlags.add("activity-coverage-diagnostics");

    const legacy = render(<DiagnosticsView />);
    await screen.findByRole("tab", { name: "Repos" });
    expect(tabLabels()).toStrictEqual(TABS_WITH_LABS_SECTIONS);
    legacy.unmount();

    enabledFlags.add(DIAGNOSTICS_COMPLETE_SURFACE_FEATURE_FLAG_KEY);
    render(<DiagnosticsView />);
    await screen.findByTestId(DIAGNOSTICS_SURFACE_V2_TEST_ID);
    expect(tabLabels()).toStrictEqual(TABS_WITH_LABS_SECTIONS);
  });
});

/**
 * ISS-7599 on the surface branch. The superseded body's own guard
 * (`diagnostics-view-ipc-error.test.tsx`) cannot speak for this one: the adapter
 * is a different module, and a port that forgot `cleanIpcError` would leave that
 * suite green while showing the private channel name on the one page a reader
 * reaches BECAUSE something else is already broken.
 */
describe("desktop Diagnostics route — the Electron IPC wrapper never reaches the reader", () => {
  it("cleans a wrapped probe rejection on the surface branch", async () => {
    enabledFlags.add(DIAGNOSTICS_COMPLETE_SURFACE_FEATURE_FLAG_KEY);
    installRejectingProbe("diagnostics table missing");

    render(<DiagnosticsView />);

    const notice = await screen.findByTestId(
      DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID
    );
    expect(notice.textContent).toContain("diagnostics table missing");
    expect(notice.textContent).not.toContain(LEAKY_IPC_CHANNEL);
    expect(notice.textContent).not.toContain(IPC_WRAPPER_PHRASE);
  });
});

/**
 * The desktop E2E spec restates these three ids as literals, because Playwright's
 * loader cannot resolve a `@repo/app/...` subpath and a spec-level import failure
 * aborts the whole desktop-e2e suite. This is where that restatement is checked.
 */
describe("desktop Diagnostics route — the ids the E2E spec pins by hand", () => {
  it("still spells what the surface emits", () => {
    expect({
      malformed: DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID,
      surface: DIAGNOSTICS_SURFACE_V2_TEST_ID,
      unavailable: DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID,
    }).toStrictEqual({
      malformed: "diagnostics-surface-v2-malformed",
      surface: "diagnostics-surface-v2",
      unavailable: "diagnostics-surface-v2-unavailable",
    });
  });
});
