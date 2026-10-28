/**
 * ISS-12552: Layer 1 attribution facts. A dossier's signed
 * `attribution` block is held against the production chain run over its raw
 * transcript and its server captures: claim extraction, receipt binding and
 * classification from `@repo/lib/attribution`, with `server/receipts.json`
 * standing in for the receipt table. Asserted here: every operation (provider
 * id, kind, target, receipt, committed, relationship), the reference set, the
 * candidate set, and usage ownership. Proven allocations need activity segments
 * and the kernel, and are asserted at Layer 3; repository implementation
 * operations come from branch participation on the server, and are asserted
 * at Layer 5.
 *
 * Held-out dossiers (`attribution-holdout.csv`) are never asserted here: they
 * are scored by the accuracy report, so no red test can invite tuning to their
 * answers (PRD-800 "Held-out accuracy annotation").
 *
 * The receipt table is the only stand-in. Target resolution, which the API
 * does against the organization's artifacts, resolves against the artifacts
 * this dossier's own receipts and results name, so an artifact outside the
 * collection organization resolves to nothing, as it does in production.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  type OperationClaim,
  OperationClaimSource,
  type OperationEvidenceCoverage,
} from "@repo/api/src/types/operation-claims";
import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import {
  type AllocationEvidence,
  claimRequestAnchors,
} from "@repo/lib/attribution/allocation-inputs";
import { classifyReconciledClaim } from "@repo/lib/attribution/classify-reconciled-claim";
import { extractOperationClaims } from "@repo/lib/attribution/extract-operation-claims";
import {
  type ReceiptCandidate,
  reconcileOperationClaims,
} from "@repo/lib/attribution/reconcile-operation-claims";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import { Harness, type NormalizedSession } from "@repo/lib/harness/types";
import { z } from "zod";
import {
  type ASSERTED_EMPTY,
  type AttributionBlock,
  NonContributionReason,
  parseAttributionExpectations,
} from "./golden-attribution-facts.js";
import {
  type ActualUsageRow,
  requestFactFailures,
} from "./golden-attribution-request-facts.js";

type ExpectedOperation = Extract<
  NonNullable<AttributionBlock["operations"]>,
  readonly unknown[]
>[number];
export type Identity = { slugs: Set<string>; uuids: Set<string> };
export type ActualOperation = {
  /** The row the API would persist, as allocation reads it. */
  evidence: AllocationEvidence;
  providerId: string;
  operationId?: string;
  kind: string;
  committed: boolean;
  relationship: string;
  identity: Identity;
};

const WRITE_RELATIONSHIPS: ReadonlySet<string> = new Set([
  AttributionRelationshipKind.Creation,
  AttributionRelationshipKind.Revision,
  AttributionRelationshipKind.CommentReview,
]);
const PARENT_AGENT = "parent";
const TOKEN_COUNT_TYPE = "token_count";

const receiptsFileSchema = z.record(
  z.string(),
  z
    .object({
      operationKind: z.string(),
      outcome: z.string(),
      clientCallId: z.string().nullable(),
      requestFingerprint: z.string().nullable(),
      requestedAt: z.iso.datetime(),
      committedAt: z.iso.datetime().nullable(),
      targetArtifactId: z.string().nullable(),
      createdArtifactId: z.string().nullable(),
      versionNumber: z.number().int().nullable(),
      changedFields: z.array(z.string()),
      contentDigestBefore: z.string().nullable(),
      contentDigestAfter: z.string().nullable(),
    })
    .loose()
);

const holdoutRowSchema = z.object({ dossier_id: z.string().min(1) });

/** The dossier ids `attribution-holdout.csv` holds out. */
export function heldOutDossierIds(corpusDir: string): Set<string> {
  const path = join(corpusDir, "attribution-holdout.csv");
  if (!existsSync(path)) {
    return new Set();
  }
  const [header, ...rows] = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(","));
  return new Set(
    rows.map(
      (row) =>
        holdoutRowSchema.parse(
          Object.fromEntries((header ?? []).map((key, i) => [key, row[i]]))
        ).dossier_id
    )
  );
}

/** Every disagreement between the signed block and the production chain. */
export async function attributionLayer1Failures(
  dossierDir: string,
  expectations: unknown,
  session: NormalizedSession
): Promise<string[]> {
  const parsed = parseAttributionExpectations(expectations);
  if (!parsed.ok) {
    return [`attribution block: ${parsed.error}`];
  }
  const block = parsed.attribution;
  if (block === undefined) {
    return [];
  }
  const harness = harnessOf(expectations);
  const claims = operationClaims(
    (await extractOperationClaims(session, harness)).claims
  );
  const actual = actualOperations(claims, readReceipts(dossierDir));
  const references = actualReferences(claims, actual);
  const usage = actualUsage(dossierDir, session, harness);
  return [
    ...operationFailures(asList(block.operations), actual),
    ...referenceFailures(block, references),
    ...candidateFailures(block, actual, references),
    ...usageFailures(
      block,
      usage.map((row) => row.key)
    ),
    ...requestFactFailures(block, usage, actual, harness, (row) =>
      usageKey(row.source_usage_ids, row.owning_agent, row.categories)
    ),
  ];
}

/** What the production chain derives for a dossier, shared with Layer 3 and the accuracy report. */
export type ProductionAttribution = {
  operations: ActualOperation[];
  /** Every receipt the dossier's server capture holds. */
  receiptIds: string[];
  coverage: OperationEvidenceCoverage;
  references: ReadonlySet<string>;
  evidence: AllocationEvidence[];
  idBySlug: ReadonlyMap<string, string>;
};

/**
 * ISS-12552: every operation, reference and evidence
 * row the production chain derives for a dossier, and the artifact ids its own
 * receipts and results name by slug.
 */
export async function productionAttribution(
  dossierDir: string,
  expectations: unknown,
  session: NormalizedSession
): Promise<ProductionAttribution> {
  const extracted = await extractOperationClaims(
    session,
    harnessOf(expectations)
  );
  const claims = operationClaims(extracted.claims);
  const { coverage } = extracted;
  const receipts = readReceipts(dossierDir);
  const known = knownArtifacts(claims, receipts);
  const operations = actualOperations(claims, receipts, known);
  return {
    operations,
    receiptIds: receipts.map((receipt) => receipt.id),
    coverage,
    references: actualReferences(claims, operations),
    evidence: operations.map((op) => op.evidence),
    idBySlug: known.idBySlug,
  };
}

function harnessOf(expectations: unknown): Harness {
  const harness = z
    .object({ harness: z.enum([Harness.Claude, Harness.Codex]) })
    .loose()
    .parse(expectations).harness;
  return harness;
}

function readReceipts(dossierDir: string): ReceiptCandidate[] {
  const path = join(dossierDir, "server", "receipts.json");
  if (!existsSync(path)) {
    return [];
  }
  const receipts = receiptsFileSchema.parse(
    JSON.parse(readFileSync(path, "utf8"))
  );
  return Object.entries(receipts).map(([id, receipt]) => ({
    id,
    operationKind: receipt.operationKind,
    outcome: receipt.outcome,
    clientCallId: receipt.clientCallId,
    requestFingerprint: receipt.requestFingerprint,
    requestedAt: new Date(receipt.requestedAt),
    committedAt: receipt.committedAt ? new Date(receipt.committedAt) : null,
    targetArtifactId: receipt.targetArtifactId,
    createdArtifactId: receipt.createdArtifactId,
    versionNumber: receipt.versionNumber,
    changedFields: receipt.changedFields,
    contentDigestBefore: receipt.contentDigestBefore,
    contentDigestAfter: receipt.contentDigestAfter,
  }));
}

function actualOperations(
  claims: readonly OperationClaim[],
  receipts: readonly ReceiptCandidate[],
  known: KnownArtifacts = knownArtifacts(claims, receipts)
): ActualOperation[] {
  const reconciled = reconcileOperationClaims({
    claims,
    receipts,
    heldElsewhere: new Map(),
  });
  return reconciled.flatMap((entry) => {
    const { claim } = entry;
    if (
      claim.source === OperationClaimSource.Reference ||
      claim.providerCallId === undefined
    ) {
      return [];
    }
    const classification = classifyReconciledClaim(
      entry,
      observedArtifactId(claim, known)
    );
    const identity = claimIdentity(claim, classification.targetArtifactId);
    const knownSlug = classification.targetArtifactId
      ? known.slugById.get(classification.targetArtifactId)
      : undefined;
    if (knownSlug) {
      identity.slugs.add(knownSlug);
    }
    return [
      {
        evidence: {
          targetArtifactId: classification.targetArtifactId,
          relationshipKind: classification.kind,
          agentId: claim.agentId ?? null,
          invokedAt: claim.invokedAt ? new Date(claim.invokedAt) : null,
          effectiveAt: entry.receipt?.committedAt ?? null,
          receiptId: entry.receipt?.id ?? null,
          anchors: claimRequestAnchors(claim),
        },
        providerId: claim.providerCallId,
        ...(entry.receipt ? { operationId: entry.receipt.id } : {}),
        kind: classification.operationKind,
        committed:
          entry.outcome === OperationEvidenceOutcome.Committed &&
          WRITE_RELATIONSHIPS.has(classification.kind),
        relationship: classification.kind,
        identity,
      },
    ];
  });
}

type KnownArtifacts = {
  ids: Set<string>;
  idBySlug: Map<string, string>;
  slugById: Map<string, string>;
};

/** The organization's artifacts as this dossier shows them: id, and slug where seen. */
function knownArtifacts(
  claims: readonly OperationClaim[],
  receipts: readonly ReceiptCandidate[]
): KnownArtifacts {
  const ids = new Set<string>();
  const idBySlug = new Map<string, string>();
  const slugById = new Map<string, string>();
  for (const receipt of receipts) {
    for (const id of [receipt.targetArtifactId, receipt.createdArtifactId]) {
      if (id) {
        ids.add(id);
      }
    }
  }
  for (const claim of claims) {
    const entity = claim.primaryResultEntity;
    if (entity?.id) {
      ids.add(entity.id);
      if (entity.slug) {
        idBySlug.set(entity.slug, entity.id);
        slugById.set(entity.id, entity.slug);
      }
    }
  }
  return { ids, idBySlug, slugById };
}

function observedArtifactId(
  claim: OperationClaim,
  known: KnownArtifacts
): string | null {
  for (const target of claim.inputTargets ?? []) {
    if (target.uuid && known.ids.has(target.uuid)) {
      return target.uuid;
    }
    const bySlug = target.slug ? known.idBySlug.get(target.slug) : undefined;
    if (bySlug) {
      return bySlug;
    }
  }
  return null;
}

function claimIdentity(
  claim: OperationClaim,
  targetArtifactId: string | null
): Identity {
  const slugs = new Set<string>();
  const uuids = new Set<string>();
  for (const target of claim.inputTargets ?? []) {
    if (target.slug) {
      slugs.add(target.slug);
    }
    if (target.uuid) {
      uuids.add(target.uuid);
    }
  }
  if (targetArtifactId) {
    uuids.add(targetArtifactId);
  }
  return { slugs, uuids };
}

/** Reference slugs, less any artifact an operation targeted. */
function actualReferences(
  claims: readonly OperationClaim[],
  operations: readonly ActualOperation[]
): Set<string> {
  const targeted = new Set(operations.flatMap((op) => [...op.identity.slugs]));
  return new Set(
    claims.flatMap((claim) =>
      claim.source === OperationClaimSource.Reference &&
      claim.referenceSlug &&
      !targeted.has(claim.referenceSlug)
        ? [claim.referenceSlug]
        : []
    )
  );
}

function asList<T>(
  value: readonly T[] | typeof ASSERTED_EMPTY | undefined
): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function operationFailures(
  expected: readonly ExpectedOperation[],
  actual: readonly ActualOperation[]
): string[] {
  const failures: string[] = [];
  const asserted = expected.filter(
    (op) => op.relationship !== AttributionRelationshipKind.Implementation
  );
  const actualById = new Map(actual.map((op) => [op.providerId, op]));
  for (const want of asserted) {
    const got = actualById.get(want.provider_id);
    if (!got) {
      failures.push(`operations[${want.provider_id}]: no claim for this call`);
      continue;
    }
    failures.push(...operationFieldFailures(want, got));
  }
  const expectedIds = new Set(asserted.map((op) => op.provider_id));
  for (const got of actual) {
    if (!expectedIds.has(got.providerId)) {
      failures.push(
        `operations[${got.providerId}]: claimed (${got.kind}, ${got.relationship}) but not in the signed block`
      );
    }
  }
  return failures;
}

function operationFieldFailures(
  want: ExpectedOperation,
  got: ActualOperation
): string[] {
  const key = `operations[${want.provider_id}]`;
  const failures: string[] = [];
  const compare = (field: string, expected: unknown, actual: unknown) => {
    if (expected !== actual) {
      failures.push(
        `${key}.${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  };
  compare("kind", want.kind, got.kind);
  compare("committed", want.committed, got.committed);
  compare("relationship", want.relationship, got.relationship);
  if (want.operation_id !== undefined) {
    compare("operation_id", want.operation_id, got.operationId);
  }
  if (want.target?.slug && !got.identity.slugs.has(want.target.slug)) {
    failures.push(
      `${key}.target.slug ${want.target.slug} not the call's target`
    );
  }
  if (want.target?.uuid && !got.identity.uuids.has(want.target.uuid)) {
    failures.push(
      `${key}.target.uuid ${want.target.uuid} not the call's target`
    );
  }
  return failures;
}

function referenceFailures(
  block: AttributionBlock,
  actual: ReadonlySet<string>
): string[] {
  const expected = new Set(
    asList(block.non_contributions).flatMap((entry) =>
      entry.reason === NonContributionReason.Reference && entry.target.slug
        ? [entry.target.slug]
        : []
    )
  );
  return setFailures("references", expected, actual);
}

function candidateFailures(
  block: AttributionBlock,
  operations: readonly ActualOperation[],
  references: ReadonlySet<string>
): string[] {
  const candidates = asList(block.candidate_artifacts);
  const expectedSlugs = new Set(candidates.flatMap((c) => c.slug ?? []));
  const actualSlugs = new Set([
    ...references,
    ...operations.flatMap((op) => [...op.identity.slugs]),
  ]);
  const failures = setFailures(
    "candidate_artifacts",
    expectedSlugs,
    actualSlugs
  );
  const actualUuids = new Set(
    operations.flatMap((op) => [...op.identity.uuids])
  );
  for (const candidate of candidates) {
    if (!candidate.slug && candidate.uuid && !actualUuids.has(candidate.uuid)) {
      failures.push(
        `candidate_artifacts: ${candidate.uuid} is no call's target`
      );
    }
  }
  return failures;
}

function setFailures(
  key: string,
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>
): string[] {
  const missing = [...expected].filter((value) => !actual.has(value)).sort();
  const extra = [...actual].filter((value) => !expected.has(value)).sort();
  return [
    ...(missing.length > 0 ? [`${key}: missing ${missing.join(", ")}`] : []),
    ...(extra.length > 0 ? [`${key}: unexpected ${extra.join(", ")}`] : []),
  ];
}

/** `ids` joined in order, then the owner and the nonzero categories. */
function usageKey(
  ids: readonly string[],
  owner: string,
  categories: readonly string[]
): string {
  return `${ids.join("+")} @${owner} [${[...categories].sort().join(",")}]`;
}

function usageFailures(
  block: AttributionBlock,
  actual: readonly string[]
): string[] {
  if (block.usage === undefined) {
    return [];
  }
  const expected = asList(block.usage).map((group) =>
    usageKey(group.source_usage_ids, group.owning_agent, group.categories)
  );
  return setFailures("usage", new Set(expected), new Set(actual));
}

type SeriesEntry = NonNullable<NormalizedSession["tokenSeries"]>[number];

function actualUsage(
  dossierDir: string,
  session: NormalizedSession,
  harness: Harness
): ActualUsageRow[] {
  const parentSeries = session.tokenSeries ?? [];
  if (harness === Harness.Codex) {
    const lines = tokenCountLines(dossierDir);
    return parentSeries.map((entry, i) =>
      usageRow(
        usageKey(
          [lines[i] ?? `unmatched#${i}`],
          PARENT_AGENT,
          categoriesOf(entry)
        ),
        entry
      )
    );
  }
  const owned: [string, SeriesEntry][] = [
    ...parentSeries.map((entry): [string, SeriesEntry] => [
      PARENT_AGENT,
      entry,
    ]),
    ...(session.subagents ?? []).flatMap((sub) =>
      (sub.tokenSeries ?? []).map((entry): [string, SeriesEntry] => [
        sub.nativeSubagentId ?? sub.id,
        entry,
      ])
    ),
  ];
  return owned.map(([owner, entry]) => {
    const identity = entry.sourceIdentity;
    const ids =
      identity?.availability === TokenSourceIdentityAvailability.Available
        ? identity.sourceRecordIds
        : ["unavailable"];
    return usageRow(usageKey(ids, owner, categoriesOf(entry)), entry);
  });
}

/** One parsed usage record: its oracle key, tokens and request keys. */
function usageRow(key: string, entry: SeriesEntry): ActualUsageRow {
  const identity = entry.sourceIdentity;
  return {
    key,
    tokens:
      (entry.input ?? 0) +
      (entry.output ?? 0) +
      (entry.cacheRead ?? 0) +
      (entry.cacheWrite ?? 0),
    requestKeys:
      identity?.availability === TokenSourceIdentityAvailability.Available
        ? identity.sourceRecordIds.map((id) =>
            requestKeyFor(identity.scheme, id)
          )
        : [],
  };
}

function categoriesOf(entry: SeriesEntry): string[] {
  return (
    [
      ["input", entry.input],
      ["output", entry.output],
      ["cacheRead", entry.cacheRead],
      ["cacheWrite", entry.cacheWrite],
    ] as const
  ).flatMap(([category, tokens]) => ((tokens ?? 0) > 0 ? [category] : []));
}

/**
 * `L<n>` for each `token_count` event that reports a new round trip, in file
 * order: the anchors the Codex usage oracle cites. Reads the raw rollout for
 * line numbers only; every count comes from the parse.
 */
function tokenCountLines(dossierDir: string): string[] {
  const rawDir = join(dossierDir, "raw");
  const rollout = readdirSync(rawDir).find((name) => name.endsWith(".jsonl"));
  if (!rollout) {
    return [];
  }
  const lines: string[] = [];
  let previous: string | null = null;
  readFileSync(join(rawDir, rollout), "utf8")
    .split("\n")
    .forEach((line, i) => {
      const record = tokenCountRecordSchema.safeParse(safeJson(line));
      if (!record.success) {
        return;
      }
      const totals = JSON.stringify(record.data.payload.info.total_token_usage);
      if (totals !== previous) {
        lines.push(`L${i + 1}`);
        previous = totals;
      }
    });
  return lines;
}

const tokenCountRecordSchema = z.object({
  payload: z.object({
    type: z.literal(TOKEN_COUNT_TYPE),
    info: z.object({ total_token_usage: z.record(z.string(), z.number()) }),
  }),
});

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * The claims that become operation evidence. Implementation-join claims feed
 * the server's implementation rows and never become operations, as in
 * `persistSessionOperationEvidence`. Read from the claim's source field here,
 * not through the code under test.
 */
function operationClaims(claims: readonly OperationClaim[]): OperationClaim[] {
  return claims.filter(
    (claim) => claim.source !== OperationClaimSource.ImplementationJoin
  );
}
