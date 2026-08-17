import { render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { DocsAnchor } from "../docs-anchor";
import {
  DocsAnchorProvider,
  useDocsAnchor,
  useResolvedDocsAnchor,
} from "../docs-anchor-context";
import { NavId } from "../route-table";

// Mounts a screen through useDocsAnchor and records every resolved anchor it
// saw, tagged with the render index. The render-count trail is the regression
// signal: the FEA-3846 loop was caused by `publish` being recreated on every
// anchorsByNav change, which re-triggered the useDocsAnchor effect's cleanup
// (clear) + re-publish forever — an unbounded render count instead of a stable
// resolved anchor.
function Harness({
  navId,
  anchor,
  onRender,
}: Readonly<{
  navId: NavId;
  anchor: DocsAnchor | null;
  onRender: (resolved: DocsAnchor | null) => void;
}>) {
  useDocsAnchor(navId, anchor);
  const resolved = useResolvedDocsAnchor(navId);
  onRender(resolved);
  return null;
}

describe("DocsAnchorProvider / useDocsAnchor", () => {
  it("publishes a runtime anchor and resolves it for the active nav id", async () => {
    const anchor: DocsAnchor = { page: "desktop-app/overview" };
    const seen: (DocsAnchor | null)[] = [];
    render(
      <DocsAnchorProvider>
        <Harness
          anchor={anchor}
          navId={NavId.Sessions}
          onRender={(r) => seen.push(r)}
        />
      </DocsAnchorProvider>
    );
    await waitFor(() => {
      expect(seen.at(-1)).toEqual(anchor);
    });
  });

  it("settles to a stable resolved anchor without an update loop", async () => {
    // Regression: an unstable `publish` recreated on every anchorsByNav change
    // invalidated the useDocsAnchor effect, whose cleanup cleared the anchor and
    // re-published it — an endless re-render while the screen stayed mounted. A
    // looping publish never reaches a fixpoint: the resolved value oscillates
    // anchor→null→anchor and the render trail grows without bound. With the
    // stable `publish` the effect commits once and the anchor stays put.
    const anchor: DocsAnchor = {
      page: "desktop-app/gateway",
      heading: "authentication",
    };
    const seen: (DocsAnchor | null)[] = [];
    render(
      <DocsAnchorProvider>
        <Harness
          anchor={anchor}
          navId={NavId.Settings}
          onRender={(r) => seen.push(r)}
        />
      </DocsAnchorProvider>
    );
    await waitFor(() => {
      expect(seen.at(-1)).toEqual(anchor);
    });
    // The publish effect adds at most one commit past mount; a looping publish
    // would drive this far higher (and never stabilize on the anchor above).
    expect(seen.length).toBeLessThanOrEqual(3);
    // And it never oscillated back to null after resolving (the loop's tell).
    const firstResolvedIndex = seen.findIndex((a) => a !== null);
    expect(firstResolvedIndex).toBeGreaterThanOrEqual(0);
    expect(seen.slice(firstResolvedIndex).every((a) => a !== null)).toBe(true);
  });
});

/**
 * ISS-5301: resolution and withdrawal, the half the FEA-3846 loop regression
 * above does not reach. Keep-alive is what makes these load-bearing — non-active
 * screens stay mounted and publishing, so the resolver must read ONLY the active
 * nav id's entry or a hidden screen's anchor lands on another screen's "Help on
 * this" button.
 */

const BRANCHES_ANCHOR: DocsAnchor = { page: "surfaces/branches" };
const SESSIONS_ANCHOR: DocsAnchor = {
  page: "surfaces/sessions",
  heading: "filters",
};

function wrapper({ children }: { children: ReactNode }) {
  return <DocsAnchorProvider>{children}</DocsAnchorProvider>;
}

describe("useResolvedDocsAnchor — static defaults", () => {
  it("falls back to the screen's static default when nothing is published", () => {
    const { result } = renderHook(
      () => useResolvedDocsAnchor(NavId.Diagnostics),
      { wrapper }
    );

    expect(result.current).toEqual({ page: "resources/troubleshooting" });
  });

  it("resolves nothing for a screen with no static anchor", () => {
    // Branches has no dedicated docs page yet, so the affordance self-hides
    // rather than pointing at a generic page.
    const { result } = renderHook(() => useResolvedDocsAnchor(NavId.Branches), {
      wrapper,
    });

    expect(result.current).toBeNull();
  });

  it("resolves nothing when there is no active nav id", () => {
    const { result } = renderHook(() => useResolvedDocsAnchor(null), {
      wrapper,
    });

    expect(result.current).toBeNull();
  });

  it("still resolves the static map outside a provider", () => {
    const { result } = renderHook(() =>
      useResolvedDocsAnchor(NavId.Diagnostics)
    );

    expect(result.current).toEqual({ page: "resources/troubleshooting" });
  });
});

describe("useDocsAnchor — overriding and withdrawing", () => {
  it("overrides the screen's static default while mounted", () => {
    const { result } = renderHook(
      () => {
        useDocsAnchor(NavId.Diagnostics, SESSIONS_ANCHOR);
        return useResolvedDocsAnchor(NavId.Diagnostics);
      },
      { wrapper }
    );

    expect(result.current).toEqual(SESSIONS_ANCHOR);
  });

  it("publishes nothing for a null anchor, leaving the static default in force", () => {
    // Passing null adds no runtime anchor; it does not SUPPRESS the default.
    const { result } = renderHook(
      () => {
        useDocsAnchor(NavId.Diagnostics, null);
        return useResolvedDocsAnchor(NavId.Diagnostics);
      },
      { wrapper }
    );

    expect(result.current).toEqual({ page: "resources/troubleshooting" });
  });

  it("does not leak a hidden keep-alive screen's anchor onto the active screen", () => {
    const { result } = renderHook(
      () => {
        // Sessions publishes first; Branches publishes LAST so a single-slot
        // implementation would leave BRANCHES_ANCHOR as the winner.
        useDocsAnchor(NavId.Sessions, SESSIONS_ANCHOR);
        useDocsAnchor(NavId.Branches, BRANCHES_ANCHOR);
        return useResolvedDocsAnchor(NavId.Sessions);
      },
      { wrapper }
    );

    expect(result.current).toEqual(SESSIONS_ANCHOR);
  });

  it("clears its screen's entry on unmount", () => {
    // Observed through a SIBLING consumer inside the SAME provider, which
    // outlives the publisher. Mounting a fresh provider after unmount instead
    // would start from empty state and stay green with the cleanup deleted.
    function Publisher() {
      useDocsAnchor(NavId.Branches, BRANCHES_ANCHOR);
      return null;
    }
    const seen: (DocsAnchor | null)[] = [];
    function Consumer() {
      seen.push(useResolvedDocsAnchor(NavId.Branches));
      return null;
    }
    function Tree({ publishing }: { publishing: boolean }) {
      return (
        <DocsAnchorProvider>
          {publishing ? <Publisher /> : null}
          <Consumer />
        </DocsAnchorProvider>
      );
    }

    const { rerender } = render(<Tree publishing />);
    expect(seen.at(-1)).toEqual(BRANCHES_ANCHOR);

    rerender(<Tree publishing={false} />);

    // The publisher unmounted; its cleanup withdrew the entry from the provider
    // the consumer is still reading.
    expect(seen.at(-1)).toBeNull();
  });

  it("republishes when the anchor's heading actually changes", () => {
    const { result, rerender } = renderHook(
      (props: { anchor: DocsAnchor }) => {
        useDocsAnchor(NavId.Branches, props.anchor);
        return useResolvedDocsAnchor(NavId.Branches);
      },
      { wrapper, initialProps: { anchor: BRANCHES_ANCHOR } }
    );
    expect(result.current).toEqual(BRANCHES_ANCHOR);

    rerender({ anchor: { page: "surfaces/branches", heading: "prs" } });

    expect(result.current).toEqual({
      page: "surfaces/branches",
      heading: "prs",
    });
  });

  it("withdraws a published anchor when the screen switches to null", () => {
    const { result, rerender } = renderHook(
      (props: { anchor: DocsAnchor | null }) => {
        useDocsAnchor(NavId.Branches, props.anchor);
        return useResolvedDocsAnchor(NavId.Branches);
      },
      {
        wrapper,
        initialProps: { anchor: BRANCHES_ANCHOR as DocsAnchor | null },
      }
    );
    expect(result.current).toEqual(BRANCHES_ANCHOR);

    rerender({ anchor: null });

    expect(result.current).toBeNull();
  });
});
