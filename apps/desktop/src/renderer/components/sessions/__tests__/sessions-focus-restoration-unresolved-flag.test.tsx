import { rowIdOfTabStop } from "@closedloop-ai/design-system/test/grid-roving-tab-stop";
import {
  createSessionTableRowFixture,
  SESSION_FIXTURE_NOW_MS,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionsListSurfaceV2 } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import {
  rememberOpenedSessionRow,
  takeOpenedSessionRow,
} from "@repo/app/agents/components/sessions/use-sessions-focus-restoration";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9555 — the Sessions keyboard resume across the desktop shell's UNRESOLVED
 * flag window.
 *
 * Desktop is where that window is genuinely observable, which is why this case
 * lives here and not only in `@repo/app`. `DesktopFeatureFlagProvider` implements
 * BOTH halves of the port from one PostHog assignment — `useFeatureFlagEnabled`
 * from `assignment.flags[key]`, `useFeatureFlagResolved` from
 * `assignment.resolved` — so a signed-in reader whose assignment has not yet
 * arrived over the IPC bridge reports ENABLED-but-UNRESOLVED, the one state that
 * reads identically to "the flag is off" and is not it.
 *
 * The resume is read from a module store exactly once per visit. A surface that
 * consumed it against the unresolved reading would spend the reader's row before
 * the assignment landed and resume nothing for the rest of the visit — on the
 * shell whose resolution window is a real IPC round trip rather than a frame.
 *
 * The adapter here is SHAPED like the desktop one (same two members, same
 * assignment-backed answers) rather than mounting the provider itself, because
 * the provider's own input is the bridge; what is under test is the surface's
 * behaviour on those two answers.
 *
 * The desktop renderer vitest config has no global jsdom setup, so this file
 * installs what the shared GridTable's auto-layout reads on mount, the way
 * `sessions-list-flag-state-parity.test.tsx` documents: `matchMedia`, and
 * `stubContainerWidthPx`, which IS the `ResizeObserver` — it replaces the global
 * with a shim reporting a fixed width, so a second `ResizeObserver` stub
 * installed after it would report nothing and drop the surface into the card
 * layout, which paints no roving cell at all.
 */

const ENTRY_ROW = createSessionTableRowFixture({
  id: "ses-entry",
  name: "agent/entry-row",
});
const OPENED_ROW = createSessionTableRowFixture({
  id: "ses-opened",
  name: "agent/opened-row",
});

/** The desktop assignment this adapter answers from, flipped by the test. */
let assignment: { flags: Record<string, boolean>; resolved: boolean } = {
  flags: {},
  resolved: false,
};

/**
 * One adapter object for the life of the tree, as the real provider's `useMemo`
 * gives: a fresh identity per render would remount the port and hide the flip.
 */
const DESKTOP_SHAPED_ADAPTER: FeatureFlagAdapter = {
  useFeatureFlagEnabled: (key) => assignment.flags[key] === true,
  useFeatureFlagResolved: () => assignment.resolved,
};

let restoreContainerWidth: (() => void) | null = null;
let restoreMatchMedia: (() => void) | undefined;

function sessionsTree() {
  // A FRESH element each call: React bails out of re-rendering a subtree handed
  // the identical element object, which would hide the resolution flip.
  return (
    <FeatureFlagAdapterProvider adapter={DESKTOP_SHAPED_ADAPTER}>
      <SessionsListSurfaceV2
        hasConnectedAgent
        rows={[ENTRY_ROW, OPENED_ROW]}
        usage={undefined}
      />
    </FeatureFlagAdapterProvider>
  );
}

beforeEach(() => {
  // Module state: a case that primed the remembered row would otherwise decide
  // the next one's result.
  takeOpenedSessionRow();
  assignment = { flags: {}, resolved: false };
  restoreMatchMedia = installMatchMedia();
  restoreContainerWidth = stubContainerWidthPx(1440);
  // The fixture rows are dated relative to this instant, and the surface's
  // default date window would otherwise filter every one of them out — leaving
  // an empty state with no grid, and no roving cell for the resume to land on.
  // `Date` only: the flag deadline and the coarse-now tick keep real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SESSION_FIXTURE_NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
  restoreMatchMedia?.();
});

describe("desktop Sessions focus resume across the unresolved flag window", () => {
  it("resumes the opened row once the desktop assignment arrives", () => {
    rememberOpenedSessionRow(OPENED_ROW.id);
    assignment = {
      flags: { [SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY]: true },
      resolved: false,
    };

    const { rerender } = render(sessionsTree());

    // ENABLED, but the assignment has not arrived. The tab stop must stay on the
    // entry cell here — and, more importantly, the remembered row must still be
    // in the store when it does arrive.
    expect(rowIdOfTabStop()).toBe(ENTRY_ROW.id);

    assignment = { ...assignment, resolved: true };
    rerender(sessionsTree());

    expect(rowIdOfTabStop()).toBe(OPENED_ROW.id);
  });
});

/**
 * The shared GridTable's auto-layout reads this on mount and the desktop
 * renderer config installs none. Restored by descriptor, so a run that starts
 * without it does not leave it behind for the next file.
 */
function installMatchMedia(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "matchMedia"
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(window, "matchMedia");
      return;
    }
    Object.defineProperty(window, "matchMedia", originalDescriptor);
  };
}
