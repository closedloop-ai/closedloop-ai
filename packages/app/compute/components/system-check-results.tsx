"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  type CheckResult,
  CheckSeverity,
  isIndeterminateCheckSeverity,
  PluginUpdateOutcome,
  resolveCheckSeverity,
} from "@closedloop-ai/loops-api/compute-target";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Info,
  Loader2,
  XCircle,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect } from "react";
import {
  SystemCheckStatusBadge,
  SystemCheckStatusTone,
} from "./system-check-status-badge";

type CheckCategoryId = "cli" | "plugins" | "apps" | "config" | "mcp" | "other";

type CheckCategory = {
  id: CheckCategoryId;
  label: string;
};

type IndexedCheck = {
  check: CheckResult;
  displayIndex: number;
};

type CheckCategoryGroup = CheckCategory & {
  checks: IndexedCheck[];
};

export type SystemCheckResultsTargetKind =
  | "local"
  | "owned_relay"
  | "shared_relay";

export type SystemCheckResultsRemediationView = {
  checkId: string;
  structuredLinksPresent: true;
  targetKind: SystemCheckResultsTargetKind;
  updateOutcome: CheckResult["updateOutcome"];
};

export type SystemCheckResultsRemediationClick =
  SystemCheckResultsRemediationView & {
    linkUrl: string;
  };

/**
 * The one neutral surface tone the System Check panel uses.
 *
 * Three surfaces in a single dialog had drifted to three different alphas
 * (`bg-background/55`, `bg-muted/30`, `bg-muted/40`), which reads as three
 * different kinds of thing rather than one panel. Exported so
 * `HealthCheckDialog`'s guidance blocks stay on the same value instead of
 * re-declaring their own.
 */
export const SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS = "border-border bg-muted/40";

const CHECK_CATEGORIES: CheckCategory[] = [
  { id: "cli", label: "CLI" },
  { id: "plugins", label: "Plugins" },
  { id: "apps", label: "Apps" },
  { id: "config", label: "Config" },
  { id: "mcp", label: "MCP" },
  { id: "other", label: "Other" },
];

const CHECK_CATEGORY_BY_ID: Record<string, CheckCategoryId> = {
  git: "cli",
  "claude-cli": "cli",
  "gh-cli": "cli",
  codex: "cli",
  python3: "cli",
  "app-version": "apps",
  "gh-auth": "config",
  "worktree-dir": "config",
  "claude-mcp": "mcp",
  "codex-mcp": "mcp",
};

type SystemCheckResultsProps = {
  checks?: CheckResult[];
  isLoading?: boolean;
  revealedCount?: number;
  className?: string;
  afterRequired?: ReactNode;
  pluginAutoUpdateEnabled?: boolean;
  targetKind?: SystemCheckResultsTargetKind;
  onStructuredRemediationViewed?: (
    payload: SystemCheckResultsRemediationView
  ) => void;
  onStructuredRemediationLinkClick?: (
    payload: SystemCheckResultsRemediationClick
  ) => void;
};

export function SystemCheckResults({
  checks,
  isLoading = false,
  revealedCount,
  className,
  afterRequired,
  pluginAutoUpdateEnabled = false,
  targetKind = "local",
  onStructuredRemediationViewed,
  onStructuredRemediationLinkClick,
}: Readonly<SystemCheckResultsProps>) {
  const requiredChecks = checks?.filter((check) => check.required) ?? [];
  const optionalChecks = checks?.filter((check) => !check.required) ?? [];
  const visibleCount = revealedCount ?? Number.POSITIVE_INFINITY;
  const requiredGroups = getCheckCategoryGroups(requiredChecks, 0);
  const optionalGroups = getCheckCategoryGroups(
    optionalChecks,
    requiredChecks.length
  );
  const showOptional = optionalGroups.length > 0 || isLoading;

  return (
    <div className={cn("space-y-4", className)}>
      <SystemCheckSection
        groups={requiredGroups}
        isLoading={isLoading}
        onStructuredRemediationLinkClick={onStructuredRemediationLinkClick}
        onStructuredRemediationViewed={onStructuredRemediationViewed}
        pluginAutoUpdateEnabled={pluginAutoUpdateEnabled}
        skeletonGroups={3}
        targetKind={targetKind}
        title="Required"
        visibleCount={visibleCount}
      />

      {afterRequired}

      {showOptional && (
        <SystemCheckSection
          groups={optionalGroups}
          isLoading={isLoading}
          onStructuredRemediationLinkClick={onStructuredRemediationLinkClick}
          onStructuredRemediationViewed={onStructuredRemediationViewed}
          pluginAutoUpdateEnabled={pluginAutoUpdateEnabled}
          skeletonGroups={2}
          targetKind={targetKind}
          title="Optional"
          visibleCount={visibleCount}
        />
      )}
    </div>
  );
}

function getCheckCategoryGroups(
  checks: CheckResult[],
  startDisplayIndex: number
): CheckCategoryGroup[] {
  const buckets = new Map<CheckCategoryId, CheckResult[]>(
    CHECK_CATEGORIES.map((category) => [category.id, []])
  );

  for (const check of checks) {
    const categoryId = getCheckCategoryId(check);
    buckets.get(categoryId)?.push(check);
  }

  let nextDisplayIndex = startDisplayIndex;
  return CHECK_CATEGORIES.flatMap((category) => {
    const categoryChecks = buckets.get(category.id) ?? [];
    if (categoryChecks.length === 0) {
      return [];
    }

    const indexedChecks = categoryChecks.map((check) => ({
      check,
      displayIndex: nextDisplayIndex++,
    }));

    return [{ ...category, checks: indexedChecks }];
  });
}

function getCheckCategoryId(check: CheckResult): CheckCategoryId {
  if (check.id.startsWith("plugin-")) {
    return "plugins";
  }

  return CHECK_CATEGORY_BY_ID[check.id] ?? "other";
}

function SystemCheckSection({
  groups,
  isLoading,
  skeletonGroups,
  title,
  visibleCount,
  pluginAutoUpdateEnabled,
  targetKind,
  onStructuredRemediationViewed,
  onStructuredRemediationLinkClick,
}: Readonly<{
  groups: CheckCategoryGroup[];
  isLoading: boolean;
  pluginAutoUpdateEnabled: boolean;
  skeletonGroups: number;
  targetKind: SystemCheckResultsTargetKind;
  title: string;
  visibleCount: number;
  onStructuredRemediationViewed?: (
    payload: SystemCheckResultsRemediationView
  ) => void;
  onStructuredRemediationLinkClick?: (
    payload: SystemCheckResultsRemediationClick
  ) => void;
}>) {
  return (
    <section className="@container/checks">
      <h4 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">
        {title}
      </h4>
      <SystemCheckCardGrid
        groups={groups}
        isLoading={isLoading}
        onStructuredRemediationLinkClick={onStructuredRemediationLinkClick}
        onStructuredRemediationViewed={onStructuredRemediationViewed}
        pluginAutoUpdateEnabled={pluginAutoUpdateEnabled}
        skeletonGroups={skeletonGroups}
        targetKind={targetKind}
        title={title}
        visibleCount={visibleCount}
      />
    </section>
  );
}

function SystemCheckCardGrid({
  groups,
  isLoading,
  skeletonGroups,
  title,
  visibleCount,
  pluginAutoUpdateEnabled,
  targetKind,
  onStructuredRemediationViewed,
  onStructuredRemediationLinkClick,
}: Readonly<{
  groups: CheckCategoryGroup[];
  isLoading: boolean;
  pluginAutoUpdateEnabled: boolean;
  skeletonGroups: number;
  targetKind: SystemCheckResultsTargetKind;
  title: string;
  visibleCount: number;
  onStructuredRemediationViewed?: (
    payload: SystemCheckResultsRemediationView
  ) => void;
  onStructuredRemediationLinkClick?: (
    payload: SystemCheckResultsRemediationClick
  ) => void;
}>) {
  return (
    <div
      className="grid @3xl/checks:grid-cols-4 @sm/checks:grid-cols-2 grid-cols-1 gap-3"
      data-system-check-layout="card-grid"
    >
      {groups.map((group) => (
        <SystemCheckCategoryCard
          group={group}
          key={group.id}
          onStructuredRemediationLinkClick={onStructuredRemediationLinkClick}
          onStructuredRemediationViewed={onStructuredRemediationViewed}
          pluginAutoUpdateEnabled={pluginAutoUpdateEnabled}
          targetKind={targetKind}
          visibleCount={visibleCount}
        />
      ))}
      {isLoading &&
        Array.from({ length: skeletonGroups }).map((_, index) => (
          <SystemCheckCategorySkeleton key={`${title}-${String(index)}`} />
        ))}
    </div>
  );
}

function SystemCheckCategoryCard({
  group,
  visibleCount,
  pluginAutoUpdateEnabled,
  targetKind,
  onStructuredRemediationViewed,
  onStructuredRemediationLinkClick,
}: Readonly<{
  group: CheckCategoryGroup;
  visibleCount: number;
  pluginAutoUpdateEnabled: boolean;
  targetKind: SystemCheckResultsTargetKind;
  onStructuredRemediationViewed?: (
    payload: SystemCheckResultsRemediationView
  ) => void;
  onStructuredRemediationLinkClick?: (
    payload: SystemCheckResultsRemediationClick
  ) => void;
}>) {
  const sharedRemediation = getSharedIndeterminateRemediation(
    group.checks,
    visibleCount
  );

  return (
    <section
      className={cn(
        "rounded-md border p-3 shadow-sm",
        SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <h5 className="font-medium text-foreground text-sm">{group.label}</h5>
      </div>
      <div className="space-y-1.5">
        {group.checks.map(({ check, displayIndex }) => (
          <SystemCheckRow
            check={check}
            key={check.id}
            onStructuredRemediationLinkClick={onStructuredRemediationLinkClick}
            onStructuredRemediationViewed={onStructuredRemediationViewed}
            pluginAutoUpdateEnabled={pluginAutoUpdateEnabled}
            revealed={visibleCount > displayIndex}
            sharedRemediation={sharedRemediation}
            targetKind={targetKind}
          />
        ))}
      </div>
      {sharedRemediation && (
        <SystemCheckRemediationNote
          className="mt-2"
          data-system-check-shared-remediation="true"
          severity={CheckSeverity.Blocked}
          toneClassName={SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS}
        >
          {renderRemediationText(sharedRemediation)}
        </SystemCheckRemediationNote>
      )}
    </section>
  );
}

/**
 * The remediation text shared by two or more revealed, indeterminate rows in
 * this category.
 *
 * One unresolvable Claude binary marks all five plugin rows `blocked` with the
 * identical "fix the Claude CLI check first" sentence. Stacking five identical
 * boxes under five rows that already read "Not checked" is noise, not
 * information, so the card says it once instead.
 */
function getSharedIndeterminateRemediation(
  checks: IndexedCheck[],
  visibleCount: number
): string | undefined {
  const counts = new Map<string, number>();
  for (const { check, displayIndex } of checks) {
    const revealed = visibleCount > displayIndex;
    const indeterminate = isIndeterminateCheckSeverity(
      resolveCheckSeverity(check)
    );
    if (revealed && indeterminate && check.remediation) {
      counts.set(check.remediation, (counts.get(check.remediation) ?? 0) + 1);
    }
  }

  for (const [remediation, count] of counts) {
    if (count > 1) {
      return remediation;
    }
  }
  return undefined;
}

function SystemCheckRow({
  check,
  pluginAutoUpdateEnabled,
  revealed,
  sharedRemediation,
  targetKind,
  onStructuredRemediationViewed,
  onStructuredRemediationLinkClick,
}: Readonly<{
  check: CheckResult;
  pluginAutoUpdateEnabled: boolean;
  revealed: boolean;
  sharedRemediation?: string;
  targetKind: SystemCheckResultsTargetKind;
  onStructuredRemediationViewed?: (
    payload: SystemCheckResultsRemediationView
  ) => void;
  onStructuredRemediationLinkClick?: (
    payload: SystemCheckResultsRemediationClick
  ) => void;
}>) {
  const severity = resolveCheckSeverity(check);
  const value = getSystemCheckValue(check);
  const updateStatus = getPluginUpdateStatus(check, pluginAutoUpdateEnabled);
  const enableStatus = getPluginEnableStatus(check);
  // A remediation the whole card already states once is not repeated per row.
  const hoistedToCard =
    sharedRemediation !== undefined && check.remediation === sharedRemediation;
  const showRemediation =
    severity !== CheckSeverity.Passed &&
    !hoistedToCard &&
    Boolean(check.remediation);
  // The gateway's own reason this failing row is beyond Repair, shown on the row
  // it describes rather than in a list above the results (ISS-5389). Passing
  // rows and repairable rows carry nothing here.
  const blockedReason =
    !check.passed && check.repair?.repairable === false
      ? check.repair.reason
      : undefined;
  const remediationLinks = check.remediationLinks ?? [];
  const showStructuredLinks =
    revealed &&
    showRemediation &&
    pluginAutoUpdateEnabled &&
    remediationLinks.length > 0;

  useEffect(() => {
    if (!(showStructuredLinks && onStructuredRemediationViewed)) {
      return;
    }
    onStructuredRemediationViewed({
      checkId: check.id,
      structuredLinksPresent: true,
      targetKind,
      updateOutcome: check.updateOutcome,
    });
  }, [
    check.id,
    check.updateOutcome,
    onStructuredRemediationViewed,
    showStructuredLinks,
    targetKind,
  ]);

  const handleRemediationLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onStructuredRemediationLinkClick?.({
      checkId: check.id,
      linkUrl: event.currentTarget.href,
      structuredLinksPresent: true,
      targetKind,
      updateOutcome: check.updateOutcome,
    });
  };

  if (!revealed) {
    return <SystemCheckRowSkeleton />;
  }

  return (
    <div className="fade-in slide-in-from-left-3 animate-in space-y-0.5 duration-300">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <SystemCheckIcon required={check.required} severity={severity} />
        <span className="min-w-0 flex-1 truncate">{check.label}</span>
        {enableStatus}
        {updateStatus}
        {value}
      </div>
      {showRemediation && (
        <SystemCheckRemediationNote
          className="mt-1 ml-6"
          severity={severity}
          toneClassName={getRemediationToneClassName(severity, check.required)}
        >
          {showStructuredLinks ? (
            <span className="mb-1 block">
              {remediationLinks.map((link) => (
                <a
                  className="font-medium text-primary underline underline-offset-2"
                  href={link.url}
                  key={link.url}
                  onClick={handleRemediationLinkClick}
                  rel="noreferrer"
                  target="_blank"
                >
                  {link.label}
                </a>
              ))}
            </span>
          ) : null}
          {renderRemediationText(check.remediation ?? "")}
        </SystemCheckRemediationNote>
      )}
      {blockedReason && (
        <p className="mt-1 ml-6 flex items-start gap-1.5 text-muted-foreground text-xs">
          <Info aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          <span>{blockedReason}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The one remediation-note treatment, used both per row and once per card when
 * several blocked rows share a single fix. Keeping it in one place is what
 * stops the row copy and the card copy drifting into two different boxes.
 */
function SystemCheckRemediationNote({
  children,
  className,
  severity,
  toneClassName,
  ...rest
}: Readonly<{
  children: ReactNode;
  className?: string;
  severity: CheckSeverity;
  toneClassName: string;
}> &
  Readonly<Record<`data-${string}`, string>>) {
  return (
    <p
      className={cn(
        "rounded border px-2 py-1 text-xs",
        toneClassName,
        className
      )}
      data-check-severity={severity}
      {...rest}
    >
      <span className="select-all text-foreground/80">{children}</span>
    </p>
  );
}

function getPluginUpdateStatus(
  check: CheckResult,
  pluginAutoUpdateEnabled: boolean
): ReactNode {
  if (!(pluginAutoUpdateEnabled && check.id.startsWith("plugin-"))) {
    return null;
  }
  if (check.updateOutcome === "success") {
    return (
      <SystemCheckStatusBadge
        label="Updated"
        tone={SystemCheckStatusTone.Success}
      />
    );
  }
  if (check.updateOutcome === "timeout") {
    return (
      <SystemCheckStatusBadge
        label="Update timed out"
        tone={SystemCheckStatusTone.Warning}
      />
    );
  }
  if (check.updateOutcome === "failed" || check.updateOutcome === "skipped") {
    return (
      <SystemCheckStatusBadge
        label="Update failed"
        tone={SystemCheckStatusTone.Danger}
      />
    );
  }
  return null;
}

function getPluginEnableStatus(check: CheckResult): ReactNode {
  if (!check.id.startsWith("plugin-")) {
    return null;
  }
  if (check.enableOutcome === PluginUpdateOutcome.Success) {
    return (
      <SystemCheckStatusBadge
        label="Enabled"
        tone={SystemCheckStatusTone.Success}
      />
    );
  }
  if (check.enableOutcome === PluginUpdateOutcome.Timeout) {
    return (
      <SystemCheckStatusBadge
        label="Enable timed out"
        tone={SystemCheckStatusTone.Warning}
      />
    );
  }
  if (
    check.enableOutcome === PluginUpdateOutcome.Failed ||
    check.enableOutcome === PluginUpdateOutcome.Skipped
  ) {
    return (
      <SystemCheckStatusBadge
        label="Setup required"
        tone={SystemCheckStatusTone.Danger}
      />
    );
  }
  return null;
}

function renderRemediationText(remediation: string): ReactNode[] {
  const parts = remediation.split(/(https:\/\/\S+)/g);
  return parts.map((part, index) => {
    if (part.startsWith("https://")) {
      return (
        <a
          className="font-medium text-primary underline underline-offset-2"
          href={part}
          key={`${part}-${String(index)}`}
          rel="noreferrer"
          target="_blank"
        >
          {part}
        </a>
      );
    }
    return <span key={`${part}-${String(index)}`}>{part}</span>;
  });
}

function getSystemCheckValue(check: CheckResult): ReactNode {
  if (check.error) {
    return <SystemCheckValue value={check.error} />;
  }

  if (check.passed && check.version) {
    return <SystemCheckValue mono value={check.version} />;
  }

  return null;
}

function SystemCheckValue({
  mono = false,
  value,
}: Readonly<{ mono?: boolean; value: string }>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "block min-w-0 max-w-[45%] cursor-help truncate text-right text-muted-foreground text-xs",
            mono && "font-mono"
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent
        align="end"
        className={cn("max-w-sm break-words", mono && "font-mono")}
      >
        {value}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A blocked or unknown row is NOT a failure — it is a check that could not be
 * determined. Rendering it with the destructive failure mark is what let one
 * stale binary-path override read as six broken plugins (ISS-5369), so those
 * two severities get a neutral mark and never the red X.
 */
function SystemCheckIcon({
  required,
  severity,
}: Readonly<{ required: boolean; severity: CheckSeverity }>) {
  if (isIndeterminateCheckSeverity(severity)) {
    return <CircleDashed className="size-4 shrink-0 text-muted-foreground" />;
  }
  if (severity === CheckSeverity.Passed) {
    return <CheckCircle2 className="size-4 shrink-0 text-success" />;
  }
  if (severity === CheckSeverity.Error && required) {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }
  return <AlertTriangle className="size-4 shrink-0 text-warning-foreground" />;
}

/**
 * Tone must read `required` alongside `severity`, exactly as `SystemCheckIcon`
 * does. An optional failure (Codex CLI not installed) carries
 * `severity: "error"` too, and toning its remediation destructive told the user
 * something was broken that never blocked them.
 */
function getRemediationToneClassName(
  severity: CheckSeverity,
  required: boolean
): string {
  if (isIndeterminateCheckSeverity(severity)) {
    return SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS;
  }
  if (severity === CheckSeverity.Error && required) {
    return "border-destructive/20 bg-destructive/10";
  }
  return "border-warning/30 bg-warning/10";
}

function SystemCheckRowSkeleton() {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
    </div>
  );
}

function SystemCheckCategorySkeleton() {
  return (
    <div
      className={cn(
        "rounded-md border p-3 shadow-sm",
        SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="h-4 w-16 animate-pulse rounded bg-muted" />
      </div>
      <div className="space-y-1.5">
        {Array.from({ length: 3 }).map((_, index) => (
          <SystemCheckRowSkeleton key={`row-${String(index)}`} />
        ))}
      </div>
    </div>
  );
}
