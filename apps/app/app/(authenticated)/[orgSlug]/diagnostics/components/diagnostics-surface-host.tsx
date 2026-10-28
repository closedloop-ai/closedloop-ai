"use client";

import { DiagnosticsSurfaceV2 } from "@repo/app/diagnostics/components/diagnostics-surface-v2";
import {
  type DiagnosticsSource,
  DiagnosticsTransportStatus,
} from "@repo/app/diagnostics/lib/diagnostics-source";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FileTextIcon } from "lucide-react";
import {
  DIAGNOSTICS_ROUTE_TITLE,
  WEB_COVERAGE_AXIS_LABELS,
  WEB_DIAGNOSTICS_AVAILABLE_SECTIONS,
  WEB_DIAGNOSTICS_DESCRIPTION,
  WEB_GATEWAY_LOGS_DESCRIPTION,
  WEB_GATEWAY_LOGS_TITLE,
  WEB_PROBE_UNAVAILABLE_MESSAGE,
  WEB_SECTION_UNSERVABLE_REASON,
} from "../web-diagnostics-contract";

function noop(): void {
  return;
}

/**
 * ISS-10006 — the WEB host for `DiagnosticsSurfaceV2`.
 *
 * It mounts the route and supplies no probe, which is the whole finding: the
 * probe is `window.desktopApi.db.getDiagnostics`, one local read over the
 * gateway store on the machine that runs the agents. A browser has no such
 * store and the cloud holds no record of it, so there is nothing here to read —
 * not now, and not after a retry.
 *
 * Per the treatment ruling of 2026-09-22 that fact is stated, never implied:
 *
 * - the route-level notice says the reader is on the wrong machine for this;
 * - `unservableReason` makes every section body say so in its own name, instead
 *   of the EMPTY body a null payload would otherwise render — an empty Repos
 *   list asserts "there are no repos", which is the confident-zero defect
 *   ISS-9931 and ISS-10541/10543 already had to fix elsewhere;
 * - Withheld and Coverage stay in `availableSections` although they are the two
 *   sections a host is allowed to drop, because dropping them shortens the tab
 *   strip with no statement, and a silently shorter strip is the silent omission
 *   AC1 forbids;
 * - Gateway Logs gets a body, so the tab is offered and opening it explains
 *   where the logs are. It is not a Desktop hand-off: the browser cannot observe
 *   whether `closedloop://` was handled, so that control can fail silently, and
 *   a section-targeted link would additionally owe ISS-6109's allowlist;
 * - the surface drops Refresh on its own once `unservableReason` is set, so no
 *   control on this page promises something the host cannot do.
 */
export function WebDiagnosticsSurfaceHost() {
  const source: DiagnosticsSource = {
    autoRefresh: null,
    availableSections: WEB_DIAGNOSTICS_AVAILABLE_SECTIONS,
    errorMessage: WEB_PROBE_UNAVAILABLE_MESSAGE,
    onSectionChange: noop,
    payload: null,
    // Required, and still honest: the surface offers no control for it on this
    // host, so it is never reachable. Left as an explicit no-op rather than a
    // throw, because a prop that throws when called is a trap for a later host.
    refresh: { busy: false, run: noop },
    settledSections: [],
    status: DiagnosticsTransportStatus.Unavailable,
    unservableReason: WEB_SECTION_UNSERVABLE_REASON,
  };

  return (
    <DiagnosticsSurfaceV2
      coverageAxisLabels={WEB_COVERAGE_AXIS_LABELS}
      description={WEB_DIAGNOSTICS_DESCRIPTION}
      logs={
        <EmptyState
          description={WEB_GATEWAY_LOGS_DESCRIPTION}
          icon={FileTextIcon}
          size="compact"
          title={WEB_GATEWAY_LOGS_TITLE}
        />
      }
      source={source}
      title={DIAGNOSTICS_ROUTE_TITLE}
    />
  );
}
