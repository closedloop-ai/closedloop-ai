"use client";

import type {
  User,
  UserContributionHeatmap,
  UserProfileHeadline,
} from "@repo/api/src/types/user";
import { DashboardCard } from "@repo/app/insights/components/overview/dashboard-card";
import { formatTokenCount } from "@repo/app/shared/lib/format-utils";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { MilestonesSection } from "@repo/app/users/components/milestones-section";
import { StandingSection } from "@repo/app/users/components/standing-section";
import {
  useUser,
  useUserContributionHeatmap,
  useUserProfileHeadline,
  useUserProfileMilestones,
  useUserProfileStanding,
} from "@repo/app/users/hooks/use-users";
import { Alert, AlertTitle } from "@repo/design-system/components/ui/alert";
import { AnalyticsRangeToggle } from "@repo/design-system/components/ui/analytics-range-toggle";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import dynamic from "next/dynamic";
import { type ReactNode, use, useMemo, useState } from "react";
import { Header } from "../../../components/header";
import { DocumentsByTypeChart } from "./components/documents-by-type-chart";
import { UserProfileHeader } from "./components/user-profile-header";
import {
  DEFAULT_PROFILE_RANGE,
  getProfileRangeStartIso,
  PROFILE_RANGE_LABELS,
  PROFILE_RANGE_SHORT_LABELS,
  PROFILE_RANGES,
  type ProfileRange,
  parseProfileRange,
} from "./lib/profile-range";

const ContributionHeatmap = dynamic(
  () =>
    import("@repo/app/users/components/contribution-heatmap").then(
      (mod) => mod.ContributionHeatmap
    ),
  { ssr: false }
);

type PageProps = {
  params: Promise<{ orgSlug: string; userId: string }>;
};

const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

// The contribution heatmap is a trailing-year grid by definition and is
// deliberately NOT re-scoped by the headline range toggle. Stating its own
// window keeps the range control from reading as broken when the heatmap
// doesn't move with it (FEA-4064).
const HEATMAP_WINDOW_LABEL = "Past year";

export default function UserProfilePage({ params }: PageProps) {
  const { orgSlug, userId } = use(params);
  const [range, setRange] = useState<ProfileRange>(DEFAULT_PROFILE_RANGE);

  const headlineFilters = useMemo(
    () => ({ startDate: getProfileRangeStartIso(range) }),
    [range]
  );

  const { data: user, isLoading: userLoading } = useUser(userId);

  // FEA-4064: two independent widget queries. The headline query is the ONLY
  // one keyed by the range window, so a range click re-fetches it alone. The
  // contribution heatmap query is unkeyed by the window and owns its own
  // loading/error state, so the toggle never re-issues the trailing-year heatmap
  // SQL and a slow/failing heatmap read never blocks or fails the headline.
  const {
    data: headline,
    isLoading: headlineLoading,
    isError: headlineError,
  } = useUserProfileHeadline(userId, headlineFilters);
  const {
    data: heatmap,
    isLoading: heatmapLoading,
    isError: heatmapError,
  } = useUserContributionHeatmap(userId);

  // FEA-4108: standing (streak) + milestones load as their own independent
  // widgets, so a slow or failing read of either degrades that section alone
  // without blocking the headline or the rest of the profile.
  const {
    data: standing,
    isLoading: standingLoading,
    isError: standingError,
  } = useUserProfileStanding(userId);
  const {
    data: milestones,
    isLoading: milestonesLoading,
    isError: milestonesError,
  } = useUserProfileMilestones(userId);

  const fullName = user ? getUserDisplayName(user) : "User";

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Users", href: `/${orgSlug}` },
          { label: fullName },
        ]}
        suppressPageHeading
      />
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-auto p-6">
        <ProfileHeaderRow
          isLoading={userLoading}
          onRangeChange={setRange}
          range={range}
          user={user ?? null}
        />

        <HeadlineSection
          headline={headline ?? null}
          isError={headlineError}
          isLoading={headlineLoading}
          rangeLabel={PROFILE_RANGE_LABELS[range]}
        />

        <StandingSection
          isError={standingError}
          isLoading={standingLoading}
          standing={standing ?? null}
        />

        <ActivitySection
          artifacts={headline?.documentsByType ?? null}
          artifactsError={headlineError}
          artifactsLoading={headlineLoading}
          heatmap={heatmap ?? null}
          heatmapError={heatmapError}
          heatmapLoading={heatmapLoading}
          rangeLabel={PROFILE_RANGE_LABELS[range]}
        />

        <MilestonesSection
          isError={milestonesError}
          isLoading={milestonesLoading}
          milestones={milestones ?? null}
        />
      </div>
    </>
  );
}

// The range toggle belongs to the page, not the user card: it scopes the
// headline metrics regardless of whether the user profile is still loading or
// missing, so it renders in the page header row alongside the identity block and
// survives both the loading skeleton and the not-found state (FEA-4064).
function ProfileHeaderRow({
  isLoading,
  user,
  range,
  onRangeChange,
}: {
  isLoading: boolean;
  user: User | null;
  range: ProfileRange;
  onRangeChange: (range: ProfileRange) => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <ProfileIdentity isLoading={isLoading} user={user} />
      <RangeControl
        onRangeChange={onRangeChange}
        range={range}
        // Mirror the usage dashboard: the window statement sits directly under
        // the pills as one unit so the control and what it scopes read together.
        windowLabel={PROFILE_RANGE_LABELS[range]}
      />
    </div>
  );
}

function ProfileIdentity({
  isLoading,
  user,
}: {
  isLoading: boolean;
  user: User | null;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-4">
        <Skeleton className="h-16 w-16 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
    );
  }
  if (user) {
    return <UserProfileHeader user={user} />;
  }
  return (
    <Alert variant="error">
      <AlertTitle>User not found</AlertTitle>
    </Alert>
  );
}

function RangeControl({
  range,
  onRangeChange,
  windowLabel,
}: {
  range: ProfileRange;
  onRangeChange: (range: ProfileRange) => void;
  windowLabel: string;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <AnalyticsRangeToggle
        onValueChange={(value) => onRangeChange(parseProfileRange(value))}
        options={PROFILE_RANGES.map((value) => ({
          value,
          label: PROFILE_RANGE_SHORT_LABELS[value],
        }))}
        value={range}
      />
      <p className="text-muted-foreground text-xs">
        Showing {windowLabel.toLowerCase()}
      </p>
    </div>
  );
}

function HeadlineSection({
  isLoading,
  isError,
  headline,
  rangeLabel,
}: {
  isLoading: boolean;
  isError: boolean;
  headline: UserProfileHeadline | null;
  rangeLabel: string;
}) {
  return (
    <section aria-labelledby="headline-stats-heading" className="space-y-4">
      <SectionHeading id="headline-stats-heading" windowLabel={rangeLabel}>
        Headline metrics
      </SectionHeading>
      <HeadlineGrid
        headline={headline}
        isError={isError}
        isLoading={isLoading}
      />
    </section>
  );
}

function HeadlineGrid({
  isLoading,
  isError,
  headline,
}: {
  isLoading: boolean;
  isError: boolean;
  headline: UserProfileHeadline | null;
}) {
  if (isLoading) {
    // Match the real card footprint (label + text-3xl value ≈ h-28) and the
    // final count so the grid doesn't reflow when stats resolve.
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {SKELETON_KEYS.map((key) => (
          <Skeleton className="h-28" key={key} />
        ))}
      </div>
    );
  }
  // The headline query owns its own error state: a failure here surfaces an
  // inline error rather than an infinite skeleton, and — because the heatmap is
  // a separate query — never blanks the Activity widgets below (FEA-4064).
  if (isError || !headline) {
    return (
      <Alert variant="error">
        <AlertTitle>Couldn't load headline metrics</AlertTitle>
      </Alert>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <StatTile label="Artifacts created" value={headline.totalDocuments} />
      <StatTile label="PRs landed" value={headline.totalPRsLanded} />
      <StatTile label="Comments" value={headline.totalComments} />
      <StatTile
        info={LOOPS_INITIATED_INFO}
        label="Loops initiated"
        value={headline.totalLoops}
      />
      <StatTile
        info={AVG_CONCURRENCY_INFO}
        label="Avg loop concurrency"
        value={headline.avgConcurrency}
      />
      <StatTile
        label="Input tokens"
        value={formatTokenCount(headline.totalTokensInput)}
      />
      <StatTile
        label="Output tokens"
        value={formatTokenCount(headline.totalTokensOutput)}
      />
      <StatTile
        info={ESTIMATED_COST_INFO}
        label="Estimated cost"
        value={`$${headline.totalEstimatedCost.toFixed(2)}`}
      />
    </div>
  );
}

// Activity: the year-long contribution graph and the artifact-type breakdown,
// grouped under one heading per the prototype's IA (rather than two sibling
// sections giving the eye no path). Each panel is its own named region with a
// real <h3> and loads INDEPENDENTLY (FEA-4064): the heatmap panel is fed by the
// fixed-window contribution query and the artifacts panel by the ranged headline
// query, so a failure or slowness in one never blanks the other. The graphs
// stack full-width: the heatmap is an intrinsically ~800px-wide 53-week grid
// that clips in a half column.
function ActivitySection({
  heatmap,
  heatmapLoading,
  heatmapError,
  artifacts,
  artifactsLoading,
  artifactsError,
  rangeLabel,
}: {
  heatmap: UserContributionHeatmap | null;
  heatmapLoading: boolean;
  heatmapError: boolean;
  artifacts: UserProfileHeadline["documentsByType"] | null;
  artifactsLoading: boolean;
  artifactsError: boolean;
  rangeLabel: string;
}) {
  return (
    <section aria-labelledby="activity-heading" className="space-y-4">
      <SectionHeading id="activity-heading">Activity</SectionHeading>
      <div className="space-y-4">
        <ActivityPanel
          description="Merged pull requests per day, past year"
          headingId="contributions-heading"
          title="Contributions"
          windowLabel={HEATMAP_WINDOW_LABEL}
        >
          <WidgetBody
            isError={heatmapError}
            isLoading={heatmapLoading}
            label="contributions"
          >
            <ContributionHeatmap data={heatmap?.contributionHeatmap ?? []} />
          </WidgetBody>
        </ActivityPanel>
        <ActivityPanel
          description="Artifacts created, grouped by type"
          headingId="artifacts-by-type-heading"
          title="Artifacts by type"
          windowLabel={rangeLabel}
        >
          <WidgetBody
            isError={artifactsError}
            isLoading={artifactsLoading}
            label="artifacts by type"
          >
            <DocumentsByTypeChart data={artifacts ?? []} />
          </WidgetBody>
        </ActivityPanel>
      </div>
    </section>
  );
}

// Per-widget loading/error shell so each Activity panel resolves on its own:
// a slow or failing widget shows its own skeleton/error without blocking the
// other panel or the headline (FEA-4064 widget independence).
function WidgetBody({
  isLoading,
  isError,
  label,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  label: string;
  children: ReactNode;
}) {
  if (isLoading) {
    return <Skeleton className="h-64" />;
  }
  if (isError) {
    return (
      <Alert variant="error">
        <AlertTitle>Couldn't load {label}</AlertTitle>
      </Alert>
    );
  }
  return <>{children}</>;
}

// Match the prototype and the Insights overview: bump the headline MetricCard
// value to text-3xl via the shared card-title slot so the stat numbers read as
// the largest type on the profile.
const STAT_CARD_CLASS_NAME = "[&_[data-slot='card-title']]:text-3xl";

// Info-popover copy for the stats whose labels are internal jargon a visitor
// can't be expected to decode ("Loops Initiated", "Avg Loop Concurrency") or
// whose derivation isn't obvious ("Estimated Cost"). Mirrors the prototype,
// which pairs each ambiguous headline with a MetricCard info popover.
const LOOPS_INITIATED_INFO = {
  what: "Autonomous coding runs you kicked off.",
  how: "Counted from loops started under your account.",
} as const;

const AVG_CONCURRENCY_INFO = {
  what: "How many loops ran in parallel on average.",
  how: "Averaged over the intervals where at least one loop was active.",
} as const;

const ESTIMATED_COST_INFO = {
  what: "Approximate model spend across your sessions.",
  how: "Derived from token usage priced at each model's published rate.",
} as const;

// One section heading for all profile sections so they read at the same level.
// The window label rides the heading as a subordinate span (not a separate
// caption line) so each section states the window it covers: the toggle's range
// for the headline section, the fixed trailing year for the heatmap panel.
function SectionHeading({
  id,
  windowLabel,
  children,
}: {
  id: string;
  windowLabel?: string;
  children: ReactNode;
}) {
  return (
    <h2
      className="flex items-baseline gap-2 font-semibold text-lg tracking-tight"
      id={id}
    >
      {children}
      {windowLabel ? (
        <span className="font-medium text-muted-foreground text-sm">
          {windowLabel}
        </span>
      ) : null}
    </h2>
  );
}

// One Activity graph, as its own named region with a real <h3>, so both charts
// stay reachable in screen-reader landmark/heading navigation. The graph routes
// through DashboardCard (the product-wide chart-card wrapper) for the corner
// expand-to-fullscreen affordance; DashboardCard's own title slot is a plain
// div, so the visible <h3> is what carries the heading semantics and names the
// region. `expandLabel` gives the expand control (and modal) its accessible
// name; `contentHasOwnTitle` keeps the modal from stacking a duplicate title.
// `windowLabel` states each panel's own window (a heatmap year vs the ranged
// artifacts window) so the range control never reads as broken (FEA-4064).
function ActivityPanel({
  title,
  description,
  headingId,
  windowLabel,
  children,
}: {
  title: string;
  description: string;
  headingId: string;
  windowLabel?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <h3 className="font-semibold text-base tracking-tight" id={headingId}>
            {title}
          </h3>
          {windowLabel ? (
            <span className="font-medium text-muted-foreground text-sm">
              {windowLabel}
            </span>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <DashboardCard
        contentClassName="overflow-x-auto"
        contentHasOwnTitle
        expandLabel={title}
      >
        {children}
      </DashboardCard>
    </section>
  );
}

function StatTile({
  label,
  value,
  info,
}: {
  label: string;
  value: string | number;
  info?: { what: string; how?: string };
}) {
  // Hand the raw value to MetricCard's own formatMetricValue: it applies
  // thousands grouping to integers AND preserves the one-decimal signal the
  // API deliberately returns for avg concurrency (2.4), which a pre-round to a
  // whole number would erase. Pre-formatted strings (tokens, cost) pass through.
  return (
    <MetricCard
      className={STAT_CARD_CLASS_NAME}
      info={info}
      label={label}
      value={value}
    />
  );
}
