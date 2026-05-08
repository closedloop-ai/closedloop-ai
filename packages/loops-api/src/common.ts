/**
 * JSON-compatible types for loop contract payloads.
 * Defined locally to avoid dependency on @repo/api.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
