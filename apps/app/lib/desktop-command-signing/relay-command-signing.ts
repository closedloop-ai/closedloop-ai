import type { BrowserSignedCommandId } from "@repo/api/src/types/compute-target";
import {
  type RelayCommandSigningInput,
  RelayRequestError,
} from "@/lib/engineer/relay-client";
import {
  COMMAND_ID_HEADER,
  COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER,
  COMMAND_SIGNATURE_HEADER,
  COMMAND_SIGNATURE_PAYLOAD_HEADER,
} from "./constants";

/**
 * Reads browser command-signing fields from app route headers. A partial
 * signature is rejected so signed compute targets never receive unsigned
 * command rows by accident.
 */
export function collectCommandSigningHeaders(
  headers: Headers
): RelayCommandSigningInput | undefined {
  const commandId = headers.get(COMMAND_ID_HEADER)?.trim();
  const signature = headers.get(COMMAND_SIGNATURE_HEADER)?.trim();
  const signaturePayload = headers
    .get(COMMAND_SIGNATURE_PAYLOAD_HEADER)
    ?.trim();
  const publicKeyFingerprint = headers
    .get(COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER)
    ?.trim();

  if (!(commandId || signature || signaturePayload || publicKeyFingerprint)) {
    return undefined;
  }
  if (!(commandId && signature && signaturePayload && publicKeyFingerprint)) {
    throw new RelayRequestError("Incomplete command signing headers", 400);
  }
  return {
    commandId: commandId as BrowserSignedCommandId,
    signature,
    signaturePayload,
    publicKeyFingerprint,
  };
}
