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
 * store a Sessions/Branches surface actually read from — `local` SQLite, synced
 * `cloud` state, or a degraded `fallback`. Lets QA/support diagnose a wrong
 * number as a data bug vs a sync gap without opening devtools.
 *
 * Domain component (it encodes the `ReadSource` vocabulary), so it lives in the
 * shared `packages/app` slice and composes the generic design-system `Badge` —
 * NOT in `packages/design-system`. Shared here (rather than duplicated in the
 * branches/agents slices) because both surfaces render the identical concept.
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
    description:
      "Rendered from this machine's local database. A wrong value here is a local data/collector bug, not a sync gap.",
  },
  [ReadSource.Cloud]: {
    label: "Cloud",
    tone: "info",
    description:
      "Rendered from synced cloud state. A wrong value here is a backend/projection bug, not a local data bug.",
  },
  [ReadSource.Fallback]: {
    label: "Fallback",
    tone: "warning",
    description:
      "Neither the local nor the cloud read succeeded — showing a degraded, best-effort result. Numbers may be incomplete due to a sync/availability gap.",
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
  className?: string;
};

export function ReadSourceBadge({
  readSource,
  surfaceLabel,
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
  const description = surfaceLabel
    ? `${surfaceLabel[0].toUpperCase()}${surfaceLabel.slice(1)}: ${presentation.description}`
    : presentation.description;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          className={className}
          data-read-source={readSource}
          data-testid="read-source-badge"
          variant={presentation.tone}
        >
          {presentation.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}
