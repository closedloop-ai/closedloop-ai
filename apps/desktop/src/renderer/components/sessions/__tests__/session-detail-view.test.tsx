import { AgentComponentInvocationAnchorKind } from "@repo/api/src/types/agent-component-invocation";
import {
  type AgentSessionAnalytics,
  type AgentSessionDetail,
  type AgentSessionListResponse,
  AgentSessionState,
  type AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { DocumentType } from "@repo/api/src/types/document";
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import {
  EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
  expectExactClaudeCodePropertyLabels,
} from "@repo/app/agents/components/detail/__tests__/property-label-contract";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectLocalLinkedArtifacts } from "../../../../main/session/local-linked-artifacts";
import {
  DEFAULT_WEB_APP_ORIGIN,
  DesktopAuthStatus,
} from "../../../../shared/contracts";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "../SessionDetailView";
import { sessionDetail } from "./fixtures/session-detail-fixture";

const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

const MERGED_PR_LINK_NAME = "1686merged";
const JUMP_TO_FAILURES_NAME = /jump to failures & limits/i;
const JUMP_TO_ACTIVITY_BUCKET_NAME = /jump to activity bucket/i;
const PERCENT_STYLE_VALUE_REGEX = /\d+(?:\.\d+)?%/;
const SHOW_COMMENTS_BUTTON_NAME = /show comments panel/i;
// ISS-4793: the linked-artifact pill must NOT resolve as a link on desktop.
const LINKED_ARTIFACT_SLUG_RE = /ISS-4544/;
// ISS-5617: the `+N` overflow chip's accessible name (`overflowChipAccessibleName`),
// which must NOT appear for a single-pill row whose producer omitted a total.
const LINKED_ARTIFACT_OVERFLOW_NAME_RE = /more linked artifact/i;
/**
 * ISS-4688 / ISS-5131: the window of the legacy no-`wallClock` fixture and the
 * span both desktop Duration surfaces must render for it. Same 4h 54m as the web
 * parity fixtures (`e2e/helpers/session-duration-parity-fixtures.ts`), so the two
 * adapters are pinned to one number.
 */
const LEGACY_STARTED_AT = "2026-06-10T10:00:00.000Z";
const LEGACY_ENDED_AT = "2026-06-10T14:54:00.000Z";
const LEGACY_SPAN = "4h 54m";

/**
 * ISS-5131 (#4409 review): the Duration row of a RUNNING session — ONE measure,
 * measured to `now()`. Pins the row's shape without pinning a number that moves
 * with the clock.
 */
const RUNNING_DURATION_ROW_PATTERN = /^\d+h \d+m$/;

/**
 * The retired decomposition. `active` and `waitingUser` are the collector's
 * turn-gap projection, clamped to a window anchored on LAST ACTIVITY, so beside
 * the corrected headline a component could exceed the total next to it. The
 * desktop renderer mounts the same shared row as the web app, so it is pinned
 * here too — a regression that put them back would show up on both surfaces.
 */
const RETIRED_DURATION_SUB_FACTS = /active|waiting on you|idle|wall/i;

describe("Desktop SessionDetailView wrapper", () => {
  beforeEach(() => {
    searchParamsMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
    installDesktopApi();
  });

  afterEach(() => {
    // `installDesktopIdentity` spies on `navigator.onLine`; restore it so the
    // pinned-offline state cannot leak into the tests that follow.
    vi.restoreAllMocks();
  });

  it("threads a hash-query invocation anchor to the exact local trace row", async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams({
        invocationAnchor: JSON.stringify({
          kind: AgentComponentInvocationAnchorKind.UserTurn,
          userTurnId: "desktop-turn-1",
        }),
      })
    );

    const { container } = renderSessionDetail("anchored-session");

    expect(await screen.findByText("Anchored prompt")).toBeDefined();
    expect(
      container.querySelector('[data-invocation-anchor-target="true"]')
        ?.textContent
    ).toContain("Anchored prompt");
  });

  // ISS-4793 / ISS-4898: the renderer still hosts no document detail routes, so
  // it never emits an IN-APP href for a linked artifact — the nav guard would
  // silently drop a click on an unmapped /issues/ one, making the pill a UI that
  // lies. ISS-4898 gives it an EXTERNAL destination instead, but only once BOTH
  // preconditions resolve: an org slug on the identity payload and a configured
  // web-app origin. Without a slug (an older server that omits
  // `organizationSlug`, or an identity fetch that has not settled) there is no
  // org-scoped URL to build and the pills must stay inert rather than link to a
  // path with a missing segment. The base desktop-api stub exposes no identity
  // bridge, which is exactly that state — the pill is present, so the
  // relationship is still surfaced, and it is not an anchor of any kind.
  it("keeps linked artifacts inert when no org slug is known", async () => {
    const { container } = renderLinkedArtifactsSessionDetail();

    expect(
      await screen.findByRole("heading", { name: "Linked Artifacts Session" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));

    expect(screen.getByText("Linked artifacts")).toBeDefined();
    const pill = screen.getByText("ISS-4544").closest(".sd3-result-pr");
    expect(pill).not.toBeNull();
    expect(pill?.tagName).toBe("SPAN");
    expect(container.querySelectorAll("a[href*='/issues/']").length).toBe(0);
    expect(
      screen.queryByRole("link", { name: LINKED_ARTIFACT_SLUG_RE })
    ).toBeNull();
  });

  // ISS-4898 positive path: with an org slug on the identity payload AND a
  // resolved origin, the wrapper composes an ABSOLUTE web-app URL and the shared
  // row renders it as an external anchor — which is what the Electron
  // window-open handler turns into an OS-browser open. An in-app href here would
  // be dropped by the nav guard, so `target="_blank"` on an absolute URL is the
  // contract.
  it("links a linked artifact to the web app when an org slug is known", async () => {
    installDesktopIdentity("acme");

    renderLinkedArtifactsSessionDetail();

    expect(
      await screen.findByRole("heading", { name: "Linked Artifacts Session" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));

    const pill = await screen.findByRole("link", {
      name: LINKED_ARTIFACT_SLUG_RE,
    });
    expect(pill.getAttribute("href")).toBe(
      `${DEFAULT_WEB_APP_ORIGIN}/acme/issues/ISS-4544`
    );
    // `target="_blank"` on an ABSOLUTE url is the contract: that is what the
    // Electron window-open handler intercepts and hands to the OS browser.
    expect(pill.getAttribute("target")).toBe("_blank");
    expect(pill.getAttribute("rel")).toBe("noreferrer");
  });

  // ISS-5617: the same pill, on the same rendered screen, from the DESKTOP-LOCAL
  // producer's shape rather than the cloud's. Local mode never showed this row at
  // all — `mapDetail` populated no `linkedArtifacts`, so the shared row took its
  // `length === 0` branch and a run that listed its artifacts on web listed none
  // on the desktop.
  //
  // Asserted against the cloud-shaped case's OWN rendered href rather than a
  // constant: the two producers disagree on `id` (a UUID vs the slug), on `name`
  // (a title vs null) and on `linkedArtifactsTotal` (present vs omitted), and
  // checking each independently against a literal would let one drift while both
  // tests stayed green. Rendering both and comparing is what makes this a parity
  // assertion.
  it("renders the desktop-local producer's linked artifact as the same pill the cloud shape renders", async () => {
    installDesktopIdentity("acme");

    const cloudShaped = render(
      <DesktopAppCoreProvider>
        <NavigationProvider
          adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
        >
          <SessionDetailView
            backHref="/sessions"
            sessionId="linked-artifacts-session"
          />
        </NavigationProvider>
      </DesktopAppCoreProvider>
    );
    expect(
      await screen.findByRole("heading", { name: "Linked Artifacts Session" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    const cloudHref = (
      await screen.findByRole("link", { name: LINKED_ARTIFACT_SLUG_RE })
    ).getAttribute("href");
    cloudShaped.unmount();

    render(
      <DesktopAppCoreProvider>
        <NavigationProvider
          adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
        >
          <SessionDetailView
            backHref="/sessions"
            sessionId="local-linked-artifacts-session"
          />
        </NavigationProvider>
      </DesktopAppCoreProvider>
    );
    expect(
      await screen.findByRole("heading", {
        name: "Local Linked Artifacts Session",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));

    // The row exists at all — the whole defect was that it did not.
    expect(screen.getByText("Linked artifacts")).toBeDefined();
    const localPill = await screen.findByRole("link", {
      name: LINKED_ARTIFACT_SLUG_RE,
    });
    expect(localPill.getAttribute("href")).toBe(cloudHref);
    expect(localPill.getAttribute("target")).toBe("_blank");
    // No `+N` overflow chip: one link, and the omitted `linkedArtifactsTotal`
    // must degrade to the served length rather than imply a truncated set.
    expect(
      screen.queryByRole("button", {
        name: LINKED_ARTIFACT_OVERFLOW_NAME_RE,
      })
    ).toBe(null);
  });

  // ISS-4898 (wongk + codex review): the org slug is not the only precondition.
  // A pending or FAILED settings read leaves the configured web-app origin
  // unknown, and guessing production there is how a stage org slug ended up in
  // an allowlisted production URL. With the slug known but the origin
  // unresolved, the pill must stay an inert label.
  it("keeps linked artifacts inert when the settings read cannot resolve an origin", async () => {
    installDesktopIdentity("acme");
    Object.assign(window.desktopApi, {
      getSettings: vi.fn(() => Promise.reject(new Error("settings ipc down"))),
    });

    const { container } = renderLinkedArtifactsSessionDetail();

    expect(
      await screen.findByRole("heading", { name: "Linked Artifacts Session" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));

    const pill = screen.getByText("ISS-4544").closest(".sd3-result-pr");
    expect(pill?.tagName).toBe("SPAN");
    expect(container.querySelectorAll("a[href*='/issues/']").length).toBe(0);
    expect(
      screen.queryByRole("link", { name: LINKED_ARTIFACT_SLUG_RE })
    ).toBeNull();
  });

  it("guards the FEA-1928 exact property-label contract with negative controls", () => {
    expectExactClaudeCodePropertyLabels([
      ...EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
    ]);

    expect(() =>
      expectExactClaudeCodePropertyLabels([
        ...EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
        "Compute target",
      ])
    ).toThrow();
    expect(() =>
      expectExactClaudeCodePropertyLabels(
        EXPECTED_CLAUDE_CODE_PROPERTY_LABELS.filter((label) => label !== "Cost")
      )
    ).toThrow();
  });

  it("renders local pending and blocked details without unsupported write surfaces", async () => {
    const { rerender } = renderSessionDetail("pending-session");

    expect(await screen.findByRole("heading", { name: "Pending Session" }));
    expect(screen.getAllByText("closedloop-ai/symphony-alpha").length).toBe(1);
    expect(screen.getAllByText("$0.01").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    const propertyLabels = Array.from(
      document.querySelectorAll(".prd-prop-label"),
      (label) => label.textContent ?? ""
    );
    expectExactClaudeCodePropertyLabels(propertyLabels);
    expect(
      screen.getByText("feat/fea-1943-session-details-local-data")
    ).toBeDefined();
    expect(screen.queryByText("Compute target")).toBeNull();
    expect(screen.queryByText("Project")).toBeNull();
    expect(screen.queryByText("Worktree")).toBeNull();
    expect(screen.queryByText("Base branch")).toBeNull();
    expect(screen.queryByText("Source artifact")).toBeNull();
    expect(screen.queryByText("Source loop")).toBeNull();
    expect(screen.queryByText("Files changed")).toBeNull();
    expect(screen.queryByText("Local Desktop")).toBeNull();
    expect(screen.queryByText("/tmp/symphony-alpha")).toBeNull();
    expect(
      screen.getByRole("link", { name: MERGED_PR_LINK_NAME })
    ).toBeDefined();
    expect(screen.getByText("+12")).toBeDefined();
    expect(screen.getByText("-2")).toBeDefined();
    // ISS-5131 (#4409 review): the Duration row prints ONE measure. This fixture
    // is a RUNNING session, so its value is measured to `now()` and is not a
    // fixed string — the row's SHAPE is what this test owns, plus the absence of
    // the retired decomposition. The value itself is pinned deterministically by
    // the legacy (terminal) fixture below and by the shared `packages/app`
    // coverage.
    expect(durationRowText()).toMatch(RUNNING_DURATION_ROW_PATTERN);
    expect(durationRowText()).not.toMatch(RETIRED_DURATION_SUB_FACTS);
    expect(
      screen.getByText("10 in | 20 out | 3 cache read | 4 cache write")
    ).toBeDefined();
    expect(screen.getByText("3 turns | 7 tool calls | 1 steers")).toBeDefined();
    // FEA-3781: thresholds recalibrated to 70/35 against the distribution the
    // attended-time score actually produces, so a score of 82 reads as "High"
    // (min 70) again. Tier is a pure function of the stored score — see
    // AUTONOMY_TIER_MIN_SCORE.
    expect(screen.getByText("High autonomy | 82/100")).toBeDefined();
    // FEA-4233: these sessions have zero trace comments, so once the discovery
    // read settles empty the rail folds to its slim re-open handle rather than an
    // open panel. The point of this spec is the absence of write surfaces, not
    // the rail — assert the collapsed handle, not the open "Comments" panel.
    expect(
      await screen.findByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeDefined();
    expect(document.querySelector(".sd3-cmts")).toBeNull();

    rerender(
      withProviders(
        <SessionDetailView backHref="/sessions" sessionId="blocked-session" />
      )
    );

    expect(await screen.findByRole("heading", { name: "Blocked Session" }));
    expect(
      await screen.findByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeDefined();
    expect(document.querySelector(".sd3-cmts")).toBeNull();

    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "pending-session"
    );
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "blocked-session"
    );
  });

  it("renders a red failures and limits marker from desktop-visible throttles", async () => {
    renderSessionDetail("throttled-session");

    expect(await screen.findByRole("heading", { name: "Throttled Session" }));
    expect(screen.getByText("Session Timeline")).toBeDefined();
    expect(screen.getByText("Session Trace")).toBeDefined();

    const limitMarkers = screen.getAllByRole("button", {
      name: JUMP_TO_FAILURES_NAME,
    });
    expect(
      limitMarkers.some((marker) => marker.className.includes("d-r"))
    ).toBe(true);
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "throttled-session"
    );
  });

  it("moves the shared session timeline tracker on the first clicked bucket", async () => {
    renderSessionDetail("throttled-session");

    expect(await screen.findByRole("heading", { name: "Throttled Session" }));

    const bucketButtons = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    expect(bucketButtons.length).toBeGreaterThan(1);

    fireEvent.click(bucketButtons[1]!);

    expect(
      document.querySelector<HTMLElement>(".sd3-bars2-wrap .tl-here")?.style
        .left
    ).toMatch(PERCENT_STYLE_VALUE_REGEX);
  });

  // FEA-4233: the desktop renderer shares the comments rail through @repo/app.
  // The local IPC trace-comments source resolves an empty list for these
  // fixtures, so the rail must settle empty and fold to its slim re-open handle
  // rather than front-loading an empty 360px panel — the same empty-default the
  // web suite covers, exercised through the desktop data source.
  it("folds the comments rail to the slim handle for a zero-comment desktop session", async () => {
    renderSessionDetail("anchored-session");

    expect(await screen.findByText("Anchored prompt")).toBeDefined();

    // Once the desktop discovery read settles empty, the full rail is gone and
    // only the slim re-open handle remains.
    expect(
      await screen.findByRole("button", { name: SHOW_COMMENTS_BUTTON_NAME })
    ).toBeDefined();
    expect(document.querySelector(".sd3-cmts")).toBeNull();
    expect(screen.queryByText("No trace comments yet")).toBeNull();
  });

  // ISS-4688 (wongk review) / ISS-5131: the Electron adapter's half of the
  // Duration parity regression. `packages/app` is mounted by both adapters, so
  // the row is pinned on each: with the collector's triple absent the Properties
  // row must still lead with the session's own measured span rather than
  // collapsing to an em-dash while the Sessions LIST cell shows a number.
  it("leads the Duration row with the session's own span, matching the list cell, for a legacy session carrying no wallClock", async () => {
    renderSessionDetail("legacy-no-wallclock-session");

    expect(
      await screen.findByRole("heading", {
        name: "Legacy No WallClock Session",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));

    // `LEGACY_SPAN` is the SAME value the list-cell mapper resolves for this
    // shape (`agentSessionToSessionTableRow`, pinned in
    // `packages/app/agents/components/detail/__tests__/detail-content.test.ts`),
    // so the desktop list and the desktop detail cannot contradict each other.
    // The mapper is not imported here: the desktop vitest resolver cannot follow
    // `session-table-row.ts`'s extension-less `@repo/app/...` subpath imports, so
    // pulling it in aborts this whole suite at load time.
    expect(durationRowText()).toContain(LEGACY_SPAN);
    // #4409: no qualifier and no sub-facts — one measure, on both adapters.
    expect(durationRowText()).not.toMatch(RETIRED_DURATION_SUB_FACTS);
  });
});

/**
 * ISS-4688 / ISS-5131: the legacy / version-skewed session shape — the
 * collector's whole trace-duration triple absent, over a 4h 54m window (the
 * SES-74818 span the web parity fixtures use). Built by one factory so the
 * detail served to the renderer and the row handed to the list mapper are the
 * SAME session; a second literal is how the two halves of the parity assertion
 * drift apart.
 *
 * ISS-5131: the Duration is measured from the session's own `endedAt`, so this
 * fixture carries one. `lastActivityAt` is deliberately set LATER than it — the
 * sync-time shape from the reported defect — so a regression that reads the
 * activity timestamp renders a visibly different number.
 */
function legacyNoWallClockSession(): AgentSessionDetail {
  return sessionDetail({
    id: "legacy-no-wallclock-session",
    name: "Legacy No WallClock Session",
    overrides: {
      activeAgent: null,
      endedAt: new Date(LEGACY_ENDED_AT),
      lastActivityAt: new Date("2026-06-16T09:00:00.000Z"),
      startedAt: new Date(LEGACY_STARTED_AT),
      updatedAt: new Date("2026-06-16T09:30:00.000Z"),
      waitingUser: null,
      wallClock: null,
    },
    state: AgentSessionState.Completed,
    status: "inactive",
  });
}

function renderSessionDetail(sessionId: string) {
  return render(
    withProviders(
      <SessionDetailView backHref="/sessions" sessionId={sessionId} />
    )
  );
}

function withProviders(ui: React.ReactElement) {
  return <DesktopAppCoreProvider>{ui}</DesktopAppCoreProvider>;
}

function installDesktopApi() {
  const details: Record<string, AgentSessionDetail> = {
    "anchored-session": sessionDetail({
      id: "anchored-session",
      name: "Anchored Session",
      overrides: {
        turnItems: [
          {
            _row: 0,
            actor: {
              color: "#000",
              human: "Ada",
              name: "Ada",
              sessionId: "anchored-session",
            },
            cum: 0,
            t: "2026-01-01T00:00:00.000Z",
            tMs: Date.parse("2026-01-01T00:00:00.000Z"),
            text: "Anchored prompt",
            transcriptIdentity: { userTurnId: "desktop-turn-1" },
            type: "prompt",
          },
        ],
      },
      state: AgentSessionState.Running,
      status: "active",
    }),
    "blocked-session": sessionDetail({
      id: "blocked-session",
      name: "Blocked Session",
      state: AgentSessionState.Blocked,
      status: "failed",
    }),
    // ISS-4688: a LEGACY / version-skewed session — the collector's whole
    // trace-duration triple is absent, so the Duration row has no headline to
    // lead with and must reach the shared calendar fallback. Its own session
    // rather than an override on `pending-session`, whose Properties pane is
    // pinned to an EXACT label list by the FEA-1928 contract test.
    "legacy-no-wallclock-session": legacyNoWallClockSession(),
    "pending-session": sessionDetail({
      id: "pending-session",
      name: "Pending Session",
      state: AgentSessionState.PendingApproval,
      status: "active",
    }),
    // ISS-4793: its own session rather than an override on `pending-session`,
    // whose Properties pane is pinned to an EXACT label list by the FEA-1928
    // contract test — a linked artifact adds a "Linked artifacts" row and would
    // break that unrelated guard. The link is a resolvable FEATURE: on the web
    // shell this exact shape renders <a href="/<org>/issues/ISS-4544">, so the
    // desktop assertion below is a real cross-adapter difference, not a data gap.
    "linked-artifacts-session": sessionDetail({
      id: "linked-artifacts-session",
      name: "Linked Artifacts Session",
      overrides: {
        linkedArtifacts: [
          {
            documentType: DocumentType.Feature,
            id: "linked-iss-4544",
            name: "E2E: enable merge queue on main",
            role: "referenced",
            slug: "ISS-4544",
          },
        ],
        linkedArtifactsTotal: 1,
      },
      state: AgentSessionState.Running,
      status: "active",
    }),
    // ISS-5617: the SAME artifact, shaped by the DESKTOP-LOCAL producer instead
    // of the cloud one. `linkedArtifacts` is built by running the real
    // `projectLocalLinkedArtifacts` over the refs a local session carries, so
    // this fixture cannot drift from what the local detail actually emits — a
    // hand-copied shape would keep passing after the producer changed. The local
    // producer resolves no artifact UUID and no title, and emits no
    // `linkedArtifactsTotal`; the case below proves that thinner shape still
    // renders the same pill, on the same screen, as the cloud-shaped session.
    "local-linked-artifacts-session": sessionDetail({
      id: "local-linked-artifacts-session",
      name: "Local Linked Artifacts Session",
      overrides: {
        linkedArtifacts: projectLocalLinkedArtifacts([
          {
            isPrimary: false,
            kind: ArtifactRefTargetKind.ClosedloopArtifact,
            method: ArtifactRefMethod.SlugInMessage,
            slug: "ISS-4544",
          },
        ]),
      },
      state: AgentSessionState.Running,
      status: "active",
    }),
    "throttled-session": sessionDetail({
      id: "throttled-session",
      name: "Throttled Session",
      overrides: {
        throttles: [
          {
            durMin: 5,
            t0: "12:08:00",
            t1: "12:13:00",
            tl: 1,
            x0: 50,
          },
        ],
        turnItems: throttledTurnItems("throttled-session"),
      },
      state: AgentSessionState.Blocked,
      status: "failed",
    }),
  };

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(async () => agentSessionAnalytics()),
        detail: vi.fn(async (id: string) => details[id] ?? null),
        list: vi.fn(async () => agentSessionList()),
        usage: vi.fn(async () => agentSessionUsage()),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      // FEA-4233: the local IPC trace-comments sink. Without it the shared
      // comments-rail discovery read (`createDesktopTraceCommentsDataSource` ->
      // `desktopApi.traceCommentsApi.list`) rejects, so the desktop rail never
      // reaches settled-empty and this suite never exercises the empty default.
      // A resolving `list` lets the rail settle and fold to the slim handle.
      traceCommentsApi: {
        create: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(async () => []),
        reply: vi.fn(),
        update: vi.fn(),
      },
    },
  });
}

function throttledTurnItems(
  sessionId: string
): NonNullable<AgentSessionDetail["turnItems"]> {
  const agentActor = {
    color: "var(--primary)",
    harness: "codex",
    human: null,
    name: "gpt-test",
    sessionId,
  };
  const humanActor = {
    color: "hsl(210 65% 45%)",
    human: "Ada Lovelace",
    name: null,
    sessionId,
  };

  return [
    {
      _row: 0,
      actor: humanActor,
      cum: 0,
      t: "2026-01-01T00:01:00.000Z",
      tMs: Date.parse("2026-01-01T00:01:00.000Z"),
      text: "Investigate the desktop-visible throttle marker.",
      type: "prompt",
    },
    {
      _row: 1,
      actor: agentActor,
      cum: 0.01,
      model: "gpt-test",
      t: "2026-01-01T00:08:00.000Z",
      tMs: Date.parse("2026-01-01T00:08:00.000Z"),
      text: "The provider reported a temporary limit and the session resumed.",
      type: "say",
    },
    {
      text: "Session stopped after the limit evidence was captured.",
      type: "end",
    },
  ];
}

function agentSessionList(): AgentSessionListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: "self",
  };
}

function agentSessionUsage(): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 0,
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    latestSessionAt: null,
    lastSyncTargets: [],
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSessions: 0,
    viewerScope: "self",
  };
}

function agentSessionAnalytics(): AgentSessionAnalytics {
  return {
    byAgentType: [],
    byProject: [],
    byRepository: [],
    byTool: [],
    viewerScope: "self",
  };
}

/**
 * FEA-4275: the composed text of the Properties "Duration" row's value. The
 * wall/active/"waiting on you" components render as separate fragments (with an
 * em-dash empty for absent ones), so the whole row's value text is asserted
 * rather than a single `getByText` node.
 */
function durationRowText(): string {
  const row = Array.from(document.querySelectorAll(".prd-prop")).find(
    (element) =>
      element.querySelector(".prd-prop-label")?.textContent === "Duration"
  );
  const label = row?.querySelector(".prd-prop-label")?.textContent ?? "";
  return (row?.textContent ?? "").slice(label.length).trim();
}

/**
 * ISS-4898: the linked-artifacts session detail. Mounts the navigation port the
 * desktop shell always provides in production — an authenticated renderer
 * resolves the cloud app-core stack, whose detail chrome links through
 * `@repo/navigation`.
 *
 * The three cases above differ ONLY in what `installDesktopApi` /
 * `installDesktopIdentity` expose (no identity bridge, slug but no origin, both),
 * so this one mount helper is what makes them a real precondition matrix rather
 * than three separately-composed renders.
 */
function renderLinkedArtifactsSessionDetail() {
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider
        adapter={createMemoryNavigation({ initialPath: "/sessions" }).adapter}
      >
        <SessionDetailView
          backHref="/sessions"
          sessionId="linked-artifacts-session"
        />
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

/**
 * ISS-4898: add the auth + identity bridges to the `window.desktopApi` stub so
 * the renderer resolves an org slug. Layered on top of `installDesktopApi` (the
 * base stub deliberately omits both, which is the "no slug known" state the
 * inert-pill cases above assert).
 */
function installDesktopIdentity(organizationSlug: string) {
  // Authenticated + ONLINE would flip `DesktopAppCoreProvider` to the cloud
  // stack, whose session read goes over the D-G fetch bridge rather than the
  // local `agentSessionsApi` stub this suite installs. Pin the renderer offline
  // so the mode stays Local: an authenticated-but-offline desktop is a real,
  // documented state (PRD-461 D3), it still knows its org slug, and it still
  // renders local session detail — exactly the composition under test.
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const identity: DesktopIdentity = {
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    organizationId: "org-1",
    organizationSlug,
    organizationName: "Acme",
    userId: "user-1",
  };
  Object.assign(window.desktopApi, {
    getDesktopAuthState: vi.fn(() =>
      Promise.resolve({
        organizationId: "org-1",
        status: DesktopAuthStatus.Authenticated,
        userId: "user-1",
      })
    ),
    getDesktopIdentity: vi.fn(() => Promise.resolve(identity)),
    // ISS-4898 (wongk + codex review): `useWebAppOrigin` now FAILS UNRESOLVED —
    // it no longer seeds itself with the production default, because a pending
    // or failed settings read used to mint a live production link for a
    // non-production org slug. A production renderer always has a settings
    // store, so the identity stub supplies one; the "unresolved origin" state
    // gets its own case below rather than being every test's accidental state.
    getSettings: vi.fn(() =>
      Promise.resolve({ webAppOrigin: DEFAULT_WEB_APP_ORIGIN })
    ),
  });
}
