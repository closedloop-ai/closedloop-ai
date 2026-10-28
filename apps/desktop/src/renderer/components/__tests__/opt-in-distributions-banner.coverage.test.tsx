/**
 * Branch-coverage tests for opt-in-distributions-banner.tsx (ISS-11284),
 * targeting branches not exercised by opt-in-distributions-banner.test.tsx:
 * the no-api guard in `accept`, the empty-normalized-pack-id error path, the
 * error-map clear in `accept` when a prior error exists, dismissing an errored
 * row, the singular overflow copy, and the `kindNoun` mcp/known/unknown arms.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  DistributionMode,
  type OptInDistributionDto,
} from "@repo/api/src/types/distribution";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptInDistributionsBanner } from "../opt-in-distributions-banner";

// The banner reads `DISTRIBUTION_OPT_IN_BANNER_FEATURE_FLAG_KEY` itself (operator
// instruction, 2026-09-30) and renders nothing while it is off. These cases are
// about the banner's own behavior with the prompt enabled, so the flag port
// resolves open here; both flag directions and the PENDING race live in
// `opt-in-distributions-banner-flag.test.tsx`.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => true,
}));

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

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installDesktopApi(
  over: {
    catalogInstall?: ReturnType<typeof vi.fn>;
    coachingInstall?: ReturnType<typeof vi.fn>;
    declineDistribution?: ReturnType<typeof vi.fn>;
    ensureDistributionAssigned?: ReturnType<typeof vi.fn>;
    acknowledgeDistributionHandled?: ReturnType<typeof vi.fn>;
    withoutDb?: boolean;
  } = {}
): {
  emit: (distributions: OptInDistributionDto[]) => Promise<void>;
  catalogInstall: ReturnType<typeof vi.fn>;
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
  const ensureDistributionAssigned =
    over.ensureDistributionAssigned ?? vi.fn().mockResolvedValue(undefined);
  const acknowledgeDistributionHandled =
    over.acknowledgeDistributionHandled ?? vi.fn().mockResolvedValue(undefined);
  (window as unknown as { desktopApi: unknown }).desktopApi = {
    db: over.withoutDb
      ? undefined
      : {
          catalogInstall,
          coachingInstall,
          declineDistribution,
          ensureDistributionAssigned,
          acknowledgeDistributionHandled,
        },
    onDistributionsOptInAvailable,
  };
  return {
    emit: async (distributions) => {
      await act(() => {
        listener?.(distributions);
      });
    },
    catalogInstall,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("OptInDistributionsBanner branch coverage", () => {
  it("no-ops Accept when window.desktopApi.db is unavailable", async () => {
    const api = installDesktopApi({ withoutDb: true });
    render(<OptInDistributionsBanner />);
    await api.emit([makeDistribution()]);

    fireEvent.click(await screen.findByText("Accept & install"));

    // Nothing to await on a no-op; the row stays exactly as pushed with no
    // installing state and no error.
    expect(await screen.findByText("Accept & install")).toBeTruthy();
    expect(screen.queryByTestId("opt-in-error-dist-1")).toBeNull();
  });

  it("shows an inline error and never installs when the catalog name normalizes to empty", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);
    const dist = makeDistribution({
      catalogItem: {
        id: "cat-symbols",
        name: "!!!",
        targetKind: AgentComponentKind.Plugin,
      },
    });
    await api.emit([dist]);

    fireEvent.click(await screen.findByText("Accept & install"));

    await waitFor(() => {
      expect(screen.getByTestId("opt-in-error-dist-1")).toBeTruthy();
    });
    expect(api.catalogInstall).not.toHaveBeenCalled();
  });

  it("clears a prior row error while the retry accept is in flight (id-in-prev true branch)", async () => {
    const catalogInstall = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const api = installDesktopApi({ catalogInstall });
    render(<OptInDistributionsBanner />);
    await api.emit([makeDistribution({ id: "dist-retry" })]);

    fireEvent.click(await screen.findByText("Accept & install"));
    await waitFor(() => {
      expect(screen.getByTestId("opt-in-error-dist-retry")).toBeTruthy();
    });

    // A successful install drops the row either way, so the clear is only
    // observable while the retry is still in flight.
    let resolveRetry: (value: { started: boolean }) => void = () => undefined;
    const retry = new Promise<{ started: boolean }>((resolve) => {
      resolveRetry = resolve;
    });
    catalogInstall.mockReturnValueOnce(retry);
    fireEvent.click(screen.getByText("Accept & install"));
    await waitFor(() => {
      expect(catalogInstall).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("Installing…")).toBeTruthy();
    expect(screen.queryByTestId("opt-in-error-dist-retry")).toBeNull();

    await act(() => {
      resolveRetry({ started: true });
      return retry;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("opt-in-row-dist-retry")).toBeNull();
    });
  });

  it("dismiss removes a row that is showing an install error", async () => {
    const catalogInstall = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const api = installDesktopApi({ catalogInstall });
    render(<OptInDistributionsBanner />);
    await api.emit([makeDistribution({ id: "dist-dismiss-with-error" })]);

    fireEvent.click(await screen.findByText("Accept & install"));
    await waitFor(() => {
      expect(
        screen.getByTestId("opt-in-error-dist-dismiss-with-error")
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Dismiss"));
    expect(
      screen.queryByTestId("opt-in-row-dist-dismiss-with-error")
    ).toBeNull();
  });

  it("renders no overflow summary row when nothing overflows the visible cap", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);
    await api.emit([
      makeDistribution({ id: "d1" }),
      makeDistribution({ id: "d2" }),
    ]);

    await screen.findByTestId("opt-in-row-d1");
    expect(screen.queryByTestId("opt-in-overflow")).toBeNull();
  });

  it("uses singular copy for exactly one overflow row", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);
    await api.emit([
      makeDistribution({ id: "d1" }),
      makeDistribution({ id: "d2" }),
      makeDistribution({ id: "d3" }),
    ]);

    expect(
      await screen.findByText("1 more shared item is available in Plugins.")
    ).toBeTruthy();
  });

  it("names an mcp target kind as an MCP server", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);
    await api.emit([
      makeDistribution({
        catalogItem: {
          id: "cat-mcp",
          name: "Search",
          targetKind: AgentComponentKind.Mcp,
        },
      }),
    ]);

    expect(
      await screen.findByText(
        "Your organization shared the Search MCP server with you."
      )
    ).toBeTruthy();
  });

  it("falls back to the generic 'item' noun for an unrecognized target kind", async () => {
    const api = installDesktopApi();
    render(<OptInDistributionsBanner />);
    await api.emit([
      makeDistribution({
        catalogItem: {
          id: "cat-unknown",
          name: "Widget",
          targetKind: "future-kind",
        },
      }),
    ]);

    expect(
      await screen.findByText(
        "Your organization shared the Widget item with you."
      )
    ).toBeTruthy();
  });
});
