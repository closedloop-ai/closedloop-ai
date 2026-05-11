import { z } from "zod";
import { commandPublicKeyFingerprintValidator } from "@/app/compute-targets/validators";

const PUBLIC_KEY_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const publicKeyRegistrationValidator = z.object({
  publicKeyBase64: z.string().trim().min(1).regex(PUBLIC_KEY_BASE64_PATTERN),
  fingerprint: commandPublicKeyFingerprintValidator,
});

export const publicKeyUnregisterValidator = z.object({
  fingerprint: commandPublicKeyFingerprintValidator,
});
