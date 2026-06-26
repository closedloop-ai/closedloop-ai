import { z } from "zod";
import {
  commandPublicKeyFingerprintValidator,
  uuidValidator,
} from "@/app/compute-targets/validators";

const PUBLIC_KEY_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const publicKeyRegistrationValidator = z.object({
  publicKeyBase64: z.string().trim().min(1).regex(PUBLIC_KEY_BASE64_PATTERN),
  fingerprint: commandPublicKeyFingerprintValidator,
});

export const publicKeyListQueryValidator = z
  .object({
    computeTargetId: uuidValidator.optional(),
    gatewayId: uuidValidator.optional(),
  })
  .refine((query) => !query.gatewayId || query.computeTargetId, {
    message: "computeTargetId is required when gatewayId is provided",
    path: ["computeTargetId"],
  });

export const publicKeyUnregisterValidator = z.object({
  fingerprint: commandPublicKeyFingerprintValidator,
});
