"use client";

import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import type { Harness } from "@repo/app/agents/lib/session-types";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { useTabParam } from "@repo/app/shared/hooks/use-tab-param";
import {
  formatLocPerDollar,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
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
import {
  mergedPrsTileInfo,
  mergedPrsTileValue,
} from "../lib/merged-prs-readout";
import type { PackComponentInstallMatrix } from "../lib/pack-install-matrix";
import {
  adoptionShare,
  CONTENT_KIND_ORDER,
  installCount,
  type PackContentEntry,
  type PackView,
} from "../lib/pack-view";
import type { PacksContext } from "../lib/packs-context";
import { InstallControls, type InstallPending } from "./install-controls";
import { InstallMatrix } from "./install-matrix";
import { InstallStateStatus } from "./install-state-status";
import {
  MemberTargetsBlock,
  type MemberTargetsInstall,
} from "./member-targets-block";
import { PackContentBody } from "./pack-content-body";
import {
  CONTENT_KIND_META,
  formatStars,
  harnessLabel,
  UserPill,
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
  /**
   * Withdraw this pack's distribution — stop offering it to the organization
   * (ISS-5123). Supplied only by a surface that both holds the capability and
   * has the closed-by-default `pack-undistribute` flag on; when absent, the
   * Distribution tab shows no withdraw control at all.
   */
  onWithdrawDistribution?: (distributionIds: string[]) => void;
  /** A withdrawal is in flight; disables the control against a second dispatch. */
  withdrawDistributionPending?: boolean;
  /** Extra admin actions (e.g. Archive) rendered in the detail header. */
  headerActions?: ReactNode;
  /** Replaces the read-only Contents list (e.g. the admin editable components
   *  manager). When present, it renders in place of the derived contents. */
  contentsSlot?: ReactNode;
  /** Secondary qualifier (kind / version / id) shown under the name when this
   *  pack shares its display name with another in the catalog (FEA-3972). The
   *  detail h1 and the install dialog are exactly where the ambiguity matters
   *  most, so the qualifier is carried through from the grid. */
  disambiguator?: string;
  /** The member per-machine read is in flight (member-targets block, FEA-4077). */
  memberTargetsLoading?: boolean;
  /** The member per-machine read failed (member-targets block, FEA-4077). */
  memberTargetsError?: boolean;
  /** Honest per-surface description for the member per-machine block. */
  memberTargetsDescription?: string;
  /**
   * ISS-5125: the ACT half of the member per-machine block — a per
   * (machine × harness) install the member can dispatch onto their own node.
   * Threaded straight through to `MemberTargetsBlock`; omitted (the default)
   * that block stays the FEA-4077 read-only status list. Surfaces gate it on
   * the closed-by-default `member-self-service-install` flag.
   */
  memberTargetsInstall?: MemberTargetsInstall | null;
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

// One bundled-component row. When the surface resolved a per-component install
// state (FEA-4071 — desktop detail read), the row carries its honest
// `InstallStateStatus` (installed / not installed on THIS machine), said once
// through the shared FEA-4083 treatment (icon SHAPE + label, never color alone).
// When no state was resolved (web catalog read — no local filesystem — or an
// older desktop) the indicator is simply absent; the row never fabricates a
// "not installed" for a machine it can't see, and never renders a dead button
// (the pack-level install control in the header owns the action).
const ContentRow = ({ item }: { item: PackContentEntry }) => (
  <li className="rounded-md px-2 py-1.5 hover:bg-muted/40">
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="shrink-0 font-medium text-sm">{item.name}</span>
        {item.description ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
            {item.description}
          </span>
        ) : null}
      </div>
      {item.installState ? (
        <span className="shrink-0 self-center">
          <InstallStateStatus state={item.installState} />
        </span>
      ) : null}
    </div>
    <PackContentBody className="mt-2" content={item.content} />
  </li>
);

// Honest per-machine note above the contents when per-component install state IS
// resolved (desktop) — so "Installed / Not installed" on each row reads as "on
// this machine", not an org-wide claim.
const CONTENTS_MACHINE_NOTE =
  "Install state below is for this machine — whether each component is installed here.";

// The web surface has no local filesystem, so it cannot know per-component
// install state. Rather than silently omit it (a viewer might wonder where the
// installed/not-installed markers went) or fake it, the Contents tab says so
// honestly: per-component install state is a desktop-app concept. Shown only on
// non-install-capable surfaces (`installLocally` false) so the desktop, which
// draws real per-component states, never carries this note.
const CONTENTS_DESKTOP_ONLY_NOTE =
  "Open this pack in the desktop app to see which components are installed on your machine.";

function hasResolvedContentInstallState(pack: PackView): boolean {
  return pack.contents.some((item) => Boolean(item.installState));
}

/**
 * The single honest note above the Contents list. On a surface that resolved
 * per-component install state (desktop), it scopes the row markers to "this
 * machine". On a web surface (`installLocally` false, no local filesystem) it
 * points the viewer to the desktop app rather than showing markers it can't
 * compute. On an install-capable surface that simply hasn't loaded states yet,
 * no note (the markers themselves are the signal once they arrive).
 */
function resolveContentsNote(params: {
  installLocally: boolean;
  resolvedStates: boolean;
}): string | null {
  if (params.resolvedStates) {
    return CONTENTS_MACHINE_NOTE;
  }
  if (!params.installLocally) {
    return CONTENTS_DESKTOP_ONLY_NOTE;
  }
  return null;
}

const ContentsTab = ({
  pack,
  installLocally,
  contentsSlot,
}: {
  pack: PackView;
  /** Whether the surface can install locally (desktop) — gates the machine note. */
  installLocally: boolean;
  contentsSlot?: ReactNode;
}) => {
  if (contentsSlot) {
    return <>{contentsSlot}</>;
  }
  const sections = CONTENT_KIND_ORDER.map((kind) => ({
    kind,
    items: pack.contents.filter((item) => item.kind === kind),
  })).filter((section) => section.items.length > 0);

  if (sections.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This pack does not list bundled contents.
      </p>
    );
  }

  const resolvedStates = hasResolvedContentInstallState(pack);
  const contentsNote = resolveContentsNote({
    installLocally,
    resolvedStates,
  });

  return (
    <div className="space-y-5">
      {contentsNote ? (
        <p className="text-muted-foreground text-sm">{contentsNote}</p>
      ) : null}
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
                <ContentRow item={item} key={`${kind}:${item.name}`} />
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
// LOC/$, org-wide invocations, and distinct sessions.
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const dashOr = (value: number | null, fmt: (n: number) => string): string =>
  value == null ? KPI_NO_VALUE : fmt(value);
/** Signed integer percent, e.g. `+12%` / `-4%`, for headline efficiency values. */
const signedPct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`;
/** A nullable delta → MetricCard's `delta` prop (omitted when no baseline). */
const nullableDelta = (n: number | null): number | undefined => n ?? undefined;

/**
 * A `MetricCard` whose delta (when present) reads higher-is-better — LOC/$ and
 * success rate, where a rise vs. baseline is a win. `delta`/`deltaPolarity` are a
 * paired union on MetricCard (wongk review on #4148), so the polarity is declared
 * only alongside a real number and an absent baseline renders no chip.
 */
const HigherIsBetterMetricCard = ({
  delta,
  deltaLabel,
  detail,
  info,
  label,
  value,
}: {
  delta: number | undefined;
  deltaLabel: string;
  detail: string;
  info: { what: string; how?: string };
  label: string;
  value: string;
}) => {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  const deltaTreatment = useMetricDeltaTreatment();
  if (delta === undefined) {
    return (
      <MetricCard detail={detail} info={info} label={label} value={value} />
    );
  }
  return (
    <MetricCard
      delta={delta}
      deltaLabel={deltaLabel}
      deltaPolarity={MetricPolarity.HigherIsBetter}
      deltaTreatment={deltaTreatment}
      detail={detail}
      info={info}
      label={label}
      value={value}
    />
  );
};

const PerformanceTab = ({ pack }: { pack: PackView }) => {
  const perf = pack.performance;
  if (!perf) {
    return null;
  }
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        How sessions that use {pack.name} compare to a baseline of org sessions
        that do not. Deltas are shown only where a baseline is available.
      </p>
      {/*
        Six real, computed metrics: three from the prototype's comparison model
        (LOC/$, Success rate, Token efficiency) and three canonical usage
        metrics (Invocations, Sessions, Merged PRs). Output quality is computed
        server-side (perf.qualityScore) but intentionally NOT rendered yet — most
        sessions carry no attached judge evaluation until judging is wired deeper
        into the UX, so the card stays hidden until scores populate.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        <HigherIsBetterMetricCard
          delta={nullableDelta(perf.locDelta)}
          deltaLabel="vs. baseline"
          detail="merged lines per dollar"
          info={{
            what: "Lines produced by sessions using the pack ÷ their cost.",
          }}
          label={LOC_PER_DOLLAR_LABEL}
          value={formatLocPerDollar(perf.locPerDollar)}
        />
        <HigherIsBetterMetricCard
          delta={nullableDelta(perf.successDelta)}
          deltaLabel="vs. baseline"
          detail="of sessions reach a merged PR"
          info={{
            what: "Share of the pack's sessions that link to a merged PR.",
          }}
          label="Success rate"
          value={dashOr(perf.successRate, (n) => `${n.toFixed(0)}%`)}
        />
        <MetricCard
          // The value already IS the signed delta vs. baseline, so no separate
          // delta chip. The efficiency trend uses a different unit (KLOC/1k
          // tokens) than this % headline, so it is deliberately not shown here
          // to avoid a value/trend contradiction — `perf.efficiencyTrend` stays
          // in the model for a future dedicated visualization.
          detail="fewer tokens per KLOC vs. baseline"
          info={{
            what: "Tokens per KLOC, pack sessions vs. baseline (directional).",
          }}
          label="Token efficiency"
          value={dashOr(perf.tokenEfficiencyDelta, signedPct)}
        />
        <MetricCard
          detail="org-wide invocations"
          info={{
            what: "Total times the pack was invoked across all sessions.",
          }}
          label="Invocations"
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
        {/*
          ISS-6462: the count is a FLOOR when the server scanned only the first
          COHORT_SCAN_CAP cohort sessions, so the value and its population copy
          both come from `merged-prs-readout` rather than being formatted inline
          like the tiles above.
        */}
        <MetricCard
          detail="merged PRs from those sessions"
          info={mergedPrsTileInfo(perf)}
          label="Merged PRs"
          value={mergedPrsTileValue(perf)}
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
//
// ISS-5123 adds the withdraw half. `onWithdraw` is supplied only when the
// surface has the capability AND the closed-by-default `pack-undistribute` flag
// is on; absent, the tab renders exactly as it did before, so the destructive
// control cannot appear by default.
const DistributionTab = ({
  pack,
  onManage,
  onWithdraw,
  withdrawPending = false,
}: {
  pack: PackView;
  onManage?: (packId: string) => void;
  onWithdraw?: (distributionIds: string[]) => void;
  withdrawPending?: boolean;
}) => {
  const dist = pack.distribution;
  // ISS-5123: a pack can carry several live distributions at once — the admin
  // "Edit distribution" button files a NEW one rather than editing in place — and
  // `pack.distribution` is only the first of them (the summary fold). Withdrawing
  // that one alone would leave the others reaching their targets while the
  // confirmation promised the pack would no longer be offered to anyone, so the
  // control dispatches every live distribution id. `allDistributions` is the
  // unfolded list; it falls back to the folded one on older payloads that omit it.
  const liveDistributionIds = Array.from(
    new Set((pack.allDistributions ?? (dist ? [dist] : [])).map((d) => d.id))
  );
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Roll this pack out to your organization — install automatically or let
          members opt in.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            Only offered once a distribution actually exists — there is nothing
            to withdraw otherwise. Keyed to distribution ids, not the pack id, so
            the withdrawal can only ever hit the assignments this pack actually
            holds, and so a second click during an in-flight withdrawal is
            disabled rather than dispatched again. `ghost` deliberately: it sits
            beside a filled primary, and the destructive weight belongs on the
            confirm button, said once. Matches the quieter Archive control on this
            same surface, which is the larger action of the two.
          */}
          {liveDistributionIds.length > 0 && onWithdraw ? (
            <Button
              disabled={withdrawPending}
              onClick={() => onWithdraw(liveDistributionIds)}
              size="sm"
              variant="ghost"
            >
              Stop distributing
            </Button>
          ) : null}
          <Button onClick={() => onManage?.(pack.id)} size="sm">
            {dist ? "Edit distribution" : "Distribute"}
          </Button>
        </div>
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

// The org-wide install matrix for this pack (FEA-4081). Selects the pack's own
// `PackComponentInstallMatrix` from the multi-target FEA-4072a `installMatrix`
// by component id, so the tab shows the pack row's per-(target × harness) cells.
// Returns null when the multi-target status wasn't loaded OR when only child-
// component matrices are present (partial / version-skewed response) — the model
// carries one matrix per pack and per child component, so a missing pack.id match
// must not silently render a child component's cells under the pack's name.
function selectPackMatrix(pack: PackView): PackComponentInstallMatrix | null {
  const matrices = pack.installMatrix ?? [];
  return matrices.find((entry) => entry.componentId === pack.id) ?? null;
}

export const PackDetail = ({
  pack,
  context,
  installPending,
  installError,
  onInstall,
  onUninstall,
  onUpdate,
  onManageDistribution,
  onWithdrawDistribution,
  withdrawDistributionPending,
  headerActions,
  contentsSlot,
  disambiguator,
  memberTargetsLoading,
  memberTargetsError,
  memberTargetsDescription,
  memberTargetsInstall,
}: PackDetailProps) => {
  const { capabilities } = context;
  const showUsage = capabilities.showTeamUsage && Boolean(pack.teamUsage);
  const showPerformance =
    capabilities.showPerformance && Boolean(pack.performance);
  const showDistribution = capabilities.manageDistribution;
  const showMemberTargets = capabilities.showMemberTargets;
  // Only surface the install-matrix tab when the multi-target FEA-4072a matrix
  // for this pack is actually loaded. Without it the tab could only ever render
  // "No install targets yet", which would read as "installed on zero machines"
  // regardless of the org's real state — a status surface must not assert a fact
  // it doesn't know. Gating on the matrix keeps the tab honest until the
  // per-target axis is wired through (targets resolution, FEA-4072a).
  const packMatrix = selectPackMatrix(pack);
  const showInstallMatrix = showDistribution && packMatrix !== null;

  // FEA-3557: durable permalink for the pack-detail tab. `?tab=distribution`
  // deep-links straight to that tab; refresh / back-forward / copy-link all
  // preserve it. validTabs is built from only the tabs actually rendered (the
  // usage/performance/distribution tabs are capability-gated), so a deep-link to
  // a hidden or bogus tab falls back to "contents". The default ("contents") is
  // omitted from the URL for a clean canonical link.
  const validPackTabs: string[] = [
    "contents",
    ...(showUsage ? ["usage"] : []),
    ...(showPerformance ? ["performance"] : []),
    ...(showDistribution ? ["distribution"] : []),
    ...(showInstallMatrix ? ["install-matrix"] : []),
  ];
  const { activeTab, setActiveTab } = useTabParam({
    defaultTab: "contents",
    validTabs: validPackTabs,
  });

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
          {disambiguator ? (
            <p className="font-medium text-muted-foreground text-sm">
              {disambiguator}
            </p>
          ) : null}
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

      {showMemberTargets ? (
        <div className="mt-6">
          <MemberTargetsBlock
            description={memberTargetsDescription}
            error={memberTargetsError}
            install={memberTargetsInstall}
            isLoading={memberTargetsLoading}
            pack={pack}
          />
        </div>
      ) : null}

      <Tabs className="mt-6" onValueChange={setActiveTab} value={activeTab}>
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
          {showInstallMatrix ? (
            <TabsTrigger value="install-matrix">Install matrix</TabsTrigger>
          ) : null}
        </TabsList>
        <div className="pt-6">
          <TabsContent value="contents">
            <ContentsTab
              contentsSlot={contentsSlot}
              installLocally={capabilities.installLocally}
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
              <DistributionTab
                onManage={onManageDistribution}
                onWithdraw={onWithdrawDistribution}
                pack={pack}
                withdrawPending={withdrawDistributionPending}
              />
            </TabsContent>
          ) : null}
          {showInstallMatrix ? (
            <TabsContent value="install-matrix">
              <InstallMatrix componentName={pack.name} matrix={packMatrix} />
            </TabsContent>
          ) : null}
        </div>
      </Tabs>
    </div>
  );
};
