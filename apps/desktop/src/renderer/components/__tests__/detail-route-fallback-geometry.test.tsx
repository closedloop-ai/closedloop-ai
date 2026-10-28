import { SessionDetailLoading } from "@repo/app/agents/components/detail/agent-session-detail-states";
import { AgentDetailLoading } from "@repo/app/agents/components/workspace/agent-detail-states";
import { SESSION_DETAIL_LOADING_LABEL } from "@repo/app/agents/lib/session-detail-slots";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDetailRouteFallback,
  DETAIL_FALLBACK_LABELS,
  DetailRouteFallback,
} from "../route-fallbacks";

/**
 * ISS-4838 (codex review on PR #4266): the detail Suspense fallbacks must
 * reserve the geometry of the loading state that REPLACES them.
 *
 * The whole promise of this feature is that the lazy chunk resolving is a no-op
 * on screen — skeleton → skeleton → content, never a visible snap. That only
 * holds if the fallback's shell inset/width and its skeleton slab match the real
 * in-page loading treatment. The session/branch detail and the agent/component
 * detail have DIFFERENT shapes (full-width `p-4 sm:p-6` + a fixed 520px slab
 * versus a centered `max-w-5xl` column with `px-6 pt-10` and a `70vh` slab), so
 * one shared fallback made the component route snap inward and change height at
 * the exact moment it was supposed to stay still.
 *
 * The fallbacks duplicate that geometry rather than importing it (they must be
 * static imports, available before the lazy chunk starts loading — importing the
 * detail slice would pull it into the eager bundle and defeat the code split).
 * These tests are what stops the duplicate drifting: they render the REAL
 * loading component beside the fallback and require the fallback to carry every
 * geometry class the real one uses. Restyle the real loading state and this
 * fails until the fallback follows.
 */

/**
 * Layout classes that actually move things on screen. Colors, radii, and
 * animation are the `Skeleton` primitive's own business and are deliberately not
 * compared — a fallback and a loading state may differ there without reflowing.
 */
const GEOMETRY_CLASS_PATTERN =
  /^(mx-auto|flex|w-full|max-w-\w+|flex-col|p[xytblr]?-\d+|sm:p-\d+|h-\[[^\]]+\]|min-h-\w+|min-h-0|flex-1|overflow-\w+)$/;
const CLASS_SEPARATOR_PATTERN = /\s+/;

afterEach(cleanup);

describe("detail route fallback geometry (ISS-4838)", () => {
  it("reserves the agent/component detail's centered column, not the full-width session shape", () => {
    const real = render(<AgentDetailLoading />);
    const realGeometry = geometryOf(real.container);
    real.unmount();

    render(<AgentDetailRouteFallback label="Loading component" />);
    const fallbackGeometry = geometryOf(
      screen.getByTestId("detail-route-fallback")
    );

    // Every geometry class the real loading state uses is present in the
    // fallback, so the swap cannot snap inward or change height.
    for (const className of realGeometry) {
      expect(fallbackGeometry).toContain(className);
    }
    // The distinguishing ones, named explicitly so a regression reads clearly
    // rather than as an opaque set diff.
    expect(fallbackGeometry).toContain("max-w-5xl");
    expect(fallbackGeometry).toContain("h-[70vh]");
    // …and it is NOT wearing the session/branch shape it used to.
    expect(fallbackGeometry).not.toContain("h-[520px]");
  });

  it("reserves the session/branch detail's full-width shape", () => {
    const real = render(<SessionDetailLoading />);
    const realGeometry = geometryOf(real.container);
    real.unmount();

    render(<DetailRouteFallback label={DETAIL_FALLBACK_LABELS.session} />);
    const fallbackGeometry = geometryOf(
      screen.getByTestId("detail-route-fallback")
    );

    for (const className of realGeometry) {
      expect(fallbackGeometry).toContain(className);
    }
    expect(fallbackGeometry).toContain("h-[520px]");
    expect(fallbackGeometry).not.toContain("max-w-5xl");
  });

  /**
   * ISS-5662: the fallback and the view that replaces it must announce ONE name.
   *
   * The geometry assertions above compare classes and never the accessible
   * name, so a rename on either side of the handoff — the fallback saying
   * "Loading session" while the view that replaces it says something else, or
   * nothing, the ISS-5593 gap — stayed green. Both sides now resolve the name
   * from `SESSION_DETAIL_LOADING_LABEL`; this is what makes reintroducing a
   * second copy fail rather than drift.
   */
  it("announces the same accessible name as the session loading state that replaces it", () => {
    const real = render(<SessionDetailLoading />);
    const viewName = screen.getByRole("status").getAttribute("aria-label");
    real.unmount();

    render(<DetailRouteFallback label={DETAIL_FALLBACK_LABELS.session} />);
    const fallbackName = screen.getByRole("status").getAttribute("aria-label");

    expect(fallbackName).toBe(viewName);
    // Pinned to the canonical constant, so two SILENT states cannot satisfy the
    // equality above.
    expect(viewName).toBe(SESSION_DETAIL_LOADING_LABEL);
  });

  it("names what is loading on a polite live region rather than as visible text", () => {
    render(<AgentDetailRouteFallback label="Loading component" />);

    // Same rule the session/branch fallback follows: the label is the
    // accessible name, never visible copy that would reflow when it vanished.
    const status = screen.getByRole("status", { name: "Loading component" });
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
  });
});

/** Every geometry-bearing class on an element subtree, deduped. */
function geometryOf(root: HTMLElement): string[] {
  const classes = new Set<string>();
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const element of elements) {
    const classAttribute = element.getAttribute("class") ?? "";
    for (const className of classAttribute.split(CLASS_SEPARATOR_PATTERN)) {
      if (GEOMETRY_CLASS_PATTERN.test(className)) {
        classes.add(className);
      }
    }
  }
  return Array.from(classes);
}
