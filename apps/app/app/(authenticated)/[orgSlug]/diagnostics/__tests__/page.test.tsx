import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/diagnostics-complete-surface-flag";
import {
  DIAGNOSTICS_REFRESH_LABEL,
  DIAGNOSTICS_SURFACE_DESCRIPTION,
  DIAGNOSTICS_SURFACE_V2_TEST_ID,
} from "@repo/app/diagnostics/components/diagnostics-surface-v2";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import DiagnosticsPage, { metadata } from "../page";
import {
  WEB_DIAGNOSTICS_DESCRIPTION,
  WEB_GATEWAY_LOGS_DESCRIPTION,
  WEB_GATEWAY_LOGS_TITLE,
  WEB_SECTION_UNSERVABLE_REASON,
} from "../web-diagnostics-contract";

/**
 * ISS-10006 — the web Diagnostics route, driven through the REAL
 * `FeatureFlagRouteGate` and the REAL `DiagnosticsSurfaceV2`.
 *
 * The body is not mocked, deliberately. What this route is FOR is the honest
 * render of a capability the host cannot execute, and a stubbed body would
 * assert that the page mounted something — the one thing that was never in
 * doubt — while the empty-section regression the ruling forbids walked straight
 * past it.
 */
const { notFoundMock, useFeatureFlagMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useFeatureFlagMock: vi.fn(),
}));

const { useFeatureFlagsLoadedMock, usePostHogDistinctIdMock } = vi.hoisted(
  () => ({
    useFeatureFlagsLoadedMock: vi.fn(),
    usePostHogDistinctIdMock: vi.fn(),
  })
);

const { useUserMock } = vi.hoisted(() => ({ useUserMock: vi.fn() }));

vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

vi.mock("@repo/analytics/client", () => ({
  postHogFeatureFlagsEnabled: true,
  useFeatureFlag: (flag: string) => useFeatureFlagMock(flag),
  useFeatureFlagsLoaded: () => useFeatureFlagsLoadedMock(),
  usePostHogDistinctId: () => usePostHogDistinctIdMock(),
}));

vi.mock("@repo/auth/client", () => ({ useUser: () => useUserMock() }));

vi.mock("../../../components/header", () => ({
  Header: () => <div>Header chrome</div>,
}));

const IDENTIFIED_USER_ID = "user_identified_123";
const POLLING_CONTROL_NAME = /Pause|Resume/;

function settledIdentifiedState() {
  useUserMock.mockReturnValue({
    isLoaded: true,
    user: { id: IDENTIFIED_USER_ID },
  });
  useFeatureFlagsLoadedMock.mockReturnValue(true);
  usePostHogDistinctIdMock.mockReturnValue(IDENTIFIED_USER_ID);
}

describe("web Diagnostics route — the gate", () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    useFeatureFlagMock.mockReset();
    useFeatureFlagsLoadedMock.mockReset();
    usePostHogDistinctIdMock.mockReset();
    useUserMock.mockReset();
  });

  it("describes the page in THIS host's words, not the probe host's", () => {
    // tamsinb review: `DIAGNOSTICS_SURFACE_DESCRIPTION` names what a probe
    // reports, and web runs no probe. Shipping it as the route's
    // `<meta name="description">` puts the page's one false claim where a
    // search engine and a link preview read it first.
    expect(metadata.description).toBe(WEB_DIAGNOSTICS_DESCRIPTION);
    expect(metadata.description).not.toBe(DIAGNOSTICS_SURFACE_DESCRIPTION);
  });

  it("404s when diagnostics-complete-surface is OFF", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    expect(() =>
      render(<DiagnosticsPage />, { wrapper: WebFeatureFlagProvider })
    ).toThrow("NEXT_NOT_FOUND");

    expect(useFeatureFlagMock).toHaveBeenCalledWith(
      DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY
    );
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_TEST_ID)
    ).not.toBeInTheDocument();
  });

  it("mounts the shared surface when the flag is ON", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: true });

    render(<DiagnosticsPage />, { wrapper: WebFeatureFlagProvider });

    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_TEST_ID)
    ).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("adds no second page heading around the surface's own h1", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: true });

    render(<DiagnosticsPage />, { wrapper: WebFeatureFlagProvider });

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("web Diagnostics route — what the host can and cannot do", () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    useFeatureFlagMock.mockReset();
    useFeatureFlagsLoadedMock.mockReset();
    usePostHogDistinctIdMock.mockReset();
    useUserMock.mockReset();
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: true });
  });

  it("says why Repos is absent instead of rendering an empty section", () => {
    render(<DiagnosticsPage />, { wrapper: WebFeatureFlagProvider });

    expect(screen.getByText("Repos is not collected here")).toBeInTheDocument();
    expect(screen.getByText(WEB_SECTION_UNSERVABLE_REASON)).toBeInTheDocument();
  });

  it("keeps the two optional tabs rather than silently shortening the strip", () => {
    render(<DiagnosticsPage />, { wrapper: WebFeatureFlagProvider });

    // The positive half of the absence: the tabs a host MAY drop are present,
    // which is what makes "Withheld is not offered" a statement the reader can
    // act on rather than a tab that was never there.
    expect(screen.getByRole("tab", { name: "Withheld" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Coverage" })).toBeInTheDocument();
  });

  it("offers Gateway Logs as an explanation, with nothing to press", async () => {
    render(<DiagnosticsPage />, { wrapper: WebFeatureFlagProvider });

    await userEvent.click(screen.getByRole("tab", { name: "Gateway Logs" }));

    expect(screen.getByText(WEB_GATEWAY_LOGS_TITLE)).toBeInTheDocument();
    expect(screen.getByText(WEB_GATEWAY_LOGS_DESCRIPTION)).toBeInTheDocument();
    // Scoped to the panel, and paired with the title above: a document-wide
    // "no buttons" would be false (the tabs are buttons), and an unscoped
    // negative on a control nothing renders could never fail.
    expect(
      within(screen.getByRole("tabpanel")).queryAllByRole("button")
    ).toHaveLength(0);
  });

  it("offers no Refresh, because there is no probe to re-run", () => {
    render(<DiagnosticsPage />, { wrapper: WebFeatureFlagProvider });

    expect(
      screen.queryByRole("button", { name: DIAGNOSTICS_REFRESH_LABEL })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: POLLING_CONTROL_NAME })
    ).not.toBeInTheDocument();
  });
});
