import type { ReactNode } from "react";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../../../shared/agent-monitor-status";
import type { CloudSyncBacklog } from "../../../shared/cloud-read-readiness-contract";
import { resolveCloudSyncBacklog } from "../../../shared/cloud-read-readiness-contract";
import { MaintenancePhase } from "../../../shared/maintenance-progress-contract";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
} from "../../../shared/sync-burndown-contract";
import {
  type CloudStatus,
  CloudStatusKind,
  type CloudSyncProgress,
  type IngestProgress,
} from "../../hooks/use-ingest-progress";
import { StartupReadinessPanelBody } from "./startup-readiness-panel-body";
import {
  buildStartupReadinessModel,
  SavedSessionsReadinessStatus,
  type StartupReadinessInputs,
} from "./startup-readiness-state";

const CAUGHT_UP_CLOUD_SYNC: CloudSyncProgress = {
  identified: true,
  pendingBackfillSessions: 0,
  pendingIncrementalSessions: 0,
  backfilling: false,
  caughtUp: true,
  deadLetteredSessions: 0,
};

/**
 * ISS-5768: every lane owes nothing — the only backlog that lets the panel
 * claim the cloud is up to date. Built through the production derivation rather
 * than hand-shaped, so a change to what "drained" means reaches this fixture.
 */
const DRAINED_BACKLOG: CloudSyncBacklog = resolveCloudSyncBacklog({
  sampledAtIso: "2026-08-10T12:00:00.000Z",
  importComplete: true,
  lanes: SYNC_LANE_IDS.map((lane) => ({
    lane,
    state: SyncLaneDrainState.Drained,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    unmeasuredRows: 0,
  })),
});

const ONLINE_CLOUD_STATUS: CloudStatus = { kind: CloudStatusKind.Online };

/**
 * ISS-4715: the startup readiness panel, one story per reachable phase.
 *
 * `StartupReadinessPanel` is the AppShell startup surface, but it is all polling
 * hooks, a reveal delay, a ready-hold timer, and a maintenance bridge, so
 * mounting it on a canvas would pin the wiring rather than the visuals.
 * `StartupReadinessPanelBody` is the presentational unit inside it, and
 * `buildStartupReadinessModel` is the pure function that decides what it says.
 * Each story feeds real signals through that derivation, so the headline, step
 * icons, and counts on the canvas are the ones the running app would produce,
 * not copies of them.
 *
 * These phases are effectively unreachable on demand: they need a first launch
 * against a machine with real unimported history, and the needs-attention state
 * additionally needs a wedged or unverifiable cloud sync.
 */
const meta = {
  title: "Composites/App Shell/Startup Readiness Panel Body",
  component: StartupReadinessPanelBody,
  tags: ["autodocs"],
  argTypes: {
    model: {
      control: "object",
      description:
        "The already built readiness model. `buildStartupReadinessModel` is the pure function that decides the headline, steps and counts.",
      table: { category: "Data" },
    },
    expanded: {
      control: "boolean",
      description: "Whether the checklist below the headline is open.",
      table: { category: "State" },
    },
    paused: {
      control: "boolean",
      description: "Whether the user has held history processing.",
      table: { category: "State" },
    },
    onToggleExpanded: {
      control: false,
      table: { category: "Events" },
    },
    onTogglePause: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    expanded: true,
    model: buildStartupReadinessModel(baseInputs()),
    onToggleExpanded: () => undefined,
    onTogglePause: () => undefined,
    paused: false,
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/** Nothing is known yet: the store is still opening behind an indeterminate bar. */
export const OpeningStore = {
  render: () =>
    renderScenario({
      caption:
        "Opening store - the global bar sweeps without claiming a percentage, and the checklist has not started.",
      inputs: {
        ...baseInputs(),
        agentMonitor: null,
        savedSessions: {
          status: SavedSessionsReadinessStatus.Loading,
          total: null,
        },
        ingest: null,
        maintenanceSettled: false,
      },
    }),
};

/** Store open and saved sessions revealed, while the source scan has no total yet. */
export const CheckingHistory = {
  render: () =>
    renderScenario({
      caption:
        "Checking history - saved sessions are already usable; the scan has no total yet, so the global bar stays indeterminate and no count is claimed.",
      inputs: {
        ...baseInputs(),
        ingest: ingest({ preparing: true, complete: false }),
      },
    }),
};

/** Mid-import, with live source-file progress (files, not sessions). */
export const ProcessingHistory = {
  render: () =>
    renderScenario({
      caption:
        "Processing history - the progress bar counts SOURCE FILES, and newly discovered files can raise the total.",
      inputs: {
        ...baseInputs(),
        ingest: ingest({ total: 2452, processed: 1300, complete: false }),
      },
    }),
};

/**
 * ISS-6241: the derived-view maintenance pass naming its own population, behind
 * the Labs flag. The count sits beside the step it describes, and only while
 * that step is the live one — a finished step's count is noise and a pending
 * step has measured nothing.
 */
export const PreparingViewsWithCount = {
  render: () =>
    renderScenario({
      caption:
        "Preparing views - the rebuild's own SESSION population, which is not the source-file count above it.",
      inputs: {
        ...baseInputs(),
        ingest: ingest({ total: 2452, processed: 2452, complete: true }),
        maintenance: {
          active: true,
          phase: MaintenancePhase.Rebuild,
          processed: 412,
          total: 1299,
        },
        maintenanceSettled: false,
        showComputeProgress: true,
      },
    }),
};

/** A cloud verdict that could not be verified: warning Alert, frozen warning bar. */
export const NeedsAttention = {
  render: () =>
    renderScenario({
      caption:
        "Needs attention - dead-lettered cloud records. Local sessions stay available; only the cloud step is flagged.",
      inputs: {
        ...baseInputs(),
        ingest: ingest({ complete: true }),
        cloudSync: {
          ...CAUGHT_UP_CLOUD_SYNC,
          deadLetteredSessions: 2,
        },
      },
    }),
};

/** Local work is done; historical cloud catch-up is still draining. Collapsed by default in the app. */
export const SyncingCloud = {
  render: () =>
    renderScenario({
      caption:
        "Syncing cloud - local readiness is complete and reported separately from the historical backfill still in flight.",
      collapsed: true,
      inputs: {
        ...baseInputs(),
        ingest: ingest({ complete: true }),
        cloudSync: {
          ...CAUGHT_UP_CLOUD_SYNC,
          pendingBackfillSessions: 750,
          backfilling: true,
          caughtUp: false,
        },
      },
    }),
};

/** Everything settled. The only state where the bar reports a real 100. */
export const Ready = {
  render: () =>
    renderScenario({
      caption:
        "Ready - the bar fills to a determinate 100 (the one honest percentage in the sequence) and the checklist is all green. The app holds this briefly, then dismisses the panel.",
      collapsed: true,
      inputs: baseInputs(),
    }),
};

function baseInputs(): StartupReadinessInputs {
  return {
    agentMonitor: READY_AGENT_MONITOR_RUNTIME_STATUS,
    savedSessions: {
      status: SavedSessionsReadinessStatus.Ready,
      total: 3087,
    },
    ingest: ingest({ complete: true }),
    maintenance: { active: false, phase: null },
    maintenanceSettled: true,
    cloudSync: CAUGHT_UP_CLOUD_SYNC,
    cloudSyncBacklog: DRAINED_BACKLOG,
    cloudStatus: ONLINE_CLOUD_STATUS,
    paused: false,
  };
}

function ingest(overrides: Partial<IngestProgress>): IngestProgress {
  return {
    byHarness: [],
    total: 0,
    processed: 0,
    preparing: false,
    complete: false,
    quarantinedCount: 0,
    ...overrides,
  };
}

function renderScenario({
  caption,
  inputs,
  collapsed,
}: {
  caption: string;
  inputs: StartupReadinessInputs;
  collapsed?: boolean;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <StartupReadinessPanelBody
        expanded={collapsed !== true}
        model={buildStartupReadinessModel(inputs)}
        onToggleExpanded={() => undefined}
        onTogglePause={() => undefined}
        paused={false}
      />
      <p className="px-4 text-muted-foreground text-xs">{caption}</p>
    </div>
  );
}
