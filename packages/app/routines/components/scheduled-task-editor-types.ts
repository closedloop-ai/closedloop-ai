import type { CascadeStep, PassKind, TaskRoute } from "@repo/crewd/model";

/**
 * The surface-agnostic save/preview types the Scheduled Tasks slice speaks to
 * its injected data source (FEA-3853). These MUST stay structurally equal to the
 * desktop IPC contract's `ScheduledTaskSaveInput` / `SchedulePreviewRequest` /
 * `SchedulePreviewResult` (`apps/desktop/src/shared/scheduled-tasks-channel.ts`),
 * which is the trust boundary that re-validates every write with the crewd Zod
 * schema. They are declared here (not imported from the desktop app) because
 * `@repo/app` cannot depend on `apps/desktop`; the field shapes reuse the crewd
 * `CascadeStep` / `PassKind` model types so the two definitions cannot drift on
 * the domain-owned fields.
 */

/** The create/edit modal's save payload; `id` present ⇒ update, absent ⇒ create. */
export type ScheduledTaskSaveInput = {
  id?: string;
  name: string;
  cron: string;
  prompt: string;
  kind: PassKind;
  pass?: string;
  harnessCascade: CascadeStep[];
  /**
   * FEA-3816 (PRD-553 M4): the capability broker's per-task route — run locally
   * through the crewd cascade (`local-cascade`) or hand the task to a Claude
   * cloud routine (`claude-routine`).
   */
  route: TaskRoute;
  timezone: string;
  enabled: boolean;
};

/** Request the modal sends to validate + preview a cron's next fire times. */
export type SchedulePreviewRequest = {
  cron: string;
  timezone?: string;
  count?: number;
};

/** The validate-and-preview result: validity, an error message, next fire times. */
export type SchedulePreviewResult = {
  valid: boolean;
  error: string | null;
  nextRuns: string[];
};
