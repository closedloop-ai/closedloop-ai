"use client";

import { useAnalytics } from "@repo/analytics/client";
import {
  SystemCheckResults as SharedSystemCheckResults,
  type SystemCheckResultsRemediationClick,
  type SystemCheckResultsRemediationView,
} from "@repo/app/compute/components/system-check-results";
import { type ReactNode, useCallback } from "react";
import type { CheckResult } from "@/lib/engineer/queries/health-check";

type SystemCheckResultsProps = {
  checks?: CheckResult[];
  isLoading?: boolean;
  revealedCount?: number;
  className?: string;
  afterRequired?: ReactNode;
  pluginAutoUpdateEnabled?: boolean;
  targetKind?: "local" | "owned_relay" | "shared_relay";
};

export function SystemCheckResults({
  checks,
  isLoading = false,
  revealedCount,
  className,
  afterRequired,
  pluginAutoUpdateEnabled = false,
  targetKind = "local",
}: Readonly<SystemCheckResultsProps>) {
  const analytics = useAnalytics();

  const handleStructuredRemediationViewed = useCallback(
    (payload: SystemCheckResultsRemediationView) => {
      analytics.capture("plugin_autoupdate_remediation_viewed", {
        check_id: payload.checkId,
        structured_links_present: payload.structuredLinksPresent,
        target_kind: payload.targetKind,
        update_outcome: payload.updateOutcome,
      });
    },
    [analytics]
  );

  const handleStructuredRemediationLinkClick = useCallback(
    (payload: SystemCheckResultsRemediationClick) => {
      analytics.capture("plugin_autoupdate_docs_link_clicked", {
        check_id: payload.checkId,
        link_url: payload.linkUrl,
        structured_links_present: payload.structuredLinksPresent,
        target_kind: payload.targetKind,
        update_outcome: payload.updateOutcome,
      });
    },
    [analytics]
  );

  return (
    <SharedSystemCheckResults
      afterRequired={afterRequired}
      checks={checks}
      className={className}
      isLoading={isLoading}
      onStructuredRemediationLinkClick={handleStructuredRemediationLinkClick}
      onStructuredRemediationViewed={handleStructuredRemediationViewed}
      pluginAutoUpdateEnabled={pluginAutoUpdateEnabled}
      revealedCount={revealedCount}
      targetKind={targetKind}
    />
  );
}
