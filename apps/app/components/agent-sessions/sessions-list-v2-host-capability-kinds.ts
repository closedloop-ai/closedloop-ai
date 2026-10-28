import {
  HOST_CAPABILITY,
  type SurfaceCapabilityKinds,
} from "@repo/app/shared/lib/surface-capability-kind";
import type { ComponentProps } from "react";
import type { SessionsListV2Host } from "./sessions-list-v2-host";

/**
 * ISS-9218 — the {@link SessionsListV2Host} half of the capability-kind
 * declaration; see `@repo/app/shared/lib/surface-capability-kind` for what the
 * two kinds mean and why the map lives beside the prop type.
 *
 * Every entry is {@link HOST_CAPABILITY}: the host's forwarded presentation prop
 * was `pageSizeOptions`, and ISS-9216 retired it — along with
 * `paginationReadout` — into the surface that renders the footer, so this host
 * has no rendering option left to forward.
 */
export const SESSIONS_LIST_V2_HOST_CAPABILITY_KINDS = {
  columnOrder: HOST_CAPABILITY,
  columnWidths: HOST_CAPABILITY,
  customDateWindow: HOST_CAPABILITY,
  errorRecoveryAction: HOST_CAPABILITY,
  exportItem: HOST_CAPABILITY,
  getIssueHref: HOST_CAPABILITY,
  hasConnectedAgent: HOST_CAPABILITY,
  hasSessionsOutsideWindow: HOST_CAPABILITY,
  hiddenSummaryCards: HOST_CAPABILITY,
  isPlaceholderPage: HOST_CAPABILITY,
  onColumnOrderChange: HOST_CAPABILITY,
  onColumnWidthChange: HOST_CAPABILITY,
  onCustomDateWindowChange: HOST_CAPABILITY,
  onPageSizeChange: HOST_CAPABILITY,
  onResetView: HOST_CAPABILITY,
  onRetry: HOST_CAPABILITY,
  onTimezoneModeChange: HOST_CAPABILITY,
  onToggleSummaryCard: HOST_CAPABILITY,
  onboardingAction: HOST_CAPABILITY,
  pageInfo: HOST_CAPABILITY,
  projectFacetEnabled: HOST_CAPABILITY,
  summaryCards: HOST_CAPABILITY,
  tableScrollRef: HOST_CAPABILITY,
  timezoneMode: HOST_CAPABILITY,
} as const satisfies SurfaceCapabilityKinds<
  ComponentProps<typeof SessionsListV2Host>
>;
