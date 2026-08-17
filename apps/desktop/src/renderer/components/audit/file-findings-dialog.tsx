/**
 * @file file-findings-dialog.tsx
 * @description FEA-3849 (PRD-556 M3) — the confirm dialog for filing the user's
 * SELECTED findings to ClosedLoop. Extended by FEA-4008: the target project is a
 * typeahead (not free text) and an assignee picker threads the chosen assignee
 * onto every created issue.
 *
 * This is the explicit gate that makes filing a deliberate, never-automatic act:
 * the user selects findings in the triage list, clicks "Create Issues & Assign",
 * and this dialog states exactly what will happen (N issues created, dedup-
 * guarded, tagged, assigned) before the parent actually calls `audit.file`. It
 * captures the target ClosedLoop project (required, via typeahead) and an
 * optional assignee, and drives the confirm action. Presentational: open/close,
 * the selected count, the project/assignee sources, and the confirm handler are
 * owned by the parent view.
 */
import {
  type ProjectOption,
  ProjectSelectPopover,
} from "@repo/app/projects/components/project-select-popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@closedloop-ai/design-system/components/ui/alert-dialog";
import { Label } from "@closedloop-ai/design-system/components/ui/label";
import type { User as AssigneeOption } from "@closedloop-ai/design-system/components/ui/user-select-popover";
import { UserSelectPopover } from "@closedloop-ai/design-system/components/ui/user-select-popover";
import { AUDIT_DOCS_DARWIN_TAG } from "../../../shared/audit-contract";

/** Trigger ids so each `<Label htmlFor>` points at its picker's combobox. */
const PROJECT_TRIGGER_ID = "audit-file-project";
const ASSIGNEE_TRIGGER_ID = "audit-file-assignee";

export type FileFindingsDialogProps = {
  open: boolean;
  /** How many findings the user selected to file. */
  selectedCount: number;
  /** The projects the user can file into (loaded by the parent). */
  projects: readonly ProjectOption[];
  /** True while the project list is still loading. */
  projectsLoading?: boolean;
  /** True when the project list failed to load. */
  projectsError?: boolean;
  /** The currently-selected target project (controlled by the parent). */
  selectedProject: ProjectOption | null;
  onProjectChange: (project: ProjectOption | null) => void;
  /** The org members the assignee typeahead can pick from. */
  assignees: readonly AssigneeOption[];
  /** True while the org roster is still loading. */
  assigneesLoading?: boolean;
  /** The currently-selected assignee (optional — unassigned when null). */
  selectedAssignee: AssigneeOption | null;
  onAssigneeChange: (assignee: AssigneeOption | null) => void;
  /** True while the file action is in flight (disables confirm). */
  filing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Confirm-before-file dialog: states the effect, captures project + assignee. */
export function FileFindingsDialog({
  open,
  selectedCount,
  projects,
  projectsLoading = false,
  projectsError = false,
  selectedProject,
  onProjectChange,
  assignees,
  assigneesLoading = false,
  selectedAssignee,
  onAssigneeChange,
  filing,
  onConfirm,
  onCancel,
}: FileFindingsDialogProps) {
  const canConfirm = selectedCount > 0 && selectedProject !== null && !filing;
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      open={open}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Create {selectedCount} {selectedCount === 1 ? "issue" : "issues"} in
            ClosedLoop?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Each selected finding is created as a TRIAGE issue tagged
            <code className="mx-1 rounded bg-[var(--muted)] px-1 py-0.5 font-mono text-xs">
              {AUDIT_DOCS_DARWIN_TAG}
            </code>
            . Findings already filed (matched by signature) are skipped, so
            re-filing never creates duplicates. Nothing is created until you
            confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={PROJECT_TRIGGER_ID}>ClosedLoop project</Label>
            <ProjectSelectPopover
              ariaLabel="ClosedLoop project"
              disabled={filing}
              id={PROJECT_TRIGGER_ID}
              isError={projectsError}
              isLoading={projectsLoading}
              onSelect={onProjectChange}
              placeholder="Select project…"
              projects={projects}
              value={selectedProject}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={ASSIGNEE_TRIGGER_ID}>
              Assignee <span className="text-muted-foreground">(optional)</span>
            </Label>
            <UserSelectPopover
              ariaLabel="Assignee"
              className="w-full"
              disabled={filing}
              id={ASSIGNEE_TRIGGER_ID}
              isLoading={assigneesLoading}
              onSelect={onAssigneeChange}
              placeholder="Assign to me"
              users={[...assignees]}
              value={selectedAssignee}
            />
            {/* Honest default: with no explicit assignee the platform assigns
                the created issues to the filer (the API key owner), so we do
                not label the empty state "Unassigned". */}
            <p className="text-muted-foreground text-xs">
              Leave blank to assign the issues to yourself.
            </p>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canConfirm}
            onClick={(event) => {
              // Keep the dialog mounted so the parent can show the outcome; the
              // parent closes it once the file action settles.
              event.preventDefault();
              onConfirm();
            }}
          >
            {filing ? "Creating…" : "Create issues"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
