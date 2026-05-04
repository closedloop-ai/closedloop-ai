"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { CheckResult } from "@/lib/engineer/queries/health-check";

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
};

export function SystemCheckResults({
  checks,
  isLoading = false,
  revealedCount,
  className,
  afterRequired,
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
        skeletonGroups={3}
        title="Required"
        visibleCount={visibleCount}
      />

      {afterRequired}

      {showOptional && (
        <SystemCheckSection
          groups={optionalGroups}
          isLoading={isLoading}
          skeletonGroups={2}
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
}: Readonly<{
  groups: CheckCategoryGroup[];
  isLoading: boolean;
  skeletonGroups: number;
  title: string;
  visibleCount: number;
}>) {
  return (
    <section className="@container/checks">
      <h4 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">
        {title}
      </h4>
      <SystemCheckCardGrid
        groups={groups}
        isLoading={isLoading}
        skeletonGroups={skeletonGroups}
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
}: Readonly<{
  groups: CheckCategoryGroup[];
  isLoading: boolean;
  skeletonGroups: number;
  title: string;
  visibleCount: number;
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
}: Readonly<{ group: CheckCategoryGroup; visibleCount: number }>) {
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
            revealed={visibleCount > displayIndex}
          />
        ))}
      </div>
    </section>
  );
}

function SystemCheckRow({
  check,
  revealed,
}: Readonly<{ check: CheckResult; revealed: boolean }>) {
  if (!revealed) {
    return <SystemCheckRowSkeleton />;
  }

  const isAdvisory = check.passed && Boolean(check.error);
  const value = getSystemCheckValue(check);

  return (
    <div className="fade-in slide-in-from-left-3 animate-in space-y-0.5 duration-300">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <SystemCheckIcon
          advisory={isAdvisory}
          passed={check.passed}
          required={check.required}
        />
        <span className="min-w-0 flex-1 truncate">{check.label}</span>
        {value}
        {check.passed && !check.version && !check.error && (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
        )}
      </div>
      {(check.error || !check.passed) && check.remediation && (
        <p className="pl-6 text-muted-foreground text-xs">
          <span className="select-all font-mono text-[11px]">
            {check.remediation}
          </span>
        </p>
      )}
    </div>
  );
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
        <button
          aria-label={value}
          className={cn(
            "min-w-0 max-w-[45%] cursor-help truncate rounded-sm border-0 bg-transparent p-0 text-right text-muted-foreground text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            mono && "font-mono"
          )}
          type="button"
        >
          {value}
        </button>
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
