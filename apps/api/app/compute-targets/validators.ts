import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";
import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import type {
  CheckResult,
  CheckResultRepair,
} from "@repo/api/src/types/compute-target";
import {
  HarnessType,
  HealthCheckRepairAction,
  PluginUpdateOutcome,
} from "@repo/api/src/types/compute-target";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

export const uuidValidator = z.uuid();
export const uuidV7Validator = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Must be a UUID v7"
  );
const signatureBase64Validator = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Must be a base64 signature");
/** Validates command-signing public-key fingerprints produced by SHA-256 base64url truncation. */
export const commandPublicKeyFingerprintValidator = z
  .string()
  .trim()
  .regex(/^cl:[A-Za-z0-9_-]{22}$/, "Must be a command public-key fingerprint");

export const registerComputeTargetValidator = z.object({
  machineName: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(80),
  capabilities: jsonObjectValidator.optional(),
  supportedOperations: z.array(z.string().trim().min(1)),
  allowedDirectories: z.array(z.string().trim().min(1)).optional(),
  pluginVersion: z.string().trim().min(1).max(120).optional(),
  gatewayId: uuidValidator.optional(),
  desktopSecurityUpgradeProtocolVersion: z.literal(1).optional(),
});

export const updateComputeTargetValidator = z
  .object({
    machineName: z.string().trim().min(1).max(120).optional(),
    platform: z.string().trim().min(1).max(80).optional(),
    capabilities: jsonObjectValidator.optional(),
    supportedOperations: z.array(z.string().trim().min(1)).optional(),
    gatewayId: uuidValidator.optional(),
    desktopSecurityUpgradeProtocolVersion: z.literal(1).optional(),
    selectedHarness: z.enum(HarnessType).optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field must be provided",
  });

export const relayOperationDispatchValidator = z.object({
  operationId: z.string().trim().min(1),
  operation: z.string().trim().min(1),
  params: z.unknown(),
  streaming: z.boolean(),
});

export const relayResultIngestValidator = z.union([
  z.object({
    operationId: z.string().trim().min(1),
    result: z.unknown(),
    sequence: z.number().int().nonnegative().optional(),
  }),
  z.object({
    operationId: z.string().trim().min(1),
    event: z.unknown(),
    done: z.boolean().optional(),
    error: z.string().trim().min(1).optional(),
    sequence: z.number().int().nonnegative().optional(),
  }),
]);

export const setSharingValidator = z.object({
  isSharedWithOrg: z.boolean(),
});

const healthCheckDebugValidator = z
  .object({
    errorCode: z.string().optional(),
    stderr: z.string().optional(),
    resolvedPath: z.string().optional(),
    shell: z.string().optional(),
    platform: z.string().optional(),
    foundAt: z.array(z.string()).optional(),
    overrideUsed: z.string().optional(),
  })
  .passthrough();

const remediationLinkUrlValidator = z.url().refine(
  (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "Remediation link URLs must use HTTPS" }
);

const pluginUpdateOutcomeValues = new Set<string>(
  Object.values(PluginUpdateOutcome)
);
/**
 * Keeps only an outcome this build knows, and degrades EVERYTHING else —
 * including a non-string — to absent.
 *
 * The earlier spelling only rewrote an unrecognised STRING, so a gateway
 * sending `enableOutcome: null` (or a number) handed the raw value straight to
 * the enum and failed it. Rejection here is not field-scoped or even
 * row-scoped: `healthCheckSnapshotValidator` fails the whole PUT, so one
 * unusable outcome discarded every other row's `repair`, `severity` and
 * `passed` and left the STALE snapshot in place — re-dropped on every retry
 * (ISS-5868, same class as the `severity` guard below).
 */
const optionalPluginUpdateOutcomeValidator = z.preprocess(
  (value) =>
    typeof value === "string" && pluginUpdateOutcomeValues.has(value)
      ? value
      : undefined,
  z.enum(PluginUpdateOutcome).optional()
);

const checkSeverityValues = new Set<string>(Object.values(CheckSeverity));

const repairActionValues = new Set<string>(
  Object.values(HealthCheckRepairAction)
);
/**
 * A newer gateway can name a repair action this build has never heard of; drop
 * the unknown action rather than rejecting the row, exactly as the plugin
 * outcome validator above does — and for the same reason, a non-string `action`
 * degrades to absent instead of failing the whole snapshot PUT (ISS-5868).
 * `repairable: true` with no recognised action already means "this build cannot
 * drive it", which is the honest reading of an action it cannot parse.
 */
export const healthCheckRepairShape = {
  repairable: z.boolean(),
  action: z.preprocess(
    (value) =>
      typeof value === "string" && repairActionValues.has(value)
        ? value
        : undefined,
    z.enum(HealthCheckRepairAction).optional()
  ),
  reason: z.string().optional(),
  blockedByCheckId: z.string().optional(),
} satisfies Record<keyof CheckResultRepair, z.ZodTypeAny>;
const healthCheckRepairValidator = z.object(healthCheckRepairShape);

/**
 * The persist-boundary shape for one check row.
 *
 * `satisfies Record<keyof CheckResult, z.ZodTypeAny>` is the compile-time
 * keys-covered guard (ISS-5712's pattern, applied here by ISS-5868). This
 * object has no `.passthrough()`, so a field the shared `CheckResult` contract
 * gains and this schema is never taught is STRIPPED on its way into storage —
 * silently, and only on the HYDRATED path, which is exactly how `severity` was
 * lost for days (ISS-5811). With the guard, the next field added to
 * `CheckResult` fails `tsc` here instead of failing in production.
 */
export const healthCheckResultShape = {
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  required: z.boolean(),
  passed: z.boolean(),
  version: z.string().optional(),
  error: z.string().optional(),
  remediation: z.string().optional(),
  debug: healthCheckDebugValidator.optional(),
  enableAttempted: z.boolean().optional(),
  enableOutcome: optionalPluginUpdateOutcomeValidator,
  enablePluginIds: z.array(z.string().trim().min(1)).optional(),
  updateAttempted: z.boolean().optional(),
  updateOutcome: optionalPluginUpdateOutcomeValidator,
  updatePluginIds: z.array(z.string().trim().min(1)).optional(),
  remediationLinks: z
    .array(
      z.object({
        label: z.string().trim().min(1),
        url: remediationLinkUrlValidator,
      })
    )
    .optional(),
  // Repairability, from ISS-5389. This object has no `.passthrough()`, so a
  // field the gateway sends and this validator has never heard of is STRIPPED
  // before the snapshot reaches storage — and the pre-loop provider hydrates
  // from that stored snapshot, so an omission here would make a repairable
  // target read as "Repair unsupported" on every hydrated render.
  repair: healthCheckRepairValidator.optional(),
  // Severity tiers, from ISS-5369, declared here for exactly the reason the
  // `repair` comment above gives: ISS-5369 taught the gateway to mark an
  // undeterminable row `severity: "unknown"` ("not-determinable, not a proven
  // failure") but never taught this validator the field, so every severity the
  // gateway sent was stripped on its way into storage. The live in-browser
  // schema passes it through, so only the HYDRATED path lost it — which is why
  // a stored snapshot read back showed `severity` absent on every row while the
  // producer had set it (ISS-5811).
  //
  // The guard drops ANYTHING that is not a tier this build knows, non-strings
  // included — the shape every preprocessor on this schema now uses (ISS-5868
  // brought the plugin-outcome and repair-action guards above into line). That
  // matters here: this validator has no `.passthrough()` and rejection is not
  // row-scoped — a single unparseable field fails the whole snapshot PUT, so a
  // gateway that ever sent `severity: null` would take every other row's
  // `repair`, `remediation` and `passed` down with it. Degrading an unusable
  // value to "absent" is the graceful failure; rejecting the payload is not.
  severity: z.preprocess(
    (value) =>
      typeof value === "string" && checkSeverityValues.has(value)
        ? value
        : undefined,
    z.enum(CheckSeverity).optional()
  ),
  // Set alongside `severity: "blocked"`; names the row that must be fixed
  // first. Guarded the same way as `severity` directly above, and for the same
  // reason: rejection here is not row-scoped, so a gateway sending
  // `blockedBy: null` — or the empty string a trimmed-but-unset field becomes —
  // would 400 the whole snapshot PUT and leave the STALE snapshot in place,
  // discarding every valid row in the new one. The name is a pointer used to
  // label one row; dropping an unusable pointer costs that label, while
  // rejecting costs the entire refresh.
  blockedBy: z.preprocess((value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, z.string().optional()),
} satisfies Record<keyof CheckResult, z.ZodTypeAny>;

export const healthCheckResultValidator = z.object(healthCheckResultShape);

// `repair` is declared explicitly on BOTH shapes rather than left to
// `.passthrough()`. Passthrough would preserve the field but skip the
// unknown-action preprocessor above, letting an action this build has never
// heard of reach storage and, from there, `pre-loop-system-check-provider`
// (ISS-5435; same trap ISS-5389 hit on `healthCheckResultValidator`).
const mcpProviderAvailabilityValidator = z.union([
  z
    .object({
      available: z.boolean(),
      serverName: z.string().nullable(),
      matchedUrl: z.string().nullable(),
      checkedAt: z.string(),
      error: z.string().nullable().optional(),
      repair: healthCheckRepairValidator.optional(),
    })
    .passthrough(),
  z
    .object({
      closedloopAvailable: z.boolean(),
      checkedAt: z.string(),
      repair: healthCheckRepairValidator.optional(),
    })
    .passthrough(),
]);

const mcpServersValidator = z
  .object({
    claude: mcpProviderAvailabilityValidator,
    codex: mcpProviderAvailabilityValidator,
  })
  .partial();

/**
 * Byte cap on one System Check snapshot PUT, declared beside the shape it bounds
 * — the two together are the persist boundary for this payload.
 *
 * 256 KiB, matching `DESKTOP_TELEMETRY_REQUEST_MAX_BYTES` (the cap already
 * carried by the other Desktop-gateway→cloud request body) rather than a number
 * invented here. A real snapshot is a couple of dozen check rows, so this is
 * generous by design: a false 413 discards the entire refresh and leaves the
 * STALE snapshot in place, which is the whole-payload rejection ISS-5868 exists
 * to remove. The cap is here to stop an authenticated caller spending unbounded
 * server memory, not to police a plausible payload.
 */
export const HEALTH_CHECK_SNAPSHOT_MAX_BYTES = 262_144;

export const healthCheckSnapshotValidator = z.object({
  expectedMcpUrl: z.string().trim().min(1).nullable().optional(),
  latestVersion: z.string().trim().min(1).max(120).nullable().optional(),
  pluginAutoUpdateEnabled: z.boolean().optional(),
  // No .passthrough() here: the parsed result is persisted directly into the
  // ComputeTargetHealthCheck.result JSON column, so unknown top-level fields are
  // stripped at the parse boundary instead of flowing into storage unvalidated.
  // (mcpServers retains forward-compatible passthrough for provider sub-fields.)
  result: z.object({
    checks: z.array(healthCheckResultValidator),
    allRequiredPassed: z.boolean(),
    mcpServers: mcpServersValidator.optional(),
  }),
});

export const createDesktopCommandValidator = z
  .object({
    commandId: uuidV7Validator.optional(),
    operationId: z.string().trim().min(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z
      .string()
      .trim()
      .min(1)
      .refine((value) => isDesktopApiPath(value), {
        message: "Path must target /api/gateway/*",
      }),
    headers: z.record(z.string(), z.string()).optional(),
    query: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional(),
    body: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
    lockKey: z.string().trim().min(1).optional(),
    requiresApproval: z.boolean().optional(),
    approvalReason: z.string().trim().min(1).optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    streaming: z.boolean().optional(),
    signature: signatureBase64Validator.optional(),
    signaturePayload: z.string().trim().min(1).optional(),
    publicKeyFingerprint: commandPublicKeyFingerprintValidator.optional(),
  })
  .superRefine((value, ctx) => {
    const signatureFieldCount = [
      value.signature,
      value.signaturePayload,
      value.publicKeyFingerprint,
    ].filter((entry) => entry !== undefined).length;
    if (signatureFieldCount === 0 || signatureFieldCount === 3) {
      return;
    }
    ctx.addIssue({
      code: "custom",
      message:
        "signature, signaturePayload, and publicKeyFingerprint must be provided together",
      path: ["signature"],
    });
  });

/**
 * Body validator for a member self-service pack install dispatch
 * (POST /compute-targets/:id/member-installs, FEA-4082). The target id rides on
 * the path (authorized server-side against member ownership); the body names
 * the pack and harness.
 */
export const memberPackInstallValidator = z.object({
  packId: z.string().trim().min(1).max(200),
  harness: z.string().trim().min(1).max(80),
});
