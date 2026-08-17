/**
 * @file scheduled-review-runner.ts
 * @description FEA-4143 (PRD-553 / PLN-1500) Slice 1 — the MAIN-process executor
 * for a scheduled night-crew review, composed through the SAME `AuditService`
 * the on-demand Audit view uses.
 *
 * This is the parity + safety keystone of the slice. A scheduled review does NOT
 * call the crewd `runReviewPass` directly (that runs the harness cascade against
 * the operator's LIVE checkout with no throwaway copy, and needs credentials the
 * db-host daemon does not have). Instead it drives `AuditService.run()` — which
 * materializes a disposable workspace copy (`prepareAuditWorkspace`) and hands
 * the login-shell PATH to the cascade — then `AuditService.file()` — which
 * resolves the desktop access token main-side and files the findings through
 * crewd's dedup-guarded `fileFindings`. Because both the scheduled path and the
 * on-demand path go through this ONE `AuditService`, they cannot diverge:
 *   - workspace safety (never the live checkout) is inherited for free;
 *   - the credential boundary holds (secrets never reach the child daemon or the
 *     per-character `claude` sub-sessions);
 *   - local ≡ scheduled parity is a structural property, not a convention.
 *
 * Never throws for an operational failure — a denied repo, missing prompt,
 * exhausted cascade, or filing error is reported in the structured result so the
 * daemon records a clean run status rather than an unhandled rejection.
 */

import { AUDIT_CHARACTER_IDS } from "../../shared/audit-contract.js";
import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../../shared/scheduled-review-contract.js";
import type { AuditService } from "../audit/audit-service.js";

/**
 * Run a scheduled review across the request's characters through `auditService`
 * and file each character's findings, aggregating the outcome. Sequential across
 * characters so the disposable-workspace copies never run concurrently (bounding
 * temp/disk pressure); each character is independent, so one character's failure
 * does not abort the rest.
 */
export async function runScheduledReviewThroughAuditService(
  auditService: AuditService,
  request: ScheduledReviewRequest
): Promise<ScheduledReviewResult> {
  if (request.characters.length === 0) {
    return {
      ok: false,
      created: 0,
      skipped: 0,
      failed: 0,
      summary: "no review characters configured",
      error: "no review characters configured",
    };
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const character of request.characters) {
    // Sequential by design: bound concurrent throwaway-workspace copies so a
    // multi-character review never fans out N simultaneous fs/git copies.
    // Catch at the character boundary: `AuditService.run`/`.file` are contracted
    // never to throw for an operational failure, but a work-directory fs/git
    // setup error (or any other unexpected throw) must NOT abort the rest of the
    // list — each character is independent, so a thrown character is recorded as
    // that character's error and the loop keeps going.
    const outcome = await runOneCharacter(
      auditService,
      request,
      character
    ).catch((error: unknown) => ({
      created: 0,
      skipped: 0,
      failed: 0,
      error: error instanceof Error ? error.message : String(error),
    }));
    created += outcome.created;
    skipped += outcome.skipped;
    failed += outcome.failed;
    if (outcome.error) {
      errors.push(`${character}: ${outcome.error}`);
    }
  }

  // `ok` is the AND of both composition halves across every character: a run
  // that reported not-ok (partial findings) or a filing batch that left findings
  // unfiled (`failed > 0`) recorded an error above, so a half-successful review
  // can never reach a clean `ok` here.
  const ok = errors.length === 0;
  return {
    ok,
    created,
    skipped,
    failed,
    summary: ok
      ? `${created} issue(s) filed, ${skipped} deduped across ${request.characters.length} character(s)`
      : summarizeFailure(created, skipped, failed, errors.length),
    error: ok ? null : errors.join("; "),
  };
}

/** One-line summary for a run where at least one character half failed. */
function summarizeFailure(
  created: number,
  skipped: number,
  failed: number,
  failedCharacters: number
): string {
  const filePart =
    failed > 0
      ? `${created} filed, ${failed} failed to file, ${skipped} deduped`
      : `${created} filed, ${skipped} deduped`;
  return `${filePart}; ${failedCharacters} character(s) failed`;
}

/** Run + file one character; returns its per-character tally + optional error. */
async function runOneCharacter(
  auditService: AuditService,
  request: ScheduledReviewRequest,
  character: string
): Promise<{
  created: number;
  skipped: number;
  failed: number;
  error: string | null;
}> {
  // 0. Roster-validate the character BEFORE any spawn — the SAME gate the
  //    on-demand Audit IPC path applies (`toAuditCharacter`). The night-crew
  //    config is operator-authored on `task.meta`, so an id outside the shipped
  //    roster (a version-skewed/hand-edited value, or a `../…`-style path) must
  //    be rejected here rather than reaching `join(promptsDir, `${id}.md`)`.
  if (!AUDIT_CHARACTER_IDS.has(character)) {
    return {
      created: 0,
      skipped: 0,
      failed: 0,
      error: `unknown review character: ${character}`,
    };
  }

  // 1. Run the audit against a THROWAWAY workspace copy (AuditService owns the
  //    `prepareAuditWorkspace` copy + PATH; the live checkout is never touched).
  const runResult = await auditService.run({
    character,
    repoDir: request.repoDir,
    cascade: request.cascade,
  });
  if (!runResult.ok && runResult.findings.length === 0) {
    return {
      created: 0,
      skipped: 0,
      failed: 0,
      error: runResult.error ?? "audit run failed",
    };
  }
  if (runResult.findings.length === 0) {
    // Clean run — nothing to file.
    return { created: 0, skipped: 0, failed: 0, error: null };
  }

  // A run can return `ok:false` WITH findings — the cascade partially failed but
  // still produced findings the runner files. That is a PARTIAL run: file what
  // we got, but do NOT let this character read as clean. Carry the partial-run
  // reason forward so the aggregate result reflects it even if filing succeeds.
  const partialRunError = runResult.ok
    ? null
    : (runResult.error ?? "audit run partially failed");

  // 2. File the findings through the SAME dedup-guarded main-side path the
  //    on-demand "File to ClosedLoop" action uses. No project ⇒ cannot file.
  if (!request.projectSlug) {
    return {
      created: 0,
      skipped: 0,
      failed: 0,
      error: "findings produced but no target project configured",
    };
  }
  const fileResult = await auditService.file({
    character,
    findings: runResult.findings,
    projectSlug: request.projectSlug,
    assigneeId: request.assigneeId ?? null,
  });
  if (!fileResult.ok) {
    return {
      created: fileResult.created,
      skipped: fileResult.skipped,
      // A hard filing failure files nothing; every finding it tried is unfiled.
      failed: fileResult.failed ?? runResult.findings.length,
      error: joinCharacterErrors(
        partialRunError,
        fileResult.error ?? "filing failed"
      ),
    };
  }
  // A successful filing batch can still leave findings unfiled: `AuditService.file`
  // returns `ok:true` with a nonzero `failed` count on a partial-batch failure.
  // Those findings are kept in triage for retry — surface them, and combine with
  // any partial-run reason so BOTH halves of the composition are preserved.
  const fileFailed = fileResult.failed ?? 0;
  const fileError =
    fileFailed > 0 ? `${fileFailed} finding(s) failed to file` : null;
  return {
    created: fileResult.created,
    skipped: fileResult.skipped,
    failed: fileFailed,
    error: joinCharacterErrors(partialRunError, fileError),
  };
}

/** Join the two composition halves' error reasons into one, or null if clean. */
function joinCharacterErrors(
  runError: string | null,
  fileError: string | null
): string | null {
  const parts = [runError, fileError].filter(
    (part): part is string => part !== null
  );
  return parts.length === 0 ? null : parts.join("; ");
}
