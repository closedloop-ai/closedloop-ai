import {
  type SelectedPullRequestCheck,
  type SelectedPullRequestCheckApp,
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import { z } from "zod";

/** Normalize one provider rollup context without inventing unknown outcomes. */
export function normalizeSelectedPullRequestCheckContext(
  input: unknown,
  position: number
): SelectedPullRequestCheckContextResult {
  const typeResult = contextTypeSchema.safeParse(input);
  if (!typeResult.success) {
    return invalid(SelectedPullRequestChecksPartialReason.MalformedContext);
  }
  if (typeResult.data.__typename === ProviderContextType.CheckRun) {
    return normalizeCheckRun(input, position);
  }
  if (typeResult.data.__typename === ProviderContextType.StatusContext) {
    return normalizeStatusContext(input, position);
  }
  return invalid(SelectedPullRequestChecksPartialReason.MalformedContext);
}

/** Select one latest attempt per logical source and report ambiguous history. */
export function selectLatestSelectedPullRequestChecks(
  attempts: readonly SelectedPullRequestCheckAttempt[]
): SelectedPullRequestCheckSelection {
  const selectedBySource = new Map<string, SelectedPullRequestCheckAttempt>();
  let hasAmbiguousSource = attempts.some(
    (attempt) => attempt.sourceIdentityIsAmbiguous
  );

  for (const attempt of attempts) {
    const selected = selectedBySource.get(attempt.check.sourceIdentity);
    if (!selected) {
      selectedBySource.set(attempt.check.sourceIdentity, attempt);
      continue;
    }
    const comparison = compareAttempts(selected, attempt);
    if (comparison.ambiguous) {
      hasAmbiguousSource = true;
    }
    if (comparison.useCandidate) {
      selectedBySource.set(attempt.check.sourceIdentity, attempt);
    }
  }

  const checks = [...selectedBySource.values()]
    .sort(compareSelectedAttempts)
    .map((attempt) => attempt.check);
  return { checks, hasAmbiguousSource };
}

function normalizeCheckRun(
  input: unknown,
  position: number
): SelectedPullRequestCheckContextResult {
  const parsed = checkRunSchema.safeParse(input);
  if (!parsed.success) {
    return invalid(SelectedPullRequestChecksPartialReason.MalformedContext);
  }
  const providerStatus = normalizeProviderValue(parsed.data.status);
  const providerConclusion = parsed.data.conclusion
    ? normalizeProviderValue(parsed.data.conclusion)
    : null;
  const category = classifyCheckRun(providerStatus, providerConclusion);
  if (!category) {
    return invalid(SelectedPullRequestChecksPartialReason.UnknownOutcome);
  }

  const sourceApp = normalizeApp(parsed.data.checkSuite?.app ?? null);
  const sourceIdentity = buildCheckRunSourceIdentity(
    sourceApp,
    parsed.data.name,
    parsed.data.id
  );
  const completedAt = parsed.data.completedAt ?? null;
  const startedAt = parsed.data.startedAt ?? null;
  const createdAt = parsed.data.createdAt ?? null;
  return valid({
    check: {
      providerId: parsed.data.id,
      sourceIdentity,
      sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
      sourceApp,
      name: parsed.data.name,
      providerStatus,
      providerConclusion,
      category,
      createdAt,
      startedAt,
      completedAt,
      targetUrl: parsed.data.detailsUrl ?? parsed.data.url ?? null,
    },
    observedAt: createdAt ?? startedAt ?? completedAt,
    observedAtIsAmbiguous: createdAt === null,
    position,
    sourceIdentityIsAmbiguous: sourceApp === null,
  });
}

function normalizeStatusContext(
  input: unknown,
  position: number
): SelectedPullRequestCheckContextResult {
  const parsed = statusContextSchema.safeParse(input);
  if (!parsed.success) {
    return invalid(SelectedPullRequestChecksPartialReason.MalformedContext);
  }
  const providerStatus = normalizeProviderValue(parsed.data.state);
  const category = classifyStatusContext(providerStatus);
  if (!category) {
    return invalid(SelectedPullRequestChecksPartialReason.UnknownOutcome);
  }
  const sourceIdentity = `${SelectedPullRequestCheckSourceKind.StatusContext}:${parsed.data.context}`;
  const createdAt = parsed.data.createdAt ?? null;
  return valid({
    check: {
      providerId: `${sourceIdentity}:${createdAt ?? "unknown"}:${providerStatus}`,
      sourceIdentity,
      sourceKind: SelectedPullRequestCheckSourceKind.StatusContext,
      sourceApp: null,
      name: parsed.data.context,
      providerStatus,
      providerConclusion: null,
      category,
      createdAt,
      startedAt: null,
      completedAt: null,
      targetUrl: parsed.data.targetUrl ?? null,
    },
    observedAt: createdAt,
    observedAtIsAmbiguous: createdAt === null,
    position,
    sourceIdentityIsAmbiguous: false,
  });
}

function classifyCheckRun(
  status: string,
  conclusion: string | null
): SelectedPullRequestCheckCategory | null {
  if (pendingCheckStatuses.has(status) && conclusion === null) {
    return SelectedPullRequestCheckCategory.Pending;
  }
  if (status !== ProviderCheckStatus.Completed || conclusion === null) {
    return null;
  }
  if (conclusion === ProviderCheckConclusion.Success) {
    return SelectedPullRequestCheckCategory.Successful;
  }
  if (neutralCheckConclusions.has(conclusion)) {
    return SelectedPullRequestCheckCategory.Neutral;
  }
  if (failingCheckConclusions.has(conclusion)) {
    return SelectedPullRequestCheckCategory.Failing;
  }
  return null;
}

function classifyStatusContext(
  state: string
): SelectedPullRequestCheckCategory | null {
  if (pendingStatusContextStates.has(state)) {
    return SelectedPullRequestCheckCategory.Pending;
  }
  if (state === ProviderStatusContextState.Success) {
    return SelectedPullRequestCheckCategory.Successful;
  }
  if (failingStatusContextStates.has(state)) {
    return SelectedPullRequestCheckCategory.Failing;
  }
  return null;
}

function normalizeApp(input: z.infer<typeof appSchema> | null) {
  if (!input) {
    return null;
  }
  return {
    nodeId: input.id,
    databaseId: input.databaseId ?? null,
    slug: input.slug ?? null,
    name: input.name,
    url: input.url ?? null,
  } satisfies SelectedPullRequestCheckApp;
}

function buildCheckRunSourceIdentity(
  app: SelectedPullRequestCheckApp | null,
  name: string,
  providerId: string
): string {
  const appIdentity = app?.nodeId ?? app?.slug ?? app?.name ?? providerId;
  return `${SelectedPullRequestCheckSourceKind.CheckRun}:${appIdentity}:${name}`;
}

function compareAttempts(
  selected: SelectedPullRequestCheckAttempt,
  candidate: SelectedPullRequestCheckAttempt
): AttemptComparison {
  if (selected.observedAt && candidate.observedAt) {
    const timeDifference =
      Date.parse(candidate.observedAt) - Date.parse(selected.observedAt);
    if (timeDifference !== 0) {
      return {
        ambiguous:
          selected.observedAtIsAmbiguous || candidate.observedAtIsAmbiguous,
        useCandidate: timeDifference > 0,
      };
    }
  }
  return {
    ambiguous: true,
    useCandidate: compareAttemptTieBreakers(selected, candidate) < 0,
  };
}

function compareAttemptTieBreakers(
  left: SelectedPullRequestCheckAttempt,
  right: SelectedPullRequestCheckAttempt
): number {
  const idComparison = left.check.providerId.localeCompare(
    right.check.providerId
  );
  return idComparison === 0 ? left.position - right.position : idComparison;
}

function compareSelectedAttempts(
  left: SelectedPullRequestCheckAttempt,
  right: SelectedPullRequestCheckAttempt
): number {
  const nameComparison = left.check.name.localeCompare(right.check.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }
  return left.check.sourceIdentity.localeCompare(right.check.sourceIdentity);
}

function normalizeProviderValue(value: string): string {
  return value.trim().toUpperCase();
}

function valid(
  attempt: SelectedPullRequestCheckAttempt
): SelectedPullRequestCheckContextResult {
  return { ok: true, attempt };
}

function invalid(
  reason: SelectedPullRequestChecksPartialReason
): SelectedPullRequestCheckContextResult {
  return { ok: false, reason };
}

/** Normalized provider attempt plus ordering and source-identity provenance. */
export type SelectedPullRequestCheckAttempt = {
  check: SelectedPullRequestCheck;
  observedAt: string | null;
  observedAtIsAmbiguous: boolean;
  position: number;
  sourceIdentityIsAmbiguous: boolean;
};

/** Boundary-validation outcome for one provider rollup context. */
export type SelectedPullRequestCheckContextResult =
  | { ok: true; attempt: SelectedPullRequestCheckAttempt }
  | { ok: false; reason: SelectedPullRequestChecksPartialReason };

/** Latest-per-source rows plus whether source selection was ambiguous. */
export type SelectedPullRequestCheckSelection = {
  checks: SelectedPullRequestCheck[];
  hasAmbiguousSource: boolean;
};

type AttemptComparison = {
  ambiguous: boolean;
  useCandidate: boolean;
};

const ProviderContextType = {
  CheckRun: "CheckRun",
  StatusContext: "StatusContext",
} as const;

const ProviderCheckStatus = {
  Completed: "COMPLETED",
  InProgress: "IN_PROGRESS",
  Pending: "PENDING",
  Queued: "QUEUED",
  Requested: "REQUESTED",
  Waiting: "WAITING",
} as const;

const ProviderCheckConclusion = {
  ActionRequired: "ACTION_REQUIRED",
  Cancelled: "CANCELLED",
  Failure: "FAILURE",
  Neutral: "NEUTRAL",
  Skipped: "SKIPPED",
  Stale: "STALE",
  StartupFailure: "STARTUP_FAILURE",
  Success: "SUCCESS",
  TimedOut: "TIMED_OUT",
} as const;

const ProviderStatusContextState = {
  Error: "ERROR",
  Expected: "EXPECTED",
  Failure: "FAILURE",
  Pending: "PENDING",
  Success: "SUCCESS",
} as const;

const contextTypeSchema = z.object({
  __typename: z.string(),
});

const httpUrlSchema = z
  .url()
  .refine((value) => HTTP_URL_PROTOCOL_REGEX.test(value));
const nullableHttpUrlSchema = httpUrlSchema.nullish();
const nullableDateTimeSchema = z.iso.datetime({ offset: true }).nullish();

const appSchema = z.object({
  id: z.string().trim().min(1),
  databaseId: z.number().int().nonnegative().nullish(),
  slug: z.string().trim().min(1).nullish(),
  name: z.string().trim().min(1),
  url: nullableHttpUrlSchema,
});

const checkRunSchema = z.object({
  __typename: z.literal(ProviderContextType.CheckRun),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  status: z.string().trim().min(1),
  conclusion: z.string().trim().min(1).nullish(),
  createdAt: nullableDateTimeSchema,
  startedAt: nullableDateTimeSchema,
  completedAt: nullableDateTimeSchema,
  detailsUrl: nullableHttpUrlSchema,
  url: nullableHttpUrlSchema,
  checkSuite: z.object({ app: appSchema.nullable() }).nullish(),
});

const statusContextSchema = z.object({
  __typename: z.literal(ProviderContextType.StatusContext),
  context: z.string().trim().min(1),
  state: z.string().trim().min(1),
  createdAt: nullableDateTimeSchema,
  targetUrl: nullableHttpUrlSchema,
});

const pendingCheckStatuses = new Set<string>([
  ProviderCheckStatus.InProgress,
  ProviderCheckStatus.Pending,
  ProviderCheckStatus.Queued,
  ProviderCheckStatus.Requested,
  ProviderCheckStatus.Waiting,
]);

const neutralCheckConclusions = new Set<string>([
  ProviderCheckConclusion.Cancelled,
  ProviderCheckConclusion.Neutral,
  ProviderCheckConclusion.Skipped,
]);

const failingCheckConclusions = new Set<string>([
  ProviderCheckConclusion.ActionRequired,
  ProviderCheckConclusion.Failure,
  ProviderCheckConclusion.Stale,
  ProviderCheckConclusion.StartupFailure,
  ProviderCheckConclusion.TimedOut,
]);

const pendingStatusContextStates = new Set<string>([
  ProviderStatusContextState.Expected,
  ProviderStatusContextState.Pending,
]);

const failingStatusContextStates = new Set<string>([
  ProviderStatusContextState.Error,
  ProviderStatusContextState.Failure,
]);

const HTTP_URL_PROTOCOL_REGEX = /^https?:\/\//;
