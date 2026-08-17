/**
 * Honest execution-boundary state vocabulary for the harness-format convert
 * engine (FEA-4079).
 *
 * The convert engine (desktop gateway, `apps/desktop/src/main/packs/convert-engine.ts`)
 * converts an agentic component from one harness's format to another's and then
 * installs it, as ONE gateway operation. The engine's status is what the UI
 * trusts, so the boundary must never lie: a lossy conversion reports `partial`,
 * an impossible one `unsupported`, and a failure distinguishes a *transient*
 * (retryable) cause from a *permanent* one — never a silent lossy write dressed
 * up as success.
 *
 * This lives in `packages/api/src/types` (the canonical shared-types home)
 * because the vocabulary crosses surfaces: the desktop MAIN process produces it,
 * and both `apps/app` and the desktop renderer consume it. It is deliberately
 * NOT co-located in `packages/app` — the sibling display vocabulary
 * `PackInstallState`
 * (`@repo/app/packs/lib/install-state`, FEA-4083) lives there but is
 * UNREACHABLE from the desktop main process, whose `nodenext` resolution cannot
 * pull `@repo/app`'s `.tsx` design-system dependencies (the same reason
 * `@repo/app/branches/lib/branch-derivations` is unreachable in main). A
 * transport-neutral, dependency-light module here resolves identically in the
 * browser, the desktop renderer, AND Node.
 *
 * Two overlapping-but-distinct vocabularies exist and are NOT restated as logic
 * here:
 *  - `PackInstallState` (`@repo/app/packs/lib/install-state`, FEA-4083) — the UI
 *    DISPLAY state a packs surface *draws* (installed / converting / unsupported
 *    / …). The overlapping terminal states below share its LITERAL string values
 *    verbatim (`"installed"`, `"converting"`, `"unsupported"`) so the engine's
 *    outcome maps cleanly onto what the UI already renders — but the const is not
 *    imported because it is unreachable from main (above). A round-trip test
 *    pins the literals equal so the two cannot drift.
 *  - `ConversionSupport` (`./harness-conversion.ts`, FEA-4078) — the
 *    PRE-execution capability verdict (supported / partial / unsupported) the
 *    capability map resolves. That answers "what WOULD a convert do?"; this
 *    module answers "what DID it do?" at the execution boundary.
 *
 * What is net-new here (no equivalent in either vocabulary above):
 *  - `Partial` — a POST-execution outcome: the component installed, but the
 *    target format could not carry every source field. `PackInstallState` has no
 *    partial; `ConversionSupport.Partial` is only the pre-execution verdict.
 *  - `Error` plus a transient-vs-permanent failure class — the retry-eligibility
 *    axis `apps/desktop/AGENTS.md` mandates.
 *
 * Const-object enums (never a TS `enum`, never bare literals), per the
 * repo-sanctioned idiom.
 */

import type { HarnessName } from "@repo/crewd/model";
import { harnessNameSchema } from "@repo/crewd/model";
import { z } from "zod";
import type { AgentComponentKind } from "./agent-component.ts";
import type {
  ConversionCapability,
  ConvertedComponentIdentity,
} from "./harness-conversion.ts";
import {
  agentComponentKindSchema,
  ConversionSupport,
} from "./harness-conversion.ts";

/**
 * The honest state the convert engine reports at the execution boundary.
 *
 * The overlapping terminal states carry the SAME literal values as their
 * `PackInstallState` counterparts
 * (`"converting"`, `"installed"`, `"unsupported"`) so the engine's outcome
 * renders with the UI's existing treatment; the two states with no
 * `PackInstallState` equivalent (`Partial`, `Error`) are named here.
 */
export const ConvertInstallState = {
  /** The convert + install is in flight (mirrors the UI's `"converting"`). */
  Converting: "converting",
  /** Converted losslessly and installed — nothing was dropped. */
  Installed: "installed",
  /**
   * Installed, but the target format could not carry every source field, so the
   * named dropped fields were dropped. A truthful "installed with loss" — NOT a
   * silent success. Post-execution only; there is no `PackInstallState` member
   * for it.
   */
  Partial: "partial",
  /**
   * No conversion exists for this component kind on this harness pair — the
   * convert is impossible and nothing is installed (mirrors the UI's
   * `"unsupported"`). A PERMANENT impossibility mapping to
   * {@link ConvertFailureClass.NotApplicable}.
   */
  Unsupported: "unsupported",
  /**
   * The convert or install failed. Carries a {@link ConvertFailureClass} that
   * says whether a retry could succeed (transient) or the cause is permanent.
   */
  Error: "error",
} as const;
export type ConvertInstallState =
  (typeof ConvertInstallState)[keyof typeof ConvertInstallState];

export const convertInstallStateSchema = z.enum([
  ConvertInstallState.Converting,
  ConvertInstallState.Installed,
  ConvertInstallState.Partial,
  ConvertInstallState.Unsupported,
  ConvertInstallState.Error,
]);

/**
 * Retry-eligibility classification for a convert/install failure, per the
 * `apps/desktop/AGENTS.md` rule: "Distinguish transient failures (network
 * timeout, CLI not found in PATH, gh auth expired) from permanent impossibility
 * (no git directory, file format unsupported). Only set `not_applicable` … for
 * the latter; transient failures should leave retry eligibility intact."
 */
export const ConvertFailureClass = {
  /**
   * A retryable failure — the same convert could succeed on a later attempt
   * (network timeout, CLI not yet on PATH, an in-flight run, a runtime not ready
   * yet). Retry eligibility is preserved.
   */
  Transient: "transient",
  /**
   * A permanent impossibility — retrying cannot succeed (unsupported format,
   * missing project directory, no install command for the harness). The engine
   * must NOT keep it retry-eligible.
   */
  Permanent: "permanent",
  /**
   * The canonical `not_applicable` terminal from `apps/desktop/AGENTS.md` — a
   * permanent impossibility that is specifically "this can never apply here"
   * (the unsupported-kind case). A subtype of permanent, named explicitly so the
   * unsupported path is unambiguous and never mistaken for a retryable error.
   */
  NotApplicable: "not_applicable",
} as const;
export type ConvertFailureClass =
  (typeof ConvertFailureClass)[keyof typeof ConvertFailureClass];

export const convertFailureClassSchema = z.enum([
  ConvertFailureClass.Transient,
  ConvertFailureClass.Permanent,
  ConvertFailureClass.NotApplicable,
]);

/**
 * `true` iff a failure class is permanent (retrying cannot help). Both
 * {@link ConvertFailureClass.Permanent} and its
 * {@link ConvertFailureClass.NotApplicable} subtype are permanent; only
 * {@link ConvertFailureClass.Transient} leaves retry eligibility intact.
 */
export function isPermanentFailure(failureClass: ConvertFailureClass): boolean {
  return failureClass !== ConvertFailureClass.Transient;
}

/**
 * One component to convert-install (FEA-4079). Transport-neutral: the desktop
 * renderer sends it to the main-process convert engine over IPC. `packId` is the
 * vetted catalog pack carrying the install command (the install trust anchor);
 * the harness/kind fields key the FEA-4078 capability matrix. `sourceHarness` is
 * the optional FEA-4028 provenance — the harness the component was ORIGINALLY
 * authored for — defaulting to `currentHarness` when the component has never
 * been converted.
 */
export type ConvertInstallRequest = {
  /** The vetted catalog pack id carrying the install command. */
  readonly packId: string;
  /** Human-facing name (echoed onto the result identity). */
  readonly name: string;
  /** The component kind that keys the capability matrix. */
  readonly kind: AgentComponentKind;
  /** The harness whose FORMAT the component is in now (matrix source axis). */
  readonly currentHarness: HarnessName;
  /** The harness to convert-install to (matrix target axis). */
  readonly targetHarness: HarnessName;
  /**
   * Optional original provenance (FEA-4028); defaults to {@link currentHarness}
   * when omitted.
   */
  readonly sourceHarness?: HarnessName;
  /** Optional validated project cwd forwarded to the install subprocess. */
  readonly cwd?: string;
};

/**
 * The honest outcome of a convert-install (FEA-4079). `state` is the boundary
 * state the UI trusts; `capability` is the resolved pre-execution verdict;
 * `droppedFields` are the source-format fields the target could not carry
 * (non-empty only for a `Partial` outcome). `identity` preserves provenance. On
 * `Error` (and the permanent `Unsupported`), `failureClass` says whether a retry
 * could succeed.
 */
export type ConvertInstallOutcome = {
  readonly state: ConvertInstallState;
  readonly identity: ConvertedComponentIdentity;
  readonly capability: ConversionCapability;
  readonly droppedFields: readonly string[];
  /** Present for `Unsupported` and `Error`; absent for a successful outcome. */
  readonly failureClass?: ConvertFailureClass;
  /** The started install run id, when an install was launched. */
  readonly runId?: number;
  /** An actionable, engine-detail-free message for a failure/skip. */
  readonly message?: string;
};

/**
 * The Zod schema validating a {@link ConvertInstallRequest} at the gateway
 * operation boundary. Co-located with the type (per the `packages/api` rule that
 * a validator lives beside the exported contract) and BOUND to it by the
 * {@link convertInstallRequestSchemaCoversType} keys-covered guard below, so the
 * next field added to {@link ConvertInstallRequest} fails `tsc` here instead of
 * being silently stripped at the IPC boundary. `kind` and the harness fields
 * reuse the canonical FEA-4078/crewd schemas so the accepted set stays exactly
 * the capability map's axes; `sourceHarness` and `cwd` are optional (provenance
 * defaults to `currentHarness`; cwd is validated again downstream by
 * `resolveSpawnCwd`).
 */
export const convertInstallRequestSchema = z.object({
  packId: z.string().min(1),
  name: z.string().min(1),
  kind: agentComponentKindSchema,
  currentHarness: harnessNameSchema,
  targetHarness: harnessNameSchema,
  sourceHarness: harnessNameSchema.optional(),
  cwd: z.string().optional(),
});

/**
 * Compile-time proof that {@link convertInstallRequestSchema} has a validator for
 * EVERY field of {@link ConvertInstallRequest}, closing the schema-vs-type drift
 * wongk flagged (the two were separate sources of truth). The exported `true`
 * const uses `satisfies` to assert the schema's `.shape` is assignable to a
 * `Record<keyof ConvertInstallRequest, z.ZodTypeAny>`: a field added to the
 * request type without a matching schema key drops that key from `.shape` and
 * fails `tsc` here. Exported so it is a referenced symbol (no unused-var lint, no
 * `void`).
 */
export const convertInstallRequestSchemaCoversType: true =
  true satisfies (typeof convertInstallRequestSchema)["shape"] extends Record<
    keyof ConvertInstallRequest,
    z.ZodTypeAny
  >
    ? true
    : false;

/**
 * Build a contract-complete {@link ConvertInstallOutcome} for a boundary path
 * that never reached the convert engine (a disabled runtime, or a request that
 * failed schema validation). The `Promise<ConvertInstallOutcome>` the preload
 * exposes REQUIRES `identity`, `capability`, and `droppedFields`; omitting them
 * (as an ad-hoc `{ state, failureClass, message }` literal would) lets a consumer
 * dereference `undefined` precisely on the unavailable/invalid paths. This
 * returns a truthful, minimal-but-complete outcome: an empty
 * {@link ConversionSupport.Unsupported}-shaped capability (no convert was
 * attempted, so nothing is known to be lost), an empty `droppedFields`, and a
 * placeholder identity echoing what the caller supplied (or empty strings when
 * the request itself was unparseable).
 */
export function makeConvertInstallErrorOutcome(params: {
  readonly failureClass: ConvertFailureClass;
  readonly message: string;
  readonly identity?: ConvertedComponentIdentity;
}): ConvertInstallOutcome {
  return {
    state: ConvertInstallState.Error,
    identity: params.identity ?? EMPTY_CONVERT_IDENTITY,
    capability: EMPTY_CAPABILITY,
    droppedFields: [],
    failureClass: params.failureClass,
    message: params.message,
  };
}

/**
 * A capability cell for a boundary error path where no convert was attempted:
 * nothing is known to convert or to be lost. Distinct from a resolved map cell —
 * it only fills the required {@link ConvertInstallOutcome.capability} slot so the
 * shape is contract-complete rather than a lie.
 */
const EMPTY_CAPABILITY: ConversionCapability = {
  support: ConversionSupport.Unsupported,
  droppedFields: [],
};

/**
 * A placeholder identity for a request that could not even be parsed (so no real
 * identity is available). All-empty rather than fabricated so a consumer can tell
 * it apart from a genuine converted identity.
 */
const EMPTY_CONVERT_IDENTITY: ConvertedComponentIdentity = {
  id: "",
  name: "",
  kind: "" as AgentComponentKind,
  sourceHarness: "" as HarnessName,
  currentHarness: "" as HarnessName,
  targetHarness: "" as HarnessName,
};
