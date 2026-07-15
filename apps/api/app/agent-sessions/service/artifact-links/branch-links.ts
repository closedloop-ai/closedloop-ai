import {
  ArtifactType,
  BranchPushSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import type {
  SyncedArtifactRef,
  SyncedBranchArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefRelation,
  BRANCH_PUSH_METHODS,
  SessionArtifactLinkKind,
  SessionArtifactLinkMetadataSource,
} from "@repo/api/src/types/session-artifact-link";
import { stampBranchFirstPush } from "@/app/branches/branch-push-state";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { parseJsonObject } from "@/lib/json-schema";
import type { AgentSessionUpsertTx } from "../records";
import { collectBranchRefs, storeUnresolvedRefs } from "./shared";

/**
 * Extractor version stamped on session_branch link metadata so a future
 * re-derivation can be recognized and re-merged in place.
 */
const SESSION_BRANCH_LINK_EXTRACTOR_VERSION = 1;

/**
 * Precedence when a session touched one branch via several methods/relations —
 * write evidence (`created`/`output`) outranks read/workspace evidence, so the
 * cloud can distinguish a branch a session wrote to from one it merely started
 * on (FEA-2729 AC).
 */
const BRANCH_RELATION_PRECEDENCE: Record<ArtifactRefRelation, number> = {
  [ArtifactRefRelation.Created]: 0,
  [ArtifactRefRelation.Output]: 1,
  [ArtifactRefRelation.Input]: 2,
  [ArtifactRefRelation.Referenced]: 3,
  [ArtifactRefRelation.Workspace]: 4,
};

type BranchRefAggregate = {
  repositoryFullName: string;
  branchName: string;
  method: string;
  relation: ArtifactRefRelation;
  observedAt?: string;
  /**
   * Earliest observed time across this branch's PUSH-method refs (`git_push` /
   * `gh_pr_create`), if any — the C1-verified in-session push evidence that
   * stamps `firstPushedAt`/`pushSource='session'` (PRD-510 FR2, PLN-1099 Phase
   * 2). Distinct from `observedAt` (which keeps the LATEST across all methods
   * for link recency); push state is earliest-wins.
   */
  pushedAt?: string;
};

type UnresolvedBranchRef = {
  repositoryFullName: string;
  branchName: string;
};

/**
 * Resolve — or, per PRD-510 FR8, artifact-first CREATE — the BRANCH artifact for
 * a session's branch ref, keyed on the D2 identity `(organizationId, normalized
 * repositoryFullName, branchName)`. This is the desktop branch producer: every
 * captured branch with a remote repo identity gets a cloud row on first sight,
 * un-pushed included, regardless of GitHub App installation.
 *
 * - `repositoryId` is enrichment only: set when the repo is in an active
 *   installation (App repo), null otherwise (non-App). Identity never depends
 *   on it (D2).
 * - Creation is artifact-first (FR13): create the `Artifact(BRANCH)` (org from
 *   the API key, never the payload) with the `BranchDetail` nested, so the org
 *   copy matches the parent by construction. No head/base/PR is written — a
 *   desktop branch ref carries none, so a later webhook still lands cleanly
 *   through `applyHeadTransition` (FR8 head-provenance discipline).
 * - Returns null when the session has no resolved project: a branch artifact
 *   must be project-parented, so the ref is DEFERRED and re-created once the
 *   session attributes to a project on a later sync (the desktop re-sends the
 *   full ref set — late-target tolerance).
 */
export async function ensureBranchArtifactRow(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    repositoryId: string | null;
    repositoryFullName: string;
    branchName: string;
  }
): Promise<string | null> {
  // D2 key is unique, so at most one row exists — resolve it regardless of
  // deletedAt (a tombstoned row still owns the key; creating a second would
  // violate the unique index).
  const identity = {
    organizationId: input.organizationId,
    repositoryFullName: input.repositoryFullName,
    branchName: input.branchName,
  };
  const existing = await tx.branchDetail.findFirst({
    where: identity,
    select: { artifactId: true },
  });
  if (existing) {
    return existing.artifactId;
  }
  if (input.projectId === null) {
    return null;
  }
  // A concurrent producer (another request or a racing tick) can insert the
  // same D2 row between the findFirst above and this create; the unique index
  // then rejects it with P2002. We deliberately do NOT catch-and-re-read on
  // `tx` here: this create runs inside the long-lived multi-session sync
  // transaction, which Postgres marks aborted after any failed statement, so a
  // recovery query on the same `tx` would itself fail (AGENTS.md: no recovery
  // inside an aborted interactive transaction). Letting P2002 propagate rolls
  // the batch back cleanly; the desktop re-sends the full ref set on its next
  // sync, where the findFirst above resolves the winning row.
  const created = await tx.artifact.create({
    data: {
      type: ArtifactType.Branch,
      organization: { connect: { id: input.organizationId } },
      project: { connect: { id: input.projectId } },
      name: input.branchName,
      status: GitHubPRState.Open,
      externalUrl: `https://github.com/${input.repositoryFullName}/tree/${encodeURIComponent(input.branchName)}`,
      branch: {
        create: {
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
          repositoryFullName: input.repositoryFullName,
          branchName: input.branchName,
        },
      },
    },
    select: { id: true },
  });
  return created.id;
}

/** Fold a branch ref into the per-artifact aggregate: strongest relation + latest observedAt win. */
function foldBranchRef(
  byArtifact: Map<string, BranchRefAggregate>,
  branchArtifactId: string,
  ref: SyncedBranchArtifactRef
): void {
  // A push-method ref with a timestamp is the earliest-wins push evidence.
  const pushAt =
    BRANCH_PUSH_METHODS.has(ref.method) && ref.observedAt
      ? ref.observedAt
      : undefined;
  const existing = byArtifact.get(branchArtifactId);
  if (!existing) {
    byArtifact.set(branchArtifactId, {
      repositoryFullName: ref.repositoryFullName,
      branchName: ref.branchName,
      method: ref.method,
      relation: ref.relation,
      ...(ref.observedAt ? { observedAt: ref.observedAt } : {}),
      ...(pushAt ? { pushedAt: pushAt } : {}),
    });
    return;
  }
  const incomingRank = BRANCH_RELATION_PRECEDENCE[ref.relation] ?? 99;
  const existingRank = BRANCH_RELATION_PRECEDENCE[existing.relation] ?? 99;
  if (incomingRank < existingRank) {
    existing.relation = ref.relation;
    existing.method = ref.method;
  }
  if (
    ref.observedAt &&
    (!existing.observedAt ||
      Date.parse(ref.observedAt) > Date.parse(existing.observedAt))
  ) {
    existing.observedAt = ref.observedAt;
  }
  // Push state is earliest-wins (unlike `observedAt`'s latest-wins recency).
  if (
    pushAt &&
    (!existing.pushedAt || Date.parse(pushAt) < Date.parse(existing.pushedAt))
  ) {
    existing.pushedAt = pushAt;
  }
}

/**
 * Merge-upsert one SESSION→BRANCH link. The row is shared with the session_pr
 * lane (same `(sourceId,targetId,linkType)` unique key), so this preserves any
 * existing metadata and overlays branch evidence — `linkKinds` accumulates
 * every kind present, and `linkKind` keeps `session_pr` precedence so that
 * lane's scalar reader/replacement keeps working (FEA-2729, decision:
 * merge-into-one-edge).
 */
async function upsertSessionBranchLink(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  branchArtifactId: string,
  aggregate: BranchRefAggregate
): Promise<void> {
  const existing = await tx.artifactLink.findFirst({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      targetId: branchArtifactId,
      linkType: LinkType.RelatesTo,
    },
    select: { metadata: true },
  });
  const base = parseJsonObject(existing?.metadata) ?? {};
  const kinds = new Set<string>();
  if (typeof base.linkKind === "string") {
    kinds.add(base.linkKind);
  }
  if (Array.isArray(base.linkKinds)) {
    for (const kind of base.linkKinds) {
      if (typeof kind === "string") {
        kinds.add(kind);
      }
    }
  }
  kinds.add(SessionArtifactLinkKind.SessionBranch);
  const linkKind = kinds.has(SessionArtifactLinkKind.SessionPr)
    ? SessionArtifactLinkKind.SessionPr
    : SessionArtifactLinkKind.SessionBranch;

  const metadata = {
    ...base,
    linkKind,
    linkKinds: [...kinds].sort(),
    branchLinked: true,
    method: aggregate.method,
    relation: aggregate.relation,
    ...(aggregate.observedAt ? { observedAt: aggregate.observedAt } : {}),
    branchName: aggregate.branchName,
    branchRepositoryFullName: aggregate.repositoryFullName,
    branchSource: SessionArtifactLinkMetadataSource.DesktopSync,
    branchExtractorVersion: SESSION_BRANCH_LINK_EXTRACTOR_VERSION,
  };

  try {
    await tx.artifactLink.upsert({
      where: {
        sourceId_targetId_linkType: {
          sourceId: sessionArtifactId,
          targetId: branchArtifactId,
          linkType: LinkType.RelatesTo,
        },
      },
      create: {
        organizationId,
        sourceId: sessionArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.RelatesTo,
        metadata,
      },
      update: { metadata },
    });
  } catch (e: unknown) {
    if (getPrismaErrorCode(e) === "P2002") {
      /* swallow concurrent sync collision */
    } else {
      throw e;
    }
  }
}

/** Persist deferred branch refs (branch artifact not yet synced) for retry on a later tick. */
function storeUnresolvedBranchRefs(
  tx: AgentSessionUpsertTx,
  sessionArtifactId: string,
  unresolvedBranchRefs: UnresolvedBranchRef[]
): Promise<void> {
  return storeUnresolvedRefs<UnresolvedBranchRef>(
    tx,
    sessionArtifactId,
    "_unresolvedBranchRefs",
    (value): value is UnresolvedBranchRef =>
      value != null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).repositoryFullName ===
        "string" &&
      typeof (value as Record<string, unknown>).branchName === "string",
    (ref) => `${ref.repositoryFullName}#${ref.branchName}`,
    unresolvedBranchRefs
  );
}

/**
 * Create SESSION→BRANCH `ArtifactLink`s from a session's `branch`-kind refs,
 * carrying `method`/`relation`/`observedAt` in metadata (FEA-2729). Resolves
 * the BRANCH artifact by `(organizationId, repositoryFullName, branchName)`
 * (org from the API key — PRD-510 FR11); a ref whose branch artifact has not
 * synced yet is deferred into `SessionDetail.metadata._unresolvedBranchRefs`
 * and retried when the session next syncs its (full) ref set — never dropped.
 *
 * Additive by design (no replacement deleteMany): a session's touched branches
 * are effectively monotonic, and skipping deletes keeps this lane from
 * clobbering the session_pr link it may share a row with. Idempotent — re-sync
 * and extractor re-derivation update metadata in place on the unique key.
 *
 * `repoIdByFullName` is resolved ONCE per payload by `resolveBranchRepoMap`
 * (org installation + repos are batch-invariant), so this per-session lane only
 * issues the branch lookup — not the org/repo lookups (avoids the N+1).
 */
export async function persistSessionBranchArtifactLinks(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  projectId: string | null,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined,
  repoIdByFullName: Map<string, string>
): Promise<void> {
  // `undefined` means the client didn't send refs — leave links untouched
  // (mirrors persistArtifactLinks).
  if (artifactRefs === undefined) {
    return;
  }
  const branchRefs = collectBranchRefs(artifactRefs);
  if (branchRefs.length === 0) {
    return;
  }

  const byArtifact = new Map<string, BranchRefAggregate>();
  const unresolved: UnresolvedBranchRef[] = [];
  for (const ref of branchRefs) {
    // PRD-510 FR8 producer: resolve or artifact-first CREATE the branch row on
    // the D2 key. `repositoryId` is enrichment (App repos only); non-App repos
    // pass null and are keyed by the normalized full name alone. The enrichment
    // map is keyed by the same normalized name (resolveBranchRepoMap), so a
    // `.git`/mixed-case ref still matches its App installation repo.
    const normalizedFullName = normalizeRepoFullName(ref.repositoryFullName);
    const branchArtifactId = await ensureBranchArtifactRow(tx, {
      organizationId,
      projectId,
      repositoryId: repoIdByFullName.get(normalizedFullName) ?? null,
      repositoryFullName: normalizedFullName,
      branchName: ref.branchName,
    });
    if (branchArtifactId === null) {
      // The session has no resolved project yet, so the branch artifact can't
      // be created — defer and retry on a later sync (late-target tolerance;
      // the desktop re-sends the full ref set).
      unresolved.push({
        repositoryFullName: ref.repositoryFullName,
        branchName: ref.branchName,
      });
      continue;
    }
    if (branchArtifactId === sessionArtifactId) {
      continue;
    }
    foldBranchRef(byArtifact, branchArtifactId, ref);
  }

  for (const [branchArtifactId, aggregate] of byArtifact) {
    // PRD-510 FR2 / PLN-1099 Phase 2b: a C1-verified in-session push (a synced
    // `git_push`/`gh_pr_create` ref — the desktop extractor already dropped
    // failed pushes) stamps `firstPushedAt`/`pushSource='session'` set-once,
    // earliest-wins. This is the non-App producer: it flips a branch to pushed
    // (and thus org-visible under FR12) with no GitHub App/webhook required.
    //
    // Stamp BEFORE the link upsert: `upsertSessionBranchLink` swallows a
    // concurrent-collision P2002, which aborts the Postgres transaction — any
    // write issued after it (in this iteration) would then fail. Doing the stamp
    // first keeps a single-ref sync committing cleanly when the link races.
    if (aggregate.pushedAt) {
      await stampBranchFirstPush(
        tx,
        branchArtifactId,
        new Date(aggregate.pushedAt),
        BranchPushSource.Session
      );
    }
    await upsertSessionBranchLink(
      tx,
      organizationId,
      sessionArtifactId,
      branchArtifactId,
      aggregate
    );
  }

  if (unresolved.length > 0) {
    await storeUnresolvedBranchRefs(tx, sessionArtifactId, unresolved);
  }
}
