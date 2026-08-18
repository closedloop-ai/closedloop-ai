"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Input } from "@repo/design-system/components/ui/input";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import {
  ActivityIcon,
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  SearchIcon,
  ShieldCheckIcon,
  StarIcon,
} from "lucide-react";
import { useState } from "react";
// The agents detail view owns the canonical LOC/$ formatter (compact "4.5k",
// not "4,500"). Imported, not re-declared, so the same metric reads the same
// number on both surfaces (ISS design-review T23).
import { LOC_PER_DOLLAR_FORMAT } from "../../agents/component-meta";
import {
  installCount,
  type Pack,
  partialInstallersFor,
  performanceFor,
  TEAM_MEMBERS,
  visibilityFor,
} from "../mock";
import { PackContentsTable } from "./pack-contents-table";
import {
  formatStars,
  HARNESS_LABEL,
  InstallerStack,
  META_BADGE_CLASS,
  UserPill,
  VisibilityBadge,
} from "./pack-meta";

type PackDetailProps = {
  pack: Pack;
};

const HeaderMeta = ({ pack }: { pack: Pack }) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground text-sm">
    <VisibilityBadge visibility={visibilityFor(pack)} />
    <Badge className={META_BADGE_CLASS} variant="outline">
      {pack.publisher}
    </Badge>
    {pack.harnesses.map((harness) => (
      <Badge className={META_BADGE_CLASS} key={harness} variant="outline">
        {HARNESS_LABEL[harness]}
      </Badge>
    ))}
    <span className="flex items-center gap-1 px-1 text-amber-600 tabular-nums dark:text-amber-400">
      <StarIcon className="size-3.5 fill-current" />
      {formatStars(pack.stars)} stars
    </span>
    <a
      className="flex items-center gap-1 px-1 hover:text-foreground"
      href={pack.githubUrl}
      rel="noreferrer"
      target="_blank"
    >
      <ExternalLinkIcon className="size-3.5" />
      GitHub
    </a>
  </div>
);

const InstallButton = ({ pack }: { pack: Pack }) => {
  if (pack.installedByMe) {
    return (
      <Button className="gap-1.5" disabled variant="secondary">
        <CheckIcon className="size-4" />
        Installed
      </Button>
    );
  }
  return (
    <Button asChild className="gap-1.5">
      <a href={pack.githubUrl} rel="noreferrer" target="_blank">
        <DownloadIcon className="size-4" />
        Install
      </a>
    </Button>
  );
};

type UsageCohort = { label: string; users: readonly string[] };

// A "view all" affordance shown after each usage group's avatar stack; opens
// the full member list. Plain text, not a second round pill. The stack
// already ends in a "+N" overflow chip, and giving this the same grey-circle
// treatment made two things look like the same kind of overflow control when
// only one of them is clickable (ISS design-review T24).
const ViewAllButton = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) => (
  <button
    aria-label={`View all ${label}`}
    className="ml-2 shrink-0 font-medium text-primary text-sm hover:underline"
    onClick={onClick}
    type="button"
  >
    View all
  </button>
);

// The stack shows up to this many avatars before it overflows to a "+N" chip.
const USAGE_STACK_MAX = 5;

// "View all" only appears when the stack is actually hiding someone. With a
// cohort of five or fewer everyone is already on screen, so the arrow would
// open a dialog listing the same faces.
const UsageGroup = ({
  cohort,
  onView,
}: {
  cohort: UsageCohort;
  onView: () => void;
}) => (
  <div className="space-y-3">
    <h3 className="font-medium text-sm">
      {cohort.label} ({cohort.users.length})
    </h3>
    {cohort.users.length > 0 ? (
      <InstallerStack
        max={USAGE_STACK_MAX}
        size="lg"
        trailing={
          cohort.users.length > USAGE_STACK_MAX ? (
            <ViewAllButton label={cohort.label} onClick={onView} />
          ) : null
        }
        users={cohort.users}
      />
    ) : (
      <span className="text-muted-foreground text-sm">None</span>
    )}
  </div>
);

// A searchable roster of everyone in a cohort — sized for potentially hundreds
// of members (search filter + scrolling list).
const UsageDialog = ({
  cohort,
  onOpenChange,
}: {
  cohort: UsageCohort | null;
  onOpenChange: (open: boolean) => void;
}) => {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = (cohort?.users ?? []).filter((user) =>
    user.toLowerCase().includes(normalized)
  );
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
        onOpenChange(open);
      }}
      open={cohort !== null}
    >
      {cohort ? (
        <DialogContent className="flex max-h-[70vh] max-w-md flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="space-y-3 border-border border-b p-5">
            <DialogTitle>
              {cohort.label} ({cohort.users.length})
            </DialogTitle>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search members"
                className="pl-9"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search members"
                value={query}
              />
            </div>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {filtered.length > 0 ? (
              <ul>
                {filtered.map((user) => (
                  <li
                    className="rounded-md px-2 py-2 hover:bg-muted/40"
                    key={user}
                  >
                    <UserPill name={user} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-8 text-center text-muted-foreground text-sm">
                No members match your search.
              </p>
            )}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

const TeamUsageGroups = ({ pack }: { pack: Pack }) => {
  const [active, setActive] = useState<UsageCohort | null>(null);
  const partial = partialInstallersFor(pack);
  const notInstalled = TEAM_MEMBERS.filter(
    (member) => !(pack.installers.includes(member) || partial.includes(member))
  );
  const cohorts: readonly UsageCohort[] = [
    { label: "Installed", users: pack.installers },
    { label: "Partial install", users: partial },
    { label: "Not installed", users: notInstalled },
  ];
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-6">
        {cohorts.map((cohort) => (
          <UsageGroup
            cohort={cohort}
            key={cohort.label}
            onView={() => setActive(cohort)}
          />
        ))}
      </div>
      <UsageDialog
        cohort={active}
        onOpenChange={(open) => {
          if (!open) {
            setActive(null);
          }
        }}
      />
    </>
  );
};

// The section states the comparison once, so each card's caption stays short.
const BASELINE_LABEL = "vs. baseline";

// A pack has no fixed set of sessions to hold constant, so "similar sessions
// that don't [use the pack]" needs its own sentence. Every performance card
// shares this one in its info popover rather than leaving the reader to guess
// at the cohort (ISS design-review T21).
const BASELINE_COHORT_HOW =
  "Baseline is comparable sessions on similar tasks that didn't use this pack.";

// A pack with only a couple of installers hasn't produced enough real
// sessions for a comparison to mean anything yet. Every mock pack shipped a
// full set of numbers regardless of how new or lightly-used it was
// (ISS design-review T20).
const MIN_INSTALLERS_FOR_PERFORMANCE = 3;

// A card whose only figure IS a delta reads the magnitude with a direction
// word instead of a bare signed number ("17% fewer", not "17%" or "-8%"),
// so the losing case (a negative override, ISS design-review T19) still
// reads as plain English rather than a double negative.
const signedChangeValue = (
  delta: number,
  positiveWord: string,
  negativeWord: string
): string => `${Math.abs(delta)}% ${delta >= 0 ? positiveWord : negativeWord}`;

// How sessions using a pack compare with similar sessions that don't.
const PerformanceMetrics = ({ pack }: { pack: Pack }) => {
  if (installCount(pack) < MIN_INSTALLERS_FOR_PERFORMANCE) {
    return (
      <EmptyState
        description="Performance shows up once enough of the team has run sessions with this pack."
        icon={ActivityIcon}
        size="compact"
        title="Not enough sessions yet"
      />
    );
  }
  const performance = performanceFor(pack);
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
      {/* Token efficiency's only figure IS the comparison (the mock carries
          no absolute tokens-per-task count), so the number goes in `delta`
          and its trend in `sparkline` like its siblings. The value is
          reworded to read as a change, not a rate (ISS design-review T18). */}
      <MetricCard
        delta={performance.tokenEfficiencyDelta}
        deltaLabel={BASELINE_LABEL}
        deltaPolarity={MetricPolarity.HigherIsBetter}
        detail="Tokens per task"
        info={{
          what: "How many fewer tokens per task this pack's sessions use.",
          how: BASELINE_COHORT_HOW,
        }}
        label="Token efficiency"
        sparkline={[...performance.efficiencyTrend]}
        value={signedChangeValue(
          performance.tokenEfficiencyDelta,
          "fewer",
          "more"
        )}
      />
      <MetricCard
        delta={performance.qualityDelta}
        deltaLabel={BASELINE_LABEL}
        deltaPolarity={MetricPolarity.HigherIsBetter}
        detail="Average reviewer score"
        info={{
          what: "Average reviewer/judge score for this pack's sessions, 0 to 10.",
          how: BASELINE_COHORT_HOW,
        }}
        label="Quality score"
        unitLabel="/ 10"
        value={performance.qualityScore}
      />
      {/* No delta chip here: a pack is further from causing its sessions' LOC/$
          than a single component is (agents surface's own "not caused by one
          component" caveat), so it doesn't get to claim "better" either. The
          value sits as plain context, formatted with the same
          LOC_PER_DOLLAR_FORMAT the agents surface uses for the same metric
          (ISS design-review T17, T23). */}
      <MetricCard
        detail="Merged lines per dollar"
        info={{
          what: "Merged lines of code per dollar spent on this pack's sessions.",
          how: `${BASELINE_COHORT_HOW} Read this as a trend, not a score. It's a session-level metric, not caused by any one component in the pack.`,
        }}
        label="LOC / $"
        value={LOC_PER_DOLLAR_FORMAT.format(performance.locPerDollar)}
      />
      {/* The absolute success rate moves into `detail` instead of sitting in
          the headline beside the delta chip: both were rendering as a bare
          "NN%", and nobody was reading the chip's as relative (ISS
          design-review T22). */}
      <MetricCard
        delta={performance.successDelta}
        deltaLabel={BASELINE_LABEL}
        deltaPolarity={MetricPolarity.HigherIsBetter}
        detail={`${performance.successRate}% of sessions reach a merged PR`}
        info={{
          what: "Share of this pack's sessions that reach a merged PR.",
          how: BASELINE_COHORT_HOW,
        }}
        label="Success rate"
        value={signedChangeValue(performance.successDelta, "higher", "lower")}
      />
    </div>
  );
};

// Single-page detail: title + metadata, Performance, and Team usage stay inset
// (centered column); the Contents table spans the full page width (full-bleed),
// like the Agents detail view.
export const PackDetail = ({ pack }: PackDetailProps) => (
  <div className="pb-10">
    <div className="mx-auto w-full max-w-4xl space-y-8 px-6 pt-8">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="flex items-center gap-2 font-semibold text-2xl tracking-tight">
            {pack.name}
            {pack.verified ? (
              <ShieldCheckIcon
                aria-label="Verified"
                className="size-5 text-primary"
              />
            ) : null}
          </h1>
          <p className="max-w-2xl text-muted-foreground">{pack.description}</p>
          <HeaderMeta pack={pack} />
        </div>
        <div className="shrink-0">
          <InstallButton pack={pack} />
        </div>
      </div>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="font-semibold text-lg tracking-tight">Performance</h2>
          <p className="text-muted-foreground text-sm">
            How sessions using this pack compare with similar sessions that
            don't.
          </p>
        </div>
        <PerformanceMetrics pack={pack} />
      </section>

      <section className="space-y-4">
        <h2 className="font-semibold text-lg tracking-tight">Team usage</h2>
        <TeamUsageGroups pack={pack} />
      </section>
    </div>

    <div className="mt-8">
      <PackContentsTable pack={pack} />
    </div>
  </div>
);
