import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Progress,
  ProgressTone,
} from "@closedloop-ai/design-system/components/ui/progress";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import {
  CompactTone,
  type ImportSplashCompactState,
} from "./import-splash-compact-state";

// Each compact tone spends itself on the rail, so the values the state
// distinguishes are things the user can actually see: a paused import holds in
// warning, a finished one lands in success, and ordinary progress stays on the
// default. Attention never reaches a rendered rail (`showRail` is false exactly
// when the tone is Attention); its entry exists so the map stays total and the
// `satisfies` clause fails typecheck if a tone is ever added.
const RAIL_TONE_FOR_COMPACT_TONE = {
  [CompactTone.Progress]: ProgressTone.Default,
  [CompactTone.Paused]: ProgressTone.Warning,
  [CompactTone.Attention]: ProgressTone.Destructive,
  [CompactTone.Done]: ProgressTone.Success,
} as const satisfies Record<CompactTone, ProgressTone>;

type ImportSplashCompactProps = {
  state: ImportSplashCompactState;
  /**
   * Whether the rail's liveness sheen is held. Comes from the banner, NOT from
   * `state.paused`: pause governs the import collector only, so during the
   * post-import maintenance window an earlier pause intent must not freeze the
   * rail — the expanded body keeps sweeping there and the collapsed row has to
   * agree, or the same import reads "loading" in one form and "hung" in the
   * other.
   */
  railPaused: boolean;
  onExpand: () => void;
  onTogglePause: () => void;
  onContinue: () => void;
};

/**
 * ISS-5258: the collapsed first-launch import splash — one slim row instead of
 * the full panel, so the Sessions content behind it is usable while the import
 * does the background work the splash already claims it is doing.
 *
 * Collapsing removes DETAIL, never truth, and never the way out:
 * - the headline is the expanded splash's own, so "Import paused" and "Import
 *   didn't finish" reach the collapsed row unchanged;
 * - the failed state keeps the expanded panel's "Continue to dashboard" so a
 *   collapsed failure is not a red row the user cannot dismiss;
 * - a phase with no measured position renders the indeterminate rail rather
 *   than an empty track (reads as 0%) or a full one (reads as finished);
 * - a phase with no known total prints no count at all.
 *
 * The words come first and the rail sits under them, inset to the strip's own
 * padding: in a one-line strip the bar is the loud signal and the sentence is
 * the true one, so the sentence gets the reading position and the bar gets out
 * of the way.
 */
export function ImportSplashCompact({
  state,
  railPaused,
  onExpand,
  onTogglePause,
  onContinue,
}: ImportSplashCompactProps) {
  const attention = state.tone === CompactTone.Attention;
  return (
    // ISS-5367: the strip ends in the same hairline `border-b` every other
    // banner in the desktop stack uses, unconditionally — the rail no longer
    // doubles as the bottom edge. Making a progress bar BE a structural rule is
    // what turned it into a full-bleed saturated band sitting directly under the
    // update banner's own band, with this pale row trapped between the two.
    // `px-4` is the inset the update banner above and the Sessions toolbar below
    // already share, so all three regions now start on one left edge; `px-6` was
    // this row alone stepping 8px further in.
    //
    // ISS-5367 review: `gap-1`, not `gap-2`. With an equal gap above and `py-2`
    // below, the rail landed exactly midway between the row it describes and the
    // strip's bottom edge, reading as attached to neither. A step tighter than
    // the padding under it groups it with its row, which is the thing it is a
    // measurement OF.
    <div className="flex flex-col gap-1 border-border border-b px-4 py-2">
      <div className="flex items-center gap-3">
        {attention ? (
          <TriangleAlertIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-destructive"
          />
        ) : null}
        {/* The sentence sizes to its content and the COUNT takes the leftover
          (`flex-1`, zero basis), so a narrowing row squeezes the number first
          and the label survives — the opposite priority would leave "Import
          didn't f…" beside a pristine "1,503 / 2,452 transcripts". Matches the
          expanded body: the headline is announced, the churning count is not. */}
        <span
          aria-atomic="true"
          aria-live="polite"
          className={cn(
            "min-w-0 truncate font-medium text-sm",
            attention ? "text-destructive" : "text-foreground"
          )}
          role="status"
        >
          {state.label}
        </span>
        {/* The count is promoted to `text-foreground` while Importing, exactly as
          the expanded body does: that number is the reason someone collapses
          the splash instead of dismissing it, so the collapsed form must not
          demote the one thing it was kept for. Every other phase leaves it
          muted, again matching the expanded body. */}
        {state.metrics === null ? null : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-right text-xs tabular-nums",
              state.promoteMetrics ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {state.metrics}
          </span>
        )}
        {/* `ml-auto` so the controls hold the right edge even when no count
            renders. The free space used to be taken by the count's `flex-1`,
            so a phase with no known total (Scanning, Computing — the states
            that run longest) collapsed the controls back against the label
            with the rest of the row left empty. Inert whenever the count IS
            present, since `flex-1` has already consumed the free space. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* "Continue to dashboard" named a destination the user is already
            looking at — collapsed, this button dismisses the strip, so it says
            that. `outline`, not the default filled primary: a filled button
            parked in a persistent row above the Sessions list is the loudest
            thing on screen, which is the opposite of what collapsing is for. */}
          {state.showContinue ? (
            <Button
              onClick={onContinue}
              size="sm"
              type="button"
              variant="outline"
            >
              Dismiss
            </Button>
          ) : null}
          {state.showPause ? (
            <Button
              aria-label={state.paused ? "Resume import" : "Pause import"}
              onClick={onTogglePause}
              size="sm"
              type="button"
              variant="outline"
            >
              {state.paused ? "Resume" : "Pause"}
            </Button>
          ) : null}
          <Button
            aria-expanded={false}
            aria-label="Show import details"
            data-import-splash-toggle=""
            onClick={onExpand}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      {/* NO className at all — not a height, not a radius, not a position. The
          indeterminate rendering is a -45deg hatch on a 7px period
          (`progress-hatch`, ISS-5115) and the primitive's own `h-2` is the
          geometry it was designed against: squeezed to `h-1` a stripe gets less
          than one period of vertical run and reads as a dotted rule rather than
          "amount unknown", which is the single thing the hatch exists to convey.
          Scanning and Computing are both indeterminate and Compute runs for
          hours, so that is the common case, not a corner.

          ISS-5367 reduced this rail's weight WITHOUT touching that geometry. It
          was `absolute inset-x-0 bottom-0 rounded-none`: an overlay escaping the
          row's padding to bleed edge-to-edge, squared off against both window
          sides. At 7/8 transcripts that is a solid `bg-primary` slab spanning
          the full width — a second saturated band directly under the update
          banner's. In flow it is inset by the row's own `px-4` and keeps the
          primitive's `rounded-full`, so it reads as a contained meter rather
          than a structural rule, while every pixel of the hatch survives.

          ISS-5367 review: the SLOT is unconditional, the rail inside it is not.
          As an overlay the rail cost the strip no height, so the row held one
          height in every phase. In flow it costs `h-2` plus the gap above, and
          `showRail` is false in exactly one state — Failed. Without the slot the
          strip would therefore SHRINK at the instant an import fails, yanking the
          Sessions list up under the user exactly as the error copy lands.
          Reserving the space holds one height across every phase.

          The reservation is the slot's own `h-2`, the height the primitive ships
          (`packages/design-system/components/ui/progress.tsx`), so the rail fills
          it rather than adding to it. It stays an EMPTY box rather than a hidden
          `Progress`: a progressbar that is present but invisible over a failed
          import is the stalled-bar-reading-as-progress this module exists to
          refuse. */}
      <div className="h-2" data-testid={IMPORT_SPLASH_RAIL_SLOT_TEST_ID}>
        {state.showRail ? (
          <Progress
            aria-label="Overall import progress"
            paused={railPaused}
            sweep
            tone={RAIL_TONE_FOR_COMPACT_TONE[state.tone]}
            value={state.railPct === null ? null : Math.round(state.railPct)}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Handle for the rail's reserved slot. The strip must hold one height whether or
 * not a rail is rendering, and that is a claim about a box the failed state
 * renders EMPTY — so it cannot be addressed through the progressbar role.
 */
export const IMPORT_SPLASH_RAIL_SLOT_TEST_ID = "import-splash-rail-slot";
