export const CloudSocketState = {
  Degraded: "degraded",
  Idle: "idle",
  Online: "online",
} as const;

export type CloudSocketState =
  (typeof CloudSocketState)[keyof typeof CloudSocketState];

export const CloudSocketError = {
  DecryptionFailed:
    "Stored API key could not be decrypted — re-enter the key in Settings",
  MissingApiKey: "Missing API key for cloud socket connection",
} as const;
