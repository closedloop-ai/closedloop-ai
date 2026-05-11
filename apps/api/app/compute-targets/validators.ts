import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import { PluginUpdateOutcome } from "@repo/api/src/types/compute-target";
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

const healthCheckResultValidator = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  required: z.boolean(),
  passed: z.boolean(),
  version: z.string().optional(),
  error: z.string().optional(),
  remediation: z.string().optional(),
  debug: healthCheckDebugValidator.optional(),
  updateAttempted: z.boolean().optional(),
  updateOutcome: z.enum(PluginUpdateOutcome).optional(),
  updatePluginIds: z.array(z.string().trim().min(1)).optional(),
  remediationLinks: z
    .array(
      z.object({
        label: z.string().trim().min(1),
        url: remediationLinkUrlValidator,
      })
    )
    .optional(),
});

const mcpProviderAvailabilityValidator = z.union([
  z
    .object({
      available: z.boolean(),
      serverName: z.string().nullable(),
      matchedUrl: z.string().nullable(),
      checkedAt: z.string(),
      error: z.string().nullable().optional(),
    })
    .passthrough(),
  z
    .object({
      closedloopAvailable: z.boolean(),
      checkedAt: z.string(),
    })
    .passthrough(),
]);

const mcpServersValidator = z
  .object({
    claude: mcpProviderAvailabilityValidator,
    codex: mcpProviderAvailabilityValidator,
  })
  .partial();

export const healthCheckSnapshotValidator = z.object({
  expectedMcpUrl: z.string().trim().min(1).nullable().optional(),
  latestVersion: z.string().trim().min(1).max(120).nullable().optional(),
  pluginAutoUpdateEnabled: z.boolean().optional(),
  result: z
    .object({
      checks: z.array(healthCheckResultValidator),
      allRequiredPassed: z.boolean(),
      mcpServers: mcpServersValidator.optional(),
    })
    .passthrough(),
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
        message: "Path must target /api/gateway/* or /api/engineer/*",
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
