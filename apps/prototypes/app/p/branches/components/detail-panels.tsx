"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitPullRequestIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  BRANCH_STATUS_CONFIG,
  BranchCostAvailability,
  type BranchDetail,
  PR_STATE_VARIANT,
} from "../mock";
import { PrDescriptionMarkdown } from "./pr-description-markdown";
import { PropertiesPanel, type PropertyRow } from "./properties-panel";

// Shared branch-detail section title: 14px, semibold, foreground, normal case.
const SECTION_TITLE_CLASS = "font-semibold text-foreground text-sm";

/** Shared visual heading for Branch Detail prototype sections. */
export function SectionHead({
  title,
  count,
  trailing,
  className,
}: {
  title: ReactNode;
  count?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mt-8 mb-2 flex items-center gap-2.5", className)}>
      <span className={SECTION_TITLE_CLASS}>{title}</span>
      {count == null ? null : (
        <span className="text-muted-foreground text-xs">{count}</span>
      )}
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </div>
  );
}

// --- Properties (collapsible, quiet) --------------------------------------

export function BranchPropertiesPanel({ detail }: { detail: BranchDetail }) {
  const config = BRANCH_STATUS_CONFIG[detail.status];
  const hasChanges = detail.additions != null && detail.deletions != null;

  // Row order flows into the two-column auto-fit grid left-to-right, so this
  // renders Status / Pull request / Reviewer / Sessions down the left and
  // Branch / Changes / Repository down the right — matching the product.
  const rows: PropertyRow[] = [
    {
      label: "Status",
      value: (
        <span className="inline-flex items-center gap-2">
          <span
            className="size-2 rounded-[0.1875rem]"
            style={{ background: config.dot }}
          />
          {config.label}
        </span>
      ),
    },
    {
      label: "Branch",
      value: <span className="truncate font-mono">{detail.branchName}</span>,
    },
    {
      label: "Pull request",
      value:
        detail.prNumber == null ? (
          <span className="text-muted-foreground">No PR yet</span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <GitPullRequestIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="font-mono">#{detail.prNumber}</span>
            {detail.prTitle ? (
              <span className="min-w-0 truncate">{detail.prTitle}</span>
            ) : null}
          </span>
        ),
    },
    {
      label: "Changes",
      value: hasChanges ? (
        <span className="inline-flex items-center gap-2 font-mono">
          <b className="text-success">+{detail.additions}</b>
          <b className="text-destructive">−{detail.deletions}</b>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Reviewer",
      value: <span className="text-muted-foreground">Unassigned</span>,
    },
    {
      label: "Repository",
      value: <span className="truncate font-mono">{detail.repoFullName}</span>,
    },
    {
      label: "Sessions",
      value: `${detail.sessions.length} session${detail.sessions.length === 1 ? "" : "s"}`,
    },
  ];

  return (
    <PropertiesPanel
      collapsedSummary={
        <>
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap text-sm">
            <span
              className="size-2 shrink-0 rounded-[0.1875rem]"
              style={{ background: config.dot }}
            />
            {config.label}
          </span>
          <span
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap font-mono text-sm"
            title={detail.branchName}
          >
            <GitBranchIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate">{detail.branchName}</span>
          </span>
          {detail.prNumber == null ? null : (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-sm">
              <GitPullRequestIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              #{detail.prNumber}
            </span>
          )}
        </>
      }
      rows={rows}
    />
  );
}

// --- Headline metric cards -------------------------------------------------

export function BranchHeadlineCards({ detail }: { detail: BranchDetail }) {
  const loc =
    detail.additions === null || detail.deletions === null
      ? "LOC unavailable"
      : `${detail.additions + detail.deletions} lines changed`;
  return (
    <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <MetricCard
        detail={headlineCostDetail(detail, loc)}
        info={{
          what: "Total lines changed (added + removed) per dollar spent.",
          how: "Lines changed divided by canonical attributed Build, Review, and Rework cost. Prefers the connected PR's live LOC.",
        }}
        label="LOC per $"
        unitLabel="LOC/$"
        value={detail.valuePerDollar}
        valueUnavailable={isLocPerDollarUnavailable(detail)}
        valueUnavailableLabel={detail.valuePerDollar}
      />
      <MetricCard
        detail="First code pushed → merge"
        info={{
          what: "Wall-clock time from the first code pushed to GitHub until merge.",
          how: "For an open pull request, elapsed time continues through the present.",
        }}
        label="Lead time for change"
        value={detail.leadTimeLabel}
      />
    </div>
  );
}

// Keep the token-cost definitions shared across the aggregate cost chart and
// chronological lead-time chart so both views explain phases consistently.
const PHASE_COPY = {
  build:
    "Token cost from the first code pushed to GitHub until the pull request is opened.",
  review:
    "Token cost after the pull request is opened when the session contributes review comments but does not push new commits.",
  rework:
    "Token cost after the pull request is opened when the session pushes one or more new commits.",
} as const;

function PhaseTooltip({
  children,
  phase,
}: {
  children: ReactNode;
  phase: keyof typeof PHASE_COPY;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-72">{PHASE_COPY[phase]}</TooltipContent>
    </Tooltip>
  );
}

// --- Cost breakdown --------------------------------------------------------

export function BranchCostToMerge({ detail }: { detail: BranchDetail }) {
  const showBreakdown =
    detail.costAvailability !== BranchCostAvailability.Unavailable &&
    detail.attributedCostUsd !== null &&
    detail.attributedCostUsd > 0;
  return (
    <section>
      <SectionHead count={detail.costTotal} title="Cost breakdown" />
      {showBreakdown ? <CostBreakdownRows detail={detail} /> : null}
      {detail.attributedCostUsd === 0 ? (
        <p className="text-muted-foreground text-xs">
          No priced spend recorded yet.
        </p>
      ) : null}
      {detail.costAvailability === BranchCostAvailability.Unavailable ? (
        <p className="text-muted-foreground text-xs">
          Build, Review, and Rework cost evidence is unavailable.
        </p>
      ) : null}
      {detail.costDisclosure ? (
        <p className="mt-2 text-muted-foreground text-xs">
          {detail.costDisclosure}
        </p>
      ) : null}
    </section>
  );
}

function CostBreakdownRows({ detail }: { detail: BranchDetail }) {
  return (
    <>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {detail.costSegments.map((segment) => (
          <PhaseTooltip key={segment.key} phase={segment.key}>
            <span
              className="block h-full"
              style={{ width: `${segment.pct}%`, background: segment.color }}
            />
          </PhaseTooltip>
        ))}
      </div>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {detail.costSegments.map((segment) => (
          <PhaseTooltip key={segment.key} phase={segment.key}>
            <div className="flex items-center gap-2 text-sm">
              <span
                className="size-2.5 rounded-[3px]"
                style={{ background: segment.color }}
              />
              <span>{segment.label}</span>
              <span className="ml-auto font-mono text-muted-foreground text-xs">
                {segment.duration} · {segment.cost} · {segment.pct}%
              </span>
            </div>
          </PhaseTooltip>
        ))}
      </div>
    </>
  );
}

function headlineCostDetail(detail: BranchDetail, loc: string): string {
  const evidence = `${loc} · ${detail.costLabel}`;
  return detail.costDisclosure
    ? `${evidence} · ${detail.costDisclosure}`
    : evidence;
}

function isLocPerDollarUnavailable(detail: BranchDetail): boolean {
  return (
    detail.costAvailability === BranchCostAvailability.Unavailable ||
    detail.attributedCostUsd === 0 ||
    detail.additions === null ||
    detail.deletions === null
  );
}

// --- Lead-time waterfall ---------------------------------------------------

export function BranchLeadTimeWaterfall({ detail }: { detail: BranchDetail }) {
  const headCount = `${detail.wallClockLabel} · ${detail.idlePct}% idle`;
  const phaseByKey = new Map(
    detail.costSegments.map((segment) => [segment.key, segment])
  );
  const firstPostBuildIndex = detail.waterfall.findIndex(
    (segment) => segment.type === "review" || segment.type === "rework"
  );
  const prOpenedPct = detail.waterfall
    .slice(
      0,
      firstPostBuildIndex < 0 ? detail.waterfall.length : firstPostBuildIndex
    )
    .reduce((total, segment) => total + segment.pct, 0);
  return (
    <section>
      <SectionHead count={headCount} title="Lead time for change" />
      <div className="relative">
        <div className="flex h-3 w-full gap-px overflow-hidden rounded-full bg-muted/40">
          {detail.waterfall.map((seg, index) =>
            seg.type === "idle" ? (
              <span
                className="h-full bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,var(--muted-foreground)_2px,var(--muted-foreground)_3px)] opacity-40"
                // biome-ignore lint/suspicious/noArrayIndexKey: positional segments.
                key={`idle-${index}`}
                style={{ width: `${seg.pct}%` }}
              />
            ) : (
              <PhaseTooltip
                // biome-ignore lint/suspicious/noArrayIndexKey: positional segments.
                key={`${seg.type}-${index}`}
                phase={seg.type}
              >
                <span
                  className="block h-full"
                  style={{
                    width: `${seg.pct}%`,
                    background: phaseByKey.get(seg.type)?.color,
                  }}
                />
              </PhaseTooltip>
            )
          )}
        </div>
        <span
          aria-hidden
          className="absolute -top-1 h-5 border-foreground/50 border-l"
          style={{ left: `${prOpenedPct}%` }}
        />
      </div>
      <div className="relative mt-1.5 flex justify-between font-mono text-muted-foreground text-xs">
        <span>First code pushed</span>
        <span
          className="absolute -translate-x-1/2"
          style={{ left: `${prOpenedPct}%` }}
        >
          PR opened
        </span>
        <span>{detail.merged ? "Merged" : "In progress"}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-muted-foreground text-xs">
        {detail.costSegments.map((segment) => (
          <PhaseTooltip key={segment.key} phase={segment.key}>
            <span className="flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-[3px]"
                style={{ background: segment.color }}
              />
              {segment.label}
              <b className="font-mono text-foreground">{segment.duration}</b>
            </span>
          </PhaseTooltip>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,var(--muted-foreground)_2px,var(--muted-foreground)_3px)]" />
          Idle / waiting
          <b className="font-mono text-foreground">{detail.idleLabel}</b>
        </span>
      </div>
    </section>
  );
}

// --- What was delivered ----------------------------------------------------

export function BranchDeliveredPanel({ detail }: { detail: BranchDetail }) {
  const [open, setOpen] = useState(false);
  const selected = detail.selectedPullRequest;
  const prNumber = selected ? selected.number : detail.prNumber;
  const prTitle = selected ? selected.title : detail.prTitle;
  const prUrl = selected ? selected.url : detail.prUrl;
  const prState = selected ? selected.state : detail.prState;
  const bodySource = selected?.body ?? detail.prBody;
  const body = bodySource?.trim() ? bodySource : null;
  const stateChip =
    prState == null ? null : (
      <Chip size="sm" variant={PR_STATE_VARIANT[prState]}>
        {prState}
      </Chip>
    );

  return (
    <section>
      <SectionHead title="What was delivered" />
      {detail.deliveredArtifacts.length > 0 ? (
        <div className="mb-2 flex flex-col gap-1.5">
          {detail.deliveredArtifacts.map((artifact) => (
            <div
              className="flex items-center gap-2.5 rounded-md border bg-card px-3 py-2 text-sm"
              key={artifact.slug}
            >
              <span className="flex items-center gap-1.5 font-medium font-mono text-primary text-xs">
                <FileTextIcon aria-hidden className="size-3.5" />
                {artifact.slug}
              </span>
              <span className="text-muted-foreground">Closedloop artifact</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="rounded-md border bg-card px-3.5 py-3">
        <div className="mb-2 flex items-center gap-2 text-muted-foreground">
          <GitPullRequestIcon aria-hidden className="size-3.5" />
          <span className="font-semibold text-[0.6875rem] uppercase tracking-[0.05em]">
            Pull request
          </span>
          {prNumber == null ? null : (
            <span className="font-mono text-foreground text-xs">
              #{prNumber}
            </span>
          )}
          {stateChip}
          {prUrl ? (
            <a
              aria-label={
                prNumber == null
                  ? "Open pull request"
                  : `Open pull request #${prNumber}`
              }
              className="ml-auto text-muted-foreground hover:text-foreground"
              href={prUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </a>
          ) : null}
        </div>
        {prTitle ? <p className="font-medium text-sm">{prTitle}</p> : null}
        {body ? (
          <>
            <div
              className={cn(
                "mt-2 break-words text-foreground text-sm leading-relaxed",
                !open &&
                  "max-h-[5.75rem] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_55%,transparent)]"
              )}
              inert={!open}
            >
              <PrDescriptionMarkdown text={body} />
            </div>
            <button
              aria-expanded={open}
              className="mt-1.5 font-medium text-primary text-sm"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              {open ? "Show less" : "Show full description"}
            </button>
          </>
        ) : (
          <p className="mt-2 text-muted-foreground text-sm">
            No PR description yet.
          </p>
        )}
      </div>
    </section>
  );
}

// --- Checks & review -------------------------------------------------------

function StatusRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function BranchChecksReviewPanel({ detail }: { detail: BranchDetail }) {
  const prState = detail.prState ?? "open";
  const lifecycleLabel =
    prState === "open"
      ? BRANCH_STATUS_CONFIG[detail.status].label
      : prState[0]?.toUpperCase() + prState.slice(1);
  return (
    <section>
      <SectionHead
        title="Checks & review"
        trailing={
          <Chip size="sm" variant={PR_STATE_VARIANT[prState]}>
            {lifecycleLabel}
          </Chip>
        }
      />
      <div className="flex flex-col gap-1.5 py-1">
        <StatusRow label="Review" value={detail.reviewLabel} />
        <StatusRow
          label="Checks"
          value={
            detail.checks
              ? `${detail.checks.passed}/${detail.checks.total} passing`
              : "Not available yet"
          }
        />
        <StatusRow label="Behind / ahead" value="Not available yet" />
      </div>
    </section>
  );
}
