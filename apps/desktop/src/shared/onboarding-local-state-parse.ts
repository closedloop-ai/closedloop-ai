/**
 * @file onboarding-local-state-parse.ts
 * @description ISS-8376 — the RENDERER's boundary validator for the onboarding
 * local-state payload.
 *
 * Split from `onboarding-local-state-contract.ts` so the preload bundle can
 * import the channel constant without pulling Zod into a synchronous CJS bundle
 * evaluated before first render (root `AGENTS.md`: split constants from
 * parsers). Only the renderer imports this module.
 */

import { z } from "zod";
import {
  type AnalysisEtaWireShape,
  ONBOARDING_INVENTORY_NO_REVISION,
  OnboardingHarness,
  OnboardingHarnessOutcome,
  OnboardingInventoryCompleteness,
  OnboardingInventoryStatus,
  type OnboardingInventoryWire,
  type OnboardingLocalStateWire,
} from "./onboarding-local-state-contract.js";
import {
  AnalysisEtaConfidence,
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
} from "./transcript-analysis-eta-contract.js";

/**
 * A byte or count field that can be believed.
 *
 * The producer already names this exact impossible set at collection time
 * (`TranscriptExclusionReason.ImplausibleSize`), and the wire parse is a SECOND
 * trust boundary that owes the same predicate: a bare `z.number()` accepts `-1`,
 * `NaN`, `1.5` and magnitudes past the safe-integer range, every one of which
 * renders as a confident number of GB. `Number.isSafeInteger` is the whole guard
 * against fractional, non-finite and precision-lost values in one predicate.
 */
const wireByteCount = z.number().refine(Number.isSafeInteger).nonnegative();

/**
 * A duration or rate, which unlike a byte count may legitimately be fractional.
 *
 * `rawRemainingMs` is `remainingBytes / throughputBytesPerMs`, so demanding an
 * integer here would withdraw every honest estimate. What it must not be is
 * non-finite: `Infinity` formats as a countdown that never ends and `NaN` as
 * one that never starts.
 */
const wireFiniteAmount = z.number().refine(Number.isFinite).nonnegative();

/** Used only when a degraded envelope's own ETA version is unreadable. */
const ANALYSIS_ETA_FALLBACK_VERSION = 1;

const harnessSchema = z.enum([
  OnboardingHarness.Claude,
  OnboardingHarness.Codex,
  OnboardingHarness.OpenCode,
]);

const completenessSchema = z.enum([
  OnboardingInventoryCompleteness.Complete,
  OnboardingInventoryCompleteness.Partial,
  OnboardingInventoryCompleteness.Unavailable,
]);

const outcomeSchema = z.enum([
  OnboardingHarnessOutcome.Measured,
  OnboardingHarnessOutcome.Absent,
  OnboardingHarnessOutcome.Disabled,
  OnboardingHarnessOutcome.Impaired,
]);

const measuredInventorySchema = z.object({
  status: z.literal(OnboardingInventoryStatus.Measured),
  inventoryRevision: wireByteCount,
  parseCompleteness: completenessSchema,
  uploadCompleteness: completenessSchema,
  discoveredBytes: wireByteCount,
  eligibleParseBytes: wireByteCount,
  excludedBytes: wireByteCount,
  physicalBytes: wireByteCount,
  attributableRawBytes: wireByteCount,
  enumeratedHarnesses: z.array(harnessSchema),
  evidence: z.array(
    z.object({ harness: harnessSchema, outcome: outcomeSchema })
  ),
  /**
   * ISS-8346. Declared HERE and not left to arrive on its own: this is a
   * `z.object`, which STRIPS unknown keys, so an undeclared field never reaches
   * the consumer no matter what main sends.
   *
   * `.catch(undefined)` withdraws the SESSION COUNTS ALONE. A list this build
   * cannot believe — an impossible count, or a harness member a newer main
   * knows and this one does not — says nothing about the byte measurement
   * beside it, and failing the whole inventory over an additive field would
   * take the size sentence and the estimate down with it. Same per-member
   * withdrawal `withCredibleEta` performs for the estimate, for the same
   * reason.
   */
  sessionsByHarness: z
    .array(
      z.object({
        harness: harnessSchema,
        // POSITIVE: the producer omits a harness it could not count, so a `0`
        // crossing this boundary is an absence nobody measured.
        sessionCount: wireByteCount.refine((count) => count > 0),
      })
    )
    // A COLLECTION-level invariant the per-entry checks cannot see: one row per
    // harness. Two Claude rows are each individually valid, and the fold sums
    // its population in one pass, so both would render AND both would land in
    // the total — an inflated headline over a duplicated source row, with the
    // harness still counted as enumerated. There is no way to tell which of the
    // two is the measurement, so the list is withdrawn rather than deduped.
    .refine(
      (rows) => new Set(rows.map((row) => row.harness)).size === rows.length
    )
    .optional()
    .catch(undefined),
  /**
   * ISS-10624. Declared for the same reason as the field above: `z.object`
   * STRIPS unknown keys, so an undeclared numerator never reaches the consumer
   * no matter what main sends.
   *
   * `.catch(undefined)` withdraws the NUMERATOR ALONE. A figure this build
   * cannot believe says nothing about the byte total beside it, and failing the
   * whole inventory over an additive field would take the size sentence, the
   * session counts and the estimate down with it.
   *
   * NOT checked against `eligibleParseBytes` here: a per-field `.catch` cannot
   * see a sibling. The consumer that divides holds that invariant, which is
   * where it can also fall back to the older ETA route rather than withdrawing
   * the percentage outright.
   */
  parsedBytes: wireByteCount.optional().catch(undefined),
});

const unavailableInventorySchema = z.object({
  status: z.literal(OnboardingInventoryStatus.Unavailable),
});

/**
 * LOOSE on purpose.
 *
 * `z.object` STRIPS unknown keys, which on a shape declaring only three of them
 * would delete `remainingMs`, `reason`, `confidence`, `throughputBytesPerMs`
 * and the rest — the ETA is half this payload's reason to exist, and the
 * renderer would receive a three-key husk typed as a full estimate. The ETA's
 * own module owns its full shape and its key witness; this boundary validates
 * the discriminator and the two numbers a consumer orders on, and passes the
 * kind-specific members through untouched.
 *
 * `kind` is `z.string()` HERE and narrowed to the closed set AFTER the parse,
 * in `withCredibleEta`. A `z.enum` at this position would reject the whole
 * envelope when a newer main names a kind this build has not heard of, taking
 * the inventory down with it; the post-parse narrowing withdraws only the
 * estimate. A consumer still switches on `kind`, so it never sees an arbitrary
 * string — that is the silent-default hole this repo's review lessons name.
 */
const analysisEtaSchema = z.looseObject({
  contractVersion: wireByteCount,
  inventoryRevision: wireByteCount,
  kind: z.string(),
});

/**
 * Per-kind schemas: what each variant must actually carry to be believed.
 *
 * The envelope schema above validates only the three members every kind shares,
 * so before this a `measured` estimate with `remainingMs: "oops"` — or with no
 * `remainingMs` at all — reached the renderer typed as a full estimate and was
 * rendered as a countdown. The discriminator alone is not the contract; the
 * fields a consumer of that discriminator then reads are.
 *
 * LOOSE per variant, for the same reason the envelope is: a newer main adding a
 * member to one kind must not have its whole estimate withdrawn over a field
 * this build never reads.
 *
 * `reason` is checked for presence, NOT against the closed reason set. An
 * `unavailable` with no reason is incoherent — the kind's whole contract is
 * that the reason says why — but an unrecognized reason from a newer main is
 * not, and withdrawing it would substitute `progress-indeterminate`, a
 * different and specific claim about the parse lane that we would be inventing.
 */
const CREDIBLE_ETA_BY_KIND: Record<AnalysisEtaKind, z.ZodTypeAny> = {
  [AnalysisEtaKind.Measured]: z.looseObject({
    remainingMs: wireFiniteAmount,
    rawRemainingMs: wireFiniteAmount,
    remainingBytes: wireByteCount,
    throughputBytesPerMs: z.number().refine(Number.isFinite).positive(),
    confidence: z.enum([
      AnalysisEtaConfidence.Provisional,
      AnalysisEtaConfidence.Established,
    ]),
    retainedSampleCount: wireByteCount,
    activeElapsedMs: wireFiniteAmount,
  }),
  [AnalysisEtaKind.Calculating]: z.looseObject({
    retainedSampleCount: wireByteCount,
    activeElapsedMs: wireFiniteAmount,
  }),
  [AnalysisEtaKind.Unavailable]: z.looseObject({ reason: z.string().min(1) }),
  [AnalysisEtaKind.Complete]: z.looseObject({}),
};

/**
 * The same table as a `Map`, because the key comes off the wire.
 *
 * DERIVED from the exhaustive `Record` above rather than written out again, so
 * a kind added to `AnalysisEtaKind` still fails `tsc` there and is carried here
 * for free. A plain object indexed by an untrusted string is the hazard this
 * avoids: `kind: "__proto__"` resolves to `Object.prototype`, which is truthy
 * and has no `safeParse`, so the guard would throw instead of withdrawing.
 */
const CREDIBLE_ETA_LOOKUP = new Map<string, z.ZodTypeAny>(
  Object.entries(CREDIBLE_ETA_BY_KIND)
);

/** The estimate a consumer is given when the real one cannot be understood. */
const WITHDRAWN_ETA = {
  contractVersion: ANALYSIS_ETA_FALLBACK_VERSION,
  inventoryRevision: ONBOARDING_INVENTORY_NO_REVISION,
  kind: AnalysisEtaKind.Unavailable,
  reason: AnalysisEtaUnavailableReason.ProgressIndeterminate,
} as const;

const onboardingLocalStateSchema = z.object({
  contractVersion: z.number(),
  computeTargetId: z.string().min(1).nullish(),
  attemptId: z.string().min(1).nullish(),
  inventory: z.union([measuredInventorySchema, unavailableInventorySchema]),
  analysisEta: analysisEtaSchema,
});

/**
 * `null` for any payload this build cannot validate — never a partial record.
 *
 * A measured inventory whose numbers fail the byte predicate degrades to the
 * `unavailable` variant rather than being clamped: a clamped byte total is
 * exactly the plausible-looking lie the producer refuses to emit. The ETA is
 * degraded WITH it — an estimate is derived from the inventory, so an inventory
 * that cannot be believed cannot leave a `complete` ETA standing beside it
 * claiming the analysis finished.
 */
export function parseOnboardingLocalState(
  value: unknown
): OnboardingLocalStateWire | null {
  const parsed = onboardingLocalStateSchema.safeParse(value);
  if (parsed.success) {
    return toWire(withCredibleEta(withAgreedRevision(parsed.data)));
  }
  return degradeInventory(value);
}

/**
 * Withdraw BOTH halves when they disagree about which sweep they describe.
 *
 * The two revisions are one fact stated twice: the producer rebases the ETA
 * fold onto each new inventory precisely so they cannot diverge. A payload
 * where they differ is a skewed or buggy main, and neither half can be trusted
 * to describe the other — so this withdraws the pair rather than picking a
 * winner it has no basis to pick.
 *
 * Load-bearing beyond mere tidiness: the renderer orders replies by the ETA's
 * revision and holds the highest one seen. One incoherent payload naming a
 * revision above the real one is accepted, becomes the held floor, and then
 * every genuine follow-up reads as superseded — the hook freezes on the bad
 * snapshot for the life of the poll. Withdrawing leaves the sentinel revision,
 * which is below every minted value, so the next coherent payload is accepted.
 */
function withAgreedRevision(data: ParsedEnvelope): ParsedEnvelope {
  if (data.inventory.status !== OnboardingInventoryStatus.Measured) {
    return data;
  }
  if (data.inventory.inventoryRevision === data.analysisEta.inventoryRevision) {
    return data;
  }
  return {
    ...data,
    inventory: { status: OnboardingInventoryStatus.Unavailable },
    analysisEta: { ...WITHDRAWN_ETA },
  };
}

/**
 * Withdraw an estimate this build cannot believe, keeping the inventory.
 *
 * Two ways to fail one check, because they are the same defect at different
 * depths: a `kind` we do not recognize, and a kind we do recognize carrying
 * members that are missing or impossible. Either one reaching a consumer that
 * switches on `kind` and then reads those members is the silent-default hole.
 *
 * It degrades the ESTIMATE only. A newer main naming a kind we have never heard
 * of says nothing about the inventory measured beside it, and rejecting the
 * whole payload over it would be the strict-boundary defect this repo's review
 * lessons name.
 */
function withCredibleEta(data: ParsedEnvelope): ParsedEnvelope {
  const credible = CREDIBLE_ETA_LOOKUP.get(data.analysisEta.kind);
  if (credible?.safeParse(data.analysisEta).success) {
    return data;
  }
  return {
    ...data,
    analysisEta: {
      ...WITHDRAWN_ETA,
      // The REVISION survives the withdrawal, and must. It was validated by the
      // envelope schema, `withAgreedRevision` has already proved it agrees with
      // the inventory, and the renderer orders replies by it: resetting it to
      // the sentinel would make this payload read as older than the last good
      // one, so the hook would drop it and every later poll, freezing on a
      // stale estimate instead of showing that there is none.
      inventoryRevision: data.analysisEta.inventoryRevision,
    },
  };
}

type ParsedEnvelope = z.infer<typeof onboardingLocalStateSchema>;

function toWire(data: ParsedEnvelope): OnboardingLocalStateWire {
  const { computeTargetId, attemptId, ...rest } = data;
  return {
    contractVersion: rest.contractVersion,
    inventory: rest.inventory as OnboardingInventoryWire,
    analysisEta: rest.analysisEta as AnalysisEtaWireShape,
    ...(computeTargetId ? { computeTargetId } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
}

/**
 * Retry the envelope with BOTH the inventory and the estimate withdrawn.
 *
 * Reached when the only thing wrong with a payload is its measured inventory —
 * a skewed or buggy main emitting an impossible byte count. The envelope is
 * still usable, but the ETA that came with it was derived from the measurement
 * that just failed, so keeping it would let `discoveredBytes: -1` arrive
 * alongside `kind: "complete"` and read as a finished analysis.
 */
function degradeInventory(value: unknown): OnboardingLocalStateWire | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Record<string, unknown>;
  const eta = source.analysisEta;
  // Only an otherwise-sound envelope is salvageable. A payload that never
  // carried an estimate is not one whose inventory went bad — it is not this
  // contract's shape at all, and synthesizing the missing half would fabricate
  // a valid-looking answer out of garbage.
  if (!eta || typeof eta !== "object") {
    return null;
  }
  const degraded = {
    ...source,
    inventory: { status: OnboardingInventoryStatus.Unavailable },
    analysisEta: {
      contractVersion:
        (eta as AnalysisEtaWireShape).contractVersion ??
        ANALYSIS_ETA_FALLBACK_VERSION,
      inventoryRevision: 0,
      kind: "unavailable",
      reason: "progress-indeterminate",
    },
  };
  const parsed = onboardingLocalStateSchema.safeParse(degraded);
  if (!parsed.success) {
    return null;
  }
  return toWire(parsed.data);
}
