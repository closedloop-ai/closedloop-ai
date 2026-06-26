"use client";

import {
  type CheckResult,
  PluginUpdateOutcome,
} from "@closedloop-ai/loops-api/compute-target";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect } from "react";

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
  return (
    <section className="rounded-md border bg-background/55 p-3 shadow-sm">
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
            targetKind={targetKind}
          />
        ))}
      </div>
    </section>
  );
}

function SystemCheckRow({
  check,
  pluginAutoUpdateEnabled,
  revealed,
  targetKind,
  onStructuredRemediationViewed,
  onStructuredRemediationLinkClick,
}: Readonly<{
  check: CheckResult;
  pluginAutoUpdateEnabled: boolean;
  revealed: boolean;
  targetKind: SystemCheckResultsTargetKind;
  onStructuredRemediationViewed?: (
    payload: SystemCheckResultsRemediationView
  ) => void;
  onStructuredRemediationLinkClick?: (
    payload: SystemCheckResultsRemediationClick
  ) => void;
}>) {
  const isAdvisory = check.passed && Boolean(check.error);
  const value = getSystemCheckValue(check);
  const updateStatus = getPluginUpdateStatus(check, pluginAutoUpdateEnabled);
  const enableStatus = getPluginEnableStatus(check);
  const showRemediation =
    (check.error || !check.passed) && Boolean(check.remediation);
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
        <SystemCheckIcon
          advisory={isAdvisory}
          passed={check.passed}
          required={check.required}
        />
        <span className="min-w-0 flex-1 truncate">{check.label}</span>
        {enableStatus}
        {updateStatus}
        {value}
        {check.passed && !check.version && !check.error && (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
        )}
      </div>
      {showRemediation && (
        <p className="mt-1 ml-6 rounded border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs">
          <span className="text-foreground/80">
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
            <span className="select-all text-[11px]">
              {renderRemediationText(check.remediation ?? "")}
            </span>
          </span>
        </p>
      )}
    </div>
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
    return <SystemCheckStatusBadge label="Updated" tone="success" />;
  }
  if (check.updateOutcome === "timeout") {
    return <SystemCheckStatusBadge label="Update timed out" tone="warning" />;
  }
  if (check.updateOutcome === "failed" || check.updateOutcome === "skipped") {
    return <SystemCheckStatusBadge label="Update failed" tone="danger" />;
  }
  return null;
}

function getPluginEnableStatus(check: CheckResult): ReactNode {
  if (!check.id.startsWith("plugin-")) {
    return null;
  }
  if (check.enableOutcome === PluginUpdateOutcome.Success) {
    return <SystemCheckStatusBadge label="Enabled" tone="success" />;
  }
  if (check.enableOutcome === PluginUpdateOutcome.Timeout) {
    return <SystemCheckStatusBadge label="Enable timed out" tone="warning" />;
  }
  if (
    check.enableOutcome === PluginUpdateOutcome.Failed ||
    check.enableOutcome === PluginUpdateOutcome.Skipped
  ) {
    return <SystemCheckStatusBadge label="Setup required" tone="danger" />;
  }
  return null;
}

function SystemCheckStatusBadge({
  label,
  tone,
}: Readonly<{ label: string; tone: "success" | "warning" | "danger" }>) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 font-medium text-[10px]",
        tone === "success" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
        tone === "warning" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700",
        tone === "danger" &&
          "border-destructive/30 bg-destructive/10 text-destructive"
      )}
    >
      {label}
    </span>
  );
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

function SystemCheckIcon({
  advisory,
  passed,
  required,
}: Readonly<{ advisory: boolean; passed: boolean; required: boolean }>) {
  if (advisory) {
    return <AlertTriangle className="size-4 shrink-0 text-amber-500" />;
  }
  if (passed) {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />;
  }
  if (required) {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }
  return <AlertTriangle className="size-4 shrink-0 text-amber-500" />;
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
    <div className="rounded-md border bg-background/55 p-3 shadow-sm">
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
