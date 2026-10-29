import {
  ArtifactRefTargetKind,
  isKnownArtifactRefKind,
  PR_INT_MAX,
  syncedArtifactRefSchema,
  syncedSessionPrRefSchema,
} from "@repo/api/src/types/session-artifact-link";
import { z } from "zod";

const artifactRefKindProbeSchema = z
  .object({ kind: z.unknown() })
  .passthrough();
const payloadSessionsProbeSchema = z
  .object({ sessions: z.unknown() })
  .passthrough();
const prNumberProbeSchema = z.object({ prNumber: z.unknown() }).passthrough();
const repositoryFullNameProbeSchema = z
  .object({ repositoryFullName: z.unknown().optional() })
  .passthrough();
const sessionRefsProbeSchema = z
  .object({
    artifactRefs: z.unknown().optional(),
    externalSessionId: z.unknown().optional(),
    prRefs: z.unknown().optional(),
  })
  .passthrough();

const OVERSIZED_PR_REF_DROP_SAMPLE_LIMIT = 5;

/** Parse diagnostic reason for int4-unsafe PR refs that were gracefully dropped. */
export const DesktopAgentSessionsPayloadDiagnosticCode = {
  OversizedPullRequestRefDropped: "oversized_pull_request_ref_dropped",
} as const;
export type DesktopAgentSessionsPayloadDiagnosticCode =
  (typeof DesktopAgentSessionsPayloadDiagnosticCode)[keyof typeof DesktopAgentSessionsPayloadDiagnosticCode];

const DroppedPrRefField = {
  ArtifactRefs: "artifactRefs",
  PrRefs: "prRefs",
} as const;
type DroppedPrRefField =
  (typeof DroppedPrRefField)[keyof typeof DroppedPrRefField];

export type DesktopAgentSessionsDroppedPrRefSample = {
  field: DroppedPrRefField;
  prNumber: number;
  repositoryFullName?: string;
  sessionExternalId?: string;
};

/** Bounded context returned with a successful parse when lossy PR-ref degradation occurred. */
export type DesktopAgentSessionsPayloadDiagnostic = {
  artifactRefCount: number;
  code: typeof DesktopAgentSessionsPayloadDiagnosticCode.OversizedPullRequestRefDropped;
  maxPrNumber: number;
  prRefCount: number;
  samples: DesktopAgentSessionsDroppedPrRefSample[];
  sessionCount: number;
};

/**
 * Drop forward-compatible unknown artifact refs and otherwise-valid oversized
 * PR refs without turning an all-dropped payload into an explicit clear.
 */
export function filterForwardCompatibleArtifactRefs(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const known = value.filter((entry) => !isUnknownArtifactRefKind(entry));
  if (value.length > 0 && known.length === 0) {
    return undefined;
  }
  const filtered = known.filter(
    (entry) => !isOversizedPullRequestArtifactRef(entry)
  );
  return value.length > 0 && filtered.length === 0 ? undefined : filtered;
}

/** Drop otherwise-valid oversized legacy `prRefs` entries before int4 storage. */
export function dropOversizedSessionPrRefs(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const filtered = value.filter((entry) => !isOversizedSessionPrRef(entry));
  return value.length > 0 && filtered.length === 0 ? undefined : filtered;
}

/** Collect bounded diagnostics for otherwise-valid PR refs discarded for int4 safety. */
export function collectOversizedPullRequestRefDrops(
  payload: unknown
): DesktopAgentSessionsPayloadDiagnostic[] {
  const parsedPayload = payloadSessionsProbeSchema.safeParse(payload);
  if (!(parsedPayload.success && Array.isArray(parsedPayload.data.sessions))) {
    return [];
  }

  const diagnostic = emptyOversizedPullRequestRefDiagnostic();
  for (const sessionCandidate of parsedPayload.data.sessions) {
    const parsedSession = sessionRefsProbeSchema.safeParse(sessionCandidate);
    if (!parsedSession.success) {
      continue;
    }
    const sessionExternalId = extractSessionExternalId(parsedSession.data);
    const artifactRefDropped = collectOversizedRefsFromField({
      diagnostic,
      field: DroppedPrRefField.ArtifactRefs,
      isOversized: isOversizedPullRequestArtifactRef,
      sessionExternalId,
      value: parsedSession.data.artifactRefs,
    });
    const prRefDropped = collectOversizedRefsFromField({
      diagnostic,
      field: DroppedPrRefField.PrRefs,
      isOversized: isOversizedSessionPrRef,
      sessionExternalId,
      value: parsedSession.data.prRefs,
    });
    if (artifactRefDropped || prRefDropped) {
      diagnostic.sessionCount += 1;
    }
  }

  return diagnostic.artifactRefCount + diagnostic.prRefCount > 0
    ? [diagnostic]
    : [];
}

function isUnknownArtifactRefKind(value: unknown): boolean {
  const parsed = artifactRefKindProbeSchema.safeParse(value);
  return (
    parsed.success &&
    Object.hasOwn(parsed.data, "kind") &&
    !isKnownArtifactRefKind(parsed.data.kind)
  );
}

function isOversizedPullRequestArtifactRef(value: unknown): boolean {
  const parsed = artifactRefKindProbeSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.kind === ArtifactRefTargetKind.PullRequest &&
    isOtherwiseValidOversizedPrNumberEntry(value, syncedArtifactRefSchema)
  );
}

function isOversizedSessionPrRef(value: unknown): boolean {
  return isOtherwiseValidOversizedPrNumberEntry(
    value,
    syncedSessionPrRefSchema
  );
}

function isOtherwiseValidOversizedPrNumberEntry(
  value: unknown,
  schema: z.ZodType<unknown>
): boolean {
  const parsed = prNumberProbeSchema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data.prNumber !== "number" ||
    !Number.isInteger(parsed.data.prNumber) ||
    parsed.data.prNumber <= PR_INT_MAX
  ) {
    return false;
  }
  return schema.safeParse({ ...parsed.data, prNumber: PR_INT_MAX }).success;
}

function emptyOversizedPullRequestRefDiagnostic(): DesktopAgentSessionsPayloadDiagnostic {
  return {
    artifactRefCount: 0,
    code: DesktopAgentSessionsPayloadDiagnosticCode.OversizedPullRequestRefDropped,
    maxPrNumber: 0,
    prRefCount: 0,
    samples: [],
    sessionCount: 0,
  };
}

function collectOversizedRefsFromField({
  diagnostic,
  field,
  isOversized,
  sessionExternalId,
  value,
}: {
  diagnostic: DesktopAgentSessionsPayloadDiagnostic;
  field: DroppedPrRefField;
  isOversized: (value: unknown) => boolean;
  sessionExternalId: string | undefined;
  value: unknown;
}): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  let dropped = false;
  for (const entry of value) {
    if (!isOversized(entry)) {
      continue;
    }
    const prNumber = extractPrNumber(entry);
    if (prNumber === null) {
      continue;
    }
    dropped = true;
    if (field === DroppedPrRefField.ArtifactRefs) {
      diagnostic.artifactRefCount += 1;
    } else {
      diagnostic.prRefCount += 1;
    }
    diagnostic.maxPrNumber = Math.max(diagnostic.maxPrNumber, prNumber);
    if (diagnostic.samples.length < OVERSIZED_PR_REF_DROP_SAMPLE_LIMIT) {
      diagnostic.samples.push({
        field,
        prNumber,
        ...(sessionExternalId ? { sessionExternalId } : {}),
        ...sampleRepositoryFullName(entry),
      });
    }
  }
  return dropped;
}

function extractPrNumber(value: unknown): number | null {
  const parsed = prNumberProbeSchema.safeParse(value);
  if (!parsed.success || typeof parsed.data.prNumber !== "number") {
    return null;
  }
  return parsed.data.prNumber;
}

function extractSessionExternalId(
  value: z.infer<typeof sessionRefsProbeSchema>
): string | undefined {
  return typeof value.externalSessionId === "string" &&
    value.externalSessionId.length > 0
    ? value.externalSessionId
    : undefined;
}

function sampleRepositoryFullName(value: unknown): {
  repositoryFullName?: string;
} {
  const parsed = repositoryFullNameProbeSchema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data.repositoryFullName !== "string" ||
    parsed.data.repositoryFullName.length === 0
  ) {
    return {};
  }
  return { repositoryFullName: parsed.data.repositoryFullName };
}
