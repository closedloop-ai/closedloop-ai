/**
 * ISS-5315: the icon rendered in each "Group by" band header, naming the
 * dimension the rows are banded on.
 *
 * One declaration, two adapters. The web Sessions table
 * (`apps/app/components/agent-sessions/sessions-table.tsx`) and the shared
 * synced table (`synced-sessions-table.tsx`) both band their rows with
 * `buildSessionGroups` and both need a header icon for the SAME dimension — so
 * the map lives here rather than being re-typed per surface, where the two
 * copies could drift into labelling one dimension with two different glyphs.
 *
 * `None` has no band header to decorate, so it maps to null rather than being
 * absent: the `Record<SessionGroupBy, ReactNode>` annotation is what makes a
 * newly added grouping dimension fail typecheck here until it is given an icon.
 */

import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { sessionStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { resolveArtifactStatusMark } from "@repo/app/shared/lib/artifact-status-appearance";
import { StatusAppearanceIcon } from "@repo/design-system/components/ui/status-icon-primitives";
import { BotIcon, CircleDotIcon, SignalIcon, UserIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SessionGroupBy } from "../../lib/session-grouping";

export const SESSION_GROUP_ICONS: Record<SessionGroupBy, ReactNode> = {
  [SessionGroupBy.None]: null,
  [SessionGroupBy.Status]: (
    <CircleDotIcon className="size-4 text-muted-foreground" />
  ),
  [SessionGroupBy.Harness]: (
    <BotIcon className="size-4 text-muted-foreground" />
  ),
  [SessionGroupBy.Owner]: <UserIcon className="size-4 text-muted-foreground" />,
  // ISS-10332: the dimension's glyph, not a value's — the band label names the
  // priority; the design system's per-value `PriorityIcon` would state it twice.
  [SessionGroupBy.Priority]: (
    <SignalIcon className="size-4 text-muted-foreground" />
  ),
};

/** Renders the canonical state-specific mark for a champion Session band. */
export function SessionStatusGroupIcon({
  rawStatus,
  status,
}: Readonly<{ rawStatus?: string | null; status: string }>) {
  const facet = sessionStatusFacet(status, rawStatus);
  return (
    <StatusAppearanceIcon
      appearance={resolveArtifactStatusMark(facet).appearance}
      aria-hidden="true"
      label={artifactStatusLabel(facet)}
      size={16}
    />
  );
}
