"use client";

import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { Harness } from "@repo/app/agents/lib/session-types";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import {
  ExternalLinkIcon,
  PackageCheckIcon,
  ShieldCheckIcon,
  StarIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { adoptionShare, installCount, type PackView } from "../lib/pack-view";
import type { PacksContext } from "../lib/packs-context";
import { InstallControls, type InstallPending } from "./install-controls";
import {
  CONTENT_KIND_META,
  formatStars,
  harnessLabel,
  UserPill,
  visibleContentKinds,
} from "./pack-meta";

type PackDetailProps = {
  pack: PackView;
  context: PacksContext;
  installPending?: InstallPending | null;
  installError?: string | null;
  onInstall?: (packId: string, harness: Harness) => void;
  onUninstall?: (packId: string, harness: Harness) => void;
  onUpdate?: (packId: string, harness: Harness) => void;
  onManageDistribution?: (packId: string) => void;
  /** Extra admin actions (e.g. Archive) rendered in the detail header. */
  headerActions?: ReactNode;
  /** Replaces the read-only Contents list (e.g. the admin editable components
   *  manager). When present, it renders in place of the derived contents. */
  contentsSlot?: ReactNode;
};

const HeaderMeta = ({ pack }: { pack: PackView }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-sm">
    <span className="flex items-center gap-1 text-amber-600 tabular-nums dark:text-amber-400">
      <StarIcon className="size-3.5 fill-current" />
      {formatStars(pack.stars)} stars
    </span>
    {pack.publisher ? <span>{pack.publisher}</span> : null}
    {pack.harnesses.map((harness) => (
      <Badge
        className="border-border bg-background text-foreground"
        key={harness}
        variant="outline"
      >
        {harnessLabel(harness)}
      </Badge>
    ))}
    {pack.githubUrl ? (
      <a
        className="flex items-center gap-1 hover:text-foreground"
        href={pack.githubUrl}
        rel="noreferrer"
        target="_blank"
      >
        <ExternalLinkIcon className="size-3.5" />
        GitHub
      </a>
    ) : null}
  </div>
);

// A circular progress ring: a full gray track with a blue arc for the installed
// share, and the package-check glyph centered inside.
const InstallRing = ({ share }: { share: number }) => {
  const size = 48;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - share / 100);
  const center = size / 2;
  return (
    <div className="relative shrink-0" style={{ height: size, width: size }}>
      <svg
        aria-hidden="true"
        className="-rotate-90"
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        width={size}
      >
        <circle
          className="text-muted-foreground/20"
          cx={center}
          cy={center}
          fill="none"
          r={radius}
          stroke="currentColor"
          strokeWidth={stroke}
        />
        <circle
          className="text-blue-500"
          cx={center}
          cy={center}
          fill="none"
          r={radius}
          stroke="currentColor"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">
        <PackageCheckIcon className="size-6 text-blue-500" strokeWidth={2} />
      </span>
    </div>
  );
};

// Adoption summary: an install ring + % when an org-member denominator is known,
// otherwise a plain "N teammates · M devices" stat from the canonical analytics.
const TeamUsageSummary = ({ pack }: { pack: PackView }) => {
  const usage = pack.teamUsage;
  const share = adoptionShare(pack);
  const deviceLabel =
    usage?.deviceCount == null ? "" : ` · ${usage.deviceCount} devices`;
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background px-5 py-4">
      {share == null ? (
        <div>
          <div className="font-bold text-2xl tabular-nums tracking-tight">
            {installCount(pack)}
          </div>
          <div className="text-muted-foreground text-sm">
            teammates use this{deviceLabel}
          </div>
        </div>
      ) : (
        <div>
          <div className="font-bold text-2xl tabular-nums tracking-tight">
            {share}%
          </div>
          <div className="text-muted-foreground text-sm">
            of the team{deviceLabel}
          </div>
        </div>
      )}
      {share == null ? null : <InstallRing share={share} />}
    </div>
  );
};

const ContentsTab = ({
  pack,
  context,
  contentsSlot,
}: {
  pack: PackView;
  context: PacksContext;
  contentsSlot?: ReactNode;
}) => {
  if (contentsSlot) {
    return <>{contentsSlot}</>;
  }
  const kinds = visibleContentKinds(
    context.capabilities.showExtendedContentKinds
  );
  const sections = kinds
    .map((kind) => ({
      kind,
      items: pack.contents.filter((item) => item.kind === kind),
    }))
    .filter((section) => section.items.length > 0);

  if (sections.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This pack does not list bundled contents.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {sections.map(({ kind, items }) => {
        const meta = CONTENT_KIND_META[kind];
        const Icon = meta.icon;
        return (
          <section key={kind}>
            <h3 className="mb-2 flex items-center gap-2 font-semibold text-base">
              <span
                className={`flex items-center justify-center rounded-full p-2 ${meta.iconBg}`}
              >
                <Icon className={`size-4 ${meta.iconColor}`} />
              </span>
              {meta.plural}
            </h3>
            <ul className="space-y-1.5">
              {items.map((item) => (
                <li
                  className="flex items-baseline gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
                  key={`${kind}:${item.name}`}
                >
                  <span className="shrink-0 font-medium text-sm">
                    {item.name}
                  </span>
                  {item.description ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
                      {item.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
};

const UsageTab = ({ pack }: { pack: PackView }) => {
  const usage = pack.teamUsage;
  if (!usage) {
    return null;
  }
  const notInstalled = usage.notInstalled ?? [];
  return (
    <div className="space-y-5">
      <TeamUsageSummary pack={pack} />
      <div>
        <h3 className="mb-2 font-medium text-sm">
          Used by ({usage.installers.length})
        </h3>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {usage.installers.map((user) => (
            <li className="py-1.5" key={user.id}>
              <UserPill user={user} />
            </li>
          ))}
        </ul>
      </div>
      {notInstalled.length > 0 ? (
        <div>
          <h3 className="mb-2 font-medium text-sm">
            Not installed ({notInstalled.length})
          </h3>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {notInstalled.map((user) => (
              <li className="py-1.5" key={user.id}>
                <UserPill muted user={user} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

// Canonical per-pack analytics from the org-wide agent-component rollup:
// KLOC/$, org-wide invocations, and distinct sessions.
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const dashOr = (value: number | null, fmt: (n: number) => string): string =>
  value == null ? "—" : fmt(value);

const PerformanceTab = ({ pack }: { pack: PackView }) => {
  const perf = pack.performance;
  if (!perf) {
    return null;
  }
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Org-wide usage and code productivity for {pack.name}, from the sessions
        that invoked it.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          detail="merged thousands of lines of code per dollar"
          info={{
            what: "Lines produced by sessions using the pack ÷ their cost.",
          }}
          label="KLOC / $"
          value={dashOr(perf.klocPerDollar, (n) => n.toFixed(2))}
        />
        <MetricCard
          detail="org-wide invocations"
          info={{
            what: "Total times the pack was invoked across all sessions.",
          }}
          label="Invocations"
          sparkline={
            perf.usageTrend.length > 0 ? [...perf.usageTrend] : undefined
          }
          value={dashOr(perf.invocations, (n) => NUMBER_FORMAT.format(n))}
        />
        <MetricCard
          detail="distinct sessions"
          info={{
            what: "Distinct agent sessions in which the pack was invoked.",
          }}
          label="Sessions"
          value={dashOr(perf.sessions, (n) => NUMBER_FORMAT.format(n))}
        />
      </div>
    </div>
  );
};

const MODE_LABEL: Record<string, string> = {
  [DistributionMode.AutoInstall]: "Auto-install",
  [DistributionMode.OptIn]: "Opt-in",
};
const TARGETING_LABEL: Record<string, string> = {
  [DistributionTargetingType.All]: "All devices",
  [DistributionTargetingType.Specific]: "Specific targets",
};
const STATUS_LABEL: Record<string, string> = {
  [DistributionTargetStatusValue.Pending]: "Pending",
  [DistributionTargetStatusValue.Installed]: "Installed",
  [DistributionTargetStatusValue.Enabled]: "Enabled",
  [DistributionTargetStatusValue.Failed]: "Failed",
  [DistributionTargetStatusValue.OptedIn]: "Opted in",
  [DistributionTargetStatusValue.Declined]: "Declined",
};

// Admin distribution management: shows how a required pack is rolled out
// (auto-install / opt-in), targeting, and per-target install status.
const DistributionTab = ({
  pack,
  onManage,
}: {
  pack: PackView;
  onManage?: (packId: string) => void;
}) => {
  const dist = pack.distribution;
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Roll this pack out to your organization — install automatically or let
          members opt in.
        </p>
        <Button onClick={() => onManage?.(pack.id)} size="sm">
          {dist ? "Edit distribution" : "Distribute"}
        </Button>
      </div>

      {dist ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="text-muted-foreground text-xs">Mode</div>
              <div className="font-medium">
                {MODE_LABEL[dist.mode] ?? dist.mode}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="text-muted-foreground text-xs">Targeting</div>
              <div className="font-medium">
                {TARGETING_LABEL[dist.targetingType] ?? dist.targetingType}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge variant="success">{dist.installedCount} installed</Badge>
            <Badge variant="muted">{dist.pendingCount} pending</Badge>
            {dist.failedCount > 0 ? (
              <Badge variant="destructive">{dist.failedCount} failed</Badge>
            ) : null}
            <Badge variant="outline">{dist.targetCount} targeted</Badge>
          </div>

          {dist.targets && dist.targets.length > 0 ? (
            <div>
              <h3 className="mb-2 font-medium text-sm">Targets</h3>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {dist.targets.map((target) => (
                  <li
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                    key={target.id}
                  >
                    <span className="min-w-0 truncate">
                      {target.user
                        ? target.user.name
                        : (target.computeTargetName ??
                          target.computeTargetId ??
                          "Unknown target")}
                    </span>
                    <Badge variant="muted">
                      {STATUS_LABEL[target.status] ?? target.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">Not distributed yet.</p>
      )}
    </div>
  );
};

export const PackDetail = ({
  pack,
  context,
  installPending,
  installError,
  onInstall,
  onUninstall,
  onUpdate,
  onManageDistribution,
  headerActions,
  contentsSlot,
}: PackDetailProps) => {
  const { capabilities } = context;
  const showUsage = capabilities.showTeamUsage && Boolean(pack.teamUsage);
  const showPerformance =
    capabilities.showPerformance && Boolean(pack.performance);
  const showDistribution = capabilities.manageDistribution;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="flex items-start justify-between gap-4 border-border border-b pb-6">
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
          {pack.description ? (
            <p className="max-w-2xl text-muted-foreground">
              {pack.description}
            </p>
          ) : null}
          <HeaderMeta pack={pack} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <InstallControls
            context={context}
            error={installError}
            onDistribute={onManageDistribution}
            onInstall={onInstall}
            onUninstall={onUninstall}
            onUpdate={onUpdate}
            pack={pack}
            pending={installPending}
          />
          {headerActions}
        </div>
      </div>

      <Tabs className="mt-6" defaultValue="contents">
        <TabsList className="w-fit">
          <TabsTrigger value="contents">Contents</TabsTrigger>
          {showUsage ? (
            <TabsTrigger value="usage">Team usage</TabsTrigger>
          ) : null}
          {showPerformance ? (
            <TabsTrigger value="performance">Performance</TabsTrigger>
          ) : null}
          {showDistribution ? (
            <TabsTrigger value="distribution">Distribution</TabsTrigger>
          ) : null}
        </TabsList>
        <div className="pt-6">
          <TabsContent value="contents">
            <ContentsTab
              contentsSlot={contentsSlot}
              context={context}
              pack={pack}
            />
          </TabsContent>
          {showUsage ? (
            <TabsContent value="usage">
              <UsageTab pack={pack} />
            </TabsContent>
          ) : null}
          {showPerformance ? (
            <TabsContent value="performance">
              <PerformanceTab pack={pack} />
            </TabsContent>
          ) : null}
          {showDistribution ? (
            <TabsContent value="distribution">
              <DistributionTab onManage={onManageDistribution} pack={pack} />
            </TabsContent>
          ) : null}
        </div>
      </Tabs>
    </div>
  );
};
