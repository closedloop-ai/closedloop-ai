/**
 * @file audit-view.tsx
 * @description FEA-3848 (PRD-556 M2) — the Audit Bot findings triage surface.
 *
 * The Labs-gated desktop view for the on-demand audit (PRD-556). The user picks
 * a repo (sandbox-validated by the main process), runs a review character (Docs
 * Darwin), watches the harness cascade attempt live, and then triages the
 * findings grouped by severity — each row opening a detail drawer with the full
 * evidence and proposed fix. Handles every state cleanly: idle (pick + run),
 * running (live cascade), no-findings (a clean pass), a typed refusal (flag off
 * / repo denied), and an error (cascade exhausted).
 *
 * Flag gating is the parent's job (App renders this only when `auditBot` is on);
 * this component assumes it is allowed to run.
 */

import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@closedloop-ai/design-system/components/ui/empty";
import { ScrollArea } from "@closedloop-ai/design-system/components/ui/scroll-area";
import type { User as AssigneeOption } from "@closedloop-ai/design-system/components/ui/user-select-popover";
import {
  type ProjectOption,
  projectSelectionValue,
} from "@repo/app/projects/components/project-select-popover";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import { useOrgUsersPopoverQuery } from "@repo/app/users/hooks/use-org-users-as-popover-users";
import type {
  AuditScope,
  CascadeAttempt,
  CascadeStep,
  HarnessName,
} from "@repo/crewd/model";
import { CircleCheckIcon, ShieldAlertIcon, UploadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  AUDIT_CHARACTER_IDS,
  AuditCharacter,
  type AuditCharacterId,
  AuditFileFailureReason,
  type AuditFileResult,
  AuditRunFailureReason,
  DEFAULT_AUDIT_CASCADE,
  DEFAULT_AUDIT_SCOPE,
} from "../../../shared/audit-contract";
import { pageTitleForNav } from "../../navigation/nav-config";
import { NavId } from "../../navigation/route-table";
import { DashboardCard, PageShell } from "../layout/page-shell";
import {
  correlateFileOutcomes,
  createdViewIds,
  type FindingFileStatus,
} from "./audit-file-model";
import {
  type AuditFindingView,
  groupFindingsBySeverity,
} from "./audit-finding-model";
import { AuditRunControls } from "./audit-run-controls";
import { CascadeProgress } from "./cascade-progress";
import { FileFindingsDialog } from "./file-findings-dialog";
import { FindingDetailSheet } from "./finding-detail-sheet";
import {
  type FindingsSelection,
  FindingsTriageList,
} from "./findings-triage-list";
import { AuditFilePhase, useAuditFile } from "./use-audit-file";
import { AuditRunPhase, useAuditRun } from "./use-audit-run";

const PAGE_DESCRIPTION =
  "Run a review character against a local repo and triage its findings. Findings stay local until you select them and create issues in ClosedLoop — nothing is created automatically.";

/** The friendly copy for each pre-flight refusal reason. */
const REFUSAL_COPY: Record<AuditRunFailureReason, string> = {
  [AuditRunFailureReason.Disabled]:
    "Audit Bot is turned off. Enable it in Labs settings to run an audit.",
  [AuditRunFailureReason.RepoNotAllowed]:
    "That folder is outside the sandbox allow-list. Pick a repo inside an allowed directory.",
  [AuditRunFailureReason.SetupFailed]:
    "The audit could not be set up. Check that the repo is valid and try again.",
};

/** The Audit Bot findings-triage view. */
export function AuditView() {
  const { phase, cascade, attempts, result, run } = useAuditRun();
  const fileController = useAuditFile();
  const [character, setCharacter] = useState<AuditCharacterId>(
    AuditCharacter.DocsDarwin
  );
  const [scope, setScope] = useState<AuditScope>(DEFAULT_AUDIT_SCOPE);
  // The operator-selected harness cascade (FEA-4009). Seeded to the canonical
  // default order so the run behaves exactly as before until the user edits it;
  // the request still degrades to the main-process default if it is ever empty.
  // Named distinctly from the hook's `cascade` (the live harness-name trail).
  const [cascadeSteps, setCascadeSteps] = useState<CascadeStep[]>(() => [
    ...DEFAULT_AUDIT_CASCADE,
  ]);
  const [repoDir, setRepoDir] = useState<string | null>(null);
  const [repoWarning, setRepoWarning] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditFindingView | null>(null);
  // The ids of findings the user has checked to file (M3). Never files on its
  // own — filing only happens when the user opens the confirm dialog + confirms.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<ProjectOption | null>(
    null
  );
  const [selectedAssignee, setSelectedAssignee] =
    useState<AssigneeOption | null>(null);
  // The ids the user has filed in a settled batch — cleared from the triage
  // list so only un-filed findings linger (FEA-4008). Failed/skipped stay.
  const [clearedIds, setClearedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // Per-view-id filing status from the last settled batch, correlated by
  // request position (not dedup key) so same-key rows badge independently. Held
  // in state — not derived from `fileController.result` — so a skipped row keeps
  // its badge even after created siblings are cleared from the list.
  const [fileStatusByViewId, setFileStatusByViewId] = useState<
    ReadonlyMap<string, FindingFileStatus>
  >(() => new Map());

  // Typeahead sources. Both are gated on the confirm dialog being open so the
  // Audit view does not fetch org projects/members on first paint — the data is
  // only needed once the user opens the "Create issues" dialog. Loading/error
  // state is threaded through so the pickers never present an in-flight or
  // failed fetch as a genuinely empty org (FEA-4008).
  const {
    data: projectRecords = [],
    isLoading: projectsLoading,
    isError: projectsError,
  } = useProjects(undefined, {
    enabled: fileDialogOpen,
  });
  const { users: assignees, isLoading: assigneesLoading } =
    useOrgUsersPopoverQuery({ enabled: fileDialogOpen });
  const projects = useMemo<ProjectOption[]>(
    () =>
      projectRecords.map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
      })),
    [projectRecords]
  );

  const running = phase === AuditRunPhase.Running;
  const filing = fileController.phase === AuditFilePhase.Filing;

  const pickRepo = useCallback(async () => {
    const picked = await window.desktopApi?.pickSandboxDirectory?.();
    if (!picked) {
      return;
    }
    setRepoDir(picked.path);
    if (picked.isRisky) {
      setRepoWarning(
        "This looks like a broad root folder — pick a specific repository instead."
      );
    } else if (picked.isGitRepo) {
      setRepoWarning(null);
    } else {
      setRepoWarning("This folder is not a git repository.");
    }
  }, []);

  const startRun = useCallback(async () => {
    if (!repoDir) {
      return;
    }
    // A fresh run invalidates any prior selection / filing outcome.
    setSelectedIds(new Set());
    setClearedIds(new Set());
    setFileStatusByViewId(new Map());
    fileController.reset();
    await run({
      character,
      repoDir,
      scopePreset: scope,
      cascade: cascadeSteps,
    });
  }, [character, repoDir, run, scope, cascadeSteps, fileController]);

  // The run's severity grouping. The original count drives the empty/clean-pass
  // vs. findings-body decision; `groups` below then drops findings the user has
  // already filed so only un-actioned ones render (FEA-4008).
  const totalFindings = result?.findings.length ?? 0;

  // Findings the user has already filed are dropped from the triage list so
  // only un-actioned findings remain (FEA-4008). Cleared ids are view ids
  // (signature-or-slug) — the same key the list rows toggle — so the filter
  // can never drift from the list's identity. Failed/skipped findings are never
  // added to `clearedIds`, so they stay for retry.
  const groups = useMemo(() => {
    const allGroups = groupFindingsBySeverity(result?.findings ?? []);
    if (clearedIds.size === 0) {
      return allGroups;
    }
    return allGroups
      .map((group) => ({
        ...group,
        findings: group.findings.filter((view) => !clearedIds.has(view.id)),
      }))
      .filter((group) => group.findings.length > 0);
  }, [result, clearedIds]);
  const remainingFindings = groups.reduce(
    (sum, group) => sum + group.findings.length,
    0
  );

  const toggleSelection = useCallback((view: AuditFindingView) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(view.id)) {
        next.delete(view.id);
      } else {
        next.add(view.id);
      }
      return next;
    });
  }, []);

  // The selected finding VIEWS, resolved from the checked view ids. Derived from
  // the grouped views (whose ids are exactly what the list checkboxes toggle) so
  // the id mapping can never drift from the list's. Views (not bare findings) so
  // the post-file clear can map a created dedup key back to the view id.
  const selectedViews = useMemo(() => {
    const views = groups.flatMap((group) => group.findings);
    return views.filter((view) => selectedIds.has(view.id));
  }, [groups, selectedIds]);

  // File under the character the SETTLED run actually produced, not the live
  // picker: after a run completes the user can change the picker without
  // starting a new run, and the on-screen findings still belong to the run that
  // produced them. Filing must stamp that character's tag, not the new pick.
  const settledCharacter = useMemo(
    () => resolveSettledCharacter(result?.character),
    [result]
  );

  const confirmFile = useCallback(async () => {
    if (
      selectedViews.length === 0 ||
      selectedProject === null ||
      !settledCharacter
    ) {
      return;
    }
    // Snapshot the batch's views BEFORE awaiting so the outcome correlates by
    // request position against exactly what was sent, even if selection changes.
    const batchViews = selectedViews;
    const result = await fileController.file({
      character: settledCharacter,
      findings: batchViews.map((view) => view.finding),
      projectSlug: projectSelectionValue(selectedProject),
      assigneeId: selectedAssignee?.id ?? null,
    });
    setFileDialogOpen(false);
    // `file()` returns null when a fresh run superseded this call — never apply
    // a stale run's outcome to the current findings.
    if (!result?.ok) {
      return;
    }
    // Correlate each outcome to its view by request position (collision-free:
    // two views that share a dedup key get their own badge). Persist the badge
    // map so a skipped row keeps it after created siblings are cleared.
    const statusByViewId = correlateFileOutcomes(batchViews, result.filed);
    setFileStatusByViewId((prev) => new Map([...prev, ...statusByViewId]));
    // Only CREATED views are dropped from the triage list; skipped/deduped ones
    // linger so the user sees they were not re-filed (FEA-4008).
    const created = createdViewIds(batchViews, result.filed);
    if (created.length > 0) {
      setClearedIds((prev) => {
        const next = new Set(prev);
        for (const id of created) {
          next.add(id);
        }
        return next;
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of created) {
          next.delete(id);
        }
        return next;
      });
    }
  }, [
    fileController,
    selectedAssignee,
    selectedProject,
    selectedViews,
    settledCharacter,
  ]);

  const selection: FindingsSelection = {
    selectedIds,
    onToggle: toggleSelection,
    fileStatus: fileStatusByViewId,
    disabled: filing,
  };

  return (
    <PageShell
      description={PAGE_DESCRIPTION}
      title={pageTitleForNav(NavId.Audit)}
    >
      <ScrollArea className="h-full">
        <div className="flex flex-col gap-4 pb-6">
          <AuditRunControls
            cascade={cascadeSteps}
            character={character}
            onCascadeChange={setCascadeSteps}
            onCharacterChange={setCharacter}
            onPick={pickRepo}
            onRun={startRun}
            onScopeChange={setScope}
            repoDir={repoDir}
            repoWarning={repoWarning}
            running={running}
            scope={scope}
          />

          {running ? (
            <DashboardCard title="Cascade progress">
              <CascadeProgress
                attempts={attempts}
                cascade={cascade}
                running={running}
              />
            </DashboardCard>
          ) : null}

          {phase === AuditRunPhase.Complete && result ? (
            <ResultBody
              attempts={attempts}
              cascade={cascade}
              fileResult={fileController.result}
              filing={filing}
              groups={groups}
              onFile={() => setFileDialogOpen(true)}
              onSelect={setSelected}
              refusal={result.reason}
              remainingFindings={remainingFindings}
              runError={result.error}
              selectedCount={selectedIds.size}
              selection={selection}
              totalFindings={totalFindings}
            />
          ) : null}
        </div>
      </ScrollArea>

      <FindingDetailSheet onClose={() => setSelected(null)} view={selected} />
      <FileFindingsDialog
        assignees={assignees}
        assigneesLoading={assigneesLoading}
        filing={filing}
        onAssigneeChange={setSelectedAssignee}
        onCancel={() => setFileDialogOpen(false)}
        onConfirm={confirmFile}
        onProjectChange={setSelectedProject}
        open={fileDialogOpen}
        projects={projects}
        projectsError={projectsError}
        projectsLoading={projectsLoading}
        selectedAssignee={selectedAssignee}
        selectedCount={selectedIds.size}
        selectedProject={selectedProject}
      />
    </PageShell>
  );
}

function ResultBody({
  refusal,
  runError,
  totalFindings,
  remainingFindings,
  groups,
  attempts,
  cascade,
  onSelect,
  selection,
  selectedCount,
  filing,
  fileResult,
  onFile,
}: {
  refusal: AuditRunFailureReason | null;
  runError: string | null;
  /** The run's original finding count — gates the empty/clean-pass state. */
  totalFindings: number;
  /** Findings still un-filed (cleared ones dropped) — drives the list copy. */
  remainingFindings: number;
  groups: ReturnType<typeof groupFindingsBySeverity>;
  attempts: readonly CascadeAttempt[];
  cascade: readonly HarnessName[];
  onSelect: (view: AuditFindingView) => void;
  selection: FindingsSelection;
  selectedCount: number;
  filing: boolean;
  fileResult: AuditFileResult | null;
  onFile: () => void;
}) {
  if (refusal) {
    return (
      <StateCard
        description={REFUSAL_COPY[refusal]}
        icon={<ShieldAlertIcon aria-hidden className="size-6" />}
        title="Audit could not run"
      />
    );
  }
  if (totalFindings === 0 && runError) {
    return (
      <StateCard
        description={`No harness produced findings (${runError}). Check the harness cascade and try again.`}
        icon={<ShieldAlertIcon aria-hidden className="size-6" />}
        title="Audit did not complete"
      />
    );
  }
  if (totalFindings === 0) {
    return (
      <StateCard
        description="The reviewer found no documentation-vs-code mismatches. Nothing to triage."
        icon={<CircleCheckIcon aria-hidden className="size-6" />}
        title="No findings"
      />
    );
  }
  if (remainingFindings === 0) {
    // Every finding was created — but keep the card so the created/skipped
    // outcome and the cascade trail survive the last file (the moment the user
    // most wants to see what happened), instead of blanking them with an empty
    // state that replaces the whole card (FEA-4008).
    return (
      <DashboardCard
        description="Every finding from this run has an issue in ClosedLoop. Nothing left to triage."
        title="All findings filed"
      >
        <div className="flex flex-col gap-4">
          {fileResult ? <FileOutcome result={fileResult} /> : null}
          <AuditCascadeTrail attempts={attempts} cascade={cascade} />
        </div>
      </DashboardCard>
    );
  }
  return (
    <DashboardCard
      description={`${remainingFindings} ${remainingFindings === 1 ? "finding" : "findings"} across ${groups.length} ${groups.length === 1 ? "severity" : "severities"}. Select findings to create issues in ClosedLoop.`}
      title="Findings"
    >
      <div className="flex flex-col gap-4">
        <FileActionBar
          filing={filing}
          onFile={onFile}
          selectedCount={selectedCount}
        />
        {fileResult ? <FileOutcome result={fileResult} /> : null}
        <FindingsTriageList
          groups={groups}
          onSelect={onSelect}
          selection={selection}
        />
        <AuditCascadeTrail attempts={attempts} cascade={cascade} />
      </div>
    </DashboardCard>
  );
}

/** The settled-run cascade trail shown under the findings list / outcome. */
function AuditCascadeTrail({
  attempts,
  cascade,
}: {
  attempts: readonly CascadeAttempt[];
  cascade: readonly HarnessName[];
}) {
  return (
    <div className="border-[var(--border)] border-t pt-3">
      <p className="mb-2 text-[var(--muted-foreground)] text-xs">
        Cascade trail
      </p>
      <CascadeProgress attempts={attempts} cascade={cascade} running={false} />
    </div>
  );
}

/** The select-count + "Create issues" trigger row above the triage list. */
function FileActionBar({
  selectedCount,
  filing,
  onFile,
}: {
  selectedCount: number;
  filing: boolean;
  onFile: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[var(--muted-foreground)] text-sm">
        {selectedCount === 0
          ? "Select findings to create issues."
          : `${selectedCount} selected`}
      </span>
      <Button
        disabled={selectedCount === 0 || filing}
        onClick={onFile}
        type="button"
      >
        <UploadIcon aria-hidden />
        {filing ? "Creating…" : "Create issues"}
      </Button>
    </div>
  );
}

/** The friendly copy for each file-to-ClosedLoop refusal reason (exhaustive). */
const FILE_REFUSAL_COPY: Record<AuditFileFailureReason, string> = {
  [AuditFileFailureReason.Disabled]:
    "Audit Bot is turned off — enable it in Labs settings to file.",
  [AuditFileFailureReason.InvalidRequest]:
    "Pick at least one finding and a target project, then retry.",
  [AuditFileFailureReason.NotAuthenticated]:
    "Sign in to your ClosedLoop account to file findings.",
  [AuditFileFailureReason.FilingFailed]:
    "Filing failed. Check the project and your connection.",
};

/** Surfaces the settled file outcome: created vs. deduped counts, or a refusal. */
function FileOutcome({ result }: { result: AuditFileResult }) {
  if (!result.ok) {
    const copy =
      (result.reason ? FILE_REFUSAL_COPY[result.reason] : null) ??
      result.error ??
      "Filing did not complete.";
    return (
      <Badge variant="error">
        <ShieldAlertIcon aria-hidden />
        {copy}
      </Badge>
    );
  }
  const failed = result.failed ?? 0;
  const summary = fileOutcomeSummary(result.created, result.skipped, failed);
  // A partial batch (some creates failed) is not a clean success — badge it as
  // an error so the failed count is not buried under a green "filed" banner.
  if (failed > 0) {
    return (
      <Badge variant="error">
        <ShieldAlertIcon aria-hidden />
        {summary}
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      <CircleCheckIcon aria-hidden />
      {summary}
    </Badge>
  );
}

/** The created / skipped / failed one-line summary for the outcome banner. */
function fileOutcomeSummary(
  created: number,
  skipped: number,
  failed: number
): string {
  const parts = [`${created} filed`];
  if (skipped > 0) {
    parts.push(`${skipped} already filed (skipped)`);
  }
  if (failed > 0) {
    parts.push(`${failed} failed — kept for retry`);
  }
  return parts.join(", ");
}

function StateCard({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <DashboardCard>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </DashboardCard>
  );
}

/**
 * Narrow the settled run's `character` (a wire string) to a known roster id
 * ({@link AUDIT_CHARACTER_IDS}), or null when it is absent/unrecognized. Filing
 * keys off this so a completed run's findings are always tagged with the
 * character that produced them, never a picker value the user changed afterward.
 */
function resolveSettledCharacter(
  character: string | undefined
): AuditCharacterId | null {
  if (character && AUDIT_CHARACTER_IDS.has(character)) {
    return character;
  }
  return null;
}
