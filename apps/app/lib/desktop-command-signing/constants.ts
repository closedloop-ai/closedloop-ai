/**
 * App-local HTTP header names used to route and verify browser-originated
 * Desktop command signing material through relay surfaces.
 */
export const COMPUTE_TARGET_HEADER = "x-compute-target" as const;
export const COMMAND_ID_HEADER = "x-command-id" as const;
export const COMMAND_SIGNATURE_HEADER = "x-command-signature" as const;
export const COMMAND_SIGNATURE_PAYLOAD_HEADER =
  "x-command-signature-payload" as const;
export const COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER =
  "x-command-public-key-fingerprint" as const;
