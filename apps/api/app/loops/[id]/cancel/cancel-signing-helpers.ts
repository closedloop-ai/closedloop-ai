import { z } from "zod";
import {
  commandPublicKeyFingerprintValidator,
  uuidV7Validator,
} from "@/app/compute-targets/validators";

const cancelUserIntentSignatureSchema = z
  .object({
    userIntentSignature: z
      .object({
        commandId: uuidV7Validator,
        signature: z.string().min(1),
        signaturePayload: z.string().min(1),
        publicKeyFingerprint: commandPublicKeyFingerprintValidator,
        body: z.unknown(),
      })
      .optional(),
  })
  .optional();

const cancelUserIntentBodySchema = z.object({
  loopId: z.string().trim().min(1),
});

export type CancelUserIntentSignature = NonNullable<
  z.infer<typeof cancelUserIntentSignatureSchema>
>["userIntentSignature"];

/**
 * Reads the optional browser-signed cancel intent from a cancel request body.
 * Missing or malformed bodies degrade to the legacy unsigned cancel path.
 */
export async function readCancelUserIntentSignature(
  request: Request
): Promise<CancelUserIntentSignature | undefined> {
  const rawBody = await request.json().catch(() => undefined);
  const parsed = cancelUserIntentSignatureSchema.safeParse(rawBody);
  return parsed.success ? parsed.data?.userIntentSignature : undefined;
}

/**
 * Reads the loop ID covered by a signed cancel intent. The route URL and signed
 * intent must match before the Desktop kill command is dispatched.
 */
export function readCancelUserIntentLoopId(
  signature: CancelUserIntentSignature
): string | undefined {
  const parsed = cancelUserIntentBodySchema.safeParse(signature?.body);
  return parsed.success ? parsed.data.loopId : undefined;
}
