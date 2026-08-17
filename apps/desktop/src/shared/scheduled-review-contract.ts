/**
 * FEA-4143 (PRD-553 / PLN-1500) Slice 1 — the wire contract for a SCHEDULED
 * review dispatch that is proxied from the db-host child (where the crewd daemon
 * ticks) to the main process (where `AuditService` + the desktop access token +
 * the login-shell PATH live).
 *
 * WHY a reverse proxy: the daemon runs inside the db-host utilityProcess, which
 * has NEITHER the cloud access token NOR the shell PATH (both main-side). It also
 * must NOT run the harness cascade directly against the operator's live checkout
 * — the cascade spawns harnesses with `--dangerously-*` bypass flags, so a copy
 * is the only real read-only boundary. `AuditService` already owns both concerns
 * (throwaway-workspace copy + main-side credentials), so the scheduled run is
 * composed through the SAME `AuditService` the on-demand Audit view uses. This
 * request is the child→main hop that carries the per-task config across.
 *
 * Kept free of `node:*` and `@repo/crewd/harness` imports so it is safe on both
 * sides of the process boundary and structured-clone-safe (plain objects only).
 */
import type { CascadeStep } from "@repo/crewd/model";

/**
 * The per-task night-crew config, resolved from `ScheduledTask.meta` in the
 * child, that main needs to run the scheduled review through `AuditService`.
 * Every field is already validated by the crewd `nightCrewConfigSchema` before
 * this request is built.
 */
export type ScheduledReviewRequest = {
  /** Absolute path to the repo the review runs against. */
  repoDir: string;
  /** Review character(s) to run, in order. */
  characters: string[];
  /** Target ClosedLoop project slug/id for the filed findings (optional). */
  projectSlug?: string;
  /** ClosedLoop assignee for the filed issues (optional). */
  assigneeId?: string;
  /** Per-run cascade override; absent/empty ⇒ the runner's default cascade. */
  cascade?: readonly CascadeStep[];
};

/**
 * The outcome of one scheduled review dispatch, mapped by the child back onto a
 * crewd `DispatchOutcome` for the run record. Plain, clone-safe fields only.
 */
export type ScheduledReviewResult = {
  /**
   * True ONLY when every character completed cleanly: each audit run reported
   * `ok` and each filing batch filed every finding. A partial run (`ok:false`
   * with findings) or a partial filing batch (`failed > 0`) flips this to false
   * so a half-successful review is never persisted as a clean success — `ok`
   * alone is not enough to describe the outcome.
   */
  ok: boolean;
  /** ClosedLoop issues newly filed across all characters. */
  created: number;
  /** Findings deduped against already-open issues. */
  skipped: number;
  /**
   * Findings that were produced but whose issue creation failed (partial-batch
   * filing failure), summed across all characters. Non-zero ⇒ some findings are
   * NOT filed and `ok` is false; the run row must not read as a clean success.
   */
  failed: number;
  /** One-line human summary for the run row. */
  summary: string;
  /** Non-null on a run/preflight/filing/partial failure. */
  error: string | null;
};
