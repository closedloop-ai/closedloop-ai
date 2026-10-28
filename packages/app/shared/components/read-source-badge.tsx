import { isReadSource, ReadSource } from "@repo/api/src/types/read-source";
import {
  Badge,
  type BadgeProps,
} from "@repo/design-system/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";

/**
 * FEA-3120 (PRD-525 Priority 2, DoD #6): a small, unobtrusive indicator of the
 * store a surface actually read from — `local` SQLite, synced `cloud` state, or
 * a degraded `fallback`. ISS-6005 dropped it from the Sessions LIST toolbar
 * outright, and ISS-10209 dropped it from the Branches LIST toolbars the same
 * way — removed, not gated.
 *
 * ISS-5714: the tooltip answers the USER's question — which data this view is
 * showing, and whether it is complete — and nothing else. It used to close with
 * a triage note ("a wrong value here is a backend/projection bug, not a local
 * data bug"), which is our vocabulary for routing a defect to a layer, printed
 * on a customer's screen. It told the reader the number might be wrong in the
 * one panel that exists to explain the number, directly under a sentence
 * promising nothing was missing. If we know a value can be wrong we withhold it
 * or qualify it (that is what `incomplete` does); we do not annotate it with our
 * debugging notes. QA/support keep the diagnosis they were given: the BADGE
 * still names the store, which is the part they actually triage on.
 *
 * Domain component (it encodes the `ReadSource` vocabulary), so it lives in the
 * shared `packages/app` slice and composes the generic design-system `Badge` —
 * NOT in `packages/design-system`. It stays in this shared slice rather than
 * moving to the desktop renderer because that renderer imports it from here and
 * the ISS-5714 cross-surface parity suite mounts it directly.
 *
 * Presentational only: no `window`/`localStorage`, so it renders identically in
 * the web shell and the Electron renderer.
 */

type ReadSourcePresentation = {
  label: string;
  tone: BadgeProps["variant"];
  description: string;
};

const READ_SOURCE_PRESENTATION: Record<ReadSource, ReadSourcePresentation> = {
  [ReadSource.Local]: {
    label: "Local",
    tone: "muted",
    description: "Showing the data stored on this device.",
  },
  [ReadSource.Cloud]: {
    label: "Cloud",
    tone: "info",
    description: "Showing the data synced to your workspace.",
  },
  [ReadSource.Fallback]: {
    label: "Fallback",
    tone: "warning",
    // Keeps the "best-effort" clause the pre-ISS-5714 copy had. Without it the
    // sentence denies the existence of the rows the reader is looking at: this
    // badge appears OVER a populated list, so "neither could be read" alone
    // reads as a contradiction of its own screen.
    description:
      "We couldn't reach this device or your workspace, so this is a best-effort view and may be incomplete.",
  },
};

export type ReadSourceBadgeProps = {
  /**
   * The source the surface read from. When `undefined` (an older/wire producer
   * that predates FEA-3120, or a source we can't attribute), the badge renders
   * nothing rather than guessing — an unknown source must never be shown as a
   * confident `local`/`cloud`.
   */
  readSource: ReadSource | undefined;
  /** Optional noun for the tooltip ("sessions", "branches") for extra context. */
  surfaceLabel?: string;
  /**
   * ISS-5477: an optional sentence appended to the tooltip explaining WHY this
   * source is in play right now — "your history is still uploading, so this view
   * is your own machine's data", "sync stalled with N items still local".
   *
   * Optional and additive: a caller that passes nothing renders exactly the
   * badge that shipped before. It extends this badge rather than growing a
   * parallel indicator beside it, so the surface keeps one place that answers
   * "where is this coming from".
   */
  detail?: string;
  className?: string;
};

export function ReadSourceBadge({
  readSource,
  surfaceLabel,
  detail,
  className,
}: ReadSourceBadgeProps) {
  // Guard unknown values: `readSource` may arrive over HTTP/desktop IPC as a
  // truthy string a newer producer added before this UI knows it. An unknown or
  // absent source renders nothing rather than indexing the presentation map with
  // an unrecognized key (which would be `undefined` and throw below).
  if (!isReadSource(readSource)) {
    return null;
  }

  const presentation = READ_SOURCE_PRESENTATION[readSource];
  const scoped = describeReadSource(readSource, surfaceLabel);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          className={className}
          data-read-source={readSource}
          data-read-source-detail={detail}
          data-testid="read-source-badge"
          variant={presentation.tone}
        >
          {presentation.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {/* ISS-5477: when there is a reason to give, the REASON leads. The
            sentence above is written for the person who just signed in and
            thinks their history vanished; the line below is the standing
            statement of which store this view is reading. Concatenating them
            put the standing line first — so it moves underneath, muted, and the
            situational reason gets the reader's first glance. */}
        {detail ? (
          <>
            <span className="block">{detail}</span>
            <span className="mt-1 block text-[0.9em] opacity-70">{scoped}</span>
          </>
        ) : (
          scoped
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The standing sentence this badge shows for a store, optionally scoped to a
 * surface noun ("Sessions: …").
 *
 * Exported so the copy itself is directly testable — ISS-5714 shipped a triage
 * note to customers here, and a regression test that has to open a Radix
 * tooltip to read the string is a test nobody keeps. The component renders
 * exactly this, and `read-source-badge.test.tsx` proves the wiring by reading
 * the rendered tooltip as well.
 */
export function describeReadSource(
  readSource: ReadSource,
  surfaceLabel?: string
): string {
  const { description } = READ_SOURCE_PRESENTATION[readSource];
  if (!surfaceLabel) {
    return description;
  }
  return `${surfaceLabel[0].toUpperCase()}${surfaceLabel.slice(1)}: ${description}`;
}
