/**
 * @file pack-scan-worker-protocol.ts — typed IPC contract between the db-host
 * and the pure-compute pack-scan utilityProcess (FEA-3628).
 *
 * The db-host sends a {@link PackScanWorkerRequest} carrying the recent project
 * roots (the scanner's single DB read, done on the db-host so the worker owns
 * no DB connection). The worker runs `computePackScan` and replies with a
 * {@link PackScanWorkerResponse} carrying the serializable
 * {@link PackScanComputeResult}. Everything is Zod-validated at the boundary so
 * a malformed worker payload can never corrupt the db-host write path.
 *
 * Mirrors the shape of `collectors/engine/historical-parse-worker-protocol.ts`.
 */

import { Harness } from "@repo/api/src/types/agent-component";
import { z } from "zod";
import type {
  DefinitionCollectorRoots,
  DefinitionScanRoot,
} from "./definition-discovery.js";
import type {
  DefinitionVariants,
  DiscoveredDefinition,
} from "./definition-variant-fold.js";
import type { PackScanComputeResult } from "./pack-scanner.js";

export const PackScanWorkerRequestType = {
  Run: "run",
  Definitions: "definitions",
} as const;

export const PackScanWorkerResponseType = {
  Computed: "computed",
  Definitions: "definitions",
  DefinitionsOmitted: "definitionsOmitted",
  Failed: "failed",
} as const;

// Generous upper bounds — a real machine has at most a few dozen packs and a
// few hundred skills. These exist only to keep a runaway/hostile payload from
// ballooning memory when it crosses the IPC boundary.
const MAX_PLAN_PACKS = 5000;
const MAX_PLAN_SKILLS = 50_000;
const MAX_PLAN_ASSOCIATIONS = 20_000;
const MAX_RECENT_ROOTS = 10_000;

/**
 * Definition-payload budgets (ISS-5274). Deliberately generous: exceeding one
 * OMITS the whole payload and reverts the cycle to the full on-host walk, so
 * tripping it must be unreachable in practice rather than a routine degrade.
 * Same order of magnitude as the plan bounds above (`MAX_PLAN_SKILLS`).
 */
export const MAX_DEFINITIONS = 50_000;
export const MAX_DEFINITION_CONTENT_BYTES = 64 * 1024 * 1024;
/** Distinct-content variants retained for ONE identity — see `DefinitionVariants`. */
const MAX_DEFINITION_VARIANTS = 1000;
/** Candidate definition subdir names per scan root (`agents`/`agent`/…). */
const MAX_DEFINITION_SUBDIRS = 32;

export const WORKER_INVALID_RESPONSE_MESSAGE_PREFIX =
  "pack-scan worker sent an invalid response";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

const harnessSchema = z.enum(Harness);

const definitionScanRootSchema: z.ZodType<DefinitionScanRoot> = z.union([
  z.string(),
  z.object({
    dir: z.string(),
    projectPath: z.string().optional(),
    harness: harnessSchema.optional(),
    subdirs: z.array(z.string()).max(MAX_DEFINITION_SUBDIRS).optional(),
  }),
]);

/**
 * The scan roots the db-host resolved, as they ride the wire.
 *
 * `homeDir` is deliberately OMITTED (ISS-5274): it is a scope-derivation input
 * for the apply half, not a walk input, and the db-host hands it straight to
 * `packScanner.applyDefinitions` without it ever entering the worker. Keying
 * the guard on `Omit<DefinitionCollectorRoots, "homeDir">` — rather than on a
 * hand-written wire type — is what makes a newly-added ROOT LIST fail `tsc`
 * here instead of being silently unscanned in production.
 */
const definitionScanRootsShape = {
  skillRoots: z
    .array(definitionScanRootSchema)
    .max(MAX_RECENT_ROOTS)
    .optional(),
  claudeRoots: z
    .array(definitionScanRootSchema)
    .max(MAX_RECENT_ROOTS)
    .optional(),
  openCodeRoots: z
    .array(definitionScanRootSchema)
    .max(MAX_RECENT_ROOTS)
    .optional(),
} satisfies Record<
  keyof Omit<DefinitionCollectorRoots, "homeDir">,
  z.ZodTypeAny
>;

export const definitionScanRootsSchema = z.object(definitionScanRootsShape);

export type DefinitionScanRootsWire = z.infer<typeof definitionScanRootsSchema>;

export const packScanWorkerRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(PackScanWorkerRequestType.Run),
    requestId: z.string().min(1),
    recentProjectRoots: z.array(z.string()).max(MAX_RECENT_ROOTS),
  }),
  z.object({
    type: z.literal(PackScanWorkerRequestType.Definitions),
    requestId: z.string().min(1),
    scanRoots: definitionScanRootsSchema,
  }),
]);

export type PackScanWorkerRequest = z.infer<typeof packScanWorkerRequestSchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

const packUpsertRowSchema = z.object({
  pack_id: z.string(),
  harness: z.string(),
  install_path: z.string(),
  install_kind: z.string(),
  source_url: z.string().nullish(),
  version: z.string().nullish(),
});

const skillUpsertRowSchema = z.object({
  skill_id: z.string(),
  pack_id: z.string().nullish(),
  harness: z.string(),
  install_path: z.string(),
  name: z.string(),
  version: z.string().nullish(),
  description: z.string().nullish(),
  source_url: z.string().nullish(),
});

const associationUpsertRowSchema = z.object({
  project_path: z.string(),
  pack_id: z.string(),
});

const scanGStackResultSchema = z.object({
  installs: z.number(),
  skills: z.number(),
});

const scanBmadResultSchema = z.object({
  installs: z.number(),
  skills: z.number(),
  projects: z.number(),
});

const scanMarketplacesResultSchema = z.object({
  installs: z.number(),
  skills: z.number(),
  marketplaces: z.number(),
  plugins: z.number().optional(),
});

export const packScanComputeResultSchema = z.object({
  plan: z.object({
    packs: z.array(packUpsertRowSchema).max(MAX_PLAN_PACKS),
    skills: z.array(skillUpsertRowSchema).max(MAX_PLAN_SKILLS),
    associations: z
      .array(associationUpsertRowSchema)
      .max(MAX_PLAN_ASSOCIATIONS),
  }),
  counts: z.object({
    gstack: scanGStackResultSchema,
    bmad: scanBmadResultSchema,
    marketplaces: scanMarketplacesResultSchema,
    catalogDetectors: z.record(z.string(), z.boolean()),
    gstackProjects: z.number(),
  }),
  scopes: z.record(z.string(), z.boolean()),
});

/**
 * One discovered definition on the wire.
 *
 * Keyed on the CANONICAL `DiscoveredDefinition` (ISS-5274, FEA-3701 precedent):
 * a field added to that type fails `tsc` here rather than being silently
 * stripped by `z.object`'s unknown-key removal on the receiving side.
 */
const discoveredDefinitionShape = {
  kind: z.enum(["skill", "subagent", "command"]),
  externalId: z.string().min(1),
  name: z.string(),
  installPath: z.string(),
  content: z.string(),
  projectPath: z.string().optional(),
  harness: harnessSchema.nullable(),
} satisfies Record<keyof DiscoveredDefinition, z.ZodTypeAny>;

const discoveredDefinitionSchema = z.object(discoveredDefinitionShape);

/**
 * A folded identity on the wire: the display-row `primary` plus its retained
 * distinct-content `variants`.
 *
 * `seenHashes` is excluded on purpose — it is `foldDiscovered`'s internal
 * hash accumulator (a `Set`), meaningless once the fold is complete and never
 * read by the apply half. The guard keys on
 * `Omit<DefinitionVariants, "seenHashes">` rather than on the wire type itself,
 * which would be tautological: a field added to the canonical `DefinitionVariants`
 * has to fail `tsc` HERE to be caught at all.
 */
const definitionWireShape = {
  primary: discoveredDefinitionSchema,
  variants: z.array(discoveredDefinitionSchema).max(MAX_DEFINITION_VARIANTS),
} satisfies Record<keyof Omit<DefinitionVariants, "seenHashes">, z.ZodTypeAny>;

export const definitionWireSchema = z.object(definitionWireShape);

export type DefinitionWire = z.infer<typeof definitionWireSchema>;

export const packScanWorkerResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(PackScanWorkerResponseType.Computed),
    requestId: z.string().min(1),
    result: packScanComputeResultSchema,
  }),
  z.object({
    type: z.literal(PackScanWorkerResponseType.Definitions),
    requestId: z.string().min(1),
    definitions: z.array(definitionWireSchema).max(MAX_DEFINITIONS),
  }),
  z.object({
    type: z.literal(PackScanWorkerResponseType.DefinitionsOmitted),
    requestId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal(PackScanWorkerResponseType.Failed),
    requestId: z.string().min(1),
    message: z.string(),
    fatal: z.literal(true).optional(),
    diagnostic: z.string().optional(),
  }),
]);

export type PackScanWorkerResponse = z.infer<
  typeof packScanWorkerResponseSchema
>;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function createPackScanComputedResponse(
  requestId: string,
  result: PackScanComputeResult
): PackScanWorkerResponse {
  return { type: PackScanWorkerResponseType.Computed, requestId, result };
}

export function createPackScanFailedResponse(
  requestId: string,
  message: string,
  opts: { fatal?: true; diagnostic?: string } = {}
): PackScanWorkerResponse {
  return {
    type: PackScanWorkerResponseType.Failed,
    requestId,
    message,
    ...(opts.fatal ? { fatal: opts.fatal } : {}),
    ...(opts.diagnostic ? { diagnostic: opts.diagnostic } : {}),
  };
}

export function createPackScanDefinitionsResponse(
  requestId: string,
  definitions: readonly DefinitionWire[]
): PackScanWorkerResponse {
  return {
    type: PackScanWorkerResponseType.Definitions,
    requestId,
    definitions: [...definitions],
  };
}

export function createPackScanDefinitionsOmittedResponse(
  requestId: string,
  reason: string
): PackScanWorkerResponse {
  return {
    type: PackScanWorkerResponseType.DefinitionsOmitted,
    requestId,
    reason,
  };
}

/**
 * Strip the fold accumulator so a discovered set can cross the process
 * boundary. Structured clone would carry the `Set` fine, but it is an internal
 * hashing accumulator with no meaning to the apply half; shipping it would put
 * a second, unvalidated shape on the wire.
 */
export function toDefinitionWire(
  definitions: readonly DefinitionVariants[]
): DefinitionWire[] {
  return definitions.map(({ primary, variants }) => ({ primary, variants }));
}

/**
 * The definition payload's own budget check — the INVARIANT's enforcement
 * point (ISS-5274).
 *
 * Returns the reason the payload must be OMITTED, or null when it fits. The
 * caller replies `definitionsOmitted` and the db-host then performs the full
 * on-host walk, so the catalog still converges: this never truncates a payload,
 * because a partial set would be applied as if complete and every definition it
 * dropped would be reconciled to `missing`. Complete, or fall back — never
 * partial.
 *
 * Exported and pure so the boundary can be tested directly rather than through
 * a fake worker child that could only prove a message was sent.
 */
export function definitionBudgetOmissionReason(
  definitions: readonly DefinitionWire[]
): string | null {
  if (definitions.length > MAX_DEFINITIONS) {
    return `definition count ${definitions.length} exceeds ${MAX_DEFINITIONS}`;
  }
  let bytes = 0;
  for (const { primary, variants } of definitions) {
    bytes += Buffer.byteLength(primary.content, "utf8");
    for (const variant of variants) {
      bytes += Buffer.byteLength(variant.content, "utf8");
    }
    if (bytes > MAX_DEFINITION_CONTENT_BYTES) {
      return `definition content ${bytes} bytes exceeds ${MAX_DEFINITION_CONTENT_BYTES}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export class PackScanWorkerFailureError extends Error {
  readonly kind: "worker_failure" | "worker_output_validation";
  readonly diagnostic?: string;
  constructor(
    message: string,
    kind: "worker_failure" | "worker_output_validation",
    diagnostic?: string
  ) {
    super(message);
    this.name = "PackScanWorkerFailureError";
    this.kind = kind;
    this.diagnostic = diagnostic;
  }
}

export function errorFromPackScanWorkerFailure(response: {
  message: string;
  diagnostic?: string;
}): PackScanWorkerFailureError {
  return new PackScanWorkerFailureError(
    response.message,
    response.message.startsWith(WORKER_INVALID_RESPONSE_MESSAGE_PREFIX)
      ? "worker_output_validation"
      : "worker_failure",
    response.diagnostic
  );
}

export function requestIdFromWorkerMessage(message: unknown): string | null {
  if (message && typeof message === "object" && "requestId" in message) {
    const value = (message as { requestId: unknown }).requestId;
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
}

/** Bounded, redacted preview of worker stderr for logging. */
export function summarizePackScanWorkerStderr(chunk: Buffer): string | null {
  const text = chunk.toString("utf8").trim();
  if (!text) {
    return null;
  }
  const clipped = text.length > 512 ? `${text.slice(0, 512)}…` : text;
  return `pack-scan worker stderr: ${clipped}`;
}

/** Up to 5 Zod issues, each truncated, for a single-line diagnostic string. */
export function summarizePackScanWorkerResponseIssues(
  error: z.ZodError
): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".");
      const where = path ? `${path}: ` : "";
      const msg = issue.message.slice(0, 160);
      return `${where}${msg}`;
    })
    .join("; ");
}
