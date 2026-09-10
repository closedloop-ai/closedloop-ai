import type { ReactNode } from "react";
import type { IngestProgress } from "../../hooks/use-ingest-progress";
import { ImportSplashBody } from "./import-splash-body";
import {
  deriveImportSplashState,
  type ImportSplashInput,
} from "./import-splash-state";

/**
 * ISS-4841: the first-launch import splash, one story per phase.
 *
 * `FirstLaunchImportBanner` is the AppShell degraded-state banner here, but it
 * is all polling, latches, and give-up timers, so mounting it on a canvas would
 * pin the wiring rather than the visuals. `ImportSplashBody` is the presentational
 * unit inside it, and `deriveImportSplashState` is the pure function that decides
 * what it says. Each story feeds real signals through that derivation, so the
 * headline, stepper position, and percentages on the canvas are the ones the
 * running app would produce, not copies of them.
 *
 * The phases past Scan are effectively unreachable on demand: they need a first
 * launch against a machine with real unimported sessions, and the Failed phase
 * also needs the import to wedge for two minutes.
 */
const meta = {
  title: "Composites/App Shell/Import Splash Body",
  component: ImportSplashBody,
  tags: ["autodocs"],
  // Every story renders a fixed scenario through the real derivation, so these
  // props document the surface rather than drive it: a live control would edit
  // an arg no render function reads.
  argTypes: {
    state: { control: false },
    railPaused: { control: false },
    panelId: { control: false },
    onCollapse: { control: false, table: { category: "Events" } },
    onContinue: { control: false, table: { category: "Events" } },
    onTogglePause: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/** The source scan, before any total exists. Indeterminate on purpose. */
export const Scanning = {
  render: () =>
    renderScenario({
      caption: "Scan - no total yet, so no count is claimed.",
      input: {
        ...baseInput(),
        ingest: ingest({ preparing: true }),
      },
    }),
};

/** Mid-import, with live per-harness counts. */
export const Importing = {
  render: () =>
    renderScenario({
      caption: "Import - live per-harness counts.",
      input: {
        ...baseInput(),
        ingest: ingest({
          byHarness: [
            { harness: "claude", total: 1840, processed: 1204 },
            { harness: "codex", total: 612, processed: 96 },
          ],
          processed: 1300,
          total: 2452,
        }),
        processed: 1300,
        total: 2452,
      },
    }),
};

/** The user paused the import. The rail holds instead of pretending to move. */
export const ImportingPaused = {
  render: () =>
    renderScenario({
      caption: "Import paused - the rail holds, the control offers Resume.",
      input: {
        ...baseInput(),
        ingest: ingest({
          byHarness: [
            { harness: "claude", total: 1840, processed: 1204 },
            { harness: "codex", total: 612, processed: 96 },
          ],
          processed: 1300,
          total: 2452,
        }),
        processed: 1300,
        total: 2452,
        paused: true,
      },
      railPaused: true,
    }),
};

/**
 * The import finished and post-boot maintenance is rebuilding derived data. The
 * app still feels slow here, which is the whole reason this phase is shown.
 */
export const Computing = {
  render: () =>
    renderScenario({
      caption: "Compute - post-boot maintenance, the residual slow window.",
      input: {
        ...baseInput(),
        complete: true,
        ingest: ingest({
          byHarness: [
            { harness: "claude", total: 1840, processed: 1840 },
            { harness: "codex", total: 612, processed: 612 },
          ],
          complete: true,
          processed: 2452,
          total: 2452,
        }),
        inMaintenancePhase: true,
        maintenance: { active: true, phase: "rebuild" },
        processed: 2452,
        total: 2452,
      },
    }),
};

/**
 * ISS-6241: the same Compute stage with the Labs count on. The live sub-step
 * states how far the rebuild has drained its own SESSION population — a
 * different population from the transcripts counted above it, which is why the
 * two are nouned differently.
 */
export const ComputingWithCount = {
  render: () =>
    renderScenario({
      caption:
        "Compute - the rebuild's real per-session position, so a multi-hour pass reads as moving rather than stuck.",
      input: {
        ...baseInput(),
        complete: true,
        ingest: ingest({
          byHarness: [
            { harness: "claude", total: 1840, processed: 1840 },
            { harness: "codex", total: 612, processed: 612 },
          ],
          complete: true,
          processed: 2452,
          total: 2452,
        }),
        inMaintenancePhase: true,
        maintenance: {
          active: true,
          phase: "rebuild",
          processed: 412,
          total: 1299,
        },
        processed: 2452,
        showComputeProgress: true,
        total: 2452,
      },
    }),
};

/** Everything landed. Held briefly at 100% so it reads as finished. */
export const Ready = {
  render: () =>
    renderScenario({
      caption: "Ready - held at 100% before the splash collapses.",
      input: {
        ...baseInput(),
        complete: true,
        ingest: ingest({
          byHarness: [
            { harness: "claude", total: 1840, processed: 1840 },
            { harness: "codex", total: 612, processed: 612 },
          ],
          complete: true,
          processed: 2452,
          total: 2452,
        }),
        processed: 2452,
        total: 2452,
      },
    }),
};

/**
 * The import stopped without finishing. What imported is usable, so the splash
 * says that plainly and lets the user continue rather than stranding them.
 */
export const PartialFailure = {
  render: () =>
    renderScenario({
      caption:
        "Failed - a partial import, stated honestly, with a way out. Nothing was quarantined, so no alert renders at all: the way forward is a plain line beside the button that acts on it.",
      input: {
        ...baseInput(),
        failed: true,
        ingest: ingest({
          byHarness: [
            { harness: "claude", total: 1840, processed: 1503 },
            { harness: "codex", total: 612, processed: 0 },
          ],
          processed: 1503,
          timedOut: true,
          total: 2452,
        }),
        processed: 1503,
        total: 2452,
      },
    }),
};

/**
 * ISS-5281: the fourth outcome - the run reached the end, but some source
 * transcripts were quarantined. A quarantine is not a halt, so the flow still
 * lands on Ready; the caveat rides on the Ready alert with the count that
 * actually failed.
 *
 * A story for this was dropped once (wongk review) because `ImportSplashBody`
 * genuinely did not read `quarantinedCount` - the canvas was byte-identical to
 * `Ready`. It does read it now, so the canvas is real again.
 */
export const ReadyWithQuarantined = {
  render: () =>
    renderScenario({
      caption:
        "Ready, partial - the run reached the end, 12 transcripts could not be read. The headline softens and the alert carries only that one new fact.",
      input: {
        ...baseInput(),
        complete: true,
        ingest: ingest({
          byHarness: [
            { harness: "claude", total: 1840, processed: 1840 },
            { harness: "codex", total: 612, processed: 612 },
          ],
          complete: true,
          processed: 2452,
          quarantinedCount: 12,
          total: 2452,
        }),
        processed: 2452,
        total: 2452,
      },
    }),
};

/**
 * ISS-5281: a genuine halt that ALSO quarantined transcripts. The two
 * populations are counted separately and stated in separate places - the detail
 * line carries the transcript shortfall, the alert carries the unreadable
 * transcripts it cannot - rather than restating the discovered total under one
 * noun.
 */
export const PartialFailureWithQuarantined = {
  render: () =>
    renderScenario({
      caption:
        "Failed - the detail line carries the transcript shortfall, the alert carries the 7 unreadable transcripts it cannot. Two populations, counted separately.",
      input: {
        ...baseInput(),
        failed: true,
        ingest: ingest({
          byHarness: [
            { harness: "claude", total: 1840, processed: 1503 },
            { harness: "codex", total: 612, processed: 0 },
          ],
          processed: 1503,
          quarantinedCount: 7,
          timedOut: true,
          total: 2452,
        }),
        processed: 1503,
        total: 2452,
      },
    }),
};

type ImportSplashScenario = {
  /** What this story is showing, for the reader of the canvas. */
  caption: string;
  /** Real signals, fed through the real derivation. */
  input: ImportSplashInput;
  /** Whether the progress rail's shimmer is held. */
  railPaused?: boolean;
};

function ingest(overrides: Partial<IngestProgress> = {}): IngestProgress {
  return {
    byHarness: [],
    complete: false,
    preparing: false,
    processed: 0,
    total: 0,
    ...overrides,
  };
}

function baseInput(): ImportSplashInput {
  return {
    complete: false,
    failed: false,
    ingest: null,
    inMaintenancePhase: false,
    maintenance: null,
    paused: false,
    processed: 0,
    total: 0,
  };
}

function renderScenario({
  caption,
  input,
  railPaused = false,
}: ImportSplashScenario): ReactNode {
  return (
    <div className="flex flex-col">
      <ImportSplashBody
        onCollapse={() => undefined}
        onContinue={() => undefined}
        onTogglePause={() => undefined}
        panelId="import-splash-story-panel"
        railPaused={railPaused}
        state={deriveImportSplashState(input)}
      />
      <p className="px-6 pb-5 text-muted-foreground text-sm">{caption}</p>
    </div>
  );
}
