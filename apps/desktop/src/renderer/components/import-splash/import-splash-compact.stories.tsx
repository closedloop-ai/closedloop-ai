import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";
import type { IngestProgress } from "../../hooks/use-ingest-progress";
import { ImportSplashCompact } from "./import-splash-compact";
import { deriveImportSplashCompactState } from "./import-splash-compact-state";
import {
  deriveImportSplashState,
  type ImportSplashInput,
} from "./import-splash-state";

/**
 * ISS-5258: the COLLAPSED first-launch import splash, one story per state it can
 * be collapsed into.
 *
 * Same discipline as the sibling `Import Splash Body` stories: each canvas feeds
 * real signals through the real derivation (`deriveImportSplashState` then
 * `deriveImportSplashCompactState`), so what the row says here is what the
 * running app would say — not a copy of it.
 *
 * The point of the matrix is the honesty contract. Collapsing costs the user
 * detail, never truth, so a paused import still reads "Import paused", a failed
 * one still reads "Import didn't finish" with a warning instead of a bar, and
 * the scan — which has no total yet — claims no count at all rather than
 * printing a fabricated 0%.
 */
const meta = {
  title: "Desktop App/App Shell/Import Splash Compact",
  component: ImportSplashCompact,
  tags: ["autodocs"],
  // Every story renders a fixed scenario through the real derivation, so these
  // props document the surface rather than drive it: a live control would edit
  // an arg no render function reads.
  argTypes: {
    state: { control: false },
    railPaused: { control: false },
    onContinue: { control: false, table: { category: "Events" } },
    onExpand: { control: false, table: { category: "Events" } },
    onTogglePause: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/** The source scan. No total exists yet, so no count is claimed. */
export const Scanning = {
  render: () =>
    renderScenario({
      caption: "Scan - no total yet, so the row states no count.",
      input: {
        ...baseInput(),
        ingest: ingest({ preparing: true }),
      },
    }),
};

/** The everyday case: the whole panel reduced to one line. */
export const Importing = {
  render: () =>
    renderScenario({
      caption: "Import - the count and Pause. The rail carries the percentage.",
      input: importingInput(),
    }),
};

/**
 * Paused. The row SAYS so: a rail that merely stopped moving reads as stalled,
 * or worse, as still working.
 */
export const Paused = {
  render: () =>
    renderScenario({
      caption: "Paused - stated, not implied by a bar that stopped moving.",
      input: { ...importingInput(), paused: true },
    }),
};

/** Post-import maintenance. Named, with the transcripts it imported. */
export const Computing = {
  render: () =>
    renderScenario({
      caption: "Compute - the rebuild is named; no percentage is invented.",
      input: {
        ...completeInput(),
        inMaintenancePhase: true,
        maintenance: { active: true, phase: "rebuild" },
      },
    }),
};

/** Everything landed, briefly, before the splash dismisses itself. */
export const Ready = {
  render: () =>
    renderScenario({
      caption: "Ready - held briefly before the whole splash dismisses.",
      input: completeInput(),
    }),
};

/**
 * The import stopped without finishing. Bad news does NOT get collapsed away:
 * the row swaps the rail for a warning and keeps the counts, because a rail
 * beside a stopped import reads as progress still happening.
 */
export const PartialFailure = {
  render: () =>
    renderScenario({
      caption: "Failed - a warning and the counts, never a cheerful bar.",
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
 * Narrow. The Electron window has no `minWidth` and the sidebar eats ~250px, so
 * this is reachable. The COUNT gives way — truncating, then collapsing out
 * entirely — and the sentence survives, because the label carries the truth and
 * the number is the detail.
 */
export const Narrow = {
  render: () =>
    renderScenario({
      caption: "Narrow - the count gives way first; the sentence never does.",
      input: {
        ...completeInput(),
        inMaintenancePhase: true,
        maintenance: { active: true, phase: "rebuild" },
      },
      width: "max-w-md",
    }),
};

type ImportSplashCompactScenario = {
  /** What this story is showing, for the reader of the canvas. */
  caption: string;
  /** Real signals, fed through the real derivation. */
  input: ImportSplashInput;
  /** Constrain the row, to show what gives when the window is narrow. */
  width?: string;
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

function importingInput(): ImportSplashInput {
  return {
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
  };
}

function completeInput(): ImportSplashInput {
  return {
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
  };
}

function renderScenario({
  caption,
  input,
  width,
}: ImportSplashCompactScenario): ReactNode {
  // Mirrors the banner's own derivation (`first-launch-import-banner.tsx`):
  // pause governs the import collector only, so an earlier pause intent must
  // not freeze the rail once the post-import maintenance window starts.
  // Hard-coding `false` here made the Paused story show a sweeping rail beside
  // a caption saying it had stopped.
  const railPaused = input.paused && !input.inMaintenancePhase;
  return (
    <div className={cn("flex flex-col", width)}>
      {/* No `border-b` here, matching the banner: since ISS-5367 the compact row
          draws its own hairline bottom edge in EVERY state (the rail stopped
          doubling as that edge), so a border here too would be the second rule
          the production surface deliberately does not draw. */}
      <div className="bg-primary/5">
        <ImportSplashCompact
          onContinue={() => undefined}
          onExpand={() => undefined}
          onTogglePause={() => undefined}
          railPaused={railPaused}
          state={deriveImportSplashCompactState(deriveImportSplashState(input))}
        />
      </div>
      <p className="px-6 py-5 text-muted-foreground text-sm">{caption}</p>
    </div>
  );
}
