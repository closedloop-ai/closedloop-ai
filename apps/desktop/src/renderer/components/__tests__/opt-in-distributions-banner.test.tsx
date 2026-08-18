/**
 * @file opt-in-distributions-banner.test.tsx
 * @description Unit tests for the desktop OptInDistributionsBanner
 * (FEA-2923 / §I; app-level mounting + row shape FEA-4007).
 *
 * Proves the renderer actually subscribes to the main-process
 * `onDistributionsOptInAvailable` push and that "Accept & install" routes
 * through the vetted `catalogInstall` / `coachingInstall` IPC — these tests
 * FAIL if the event is emitted into the void (no subscriber) or if accept is
 * inert. Also covers the app-level presentation the FEA-4007 review required:
 * one sibling-shaped `role="status"` row per distribution carrying its
 * provenance + kind, an actionable (not raw) install-failure message, and a
 * bounded number of visible rows so a multi-pack org push cannot stack an
 * unbounded wall of bars at boot.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  DistributionMode,
  type OptInDistributionDto,
} from "@repo/api/src/types/distribution";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptInDistributionsBanner } from "../opt-in-distributions-banner";

function makeDistribution(
  over: Partial<OptInDistributionDto> = {}
): OptInDistributionDto {
  return {
    id: "dist-1",
    mode: DistributionMode.OptIn,
    catalogItem: {
      id: "cat-1",
      name: "RTK",
      targetKind: AgentComponentKind.Plugin,
    },
    ...over,
  };
}

type Listener = (distributions: OptInDistributionDto[]) => void;

function installDesktopApi(
  over: {
    catalogInstall?: ReturnType<typeof vi.fn>;
    coachingInstall?: ReturnType<typeof vi.fn>;
    declineDistribution?: ReturnType<typeof vi.fn>;
    ensureDistributionAssigned?: ReturnType<typeof vi.fn>;
  } = {}
): {
  emit: (distributions: OptInDistributionDto[]) => void;
  catalogInstall: ReturnType<typeof vi.fn>;
  coachingInstall: ReturnType<typeof vi.fn>;
  declineDistribution: ReturnType<typeof vi.fn>;
  ensureDistributionAssigned: ReturnType<typeof vi.fn>;
  onDistributionsOptInAvailable: ReturnType<typeof vi.fn>;
} {
  let listener: Listener | null = null;
  const onDistributionsOptInAvailable = vi.fn((cb: Listener) => {
    listener = cb;
    return () => {
      listener = null;
    };
  });
  const catalogInstall =
    over.catalogInstall ?? vi.fn().mockResolvedValue({ started: true });
  const coachingInstall =
    over.coachingInstall ?? vi.fn().mockResolvedValue({ status: "installed" });
  const declineDistribution =
    over.declineDistribution ?? vi.fn().mockResolvedValue(undefined);
  // ISS-5123: the generic accept path asks the cloud whether the offer still
  // stands before installing. Default it to "still assigned" so existing cases
  // exercise the happy path; the withdrawal cases override it with a rejection.
  const ensureDistributionAssigned =
    over.ensureDistributionAssigned ?? vi.fn().mockResolvedValue(undefined);
  (window as unknown as { desktopApi: unknown }).desktopApi = {
    db: {
      catalogInstall,
      coachingInstall,
      declineDistribution,
      ensureDistributionAssigned,
    },
    onDistributionsOptInAvailable,
  };
  return {
    emit: (distributions) => listener?.(distributions),
    catalogInstall,
    coachingInstall,
    declineDistribution,
    ensureDistributionAssigned,
    onDistributionsOptInAvailable,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
});

describe("OptInDistributionsBanner (§I)", () => {
  it("subscribes to onDistributionsOptInAvailable on mount", () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);
    expect(api.onDistributionsOptInAvailable).toHaveBeenCalledTimes(1);
  });

  it("renders nothing until an opt-in distribution is pushed", () => {
    installDesktopApi();
    const { container } = render(<OptInDistributionsBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("surfaces a pushed opt-in distribution with its provenance and kind", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution()]);

    await waitFor(() =>
      expect(screen.getByTestId("opt-in-banner")).toBeDefined()
    );
    // The row carries who shared it and what it is, not just the bare name —
    // the context the Plugins page used to supply around it.
    expect(
      screen.getByText("Your organization shared the RTK plugin with you.")
    ).toBeDefined();
    expect(screen.getByText("Accept & install")).toBeDefined();
  });

  it("names a coaching pack as a coaching pack, not a plugin", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([
      makeDistribution({
        id: "coach-copy",
        catalogItem: {
          id: "cat-coach",
          name: "Reviewer Coaching",
          // Coaching packs still carry a component targetKind; the row must
          // announce the coaching pack, never the raw kind.
          targetKind: AgentComponentKind.Plugin,
          coaching: true,
        },
      }),
    ]);

    await waitFor(() =>
      expect(
        screen.getByText(
          "Your organization shared the Reviewer Coaching coaching pack with you."
        )
      ).toBeDefined()
    );
  });

  /**
   * ISS-5123 — withdrawal has to reach a banner that is ALREADY on screen.
   *
   * Withdrawing a pack only removes it from the next assignment poll, so the
   * reconcile's push is the only channel that can revoke a row the renderer is
   * already showing. That makes the push a snapshot, not an increment: a row
   * absent from a later push must disappear. Under the previous union-merge it
   * survived every push and stayed installable.
   */
  it("drops a row the next push no longer offers", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([
      makeDistribution({ id: "dist-kept" }),
      makeDistribution({ id: "dist-withdrawn" }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("opt-in-row-dist-withdrawn")).toBeDefined()
    );

    api.emit([makeDistribution({ id: "dist-kept" })]);

    await waitFor(() =>
      expect(screen.queryByTestId("opt-in-row-dist-withdrawn")).toBeNull()
    );
    // The positive arm: the surviving row proves the selector still matches, so
    // the absence assertion above is meaningful rather than vacuous.
    expect(screen.getByTestId("opt-in-row-dist-kept")).toBeDefined();
  });

  it("clears the banner when an empty push says the org offers nothing", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution({ id: "dist-last" })]);
    await waitFor(() =>
      expect(screen.getByTestId("opt-in-row-dist-last")).toBeDefined()
    );

    // Withdrawing the last opt-in pack produces exactly this payload.
    api.emit([]);

    await waitFor(() =>
      expect(screen.queryByTestId("opt-in-banner")).toBeNull()
    );
  });

  it("refuses to install a generic offer the cloud says is no longer assigned", async () => {
    const ensureDistributionAssigned = vi
      .fn()
      .mockRejectedValue(new Error("Distribution is no longer assigned."));
    const api = installDesktopApi({ ensureDistributionAssigned });
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution({ id: "dist-stale" })]);
    await waitFor(() =>
      expect(screen.getByText("Accept & install")).toBeDefined()
    );
    fireEvent.click(screen.getByText("Accept & install"));

    // The revalidation runs BEFORE the install, so the withdrawn pack never
    // reaches the local installer at all…
    await waitFor(() =>
      expect(ensureDistributionAssigned).toHaveBeenCalledWith("dist-stale")
    );
    expect(api.catalogInstall).not.toHaveBeenCalled();
    // …and the row stays with an inline error rather than silently vanishing as
    // though the install had succeeded.
    expect(screen.getByTestId("opt-in-row-dist-stale")).toBeDefined();
  });

  it("checks the offer still stands before every generic install", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution({ id: "dist-live" })]);
    await waitFor(() =>
      expect(screen.getByText("Accept & install")).toBeDefined()
    );
    fireEvent.click(screen.getByText("Accept & install"));

    await waitFor(() => expect(api.catalogInstall).toHaveBeenCalled());
    expect(api.ensureDistributionAssigned).toHaveBeenCalledWith("dist-live");
  });

  it("presents each pushed distribution as a role=status app banner row", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution({ id: "dist-status" })]);

    await waitFor(() =>
      expect(screen.getByTestId("opt-in-row-dist-status")).toBeDefined()
    );
    expect(
      screen.getByTestId("opt-in-row-dist-status").getAttribute("role")
    ).toBe("status");
  });

  it("Accept & install calls catalogInstall with the normalized pack id", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([
      makeDistribution({
        catalogItem: {
          id: "cat-1",
          name: "Web Command Enablement",
          targetKind: AgentComponentKind.Plugin,
        },
      }),
    ]);

    await waitFor(() =>
      expect(screen.getByText("Accept & install")).toBeDefined()
    );
    fireEvent.click(screen.getByText("Accept & install"));

    await waitFor(() =>
      expect(api.catalogInstall).toHaveBeenCalledWith(
        "web-command-enablement",
        "auto"
      )
    );
    // A non-coaching distribution never touches the coaching-pack bridge.
    expect(api.coachingInstall).not.toHaveBeenCalled();
    // After accept the row is removed.
    await waitFor(() =>
      expect(screen.queryByTestId("opt-in-banner")).toBeNull()
    );
  });

  it("Dismiss removes the distribution without installing", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution()]);
    await waitFor(() => expect(screen.getByText("Dismiss")).toBeDefined());

    fireEvent.click(screen.getByText("Dismiss"));

    await waitFor(() =>
      expect(screen.queryByTestId("opt-in-banner")).toBeNull()
    );
    expect(api.catalogInstall).not.toHaveBeenCalled();
    // FEA-4050: an explicit dismiss must durably persist the decline (by
    // distribution id) so the reconcile does not re-surface it after restart.
    expect(api.declineDistribution).toHaveBeenCalledWith("dist-1");
    expect(api.declineDistribution).toHaveBeenCalledTimes(1);
  });

  it("Accept & install does NOT record a decline (accept is not a decline)", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution()]);
    await waitFor(() =>
      expect(screen.getByText("Accept & install")).toBeDefined()
    );

    fireEvent.click(screen.getByText("Accept & install"));

    await waitFor(() => expect(api.catalogInstall).toHaveBeenCalled());
    // The row is removed on a successful install, but that is NOT a decline —
    // the durable decline record must never be written on the accept path.
    await waitFor(() =>
      expect(screen.queryByTestId("opt-in-banner")).toBeNull()
    );
    expect(api.declineDistribution).not.toHaveBeenCalled();
  });

  it("routes a coaching distribution through coachingInstall, not the generic catalogInstall", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    const dist = makeDistribution({
      id: "coach-1",
      catalogItem: {
        id: "cat-2",
        name: "Reviewer Coaching",
        targetKind: AgentComponentKind.Plugin,
        coaching: true,
      },
    });
    api.emit([dist]);

    await waitFor(() =>
      expect(screen.getByText("Accept & install")).toBeDefined()
    );
    fireEvent.click(screen.getByText("Accept & install"));

    // Coaching packs are installed by distribution id via the dedicated
    // coaching-pack bridge — the generic pack-catalog path is never used.
    await waitFor(() =>
      expect(api.coachingInstall).toHaveBeenCalledWith("coach-1")
    );
    expect(api.catalogInstall).not.toHaveBeenCalled();
    // After a successful coaching install the row is removed.
    await waitFor(() =>
      expect(screen.queryByTestId("opt-in-banner")).toBeNull()
    );
  });

  it("shows an actionable, engine-detail-free error when catalogInstall rejects", async () => {
    const catalogInstall = vi
      .fn()
      .mockRejectedValue(new Error("EPIPE broken pipe at spawn"));
    const api = installDesktopApi({ catalogInstall });
    render(<OptInDistributionsBanner />);

    api.emit([
      makeDistribution({
        id: "dist-fail",
        catalogItem: {
          id: "cat-fail",
          name: "cl-sweep",
          targetKind: AgentComponentKind.Plugin,
        },
      }),
    ]);
    await waitFor(() =>
      expect(screen.getByText("Accept & install")).toBeDefined()
    );
    fireEvent.click(screen.getByText("Accept & install"));

    await waitFor(() =>
      expect(screen.getByTestId("opt-in-error-dist-fail")).toBeDefined()
    );
    // The user-facing copy tells them what to do next and does NOT leak the raw
    // engine error message.
    expect(
      screen.getByText(
        "Couldn't install cl-sweep. Try again, or ask your admin to re-share it."
      )
    ).toBeDefined();
    expect(screen.queryByText((text) => text.includes("EPIPE"))).toBeNull();
    // Failure does NOT dismiss the row.
    expect(screen.getByTestId("opt-in-row-dist-fail")).toBeDefined();
    expect(api.catalogInstall).toHaveBeenCalledTimes(1);
  });

  it("scopes the installing state to its own row", async () => {
    // A never-resolving install keeps row A in the installing state; row B's
    // controls must stay enabled (accepting one pack does not lock the others).
    const catalogInstall = vi.fn(() => new Promise(() => undefined));
    const api = installDesktopApi({ catalogInstall });
    render(<OptInDistributionsBanner />);

    api.emit([
      makeDistribution({
        id: "row-a",
        catalogItem: {
          id: "cat-a",
          name: "Pack A",
          targetKind: AgentComponentKind.Plugin,
        },
      }),
      makeDistribution({
        id: "row-b",
        catalogItem: {
          id: "cat-b",
          name: "Pack B",
          targetKind: AgentComponentKind.Plugin,
        },
      }),
    ]);

    await waitFor(() =>
      expect(screen.getByTestId("opt-in-row-row-a")).toBeDefined()
    );

    const rowA = screen.getByTestId("opt-in-row-row-a");
    const rowB = screen.getByTestId("opt-in-row-row-b");
    const acceptA = within(rowA).getByRole("button", {
      name: "Accept & install",
    });
    fireEvent.click(acceptA);

    // Row A shows Installing… and is disabled; row B is untouched.
    await waitFor(() =>
      expect(within(rowA).getByText("Installing…")).toBeDefined()
    );
    const acceptB = within(rowB).getByRole("button", {
      name: "Accept & install",
    });
    const dismissB = within(rowB).getByRole("button", { name: "Dismiss" });
    expect((acceptB as HTMLButtonElement).disabled).toBe(false);
    expect((dismissB as HTMLButtonElement).disabled).toBe(false);
  });

  it("caps the visible rows and collapses the remainder into a summary row", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([
      makeDistribution({ id: "d1" }),
      makeDistribution({ id: "d2" }),
      makeDistribution({ id: "d3" }),
      makeDistribution({ id: "d4" }),
    ]);

    await waitFor(() =>
      expect(screen.getByTestId("opt-in-row-d1")).toBeDefined()
    );
    // Only the first two render individually; the rest collapse.
    expect(screen.getByTestId("opt-in-row-d2")).toBeDefined();
    expect(screen.queryByTestId("opt-in-row-d3")).toBeNull();
    expect(screen.queryByTestId("opt-in-row-d4")).toBeNull();
    expect(
      screen.getByText("2 more shared items are available in Plugins.")
    ).toBeDefined();
  });

  it("does not resurrect a dismissed distribution on a reconnect re-push", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution({ id: "dist-x" })]);
    await waitFor(() => expect(screen.getByText("Dismiss")).toBeDefined());
    fireEvent.click(screen.getByText("Dismiss"));
    await waitFor(() =>
      expect(screen.queryByTestId("opt-in-banner")).toBeNull()
    );

    // A cloud reconnect re-pushes the same (still server-assigned) distribution.
    api.emit([makeDistribution({ id: "dist-x" })]);

    // It must NOT reappear — the user already handled it.
    expect(screen.queryByTestId("opt-in-banner")).toBeNull();
    expect(screen.queryByTestId("opt-in-row-dist-x")).toBeNull();
  });
});
