import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import {
  CloudSyncDisclosure,
  getCloudSyncDisclosureCopy,
} from "@repo/app/agents/components/sessions/cloud-sync-state-badge";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { SESSION_STATUS_SYNC_BADGE_TEST_ID } from "@repo/app/agents/lib/session-sync-presentation";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../../test/deferred.js";
import { DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { DesktopFeatureFlagProvider } from "../desktop-feature-flag-provider";

const UNKNOWN_SHARED_FLAG_KEY = "sharedDevOnlyFlag";
// ISS-5279: the row's own Status pill, marked as carrying a sync presentation.
// There is no separate "Syncing" badge any more — that WAS the duplicate.
const STATUS_BADGE_TEST_ID = SESSION_STATUS_SYNC_BADGE_TEST_ID;
const PULSE_RING_CLASS_RE = /motion-safe:animate-status-pulse-ring/;
const SYNCING_LABEL_REGEX = /^Syncing$/;
// Every default data column EXCEPT Status — the View-menu state wongk's
// hidden-column case describes.
//
// ISS-5666: `qualifiers` is listed explicitly. This set means "everything but
// Status", and it predates the `Signals` column, so omitting that id was
// incidental rather than intended — but once the qualifiers-column gate was
// retired the omission started HIDING the column these cases need, which sent
// the sync disclosure they assert on nowhere at all. The subject here is the
// fold standing down, not column hiding.
const VISIBLE_COLUMNS_WITHOUT_STATUS = new Set([
  "name",
  "owner",
  "cost",
  "repo",
  "branch",
  "pr",
  "qualifiers",
  "started",
]);
// ISS-5282: the desktop row-qualifiers fixture and the two labels it must keep
// reachable after the move, read from their canonical sources rather than
// re-typed — a relocated chip whose label drifted would otherwise still pass.
const DESKTOP_QUALIFIED_ROW_NAME = "Desktop qualified session";
const _DESKTOP_LOCAL_ONLY_LABEL = getCloudSyncDisclosureCopy(
  CloudSyncDisclosure.LocalOnly
).label;
let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

describe("DesktopFeatureFlagProvider", () => {
  beforeEach(() => {
    originalDesktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
  });

  afterEach(() => {
    if (originalDesktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", originalDesktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    vi.restoreAllMocks();
  });

  it("keeps default-off desktop flags disabled while settings load in dev", async () => {
    const runtime = deferred<unknown>();
    const flags = deferred<unknown>();
    installDesktopApi({
      flags: flags.promise,
      runtimeStatus: runtime.promise,
    });

    renderFeatureProbe();

    expect(screen.getByTestId("agent-coaching").textContent).toBe("disabled");
    expect(screen.getByTestId("shared-dev").textContent).toBe("disabled");

    runtime.resolve({ isPackaged: false });

    await waitFor(() =>
      expect(screen.getByTestId("shared-dev").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("agent-coaching").textContent).toBe("disabled");

    flags.resolve({ flags: [] });

    await waitFor(() =>
      expect(screen.getByTestId("agent-coaching").textContent).toBe("disabled")
    );
  });

  it("uses explicit persisted desktop flag values when they arrive", async () => {
    installDesktopApi({
      flags: Promise.resolve({
        flags: [
          {
            key: DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY,
            value: true,
          },
        ],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: false }),
    });

    renderFeatureProbe();

    await waitFor(() =>
      expect(screen.getByTestId("agent-coaching").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("shared-dev").textContent).toBe("enabled");
  });
});

// ISS-4774: prove the DESKTOP adapter drives the shared `SyncedSessionsTable`
// fold, so the feature can't render one way on web and another on desktop. These
// tests use a packaged build (isPackaged: true, dev fallback off) so the shared
// derivation, not a dev fallback, is what drives the render.
describe("DesktopFeatureFlagProvider — ISS-4774 folds the shared sessions table on desktop", () => {
  // ISS-5366: with `sessions-honest-unknown-states` retired ON the row's
  // DISPLAYED status is folded against the staleness cutoff, and the sync fold
  // only applies to a row that reads Active. The shared fixture's
  // `lastActivityAt` is a fixed date, so against the real clock every row here
  // would read "Stale" and nothing would fold — the suite would pass on
  // vacuously-unfolded rows. Pin the clock just after that timestamp, exactly as
  // the web twin does in `agent-sessions-table-sync-fold.test.tsx`.
  const NOW = new Date("2026-06-01T14:45:00.000Z");

  beforeEach(() => {
    // `shouldAdvanceTime` keeps the timer queue draining so the async
    // `waitFor`/`findBy*` polling below still resolves; only the wall-clock
    // ORIGIN is pinned, which is all the staleness cutoff reads.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ISS-4846: the fold keys on the transcript VERDICT, so a genuinely
  // mid-upload row carries `transcriptDisposition: Syncing`. A bare
  // `cloudSyncState: Pending` with no verdict is "Local only" — a different
  // fact — and must NOT fold (see the sibling case below).
  const uploadingItem = createAgentSessionListItemFixture({
    id: "uploading-session",
    name: "Uploading session",
    status: "active",
    cloudSyncState: AgentSessionCloudSyncState.Pending,
    transcriptDisposition: TranscriptDisposition.Syncing,
  });

  function renderDesktopTable(
    item: AgentSessionListItem,
    visibleColumns?: Set<string>
  ) {
    const memoryNavigation = createMemoryNavigation({ orgSlug: "org-test" });
    return render(
      <DesktopFeatureFlagProvider>
        <NavigationProvider adapter={memoryNavigation.adapter}>
          <TooltipProvider>
            <SyncedSessionsTable
              getSessionHref={(session) => `/sessions/${session.id}`}
              items={[item]}
              visibleColumns={visibleColumns}
            />
          </TooltipProvider>
        </NavigationProvider>
      </DesktopFeatureFlagProvider>
    );
  }

  function renderDesktopSessionsTable() {
    return renderDesktopTable(uploadingItem);
  }

  it("ONE Status pill, still labelled 'Active', pulsing — no second pill and no dot (ISS-5279)", async () => {
    installDesktopApi({
      flags: Promise.resolve({
        flags: [],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: true }),
    });

    renderDesktopSessionsTable();

    // Desktop twin of the web assertion in
    // `packages/app/agents/components/sessions/__tests__/synced-sessions-table-status-sync.test.tsx`.
    // ONE shared derivation drives both surfaces, so the two halves cannot
    // diverge — which is how the duplicate pill kept coming back.
    const statusBadge = await screen.findByTestId(STATUS_BADGE_TEST_ID);
    // ISS-5279: the lifecycle word STAYS and the pill pulses. Sync is a second
    // dimension, never a Status value.
    expect(statusBadge.textContent).toContain("Active");
    expect(statusBadge.className).toMatch(PULSE_RING_CLASS_RE);
    // The duplicate Mike filed repeatedly: no second "Syncing" pill…
    expect(screen.queryByText(SYNCING_LABEL_REGEX)).toBeNull();
    // …and no separate dot either.
    expect(screen.queryByTestId("session-liveness-dot")).toBeNull();
    // No inline "Local only" cloud-sync pill once folded.
    expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull();
  });

  it("a desktop row that is not uploading carries no pill mark, and keeps its Name-cell verdict (ISS-5279)", async () => {
    // The desktop half of PR review's resolution: a `stale` verdict means the
    // cloud copy is behind and nothing is in flight, so the Status pill — whose
    // claim is "an upload is in flight" — says nothing. The verdict is not lost:
    // it is the Name cell's disposition badge, which the fold only suppresses
    // for a row that IS uploading.
    installDesktopApi({
      flags: Promise.resolve({
        flags: [],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: true }),
    });

    renderDesktopTable(
      createAgentSessionListItemFixture({
        id: "stale-transcript-session",
        name: "Stale transcript session",
        status: "active",
        transcriptDisposition: TranscriptDisposition.Stale,
      })
    );

    // The row rendered — without this the negative below could pass against a
    // never-mounted table.
    expect(
      (await screen.findByText("Stale transcript session")).textContent
    ).toBe("Stale transcript session");
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).toBeNull();
    // Still the lifecycle word, unmarked.
    expect(screen.getByText("Active").textContent).toBe("Active");
  });

  it("a GENUINELY synced row carries no sync marker at all (ISS-5279)", async () => {
    // The one rendering that is allowed to look like "done", because it is. If
    // this row grew a marker, "no marker" would stop meaning "finished" and the
    // pulse's stop would be uninterpretable again.
    installDesktopApi({
      flags: Promise.resolve({
        flags: [],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: true }),
    });

    renderDesktopTable(
      createAgentSessionListItemFixture({
        id: "active-synced-session",
        name: "Active synced session",
        status: "active",
        transcriptDisposition: TranscriptDisposition.Synced,
      })
    );

    await waitFor(() => expect(screen.queryByText("Active")).not.toBeNull());
    expect(screen.queryByTestId("session-liveness-dot")).toBeNull();
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).toBeNull();
  });

  it("a `failedTransient` row does NOT fold, so it keeps its own run status (ISS-4846)", async () => {
    // `reconcileCloudSyncState` maps `failedTransient` onto the same `pending`
    // cloudSyncState as `syncing`, so a fold gated on `cloudSyncState` swallowed
    // a retrying-after-failure row on desktop exactly as it did on web: the
    // inline verdict was suppressed and the row rendered the same calm blue pill
    // as a healthy upload. Desktop twin of the shared-table case.
    //
    // ISS-5770 removed the `Signals` column the inline sync badge rendered
    // into, so the badge is now asserted ABSENT — a creep-back guard. What this
    // case still proves is the part that matters: the row keeps its OWN run
    // status ("Active") rather than being repainted by a fold it must not enter.
    installDesktopApi({
      flags: Promise.resolve({
        flags: [],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: true }),
    });

    renderDesktopTable(
      createAgentSessionListItemFixture({
        id: "failed-transient-session",
        name: "Failed transient session",
        status: "active",
        cloudSyncState: AgentSessionCloudSyncState.Pending,
        transcriptDisposition: TranscriptDisposition.FailedTransient,
      })
    );

    await waitFor(() =>
      expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull()
    );
    expect(screen.queryByText("Active")).not.toBeNull();
  });

  it("the Status column hidden: the fold stands down, and no sync chip is left behind on the row (ISS-4848)", async () => {
    // wongk: with Status hidden from the View menu the desktop grid renders no
    // Status cell, so the folded pill has nowhere to live — and the fold also
    // suppressed the name-cell badge, leaving an uploading row with no sync
    // signal anywhere. The fold now gates on Status visibility on BOTH adapters.
    //
    // ISS-5770 removed the `Signals` column the inline pill was handed back to,
    // so it is asserted absent rather than present. The stood-down fold — no
    // Status pill, no pulse — is what this case still proves.
    installDesktopApi({
      flags: Promise.resolve({
        flags: [],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: true }),
    });

    renderDesktopTable(uploadingItem, VISIBLE_COLUMNS_WITHOUT_STATUS);

    await waitFor(() =>
      expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull()
    );
    // Parity with the shared-table twin: BOTH retired sync chips are guarded,
    // not one of them twice.
    expect(screen.queryByTestId("session-sync-status-badge")).toBeNull();
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).toBeNull();
    // ISS-5279: the pulse rides the fold, so a stood-down fold renders none.
    expect(screen.queryByTestId("session-liveness-dot")).toBeNull();
  });

  it("the duplicate freshness pill is dropped, with no Labs flag seeded (ISS-5036)", async () => {
    // Desktop twin of the web duplicate-pill case. An uploading row carries both
    // `transcriptDisposition: syncing` (rendered by `SessionSyncStatusBadge` as
    // "Syncing") and `cloudSyncState: pending` (rendered by `CloudSyncStateBadge`
    // as "Transcript still syncing") — one fact, two pills in the Name cell.
    // Status is hidden so the folded pill cannot stand in for either, isolating
    // the duplicate-chip guard itself.
    //
    // The cap was `disclosureNamesTheVerdict` in `useSessionRowQualifiers`. It
    // shipped behind a row-state chip Labs key that ISS-5282 retired by keeping
    // its ENABLED path, so the cap became unconditional and this case seeds no
    // third flag. ISS-5770 then removed the `Signals` column both chips rendered
    // into, so the cap no longer has anything to arbitrate on the list: neither
    // chip renders, which is asserted below.
    installDesktopApi({
      flags: Promise.resolve({
        flags: [],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: true }),
    });

    renderDesktopTable(uploadingItem, VISIBLE_COLUMNS_WITHOUT_STATUS);

    // ISS-5770 removed the `Signals` column both chips rendered into, so
    // NEITHER reaches the list — not the disclosure that used to survive the
    // cap, and not the pill that merely restated it. Both are asserted absent
    // as creep-back guards.
    await waitFor(() =>
      expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull()
    );
    expect(screen.queryByTestId("session-sync-status-badge")).toBeNull();
  });

  it("a LOCAL-ONLY row (pending, no transcript verdict) does NOT fold (ISS-4846)", async () => {
    // `reconcileCloudSyncState` maps several verdicts onto `pending`, so gating
    // the fold on `cloudSyncState` alone painted "Syncing" over rows that are not
    // in the cloud at all ("Local only") — a different fact, with different copy
    // (#4150). The fold keys on the transcript verdict, so this row keeps its
    // honest inline pill.
    installDesktopApi({
      flags: Promise.resolve({
        flags: [],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: true }),
    });

    renderDesktopTable(
      createAgentSessionListItemFixture({
        id: "local-only-session",
        name: "Local only session",
        status: "active",
        cloudSyncState: AgentSessionCloudSyncState.Pending,
      })
    );

    await waitFor(() =>
      expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull()
    );
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).toBeNull();
  });

  // ISS-5366 removed the "Labs flag OFF (default)" case that used to sit here.
  // It asserted the UNFOLDED render of `uploadingItem` — an inline
  // `cloud-sync-state-badge` and NO Status sync mark — which is the exact
  // opposite of what the first case in this block now asserts for that same
  // row. With `sessions-status-pill-sync-state` retired ON there is no OFF
  // branch left to describe, so the case was a contradiction, not coverage; the
  // folded render it was contrasted against is asserted above.
});

// ISS-5282: the DESKTOP half of the row-qualifiers move. The same kebab-case key
// gates both surfaces — a PostHog flag on web, this persisted Labs setting here
// — so these drive the real desktop adapter (packaged build, dev fallback off)
// rather than a stubbed provider. Without this block the ticket's "both
// surfaces" acceptance would rest on the web test alone, which proves nothing
// about how the packaged renderer resolves the key.
describe("DesktopFeatureFlagProvider — ISS-5282 rehomes the row qualifiers on desktop", () => {
  /**
   * A row carrying TWO qualifiers at once — `Awaiting input` and the bare
   * `Local only` disclosure (pending upload, no transcript verdict to refine
   * it). Its status is not Active, so the ISS-4774 sync fold never suppresses
   * either one; whatever is missing after the move is genuinely missing.
   */
  const qualifiedItem = createAgentSessionListItemFixture({
    awaitingInputSince: new Date("2026-08-01T10:00:00Z").toISOString(),
    cloudSyncState: AgentSessionCloudSyncState.Pending,
    id: "desktop-qualified",
    name: DESKTOP_QUALIFIED_ROW_NAME,
    status: "waiting",
    turns: 4,
  });

  let restoreContainerWidth: (() => void) | null = null;

  beforeEach(() => {
    // Wider than the whole table, so the ISS-4889 fold fit is a no-op and every
    // declared column renders — these cases are about WHICH cell holds a
    // qualifier, not about the fold.
    restoreContainerWidth = stubContainerWidthPx(4000);
  });

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = null;
  });

  /**
   * ISS-5666: NO Labs key is seeded. The `sessions-row-qualifiers-column`
   * toggle is retired, so the desktop renderer must reach the name-only Session
   * cell on its own — seeding a key here would hide a regression that
   * re-gated it.
   */
  function renderDesktopQualifiers() {
    installDesktopApi({
      flags: Promise.resolve({ flags: [] }),
      runtimeStatus: Promise.resolve({ isPackaged: true }),
    });
    const memoryNavigation = createMemoryNavigation({ orgSlug: "org-test" });
    return render(
      <DesktopFeatureFlagProvider>
        <NavigationProvider adapter={memoryNavigation.adapter}>
          <TooltipProvider>
            <SyncedSessionsTable
              getSessionHref={(session) => `/sessions/${session.id}`}
              items={[qualifiedItem]}
            />
          </TooltipProvider>
        </NavigationProvider>
      </DesktopFeatureFlagProvider>
    );
  }

  it("the Session Name cell is the name alone, with no Labs flag seeded", async () => {
    renderDesktopQualifiers();

    // ISS-5770 removed the `Signals` column this test used to read the relocated
    // qualifier chips out of, so the half that asserted their presence is gone
    // with the column. What survives is the half that still has to hold on
    // DESKTOP: the lead cell is the session name and nothing else.
    //
    // That contract is the whole point of ISS-5666 — Mike asked three times for
    // the pills to leave that cell — and removing their new home must not hand
    // them back to it. Asserted with the row on screen so an unrendered row
    // cannot satisfy it vacuously.
    const nameCell = await waitFor(() =>
      screen
        .getByText(DESKTOP_QUALIFIED_ROW_NAME)
        .closest<HTMLElement>('[role="cell"], [role="gridcell"]')
    );
    expect(nameCell?.textContent?.trim()).toBe(DESKTOP_QUALIFIED_ROW_NAME);
    // And no pill of ANY kind, matched by design-system slot rather than by
    // today's label strings: an icon-only or aria-label-only chip contributes no
    // text and would pass the check above.
    expect(
      nameCell?.querySelectorAll('[data-slot="badge"], [data-slot="chip"]')
    ).toHaveLength(0);
  });
});

function renderFeatureProbe() {
  return render(
    <DesktopFeatureFlagProvider>
      <FeatureProbe
        flagKey={DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY}
        testId="agent-coaching"
      />
      <FeatureProbe flagKey={UNKNOWN_SHARED_FLAG_KEY} testId="shared-dev" />
    </DesktopFeatureFlagProvider>
  );
}

function FeatureProbe({
  flagKey,
  testId,
}: {
  flagKey: string;
  testId: string;
}) {
  const enabled = useFeatureFlagEnabled(flagKey);
  return <div data-testid={testId}>{enabled ? "enabled" : "disabled"}</div>;
}

function installDesktopApi({
  flags,
  runtimeStatus,
}: {
  flags: Promise<unknown>;
  runtimeStatus: Promise<unknown>;
}) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getAllFlags: vi.fn(() => flags),
      getRuntimeStatus: vi.fn(() => runtimeStatus),
      onFlagsChanged: vi.fn(),
    },
  });
}
