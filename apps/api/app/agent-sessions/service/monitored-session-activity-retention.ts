import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  type MonitoredActivityRetainedSnapshot,
} from "@repo/api/src/types/artifact-activity";
import {
  MonitoredHoldExpiryCause,
  MonitoredTargetDisposition,
  monitoredActivityTargetKey,
  monitoredActivityTargetUrl,
} from "@repo/api/src/types/monitored-activity-target";
import { v5 as uuidv5 } from "uuid";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import { BIND_PARAMETERS_PER_ACTIVITY_EVENT_ROW } from "@/app/documents/artifact-activity-service";
import { chunksOf } from "@/lib/chunks-of";
import {
  canonicalMonitoredSourceEventId,
  type ResolvedActivityCandidate,
} from "./monitored-session-activity-persistence";
import {
  type RetainedMonitoredActivityRow,
  readRetainedMonitoredActivityRows,
} from "./monitored-session-activity-retained-rows";
import { MONITORED_ACTIVITY_RETAINED_SNAPSHOT_SCHEMA } from "./monitored-session-activity-retained-snapshot";
import {
  type MonitoredActivityCandidate,
  monitoredActivityCandidateIdentity,
} from "./monitored-session-activity-shared";
import {
  effectiveMonitoredTargetDisposition,
  isRetryOwnedMonitoredDisposition,
} from "./monitored-session-transport-resolution";
import type { AgentSessionUpsertTx } from "./records";
import { bindParameterChunkSize } from "./write-chunking";

/**
 * ISS-9182: make a delivery's monitored-activity evidence durable even when no
 * `BranchActivityAtom` can carry it.
 *
 * `ArtifactActivityEvent` is keyed on `artifactId`, and a repository this
 * organization holds no Artifact for has nothing to key onto — which is WHY the
 * evidence used to be counted and then dropped. The row is written against the
 * SESSION artifact, which always exists and is already committed at this point
 * in the sync transaction, so nothing new has to be created for the write to
 * land. Operator ruling, 2026-09-18 (PLN-2061, "Governing rulings"): work done
 * in a repository the organization does not own and never will still counts,
 * and its evidence must land; acknowledge-and-discard is rejected.
 *
 * Retention fires for a candidate this delivery wrote nothing for AND settled.
 * Evidence a later delivery still owns is not lost, so there is nothing to
 * retain: a retained row asserts "no evidence could be written for this", and
 * that claim becomes false the moment a retry materializes the target and lands
 * the atom.
 *
 * A retry is not the only thing that falsifies it. Org state moves too — the
 * App gets installed on the repository, or the PR row arrives from a webhook —
 * and a settled target then resolves with no retry ever having been owed. So
 * {@link retractRetainedMonitoredActivity} removes the rows a later delivery's
 * own atom contradicts. Nothing UPDATES a retained row in place: it is true
 * when filed, and gone once it is not. A ceiling expiry is the one replacement:
 * a row retained earlier for a terminal reason stops being true once the same
 * candidate becomes retry-owned and expires, so it is deleted and re-filed as
 * `HoldExpired` ({@link retainMonitoredActivityEvidence}).
 *
 * Retry-ownership is asked of {@link isRetryOwnedMonitoredDisposition}, which
 * reads the classifier's own exhaustive `Record` — so a disposition invented
 * later fails `tsc` there rather than silently landing on either side of this
 * question. That is what keeps the population this exists for covered as
 * ISS-9181's fetch-authority gate moves an observation-only PR target from
 * held to acknowledged: the delivery that finally settles such a target is the
 * same delivery that retains its evidence.
 */

export type RetainedMonitoredActivityEntry = {
  candidate: MonitoredActivityCandidate;
  disposition: MonitoredTargetDisposition;
  /** Set exactly when `disposition` is `HoldExpired`. */
  holdExpiryCause?: MonitoredHoldExpiryCause;
};

/**
 * Persist one session-attached evidence row per entry and return the candidate
 * identities the store actually holds afterwards.
 *
 * Idempotent by primary key: the row id is derived from the session, the target
 * and the source event, so a redelivery of the same evidence conflicts with the
 * row it already wrote and inserts nothing. A settled candidate is redelivered
 * often, because the acknowledgement is withheld per DELIVERY and not per
 * candidate: one retry-owned sibling re-offers every target on the Session,
 * settled ones included. The measurement is of the holds themselves — 1,782 in
 * the 7 days to 2026-09-18 — and each is a delivery the desktop then re-offered
 * whole. An append-only writer here would accumulate thousands of duplicate
 * rows.
 *
 * The verification read is what makes the caller's guard a check rather than a
 * tautology: it reports what the DATABASE holds, not what this function meant
 * to write, so a row the insert silently dropped is not reported as retained.
 * Same shape as `claimLegacyMonitoredActivityAliases`'s claim verification.
 */
export async function retainMonitoredActivityEvidence(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    sessionArtifactId: string;
    receivedAt: Date;
  },
  entries: readonly RetainedMonitoredActivityEntry[],
  readRetainedRows: RetainedMonitoredActivityRowReader
): Promise<Set<string>> {
  if (entries.length === 0) {
    return new Set();
  }
  await supersedeRowsForCeilingExpiry(tx, input, entries, readRetainedRows);
  const identityByEventId = new Map<string, string>();
  const rows = entries.map(({ candidate, disposition, holdExpiryCause }) => {
    const id = retainedMonitoredActivityEventId(
      input.sessionArtifactId,
      candidate
    );
    identityByEventId.set(id, monitoredActivityCandidateIdentity(candidate));
    return {
      id,
      organizationId: input.organizationId,
      artifactId: input.sessionArtifactId,
      actorType: ArtifactActivityActorType.System,
      actorId: null,
      action: ArtifactActivityAction.MonitoredActivityRetained,
      after: retainedMonitoredActivitySnapshot(
        candidate,
        disposition,
        holdExpiryCause
      ),
      createdAt: input.receivedAt,
    };
  });
  for (const chunk of chunksOf(rows, RETENTION_INSERT_CHUNK_SIZE)) {
    await tx.artifactActivityEvent.createMany({
      data: chunk,
      skipDuplicates: true,
    });
  }
  const retained = new Set<string>();
  for (const chunk of chunksOf(
    [...identityByEventId.keys()],
    RETENTION_ID_LIST_CHUNK_SIZE
  )) {
    const stored = await tx.artifactActivityEvent.findMany({
      where: {
        organizationId: input.organizationId,
        artifactId: input.sessionArtifactId,
        id: { in: chunk },
      },
      select: { id: true },
    });
    for (const row of stored) {
      const identity = identityByEventId.get(row.id);
      if (identity !== undefined) {
        retained.add(identity);
      }
    }
  }
  return retained;
}

/**
 * The candidates whose evidence a delivery actually landed — an atom inserted
 * or replayed now, or one a prior delivery already stored under the legacy
 * identity. A `FutureTimestamp` result is deliberately NOT written: the atom
 * was refused, so that candidate still needs an end state of its own.
 */
export function writtenMonitoredActivityIdentities(input: {
  sessionArtifactId: string;
  resolvedCandidates: readonly ResolvedActivityCandidate[];
  replayedKeys: ReadonlySet<string>;
  pending: readonly ResolvedActivityCandidate[];
  results: readonly { status: BranchActivityPersistStatus }[];
}): Set<string> {
  const written = new Set<string>();
  for (const { candidate } of input.resolvedCandidates) {
    const key = canonicalMonitoredSourceEventId(
      input.sessionArtifactId,
      candidate.target,
      candidate.event
    );
    if (input.replayedKeys.has(key)) {
      written.add(monitoredActivityCandidateIdentity(candidate));
    }
  }
  for (const [index, result] of input.results.entries()) {
    const entry = input.pending[index];
    if (entry === undefined) {
      continue;
    }
    if (
      result.status === BranchActivityPersistStatus.Inserted ||
      result.status === BranchActivityPersistStatus.Replayed
    ) {
      written.add(monitoredActivityCandidateIdentity(entry.candidate));
    }
  }
  return written;
}

/**
 * Split the candidates this delivery wrote nothing for into the evidence it
 * files now and the identities a later delivery still owns.
 *
 * The disposition lookup lives here rather than at the call site because it is
 * what decides the split: retaining is only correct once a candidate is
 * TERMINAL for this delivery, and the same disposition then travels into the
 * snapshot as the label for why nothing could be written.
 */
export function partitionUnwrittenMonitoredActivityCandidates(input: {
  candidates: readonly MonitoredActivityCandidate[];
  writtenIdentities: ReadonlySet<string>;
  quarantinedIdentities: ReadonlySet<string>;
  dispositions: ReadonlyMap<string, MonitoredTargetDisposition>;
  /**
   * ISS-11427: the expired-hold identities the delivery computed ONCE
   * ({@link import("./monitored-activity-hold-ceiling").resolveMonitoredActivityHoldExpiry}),
   * including targets an earlier delivery's ceiling already settled.
   * Passed rather than re-derived: the acknowledgement gate reads the same set,
   * so the two cannot put one candidate on opposite sides of the ceiling and fail
   * {@link assertEveryMonitoredCandidateAccounted}.
   */
  expiredHoldIdentities: ReadonlySet<string>;
  /** The subset of `expiredHoldIdentities` the whole-session escalation swept in. */
  sweptHoldIdentities: ReadonlySet<string>;
}): {
  retainable: RetainedMonitoredActivityEntry[];
  retryOwnedIdentities: Set<string>;
} {
  const retainable: RetainedMonitoredActivityEntry[] = [];
  const retryOwnedIdentities = new Set<string>();
  for (const candidate of input.candidates) {
    const identity = monitoredActivityCandidateIdentity(candidate);
    if (
      input.writtenIdentities.has(identity) ||
      input.quarantinedIdentities.has(identity)
    ) {
      continue;
    }
    // ISS-11427: the EFFECTIVE disposition, so a hold past its ceiling becomes
    // terminal for this delivery and its evidence is filed here instead of being
    // left owed to a delivery the desktop has stopped making. Same helper the
    // acknowledgement gate calls, so the two cannot split one candidate.
    const disposition = effectiveMonitoredTargetDisposition({
      disposition: input.dispositions.get(
        monitoredActivityTargetKey(candidate.target)
      ),
      holdExpired: input.expiredHoldIdentities.has(identity),
    });
    // The `undefined` clause narrows the entry; it does not answer the
    // retry-ownership question a second time. `isRetryOwnedMonitoredDisposition`
    // owns that answer and gives the same one for an unclassified target.
    if (
      disposition === undefined ||
      isRetryOwnedMonitoredDisposition(disposition)
    ) {
      retryOwnedIdentities.add(identity);
      continue;
    }
    if (disposition === MonitoredTargetDisposition.HoldExpired) {
      retainable.push({
        candidate,
        disposition,
        holdExpiryCause: input.sweptHoldIdentities.has(identity)
          ? MonitoredHoldExpiryCause.Escalation
          : MonitoredHoldExpiryCause.OwnAge,
      });
      continue;
    }
    retainable.push({ candidate, disposition });
  }
  return { retainable, retryOwnedIdentities };
}

/**
 * PLN-2061 M2's invariant: no delivery discards monitored-activity evidence
 * silently. Every candidate leaves the pipeline written, retained, quarantined
 * or still owed to a later delivery, and one in none of those states fails the
 * delivery rather than vanishing from it.
 *
 * Retry-owned counts as accounted because the Session's acknowledgement is
 * withheld for exactly those candidates: the desktop re-offers them and the
 * next delivery settles them. Nothing is lost, so nothing is filed.
 *
 * Throwing rolls the sync transaction back, which is the same response the
 * sibling accounting failure in `persistMonitoredSessionActivity` already
 * gives an atom that came back neither inserted nor replayed. A candidate can
 * only reach here unaccounted through a bug in this module's own bookkeeping,
 * so a silent degrade would hide exactly the defect the guard exists for.
 */
export function assertEveryMonitoredCandidateAccounted(input: {
  candidates: readonly MonitoredActivityCandidate[];
  writtenIdentities: ReadonlySet<string>;
  quarantinedIdentities: ReadonlySet<string>;
  retainedIdentities: ReadonlySet<string>;
  retryOwnedIdentities: ReadonlySet<string>;
}): void {
  for (const candidate of input.candidates) {
    const identity = monitoredActivityCandidateIdentity(candidate);
    if (
      input.writtenIdentities.has(identity) ||
      input.quarantinedIdentities.has(identity) ||
      input.retainedIdentities.has(identity) ||
      input.retryOwnedIdentities.has(identity)
    ) {
      continue;
    }
    throw new Error(
      `monitored session activity dropped for ${monitoredActivityTargetKey(candidate.target)}`
    );
  }
}

/**
 * The row id one retained candidate always gets, so a redelivery collides with
 * itself instead of appending. Namespace-based (RFC 9562 v5) rather than a bare
 * hash, because the column is a real `uuid`.
 */
export function retainedMonitoredActivityEventId(
  sessionArtifactId: string,
  candidate: MonitoredActivityCandidate
): string {
  return uuidv5(
    [
      sessionArtifactId,
      monitoredActivityTargetKey(candidate.target),
      candidate.event.sourceEventId,
    ].join("\u0000"),
    RETAINED_MONITORED_ACTIVITY_NAMESPACE
  );
}

export function retainedMonitoredActivitySnapshot(
  candidate: MonitoredActivityCandidate,
  disposition: MonitoredTargetDisposition,
  holdExpiryCause?: MonitoredHoldExpiryCause
): MonitoredActivityRetainedSnapshot {
  const { target, event } = candidate;
  const url = monitoredActivityTargetUrl(target);
  return {
    ...target,
    ...(url === undefined ? {} : { url }),
    eventKind: event.kind,
    occurredAt: event.occurredAt,
    completeness: event.completeness,
    disposition,
    ...(holdExpiryCause === undefined ? {} : { holdExpiryCause }),
  };
}

/**
 * Retract the retained rows this delivery's own writes just falsified.
 *
 * A retained row asserts that no evidence could be written for its target, and
 * two ordinary changes in ORG state make that false with no retry involved: the
 * organization installs the App on a repository a target was retained under
 * `RepositoryOutOfScope` for, or the `PullRequestDetail` row a prose-mention PR
 * was retained `IntentionallyAbsent` for lands from a webhook in between. The
 * next delivery then resolves the target and writes the atom, and the session
 * would otherwise carry BOTH that atom and a row denying it — the same work
 * counted twice by whatever reads these rows.
 *
 * Scoped to the targets this delivery wrote, and run in the transaction that
 * wrote them, so the atom and the retraction commit together or not at all.
 * Matched by TARGET rather than by row id: the id also keys on the source
 * event, because a target with several carrier events keeps a row per event,
 * and every one of them is falsified by the same atom. Hence the read back —
 * this delivery's targets only, through the shared reader, and only on a
 * delivery that wrote something.
 */
export async function retractRetainedMonitoredActivity(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; sessionArtifactId: string },
  written: {
    candidates: readonly MonitoredActivityCandidate[];
    writtenIdentities: ReadonlySet<string>;
  },
  readRetainedRows: RetainedMonitoredActivityRowReader
): Promise<void> {
  const writtenTargetKeys = new Set(
    written.candidates
      .filter((candidate) =>
        written.writtenIdentities.has(
          monitoredActivityCandidateIdentity(candidate)
        )
      )
      .map((candidate) => monitoredActivityTargetKey(candidate.target))
  );
  if (writtenTargetKeys.size === 0) {
    return;
  }
  const rows = await readRetainedRows();
  const falsified = rows.flatMap((row) => {
    const target = parseRetainedSnapshot(row.after);
    return target !== undefined &&
      writtenTargetKeys.has(monitoredActivityTargetKey(target))
      ? [row.id]
      : [];
  });
  for (const chunk of chunksOf(falsified, RETENTION_ID_LIST_CHUNK_SIZE)) {
    await tx.artifactActivityEvent.deleteMany({
      where: {
        organizationId: input.organizationId,
        artifactId: input.sessionArtifactId,
        id: { in: chunk },
      },
    });
  }
}

/**
 * Fixed namespace for retained monitored-activity row ids (a constant, not
 * generated). Changing it re-keys every row, so a redelivery would stop
 * colliding with what it already wrote — it must stay stable.
 */
const RETAINED_MONITORED_ACTIVITY_NAMESPACE =
  "9f3c6b8e-2d41-4a77-9c15-6b0d2f8a5e31";

/**
 * Sized off the store's own per-row bind cost rather than a second count of the
 * same model: this writer and `recordActivityEvents` insert the identical table
 * through the identical `createMany`, so a column added to
 * `ArtifactActivityEvent` must move both chunk sizes or neither.
 */
const RETENTION_INSERT_CHUNK_SIZE = bindParameterChunkSize(
  BIND_PARAMETERS_PER_ACTIVITY_EVENT_ROW,
  0
);
/** `in` list width: one bind per id beside the fixed org and artifact binds. */
const RETENTION_ID_LIST_CHUNK_SIZE = bindParameterChunkSize(1, 2);

/**
 * The targets this session's hold ceiling has already given up on: those with a
 * retained row whose disposition is `HoldExpired`. Read by TARGET, not by
 * candidate, because a live session keeps adding new mentions of a target
 * nothing will materialize, and whether the expired mention itself is re-sent
 * is the desktop's business.
 *
 * Only `HoldExpired` rows from an OWN-AGE expiry count (#8737, operator ruling
 * 2026-10-12): a candidate the whole-session escalation swept in never ran its
 * own hold, so its target gets a fresh one. A row with no `holdExpiryCause`
 * predates the field and reads as own-age. A row retained under a terminal disposition
 * (`RepositoryOutOfScope` and the like) says nothing about a later delivery in
 * which the same target has become retry-owned again, e.g. after the App is
 * installed, and that delivery still gets its hold.
 *
 * A settled target stays settled until its atom lands, which retracts the row
 * ({@link retractRetainedMonitoredActivity}). Monitor 315255487, 2026-10-12:
 * without this, the re-offered target opened a fresh thirty-minute hold on
 * every cycle, and a live session was acknowledged once per half hour and
 * dead-lettered on the desktop in between.
 */
export async function findCeilingSettledMonitoredTargetKeys(
  readRetainedRows: RetainedMonitoredActivityRowReader
): Promise<Set<string>> {
  const settled = new Set<string>();
  for (const row of await readRetainedRows()) {
    const snapshot = parseRetainedSnapshot(row.after);
    if (snapshot !== undefined && settlesTarget(snapshot)) {
      settled.add(monitoredActivityTargetKey(snapshot));
    }
  }
  return settled;
}

/**
 * The retained rows of the targets THIS delivery carries, read at most once
 * per delivery and shared by {@link findCeilingSettledMonitoredTargetKeys},
 * {@link retractRetainedMonitoredActivity} and
 * {@link retainMonitoredActivityEvidence} (apps/api AGENTS.md, "Read a scope
 * ONCE per request").
 *
 * Every consumer asks only about this delivery's candidates: the ceiling about
 * the held ones' targets, the retraction about the targets it wrote, and the
 * supersede about the ids its expiries would file — and a retained row's id is
 * derived from its candidate's target. So rows of any other target cannot
 * change an answer, and are not read: the session's whole retained history grew
 * with every retained event, and reading it on every held delivery, inside the
 * sync transaction, was the cost the #8737 follow-up removed. The read is
 * index-backed (`readRetainedMonitoredActivityRows`). Nothing inserts a
 * retained row between the first read and the last consumer; the retraction's
 * deletes only shrink it.
 */
export type RetainedMonitoredActivityRowReader = () => Promise<
  readonly RetainedMonitoredActivityRow[]
>;

export function createRetainedMonitoredActivityRowReader(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; sessionArtifactId: string },
  candidates: readonly MonitoredActivityCandidate[]
): RetainedMonitoredActivityRowReader {
  let rows: Promise<readonly RetainedMonitoredActivityRow[]> | undefined;
  return () => {
    rows ??= readRetainedMonitoredActivityRows(tx, {
      organizationId: input.organizationId,
      sessionArtifactId: input.sessionArtifactId,
      targets: candidates.map((candidate) => candidate.target),
      rowIds: candidates.map((candidate) =>
        retainedMonitoredActivityEventId(input.sessionArtifactId, candidate)
      ),
    });
    return rows;
  };
}

/**
 * A `HoldExpired` entry whose row id already holds a row retained for another
 * reason, or an own-age expiry over an escalation-swept row of the same
 * candidate, would be skipped by `skipDuplicates`, leaving the old reason in place;
 * {@link findCeilingSettledMonitoredTargetKeys} would then not see the target
 * as settled and the next re-send would open a fresh hold. Delete those rows
 * first so the insert files the expiry.
 */
async function supersedeRowsForCeilingExpiry(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; sessionArtifactId: string },
  entries: readonly RetainedMonitoredActivityEntry[],
  readRetainedRows: RetainedMonitoredActivityRowReader
): Promise<void> {
  const expiryById = new Map(
    entries
      .filter(
        ({ disposition }) =>
          disposition === MonitoredTargetDisposition.HoldExpired
      )
      .map((entry) => [
        retainedMonitoredActivityEventId(
          input.sessionArtifactId,
          entry.candidate
        ),
        entry,
      ])
  );
  if (expiryById.size === 0) {
    return;
  }
  const superseded = (await readRetainedRows()).flatMap((row) => {
    const entry = expiryById.get(row.id);
    if (entry === undefined) {
      return [];
    }
    const stored = parseRetainedSnapshot(row.after);
    return stored === undefined || isSupersededByExpiry(stored, entry)
      ? [row.id]
      : [];
  });
  for (const chunk of chunksOf(superseded, RETENTION_ID_LIST_CHUNK_SIZE)) {
    await tx.artifactActivityEvent.deleteMany({
      where: {
        organizationId: input.organizationId,
        artifactId: input.sessionArtifactId,
        id: { in: chunk },
      },
    });
  }
}

/**
 * The snapshot a stored retained row holds, or ABSENT when the payload is not
 * one this writer produced. `after` is a freeform JSON column, so what comes
 * back is parsed rather than trusted to still match the type that wrote it.
 */
function parseRetainedSnapshot(after: unknown) {
  const parsed = MONITORED_ACTIVITY_RETAINED_SNAPSHOT_SCHEMA.safeParse(after);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a stored row settles its target (own-age `HoldExpired`, legacy included). */
function settlesTarget(
  snapshot: Pick<
    MonitoredActivityRetainedSnapshot,
    "disposition" | "holdExpiryCause"
  >
): boolean {
  return (
    snapshot.disposition === MonitoredTargetDisposition.HoldExpired &&
    snapshot.holdExpiryCause !== MonitoredHoldExpiryCause.Escalation
  );
}

/**
 * A new expiry replaces a stored row unless the row already settles the target
 * or already records the same escalation sweep. Never the reverse: an
 * escalation sweep does not downgrade an own-age row.
 */
function isSupersededByExpiry(
  stored: Pick<
    MonitoredActivityRetainedSnapshot,
    "disposition" | "holdExpiryCause"
  >,
  entry: RetainedMonitoredActivityEntry
): boolean {
  if (settlesTarget(stored)) {
    return false;
  }
  return (
    stored.disposition !== MonitoredTargetDisposition.HoldExpired ||
    entry.holdExpiryCause !== MonitoredHoldExpiryCause.Escalation
  );
}
