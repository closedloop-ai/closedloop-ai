/**
 * @file opt-in-distributions-banner.test.tsx
 * @description Unit tests for the desktop OptInDistributionsBanner
 * (FEA-2923 / §I).
 *
 * Proves the renderer actually subscribes to the main-process
 * `onDistributionsOptInAvailable` push and that "Accept & install" routes
 * through the vetted `catalogInstall` IPC — these tests FAIL if the event is
 * emitted into the void (no subscriber) or if accept is inert.
 */

import type { DistributionDto } from "@repo/api/src/types/distribution";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptInDistributionsBanner } from "../opt-in-distributions-banner";

function makeDistribution(
  over: Partial<DistributionDto> = {}
): DistributionDto {
  return {
    id: "dist-1",
    organizationId: "org-1",
    catalogItemId: "cat-1",
    catalogItem: {
      id: "cat-1",
      name: "RTK",
      targetKind: "plugin",
      source: "curated",
    },
    mode: "opt_in",
    targetingType: "all",
    desiredEnabled: true,
    targetingEntries: [],
    targetStatuses: [],
    assetDownloadUrl: null,
    createdAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:00:00Z",
    ...over,
  } as DistributionDto;
}

type Listener = (distributions: DistributionDto[]) => void;

function installDesktopApi(
  over: {
    catalogInstall?: ReturnType<typeof vi.fn>;
    coachingInstall?: ReturnType<typeof vi.fn>;
  } = {}
): {
  emit: (distributions: DistributionDto[]) => void;
  catalogInstall: ReturnType<typeof vi.fn>;
  coachingInstall: ReturnType<typeof vi.fn>;
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
  (window as unknown as { desktopApi: unknown }).desktopApi = {
    db: { catalogInstall, coachingInstall },
    onDistributionsOptInAvailable,
  };
  return {
    emit: (distributions) => listener?.(distributions),
    catalogInstall,
    coachingInstall,
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

  it("surfaces pushed opt-in distributions for accept", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution()]);

    await waitFor(() =>
      expect(screen.getByTestId("opt-in-banner")).toBeDefined()
    );
    expect(screen.getByText("RTK")).toBeDefined();
    expect(screen.getByText("Accept & install")).toBeDefined();
  });

  it("Accept & install calls catalogInstall with the normalized pack id", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    api.emit([
      makeDistribution({
        catalogItem: {
          id: "cat-1",
          name: "Web Command Enablement",
          targetKind: "plugin",
          source: "curated",
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
  });

  it("routes a coaching distribution through coachingInstall, not the generic catalogInstall", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);

    const dist = makeDistribution({
      id: "coach-1",
      catalogItem: {
        id: "cat-2",
        name: "Reviewer Coaching",
        targetKind: "plugin",
        source: "curated",
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

  it("keeps the row visible with an inline error when catalogInstall rejects", async () => {
    const catalogInstall = vi
      .fn()
      .mockRejectedValue(new Error("install exploded"));
    const api = installDesktopApi({ catalogInstall });
    render(<OptInDistributionsBanner />);

    api.emit([makeDistribution({ id: "dist-fail" })]);
    await waitFor(() =>
      expect(screen.getByText("Accept & install")).toBeDefined()
    );
    fireEvent.click(screen.getByText("Accept & install"));

    await waitFor(() =>
      expect(screen.getByTestId("opt-in-error-dist-fail")).toBeDefined()
    );
    expect(screen.getByText("install exploded")).toBeDefined();
    // Failure does NOT dismiss the row.
    expect(screen.getByTestId("opt-in-row-dist-fail")).toBeDefined();
    expect(api.catalogInstall).toHaveBeenCalledTimes(1);
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
