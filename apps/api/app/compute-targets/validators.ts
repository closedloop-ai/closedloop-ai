import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import { z } from "zod";
import {
  ALLOWED_DIRECTORIES_MAX_COUNT,
  ALLOWED_DIRECTORY_MAX_LENGTH,
  APPROVAL_REASON_MAX_LENGTH,
  isHeaderSafeReason,
  LOCK_KEY_MAX_LENGTH,
  MACHINE_NAME_MAX_LENGTH,
  OPERATION_ID_MAX_LENGTH,
  SIGNATURE_PAYLOAD_MAX_LENGTH,
  SUPPORTED_OPERATION_MAX_LENGTH,
  SUPPORTED_OPERATIONS_MAX_COUNT,
} from "@/lib/compute-target-field-limits";
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

/**
 * Both land verbatim in `ComputeTarget.supportedOperations` / the allowed-dirs
 * JSON column, which every compute-target read echoes back, so an unbounded one
 * is a stored blob the API then re-serves. No btree sits on either column, so
 * this is a size bound, not the 54000 class.
 */
const supportedOperationsSchema = z
  .array(z.string().trim().min(1).max(SUPPORTED_OPERATION_MAX_LENGTH))
  .max(SUPPORTED_OPERATIONS_MAX_COUNT);

const allowedDirectoriesSchema = z
  .array(z.string().trim().min(1).max(ALLOWED_DIRECTORY_MAX_LENGTH))
  .max(ALLOWED_DIRECTORIES_MAX_COUNT);

export const registerComputeTargetValidator = z.object({
  machineName: z.string().trim().min(1).max(MACHINE_NAME_MAX_LENGTH),
  platform: z.string().trim().min(1).max(80),
  capabilities: jsonObjectValidator.optional(),
  supportedOperations: supportedOperationsSchema,
  allowedDirectories: allowedDirectoriesSchema.optional(),
  pluginVersion: z.string().trim().min(1).max(120).optional(),
  gatewayId: uuidValidator.optional(),
  desktopSecurityUpgradeProtocolVersion: z.literal(1).optional(),
});

export const createDesktopCommandValidator = z
  .object({
    commandId: uuidV7Validator.optional(),
    operationId: z.string().trim().min(1).max(OPERATION_ID_MAX_LENGTH),
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
    lockKey: z.string().trim().min(1).max(LOCK_KEY_MAX_LENGTH).optional(),
    requiresApproval: z.boolean().optional(),
    approvalReason: z
      .string()
      .trim()
      .min(1)
      .max(APPROVAL_REASON_MAX_LENGTH)
      .refine((value) => isHeaderSafeReason(value), {
        message:
          "approvalReason must not contain control characters or code points above U+00FF",
      })
      .optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    streaming: z.boolean().optional(),
    signature: signatureBase64Validator.optional(),
    signaturePayload: z
      .string()
      .trim()
      .min(1)
      .max(SIGNATURE_PAYLOAD_MAX_LENGTH)
      .optional(),
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
