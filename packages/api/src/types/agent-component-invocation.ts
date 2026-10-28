/**
 * Runtime Agent Component invocation contracts (FEA-3294).
 *
 * This module is the shared, transport-safe owner for invocation values. It is
 * intentionally independent from the existing schema-v2 agent-session sync:
 * invocation delivery uses its own protocol, endpoint, parts, and exact
 * acknowledgements so an older API cannot silently accept and discard it.
 */

import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type { SourceOccurrence } from "./agent-component.ts";
import type { AgentComponentFindingsIngestDisposition } from "./agent-component-findings-disposition.ts";
import { AGENT_COMPONENT_FINDINGS_FUNNEL_COUNT_KEYS } from "./agent-component-findings-funnel.ts";
import type { AgentComponentInvocationAncestry } from "./agent-component-invocation-ancestry.ts";
import type { AgentComponentInvocationDurationFields } from "./agent-component-invocation-duration.ts";
import type { AgentComponentInvocationFindingsReadFields } from "./agent-component-invocation-findings.ts";
import { hasAgentComponentInvocationLines } from "./agent-component-invocation-lines.ts";
import type { AgentComponentInvocationTelemetryReadFields } from "./agent-component-invocation-telemetry.ts";
import { DesktopWriteLaneRejectReason } from "./desktop-write-lane.ts";
import { PR_INT_MAX } from "./session-artifact-link.ts";

export const AgentComponentInvocationKind = {
  Tool: "tool",
  Mcp: "mcp",
  Orchestration: "orchestration",
  Command: "command",
  Skill: "skill",
  Subagent: "subagent",
  // FEA-4093: a configured Hook that fired (captured from transcript
  // `attachment` hook_success/hook_error records). The value equals
  // `AgentComponentKind.Hook` so an invocation projects directly onto the
  // matching Hook inventory row.
  Hook: "hook",
} as const;
export type AgentComponentInvocationKind =
  (typeof AgentComponentInvocationKind)[keyof typeof AgentComponentInvocationKind];

export const AgentComponentInvocationAttributionStatus = {
  Matched: "matched",
  Unresolved: "unresolved",
  Unmatched: "unmatched",
  Ambiguous: "ambiguous",
} as const;
export type AgentComponentInvocationAttributionStatus =
  (typeof AgentComponentInvocationAttributionStatus)[keyof typeof AgentComponentInvocationAttributionStatus];

export const AgentComponentInvocationEvidenceClass = {
  TranscriptSnapshot: "transcriptSnapshot",
  CollectorSnapshot: "collectorSnapshot",
  RepositoryCommit: "repositoryCommit",
  PackMembership: "packMembership",
  /**
   * ISS-10720: the harness named the component ITSELF, on its own
   * `claude_code.cost.usage` OTel counter (ISS-7352 item E), rather than this
   * device reconstructing the name from a transcript.
   *
   * It is the one member whose evidence is not a definition: a counter carries
   * no file, hash or commit, so a row bearing this class keeps whatever exact
   * evidence it already had and only records WHICH SOURCE attributed it. Until
   * this member existed every row answered "transcript" however loudly the
   * harness had stamped the answer, which is the gap ISS-10720 names.
   */
  OtelCounter: "otelCounter",
  None: "none",
} as const;
export type AgentComponentInvocationEvidenceClass =
  (typeof AgentComponentInvocationEvidenceClass)[keyof typeof AgentComponentInvocationEvidenceClass];

/**
 * ISS-10720: WHICH SOURCE attributed this invocation to its component.
 *
 * A SECOND AXIS, deliberately not folded into
 * {@link AgentComponentInvocationEvidenceClass}. That enum answers where the
 * DEFINITION came from, and `genuineSourceOccurrence`
 * (`apps/api/app/agent-sessions/service/component-invocation-helpers.ts`) reads
 * it to build the component-detail surface's on-disk source pointer — so
 * writing an attribution answer into it would delete a provenance pointer that
 * is still perfectly well known. No operand is absent here: the `sourcePath`,
 * the definition provenance and the harness's attribution are all present. One
 * column was simply carrying two jobs that disagree.
 *
 * ABSENT MEANS TRANSCRIPT-DERIVED, which is every row written before this
 * member existed and every row the OTel join did not reach. It is therefore an
 * omitted key on the wire, never a `null` — an older Desktop build that
 * computes nothing new stays byte-identical, and the cloud column stays NULL.
 */
export const AgentComponentInvocationAttributionSource = {
  /**
   * The harness named the component itself, on its own
   * `claude_code.cost.usage` OTel counter (ISS-7352 item E).
   */
  HarnessOtel: "harnessOtel",
} as const;
export type AgentComponentInvocationAttributionSource =
  (typeof AgentComponentInvocationAttributionSource)[keyof typeof AgentComponentInvocationAttributionSource];

export const AgentComponentInvocationRelationship = {
  Direct: "direct",
  ChildSession: "childSession",
  Associated: "associated",
} as const;
export type AgentComponentInvocationRelationship =
  (typeof AgentComponentInvocationRelationship)[keyof typeof AgentComponentInvocationRelationship];

export const AgentComponentInvocationAnchorKind = {
  Event: "event",
  Agent: "agent",
  UserTurn: "userTurn",
  Timestamp: "timestamp",
  Session: "session",
} as const;
export type AgentComponentInvocationAnchorKind =
  (typeof AgentComponentInvocationAnchorKind)[keyof typeof AgentComponentInvocationAnchorKind];

export type AgentComponentInvocationAnchor =
  | {
      kind: typeof AgentComponentInvocationAnchorKind.Event;
      eventId: string;
      providerToolUseId?: string;
    }
  | {
      kind: typeof AgentComponentInvocationAnchorKind.Agent;
      agentId: string;
      externalAgentId?: string;
      transcriptFileId?: string;
    }
  | {
      kind: typeof AgentComponentInvocationAnchorKind.UserTurn;
      userTurnId: string;
    }
  | {
      kind: typeof AgentComponentInvocationAnchorKind.Timestamp;
      timestamp: string;
      ordinal: number;
    }
  | { kind: typeof AgentComponentInvocationAnchorKind.Session };

/** Dedicated invocation protocol; unrelated to agent-session schema version 2. */
export const AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION = 1 as const;

/**
 * ISS-4976 (@whitlockk / @closedloop-ai-stage review): the version a part MUST
 * declare once any of its items carries per-invocation telemetry.
 *
 * Desktop tags are cut from `main` while the API deploys from `production`, so a
 * Desktop build shipping ahead of the API is ordinary. Without a version bump
 * that build's telemetry-carrying parts would clear the already-deployed route's
 * v1 gate and then be rejected by its `.strict()` item schema as a 400, which the
 * client maps to `validation_failed` — a PERMANENT rejection that dead-letters
 * the part after five attempts and drops the generation for good.
 *
 * Declaring v2 instead hits the version gate the deployed route ALREADY has
 * (`protocolVersion !== 1` → HTTP 501 / `protocol_unsupported`), which the client
 * maps to `unavailable` and retries indefinitely without ever dead-lettering. The
 * generation simply waits and drains once the API deploys.
 *
 * The version is chosen per part from its own items, so a telemetry-free part
 * still declares v1 and is accepted by an older API exactly as it is today.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION =
  2 as const;

/**
 * ISS-7795: the version a part MUST declare once any of its items carries the
 * `usageMeasurement` label.
 *
 * v2 bought exactly one thing — that a telemetry-carrying part meets a version
 * gate an older API already has, so it answers the retryable
 * `protocol_unsupported` instead of dead-lettering. It cannot buy that for a
 * field added ON TOP of v2: an API carrying ISS-4976 but not this change
 * ACCEPTS a v2 declaration and only then rejects `usageMeasurement` as an
 * unknown key on its `.strict()` item schema — a 400 the client maps to
 * `validation_failed`, which is permanent and drops the generation for good
 * after five attempts. Since the boundary now requires the label on every
 * telemetry-carrying item, that is every such part, so the gate has to move.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION =
  3 as const;

/**
 * ISS-10718: the version a part MUST declare once any of its items carries
 * `succeeded`.
 *
 * Same reasoning as v3 and for the same reason it could not reuse v2. An API
 * that predates this change accepts a v3 declaration and only then rejects
 * `succeeded` as an unknown key on its `.strict()` item schema — a 400 the
 * client maps to `validation_failed`, which is PERMANENT and drops the
 * generation after five attempts. Declaring a version that API does not know
 * hits its version gate instead and answers the retryable
 * `protocol_unsupported`, so the generation waits and drains once the API
 * deploys (the ISS-4976 / ISS-7795 lesson).
 *
 * THE LADDER HAS NO HOLES, and that is load-bearing rather than tidy
 * (@tamsinb review). The part gate is
 * `protocolVersion < versionForItems(items)`, so declaring N asserts that this
 * build understands EVERY field introduced at or below N. Reserving 4, 5 and 6
 * for siblings in flight and taking 7 would have made that assertion false: an
 * API deployed from here would support {1,2,3,7}, and a newer Desktop part
 * carrying both `succeeded` and a sibling's v4 field derives 7 from
 * `succeeded`, clears the version gate, and is then rejected by `.strict()` for
 * the v4 field it never learned — the permanent `validation_failed` and dead
 * letter this whole constant exists to avoid. So this takes the next free
 * number at merge time and siblings renumber above it; the SUPPORTED list is
 * always UNIONED, never replaced.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_SUCCEEDED_PROTOCOL_VERSION =
  4 as const;

/**
 * ISS-10726: the version a part MUST declare once any of its items carries the
 * ISS-7796 findings funnel (`findingsEmitted` / `findingsInvalidated`).
 *
 * v5, not v4: ISS-10718 minted v4 for `succeeded` and merged first. Its own
 * rule is that the next free number is taken at merge time and siblings
 * renumber ABOVE it, because the ladder must have no holes — declaring N
 * asserts this build understands every field introduced at or below N, so a
 * part declaring v5 for a funnel is also asserting it understands `succeeded`,
 * which it does.
 *
 * The gate has to move a FOURTH time, for the same reason it moved for v3 and
 * for exactly as narrow a window. An API carrying ISS-7795 but not this change
 * ACCEPTS a v3 declaration — v3 is in its supported list — and only then
 * rejects `findingsEmitted` as an unknown key on its `.strict()` item schema.
 * That is an HTTP 400 the Desktop client classes `validation_failed`, which is
 * PERMANENT: the part dead-letters after five attempts and the generation is
 * dropped for good rather than retried.
 *
 * Declaring v5 instead meets a version gate that API already has
 * (`protocolVersion` outside its supported set → HTTP 501 /
 * `protocol_unsupported`), which the client maps to `unavailable` and retries
 * indefinitely. Desktop tags are cut from `main` while the API deploys from
 * `production`, so a Desktop build shipping ahead of the API is ordinary, not
 * an edge case; the generation simply waits and drains once the API deploys.
 *
 * Chosen PER PART from its own items, as v2 and v3 already are, so a part whose
 * items carry no findings still declares its pre-existing version and an older
 * API accepts it byte-for-byte as it does today.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION =
  5 as const;

/**
 * ISS-10730: the version a part MUST declare once any of its items carries
 * per-invocation LINE attribution (`linesAdded`/`linesRemoved`).
 *
 * The same reasoning that moved the gate for `usageMeasurement` moves it again,
 * and for the same reason: an API carrying ISS-7795 but not this change ACCEPTS
 * a v3 declaration and only then rejects `linesAdded` as an unknown key on its
 * `.strict()` item schema — a 400 the client maps to `validation_failed`, which
 * is PERMANENT and drops the generation for good after five attempts. Declaring
 * a later version instead trips the deployed route's version gate, which answers
 * the retryable `protocol_unsupported`, so the generation simply waits for the
 * API to deploy and then drains.
 *
 * WHY 6 AND NOT 4 OR 5. A wire version is an IDENTITY, not a counter: two
 * producers that both declare the same number while meaning different payload
 * shapes are exactly the skew the gate exists to prevent, because the boundary
 * then cannot tell "carries findings fields" from "carries lines fields" and
 * silently accepts the wrong shape. ISS-10718 (#7804) merged v4 for `succeeded`
 * and ISS-10725 (#7715) merged v5 for the findings funnel, so lines take the
 * next free number at merge time. The ladder keeps no holes: declaring 6
 * asserts this build understands every field introduced at or below it, which
 * it does, because both v4 and v5 are in this tree.
 * `AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS` IS UNIONED, NOT
 * REPLACED, whenever two of these land together: dropping a version a peer is
 * already shipping makes the ingest gate answer `protocol_unsupported` forever
 * for a producer that is doing nothing wrong.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION =
  6 as const;

/**
 * ISS-10720: the version a part MUST declare once any of its items carries the
 * `otelCounter` evidence class or the `attributionSource` field.
 *
 * Same mechanism as v2 and v3, for the same reason and with the same cost if it
 * is skipped. `evidenceClass` is a `z.enum` derived from the const object, so an
 * API that predates this member ACCEPTS a v3 declaration and then rejects
 * `otelCounter` as an out-of-enum value on its `.strict()` item schema — a 400
 * the client maps to `validation_failed`, which is PERMANENT and drops the whole
 * generation after five attempts. Declaring a version that API has never heard
 * of hits its version gate instead (HTTP 501 / `protocol_unsupported`), which
 * the client retries indefinitely until the API deploys.
 *
 * SEVEN, BECAUSE FOUR, FIVE AND SIX ARE SPENT. ISS-10718 minted v4
 * (`succeeded`), ISS-10725/10726 minted v5 (the findings funnel) and ISS-10730
 * minted v6 (per-agent lines); all three merged to `main` before this lane, so
 * this takes the next free number at merge time, which is the rule each of
 * those three states for itself. THE LADDER HAS NO HOLES: declaring N asserts
 * this build understands every field introduced at or below N, and it does,
 * because v4, v5 and v6 are all in this tree.
 *
 * THE SUPPORTED LIST BELOW IS UNIONED AT MERGE, NEVER REPLACED. A numeric gap
 * there is a defect, not a cosmetic one: the ingest boundary refuses a version
 * it does not list, so a Desktop already shipping the dropped version gets
 * `protocol_unsupported` forever and every one of its generations dead-letters.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION =
  7 as const;

/**
 * ISS-11325: the version a part MUST declare once any of its items carries
 * `findingsDisposition`.
 *
 * Same mechanism and the same cost if skipped as v2 through v7. The field is a
 * `z.enum` on the `.strict()` item schema, so an API that predates it ACCEPTS a
 * v7 declaration and then rejects the key as unrecognized — a 400 the client maps
 * to the PERMANENT `validation_failed`, which dead-letters the WHOLE generation
 * rather than the one field. Declaring a version that API has never heard of hits
 * its version gate instead (HTTP 501 / `protocol_unsupported`), which the client
 * retries until the API deploys.
 *
 * EIGHT, because seven is spent: ISS-10720 minted v7 for the OTel attribution
 * pair and it is on `main`. THE LADDER KEEPS NO HOLES — declaring 8 asserts this
 * build understands every field introduced at or below it, which it does. The
 * supported list below is UNIONED at merge, never replaced.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_DISPOSITION_PROTOCOL_VERSION =
  8 as const;

/** Duration-bearing parts wait for an extent-capable API instead of failing
 * an older API's strict item schema and permanently dead-lettering. ISS-10713. */
export const AGENT_COMPONENT_INVOCATION_SYNC_DURATION_PROTOCOL_VERSION =
  9 as const;

/** A part carrying `succeeded` on a tool-result kind waits for an API that
 * accepts it there, instead of failing an older API's kind refinement and
 * permanently dead-lettering. Hook-only `succeeded` parts keep v4. */
export const AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION =
  10 as const;

/** Every protocol version this build's ingest boundary accepts. */
export const AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS = [
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUCCEEDED_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_DISPOSITION_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_DURATION_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION,
] as const;

export type AgentComponentInvocationSyncProtocolVersion =
  (typeof AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Maximum number of invocation occurrences in one complete generation. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS = 25_000;
/** Maximum number of invocation occurrences in one wire part. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS = 500;
/** Defensive cap on the number of parts in one generation. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS = 1000;
/** Maximum UTF-8 bytes for optional exact definition content. */
export const AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES = 98_304;
/** Maximum serialized UTF-8 bytes for one invocation item. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES = 131_072;
/** Maximum serialized UTF-8 bytes for one part envelope. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES = 524_288;
/** Maximum serialized UTF-8 bytes for one endpoint batch. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES = 1_048_576;
/** Maximum cumulative staged bytes across all parts of one generation. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_STAGED_BYTES = 52_428_800;
/** Maximum concurrent incomplete generations per session. */
export const AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS = 5;
/** Maximum invocation rows returned on one component-detail response. */
export const AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS = 500;

export type AgentComponentInvocationSourceFreshness = {
  sourceUpdatedAt: string;
  dataRevision: number;
  sourceSequence: number;
};

/**
 * One occurrence in the Desktop-local complete-set projection and dedicated
 * sync protocol. Optional fields are omitted when absent; producers must not
 * serialize them as null. `invokedAt` alone is nullable because minimal
 * harnesses may prove a session occurrence without an invocation timestamp.
 */
export type AgentComponentInvocationSyncItem = {
  externalInvocationId: string;
  sourceSessionId: string;
  childSessionId?: string;
  parentExternalInvocationId?: string;
  externalAgentId?: string;
  kind: AgentComponentInvocationKind;
  componentKey: string;
  rawName?: string;
  normalizedName?: string;
  relationship: AgentComponentInvocationRelationship;
  invokedAt: string | null;
  /** Zero-based canonical order inside the source session. */
  sequence: number;
  anchor: AgentComponentInvocationAnchor;
  providerInvocationId?: string;
  status: AgentComponentInvocationAttributionStatus;
  evidenceClass: AgentComponentInvocationEvidenceClass;
  definitionHash?: string;
  normalizerContractVersion?: number;
  /** Optional exact evidence; omitted from read DTOs and when over the cap. */
  definitionContent?: string;
  definitionFormat?: string;
  sourcePath?: string;
  sourceModifiedAt?: string;
  capturedAt?: string;
  repositoryFullName?: string;
  repositoryCommit?: string;
  packId?: string;
  branchName?: string;
  /**
   * FEA-3981 (ISS-4976) per-invocation telemetry. Additive and optional: a
   * producer that has not computed a value omits the key entirely rather than
   * sending `null`, so an older Desktop build stays byte-identical on the wire
   * and its generation identity is unchanged.
   *
   * These describe TWO DIFFERENT POPULATIONS and are NOT additive with each
   * other. Do not sum them into one "total tokens" or one "total cost".
   *
   * - `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
   *   `cacheWriteTokens`, `estimatedCost` — the SUBAGENT TURN's own usage: the
   *   model that turn ran under and the tokens/cost that turn billed. Both
   *   Prisma schemas define these as subagent-only ("other kinds leave them
   *   NULL"), and the ingest boundary rejects them on any other kind. That turn
   *   is a child of the session, so its cost is ALREADY counted in the parent
   *   session's own `estimatedCost`: adding per-invocation `estimatedCost` to
   *   the session total double-counts the subagent turns.
   * - `footprintTokens` — the deterministic "tokens this component injected
   *   into context" metric, computed for EVERY kind. A component's injected
   *   definition text is part of the consuming turn's input, so it is already
   *   inside that turn's `inputTokens`: footprint is an attribution of tokens
   *   another field also counts, not an additional token population.
   *
   * A read surface that wants one number must pick ONE population and say which
   * (e.g. "subagent turn spend" or "context footprint"), never fold both.
   *
   * Token counts are safe integers, and `estimatedCost` must already be
   * canonical for the cloud column's decimal scale (see
   * {@link canonicalAgentComponentInvocationCost}) so the value that comes back
   * out of persistence re-serializes byte-identically and the generation hash
   * still reconciles.
   */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
  footprintTokens?: number;
  /**
   * ISS-7795: HOW the telemetry on this item was arrived at. A count bracketed
   * around the invocation and a count derived from a session-wide average are
   * not comparable, so a reader must never see them in one undifferentiated
   * column. Required alongside any telemetry value on a part declaring
   * {@link AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION} or
   * later — a v2 producer that predates the label is still accepted — and
   * forbidden without telemetry at any version. See
   * {@link agentComponentInvocationSyncPartSchema}.
   */
  usageMeasurement?: AgentComponentInvocationUsageMeasurement;
  /**
   * ISS-10730: the lines THIS invocation changed, derived from the
   * `Edit`/`Write`/`MultiEdit` (or `apply_patch`/`patch`) call's own
   * before/after content — `NormalizedToolUse.diffDelta`, the same per-edit
   * delta that already sums into the session's `diffStats`.
   *
   * A THIRD population, additive with neither block above: these are lines, not
   * tokens and not dollars. Only the kinds in `LINE_BEARING_INVOCATION_KINDS`
   * may carry them, and that set is DISJOINT from
   * {@link USAGE_BEARING_INVOCATION_KINDS} — which is why a per-component LOC/$
   * ratio has to be resolved through `resolveInvocationLocPerDollar` rather
   * than divided directly (`agent-component-invocation-lines.ts`).
   *
   * Attribution does not nest: the lines land on the invocation that MADE the
   * call and are never copied onto the subagent that ran it, so the persisted
   * set stays non-overlapping and a session's parts reconcile against its
   * whole. Absent when the call changed no file, or when the harness recorded
   * no per-edit delta — omitted, never sent as `0`, because a measured zero and
   * an unmeasured one are different facts.
   */
  linesAdded?: number;
  linesRemoved?: number;
  /**
   * ISS-10718 / FEA-4093: whether this invocation SUCCEEDED, for the kinds whose
   * success is a first-class transcript fact.
   *
   * THREE-VALUED, AND THE THIRD VALUE IS THE POINT. Absent means "this kind's
   * success is not a fact the transcript records", which is NOT `false`. A tool
   * call that errored and a hook nobody can adjudicate must never render
   * identically, so a producer omits the key rather than coercing an unknown to
   * a failure — the same contract the desktop column has carried since
   * FEA-4093.
   */
  succeeded?: boolean;
  /**
   * ISS-7796 / ISS-10725: the findings funnel at this invocation's grain — the
   * OUTPUT side of the same row the cost denominator already sits on.
   *
   * Additive and optional, and BOTH-OR-NEITHER. `findingsInvalidated` without
   * `findingsEmitted` is meaningless ("invalidated out of what?"), so the
   * boundary rejects a half-set pair in either direction rather than persisting
   * one number that describes nothing. A producer that measured no funnel omits
   * both keys entirely instead of sending `null`, so an older Desktop build
   * stays byte-identical on the wire and its generation identity is unchanged.
   *
   * ABSENT IS UNKNOWN, NEVER ZERO. A component we did not measure and a
   * reviewer that genuinely emitted nothing are different facts; the first is
   * the absent pair, the second is a stored `0`.
   *
   * `findingsConfirmed` is DERIVED at read as `emitted - invalidated` and is
   * never a field here, never persisted, and never sent — see
   * `AgentComponentFindingsFunnel`. There is no per-finding cost on this
   * item and none may be derived from it (PRD-753 R3/R8).
   *
   * Carrying either key moves the part to
   * {@link AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION}.
   */
  findingsEmitted?: number;
  findingsInvalidated?: number;
  /**
   * ISS-11325: WHY the two counts above read what they read — measured by the run
   * that wrote this item, carried forward from an earlier one, or withheld for
   * one of the ingest's three named reasons.
   *
   * Additive and optional, OMITTED rather than `null` when absent: an older peer
   * records no disposition and a reader resolves the absence to the `unrecorded`
   * member, which is a different fact from any statement a producer can make.
   * Carrying this key moves the part to
   * {@link AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_DISPOSITION_PROTOCOL_VERSION}.
   *
   * Typed over the INGEST-ONLY union and not the whole vocabulary (@whitlockk
   * review), so `unrecorded` — which the wire schema refuses, because it is what
   * a READ resolves an absence to — cannot be put on an item that then dies at
   * the `.strict()` boundary and dead-letters the generation. The type and the
   * schema accept the same set by construction rather than by agreement.
   */
  findingsDisposition?: AgentComponentFindingsIngestDisposition;
  /**
   * ISS-10720: which source attributed this invocation to its component, when
   * that source was not this device's own transcript reconstruction. Additive
   * and optional — omitted rather than `null` when absent, which is what "the
   * transcript attributed it" has always looked like on the wire.
   */
  attributionSource?: AgentComponentInvocationAttributionSource;
} & AgentComponentInvocationDurationFields;

/** Desktop-local, unsplit source of truth handed to the dedicated preparer. */
export type AgentComponentInvocationCompleteGeneration =
  AgentComponentInvocationSourceFreshness & {
    externalSessionId: string;
    /** Deterministic hash of the complete canonically ordered item set. */
    externalGenerationId: string;
    items: AgentComponentInvocationSyncItem[];
  };

/**
 * Canonical preimage for `externalGenerationId`. It includes the source session
 * (so two explicit empty generations do not collide across sessions) and the
 * complete canonically ordered item set. Freshness is deliberately excluded:
 * sourceUpdatedAt/dataRevision/sourceSequence order activation separately and
 * do not change the identity of byte-identical invocation history.
 */
export function agentComponentInvocationGenerationHashPreimage(
  generation: Pick<
    AgentComponentInvocationCompleteGeneration,
    "externalSessionId" | "items"
  >
): string {
  const canonical = {
    externalSessionId: generation.externalSessionId,
    items: generation.items,
  };
  return stableStringify(JSON.parse(JSON.stringify(canonical)));
}

/** One independently retriable part of a complete invocation generation. */
export type AgentComponentInvocationSyncPart =
  AgentComponentInvocationSourceFreshness & {
    protocolVersion: AgentComponentInvocationSyncProtocolVersion;
    externalSessionId: string;
    externalGenerationId: string;
    partIndex: number;
    partCount: number;
    partHash: string;
    items: AgentComponentInvocationSyncItem[];
  };

export type AgentComponentInvocationSyncPartWithoutHash = Omit<
  AgentComponentInvocationSyncPart,
  "partHash"
>;

/**
 * Canonical, client-safe preimage hashed by both Desktop and API for `partHash`.
 * Fields are reconstructed explicitly so transport-only extras never enter the
 * hash. JSON normalization first removes absent optional item fields (rather
 * than reinterpreting them as null), then stableStringify sorts nested keys.
 */
export function agentComponentInvocationSyncPartHashPreimage(
  part: AgentComponentInvocationSyncPartWithoutHash
): string {
  const canonical = {
    protocolVersion: part.protocolVersion,
    externalSessionId: part.externalSessionId,
    externalGenerationId: part.externalGenerationId,
    sourceUpdatedAt: part.sourceUpdatedAt,
    dataRevision: part.dataRevision,
    sourceSequence: part.sourceSequence,
    partIndex: part.partIndex,
    partCount: part.partCount,
    items: part.items,
  };
  return stableStringify(JSON.parse(JSON.stringify(canonical)));
}

/** One endpoint request carries one exact part so its acknowledgement is unambiguous. */
export type AgentComponentInvocationSyncBatch = {
  protocolVersion: AgentComponentInvocationSyncProtocolVersion;
  parts: AgentComponentInvocationSyncPart[];
};

export const AgentComponentInvocationSyncAckState = {
  Staged: "staged",
  Activated: "activated",
  Stale: "stale",
} as const;
export type AgentComponentInvocationSyncAckState =
  (typeof AgentComponentInvocationSyncAckState)[keyof typeof AgentComponentInvocationSyncAckState];

export const AgentComponentInvocationSyncRejectReason = {
  ProtocolUnsupported: DesktopWriteLaneRejectReason.ProtocolUnsupported,
  SessionMissing: DesktopWriteLaneRejectReason.SessionMissing,
  ValidationFailed: DesktopWriteLaneRejectReason.ValidationFailed,
  PartConflict: DesktopWriteLaneRejectReason.PartConflict,
  GenerationConflict: DesktopWriteLaneRejectReason.GenerationConflict,
  IngestionFailed: DesktopWriteLaneRejectReason.IngestionFailed,
  RateLimited: DesktopWriteLaneRejectReason.RateLimited,
} as const;
export type AgentComponentInvocationSyncRejectReason =
  (typeof AgentComponentInvocationSyncRejectReason)[keyof typeof AgentComponentInvocationSyncRejectReason];

/**
 * Exact per-part acknowledgement. An outbox may advance only when generation,
 * part index, and part hash all match its pending part.
 */
export type AgentComponentInvocationSyncAck =
  | {
      accepted: true;
      protocolVersion: AgentComponentInvocationSyncProtocolVersion;
      externalGenerationId: string;
      partIndex: number;
      partHash: string;
      state: AgentComponentInvocationSyncAckState;
    }
  | {
      accepted: false;
      protocolVersion: AgentComponentInvocationSyncProtocolVersion;
      externalGenerationId: string;
      partIndex: number;
      partHash: string;
      reason: AgentComponentInvocationSyncRejectReason;
    };

/** Bounded, content-free invocation row returned by cloud and Desktop reads. */
export type AgentComponentInvocationReadRow = {
  id: string;
  externalInvocationId: string;
  sessionId: string;
  externalSessionId: string;
  sourceSessionId: string;
  childSessionId?: string;
  parentExternalInvocationId?: string;
  externalAgentId?: string;
  kind: AgentComponentInvocationKind;
  componentKey: string;
  rawName?: string;
  normalizedName?: string;
  relationship: AgentComponentInvocationRelationship;
  invokedAt: string | null;
  sequence: number;
  anchor: AgentComponentInvocationAnchor;
  providerInvocationId?: string;
  status: AgentComponentInvocationAttributionStatus;
  evidenceClass: AgentComponentInvocationEvidenceClass;
  definitionHash?: string;
  normalizerContractVersion?: number;
  definitionVersionId?: string;
  sourceOccurrence?: SourceOccurrence;
  sourcePath?: string;
  sourceModifiedAt?: string;
  capturedAt?: string;
  repositoryFullName?: string;
  repositoryCommit?: string;
  packId?: string;
  branchName?: string;
  /**
   * ISS-10714: the ordered call chain that reached this invocation plus its
   * depth. ABSENT when the chain could not be reconstructed — never a zero
   * depth, which is the positive claim that this is a root invocation.
   */
  ancestry?: AgentComponentInvocationAncestry;
  /** ISS-10720: which source attributed this row, when not the transcript. */
  attributionSource?: AgentComponentInvocationAttributionSource;
} & AgentComponentInvocationFindingsReadFields &
  AgentComponentInvocationTelemetryReadFields &
  AgentComponentInvocationDurationFields;

export type AgentComponentInvocationReadPage = {
  items: AgentComponentInvocationReadRow[];
  total: number;
  hasMore: boolean;
  unmatchedCount: number;
  ambiguousCount: number;
  /**
   * ISS-9880: opaque keyset position of the last row on this page, sent back as
   * the next read's cursor. OMITTED, never null, both when the walk is
   * exhausted and by a producer that cannot page at all — `hasMore` is what
   * separates those two: an absent cursor beside `hasMore: true` means records
   * were withheld with no way to ask for them.
   *
   * ISS-10640 made the desktop local read a pager, so the only producer left
   * that can strand rows that way is an older cloud peer across the version
   * skew.
   */
  nextCursor?: string;
};

/**
 * Decimal places carried by the cloud `agent_component_invocations.estimated_cost`
 * column (`numeric(14, 6)`).
 */
const AGENT_COMPONENT_INVOCATION_COST_SCALE = 6;

/** Largest value `numeric(14, 6)` can hold: eight integer digits, six fractional. */
export const AGENT_COMPONENT_INVOCATION_MAX_COST = 99_999_999.999_999;

/** Token counts cross the wire as JSON numbers, so they must stay safe integers. */
export const AGENT_COMPONENT_INVOCATION_MAX_TOKENS = Number.MAX_SAFE_INTEGER;

/**
 * The scale factor itself, exported so a consumer that SUMS costs can
 * accumulate exact integer units instead of adding floats: a canonical cost
 * times this factor is an exact integer, and an integer total that leaves the
 * safe-integer range is detectable, where a float total is silently rounded.
 */
export const AGENT_COMPONENT_INVOCATION_COST_FACTOR =
  10 ** AGENT_COMPONENT_INVOCATION_COST_SCALE;

/**
 * Round a cost to the exact scale the cloud column persists.
 *
 * The generation and part hashes are taken over the item set itself, so a value
 * the database would silently round on write (a seventh decimal place) would
 * come back out different and permanently fail the post-ingest generation-hash
 * reconciliation. Producers canonicalize before hashing and the ingest boundary
 * rejects anything that is not already canonical, so the two never disagree.
 */
export function canonicalAgentComponentInvocationCost(value: number): number {
  return (
    Math.round(value * AGENT_COMPONENT_INVOCATION_COST_FACTOR) /
    AGENT_COMPONENT_INVOCATION_COST_FACTOR
  );
}

/** True when a cost is finite, in range, and already at the persisted scale. */
export function isCanonicalAgentComponentInvocationCost(
  value: number
): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    value <= AGENT_COMPONENT_INVOCATION_MAX_COST &&
    canonicalAgentComponentInvocationCost(value) === value
  );
}

/**
 * The subagent-turn usage keys. Both Prisma schemas define these as
 * subagent-only ("a subagent invocation carries the model it ran and that
 * turn's usage; other kinds leave them NULL"), so the ingest boundary rejects
 * them on any other kind and the producer omits them there.
 * `footprintTokens` is deliberately absent: it is kind-agnostic.
 */
export const AGENT_COMPONENT_INVOCATION_SUBAGENT_USAGE_KEYS = [
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "estimatedCost",
] as const;

/** Every per-invocation telemetry key, whatever population it belongs to. */
export const AGENT_COMPONENT_INVOCATION_TELEMETRY_KEYS = [
  ...AGENT_COMPONENT_INVOCATION_SUBAGENT_USAGE_KEYS,
  "footprintTokens",
] as const;

/**
 * ISS-7795: how a per-invocation telemetry value was arrived at.
 *
 * `Measured` is a count bracketed around the invocation itself — the two-sided
 * hook or transcript span that bills exactly this call. `Estimated` is anything
 * derived rather than observed, most often a share of a session-wide average.
 * The two answer the same question with incomparable confidence, so the
 * boundary keeps them labelled rather than letting a reader fold them into one
 * column and compare unlike with unlike.
 *
 * Deliberately NOT a "0 = unknown" sentinel: an absent measurement means the
 * telemetry itself is absent, which is a different fact from a measured zero.
 */
export const AgentComponentInvocationUsageMeasurement = {
  Measured: "measured",
  Estimated: "estimated",
} as const;

export type AgentComponentInvocationUsageMeasurement =
  (typeof AgentComponentInvocationUsageMeasurement)[keyof typeof AgentComponentInvocationUsageMeasurement];

/** True when the item carries any subagent-turn usage value. */
export function hasAgentComponentInvocationSubagentUsage(
  item: Partial<AgentComponentInvocationSyncItem>
): boolean {
  return AGENT_COMPONENT_INVOCATION_SUBAGENT_USAGE_KEYS.some(
    (key) => item[key] !== undefined
  );
}

/** True when the item carries any per-invocation telemetry value at all. */
export function hasAgentComponentInvocationTelemetry(
  item: Partial<AgentComponentInvocationSyncItem>
): boolean {
  return AGENT_COMPONENT_INVOCATION_TELEMETRY_KEYS.some(
    (key) => item[key] !== undefined
  );
}

/**
 * ISS-10720: whether this item carries either half of the OTel attribution
 * contract — the `otelCounter` evidence member or the `attributionSource`
 * field. Both were introduced together at
 * {@link AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION} and an
 * API below it rejects either one, so the arm must test both rather than the
 * field alone.
 */
function hasAgentComponentInvocationOtelAttribution(
  item: Partial<AgentComponentInvocationSyncItem>
): boolean {
  return (
    item.evidenceClass === AgentComponentInvocationEvidenceClass.OtelCounter ||
    item.attributionSource !== undefined
  );
}

/**
 * The version the part's USAGE alone requires — the same ladder, stopped below
 * the fields that have nothing to do with usage.
 *
 * ISS-10718 (@whitlockk review): a rule introduced at version N must be gated on
 * the part needing N FOR THE REASON N EXISTS. `telemetry_requires_usage_measurement`
 * is a rule about usage, and gating it on the part's DECLARED version made it
 * fire for a reason that is not usage the moment a version above v3 existed:
 * one hook item carrying `succeeded` lifts the whole part to v4, which then
 * retroactively demands a label of a legacy v2-shape row whose
 * `usage_measurement` column predates the label. `storedSubagentUsage` keeps
 * that row's counts on purpose, so the part would fail
 * `assertPartSatisfiesWireContract` ON THE DEVICE and dead-letter the whole
 * generation — losing every row to protect a rule about a field none of them
 * carried.
 */
export function agentComponentInvocationSyncUsageProtocolVersionForItems(
  items: readonly Partial<AgentComponentInvocationSyncItem>[]
): AgentComponentInvocationSyncProtocolVersion {
  if (items.some((item) => item.usageMeasurement !== undefined)) {
    return AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION;
  }
  return items.some(hasAgentComponentInvocationTelemetry)
    ? AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION
    : AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION;
}

/**
 * The protocol version a part carrying `items` must declare.
 *
 * Derived from the items themselves so producer and boundary agree without
 * negotiation: a telemetry-free part stays v1 and an older API accepts it
 * exactly as today, while a telemetry-carrying part declares v2 and an older API
 * answers the retryable `protocol_unsupported` instead of dead-lettering it.
 * The arms are ordered HIGHEST VERSION FIRST, because the part must declare the
 * highest version any of its fields introduced: the tool-result `succeeded` arm
 * at v10 outranks the duration arm at v9, which outranks the findings
 * disposition arm at v8, which outranks ISS-10720's OTel-attribution
 * arm at v7, which outranks ISS-10730's lines arm at v6, which outranks ISS-10726's
 * findings arm at v5, which outranks ISS-10718's `succeeded` arm at v4, which
 * outranks the usage arms at v3 and below.
 *
 * ISS-10730: the lines arm belongs HERE and not in
 * {@link agentComponentInvocationSyncUsageProtocolVersionForItems}, even though
 * that is where this branch's single pre-merge function had it. That helper is
 * the version the part's USAGE alone requires, and it gates
 * `telemetry_requires_usage_measurement`; line attribution rides kinds disjoint
 * from the usage-bearing ones, so letting it lift the usage version would demand
 * a `usageMeasurement` label of legacy rows that carry no lines — the exact
 * cross-field misfire ISS-10718 split the two functions to stop.
 */
export function agentComponentInvocationSyncProtocolVersionForItems(
  items: readonly Partial<AgentComponentInvocationSyncItem>[]
): AgentComponentInvocationSyncProtocolVersion {
  if (
    items.some(
      (item) =>
        item.succeeded !== undefined &&
        isAgentComponentInvocationKindIn(
          TOOL_RESULT_SUCCESS_BEARING_INVOCATION_KINDS,
          item.kind
        )
    )
  ) {
    return AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION;
  }
  if (items.some((item) => item.durationMs !== undefined)) {
    return AGENT_COMPONENT_INVOCATION_SYNC_DURATION_PROTOCOL_VERSION;
  }
  if (items.some((item) => item.findingsDisposition !== undefined)) {
    return AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_DISPOSITION_PROTOCOL_VERSION;
  }
  if (items.some(hasAgentComponentInvocationOtelAttribution)) {
    return AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION;
  }
  if (items.some(hasAgentComponentInvocationLines)) {
    return AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION;
  }
  if (items.some(hasAgentComponentInvocationFindings)) {
    return AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION;
  }
  if (items.some((item) => item.succeeded !== undefined)) {
    return AGENT_COMPONENT_INVOCATION_SYNC_SUCCEEDED_PROTOCOL_VERSION;
  }
  return agentComponentInvocationSyncUsageProtocolVersionForItems(items);
}

/**
 * ISS-4976 (@tamsinb review): whether `value` is a protocol version THIS build
 * participates in — the SET, never one scalar.
 *
 * The single canonical membership test, so every gate that has to answer "can I
 * handle this version?" reads the same tuple the producer picks from
 * ({@link agentComponentInvocationSyncProtocolVersionForItems}) and the two
 * cannot drift. Both directions matter and they fail differently:
 *
 * - Comparing against ONE constant makes a version this build EMITS look
 *   foreign. That is how the desktop outbox loader dropped every v2
 *   (telemetry-carrying) part it had just written — local data loss, before the
 *   wire, with no old peer involved.
 * - Accepting ANY number defeats the quarantine. A corrupt row, or a row a
 *   FUTURE build wrote that this one cannot interpret, must still be turned
 *   away (root AGENTS.md: unknown values degrade gracefully — the API answers
 *   the retryable `protocol_unsupported`, the outbox quarantines the row —
 *   rather than being waved through as if understood).
 */
export function isSupportedAgentComponentInvocationSyncProtocolVersion(
  value: unknown
): value is AgentComponentInvocationSyncProtocolVersion {
  return AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS.some(
    (version) => version === value
  );
}

/**
 * ISS-6757: fold a requested component key into the form the persisted
 * `agent_component_invocations.component_key_normalized` column holds, so the
 * invocation read's fallback arm can match it with an INDEXED equality instead
 * of the ILIKE Prisma emits for `mode: "insensitive"`.
 *
 * This is the read half of a two-sided contract. The write half is SQL —
 * `lower(component_key)`, applied by the `trg_aci_fold_component_key` trigger
 * added in migration 20260820140000 — so this function is not free to pick a
 * different folding. `packages/database/__tests__/integration/iss6757-invocation-component-key-normalized.integration.test.ts`
 * drives both halves against a real database over the same key set and fails if
 * they disagree, because a silent divergence here does not surface as an error:
 * it makes a component's invocations vanish from its detail page.
 *
 * Case only, no trimming. The predicate this replaces was
 * `component_key ILIKE <key>`, which is case-insensitive equality and nothing
 * else; trimming here would start matching rows the old read did not.
 *
 * WHERE JS AND POSTGRES DISAGREE, AND WHY THAT IS NOT NEW. `lower()` and
 * `String#toLowerCase` are not the same function: measured on `en_US.utf8`,
 * `İ` (U+0130) folds to `i` in Postgres and to `i` + U+0307 in JS, and a
 * word-final `Σ` folds to `σ` in Postgres and `ς` in JS. Neither divergence is
 * introduced here: the key reaching this function has ALREADY been folded by
 * `normalizeComponentKey` (agent-component-analytics.ts) on its way through the
 * detail slug, so the ILIKE predicate this replaces was comparing that same
 * JS-folded value against Postgres's own folding and missed those two classes
 * too — `'İstanbul' ILIKE 'i̇stanbul'` and `'ΣΟΦΟΣ' ILIKE 'σοφος'` are both
 * false. Everything else agrees, accented Latin included (`'CAFÉ'` matches
 * `'café'` on both sides), and the integration suite pins that.
 */
export function normalizeAgentComponentInvocationKey(key: string): string {
  return key.toLowerCase();
}

/**
 * ISS-7795: the invocation kinds a per-invocation usage row may describe.
 *
 * ONE definition, read by all three layers that enforce it — the Desktop wire
 * projection, this package's ingest boundary, and the Desktop store-integrity
 * probe. They previously each spelled `!== Subagent` inline, so widening the
 * population meant finding all three; a row admitted by one and called
 * corruption by another is the failure that shape invites.
 *
 * Membership means "something measures this kind", not "the column permits it".
 * `subagent` was the whole set under ISS-4976; ISS-7795 added `skill` and
 * `command`, which the harness's own per-turn attribution stamp measures. The
 * kinds outside it have no producer, so a value on one of their rows is still
 * corruption.
 */
export const USAGE_BEARING_INVOCATION_KINDS: ReadonlySet<AgentComponentInvocationKind> =
  new Set([
    AgentComponentInvocationKind.Subagent,
    AgentComponentInvocationKind.Skill,
    AgentComponentInvocationKind.Command,
  ]);

/**
 * The invocation kinds a line count may describe: the kinds built from a single
 * transcript tool call, which is the only thing that carries a `diffDelta`.
 *
 * ONE definition, read by the producer, the ingest boundary and the store
 * integrity probe — the shape `USAGE_BEARING_INVOCATION_KINDS` established, for
 * the same reason: a row admitted by one layer and called corruption by another
 * is the failure that spelling the set inline three times invites.
 *
 * Membership means "something measures this kind", never "the column permits
 * it". A `skill`, `command`, `subagent` or `hook` invocation is not a file
 * mutation and has no producer here, so a value on one of their rows is
 * corruption rather than enrichment.
 *
 * This set and `USAGE_BEARING_INVOCATION_KINDS` are DISJOINT, and that is the
 * whole reason {@link resolveInvocationLocPerDollar} exists: the cohort that
 * can carry lines and the cohort that can carry cost do not cover each other,
 * so a ratio taken across them is inflated rather than incomplete.
 */
export const LINE_BEARING_INVOCATION_KINDS: ReadonlySet<AgentComponentInvocationKind> =
  new Set([
    AgentComponentInvocationKind.Tool,
    AgentComponentInvocationKind.Mcp,
    AgentComponentInvocationKind.Orchestration,
  ]);

/**
 * ISS-10718 (@whitlockk review): the invocation kinds whose success is a first-class
 * transcript fact.
 *
 * Hook firings carry it on their `hook_success`/`hook_error` record, and the
 * tool-result kinds (`tool`, `mcp`, `orchestration`) on their `tool_result`'s
 * `is_error`. Every other kind leaves the column NULL. Membership means
 * "something ADJUDICATES this kind", not "the column permits it" — the same
 * distinction
 * {@link USAGE_BEARING_INVOCATION_KINDS} draws, and for the same reason. A
 * boolean on a kind with no adjudicator is a verdict nobody reached, rendering
 * as a confident pass or fail; unknown is not `false`, and that is the whole
 * point of the field being three-valued.
 */
export const SUCCESS_BEARING_INVOCATION_KINDS: ReadonlySet<AgentComponentInvocationKind> =
  new Set([
    AgentComponentInvocationKind.Hook,
    AgentComponentInvocationKind.Tool,
    AgentComponentInvocationKind.Mcp,
    AgentComponentInvocationKind.Orchestration,
  ]);

/**
 * The success-bearing kinds whose verdict is a `tool_result`'s `is_error`. A
 * part carrying one of these verdicts declares
 * {@link AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION}.
 */
export const TOOL_RESULT_SUCCESS_BEARING_INVOCATION_KINDS: ReadonlySet<AgentComponentInvocationKind> =
  new Set(
    [...SUCCESS_BEARING_INVOCATION_KINDS].filter(
      (kind) => kind !== AgentComponentInvocationKind.Hook
    )
  );

/**
 * Whether `value` names a kind in `kinds`, for a caller holding a raw column
 * rather than the narrowed enum (the desktop read's `component_kind` is a bare
 * `string`). Folded through the canonical const object so an unknown spelling
 * is a miss rather than a cast that lies.
 */
export function isAgentComponentInvocationKindIn(
  kinds: ReadonlySet<AgentComponentInvocationKind>,
  value: string | null | undefined
): boolean {
  return Object.values(AgentComponentInvocationKind).some(
    (kind) => kind === value && kinds.has(kind)
  );
}

/**
 * ISS-7580: the ONE producer-side reading of a stored `normalizer_contract_version`
 * cell, returning the value to emit or `undefined` to OMIT the key.
 *
 * It mirrors this module's own wire constraint —
 * `normalizerContractVersion: z.number().int().positive().max(PR_INT_MAX).optional()`
 * in `agent-component-invocation-schema.ts` — so the two cannot drift, and it lives
 * beside that schema for the same reason {@link canonicalAgentComponentInvocationCost}
 * does. Both desktop producers (the dashboard read row and the sync item) share
 * it; when they each coerced the cell themselves, they disagreed.
 *
 * A version is an IDENTITY, not a count, so every value the schema would reject
 * degrades to omission rather than to a number: omission is already this optional
 * field's contract for "not known" and the shape a NULL column has always
 * produced. The rejected set is why a general numeric coercion cannot serve here
 * — a blank or whitespace cell is a FINITE ZERO through `Number`, and `0` is not
 * a version any normalizer has emitted, so a finite check alone would put a
 * plausible wrong identity on the wire and the strict boundary schema would then
 * reject the entire part.
 *
 * Reached through `$queryRawUnsafe`, where the declared row type does not
 * constrain the runtime value: SQLite stores what was written, so an INTEGER
 * column can hand back a `bigint`, and a corrupt cell arrives as TEXT. That is
 * also why the int4 ceiling is checked here and not left to the column: a
 * `bigint` above it is exactly what such a cell hands back, and emitting it
 * would make the strict boundary reject the whole part (ISS-8329, whitlockk review).
 */
export function agentComponentInvocationContractVersion(
  value: number | bigint | string | null | undefined
): number | undefined {
  if (value == null) {
    return;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return;
  }
  const parsed = Number(value);
  const withinWireBounds =
    Number.isSafeInteger(parsed) && parsed > 0 && parsed <= PR_INT_MAX;
  return withinWireBounds ? parsed : undefined;
}

/**
 * ISS-10725: the two findings keys an item may carry, as a value, so nothing
 * hand-copies the pair. Sourced from the funnel contract itself rather than
 * respelled here, which is what keeps the wire keys and the stored keys one set.
 * The COUNT set and not the ingest set: ISS-10739's `findingsProvenance` is not
 * on this item, so admitting it here would let a key the wire cannot carry
 * declare an item findings-carrying.
 */
export const AGENT_COMPONENT_INVOCATION_FINDINGS_KEYS =
  AGENT_COMPONENT_FINDINGS_FUNNEL_COUNT_KEYS;

/**
 * True when the item carries EITHER findings key.
 *
 * Deliberately "either", not "both": a half-set pair is exactly what the
 * boundary must reject, and it can only reject what it first admits is a
 * findings-carrying item. A predicate that required both would let
 * `findingsInvalidated` alone declare v3 and then be refused as an unknown key
 * by a v3 API — the dead-letter this version gate exists to avoid.
 */
export function hasAgentComponentInvocationFindings(
  item: Partial<AgentComponentInvocationSyncItem>
): boolean {
  return AGENT_COMPONENT_INVOCATION_FINDINGS_KEYS.some(
    (key) => item[key] !== undefined
  );
}
