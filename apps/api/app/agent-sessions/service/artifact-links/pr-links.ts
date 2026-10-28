import { LinkType } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { JsonObject } from "@repo/api/src/types/common";
import type { PersistedSessionPrRef } from "@repo/api/src/types/session-artifact-link";
import {
  isProseDerivedSessionPrRef,
  SessionArtifactLinkKind,
  sessionPrIdentityKey,
  sessionPrRefsFromMetadata,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma } from "@repo/database";
import { parseJsonObject } from "@/lib/json-schema";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";
import { acquireSessionArtifactLinksAdvisoryLock } from "../advisory-locks";
import type { AgentSessionUpsertTx } from "../records";
import { deleteBranchMaterializationRetryForMaterializedAggregateTx } from "./branch-materialization-retry";
import { pruneStalePullRequestHeadBranchRetriesTx } from "./branch-materialization-retry-pruning";
import {
  type BranchRefAggregate,
  mergeBranchRefAggregates,
} from "./branch-ref-aggregate";
import type { SessionPrRefWithMethod } from "./prose-pr-refs";
import {
  type SessionPullRequestDetailMap,
  sessionPullRequestDetailKey,
} from "./pull-request-details";
import {
  buildSessionBranchLinkWriteData,
  collectSessionArtifactLinkKinds,
  type ExistingSessionBranchLinkState,
  prLinkKind,
  SessionBranchLinkEvidenceSource,
  topLevelLinkKind,
  withoutSessionBranchProjectionFields,
  withoutSessionPrIdentityFields,
} from "./session-branch-link-writer";
import {
  foldBranchAssociationIntoBranchRef,
  foldStoredLinkIntoBranchRef,
  type PrRefByBranch,
  type PrRefByIdentity,
  persistedPrRefs,
  SessionPrLinkWriteMode,
} from "./session-pr-link-merge";
import { SESSION_PR_LINK_SOURCE } from "./session-pr-link-source";
import { acquireSessionPullRequestProviderLocks } from "./session-pull-request-provider-locks";
import {
  mergeBranchLifecycleEvents,
  readBranchLifecycleEventsFromMetadata,
  storeUnresolvedRefs,
} from "./shared";

export type UnresolvedPrRef = {
  repositoryFullName: string;
  prNumber: number;
  cause?: string;
};

function aggregatePrRefsByBranch(
  prRefs: SessionPrRefWithMethod[],
  prDetailsByIdentity: SessionPullRequestDetailMap
): {
  byBranch: Map<string, PrRefByBranch>;
  unresolved: SessionPrRefWithMethod[];
} {
  const byBranch = new Map<string, PrRefByBranch>();
  const unresolved: SessionPrRefWithMethod[] = [];

  for (const prRef of prRefs) {
    const resolution = prDetailsByIdentity.get(
      sessionPullRequestDetailKey(prRef.repositoryFullName, prRef.prNumber)
    );

    if (!resolution) {
      unresolved.push(prRef);
      continue;
    }

    const existing = byBranch.get(resolution.branchArtifactId);
    if (existing) {
      existing.relationTypes.add(prRef.relationType);
      mergeIdentityInto(existing.refs, prRef);
      existing.branchLifecycleEvents = mergeBranchLifecycleEvents(
        existing.branchLifecycleEvents,
        prRef.branchLifecycleEvents
      );
      mergeBranchAssociationInto(existing, resolution.branchAssociation);
      continue;
    }
    const refs = new Map<string, PrRefByIdentity>();
    mergeIdentityInto(refs, prRef);
    byBranch.set(resolution.branchArtifactId, {
      relationTypes: new Set([prRef.relationType]),
      refs,
      branchLifecycleEvents: prRef.branchLifecycleEvents ?? [],
      ...(resolution.branchAssociation
        ? { branchAssociation: resolution.branchAssociation }
        : {}),
    });
  }

  return { byBranch, unresolved };
}

function mergeBranchAssociationInto(
  existing: PrRefByBranch,
  incoming: BranchRefAggregate | undefined
): void {
  if (!incoming) {
    return;
  }
  existing.branchAssociation = existing.branchAssociation
    ? mergeBranchRefAggregates(existing.branchAssociation, incoming)
    : incoming;
}

/**
 * Fold one incoming ref into a branch's per-identity map.
 *
 * ISS-5823: strong evidence wins the `method` marker. Once any command-derived
 * ref claims an identity, a later prose ref for the same PR must not re-mark it
 * as weak — otherwise the metric readers' per-ref filter would drop a PR the
 * session genuinely pushed, just because it also talked about it.
 */
function mergeIdentityInto(
  refs: Map<string, PrRefByIdentity>,
  prRef: SessionPrRefWithMethod
): void {
  const identity = sessionPrIdentityKey(
    prRef.repositoryFullName,
    prRef.prNumber
  );
  const existingRef = refs.get(identity);
  if (!existingRef) {
    refs.set(identity, {
      relationTypes: new Set([prRef.relationType]),
      repositoryFullName: prRef.repositoryFullName,
      prNumber: prRef.prNumber,
      ...(prRef.method ? { method: prRef.method } : {}),
    });
    return;
  }
  existingRef.relationTypes.add(prRef.relationType);
  if (!prRef.method) {
    Reflect.deleteProperty(existingRef, "method");
  }
}

function storeUnresolvedPrRefs(
  tx: AgentSessionUpsertTx,
  sessionArtifactId: string,
  unresolvedPrRefs: UnresolvedPrRef[]
): Promise<void> {
  return storeUnresolvedRefs<UnresolvedPrRef>(
    tx,
    sessionArtifactId,
    "_unresolvedPrRefs",
    (value): value is UnresolvedPrRef =>
      value != null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).repositoryFullName ===
        "string" &&
      typeof (value as Record<string, unknown>).prNumber === "number" &&
      ((value as Record<string, unknown>).cause === undefined ||
        typeof (value as Record<string, unknown>).cause === "string"),
    // ISS-7060: dedupe on the CANONICAL PR identity, the same key every other
    // PR-identity comparison in this lane uses (`mergeIdentityInto`,
    // `resolvePreserveTargetIds`, the `persistedPrRefs` sort). The refs stored
    // here are raw wire values — the persisted schema normalizes nothing — so a
    // hand-built `repositoryFullName#prNumber` key kept `Org/Repo#12`,
    // `org/repo#12` and `org/repo.git#12` as three retry entries for what those
    // comparisons all treat as one PR.
    (ref) => sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber),
    unresolvedPrRefs
  );
}

async function resolvePreserveTargetIds(
  tx: AgentSessionUpsertTx,
  sessionArtifactId: string,
  byBranch: Map<string, PrRefByBranch>,
  unresolved: SessionPrRefWithMethod[]
): Promise<Set<string>> {
  const ids = new Set(byBranch.keys());
  if (unresolved.length === 0) {
    return ids;
  }
  const existingPrLinks = await tx.artifactLink.findMany({
    where: {
      sourceId: sessionArtifactId,
      linkType: LinkType.RelatesTo,
      ...sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
    },
    select: { targetId: true, metadata: true },
  });
  for (const link of existingPrLinks) {
    const refs = sessionPrRefsFromMetadata(link.metadata);
    for (const unresolvedRef of unresolved) {
      const existingRef = refs.find(
        (ref) =>
          sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber) ===
          sessionPrIdentityKey(
            unresolvedRef.repositoryFullName,
            unresolvedRef.prNumber
          )
      );
      if (!existingRef) {
        continue;
      }
      mergePreservedUnresolvedRef(
        byBranch,
        link.targetId,
        unresolvedRef,
        existingRef
      );
      ids.add(link.targetId);
    }
  }
  return ids;
}

export async function persistSessionPrArtifactLinks(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  prRefs: SessionPrRefWithMethod[] | undefined,
  prDetailsByIdentity: SessionPullRequestDetailMap,
  // ISS-9859: `Merge` is a CONTINUATION part of a paginated `prRefs` sequence —
  // it declares a slice, not the session's whole set, so it may not retract. The
  // first part of such a sequence arrives as `Replace` and owns retraction for
  // the whole sequence; see `SessionPrLinkWriteMode`.
  mode: SessionPrLinkWriteMode = SessionPrLinkWriteMode.Replace,
  providerLocksHeld = false
): Promise<void> {
  if (prRefs === undefined) {
    return;
  }
  const isMerge = mode === SessionPrLinkWriteMode.Merge;

  if (!providerLocksHeld) {
    await acquireSessionPullRequestProviderLocks(tx, {
      organizationId,
      prRefs,
    });
  }
  const { byBranch, unresolved } = aggregatePrRefsByBranch(
    prRefs,
    prDetailsByIdentity
  );
  if (!isMerge) {
    // Prunes retry rows down to the identities this payload declares. A
    // continuation part declares only its own slice, so running this there would
    // delete the retry rows belonging to PRs that later parts still have to
    // deliver.
    await pruneStalePullRequestHeadBranchRetriesTx(tx, {
      organizationId,
      sourceArtifactId: sessionArtifactId,
      currentPrRefs: prRefs,
    });
  }

  await acquireSessionArtifactLinksAdvisoryLock(tx, {
    organizationId,
    sessionArtifactId,
  });

  // The RETRACTION half, and the whole of what `Merge` skips. A continuation
  // part declares one slice of the session's PR set, so every identity outside
  // that slice looks "removed" to it — running any of this there would delete
  // the links, downgrade the evidence and drop the retry rows belonging to PRs
  // the sequence has not finished delivering. The first part of the sequence
  // already ran it against the set it declared.
  if (!isMerge) {
    const preserveTargetIds = await resolvePreserveTargetIds(
      tx,
      sessionArtifactId,
      byBranch,
      unresolved
    );

    await downgradeRemovedPrEvidence(
      tx,
      organizationId,
      sessionArtifactId,
      preserveTargetIds
    );

    await tx.artifactLink.deleteMany({
      where: {
        organizationId,
        sourceId: sessionArtifactId,
        linkType: LinkType.RelatesTo,
        ...sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
        // FEA-2729: never delete a row that also carries session_branch evidence
        // (a merged edge keeps linkKind=session_pr for precedence). The branch
        // lane owns those rows; dropping a PR ref must not take branch data with
        // it.
        //
        // ISS-9859 (review, davetho): spelled NULL-safe. The bare
        // `NOT (branchLinked = true)` this replaces is NULL on a row with no
        // `branchLinked` key, and Postgres drops a NULL from a WHERE — so every
        // PR-only link this lane writes (`withoutSessionBranchProjectionFields`
        // strips the key) survived retraction. `AnyNull` admits the missing key,
        // the `NOT` arm admits an explicit `false`, and a `true` row matches
        // neither. Under `AND` because the kind predicate above is already an
        // `OR`.
        AND: [
          {
            OR: [
              { metadata: { path: ["branchLinked"], equals: Prisma.AnyNull } },
              { NOT: { metadata: { path: ["branchLinked"], equals: true } } },
            ],
          },
        ],
        ...(preserveTargetIds.size > 0
          ? { targetId: { notIn: [...preserveTargetIds] } }
          : {}),
      },
    });
  }

  // ISS-4445 (whitlockk): batch the pre-upsert reads. Previously this loop issued one
  // serial `findFirst` per branch (then one upsert), so a large session doubled
  // the statement count inside the batch-wide 30s transaction and risked a
  // timeout that rolls back the whole sync batch. Fetch every existing link's
  // merge base in ONE `findMany` keyed by targetId, then the loop only upserts.
  const resolvedEntries = [...byBranch].filter(
    ([branchArtifactId]) => branchArtifactId !== sessionArtifactId
  );
  const existingStateByTargetId = await loadExistingLinkStateByTargetId(
    tx,
    organizationId,
    sessionArtifactId,
    resolvedEntries.map(([branchArtifactId]) => branchArtifactId)
  );

  for (const [branchArtifactId, ref] of resolvedEntries) {
    const existingState = existingStateByTargetId.get(branchArtifactId);
    if (isMerge) {
      // Fold the stored link INTO this slice before it is written, so the upsert
      // below still writes a whole link rather than a partial one. Free of extra
      // queries: `existingStateByTargetId` was already read for the merge base.
      foldStoredLinkIntoBranchRef(ref, existingState?.metadata);
    }
    foldBranchAssociationIntoBranchRef(ref);
    await upsertSessionPrLink(tx, {
      branchArtifactId,
      existingState,
      isMerge,
      organizationId,
      ref,
      sessionArtifactId,
    });
  }

  if (unresolved.length > 0) {
    await storeUnresolvedPrRefs(
      tx,
      sessionArtifactId,
      unresolved.map((ref) => ({
        repositoryFullName: ref.repositoryFullName,
        prNumber: ref.prNumber,
      }))
    );
  }
}

function mergePreservedUnresolvedRef(
  byBranch: Map<string, PrRefByBranch>,
  branchArtifactId: string,
  incoming: SessionPrRefWithMethod,
  persisted: PersistedSessionPrRef
): void {
  const identity = sessionPrIdentityKey(
    incoming.repositoryFullName,
    incoming.prNumber
  );
  const relationTypes = new Set([
    ...persisted.relationTypes,
    incoming.relationType,
  ]);
  // A preserved ref keeps its weak tier only while BOTH sides still call it
  // prose; either side arriving command-derived promotes the identity.
  const method =
    incoming.method && persisted.method ? incoming.method : undefined;
  const existing = byBranch.get(branchArtifactId);
  if (existing) {
    existing.relationTypes.add(incoming.relationType);
    existing.refs.set(identity, {
      repositoryFullName: normalizeRepoFullName(incoming.repositoryFullName),
      prNumber: incoming.prNumber,
      relationTypes,
      ...(method ? { method } : {}),
    });
    existing.branchLifecycleEvents = mergeBranchLifecycleEvents(
      existing.branchLifecycleEvents,
      incoming.branchLifecycleEvents
    );
    return;
  }
  byBranch.set(branchArtifactId, {
    relationTypes,
    refs: new Map([
      [
        identity,
        {
          repositoryFullName: normalizeRepoFullName(
            incoming.repositoryFullName
          ),
          prNumber: incoming.prNumber,
          relationTypes,
          ...(method ? { method } : {}),
        },
      ],
    ]),
    branchLifecycleEvents: incoming.branchLifecycleEvents ?? [],
  });
}

function buildSessionPrLinkMetadata(
  existingMetadata: unknown,
  ref: PrRefByBranch,
  // ISS-9859: a continuation part of a paginated sequence. It carries one slice,
  // so it may not re-derive the link's branch projection from its own contents.
  isMerge = false
) {
  const rawBase = parseJsonObject(existingMetadata) ?? {};
  const identitylessBase = withoutSessionPrIdentityFields(rawBase);
  // The strip exists so a link whose PR evidence no longer supports a branch
  // projection loses it. A continuation part cannot make that judgement — its
  // slice is not the session's whole PR set — and the refs it resolves through
  // an already-verified PullRequestDetail row carry no `branchAssociation` at
  // all, so stripping here would silently drop the projection an earlier part
  // established. Treat the stored row as authoritative instead.
  const base =
    identitylessBase.branchLinked === true || isMerge
      ? identitylessBase
      : withoutSessionBranchProjectionFields(identitylessBase);
  const prRefs = persistedPrRefs(ref);
  const isMultiPr = prRefs.length > 1;
  // ISS-5823: the link-level kind states the STRONGEST evidence on the link, so
  // it drops to the weak tier only when every identity it declares is a prose
  // mention. One command-derived ref keeps the strong kind and the weak siblings
  // stay marked per-ref (`method`), which is what the metric readers filter on.
  const isProseOnly =
    prRefs.length > 0 && prRefs.every(isProseDerivedSessionPrRef);
  const linkKinds = collectSessionArtifactLinkKinds(base);
  linkKinds.delete(SessionArtifactLinkKind.SessionPr);
  linkKinds.delete(SessionArtifactLinkKind.SessionPrSet);
  linkKinds.delete(SessionArtifactLinkKind.SessionPrProse);
  // ISS-5823 (codex P1 review): `session_branch` is RE-DERIVED, not inherited,
  // unless the link independently established it (`branchLinked`). The PR kinds
  // above are cleared and recomputed every pass, but this one was not, so a link
  // that once carried two strong refs kept the `session_branch` those refs
  // earned even after a fresher snapshot retracted them and left only prose.
  // `topLevelLinkKind` then reads that survivor and emits `session_branch`, and
  // the branch lane's own predicate readmits the prose-only session into the
  // Branches corpus and the 1/N cost divisor — through a kind the current
  // evidence does not support, and past the exclusion three lines below.
  // ISS-9859: `isMerge` joins that condition for the same reason it preserves
  // the projection above. A PR-head-derived link carries `session_branch` in
  // `linkKinds` and a `branchParticipation` projection but NO `branchLinked`
  // key (`branchLinkedMetadata` writes that only for INDEPENDENT branch
  // evidence), so without this a continuation part deletes the kind while
  // keeping the projection — a row asserting `branchParticipation: wrote` that
  // every `session_branch` reader nonetheless skips. A slice has no standing to
  // re-derive the link's branch kind from its own partial contents, exactly as
  // it has none to re-derive the projection.
  if (base.branchLinked !== true && !isMerge) {
    linkKinds.delete(SessionArtifactLinkKind.SessionBranch);
  }
  linkKinds.add(prLinkKind(isProseOnly, isMultiPr));
  // A multi-PR link is also a branch link — but ONLY on strong evidence. Adding
  // `session_branch` for a prose-only link would put it back in the Branches
  // corpus and the 1/N cost divisor through the branch lane's own predicate.
  if (isMultiPr && !isProseOnly) {
    linkKinds.add(SessionArtifactLinkKind.SessionBranch);
  }
  const branchLifecycleEvents = mergeBranchLifecycleEvents(
    base.branchLinked === true
      ? readBranchLifecycleEventsFromMetadata(existingMetadata)
      : [],
    ref.branchLifecycleEvents
  );
  return {
    ...base,
    linkKind: topLevelLinkKind(isProseOnly, isMultiPr, linkKinds),
    linkKinds: [...linkKinds].sort(),
    relationTypes: [...ref.relationTypes].sort(),
    prRefs,
    source: SESSION_PR_LINK_SOURCE,
    confidence: 1.0,
    extractorVersion: 1,
    ...(prRefs.length === 1
      ? {
          repositoryFullName: prRefs[0]?.repositoryFullName,
          prNumber: prRefs[0]?.prNumber,
        }
      : {}),
    ...(branchLifecycleEvents.length > 0 ? { branchLifecycleEvents } : {}),
  };
}

async function downgradeRemovedPrEvidence(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  preserveTargetIds: Set<string>
): Promise<void> {
  const links = await tx.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      linkType: LinkType.RelatesTo,
      ...sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
      metadata: { path: ["branchLinked"], equals: true },
      ...(preserveTargetIds.size > 0
        ? { targetId: { notIn: [...preserveTargetIds] } }
        : {}),
    },
    select: { id: true, metadata: true },
  });
  if (links.length === 0) {
    return;
  }
  // ISS-8145: ONE statement carrying each link's OWN metadata, not one
  // `update` per link and not one `updateMany` per distinct metadata. These
  // writes are serial round trips inside the per-session write transaction, so
  // their count was the link count — bounded only by
  // `MAX_SYNCED_ARTIFACT_REFS_PRODUCER`, a client-side courtesy rather than a
  // server guarantee. Matches what ISS-4445/4440 did for this lane's READS.
  //
  // Grouping by serialized metadata (whitlockk + codex review) was not enough on
  // either axis. It collapses only links whose RESULT is byte-identical, and
  // `branchOnlyMetadata` strips PR identity while PRESERVING `branchName` and
  // `branchRepositoryFullName`, so a session retracting PR evidence from N
  // branches produced N statements — the per-item writer this change exists to
  // remove. And each statement's `in` list was an unbounded persisted group: a
  // present-empty snapshot selects every `branchLinked` PR link the session
  // holds, and past Prisma's built-statement bind budget the statement is
  // REFUSED outright, rolling the whole session slice back rather than running
  // slow. `unnest` answers both: three bind parameters whatever the link count,
  // the shape `component-usage-writes.ts` already uses for the same reason.
  const linkIds: string[] = [];
  const downgradedMetadata: string[] = [];
  for (const link of links) {
    linkIds.push(link.id);
    // Serialized per link rather than per distinct value, because each row now
    // carries its own payload. `metadata` is `JSONB`, so the text is cast back
    // on the server side.
    downgradedMetadata.push(JSON.stringify(branchOnlyMetadata(link.metadata)));
  }
  await tx.$executeRaw`
    UPDATE artifact_links AS l
    SET metadata = v.metadata::jsonb
    FROM unnest(${linkIds}::uuid[], ${downgradedMetadata}::text[])
      AS v(id, metadata)
    WHERE l.id = v.id
      AND l.organization_id = ${organizationId}::uuid
  `;
}

function branchOnlyMetadata(metadata: unknown): JsonObject {
  const preserved = withoutSessionPrIdentityFields(
    parseJsonObject(metadata) ?? {}
  );
  Reflect.deleteProperty(preserved, "relationTypes");
  const linkKinds = collectSessionArtifactLinkKinds(preserved);
  linkKinds.delete(SessionArtifactLinkKind.SessionPr);
  linkKinds.delete(SessionArtifactLinkKind.SessionPrSet);
  linkKinds.delete(SessionArtifactLinkKind.SessionPrProse);
  linkKinds.add(SessionArtifactLinkKind.SessionBranch);
  return {
    ...preserved,
    linkKind: SessionArtifactLinkKind.SessionBranch,
    linkKinds: [...linkKinds].sort(),
  };
}

async function upsertSessionPrLink(
  tx: AgentSessionUpsertTx,
  input: {
    branchArtifactId: string;
    existingState: ExistingSessionBranchLinkState | undefined;
    /** ISS-9859: a continuation part of a paginated `prRefs` sequence. */
    isMerge: boolean;
    organizationId: string;
    ref: PrRefByBranch;
    sessionArtifactId: string;
  }
): Promise<void> {
  const metadata = buildSessionPrLinkMetadata(
    input.existingState?.metadata,
    input.ref,
    input.isMerge
  );
  const writeData = input.ref.branchAssociation
    ? buildSessionBranchLinkWriteData({
        aggregate: input.ref.branchAssociation,
        evidenceSource: SessionBranchLinkEvidenceSource.PullRequestHead,
        existing: input.existingState,
        initialMetadata: metadata,
      })
    : buildSessionPrOnlyLinkWriteData(
        metadata,
        input.existingState,
        input.isMerge
      );
  if (input.ref.branchAssociation) {
    await deleteBranchMaterializationRetryForMaterializedAggregateTx(tx, {
      organizationId: input.organizationId,
      sourceArtifactId: input.sessionArtifactId,
      aggregate: input.ref.branchAssociation,
    });
  }
  await tx.artifactLink.upsert({
    where: {
      sourceId_targetId_linkType: {
        sourceId: input.sessionArtifactId,
        targetId: input.branchArtifactId,
        linkType: LinkType.RelatesTo,
      },
    },
    create: {
      organizationId: input.organizationId,
      sourceId: input.sessionArtifactId,
      targetId: input.branchArtifactId,
      linkType: LinkType.RelatesTo,
      ...writeData,
    },
    update: writeData,
    select: { id: true },
  });
}

function buildSessionPrOnlyLinkWriteData(
  metadata: JsonObject,
  existingState: ExistingSessionBranchLinkState | undefined,
  isMerge = false
) {
  const existingMetadata = parseJsonObject(existingState?.metadata) ?? {};
  // ISS-9859: same reasoning as the projection strip above, applied to the three
  // columns. Nulling them states "this session's PR evidence no longer supports
  // a branch projection", which one slice of a paginated set has no standing to
  // say — and the association-less resolution path every later-page ref takes
  // would make it say it on every continuation part.
  if (existingMetadata.branchLinked === true || isMerge) {
    return { metadata };
  }
  return {
    metadata,
    branchParticipation: null,
    branchParticipationMethod: null,
    branchParticipationObservedAt: null,
  };
}

/**
 * ISS-4445 (whitlockk): fetch the existing `RelatesTo` link metadata for every
 * `(session → branch)` target in one `findMany`, so the persist loop can merge
 * against it without a per-branch `findFirst`. Returns a `targetId → state`
 * map. An empty target list short-circuits Prisma's `targetId IN ()` no-op.
 */
async function loadExistingLinkStateByTargetId(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  targetIds: string[]
): Promise<Map<string, ExistingSessionBranchLinkState>> {
  const byTargetId = new Map<string, ExistingSessionBranchLinkState>();
  if (targetIds.length === 0) {
    return byTargetId;
  }
  const existingLinks = await tx.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      targetId: { in: targetIds },
      linkType: LinkType.RelatesTo,
    },
    select: {
      targetId: true,
      metadata: true,
      branchParticipation: true,
      branchParticipationMethod: true,
      branchParticipationObservedAt: true,
    },
  });
  for (const link of existingLinks) {
    byTargetId.set(link.targetId, link);
  }
  return byTargetId;
}
