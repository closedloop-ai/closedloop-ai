import { z } from "zod";
import { normalizeRepoFullName } from "./branch.ts";

export const SessionPrRelationType = {
  Created: "CREATED",
  Referenced: "REFERENCED",
  Reviewed: "REVIEWED",
} as const;
export type SessionPrRelationType =
  (typeof SessionPrRelationType)[keyof typeof SessionPrRelationType];

/**
 * Persisted ArtifactLink discriminators for session-to-Branch evidence.
 *
 * `SessionPrProse` (ISS-5823) is the WEAK tier: every identity the link declares
 * was read out of assistant prose (`ArtifactRefMethod.PrMentionInProse`) rather
 * than out of a `gh`/`git` command, a URL, an MCP call, or a harness record. It
 * is a separate kind precisely so no metric- or cost-bearing population picks it
 * up by matching `SessionPr`/`SessionPrSet`. A link that carries even ONE
 * command-derived identity keeps the strong kind and marks the weak identities
 * per-ref instead — see `PersistedSessionPrRef.method`.
 */
export const SessionArtifactLinkKind = {
  SessionPr: "session_pr",
  SessionPrSet: "session_pr_set",
  SessionPrProse: "session_pr_prose",
  SessionBranch: "session_branch",
  /**
   * ISS-12552: a session-to-artifact link written from
   * operation evidence while `attribution-evidence-policy` is on, for a target
   * the slug lane never linked (a UUID-only revision). The legacy classifier
   * reads it as a reference.
   */
  SessionEvidence: "session_evidence",
} as const;
export type SessionArtifactLinkKind =
  (typeof SessionArtifactLinkKind)[keyof typeof SessionArtifactLinkKind];

export const SessionPrPurpose = {
  Authored: "authored",
  Reviewed: "reviewed",
  Referenced: "referenced",
  Unknown: "unknown",
} as const;
export type SessionPrPurpose =
  (typeof SessionPrPurpose)[keyof typeof SessionPrPurpose];

export const SESSION_PR_PURPOSE_LABELS: Record<SessionPrPurpose, string> = {
  [SessionPrPurpose.Authored]: "Authored PR",
  [SessionPrPurpose.Reviewed]: "Reviewed PR",
  [SessionPrPurpose.Referenced]: "Referenced PR",
  [SessionPrPurpose.Unknown]: "Unknown PR purpose",
};

export const sessionPrRelationTypeSchema = z.enum([
  SessionPrRelationType.Created,
  SessionPrRelationType.Referenced,
  SessionPrRelationType.Reviewed,
]);

export const persistedSessionPrRelationTypesSchema = z
  .array(z.unknown())
  .transform((values) =>
    values.flatMap((value) => {
      const parsed = sessionPrRelationTypeSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
  );

/**
 * ISS-8064: every schema in this module parses the PERSISTED shape on the way
 * OUT of `artifact_links.metadata`. A length or count bound here cannot protect
 * a write — the row is already stored — so it can only fail the read closed and
 * drop the whole link's identities with no error, no log, and no truncation
 * marker. The bounds are gone deliberately; do not reintroduce one.
 */
export const persistedSessionPrRefSchema = z.object({
  repositoryFullName: z.string().min(1),
  prNumber: z.number().int().positive(),
  relationTypes: persistedSessionPrRelationTypesSchema,
  /**
   * ISS-5823: the `ArtifactRefMethod` that produced this identity, carried so a
   * reader can tell a prose mention from a command-derived ref on a link that
   * mixes both. Optional — every row written before ISS-5823 omits it, and an
   * absent method means "not prose-derived", which is what those rows were.
   */
  method: z.string().min(1).optional(),
});

/**
 * Canonical persisted repository-plus-PR identity on a session link.
 * `relationTypes` belongs only to this identity and must not be borrowed from
 * another PR that happens to share its Branch.
 */
export type PersistedSessionPrRef = z.infer<typeof persistedSessionPrRefSchema>;

// A membership test built once: a `z.enum` per array value, and a `ZodError`
// per unknown member, dominated the per-link parse cost of every session-link
// reader (ISS-11895).
const persistedSessionArtifactLinkKinds: ReadonlySet<unknown> = new Set(
  Object.values(SessionArtifactLinkKind)
);

const persistedSessionArtifactLinkKindsSchema = z
  .array(z.unknown())
  .transform((values) =>
    values.filter((value): value is SessionArtifactLinkKind =>
      persistedSessionArtifactLinkKinds.has(value)
    )
  );

/** Identity-bearing portion extended by the broader ArtifactLink schema. */
export const sessionPrIdentityMetadataSchema = z
  .object({
    linkKind: z
      .enum([
        SessionArtifactLinkKind.SessionPr,
        SessionArtifactLinkKind.SessionPrProse,
        SessionArtifactLinkKind.SessionBranch,
      ])
      .optional(),
    linkKinds: persistedSessionArtifactLinkKindsSchema.optional(),
    repositoryFullName: z.string().min(1).optional(),
    prNumber: z.number().int().positive().optional(),
    /**
     * ISS-8051: DELIBERATELY UNBOUNDED, and on a READ schema the reason is
     * sharper than on the wire. This validator runs over metadata ALREADY
     * PERSISTED, and `classifySessionPrMetadata` maps a `safeParse` failure to
     * `invalid` — which resolves to `refs: []`. A `.max()` here therefore never
     * truncated an over-cap row; it discarded the ENTIRE stored PR set on every
     * read, so a session whose links the cloud accepted and wrote would read
     * back with no PR attribution at all and no signal that anything was
     * dropped. Once the wire cap on `prRefs` came off, rows past the old 500
     * became reachable, and this was the only thing left refusing them.
     * ISS-9859 removed the producer bound this used to anchor, so nothing
     * constrains the count on either side now — which is the point: a session's
     * PR set is delivered in full, paginated across sync parts when it is too
     * large for one payload.
     * Do not reintroduce a cardinality bound on a persisted-read validator.
     */
    prRefs: z.array(persistedSessionPrRefSchema).optional(),
    relationTypes: persistedSessionPrRelationTypesSchema.optional(),
  })
  .passthrough();

export const SessionPrMetadataClassificationKind = {
  Canonical: "canonical",
  Legacy: "legacy",
  None: "none",
  Invalid: "invalid",
} as const;
export type SessionPrMetadataClassificationKind =
  (typeof SessionPrMetadataClassificationKind)[keyof typeof SessionPrMetadataClassificationKind];

export type SessionPrMetadataClassification = {
  kind: SessionPrMetadataClassificationKind;
  refs: PersistedSessionPrRef[];
};

/**
 * Classifies persisted identity metadata without losing `prRefs` presence.
 * Canonical empty and invalid canonical shapes remain authoritative fail-closed
 * states; only a valid scalar-PR row with `prRefs` absent is legacy-fallback
 * eligible.
 */
export function classifySessionPrMetadata(
  metadata: unknown
): SessionPrMetadataClassification {
  const hasPrRefs = hasOwn(metadata, "prRefs");
  const parsed = sessionPrIdentityMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return invalidClassification();
  }
  if (hasPrRefs) {
    return {
      kind: SessionPrMetadataClassificationKind.Canonical,
      refs: parsed.data.prRefs ?? [],
    };
  }
  if (parsed.data.linkKinds?.includes(SessionArtifactLinkKind.SessionPrSet)) {
    return invalidClassification();
  }
  if (parsed.data.linkKind !== SessionArtifactLinkKind.SessionPr) {
    return {
      kind: SessionPrMetadataClassificationKind.None,
      refs: [],
    };
  }
  const hasRepository = parsed.data.repositoryFullName !== undefined;
  const hasNumber = parsed.data.prNumber !== undefined;
  if (hasRepository !== hasNumber) {
    return invalidClassification();
  }
  return {
    kind: SessionPrMetadataClassificationKind.Legacy,
    refs:
      hasRepository && hasNumber
        ? [
            {
              repositoryFullName: parsed.data.repositoryFullName ?? "",
              prNumber: parsed.data.prNumber ?? 0,
              relationTypes: parsed.data.relationTypes ?? [],
            },
          ]
        : [],
  };
}

/** Canonical or legacy identities declared by one persisted link. */
export function sessionPrRefsFromMetadata(
  metadata: unknown
): PersistedSessionPrRef[] {
  return classifySessionPrMetadata(metadata).refs;
}

/** Whether unique-Branch inference is allowed for this legacy row. */
export function allowsUniqueBranchPrFallback(metadata: unknown): boolean {
  const classification = classifySessionPrMetadata(metadata);
  return (
    classification.kind === SessionPrMetadataClassificationKind.Legacy &&
    classification.refs.length === 0
  );
}

/** True only for a valid legacy PR row or a valid canonical PR set. */
export function hasSessionPrLinkKind(metadata: unknown): boolean {
  const classification = classifySessionPrMetadata(metadata);
  return (
    classification.kind === SessionPrMetadataClassificationKind.Legacy ||
    classification.kind === SessionPrMetadataClassificationKind.Canonical
  );
}

/** Derives one declared PR reference's purpose without sibling evidence. */
export function deriveSessionPrPurposeFromRelationTypes(
  relationTypes: readonly SessionPrRelationType[],
  confidence?: number
): SessionPrPurpose {
  if (confidence !== undefined && confidence < 0.5) {
    return SessionPrPurpose.Unknown;
  }
  if (relationTypes.includes(SessionPrRelationType.Created)) {
    return SessionPrPurpose.Authored;
  }
  if (relationTypes.includes(SessionPrRelationType.Reviewed)) {
    return SessionPrPurpose.Reviewed;
  }
  if (relationTypes.includes(SessionPrRelationType.Referenced)) {
    return SessionPrPurpose.Referenced;
  }
  return SessionPrPurpose.Unknown;
}

/** Canonical repo-scoped identity, or a repo-unknown legacy twin. */
export function sessionPrIdentityKey(
  repositoryFullName: string | null | undefined,
  prNumber: number | string
): string {
  const trimmedRepository = repositoryFullName?.trim();
  const normalizedRepository = trimmedRepository
    ? normalizeRepoFullName(trimmedRepository)
    : null;
  const normalizedNumber = String(prNumber).trim();
  return normalizedRepository
    ? `${normalizedRepository}#${normalizedNumber}`
    : `legacy#${normalizedNumber}`;
}

/**
 * Whether parsed link metadata DECLARES session→branch evidence, in EITHER
 * marker.
 *
 * A link that carried both roles — the session's branch link, also used as its
 * PR link — is persisted as the composite `linkKind: session_pr` with
 * `session_branch` in `linkKinds`, so the top-level scalar alone rejects a link
 * that plainly states it is a branch link. Both readers of that fact
 * (`isNonProseSessionBranchLink` in the admission pass, `statesLegacyBranchTouch`
 * in the ISS-8427 plural derivation) call this rather than re-deriving it: a
 * second copy that checked one marker would silently disagree with the writers.
 *
 * It reports only the DECLARATION. Whether the evidence is strong enough to
 * admit — prose method, participation kind — stays with each caller.
 */
export function declaresSessionBranchLinkKind(
  metadata: {
    linkKind?: SessionArtifactLinkKind | null;
    linkKinds?: readonly SessionArtifactLinkKind[] | null;
  } | null
): boolean {
  if (!metadata) {
    return false;
  }
  return (
    metadata.linkKind === SessionArtifactLinkKind.SessionBranch ||
    metadata.linkKinds?.includes(SessionArtifactLinkKind.SessionBranch) === true
  );
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    value !== null && typeof value === "object" && Object.hasOwn(value, key)
  );
}

function invalidClassification(): SessionPrMetadataClassification {
  return {
    kind: SessionPrMetadataClassificationKind.Invalid,
    refs: [],
  };
}
