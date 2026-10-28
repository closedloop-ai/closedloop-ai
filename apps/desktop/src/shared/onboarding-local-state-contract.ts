/**
 * @file onboarding-local-state-contract.ts
 * @description ISS-8376 — the main→renderer contract for the onboarding view
 * model's DESKTOP-LOCAL facts: the transcript byte inventory (ISS-8506) and the
 * analysis ETA (ISS-8507).
 *
 * ZOD-FREE ON PURPOSE. The preload bridge imports the channel constant from
 * here, and `vite.preload.config.ts` builds preload as one self-contained CJS
 * bundle evaluated synchronously before first render. Root `AGENTS.md`: "Do not
 * make a widely used component import a mixed helper module solely for
 * constants if that module also imports heavy parsing/validation libraries such
 * as Zod; split constants from parsers so bundle-sensitive consumers can import
 * only the lightweight values." The parser lives in
 * `onboarding-local-state-parse.ts`, which only the renderer imports.
 *
 * Also node-free — the renderer tsconfig has no `@types/node`.
 *
 * WHY THE VOCABULARY IS MIRRORED HERE. `src/shared/` has no `src/main/` imports
 * at all, and Biome's `noBarrelFile` forbids re-exporting runtime bindings the
 * other way (`transcript-sync-types.ts:25`), so moving the producer's consts
 * would mean rewriting 24 value-import sites. Instead the main-side projection
 * (`onboarding-local-state-source.ts`) carries an exhaustive
 * `Record<TranscriptSourceHarness, OnboardingHarness>` and siblings, so adding a
 * producer member fails `tsc` there until it is mapped. That witness is what
 * makes these mirrors safe; without it they would be SSOT drift by copy.
 */

/**
 * The read channel.
 *
 * Declared here rather than inline in `OnboardingIpcChannel` so main, the
 * preload bridge and the renderer adapter all name one declaration; the registry
 * takes it as a member. A channel in the registry but missing from the preload's
 * `createDesktopApi` object typechecks everywhere and never dispatches, which is
 * what the preload-hop test exists to catch.
 */
export const ONBOARDING_LOCAL_STATE_CHANNEL =
  "desktop:get-onboarding-local-state";

/**
 * Bumped when the shape below changes in a way a consumer must notice.
 *
 * Separate from `ANALYSIS_ETA_CONTRACT_VERSION`, which versions the nested ETA
 * alone: this envelope can gain a field without the ETA shape moving, and the
 * ETA can move without this envelope changing. A consumer reads whichever
 * version gates the shape it is about to use.
 */
export const ONBOARDING_LOCAL_STATE_CONTRACT_VERSION = 2;

/** Whether the corpus measurement exists yet. */
export const OnboardingInventoryStatus = {
  /** A real sweep landed. Its completeness says how much of it to believe. */
  Measured: "measured",
  /**
   * No sweep has landed. NOT a zero: the sweep is one-shot and runs off-thread,
   * so this is the honest state before it returns and after one that failed.
   */
  Unavailable: "unavailable",
} as const;
export type OnboardingInventoryStatus =
  (typeof OnboardingInventoryStatus)[keyof typeof OnboardingInventoryStatus];

/** Mirrors `TranscriptSourceHarness`; the source's witness maps it exhaustively. */
export const OnboardingHarness = {
  Claude: "claude",
  Codex: "codex",
  OpenCode: "opencode",
} as const;
export type OnboardingHarness =
  (typeof OnboardingHarness)[keyof typeof OnboardingHarness];

/** Mirrors `TranscriptHarnessOutcome`; the source's witness maps it exhaustively. */
export const OnboardingHarnessOutcome = {
  Measured: "measured",
  Absent: "absent",
  Disabled: "disabled",
  Impaired: "impaired",
} as const;
export type OnboardingHarnessOutcome =
  (typeof OnboardingHarnessOutcome)[keyof typeof OnboardingHarnessOutcome];

/** Mirrors `TranscriptInventoryCompleteness`; the witness maps it exhaustively. */
export const OnboardingInventoryCompleteness = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
} as const;
export type OnboardingInventoryCompleteness =
  (typeof OnboardingInventoryCompleteness)[keyof typeof OnboardingInventoryCompleteness];

/**
 * The revision a payload carries before any sweep has landed.
 *
 * `0` and NOT `mintInventoryRevision()`. That minter is a module-level monotone
 * counter shared with the real collector and starts at 1, so minting one per
 * read would burn 1..N and the real inventory would then arrive carrying a
 * LOWER revision than a consumer had already seen. A fixed sentinel below every
 * minted value can never outrank one.
 */
export const ONBOARDING_INVENTORY_NO_REVISION = 0;

export type OnboardingHarnessEvidenceWire = {
  harness: OnboardingHarness;
  outcome: OnboardingHarnessOutcome;
};

/** How many distinct sessions the sweep discovered for one harness (ISS-8346). */
export type OnboardingHarnessSessionCountWire = {
  harness: OnboardingHarness;
  sessionCount: number;
};

/**
 * The SAFE projection of `TranscriptByteInventory`.
 *
 * Three producer fields are deliberately not carried, and the main-side witness
 * names each one so a new producer field fails `tsc` rather than being dropped
 * in silence: `eligibleFiles` (up to 20,000 rows of session ids and file keys —
 * user data with no onboarding consumer), `impairments` (carries a
 * home-abbreviated path), and the two exclusion tallies (diagnostic; the
 * completeness verdicts already carry the honesty signal a view model needs).
 *
 * `excludedBytes` IS carried: the producer's partition invariant is
 * `discoveredBytes === eligibleParseBytes + excludedBytes`, and dropping it
 * would leave a consumer unable to reconcile the two totals it does receive.
 */
export type OnboardingInventoryWire =
  | {
      status: typeof OnboardingInventoryStatus.Measured;
      inventoryRevision: number;
      parseCompleteness: OnboardingInventoryCompleteness;
      uploadCompleteness: OnboardingInventoryCompleteness;
      discoveredBytes: number;
      eligibleParseBytes: number;
      excludedBytes: number;
      physicalBytes: number;
      attributableRawBytes: number;
      enumeratedHarnesses: readonly OnboardingHarness[];
      evidence: readonly OnboardingHarnessEvidenceWire[];
      /**
       * Distinct sessions discovered per harness (ISS-8346).
       *
       * OPTIONAL because a desktop build older than contract version 2 does not
       * send it, and a renderer that requires it would blank a measurement that
       * build made perfectly well. Absent means NOT REPORTED, never zero.
       * Omitted when absent, never `null` — the receiving contract does not
       * declare it nullable.
       *
       * What the consumer degrades TO, on a v1 payload: the per-source counts,
       * the session total and the percentage are all withheld, while the bytes
       * and the estimate render unchanged. A v1 build still sends `evidence`
       * with a row per probe, so every harness it enumerated reads as walked
       * and uncounted, the enumeration is SHORT, and the byte fallback — gated
       * on a whole enumeration — does not fire either. That is the honest
       * outcome rather than a shortfall: a build that cannot enumerate sessions
       * should state no session figure, and nothing here fails.
       *
       * A harness the producer could not faithfully enumerate has no entry
       * here, so this list is routinely SHORTER than `enumeratedHarnesses`. That
       * is not a gap in the payload; it is the producer refusing to state a
       * count it cannot substantiate.
       */
      sessionsByHarness?: readonly OnboardingHarnessSessionCountWire[];
      /**
       * Bytes of `eligibleParseBytes` the parse lane has already processed
       * (ISS-10624).
       *
       * THE NUMERATOR FOR THE DENOMINATOR ALREADY ON THIS ARM. Before this
       * field, a byte numerator reached the renderer only as
       * `AnalysisEtaWire.remainingBytes`, which ONLY the `measured` ETA arm
       * carries — so during the entire `calculating` window, the one window in
       * which a progress bar is worth rendering, the renderer held a
       * denominator and no numerator and could state no percentage at all. A
       * percentage does not need a throughput rate; the estimate is
       * `calculating` precisely because it HAS byte progress and not yet enough
       * samples to state a TIME.
       *
       * Carried as the DONE figure rather than a remainder because that is the
       * unit the producer's fold already holds: `ParseProgressFold` keeps its
       * high-water mark in processed bytes, so a remainder here would be that
       * number inverted against the denominator by the producer and inverted
       * back by the consumer, with two chances to disagree about which total.
       *
       * OPTIONAL because a desktop build older than this field does not send
       * it. Absent means NOT REPORTED, never zero — a zero would tell the
       * renderer the parse lane has done nothing, which on a machine mid-import
       * is a measurement nobody took. Omitted when absent, never `null`: the
       * receiving contract does not declare it nullable.
       *
       * What the consumer degrades TO when it is absent: exactly today's
       * behaviour — the byte ratio comes from the ETA's `remainingBytes` when a
       * `measured` estimate carries one, and is withheld otherwise.
       *
       * {@link ONBOARDING_LOCAL_STATE_CONTRACT_VERSION} is deliberately NOT
       * bumped for it. That number is bumped when a consumer MUST notice a
       * change, and no consumer must: this field is detected by presence, and a
       * renderer that gates on a version instead would blank the numerator of
       * any main process whose envelope version it did not recognize.
       *
       * Reported ONLY when the parse fold states a measured position for this
       * read. The fold owns the high-water mark and the countability refusal,
       * so an indeterminate lane sends nothing rather than a stale or clamped
       * number, and `parsedBytes <= eligibleParseBytes` holds by construction —
       * both come from one sweep, named by the `inventoryRevision` beside them.
       */
      parsedBytes?: number;
    }
  | { status: typeof OnboardingInventoryStatus.Unavailable };

/**
 * The transported shape.
 *
 * `computeTargetId` and `attemptId` are OMITTED when absent, never `null`: this
 * crosses to a possibly version-skewed renderer and the receiving contract does
 * not declare them nullable. `attemptId` is echoed back from the request so the
 * renderer can drop a response belonging to a prior onboarding attempt — the
 * second axis the acceptance criterion names beside identity.
 */
export type OnboardingLocalStateWire = {
  contractVersion: number;
  computeTargetId?: string;
  attemptId?: string;
  inventory: OnboardingInventoryWire;
  analysisEta: AnalysisEtaWireShape;
};

/**
 * The ETA as it crosses this envelope.
 *
 * Structurally `AnalysisEtaWire` from `transcript-analysis-eta-contract.ts`,
 * restated as a type-only alias so this module stays free of that one's imports.
 * The parser validates it with a LOOSE object so the optional members
 * (`remainingMs`, `reason`, `confidence`, …) survive the boundary rather than
 * being stripped by a strict shape that only knows three keys.
 */
export type AnalysisEtaWireShape = {
  contractVersion: number;
  inventoryRevision: number;
  kind: string;
  reason?: string;
  remainingMs?: number;
  rawRemainingMs?: number;
  remainingBytes?: number;
  throughputBytesPerMs?: number;
  confidence?: string;
  retainedSampleCount?: number;
  activeElapsedMs?: number;
};
