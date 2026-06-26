import { z } from "zod";
import {
  commandPublicKeyFingerprintValidator,
  uuidV7Validator,
} from "@/app/compute-targets/validators";
import { additionalReposSchema, repoSchema } from "@/app/loops/validators";
import { COMMAND_MAP } from "./run-loop-helpers";

const loopCommands = Object.keys(COMMAND_MAP) as (keyof typeof COMMAND_MAP)[];

const userIntentSignatureSchema = z.object({
  commandId: uuidV7Validator,
  signature: z.string().min(1),
  signaturePayload: z.string().min(1),
  publicKeyFingerprint: commandPublicKeyFingerprintValidator,
  body: z.unknown(),
});

export const runLoopSchema = z
  .object({
    command: z.enum(loopCommands),
    prompt: z.string().max(100_000).optional(),
    repo: repoSchema.optional(),
    additionalRepos: additionalReposSchema,
    computeTargetId: z.uuid().nullable().optional(),
    backendOverride: z.boolean().optional(),
    userIntentSignature: userIntentSignatureSchema.optional(),
  })
  .strict();

export type RunLoopBody = z.infer<typeof runLoopSchema>;
