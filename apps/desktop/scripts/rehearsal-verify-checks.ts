/**
 * @file rehearsal-verify-checks.ts
 * @description ISS-5104 (widened by ISS-5466 and ISS-9284) — pure decision logic for Phase B
 * of the DATA_REVISION rebuild rehearsal (`rehearsal-verify.ts`): manifest
 * validation and the violation checks over the post-rebuild store state. Kept
 * free of DB/collector imports so `test/rehearsal-verify-checks.test.ts` can
 * cover every branch without a store.
 *
 * The manifest is written by `rehearsal-build-store.ts` running in the
 * merge-base worktree, so the schema is tolerant of what it cannot predict —
 * unknown extra fields pass through, and only the fields the checks consume are
 * validated. It is NOT tolerant of a field going missing: the workflow copies
 * the PR's own builder in before running it, so every field this file requires
 * is written by code that knows about it, and an absent one means the wiring
 * broke rather than that a producer is old.
 *
 * ISS-9284: this module is the READ side of the per-view manifest, and it is
 * where the tie to the canonical {@link ProjectionTarget} lives. The builder
 * cannot import that module (it runs in a merge-base worktree that may predate
 * it), so the guard is here: the count schema is a keys-covered `Record` over
 * every target, and every check iterates the target list rather than naming two
 * hand-picked counters.
 */
import { z } from "zod";
import { ProjectionTarget } from "../src/main/database/derived-projection-revision.js";
import type { SessionIdentity } from "../src/main/database/session-owner-identity.js";

/**
 * ISS-9284: the per-view count shape, built from the canonical
 * {@link ProjectionTarget} under a COMPILE-TIME KEYS-COVERED GUARD.
 *
 * The `Record<ProjectionTarget, …>` annotation is the load-bearing part: a
 * fifth view added to `derived-projection-revision.ts` makes this object an
 * incomplete Record and fails `tsc`, so a view cannot be declared destroyable
 * and then silently go unwatched by the rehearsal — which is the whole ISS-9284
 * defect, one level up. `rehearsal-build-store.ts` re-declares the same value
 * list locally (it is copied into a merge-base worktree and cannot import this
 * module's dependency); this guard is what keeps that copy honest.
 */
const projectionCountShape: Record<ProjectionTarget, z.ZodNumber> = {
  [ProjectionTarget.Sessions]: z.number(),
  [ProjectionTarget.Branches]: z.number(),
  [ProjectionTarget.Owner]: z.number(),
  [ProjectionTarget.Aggregate]: z.number(),
};

const rehearsalProjectionCountsSchema = z.object(projectionCountShape);

/**
 * Every view, in a fixed order so a multi-view failure reads the same way twice.
 * `Object.values` over a const object preserves declaration order.
 */
const PROJECTION_TARGETS: readonly ProjectionTarget[] =
  Object.values(ProjectionTarget);

/**
 * What each view's count is made of, for a message that tells a reader WHICH
 * rows went missing rather than reporting an anonymous number. Same
 * keys-covered guard as the schema above.
 */
const PROJECTION_ROW_LABEL: Record<ProjectionTarget, string> = {
  [ProjectionTarget.Sessions]: "component-invocation row(s)",
  [ProjectionTarget.Branches]: "branch-attribution link(s)",
  [ProjectionTarget.Owner]: "owner identity column(s)",
  [ProjectionTarget.Aggregate]: "session_analytics row(s)",
};

const rehearsalSessionStateSchema = z.object({
  id: z.string(),
  dataRevision: z.number(),
  /**
   * ISS-9284: REQUIRED, and required to carry every view. The predecessor was a
   * flat `invocationCount`/`analyticsCount` pair, which could not represent a
   * record valid for Sessions and broken for Branches — the two views it did
   * not measure at all. Optionality here would restore exactly that: a Phase A
   * that stopped snapshotting a view would hand Phase B a manifest it happily
   * accepted and could never fail on that view. The workflow copies the PR's own
   * builder into the merge-base worktree, so the field is always written by code
   * that knows about it.
   */
  projections: rehearsalProjectionCountsSchema,
  /**
   * PR #6728 review (whitlockk): REQUIRED, and the reason is that
   * `projections.owner` is a COUNT of non-null identity columns and a count
   * cannot see a SUBSTITUTION. An importer regression that replaced both ids
   * with a different non-null pair still read as 2, so the rehearsal stayed
   * green while Owner pointed at someone else — a loss detector staying green
   * through the loss it exists to catch. Optional here would restore exactly
   * that: a Phase A that stopped recording the pair would hand Phase B a
   * manifest it accepted and could never fail a reattribution on.
   *
   * Annotated `Record<keyof SessionIdentity, …>` so the canonical identity
   * shape gaining a third column fails `tsc` here rather than silently leaving
   * that column unwatched — the same keys-covered guard the count shape uses.
   */
  ownerIdentity: z.object({
    userId: z.string().nullable(),
    organizationId: z.string().nullable(),
  } satisfies Record<keyof SessionIdentity, z.ZodTypeAny>),
});

export const rehearsalManifestSchema = z.object({
  rehearsalManifestVersion: z.number(),
  sessions: z.array(rehearsalSessionStateSchema).min(1),
  /**
   * ISS-5466: the missing-source sessions Phase A synthesized. REQUIRED and
   * non-empty on purpose. The lane's Phase A step always copies the PR's own
   * `rehearsal-build-store.ts` into the merge-base worktree, so the field is
   * always written by code that knows about it — and making it optional would
   * mean a Phase A that silently stopped injecting produced a manifest Phase B
   * happily accepted, restoring the exact false-completeness this ticket closes.
   *
   * The custom message is load-bearing: the only human who can hit this is an
   * operator pointing `--store` at a directory a pre-ISS-5466 Phase A produced,
   * and a bare ZodError tells them nothing about how to recover.
   */
  missingSourceFixtureIds: z
    .array(z.string())
    .min(
      1,
      "manifest has no missingSourceFixtureIds — it predates ISS-5466 or Phase A stopped injecting the fixture; rebuild the store with the current rehearsal-build-store.ts"
    ),
});

export type RehearsalManifest = z.infer<typeof rehearsalManifestSchema>;

export type RehearsalSessionState = z.infer<typeof rehearsalSessionStateSchema>;

export type RehearsalRebuildOutcome = {
  errors: number;
  parseErrors: number;
  /**
   * Sessions whose SOURCE transcript the rebuild could not find. Every
   * golden-corpus session's source is present by construction, so the only
   * sessions that may land here are the ones Phase A synthesized on purpose
   * (`manifest.missingSourceFixtureIds`) — hence the check is EQUALITY, not a
   * ceiling: too many means a source-mapping regression silently took the
   * stored-row fallback and stamped a corpus session anyway, and too few means
   * the fixture never reached the bridge and the lane proved nothing.
   */
  missingSource: number;
  /**
   * Sources the rebuild parsed but could not match back to a stale session.
   * Nothing legitimately produces these here, fixtures included: a fixture has
   * no source at all.
   */
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
  const expectedMissingSource = manifest.missingSourceFixtureIds.length;
  if (outcome.missingSource !== expectedMissingSource) {
    violations.push(
      `missing-source population is not the one Phase A staged: missingSource=${outcome.missingSource}, expected exactly ${expectedMissingSource} (the injected fixture(s); every golden-corpus session's source is present by construction)`
    );
  }
  if (outcome.unmatchedSource > 0) {
    violations.push(
      `rebuild could not match sources it must find in the frozen corpus: unmatchedSource=${outcome.unmatchedSource}`
    );
  }
  violations.push(
    ...manifestSanityViolations(manifest),
    ...storedRowBridgeViolations(manifest, postSessions)
  );
  if (postSessions.length === 0) {
    violations.push("post-rebuild store contains zero sessions");
  }
  violations.push(
    ...revisionViolations(
      postSessions,
      currentRevision,
      options.importPendingSentinel
    ),
    ...projectionLossViolations(manifest, postSessions),
    ...ownerReattributionViolations(manifest, postSessions)
  );
  return violations;
}

/**
 * The manifest must prove the pre-state was non-vacuous, PER VIEW: a store where
 * no session has any rows for one view makes THAT view's loss check pass
 * trivially, whatever the other three hold.
 *
 * ISS-9284 made this per-view for the reason the ticket exists. A single
 * whole-manifest vacuity check is satisfied by one populated view, so Branches
 * and Owner could have been empty in every run — and were: measured on the
 * frozen corpus, 0 of 35 sessions carried an owner identity until Phase A began
 * claiming one.
 */
function manifestSanityViolations(manifest: RehearsalManifest): string[] {
  const violations: string[] = [];
  for (const target of PROJECTION_TARGETS) {
    if (manifest.sessions.some((s) => s.projections[target] > 0)) {
      continue;
    }
    violations.push(
      `manifest sanity: no pre-rebuild session has a ${PROJECTION_ROW_LABEL[target]} — the "${target}" projection-loss check would be vacuous`
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
 * A session that had rows for a view before the rebuild must still have AT
 * LEAST AS MANY after — a shrunken count is partial loss and fails just like
 * total loss.
 *
 * ISS-9284: CLASSIFIED INDEPENDENTLY PER VIEW. One violation is emitted per
 * view, and each names the views the same session came through intact, so a
 * record valid for Sessions and broken for Branches is reported as exactly
 * that. The predecessor collapsed the whole record into a per-session pair over
 * two of the four views, which made a record broken for Branches or Owner
 * indistinguishable from a wholly valid one — one view fabricating validity for
 * another.
 *
 * A session that vanishes entirely is a violation too, and stays a SINGLE
 * violation rather than one per view: it is not a per-view verdict, it is the
 * absence of a record for all of them at once. Tolerating it would outsource the
 * verdict to `isBurstArtifactSource`, which is part of the code under test: a
 * regression there could delete real sessions carrying projections and still
 * pass. Every golden-corpus session's source survives the rebuild by
 * construction, so the honest expectation is that none disappear — and if a
 * deliberate change ever makes one disappear, this fails loudly and the corpus
 * oracle gets updated on purpose.
 */
function projectionLossViolations(
  manifest: RehearsalManifest,
  postSessions: RehearsalSessionState[]
): string[] {
  const postById = new Map(postSessions.map((s) => [s.id, s]));
  const disappeared: RehearsalSessionState[] = [];
  const lostByTarget = new Map<ProjectionTarget, string[]>();
  for (const before of manifest.sessions) {
    const after = postById.get(before.id);
    if (!after) {
      disappeared.push(before);
      continue;
    }
    const lost = PROJECTION_TARGETS.filter(
      (target) => after.projections[target] < before.projections[target]
    );
    const intact = PROJECTION_TARGETS.filter((t) => !lost.includes(t));
    for (const target of lost) {
      const entries = lostByTarget.get(target) ?? [];
      entries.push(
        `${before.id} (${before.projections[target]}→${after.projections[target]}; intact for ${intact.join(", ")})`
      );
      lostByTarget.set(target, entries);
    }
  }
  const violations: string[] = [];
  if (disappeared.length > 0) {
    violations.push(
      `${disappeared.length} session(s) present before the rebuild are gone after it: ${idSample(disappeared)}`
    );
  }
  for (const target of PROJECTION_TARGETS) {
    const entries = lostByTarget.get(target);
    if (entries) {
      violations.push(
        `projection loss in view "${target}": ${entries.length} session(s) lost ${PROJECTION_ROW_LABEL[target]} in the rebuild: ${sample(entries)}`
      );
    }
  }
  return violations;
}

/**
 * ISS-5466: the POSITIVE CONTROL for the stored-row invocation bridge.
 *
 * Every other check here is satisfiable by a run that exits before the repair
 * tail — a rebuild that touched nothing leaves no failures, no stale revisions
 * and no lost projections, and reads as green. These assert the stored-row path
 * was actually ENTERED for each Phase A fixture: it starts with zero
 * `agent_component_invocations` rows and no transcript to re-parse, so the only
 * code that can give it rows builds candidates from `storedEventCandidates` and
 * commits them through `insertInvocationRows` — the ISS-5098 path. A run where
 * the FK guard is missing fails that insert and the count stays at zero.
 *
 * Both stored-row entry points are in scope, deliberately. The repair tail's
 * `rebuildComponentInvocationsFromStoredRows` is the one ISS-5466 set out to
 * reach, but the rollup recompute that runs FIRST in the same tail reaches
 * `ensureStoredAgentComponentInvocations`, which builds from the same
 * FK-less `events.agent_id`. When the guard was reverted to prove this check
 * bites, that sibling is where the FK actually fired — so the message names
 * both rather than sending a reader to only one of them.
 *
 * The zero-before assertion is not redundant with the gain: a fixture that
 * arrived already carrying rows would make "has rows after" true without either
 * path doing anything. `agentReferenceViolations` covers the other way this
 * control could decay — see there.
 */
function storedRowBridgeViolations(
  manifest: RehearsalManifest,
  postSessions: RehearsalSessionState[]
): string[] {
  const preById = new Map(manifest.sessions.map((s) => [s.id, s]));
  const postById = new Map(postSessions.map((s) => [s.id, s]));
  const violations: string[] = [];
  for (const id of manifest.missingSourceFixtureIds) {
    const before = preById.get(id);
    if (!before) {
      violations.push(
        `missing-source fixture ${id} is absent from the manifest's own pre-state — Phase A did not snapshot what it injected`
      );
      continue;
    }
    const invocationsBefore = before.projections[ProjectionTarget.Sessions];
    if (invocationsBefore !== 0) {
      violations.push(
        `missing-source fixture ${id} already had ${invocationsBefore} component-invocation row(s) before the rebuild — the stored-row bridge check would be vacuous`
      );
    }
    const after = postById.get(id);
    if (!after) {
      violations.push(
        `missing-source fixture ${id} is gone after the rebuild — the stored-row bridge must preserve a session it cannot re-parse`
      );
      continue;
    }
    if (after.projections[ProjectionTarget.Sessions] === 0) {
      violations.push(
        `missing-source fixture ${id} gained no component-invocation rows: neither stored-row path (rebuildComponentInvocationsFromStoredRows, ensureStoredAgentComponentInvocations → storedEventCandidates → insertInvocationRows) ran or committed — the ISS-5098 shape`
      );
    }
  }
  return violations;
}

/**
 * ISS-5466: what each fixture's surviving agent references must look like.
 * Shape mirrors `collectFixtureAgentReferences` in `rehearsal-build-store.ts`;
 * declared structurally so this module stays free of that import.
 */
export type FixtureAgentReferences = {
  id: string;
  invocationsWithNullAgent: number;
  invocationsWithAgent: number;
};

/**
 * ISS-5466: the check that keeps the positive control from decaying into a
 * tautology.
 *
 * `storedRowBridgeViolations` proves rows landed. It does NOT prove the
 * ISS-5098 guard is what let them land — a future change that stopped copying
 * `events.agent_id` into the invocation candidate would remove the FK hazard
 * altogether, and "the fixture gained rows" would stay true while proving
 * nothing about `nullUnresolvableAgentReferences`. Phase A therefore gives each
 * fixture TWO tool events, one naming an unbacked agent id and one naming a real
 * `agents` row, and both outcomes are required:
 *
 *  - at least one invocation with a NULL `agent_id` — the guard dropped the
 *    unresolvable reference instead of failing the whole insert on the FK;
 *  - at least one invocation WITH an `agent_id` — resolvable references are
 *    still being copied, so the null above is the guard's doing and not a
 *    builder that stopped populating the column.
 */
export function agentReferenceViolations(
  refs: readonly FixtureAgentReferences[]
): string[] {
  const violations: string[] = [];
  for (const ref of refs) {
    if (ref.invocationsWithNullAgent === 0) {
      violations.push(
        `missing-source fixture ${ref.id} has no invocation row with a NULL agent_id — the unresolvable ${"`events.agent_id`"} was never dropped, so the ISS-5098 guard did not run on it`
      );
    }
    if (ref.invocationsWithAgent === 0) {
      violations.push(
        `missing-source fixture ${ref.id} has no invocation row carrying an agent_id — resolvable agent references are no longer copied from stored events, so the nulled-reference check above can no longer prove the ISS-5098 guard fired`
      );
    }
  }
  return violations;
}

/** The identity columns, so the check and its message cannot name a different set. */
const OWNER_IDENTITY_FIELDS: readonly (keyof SessionIdentity)[] = [
  "userId",
  "organizationId",
];

/**
 * PR #6728 review (whitlockk): the REATTRIBUTION arm of the Owner projection.
 *
 * `projectionLossViolations` compares `projections.owner`, a count of non-null
 * identity columns, so it catches BLANKING (2→1, 2→0) and nothing else. Two
 * WRONG ids count exactly as two right ones, so an importer regression that
 * replaced the pair with a different non-null pair left the rehearsal green
 * while every owner facet pointed at someone else — the same false-green shape
 * as a loss detector that cannot fail for the loss it exists to catch.
 *
 * Only a non-null→DIFFERENT-non-null transition is reported here, deliberately.
 * A blanked column is already one violation from the count arm, and emitting a
 * second for the same fact would make one regression read as two. A null→
 * non-null transition is a gain, not a loss: nothing in the rebuild should
 * invent an owner, but if something does it costs the reader nothing and the
 * count arm is the wrong place to relitigate it either.
 *
 * Per FIELD, not per pair, so a run that reattributed only the organization
 * names the column that moved instead of an anonymous "owner changed".
 */
function ownerReattributionViolations(
  manifest: RehearsalManifest,
  postSessions: RehearsalSessionState[]
): string[] {
  const postById = new Map(postSessions.map((s) => [s.id, s]));
  const reattributed: string[] = [];
  for (const before of manifest.sessions) {
    const after = postById.get(before.id);
    if (!after) {
      // Already reported, once, by `projectionLossViolations`.
      continue;
    }
    for (const field of OWNER_IDENTITY_FIELDS) {
      const wasValue = before.ownerIdentity[field];
      const nowValue = after.ownerIdentity[field];
      if (wasValue !== null && nowValue !== null && wasValue !== nowValue) {
        reattributed.push(`${before.id} (${field}: ${wasValue}→${nowValue})`);
      }
    }
  }
  if (reattributed.length === 0) {
    return [];
  }
  return [
    `owner reattribution: ${reattributed.length} identity column(s) were rewritten to a DIFFERENT non-null value by the rebuild — the Owner projection survived the count check but points at someone else: ${sample(reattributed)}`,
  ];
}

const ID_SAMPLE_LIMIT = 10;

function idSample(sessions: RehearsalSessionState[]): string {
  return sample(sessions.map((s) => s.id));
}

function sample(entries: string[]): string {
  const shown = entries.slice(0, ID_SAMPLE_LIMIT).join(", ");
  return entries.length > ID_SAMPLE_LIMIT ? `${shown}, …` : shown;
}
