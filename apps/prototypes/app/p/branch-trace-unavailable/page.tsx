"use client";

// ISS-5555: the Branch Details page (branches prototype, HandedOff) with the
// Sessions & timeline tab's trace read forced into each of its outcomes. The
// shell, tabs, Branch-details panels, and comments rails are imported from the
// flow owner (`app/p/branches`) — same precedent as web-master — so this page
// is that page; only the Sessions & timeline tab body is reimplemented, with
// the degraded-state rendering the production tab is missing.

import { Button } from "@repo/design-system/components/ui/button";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs, TabsContent } from "@repo/design-system/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { PanelRightIcon } from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/app/p/branches/components/app-shell";
import { BranchCommentsPanel } from "@/app/p/branches/components/branch-comments-panel";
import { BranchDetailTab } from "@/app/p/branches/components/branch-detail";
import { BranchFilesChangedPanel } from "@/app/p/branches/components/branch-files-changed-panel";
import {
  BranchChecksReviewPanel,
  BranchCostToMerge,
  BranchDeliveredPanel,
  BranchHeadlineCards,
  BranchLeadTimeWaterfall,
  BranchPropertiesPanel,
} from "@/app/p/branches/components/detail-panels";
import type { BranchDetail } from "@/app/p/branches/mock";
import { DegradedSessionsTimeline } from "./components/sessions-timeline-degraded";
import {
  BUG_DETAIL,
  FULL_DETAIL,
  PARTIAL_DETAIL,
  TraceReadOutcome,
  TraceUnavailableReason,
  UNAVAILABLE_SESSION,
} from "./mock";

const OUTCOME_LABEL: Record<TraceReadOutcome, string> = {
  [TraceReadOutcome.Loaded]: "Loaded",
  [TraceReadOutcome.BugEmpty]: "Bug (today)",
  [TraceReadOutcome.Unavailable]: "Unavailable (fix)",
  [TraceReadOutcome.Incomplete]: "Incomplete (fix)",
};

const OUTCOMES: readonly TraceReadOutcome[] = [
  TraceReadOutcome.Loaded,
  TraceReadOutcome.BugEmpty,
  TraceReadOutcome.Unavailable,
  TraceReadOutcome.Incomplete,
];

const REASON_LABEL: Record<TraceUnavailableReason, string> = {
  [TraceUnavailableReason.Authentication]: "Auth",
  [TraceUnavailableReason.Permission]: "Permission",
  [TraceUnavailableReason.PageFailure]: "Page failure",
  [TraceUnavailableReason.Malformed]: "Malformed",
  [TraceUnavailableReason.LegacyResponse]: "Legacy",
  [TraceUnavailableReason.Unknown]: "Unknown",
};

const REASONS: readonly TraceUnavailableReason[] = [
  TraceUnavailableReason.Authentication,
  TraceUnavailableReason.Permission,
  TraceUnavailableReason.PageFailure,
  TraceUnavailableReason.Malformed,
  TraceUnavailableReason.LegacyResponse,
];

// The Incomplete scenario's per-session failure reason is fixed: one session's
// detail read hit a transient page failure while the rest hydrated.
const INCOMPLETE_REASON = TraceUnavailableReason.PageFailure;

const OUTCOME_DETAIL: Record<TraceReadOutcome, BranchDetail> = {
  [TraceReadOutcome.Loaded]: FULL_DETAIL,
  [TraceReadOutcome.BugEmpty]: BUG_DETAIL,
  [TraceReadOutcome.Unavailable]: FULL_DETAIL,
  [TraceReadOutcome.Incomplete]: PARTIAL_DETAIL,
};

const BranchTraceUnavailablePrototypePage = () => {
  const [activeTab, setActiveTab] = useState<BranchDetailTab>(
    BranchDetailTab.Sessions
  );
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);
  const [outcome, setOutcome] = useState<TraceReadOutcome>(
    TraceReadOutcome.BugEmpty
  );
  const [reason, setReason] = useState<TraceUnavailableReason>(
    TraceUnavailableReason.PageFailure
  );
  const [retrying, setRetrying] = useState(false);

  // The Branch details tab always renders FULL_DETAIL: its data comes from the
  // detail/analytics reads, which succeed in every scenario here. Only the
  // Sessions & timeline tab consumes the trace read.
  const detail = FULL_DETAIL;
  const timelineDetail = OUTCOME_DETAIL[outcome];

  // The signed-out condition: an expired session is the only way a trace-read
  // auth failure is reachable under a loaded page (the route is auth-gated and
  // the detail read fires first, so a never-signed-in visitor gets the
  // page-level error state instead). Everything rendered around the disclosure
  // was loaded BEFORE expiry and is served from cache — real but stale, and
  // nothing new can load or post until re-auth.
  const isSignedOut =
    outcome === TraceReadOutcome.Unavailable &&
    reason === TraceUnavailableReason.Authentication;

  // Retry drives real state. A transient failure retries into the same failure
  // ("retried and it failed again" is one of the truthful states); sign-in is
  // different — re-auth genuinely restores every read, so it resolves to the
  // loaded page.
  const handleRetry = () => {
    setRetrying(true);
    if (isSignedOut) {
      setTimeout(() => {
        setOutcome(TraceReadOutcome.Loaded);
        setRetrying(false);
      }, 900);
      return;
    }
    setTimeout(() => setRetrying(false), 900);
  };

  return (
    <Tabs
      className="h-svh w-full gap-0"
      onValueChange={(value) => setActiveTab(value as BranchDetailTab)}
      value={activeTab}
    >
      <AppShell
        actions={
          <CommentsToggle
            collapsed={commentsCollapsed}
            onToggle={() => setCommentsCollapsed((value) => !value)}
          />
        }
        breadcrumbs={[
          { label: "Branches" },
          { label: detail.branchName, isCurrent: true },
        ]}
        navigation={
          <UnderlineTabsList>
            <UnderlineTabsTrigger value={BranchDetailTab.Details}>
              Branch details
            </UnderlineTabsTrigger>
            <UnderlineTabsTrigger value={BranchDetailTab.Sessions}>
              Sessions &amp; timeline
            </UnderlineTabsTrigger>
          </UnderlineTabsList>
        }
      >
        <div className="flex min-h-0 flex-1">
          <h1 className="sr-only">Branch {detail.branchName}</h1>
          <div className="flex min-h-0 min-w-0 flex-1">
            <TabsContent
              className="mx-auto min-h-0 w-full max-w-content flex-1 overflow-auto px-5 pt-4 pb-6"
              value={BranchDetailTab.Details}
            >
              <BranchPropertiesPanel detail={detail} />
              <BranchHeadlineCards detail={detail} />
              <BranchCostToMerge detail={detail} />
              <BranchLeadTimeWaterfall detail={detail} />
              <BranchDeliveredPanel detail={detail} />
              <BranchChecksReviewPanel detail={detail} />
              <BranchFilesChangedPanel detail={detail} />
            </TabsContent>

            <TabsContent
              className="min-h-0 flex-1 overflow-auto"
              value={BranchDetailTab.Sessions}
            >
              <ScenarioSwitcher
                onReasonChange={(value) => {
                  setReason(value);
                  setRetrying(false);
                }}
                onSelect={(value) => {
                  setOutcome(value);
                  setRetrying(false);
                }}
                outcome={outcome}
                reason={reason}
              />
              <DegradedSessionsTimeline
                detail={timelineDetail}
                onRetry={handleRetry}
                outcome={outcome}
                reason={
                  outcome === TraceReadOutcome.Incomplete
                    ? INCOMPLETE_REASON
                    : reason
                }
                retrying={retrying}
                totalSessionCount={FULL_DETAIL.sessions.length}
                unavailableSession={UNAVAILABLE_SESSION}
              />
            </TabsContent>
          </div>

          <BranchCommentsPanel
            comments={detail.comments}
            emptyDescription="Pull request review comments and replies appear here."
            hidden={commentsCollapsed || activeTab !== BranchDetailTab.Details}
            placeholder="Add a PR comment…"
            readOnly
            title="PR comments"
          />
          <BranchCommentsPanel
            comments={detail.sessionComments}
            emptyDescription="Comments about sessions and timeline events appear here."
            hidden={commentsCollapsed || activeTab !== BranchDetailTab.Sessions}
            placeholder="Add a session comment…"
            // Signed out: cached comments still render (loaded before expiry),
            // but posting would 401 — the composer goes away rather than
            // offering a control that can't work.
            readOnly={isSignedOut}
            title="Session comments"
          />
        </div>
      </AppShell>
    </Tabs>
  );
};

/**
 * Prototype-only chrome (dashed = not part of the page): forces the combined
 * trace read into each outcome, since the failure can't be induced on demand
 * with mock data any more than it could live (the ticket is CODE-DERIVED).
 */
function ScenarioSwitcher({
  onReasonChange,
  onSelect,
  outcome,
  reason,
}: {
  onReasonChange: (value: TraceUnavailableReason) => void;
  onSelect: (value: TraceReadOutcome) => void;
  outcome: TraceReadOutcome;
  reason: TraceUnavailableReason;
}) {
  return (
    <div className="mx-auto w-full max-w-content px-5 pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border border-dashed bg-muted/30 px-3 py-2">
        <span className="text-muted-foreground text-xs">
          <span className="font-medium text-foreground">ISS-5555</span> · trace
          read outcome
        </span>
        <ToggleGroup
          aria-label="Trace read outcome"
          onValueChange={(value) => {
            if (value) {
              onSelect(value as TraceReadOutcome);
            }
          }}
          type="single"
          value={outcome}
          variant="outline"
        >
          {OUTCOMES.map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {OUTCOME_LABEL[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {outcome === TraceReadOutcome.Unavailable ? (
          <ToggleGroup
            aria-label="Failure reason"
            onValueChange={(value) => {
              if (value) {
                onReasonChange(value as TraceUnavailableReason);
              }
            }}
            type="single"
            value={reason}
            variant="outline"
          >
            {REASONS.map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {REASON_LABEL[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>
    </div>
  );
}

function CommentsToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? "Show comments rail" : "Hide comments rail";

  return (
    <Button
      aria-label={label}
      aria-pressed={!collapsed}
      onClick={onToggle}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
    >
      <PanelRightIcon aria-hidden />
    </Button>
  );
}

export default BranchTraceUnavailablePrototypePage;
