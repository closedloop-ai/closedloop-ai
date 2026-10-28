/**
 * ISS-9223 — the pinned identity column, proven on the DESKTOP renderer.
 *
 * The web half is
 * `packages/app/agents/components/sessions/__tests__/sessions-pinned-lead-column.test.tsx`.
 * What only this file can settle is AC3: that the SAME shared surface, mounted
 * on this shell, reaches the same pinned DOM. This ticket family exists because
 * a capability was passed by one consumer and not another, and a shared
 * component newly hosted on a second shell also breaks on providers the first
 * shell happened to supply — a test that stubbed the surface would prove
 * neither.
 *
 * The pin is set ONCE, inside `SessionsListGridV2`, so no host passes it and
 * no host can forget it. What differs between the shells is the SHAPE: the web
 * host supplies `favorites` (a leading utility track ahead of the identity
 * cell), the desktop view supplies none — so this file drives the no-utility
 * shape and the web file drives both.
 *
 * ISS-9659 retired the `sessions-pinned-lead-column` gate ENABLED, which is a
 * DELIBERATE behaviour change on this shell: the desktop read resolved closed
 * with no PostHog provider, so desktop shipped unpinned while web shipped
 * pinned. Both surfaces now pin, which is the parity the single read was always
 * for, and the flag-off case this file used to assert is gone with its gate.
 *
 * The desktop renderer vitest config has no global jsdom setup, so this file
 * installs the `matchMedia` + `ResizeObserver` shims the shared GridTable
 * auto-layout reads, exactly as `sessions-list-flag-state-parity.test.tsx` does.
 *
 * What this file CANNOT settle: jsdom neither lays out nor applies a stylesheet, so the sticky
 * classes asserted below have no observable effect here. A class that resolved
 * to nothing, or a desktop shell whose scroll host stopped clipping, keeps every
 * assertion in this file green. The shared-only Electron duplicate was removed
 * in ISS-10527; no native-layout coverage is claimed here.
 */

import { createSessionTableRowFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionsListSurfaceV2 } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROW_NAME = "agent/desktop-pinned";
const ROW = createSessionTableRowFixture({ id: "ses-1", name: ROW_NAME });

// Written out rather than imported from `grid-table-pin.ts`: importing them
// would make this test agree with whatever that module currently says.
const STICKY_CLASS = "sticky";
const LEFT_EDGE_CLASS = "left-0";
const WHITESPACE_PATTERN = /\s+/;
const OPAQUE_SURFACE_CLASS = "bg-[var(--grid-table-surface,var(--background))]";

let restoreContainerWidth: (() => void) | null = null;
let restoreResizeObserver: (() => void) | undefined;
let restoreMatchMedia: (() => void) | undefined;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
  restoreMatchMedia = installMatchMedia();
});

afterEach(() => {
  cleanup();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
  restoreResizeObserver?.();
  restoreMatchMedia?.();
});

describe("Desktop Sessions pinned lead column (ISS-9223)", () => {
  // Rendered with NO flag enabled, which is the assertion ISS-9659 needs: the
  // pin is the shipped desktop rendering rather than something a PostHog
  // assignment this shell never receives could still withhold.
  it("pins the identity cell with no flag enabled", () => {
    renderDesktopSessions();

    const classes = leadCellClasses();
    expect(classes).toContain(STICKY_CLASS);
    expect(classes).toContain(LEFT_EDGE_CLASS);
    expect(classes).toContain(OPAQUE_SURFACE_CLASS);
  });

  // The neighbour that stops the case above passing on a grid that pins every
  // cell — which holds the whole row still under a scroll and pins nothing.
  it("leaves a data cell out of the pinned region", () => {
    renderDesktopSessions();

    const classes = cellClassesFor(dataCell());
    expect(classes).not.toContain(STICKY_CLASS);
    expect(classes).not.toContain(LEFT_EDGE_CLASS);
  });
});

function renderDesktopSessions(): void {
  restoreContainerWidth = stubContainerWidthPx(1440);
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      <SessionsListSurfaceV2
        hasConnectedAgent
        // The fixture row carries no recent activity, and the default window
        // would filter it out before any cell existed to assert on.
        initialDateRange="all"
        mode="expanded"
        rows={[ROW]}
        usage={undefined}
      />
    </FeatureFlagAdapterProvider>
  );
}

/**
 * The identity cell's classes as exact tokens. The desktop renderer config
 * installs no `jest-dom`, so the token split stands in for `toHaveClass` — and
 * it is stricter, since a substring match would let `left-0.5` satisfy `left-0`.
 */
function leadCellClasses(): readonly string[] {
  return cellClassesFor(leadBodyCell());
}

function cellClassesFor(cell: HTMLElement): readonly string[] {
  return cell.className.split(WHITESPACE_PATTERN);
}

/**
 * The LAST cell of the row the identity cell belongs to — the end of the
 * horizontal scroll, and the cell furthest from anything the pin should reach.
 */
function dataCell(): HTMLElement {
  const row = leadBodyCell().closest('[role="row"]');
  if (!(row instanceof HTMLElement)) {
    throw new Error("session name is not inside a table row");
  }
  const cells = row.querySelectorAll<HTMLElement>(
    '[role="cell"], [role="gridcell"]'
  );
  const last = cells.item(cells.length - 1);
  if (!last || last === leadBodyCell()) {
    throw new Error("the row renders no cell beyond its identity cell");
  }
  return last;
}

/** The row's identity cell, found through the session name it renders. */
function leadBodyCell(): HTMLElement {
  const cell = screen
    .getByText(ROW_NAME)
    .closest('[role="cell"], [role="gridcell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error("session name is not inside a table cell");
  }
  return cell;
}

/**
 * The two browser APIs the shared GridTable's auto-layout reads on mount and
 * the desktop renderer config installs neither of. Restored by descriptor, so a
 * run that starts without them does not leave them behind for the next file.
 */
function installResizeObserver(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    },
  });
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
      return;
    }
    Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
  };
}

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
