/**
 * @file rehearsal-verify-checks.ts
 * @description ISS-5104 — pure decision logic for Phase B of the DATA_REVISION
 * rebuild rehearsal (`rehearsal-verify.ts`): manifest validation and the
 * violation checks over the post-rebuild store state. Kept free of DB/collector
 * imports so `test/rehearsal-verify-checks.test.ts` can cover every branch
 * without a store.
 *
 * The manifest crosses a VERSION-SKEW boundary (it may be written by the
 * merge-base's copy of `rehearsal-build-store.ts`), so the schema is tolerant:
 * unknown extra fields pass through, and only the fields the checks consume are
 * validated.
 */
import { z } from "zod";

const rehearsalSessionStateSchema = z.object({
  id: z.string(),
  dataRevision: z.number(),
  invocationCount: z.number(),
  analyticsCount: z.number(),
});

export const rehearsalManifestSchema = z.object({
  rehearsalManifestVersion: z.number(),
  sessions: z.array(rehearsalSessionStateSchema).min(1),
});

export type RehearsalManifest = z.infer<typeof rehearsalManifestSchema>;

export type RehearsalSessionState = z.infer<typeof rehearsalSessionStateSchema>;

export type RehearsalRebuildOutcome = {
  errors: number;
  parseErrors: number;
  /**
   * Sessions whose SOURCE transcript the rebuild could not find, and sources it
   * could not match back to a session. Every golden-corpus session's source is
   * present by construction, so either being non-zero is a source-mapping
   * regression — and it must fail here rather than quietly take the stored-row
   * fallback and stamp the session at the current revision anyway.
   */
  missingSource: number;
  unmatchedSource: number;
};

/**
 * All violations of the rehearsal contract, as human-readable strings citing
 * session ids. Empty array = the boot path over the previous-code store is
 * clean. `currentRevision` / `importPendingSentinel` arrive as parameters so
 * this module stays import-light and the checks stay unit-testable against
 * synthetic revisions.
 */
export function collectRehearsalViolations(options: {
  manifest: RehearsalManifest;
  postSessions: RehearsalSessionState[];
  outcome: RehearsalRebuildOutcome;
  currentRevision: number;
  importPendingSentinel: number;
}): string[] {
  const { manifest, postSessions, outcome, currentRevision } = options;
  const violations: string[] = [];
  if (outcome.errors > 0 || outcome.parseErrors > 0) {
    violations.push(
      `rebuild summary reports failures: errors=${outcome.errors} parseErrors=${outcome.parseErrors}`
    );
  }
  if (outcome.missingSource > 0 || outcome.unmatchedSource > 0) {
    violations.push(
      `rebuild could not resolve sources it must find in the frozen corpus: missingSource=${outcome.missingSource} unmatchedSource=${outcome.unmatchedSource}`
    );
  }
  violations.push(...manifestSanityViolations(manifest));
  if (postSessions.length === 0) {
    violations.push("post-rebuild store contains zero sessions");
  }
  violations.push(
    ...revisionViolations(
      postSessions,
      currentRevision,
      options.importPendingSentinel
    )
  );
  violations.push(...projectionLossViolations(manifest, postSessions));
  return violations;
}

/**
 * The manifest must prove the pre-state was non-vacuous: a corpus store where
 * NO session has invocation or analytics rows would make the projection-loss
 * checks pass trivially.
 */
function manifestSanityViolations(manifest: RehearsalManifest): string[] {
  const violations: string[] = [];
  if (!manifest.sessions.some((s) => s.invocationCount > 0)) {
    violations.push(
      "manifest sanity: no pre-rebuild session has component-invocation rows — the invocation-preservation check would be vacuous"
    );
  }
  if (!manifest.sessions.some((s) => s.analyticsCount > 0)) {
    violations.push(
      "manifest sanity: no pre-rebuild session has session_analytics rows — the analytics-preservation check would be vacuous"
    );
  }
  return violations;
}

/**
 * Every surviving session must be sealed at the current revision: none left at
 * the import-pending sentinel (an interrupted/evicted import) and none left
 * below current (a swallowed rebuild failure — every golden-corpus source
 * survives, so "still stale" cannot mean "source gone").
 */
function revisionViolations(
  postSessions: RehearsalSessionState[],
  currentRevision: number,
  importPendingSentinel: number
): string[] {
  const violations: string[] = [];
  const pending = postSessions.filter(
    (s) => s.dataRevision === importPendingSentinel
  );
  if (pending.length > 0) {
    violations.push(
      `${pending.length} session(s) left at DATA_REVISION_IMPORT_PENDING: ${idSample(pending)}`
    );
  }
  const stale = postSessions.filter(
    (s) =>
      s.dataRevision !== currentRevision &&
      s.dataRevision !== importPendingSentinel
  );
  if (stale.length > 0) {
    violations.push(
      `${stale.length} session(s) left at a stale data_revision (current ${currentRevision}): ${idSample(stale)}`
    );
  }
  return violations;
}

/**
 * A session that had invocation/analytics rows before the rebuild must still
 * have AT LEAST AS MANY after — a shrunken count is partial loss and fails just
 * like total loss.
 *
 * A session that vanishes entirely is a violation too. Tolerating it would
 * outsource the verdict to `isBurstArtifactSource`, which is part of the code
 * under test: a regression there could delete real sessions carrying
 * projections and still pass. Every golden-corpus session's source survives the
 * rebuild by construction, so the honest expectation is that none disappear —
 * and if a deliberate change ever makes one disappear, this fails loudly and
 * the corpus oracle gets updated on purpose.
 */
function projectionLossViolations(
  manifest: RehearsalManifest,
  postSessions: RehearsalSessionState[]
): string[] {
  const postById = new Map(postSessions.map((s) => [s.id, s]));
  const disappeared: RehearsalSessionState[] = [];
  const lostInvocations: string[] = [];
  const lostAnalytics: string[] = [];
  for (const before of manifest.sessions) {
    const after = postById.get(before.id);
    if (!after) {
      disappeared.push(before);
      continue;
    }
    if (after.invocationCount < before.invocationCount) {
      lostInvocations.push(
        `${before.id} (${before.invocationCount}→${after.invocationCount})`
      );
    }
    if (after.analyticsCount < before.analyticsCount) {
      lostAnalytics.push(
        `${before.id} (${before.analyticsCount}→${after.analyticsCount})`
      );
    }
  }
  const violations: string[] = [];
  if (disappeared.length > 0) {
    violations.push(
      `${disappeared.length} session(s) present before the rebuild are gone after it: ${idSample(disappeared)}`
    );
  }
  if (lostInvocations.length > 0) {
    violations.push(
      `${lostInvocations.length} session(s) lost component-invocation rows in the rebuild: ${sample(lostInvocations)}`
    );
  }
  if (lostAnalytics.length > 0) {
    violations.push(
      `${lostAnalytics.length} session(s) lost session_analytics rows in the rebuild: ${sample(lostAnalytics)}`
    );
  }
  return violations;
}

const ID_SAMPLE_LIMIT = 10;

function idSample(sessions: RehearsalSessionState[]): string {
  return sample(sessions.map((s) => s.id));
}

function sample(entries: string[]): string {
  const shown = entries.slice(0, ID_SAMPLE_LIMIT).join(", ");
  return entries.length > ID_SAMPLE_LIMIT ? `${shown}, …` : shown;
}
