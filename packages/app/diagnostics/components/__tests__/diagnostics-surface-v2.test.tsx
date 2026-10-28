import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticsPayload } from "../../lib/diagnostics-payload";
import { DiagnosticsSectionId } from "../../lib/diagnostics-sections";
import {
  type DiagnosticsSource,
  DiagnosticsTransportStatus,
} from "../../lib/diagnostics-source";
import {
  DIAGNOSTICS_SURFACE_DESCRIPTION,
  DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID,
  DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID,
  DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID,
  DIAGNOSTICS_SURFACE_V2_UNSERVABLE_TEST_ID,
  DiagnosticsSurfaceV2,
} from "../diagnostics-surface-v2";

/**
 * ISS-10004 — what `DiagnosticsSurfaceV2` owes a reader.
 *
 * THE TAB STRIP IS PINNED AS A LITERAL. `DIAGNOSTICS_SECTIONS` is the thing
 * under test: a fixture that mapped over it could not fail when a section is
 * dropped, renamed or reordered, because the expectation would move with the
 * defect. The duplication IS the test — it is the executable form of ISS-10004
 * AC1, "existing deep links and anchors preserved", transcribed from the
 * superseded desktop body (`diagnostics-legacy-body.tsx`) before it moved.
 */
const EXPECTED_TABS_ALL_SECTIONS = [
  "Repos",
  "Backfill",
  "Links",
  "Withheld",
  "Coverage",
  "Gateway Logs",
];

/** The strip a device that offers neither local-collector section shows. */
const EXPECTED_TABS_BASE = ["Repos", "Backfill", "Links", "Gateway Logs"];

const AXIS_LABELS = { harness: "Harness" } as const;

const LOGS_MARKER = "logs-body-marker";
const REFRESH_BUTTON_NAME = "Refresh";

function payload(overrides: Partial<DiagnosticsPayload> = {}) {
  return {
    backfill: {
      artifactLinks: { lastScannedAt: null, totalScanned: 4 },
      prBackfill: { lastScannedAt: null, totalScanned: 7 },
    },
    linkStats: [{ count: 3, method: "pr-body", relation: "implements" }],
    linkTotals: { linkedArtifacts: 2, linkedSessions: 1, totalLinks: 3 },
    repos: [
      {
        defaultBranch: "main",
        gitDir: "/tmp/one/.git",
        id: "repo-1",
        lastSeenAt: "2026-09-11T10:00:00.000Z",
        remoteUrl: null,
        repoFullName: "acme/one",
        worktreeCount: 2,
      },
    ],
    ...overrides,
  } as DiagnosticsPayload;
}

function source(overrides: Partial<DiagnosticsSource> = {}): DiagnosticsSource {
  return {
    autoRefresh: { enabled: true, toggle: vi.fn() },
    availableSections: [],
    errorMessage: null,
    onSectionChange: vi.fn(),
    payload: payload(),
    refresh: { busy: false, run: vi.fn() },
    settledSections: [DiagnosticsSectionId.Withheld],
    status: DiagnosticsTransportStatus.Ready,
    unservableReason: null,
    ...overrides,
  };
}

function renderSurface(overrides: Partial<DiagnosticsSource> = {}) {
  return render(
    <DiagnosticsSurfaceV2
      coverageAxisLabels={AXIS_LABELS}
      description={DIAGNOSTICS_SURFACE_DESCRIPTION}
      logs={<div data-testid={LOGS_MARKER} />}
      source={source(overrides)}
      title="Diagnostics"
    />
  );
}

function tabLabels(): string[] {
  return screen
    .getAllByRole("tab")
    .map((tab) => tab.textContent ?? "")
    .map((text) => text.trim());
}

describe("DiagnosticsSurfaceV2 — navigation", () => {
  it("renders every section the host offers, in the surface's own order", () => {
    renderSurface({
      availableSections: [
        DiagnosticsSectionId.Withheld,
        DiagnosticsSectionId.Coverage,
      ],
    });

    expect(tabLabels()).toStrictEqual(EXPECTED_TABS_ALL_SECTIONS);
  });

  it("hides only the optional sections a host does not offer", () => {
    renderSurface({ availableSections: [] });

    expect(tabLabels()).toStrictEqual(EXPECTED_TABS_BASE);
  });

  it("places the host's log reader under Gateway Logs", async () => {
    renderSurface();

    await userEvent.click(screen.getByRole("tab", { name: "Gateway Logs" }));

    // The sibling of the absence assertion below. Radix unmounts inactive tab
    // content, so the marker is absent on every other case in this file —
    // without this, "the logs node is absent" would pass on a surface that
    // never placed it at all.
    expect(screen.getByTestId(LOGS_MARKER)).toBeTruthy();
  });

  it("drops the Gateway Logs tab when the host supplies no log reader", () => {
    render(
      <DiagnosticsSurfaceV2
        coverageAxisLabels={AXIS_LABELS}
        description={DIAGNOSTICS_SURFACE_DESCRIPTION}
        logs={null}
        source={source()}
        title="Diagnostics"
      />
    );

    expect(tabLabels()).toStrictEqual(["Repos", "Backfill", "Links"]);
    expect(screen.queryByTestId(LOGS_MARKER)).toBeNull();
  });

  it("tells the host which section the reader moved to, so it can shape its probe", async () => {
    const onSectionChange = vi.fn();
    renderSurface({
      availableSections: [DiagnosticsSectionId.Coverage],
      onSectionChange,
      settledSections: [
        DiagnosticsSectionId.Withheld,
        DiagnosticsSectionId.Coverage,
      ],
    });

    await userEvent.click(screen.getByRole("tab", { name: "Coverage" }));

    expect(onSectionChange).toHaveBeenCalledWith(DiagnosticsSectionId.Coverage);
  });
});

describe("DiagnosticsSurfaceV2 — a malformed payload degrades instead of crashing", () => {
  /**
   * ISS-10004 AC2. The pair is the point: the SIBLING below renders the same
   * section from a WELL-FORMED payload and asserts the real table. Without it,
   * "the malformed notice is absent" would be satisfied by a loading skeleton, an
   * empty fixture, or an error boundary that swallowed something unrelated — and
   * "did not crash" is not observable on its own.
   */
  it("renders the Links table from a well-formed payload", async () => {
    renderSurface();

    await userEvent.click(screen.getByRole("tab", { name: "Links" }));

    expect(screen.getByText("Links by Method")).toBeTruthy();
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID)
    ).toBeNull();
  });

  it("refuses one unreadable section and keeps every other one rendering", async () => {
    // `linkTotals` absent: the superseded body reads `linkTotals.totalLinks`
    // during render, so this exact payload is what took the page down.
    renderSurface({
      payload: payload({ linkTotals: undefined }) as DiagnosticsPayload,
    });

    await userEvent.click(screen.getByRole("tab", { name: "Links" }));

    const notice = screen.getByTestId(DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID);
    expect(within(notice).getByText("Links could not be read")).toBeTruthy();
    // The shell is still standing AND the intact section still answers.
    await userEvent.click(screen.getByRole("tab", { name: "Repos" }));
    expect(screen.getByText("acme/one")).toBeTruthy();
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID)
    ).toBeNull();
  });

  it("keeps a malformed payload apart from a failed probe", () => {
    renderSurface({
      errorMessage: "diagnostics table missing",
      payload: null,
      status: DiagnosticsTransportStatus.Unavailable,
    });

    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID).textContent
    ).toContain("diagnostics table missing");
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID)
    ).toBeNull();
  });
});

describe("DiagnosticsSurfaceV2 — actions and the optional read", () => {
  it("re-runs the host's probe and reports it as busy while it is in flight", async () => {
    const run = vi.fn();
    const { rerender } = renderSurface({ refresh: { busy: false, run } });

    await userEvent.click(
      screen.getByRole("button", { name: REFRESH_BUTTON_NAME })
    );
    expect(run).toHaveBeenCalledTimes(1);

    rerender(
      <DiagnosticsSurfaceV2
        coverageAxisLabels={AXIS_LABELS}
        description={DIAGNOSTICS_SURFACE_DESCRIPTION}
        logs={<div data-testid={LOGS_MARKER} />}
        source={source({ refresh: { busy: true, run } })}
        title="Diagnostics"
      />
    );
    expect(
      screen
        .getByRole("button", { name: REFRESH_BUTTON_NAME })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("holds a skeleton for an optional section the settled probe did not ask for", async () => {
    renderSurface({
      availableSections: [DiagnosticsSectionId.Coverage],
      settledSections: [DiagnosticsSectionId.Withheld],
    });

    await userEvent.click(screen.getByRole("tab", { name: "Coverage" }));

    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID)
    ).toBeTruthy();
    // NOT the section's own "could not read" claim, which would state a
    // measurement failure about a load still in progress.
    expect(screen.queryByText("Coverage unavailable")).toBeNull();
  });

  it("shows the section's unavailable claim once a probe that asked has settled", async () => {
    renderSurface({
      availableSections: [DiagnosticsSectionId.Coverage],
      settledSections: [
        DiagnosticsSectionId.Withheld,
        DiagnosticsSectionId.Coverage,
      ],
    });

    await userEvent.click(screen.getByRole("tab", { name: "Coverage" }));

    expect(screen.getByText("Coverage unavailable")).toBeTruthy();
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID)
    ).toBeNull();
  });

  /**
   * marisolashgrove review: Withheld was listed as an optional read it is not —
   * `getDiagnosticsData` fetches it on every call. The desktop host hid that by
   * seeding `settledSections` with Withheld unconditionally, so the bug was
   * invisible until a SECOND host built its list from
   * `DIAGNOSTICS_OPTIONAL_READ_SECTION_IDS` and stranded the section on a
   * skeleton forever. An empty `settledSections` is that host.
   */
  it("renders Withheld immediately, with nothing settled", async () => {
    renderSurface({
      availableSections: [DiagnosticsSectionId.Withheld],
      settledSections: [],
    });

    await userEvent.click(screen.getByRole("tab", { name: "Withheld" }));

    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID)
    ).toBeNull();
  });

  /** Coverage still gates on the same empty list, so the case above is specific. */
  it("still holds Coverage on a skeleton with nothing settled", async () => {
    renderSurface({
      availableSections: [DiagnosticsSectionId.Coverage],
      settledSections: [],
    });

    await userEvent.click(screen.getByRole("tab", { name: "Coverage" }));

    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID)
    ).toBeTruthy();
  });
});

describe("DiagnosticsSurfaceV2 — the transport states stay apart", () => {
  it("shows a skeleton, and no failure claim, while the first probe is in flight", () => {
    renderSurface({
      payload: null,
      refresh: { busy: true, run: vi.fn() },
      status: DiagnosticsTransportStatus.Loading,
    });

    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID)
    ).toBeTruthy();
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID)
    ).toBeNull();
  });

  it("keeps the last good reading beneath a failed refresh", () => {
    renderSurface({
      errorMessage: "store is locked",
      status: DiagnosticsTransportStatus.Unavailable,
    });

    // Both at once: blanking the page a reader was sent to is the worse of the
    // two, and a notice with nothing under it is indistinguishable from a crash.
    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID)
    ).toBeTruthy();
    expect(screen.getByText("acme/one")).toBeTruthy();
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID)
    ).toBeNull();
  });

  it("offers Pause while the host is polling and Resume once it is not", async () => {
    const toggle = vi.fn();
    const { rerender } = renderSurface({
      autoRefresh: { enabled: true, toggle },
    });

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(toggle).toHaveBeenCalledTimes(1);

    rerender(
      <DiagnosticsSurfaceV2
        coverageAxisLabels={AXIS_LABELS}
        description={DIAGNOSTICS_SURFACE_DESCRIPTION}
        logs={<div data-testid={LOGS_MARKER} />}
        source={source({ autoRefresh: { enabled: false, toggle } })}
        title="Diagnostics"
      />
    );
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("offers no polling control to a host that does not poll", () => {
    render(
      <DiagnosticsSurfaceV2
        coverageAxisLabels={AXIS_LABELS}
        description={DIAGNOSTICS_SURFACE_DESCRIPTION}
        logs={null}
        source={source({ autoRefresh: null })}
        title="Diagnostics"
      />
    );

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    // A control that is merely missing looks the same as one that never worked;
    // the surface still offers the command this host CAN honour.
    expect(
      screen.getByRole("button", { name: REFRESH_BUTTON_NAME })
    ).toBeTruthy();
  });
});

/**
 * ISS-10006 — a host that can never serve section data, which is the browser.
 *
 * Every assertion here is paired: the absence of the empty/loading/refresh
 * render is only meaningful beside a POSITIVE assertion on the same locator in
 * the servable case, because "nothing is shown" is satisfied by the skeleton, by
 * an empty fixture, by the transport notice and by an error boundary alike.
 */
const UNSERVABLE_REASON =
  "It is read from the gateway store on the machine that runs your agents.";

function unservableSource(overrides: Partial<DiagnosticsSource> = {}) {
  return {
    autoRefresh: null,
    availableSections: [
      DiagnosticsSectionId.Withheld,
      DiagnosticsSectionId.Coverage,
    ],
    errorMessage: "This browser has no record of them.",
    payload: null,
    status: DiagnosticsTransportStatus.Unavailable,
    unservableReason: UNSERVABLE_REASON,
    ...overrides,
  } satisfies Partial<DiagnosticsSource>;
}

describe("DiagnosticsSurfaceV2 — a host that cannot serve the sections", () => {
  it("names the section it cannot serve instead of rendering an empty body", () => {
    renderSurface(unservableSource());

    const notice = screen.getByTestId(
      DIAGNOSTICS_SURFACE_V2_UNSERVABLE_TEST_ID
    );
    expect(
      within(notice).getByText("Repos is not collected here")
    ).toBeTruthy();
    expect(within(notice).getByText(UNSERVABLE_REASON)).toBeTruthy();
  });

  it("keeps saying it on an OPTIONAL section, rather than dropping the tab", async () => {
    renderSurface(unservableSource());

    await userEvent.click(screen.getByRole("tab", { name: "Coverage" }));

    // On the PANEL, not on the document: "no empty body" is the claim, and a
    // document-wide query would be satisfied by the notice on another tab.
    expect(
      within(screen.getByRole("tabpanel")).getByTestId(
        DIAGNOSTICS_SURFACE_V2_UNSERVABLE_TEST_ID
      )
    ).toBeTruthy();
    expect(screen.getByText("Coverage is not collected here")).toBeTruthy();
  });

  it("offers no Refresh, while a servable host with the same status still does", () => {
    const { unmount } = renderSurface(unservableSource());
    expect(
      screen.queryByRole("button", { name: REFRESH_BUTTON_NAME })
    ).toBeNull();
    unmount();

    // The paired positive: same Unavailable status, same null payload, and the
    // ONLY difference is that this host owns a probe worth re-running.
    renderSurface(unservableSource({ unservableReason: null }));
    expect(
      screen.getByRole("button", { name: REFRESH_BUTTON_NAME })
    ).toBeTruthy();
  });

  it("still carries the route-level transport notice, and leaves a servable host's sections alone", () => {
    const { unmount } = renderSurface(unservableSource());
    // Both notices, together: the route one says where diagnostics live, the
    // section one says this section is not among them.
    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID)
    ).toBeTruthy();
    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_UNSERVABLE_TEST_ID)
    ).toBeTruthy();
    unmount();

    // A host with a probe keeps its sections: same locator, opposite condition,
    // which is what makes the presence above a statement about `unservableReason`
    // and not about the surface always rendering it.
    renderSurface();
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_UNSERVABLE_TEST_ID)
    ).toBeNull();
  });
});
