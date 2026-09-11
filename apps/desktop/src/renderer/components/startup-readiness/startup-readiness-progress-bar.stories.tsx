import type { ReactNode } from "react";
import { StartupReadinessProgressBar } from "./startup-readiness-progress-bar";
import { StartupReadinessPhase } from "./startup-readiness-state";

// ISS-5115: the global startup progress bar, one row per state it can be in.
// The bar is the whole point of this story: it is INDETERMINATE for every
// in-flight phase (no `aria-valuenow`, because startup has no single true
// percentage), a frozen warning-toned hatch when startup needs attention or the
// user paused history processing, and a determinate 100 only at Ready. The
// captions name the accessible NAME (from `aria-label`), not `aria-valuetext` —
// the component deliberately omits valuetext, because ARIA only defines it
// alongside an `aria-valuenow` an indeterminate bar has no honest way to
// supply. So the canvas and the screen-reader story can be compared side by
// side on the one channel that is actually guaranteed.
// These phases are effectively unreachable on demand in the running app — they
// need a first launch against a machine with real unimported history, and the
// needs-attention state additionally needs a wedged or unverifiable cloud sync.
/**
 * The single progress bar at the top of the app that tracks overall startup
 * rather than any one step. It sweeps continuously while real work is
 * happening, since startup has no one true percentage to report, and
 * switches to a still, hatched pattern when it is paused or stalled instead
 * of showing a bar that misleadingly looks empty or full. It only fills in
 * solid once startup is fully ready. Screen readers hear which stage it is
 * in, but the bar never claims a percentage it cannot back up.
 */
const meta = {
  title: "Composites/App Shell/Startup Readiness Progress Bar",
  component: StartupReadinessProgressBar,
  tags: ["autodocs"],
  argTypes: {
    phase: {
      control: "select",
      options: Object.values(StartupReadinessPhase),
      description:
        "Every phase but Ready draws an indeterminate bar; Ready is the only determinate 100.",
    },
    paused: {
      control: "boolean",
      description: "Drops the sweep and leaves the primitive's static hatch.",
    },
    className: { control: false, table: { category: "Appearance" } },
  },
  args: {
    paused: false,
    phase: StartupReadinessPhase.OpeningStore,
  },
  parameters: {
    layout: "padded",
  },
};

export default meta;

/** The store is still opening: nothing is known yet, so nothing is claimed. */
export const Opening = {
  render: () =>
    renderBar({
      phase: StartupReadinessPhase.OpeningStore,
      caption:
        'Opening - indeterminate sweep, announced as "Opening the local store". No percentage exists yet.',
    }),
};

/** Saved sessions are usable; the source scan has not reported a total. */
export const Checking = {
  render: () =>
    renderBar({
      phase: StartupReadinessPhase.CheckingHistory,
      caption:
        "Checking - indeterminate. This is the state the old top ring duplicated; the checklist below still names the stage.",
    }),
};

/** Mid-import. The real source-file ratio stays on its own labelled bar below. */
export const Processing = {
  render: () =>
    renderBar({
      phase: StartupReadinessPhase.ProcessingHistory,
      caption:
        "Processing - still indeterminate. Source files are one stage of three and the stages are not equal-length, so promoting that ratio to an overall percentage would be invented.",
    }),
};

/** Local readiness is done; historical cloud catch-up is still draining. */
export const Syncing = {
  render: () =>
    renderBar({
      phase: StartupReadinessPhase.SyncingCloud,
      caption:
        'Syncing - indeterminate, announced as "Syncing cloud history". Local sessions are already usable.',
    }),
};

/** The user paused history processing: the sweep stops rather than lying. */
export const Paused = {
  render: () =>
    renderBar({
      phase: StartupReadinessPhase.ProcessingHistory,
      paused: true,
      caption:
        "Paused - the same phase as Processing, but frozen: the hatch stays, the sweep goes. A travelling bar would report work the user just stopped, and an empty track would read as a reset to 0%.",
    }),
};

/** A startup source could not be verified: frozen, warning-toned, no value. */
export const Attention = {
  render: () =>
    renderBar({
      phase: StartupReadinessPhase.NeedsAttention,
      caption:
        "Attention - warning-toned hatch, no sweep, still no aria-valuenow. Progress has stopped, the amount is unknown, and the bar says both.",
    }),
};

/** Startup is complete. This is the only state with a real percentage. */
export const Ready = {
  render: () =>
    renderBar({
      phase: StartupReadinessPhase.Ready,
      caption:
        "Ready - the only determinate state: value 100, so aria-valuenow is emitted and it is true.",
    }),
};

function renderBar({
  phase,
  caption,
  paused = false,
}: {
  phase: StartupReadinessPhase;
  caption: string;
  paused?: boolean;
}): ReactNode {
  return (
    <div className="flex max-w-2xl flex-col gap-2">
      <StartupReadinessProgressBar paused={paused} phase={phase} />
      <p className="text-muted-foreground text-xs">{caption}</p>
    </div>
  );
}
