import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
  SessionVolumeBucket,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { DashboardContentState } from "@repo/app/insights/components/overview/dashboard-content-state";
import {
  DASHBOARD_PAGE_DESCRIPTION,
  DASHBOARD_PAGE_TITLE,
} from "@repo/app/insights/lib/dashboard-header-copy";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "@repo/app/onboarding/lib/desktop-download-copy";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "../page";

vi.mock("@repo/app/insights/components/insights-data-source-provider", () => ({
  WebInsightsDataSourceProvider: ({
    children,
    teamScopes,
  }: {
    children: ReactNode;
    teamScopes?: boolean;
  }) => (
    <div
      data-team-scopes={String(teamScopes)}
      data-testid="web-insights-provider"
    >
      {children}
    </div>
  ),
}));

vi.mock(
  "@repo/app/insights/components/overview/insights-overview-dashboard",
  () => ({
    InsightsOverviewDashboard: ({
      emptyStateAction,
      emptyStateDescription,
      getSessionHref,
      onContentStateChange,
      onSessionVolumeReport,
    }: {
      emptyStateAction?: ReactNode;
      emptyStateDescription?: string;
      getSessionHref: (session: { id: string }) => string;
      onContentStateChange?: (state: DashboardContentState) => void;
      onSessionVolumeReport?: (report: unknown) => void;
    }) => {
      // Stands in for the real dashboard finishing its rows. The route's only
      // job with these reports is to relay/derive from them, so the stub
      // reports once and the cases below read what reached the host and the
      // analytics port.
      useEffect(() => {
        onContentStateChange?.(
          // `null` is the default, resolved HERE rather than in the hoisted
          // block: `vi.hoisted` runs before this file's imports, so the const
          // reference is not initialized there yet.
          dashboardContentStateForRoute.value ?? DashboardContentState.Ready
        );
        onSessionVolumeReport?.(sessionVolumeReportForRoute.value);
      }, [onContentStateChange, onSessionVolumeReport]);
      return (
        <section aria-label="Insights overview">
          <h2>Recent Sessions</h2>
          <a href={getSessionHref({ id: "session-1" })}>Session one</a>
          {emptyStateDescription ? <p>{emptyStateDescription}</p> : null}
          {emptyStateAction}
        </section>
      );
    },
  })
);

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ breadcrumbs }: { breadcrumbs: { label: string }[] }) => (
    <header>
      {breadcrumbs.map((breadcrumb) => breadcrumb.label).join(" / ")}
    </header>
  ),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

const {
  currentUserState,
  dashboardContentStateForRoute,
  deferTour,
  finishTour,
  guidedTour,
  readTourRun,
  renderDashboardTourHost,
  sessionVolumeReportForRoute,
  setViewContextProperty,
} = vi.hoisted(() => ({
  /**
   * Controlled `useCurrentUser` state: the route reads it for the PRD-736
   * volume buckets (and it needs an AuthAdapterProvider in production, so the
   * hook is mocked rather than mounted bare).
   */
  currentUserState: {
    value: {
      data: { id: "user-1" } as { id: string } | undefined,
      isError: false,
      isSuccess: true,
    },
  },
  /**
   * What the stub dashboard reports it is rendering. `null` means "the default",
   * which the stub resolves to `Ready` — what an ordinary dashboard reports. The
   * desktop-download cases below drive it.
   */
  dashboardContentStateForRoute: {
    value: null as DashboardContentState | null,
  },
  deferTour: vi.fn(),
  finishTour: vi.fn(),
  /** What the mocked guided-onboarding client answers; a case may flip it. */
  guidedTour: { tourRequested: true },
  /** Records what the ROUTE read the run with, and the run it got back. */
  readTourRun: vi.fn(),
  renderDashboardTourHost: vi.fn(),
  /** What the stub dashboard reports as its settled session-volume payload. */
  sessionVolumeReportForRoute: {
    value: {
      orgSessionCount: null,
      userSessionCounts: null,
    } as {
      orgSessionCount: number | null;
      userSessionCounts: readonly { count: number; userId: string }[] | null;
    },
  },
  setViewContextProperty: vi.fn(),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => currentUserState.value,
}));

// The real run and the real host, behind probes: the run's own behaviour is
// covered beside it, and what this file owns is what the ROUTE hands each.
vi.mock("../dashboard-tour-host", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../dashboard-tour-host")>();
  return {
    ...actual,
    useDashboardTourRun: (
      args: Parameters<typeof actual.useDashboardTourRun>[0]
    ) => {
      const run = actual.useDashboardTourRun(args);
      readTourRun(args, run);
      return run;
    },
    DashboardTourHost: (
      props: Parameters<typeof actual.DashboardTourHost>[0]
    ) => {
      renderDashboardTourHost(props);
      return <actual.DashboardTourHost {...props} />;
    },
  };
});

// The guided-onboarding client itself is covered in `@repo/app`; what this file
// owns is whether the ROUTE reads it and passes what it answered to the host.
vi.mock("@repo/app/onboarding/hooks/use-guided-dashboard-tour", () => ({
  useGuidedDashboardTour: () => ({
    deferTour,
    finishTour,
    tourRequested: guidedTour.tourRequested,
  }),
}));

vi.mock("@datadog/browser-rum", () => ({
  datadogRum: { setViewContextProperty },
}));

describe("DashboardPage RUM range attribute (ISS-7250)", () => {
  afterEach(() => {
    setViewContextProperty.mockReset();
    localStorage.clear();
  });

  /**
   * The picker lives inside the shared dashboard component, so this is the only
   * coverage proving the ROUTE still reads that persisted selection and tags its
   * RUM view with it. Driving the real store (rather than mocking the hook)
   * exercises page -> store -> RANGE_TO_PERIOD -> RUM end to end; deleting the
   * `useRumViewRange` call from the page turns this red.
   */
  it("tags the view with the persisted 90-day selection", () => {
    localStorage.setItem("shared:date-range:web", JSON.stringify("90d"));

    render(<DashboardPage />);

    expect(setViewContextProperty.mock.calls).toEqual([["range_days", "90"]]);
  });

  it("tags the view with the 7-day default when nothing is persisted", () => {
    render(<DashboardPage />);

    expect(setViewContextProperty.mock.calls).toEqual([["range_days", "7"]]);
  });
});

describe("DashboardPage tour mount (ISS-8351)", () => {
  afterEach(() => {
    readTourRun.mockReset();
    renderDashboardTourHost.mockReset();
  });

  /**
   * PLN-1875 Steps 8 and 9's web wiring: the route reads the run with what the
   * guided-onboarding client answered plus BOTH writes that end a run, and
   * mounts the tour host on that run — delete the element and nothing renders
   * it. Step 6 shipped these props permanently inert because that client did not
   * exist; a route that stopped reading them would go back to a tour nobody can
   * open, and a route that dropped `onDeferTour` would leave a zero-session
   * reader parked in the tour phase for good.
   *
   * The clear is load-bearing, not hygiene. Two earlier cases in this file
   * render `DashboardPage` too, so at this point the spies already hold their
   * calls — and `toHaveBeenCalledWith` is satisfied by ANY recorded call, so
   * without the clear this case could pass on a render it did not perform.
   * Cleared here and asserted as the first call, it pins its own.
   */
  it("mounts the tour host with what the guided-onboarding client read", () => {
    readTourRun.mockClear();
    renderDashboardTourHost.mockClear();

    render(<DashboardPage />);

    expect(readTourRun.mock.calls[0]?.[0]).toMatchObject({
      onDeferTour: deferTour,
      onFinishTour: finishTour,
      tourRequested: true,
    });
    // The run the route READ, not a second read of it: the Tour control is
    // handed the same one, and two reads would be two runs.
    expect(renderDashboardTourHost.mock.calls[0]?.[0]).toEqual({
      run: readTourRun.mock.calls[0]?.[1],
    });
  });

  /**
   * The readiness half. The dashboard's report travels route-side because the
   * tour host is the dashboard's SIBLING, not its child — so a route that took
   * the report and never relayed it would leave the host permanently believing
   * the page was still loading, and the tour would never open for anyone.
   *
   * The first render is asserted as loading on purpose: the report arrives from
   * the dashboard's effect, so "ready from the start" would be a route that had
   * stopped waiting rather than one that relays.
   */
  it("relays the dashboard's own report of what it is rendering", () => {
    readTourRun.mockClear();

    render(<DashboardPage />);

    const states = readTourRun.mock.calls.map(
      (call) =>
        (call[0] as { dashboardContentState: string }).dashboardContentState
    );
    expect(states[0]).toBe(DashboardContentState.Loading);
    expect(states.at(-1)).toBe(DashboardContentState.Ready);
  });
});

describe("DashboardPage Tour control (ISS-10929)", () => {
  it("renders no Tour control", () => {
    // The operator retired it from BOTH dashboards. Asserted STRUCTURALLY over
    // the title block it sat in, not by its retired `[data-tour-btn]` dock
    // marker: nothing in the repo emits that attribute any more, so an absence
    // assertion on it is satisfied by a reinstated control that simply does not
    // opt back into it. A control of ANY shape put back into this block fails
    // the emptiness check, and the description assertion above it is the same
    // locator resolving to real content — so emptiness cannot pass against a
    // block that resolved to nothing. ISS-10929 collapsed the flex row this
    // used to walk two parents to reach, so the title block is now the
    // heading's own parent.
    render(<DashboardPage />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: DASHBOARD_PAGE_TITLE,
    });
    const titleBlock = heading.parentElement;
    expect(titleBlock).not.toBeNull();
    expect(titleBlock).toHaveTextContent(DASHBOARD_PAGE_DESCRIPTION);
    expect(
      titleBlock?.querySelectorAll("button, a[href], [role='button']")
    ).toHaveLength(0);
    // And no control anywhere on the page still offers to replay the tour,
    // whatever block it were moved into.
    expect(screen.queryByRole("button", { name: TOUR_BUTTON_NAME })).toBeNull();
  });
});

describe("DashboardPage a11y", () => {
  // FEA-4155: the dashboard is no longer wrapped in `<FeatureFlagged>` on the
  // winding-down `DESKTOP_AGENT_SESSION_SYNC` flag (bot review #3789) — it is the
  // first always-on nav destination and renders directly, its own empty/loading
  // states owned by InsightsOverviewDashboard. This proves no flag gate wraps the
  // body.
  it("renders the dashboard shell directly with no feature-flag gate (FEA-4155)", () => {
    render(<DashboardPage />);

    const sessionLink = screen.getByRole("link", { name: "Session one" });

    expect(screen.getByTestId("web-insights-provider")).toBeInTheDocument();
    expect(sessionLink).toHaveAttribute("href", "/acme/sessions/session-1");
    expect(
      screen.getByRole("heading", { level: 1, name: DASHBOARD_PAGE_TITLE })
    ).toBeInTheDocument();
    expect(screen.getByText(DASHBOARD_PAGE_DESCRIPTION)).toBeInTheDocument();
    expect(sessionLink.closest("[data-feature-flag]")).toBeNull();
  });

  // ISS-7514: no control on this route can reach the `team` aggregation scope,
  // so the route must not ask the provider to read the org's Teams. Sibling
  // assertion (the surface that DOES ask) lives on the Insights route test.
  it("does not ask the provider for team scopes it cannot render", () => {
    render(<DashboardPage />);

    expect(screen.getByTestId("web-insights-provider")).toHaveAttribute(
      "data-team-scopes",
      "undefined"
    );
  });

  it.each([A11yTheme.Light, A11yTheme.Dark])(
    "keeps the dashboard route critical a11y and contrast clean in %s theme",
    async (theme) => {
      const { container } = render(
        <A11yThemeRoot theme={theme}>
          <DashboardPage />
        </A11yThemeRoot>
      );

      await expectCriticalAxeClean(container);
      expectElementContrast(screen.getByText("Recent Sessions"), {
        background: themeBackground(theme),
        label: `dashboard route ${theme}`,
      });
    }
  );

  // ISS-11261: the installer-gap arm renders markup the cases above never reach
  // — an Alert with a leading icon, a per-platform detail line, and an external
  // anchor. It is the arm a reader on an unpublished platform gets, and it
  // carries the most markup.
  it.each([A11yTheme.Light, A11yTheme.Dark])(
    "keeps the installer-gap empty state critical a11y clean in %s theme",
    async (theme) => {
      const priorPlatform = Object.getOwnPropertyDescriptor(
        navigator,
        "platform"
      );
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: "Win32",
      });
      dashboardContentStateForRoute.value = DashboardContentState.Empty;
      try {
        const { container } = render(
          <A11yThemeRoot theme={theme}>
            <DashboardPage />
          </A11yThemeRoot>
        );

        // Asserted present first: an axe pass over a card that never drew the
        // gap arm proves nothing about the gap arm.
        expect(
          await screen.findByText("Not available for Windows yet")
        ).toBeDefined();
        await expectCriticalAxeClean(container);
      } finally {
        if (priorPlatform) {
          Object.defineProperty(navigator, "platform", priorPlatform);
        } else {
          Reflect.deleteProperty(navigator as unknown as object, "platform");
        }
        dashboardContentStateForRoute.value = null;
      }
    }
  );
});

// PRD-736 (ISS-10501) through the REAL analytics port: the route derives the
// settled volume buckets from the dashboard's own report + the viewer identity
// and stamps them on the single `page_viewed`. Deleting or miswiring the
// derivation callback leaves these red — the generic-hook and pure-helper
// suites cannot see this route.
describe("DashboardPage page_viewed volume buckets (PRD-736 ISS-10501)", () => {
  const capture = vi.fn<SurfaceAnalyticsCapture>();

  function renderWithAnalytics() {
    return render(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <DashboardPage />
      </SurfaceAnalyticsProvider>
    );
  }

  function pageViewedCalls() {
    return capture.mock.calls.filter(
      ([event]) => event === OnboardingAnalyticsEvent.PageViewed
    );
  }

  afterEach(() => {
    capture.mockClear();
    currentUserState.value = {
      data: { id: "user-1" },
      isError: false,
      isSuccess: true,
    };
    sessionVolumeReportForRoute.value = {
      orgSessionCount: null,
      userSessionCounts: null,
    };
  });

  it("emits one page_viewed carrying the settled org and own volume buckets", async () => {
    sessionVolumeReportForRoute.value = {
      orgSessionCount: 42,
      userSessionCounts: [{ count: 5, userId: "user-1" }],
    };

    renderWithAnalytics();

    await waitFor(() => {
      expect(pageViewedCalls()).toHaveLength(1);
    });
    expect(pageViewedCalls()[0]?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.PageName]:
        OnboardingAnalyticsPageName.Dashboard,
      [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
        SessionVolumeBucket.TenToNinetyNine,
      [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
        SessionVolumeBucket.OneToNine,
    });
  });

  // The deliberate gating half (PRD-736; denominator note recorded in the PRD):
  // the dashboard page_viewed waits for the viewer identity so the buckets can
  // settle — an unsettled viewer must not produce an emit, and absent operands
  // omit their properties rather than fabricating a value.
  it("holds the emit while the viewer identity is unsettled, then omits absent buckets", async () => {
    currentUserState.value = {
      data: undefined,
      isError: false,
      isSuccess: false,
    };
    const view = renderWithAnalytics();
    // The report settled, the viewer did not: no emit yet.
    expect(pageViewedCalls()).toHaveLength(0);
    view.unmount();

    currentUserState.value = {
      data: undefined,
      isError: true,
      isSuccess: false,
    };
    renderWithAnalytics();
    await waitFor(() => {
      expect(pageViewedCalls()).toHaveLength(1);
    });
    const properties = pageViewedCalls()[0]?.[1];
    expect(properties).toMatchObject({
      [OnboardingAnalyticsProperty.PageName]:
        OnboardingAnalyticsPageName.Dashboard,
    });
    expect(properties).not.toHaveProperty(
      OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume
    );
    expect(properties).not.toHaveProperty(
      OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume
    );
  });
});

/** Any control still offering to replay the tour, by its accessible name. */
const TOUR_BUTTON_NAME = /tour/i;

/**
 * The desktop-download empty state (ISS-11261), offered on every dashboard
 * (PLN-2216 R5).
 *
 * Detection is driven through the REAL `useDetectedDesktopOs` and a stubbed
 * `navigator.platform`, not a mocked hook: the platform read is the thing AC3 is
 * about, so a stub of the hook would pin the arms without proving the route
 * reaches them.
 */
describe("DashboardPage desktop-download empty state (ISS-11261)", () => {
  const RELEASE_PAGE_NAME = "Download desktop app";
  const MAC_INSTALL_NAME = "Download Mac Desktop App";
  const WINDOWS_GAP_HEADLINE = "Not available for Windows yet";

  let platformDescriptor: PropertyDescriptor | undefined;

  function stubPlatform(platform: string) {
    platformDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "platform"
    ) as PropertyDescriptor | undefined;
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: platform,
    });
  }

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(navigator, "platform", platformDescriptor);
    } else {
      Reflect.deleteProperty(navigator as unknown as object, "platform");
    }
    platformDescriptor = undefined;
    dashboardContentStateForRoute.value = null;
  });

  function renderEmpty() {
    dashboardContentStateForRoute.value = DashboardContentState.Empty;
    return render(<DashboardPage />);
  }

  /**
   * AC1, on ONE render: the composite's own macOS install control, and the
   * step's approved sentence reaching the card. That sentence is imported from
   * its owner rather than retyped, so a re-authored copy fails here.
   */
  it("offers the macOS installer with the approved description", async () => {
    stubPlatform("MacIntel");

    renderEmpty();

    expect(
      await screen.findByRole("link", { name: MAC_INSTALL_NAME })
    ).toHaveAttribute("href", expect.stringContaining(".dmg"));
    expect(screen.getByText(DESKTOP_DOWNLOAD_DESCRIPTION)).toBeDefined();
  });

  /**
   * AC3, positively. A reader whose platform has no published artifact must get
   * the gap sentence AND somewhere to go: "no `.dmg` link" alone is satisfied by
   * a blank card, which is the dead end this ticket exists to stop. So the gap
   * headline, the forward control's presence and its resolving href are asserted
   * together, and the macOS installer is asserted absent on that same render.
   */
  it("gives a platform with no installer the gap arm and a working exit", async () => {
    stubPlatform("Win32");

    renderEmpty();

    expect(await screen.findByText(WINDOWS_GAP_HEADLINE)).toBeDefined();
    const releasePage = screen.getByRole("link", { name: RELEASE_PAGE_NAME });
    // An independent literal, not read back from the constant the control uses:
    // a fixture assembled from the const it polices agrees with any value that
    // const takes, including one GitHub does not answer.
    expect(releasePage).toHaveAttribute(
      "href",
      "https://github.com/closedloop-ai/closedloop-ai/releases/tag/desktop-latest"
    );
    expect(screen.queryByRole("link", { name: MAC_INSTALL_NAME })).toBeNull();
  });

  /**
   * PLN-2216 R5: the dashboard always offers the Desktop download, including to
   * the dormant org whose sessions are older than the seven-day window.
   */
  it("offers the download to a dormant org too", async () => {
    stubPlatform("MacIntel");
    dashboardContentStateForRoute.value = DashboardContentState.Quiet;

    render(<DashboardPage />);

    expect(
      await screen.findByRole("link", { name: MAC_INSTALL_NAME })
    ).toHaveAttribute("href", expect.stringContaining(".dmg"));
    expect(screen.getByText(DESKTOP_DOWNLOAD_DESCRIPTION)).toBeDefined();
  });
});
