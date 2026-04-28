import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

export const uuidV4Validator = z
  .string()
  .trim()
  .uuid()
  .refine(
    (value) =>
      value[14] === "4" &&
      ["8", "9", "a", "b", "A", "B"].includes(value[19] ?? ""),
    { message: "gatewayId must be a UUID v4" }
  );

export const registerComputeTargetValidator = z.object({
  machineName: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(80),
  capabilities: jsonObjectValidator.optional(),
  supportedOperations: z.array(z.string().trim().min(1)),
  allowedDirectories: z.array(z.string().trim().min(1)).optional(),
  pluginVersion: z.string().trim().min(1).max(120).optional(),
  gatewayId: uuidV4Validator.optional(),
  desktopSecurityUpgradeProtocolVersion: z.literal(1).optional(),
});

export const updateComputeTargetValidator = z
  .object({
    machineName: z.string().trim().min(1).max(120).optional(),
    platform: z.string().trim().min(1).max(80).optional(),
    capabilities: jsonObjectValidator.optional(),
    supportedOperations: z.array(z.string().trim().min(1)).optional(),
    gatewayId: uuidV4Validator.optional(),
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

export const createDesktopCommandValidator = z.object({
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
});
