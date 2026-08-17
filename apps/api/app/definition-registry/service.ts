import "server-only";

import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import type {
  AgentComponentKind,
  ComponentVersion,
  SourceAccessState as SourceAccessStateDto,
  SourceOccurrence as SourceOccurrenceDto,
  SourceOccurrenceType as SourceOccurrenceTypeDto,
} from "@repo/api/src/types/agent-component";
import { buildComponentVersions } from "@repo/api/src/types/agent-component";
import type { ComponentSourceProvenance } from "@repo/api/src/types/component-source";
import type { TransactionClient, withDb } from "@repo/database";
import { SourceAccessState, SourceOccurrenceType } from "@repo/database";

/**
 * The Prisma client handed to a `withDb`/`withDb.tx` callback — the read methods
 * below run inside the agent-components service's existing `withDb`, so they take
 * this client rather than opening their own connection.
 */
type DbClient = Parameters<Parameters<typeof withDb>[0]>[0];

/**
 * F1 definition-version registry writer (FEA-3290 / PRD-527, Slice 3).
 *
 * This module is the **single** place that maps `{ content, kind } → an exact
 * `DefinitionVersion` row + a typed `SourceOccurrence`. Every content-bearing
 * writer (today: the desktop component sync lane; tomorrow: F6 discovery, F4
 * packs) calls {@link registerDefinitionVersion} rather than re-deriving a hash
 * or re-shaping the upsert — the same "one SSOT, import everywhere" pattern
 * Slice-1 established for the fingerprint itself.
 *
 * Two hard invariants:
 *
 * 1. **The fingerprint is never recomputed here.** The version identity is
 *    produced ONLY by `computeDefinitionHash` from
 *    `@repo/api/src/definition-fingerprint` (Slice-1, provenance-free,
 *    whitespace-preserving). There is deliberately no local sha256 in this file.
 * 2. **Org-scoping is threaded from the authenticated caller, never the
 *    payload.** `organizationId` is a required argument and participates in every
 *    `where`/`create`, so there is no code path that writes a version or an
 *    occurrence without an org filter. Two orgs with byte-identical content get
 *    two distinct `DefinitionVersion` rows (same `definitionHash`, different
 *    `organizationId`), and neither can read the other's.
 */

/**
 * Inputs to {@link registerDefinitionVersion}. Carries the definition's own
 * content + kind (which produce the fingerprint) plus the provenance evidence
 * for the source occurrence. `organizationId` is always the authenticated
 * caller's org — never taken from an untrusted payload.
 */
export type RegisterDefinitionInput = {
  /** Authenticated caller's org. Threaded into every where/create. */
  organizationId: string;
  /** The component kind whose bytes are fingerprinted. Folded into the hash. */
  componentKind: AgentComponentKind;
  /** Whole-file definition text (the Prompt-panel content). */
  content: string;
  /** Source format (md, json, yml, …) at first observation; null when unknown. */
  format?: string | null;
  /**
   * FEA-3982 edit-lineage: the authenticated user who authored/observed this
   * exact version (an "editor" of that hash). Threaded from the sync caller's
   * `input.userId` — never the payload. When present, an idempotent
   * `DefinitionVersionEditor` row is upserted so the org-level read surface can
   * attribute the version's collaborators (discoverer + editors of that hash).
   * Optional/skew-safe: absent ⇒ no lineage row is written (identical to the
   * pre-FEA-3982 behavior), so a caller that has no user context never fails.
   */
  editorUserId?: string | null;
  /**
   * The kind of place this exact version was observed. The sync lane observes
   * definitions on a device, so it passes `local`; F6 discovery will pass
   * `repository`, F4 packs `pack`. Defaults to `local`.
   */
  occurrenceType?: SourceOccurrenceType;
  /** Whether the body was readable at capture (AC-5). Defaults to accessible. */
  accessState?: SourceAccessState;
  /** `local` evidence: the compute target the occurrence was observed on. */
  computeTargetId?: string | null;
  /** `local` evidence: filesystem path the definition was read from. */
  installPath?: string | null;
  /**
   * `pack` evidence (FEA-3909 / PRD-527 F4): the top-level pack `CatalogItem` id
   * whose membership carries this exact version. Supply with
   * `occurrenceType: pack`; coalesced to '' (ignored) for every other type. A
   * version referenced by multiple packs yields one `pack` occurrence per pack
   * id — membership is many-to-many (PD3) and the version row is never copied.
   */
  packId?: string | null;
  /** When the occurrence was observed; defaults to now. */
  observedAt?: Date;
};

/**
 * SSOT frontmatter/body split for the fingerprint input (DD-3).
 *
 * The cloud only ever has the **whole file**; nothing splits frontmatter from
 * body. We feed the whole file as `body` with `frontmatter: ""`, which is
 * contract-faithful: Slice-1 length-prefix-frames each field, so
 * `{ frontmatter: "", body: <file> }` is a well-defined, collision-safe
 * pre-image. Centralized here so if a future producer supplies a real split,
 * only this helper changes — never a caller, and never the hash contract.
 */
function definitionFingerprintOf(content: string, kind: AgentComponentKind) {
  return computeDefinitionHash({ frontmatter: "", body: content, kind });
}

/**
 * Register (idempotently) that an exact definition version was observed at a
 * provenance. Runs INSIDE the caller's `withDb` transaction (`tx` passed in) so
 * the F1 registry write stays atomic with the sync-lane writes that triggered
 * it. Returns the stable `definitionVersionId` for the caller to stamp onto the
 * coarse `AgentComponentVersion` row.
 *
 * Idempotency:
 * - `DefinitionVersion` upserts on `(organizationId, definitionHash)` — the same
 *   fingerprint never creates a second row; a re-observation only bumps
 *   `lastSeenAt`. A whitespace-only edit yields a *different* fingerprint (it
 *   rides Slice-1's exact contract) → a genuinely new version row.
 * - `SourceOccurrence` upserts on its 8-column natural key; an idempotent rescan
 *   bumps `lastObservedAt`/`accessState` rather than duplicating (AC-6).
 *
 * NULL-in-unique-key safety: Postgres treats NULL as *distinct* in a unique
 * index, so this writer never passes NULL into an occurrence key participant.
 * The evidence columns not relevant to the `occurrenceType` are coalesced to `""`
 * (the repo and pack columns, for a `local` occurrence), and `localPath` is
 * coalesced to `installPath ?? ""`. `computeTargetId` is a real, authenticated
 * UUID on the sync path.
 */
export async function registerDefinitionVersion(
  tx: TransactionClient,
  input: RegisterDefinitionInput
): Promise<string> {
  const definitionVersionId = await ensureDefinitionVersion(tx, input);
  await recordDefinitionSourceOccurrence(tx, {
    organizationId: input.organizationId,
    definitionVersionId,
    occurrenceType: input.occurrenceType ?? SourceOccurrenceType.local,
    accessState: input.accessState ?? SourceAccessState.accessible,
    computeTargetId: input.computeTargetId ?? null,
    installPath: input.installPath ?? null,
    packId: input.packId ?? "",
    observedAt: input.observedAt,
  });
  return definitionVersionId;
}

/**
 * Idempotently upsert the typed `SourceOccurrence` for a version at a provenance.
 *
 * Every non-participating evidence column is coalesced to `""` so the
 * NULL-distinct unique-index caveat can never spawn a duplicate occurrence
 * (`local` uses computeTargetId + localPath; `pack` uses packId; the repo
 * columns stay `""`).
 *
 * Prisma's compound-unique **input** types every key participant as non-null —
 * you cannot upsert-by-key with a null `computeTargetId`, even though the DB
 * column is nullable. A `local` occurrence always carries a real, authenticated
 * `computeTargetId` (the sync path), so it takes the fast `upsert`-by-key. The
 * null-target case (a non-device source: a `pack` occurrence (F4), repository
 * evidence, or a future repo scan) can't use that compound key, and a
 * `findFirst`-then-`create` cannot arbitrate a race — two concurrent imports of
 * the same member each see no row and both insert, so it does an ATOMIC
 * `INSERT … ON CONFLICT DO UPDATE` against the null-target partial unique index
 * (`idx_source_occurrence_null_target_key`, `WHERE compute_target_id IS NULL`),
 * which the database enforces even though the 8-column index treats a NULL
 * `computeTargetId` as distinct. Both paths are idempotent: a rescan (or a
 * losing concurrent racer) bumps `lastSeenAt` + re-affirms `accessState` (AC-6)
 * rather than duplicating.
 */
async function upsertSourceOccurrence(
  tx: TransactionClient,
  args: {
    organizationId: string;
    definitionVersionId: string;
    occurrenceType: SourceOccurrenceType;
    accessState: SourceAccessState;
    computeTargetId: string | null;
    localPath: string;
    repoFullName?: string;
    repoPath?: string;
    repoCommit?: string;
    packId: string;
    now: Date;
  }
): Promise<string> {
  const {
    organizationId,
    definitionVersionId,
    occurrenceType,
    accessState,
    computeTargetId,
    localPath,
    packId,
    now,
  } = args;
  const repoFullName = args.repoFullName ?? "";
  const repoPath = args.repoPath ?? "";
  const repoCommit = args.repoCommit ?? "";

  if (computeTargetId != null) {
    const occurrence = await tx.sourceOccurrence.upsert({
      where: {
        definitionVersionId_occurrenceType_repoFullName_repoPath_repoCommit_computeTargetId_localPath_packId:
          {
            definitionVersionId,
            occurrenceType,
            repoFullName,
            repoPath,
            repoCommit,
            computeTargetId,
            localPath,
            packId,
          },
      },
      create: {
        organizationId,
        definitionVersionId,
        occurrenceType,
        accessState,
        repoFullName,
        repoPath,
        repoCommit,
        computeTargetId,
        localPath,
        packId,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {},
      select: { id: true },
    });
    await updateSourceOccurrenceObservation(
      tx,
      occurrence.id,
      accessState,
      now
    );
    return occurrence.id;
  }

  // Null-target provenance (pack (F4) / repository evidence / future repo scan):
  // the DB treats a NULL `compute_target_id` as distinct in the 8-column natural
  // key, so a find-then-create would let two concurrent imports of the same member
  // each insert a duplicate occurrence. Instead do an ATOMIC upsert against the
  // null-target partial unique index (`WHERE compute_target_id IS NULL`), so the
  // database arbitrates the race: the loser's insert conflicts and falls through
  // to `DO UPDATE` (bump `lastSeenAt`, re-affirm `accessState`, AC-6).
  await tx.$executeRaw`
    INSERT INTO "source_occurrences" (
      "id", "organization_id", "definition_version_id", "occurrence_type",
      "access_state", "repo_full_name", "repo_path", "repo_commit",
      "compute_target_id", "local_path", "pack_id",
      "first_seen_at", "last_seen_at", "created_at", "updated_at"
    )
    VALUES (
      gen_random_uuid(), ${organizationId}::uuid, ${definitionVersionId}::uuid,
      ${occurrenceType}::"source_occurrence_type", ${accessState}::"source_access_state",
      ${repoFullName}, ${repoPath}, ${repoCommit},
      NULL, ${localPath}, ${packId},
      ${now}, ${now}, ${now}, ${now}
    )
    ON CONFLICT ("definition_version_id", "occurrence_type", "repo_full_name",
      "repo_path", "repo_commit", "local_path", "pack_id")
      WHERE "compute_target_id" IS NULL
    DO UPDATE SET
      "last_seen_at" = ${now},
      "access_state" = ${accessState}::"source_access_state",
      "updated_at" = ${now}
  `;
  const occurrence = await tx.sourceOccurrence.findFirst({
    where: {
      organizationId,
      definitionVersionId,
      occurrenceType,
      repoFullName,
      repoPath,
      repoCommit,
      computeTargetId: null,
      localPath,
      packId,
    },
    select: { id: true },
  });
  if (!occurrence) {
    throw new Error("Null-target source occurrence was not persisted");
  }
  return occurrence.id;
}

// ===========================================================================
// F1 read surface (FEA-3290 / PRD-527, Slice 6).
//
// The agent-components detail read path delegates here so version history is
// backed by the exact-fingerprint `DefinitionVersion` registry while remaining
// wire-compatible with the shipped `ComponentVersion` DTO (which keys off the
// legacy `hash`). Every read is org-scoped — `organizationId` participates in
// every `where`, so a private body / identity / occurrence is NEVER exposed
// cross-org (AC-019), and the inaccessible-vs-missing distinction (AC-5) is
// carried through on `SourceOccurrence.accessState` untouched.
// ===========================================================================

/**
 * The coarse revision rows a component's version history is built from, joined
 * to their exact `DefinitionVersion` (when linked). Selected so the shared
 * `buildComponentVersions` mapper produces the wire DTO, plus the F1 fingerprint
 * passthrough. Org-scoped by construction (the caller passes the org filter).
 */
type ComponentVersionJoinRow = {
  contentHash: string;
  source: string | null;
  format: string | null;
  firstSeenAt: Date | null;
  definitionVersion: {
    definitionHash: string;
    normalizerContractVersion: number;
  } | null;
  content: string;
};

/**
 * F1-preferred version history for one component identity, org-scoped.
 *
 * Reads the coarse `AgentComponentVersion` revisions for `(org, kind, key)`
 * newest-first and joins each to its exact `DefinitionVersion` via the
 * `definitionVersionId` link. Every returned `ComponentVersion` carries its
 * `definitionHash` + `normalizerContractVersion` **once linked**; during the
 * pre-backfill window a still-unlinked revision is UNION-fallback preserved
 * (surfaced by its legacy `hash`/`content` alone), so no version ever
 * disappears from the selector between the schema landing and the backfill
 * completing.
 *
 * This is a strict superset of the legacy read: same rows, same ordering, same
 * `hash`/`content`, plus the exact fingerprint where available.
 *
 * `componentKeys` is the identity's COMPLETE normalized name set, not one name
 * (closedloop-ai-stage, #4391). The same bytes can be installed under different
 * names, which FEA-4335 treats as ONE component, and `content-hash-identity.ts`
 * names version history explicitly among the reads that "scope usage across
 * EVERY name that shares the content". Reading one name split the family: the
 * selector silently omitted revisions attached under an alternate name, and
 * `truncated` — probed over that same narrowed predicate — reported the split
 * page complete. For a legacy name key the set is a singleton and the emitted
 * SQL is the previous one.
 */
export async function getVersionsForComponent(
  db: DbClient,
  organizationId: string,
  componentKind: string,
  componentKeys: readonly string[],
  currentHash: string | null,
  take: number,
  /**
   * ISS-6232: the identity's own captured provenance (pack, repo, scope,
   * install path). Every stored revision carries the pre-derivation `""` source
   * sentinel, so the shared mapper resolves each revision's reported `source`
   * against this — the same helper the desktop reader calls with its own
   * representative row, so the two surfaces cannot answer differently.
   */
  provenance: ComponentSourceProvenance
): Promise<ComponentVersionHistory> {
  // AC-019: org filter on every read. The join to DefinitionVersion inherits it
  // via the link, and a purged/foreign version link is SetNull, so a row can
  // never surface another org's fingerprint or body.
  //
  // An OR of case-insensitive equals rather than an `in`: the name keys reach
  // this read normalized, but an event-minted row stores the raw-case subagent
  // type (`Explore`), and the case-insensitive match is the contract the
  // name-level reads already carry (FEA-3750). Both the body page and the
  // sentinel probe below share this object, so they can never disagree about
  // which rows the history spans.
  const where = {
    organizationId,
    componentKind,
    OR: componentKeys.map((componentKey) => ({
      componentKey: { equals: componentKey, mode: "insensitive" as const },
    })),
  };
  const orderBy = [
    { lastSeenAt: "desc" as const },
    { firstSeenAt: "desc" as const },
  ];
  const rows = (await db.agentComponentVersion.findMany({
    where,
    orderBy,
    select: {
      contentHash: true,
      source: true,
      format: true,
      firstSeenAt: true,
      content: true,
      // The exact fingerprint, when this coarse revision has been linked. NULL
      // during the pre-backfill window → union-fallback to the legacy row. Only
      // the hash + contract version are read — the exact `content` body is NOT
      // selected here (the DTO's `content` comes from the same-org coarse row's
      // own `content`), so this read never pulls a joined body across the link.
      definitionVersion: {
        select: {
          definitionHash: true,
          normalizerContractVersion: true,
        },
      },
    },
    take,
  })) as ComponentVersionJoinRow[];

  // ISS-5029: probe for a `take + 1`th row in a SEPARATE, BODY-FREE query rather
  // than widening the read above to `take + 1`. The cap exists precisely to bound
  // body bytes (each `content` can be the full 256 KiB sync cap), so widening the
  // body read to fetch a sentinel it immediately discards would add up to another
  // 256 KiB per detail request on exactly the pathological components the cap was
  // written for. `skip: take, take: 1` over the SAME `where`/`orderBy` reads one
  // hash and nothing else (closedloop-ai review, ISS-5029) — the same position the
  // desktop packer's own probe takes on its body-free ranking pass.
  //
  // Reported from the read whose bound actually BOUND, never inferred by
  // comparing the returned length against `take` — dedupe/UNION-fallback in this
  // lane can change that count independently of whether anything was dropped
  // (the ISS-4797/4799 lesson, PR #4354).
  const sentinel = await db.agentComponentVersion.findMany({
    where,
    orderBy,
    select: { contentHash: true },
    skip: take,
    take: 1,
  });
  const truncated = sentinel.length > 0;
  const versions = buildComponentVersions(
    rows.map((v) => ({
      contentHash: v.contentHash,
      // F1 passthrough once linked; omitted (undefined) while unlinked so the
      // union-fallback row is byte-identical to the pre-F1 wire shape.
      definitionHash: v.definitionVersion?.definitionHash,
      normalizerContractVersion: v.definitionVersion?.normalizerContractVersion,
      source: v.source,
      format: v.format,
      createdAt: v.firstSeenAt?.toISOString() ?? "",
      content: v.content,
    })),
    currentHash,
    provenance
  );
  return { versions, truncated };
}

/**
 * ISS-5029: one component's bounded revision page plus whether the read's own
 * `take` bound — i.e. the cloud holds revisions this page does not carry.
 *
 * `truncated: false` is a real claim (the whole stored history fits), not a
 * default, so a consumer can render "complete" and "partial" as genuinely
 * different states.
 */
export type ComponentVersionHistory = {
  versions: ComponentVersion[];
  truncated: boolean;
};

/**
 * Map a Prisma `SourceOccurrence` row to the surface-neutral DTO. Never carries
 * the definition body — provenance only — and preserves `accessState` verbatim
 * so `inaccessible` is NEVER collapsed into "missing" downstream (AC-5).
 */
function toSourceOccurrenceDto(row: {
  occurrenceType: SourceOccurrenceType;
  accessState: SourceAccessState;
  repoFullName: string | null;
  repoPath: string | null;
  repoCommit: string | null;
  computeTargetId: string | null;
  localPath: string | null;
  packId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}): SourceOccurrenceDto {
  return {
    occurrenceType: row.occurrenceType as SourceOccurrenceTypeDto,
    accessState: row.accessState as SourceAccessStateDto,
    // The writer coalesces non-participating evidence columns to '' for a stable
    // unique key; normalize '' back to null so the DTO reports "no evidence of
    // this kind" honestly rather than an empty-string artifact.
    repoFullName: row.repoFullName || null,
    repoPath: row.repoPath || null,
    repoCommit: row.repoCommit || null,
    computeTargetId: row.computeTargetId ?? null,
    localPath: row.localPath || null,
    packId: row.packId || null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/**
 * The provenance list (occurrenceType, evidence, accessState, first/last seen)
 * for one exact `DefinitionVersion`, org-scoped (AC-019).
 *
 * BOTH the `organizationId` AND the `definitionVersionId` participate in the
 * `where`: a caller can never read another org's occurrences even if it somehow
 * learns a foreign `definitionVersionId`, because the org filter excludes it.
 * `accessState` is surfaced per-occurrence so an `inaccessible` (permission-
 * denied) provenance is presented as itself — never conflated with a missing /
 * deleted occurrence (AC-5).
 */
export async function getSourceOccurrences(
  db: DbClient,
  organizationId: string,
  definitionVersionId: string,
  take = 200
): Promise<SourceOccurrenceDto[]> {
  const rows = await db.sourceOccurrence.findMany({
    where: { organizationId, definitionVersionId },
    orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    select: {
      occurrenceType: true,
      accessState: true,
      repoFullName: true,
      repoPath: true,
      repoCommit: true,
      computeTargetId: true,
      localPath: true,
      packId: true,
      firstSeenAt: true,
      lastSeenAt: true,
    },
    take,
  });
  return rows.map(toSourceOccurrenceDto);
}

/**
 * Provenance-free definition-version write used when exact invocation evidence
 * proves the bytes that ran but does not prove where those bytes were observed.
 * Callers must record a source occurrence separately and only when they possess
 * genuine provenance evidence.
 */
export async function ensureDefinitionVersion(
  tx: TransactionClient,
  input: EnsureDefinitionVersionInput
): Promise<string> {
  const { definitionHash, normalizerContractVersion } = definitionFingerprintOf(
    input.content,
    input.componentKind
  );
  const now = input.observedAt ?? new Date();
  const version = await tx.definitionVersion.upsert({
    where: {
      organizationId_definitionHash: {
        organizationId: input.organizationId,
        definitionHash,
      },
    },
    create: {
      organizationId: input.organizationId,
      componentKind: input.componentKind,
      definitionHash,
      normalizerContractVersion,
      content: input.content,
      format: input.format ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {},
    select: { id: true },
  });
  await updateDefinitionObservationWindow(tx, version.id, now);
  await recordDefinitionVersionEditor(tx, version.id, input.editorUserId, now);
  return version.id;
}

/**
 * FEA-3982 (Mike-approved edit-lineage capture): idempotently record that
 * `userId` authored/observed this exact version hash. Atomic upsert on the
 * `(definitionVersionId, userId)` unique key — a re-observation only bumps
 * `lastEditedAt`, never duplicates and never races (no findFirst-then-write). A
 * no-op when the caller has no user context (`editorUserId` null/absent), so the
 * lineage capture is fully additive.
 *
 * `role` defaults to `editor` on create; the discoverer (the earliest observer
 * of the hash in the org) is derived at read time as `min(firstEditedAt)`, so
 * the write stays a single conflict-free upsert with no read-modify-write.
 */
async function recordDefinitionVersionEditor(
  tx: TransactionClient,
  definitionVersionId: string,
  editorUserId: string | null | undefined,
  observedAt: Date
): Promise<void> {
  if (!editorUserId) {
    return;
  }
  // FEA-3982 (wongk): one atomic INSERT … ON CONFLICT DO UPDATE with LEAST/GREATEST
  // on the observation window, instead of an upsert + two guarded updateMany
  // round-trips. The `(definition_version_id, user_id)` unique key arbitrates the
  // race; `LEAST`/`GREATEST` keep `first_edited_at` monotonically earliest and
  // `last_edited_at` monotonically latest without clobbering. Mirrors the shape of
  // the null-target occurrence path's atomic upsert (this file). `role` is left at
  // its `editor` default on create (see `DefinitionVersionEditor.role`).
  await tx.$executeRaw`
    INSERT INTO "definition_version_editors" (
      "id", "definition_version_id", "user_id",
      "first_edited_at", "last_edited_at", "created_at", "updated_at"
    )
    VALUES (
      gen_random_uuid(), ${definitionVersionId}::uuid, ${editorUserId}::uuid,
      ${observedAt}, ${observedAt}, ${observedAt}, ${observedAt}
    )
    ON CONFLICT ("definition_version_id", "user_id")
    DO UPDATE SET
      "first_edited_at" = LEAST("definition_version_editors"."first_edited_at", ${observedAt}),
      "last_edited_at" = GREATEST("definition_version_editors"."last_edited_at", ${observedAt}),
      "updated_at" = ${observedAt}
  `;
}

/** Record genuine provenance for an already-ensured exact definition version. */
export function recordDefinitionSourceOccurrence(
  tx: TransactionClient,
  input: RecordDefinitionSourceOccurrenceInput
): Promise<string> {
  return upsertSourceOccurrence(tx, {
    organizationId: input.organizationId,
    definitionVersionId: input.definitionVersionId,
    occurrenceType: input.occurrenceType ?? SourceOccurrenceType.local,
    accessState: input.accessState ?? SourceAccessState.accessible,
    computeTargetId: input.computeTargetId ?? null,
    localPath: input.installPath ?? "",
    repoFullName: input.repoFullName,
    repoPath: input.repoPath,
    repoCommit: input.repoCommit,
    packId: input.packId ?? "",
    now: input.observedAt ?? new Date(),
  });
}

export type EnsureDefinitionVersionInput = Pick<
  RegisterDefinitionInput,
  | "organizationId"
  | "componentKind"
  | "content"
  | "format"
  | "observedAt"
  | "editorUserId"
>;

export type RecordDefinitionSourceOccurrenceInput = Pick<
  RegisterDefinitionInput,
  | "organizationId"
  | "occurrenceType"
  | "accessState"
  | "computeTargetId"
  | "installPath"
  | "observedAt"
> & {
  definitionVersionId: string;
  repoFullName?: string;
  repoPath?: string;
  repoCommit?: string;
  packId?: string;
};

async function updateDefinitionObservationWindow(
  tx: TransactionClient,
  definitionVersionId: string,
  observedAt: Date
): Promise<void> {
  await tx.definitionVersion.updateMany({
    where: { id: definitionVersionId, firstSeenAt: { gt: observedAt } },
    data: { firstSeenAt: observedAt },
  });
  await tx.definitionVersion.updateMany({
    where: { id: definitionVersionId, lastSeenAt: { lt: observedAt } },
    data: { lastSeenAt: observedAt },
  });
}

async function updateSourceOccurrenceObservation(
  tx: TransactionClient,
  sourceOccurrenceId: string,
  accessState: SourceAccessState,
  observedAt: Date
): Promise<void> {
  await tx.sourceOccurrence.updateMany({
    where: { id: sourceOccurrenceId, firstSeenAt: { gt: observedAt } },
    data: { firstSeenAt: observedAt },
  });
  await tx.sourceOccurrence.updateMany({
    where: { id: sourceOccurrenceId, lastSeenAt: { lte: observedAt } },
    data: { lastSeenAt: observedAt, accessState },
  });
}

/**
 * FEA-3704: the PAGINATED, org-scoped source-occurrence read behind the new
 * `GET /agent-components/source-occurrences` route. Same org-scoping guarantee as
 * {@link getSourceOccurrences} — BOTH `organizationId` AND `definitionVersionId`
 * participate in the `where`, so a caller can never read another org's
 * occurrences even with a leaked foreign version id (the org filter excludes it,
 * yielding an empty page and `total = 0`).
 *
 * The count and the page are both scoped to the identical `where` and run against
 * the same `db` (one `withDb` from the caller); the page uses `skip`/`take` so
 * peak memory is bounded by the page size, never the full occurrence set (no
 * N+1 — one `count` + one `findMany`, both indexed on the org+version key).
 */
export async function getSourceOccurrencesPage(
  db: DbClient,
  organizationId: string,
  definitionVersionId: string,
  offset: number,
  limit: number
): Promise<{ items: SourceOccurrenceDto[]; total: number }> {
  const where = { organizationId, definitionVersionId };
  const [total, rows] = await Promise.all([
    db.sourceOccurrence.count({ where }),
    db.sourceOccurrence.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
      select: {
        occurrenceType: true,
        accessState: true,
        repoFullName: true,
        repoPath: true,
        repoCommit: true,
        computeTargetId: true,
        localPath: true,
        packId: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
      skip: offset,
      take: limit,
    }),
  ]);
  return { items: rows.map(toSourceOccurrenceDto), total };
}
