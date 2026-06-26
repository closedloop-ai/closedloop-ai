import type { JsonValue } from "@repo/api/src/types/common";
import type {
  DesktopAnalyticsEventName as ParsedDesktopAnalyticsEventName,
  DesktopAnalyticsPayload as ParsedDesktopAnalyticsPayload,
} from "@repo/api/src/types/desktop-analytics";
import {
  DESKTOP_ANALYTICS_SOCKET_EVENT as API_DESKTOP_ANALYTICS_SOCKET_EVENT,
  DESKTOP_SERVER_ANALYTICS_RELAY_FLAG as API_DESKTOP_SERVER_ANALYTICS_RELAY_FLAG,
  DesktopAnalyticsAckReason as ApiDesktopAnalyticsAckReason,
  DesktopAnalyticsEventName as ApiDesktopAnalyticsEventName,
} from "@repo/api/src/types/desktop-analytics";
import { z } from "zod";
import { jsonObjectSchema } from "./json-schema";

export type {
  DesktopAnalyticsAck,
  DesktopAnalyticsPayload,
} from "@repo/api/src/types/desktop-analytics";

export const DESKTOP_ANALYTICS_SOCKET_EVENT =
  API_DESKTOP_ANALYTICS_SOCKET_EVENT;
export const DESKTOP_SERVER_ANALYTICS_RELAY_FLAG =
  API_DESKTOP_SERVER_ANALYTICS_RELAY_FLAG;
export const DesktopAnalyticsAckReason = ApiDesktopAnalyticsAckReason;

export const DESKTOP_ANALYTICS_PROPERTY_MAX_BYTES = 8 * 1024;
export const DESKTOP_ANALYTICS_STRING_MAX_LENGTH = 512;

const DESKTOP_ANALYTICS_EVENT_NAME_VALUES = Object.values(
  ApiDesktopAnalyticsEventName
) as [ParsedDesktopAnalyticsEventName, ...ParsedDesktopAnalyticsEventName[]];
const desktopAnalyticsEventNameSchema = z.enum(
  DESKTOP_ANALYTICS_EVENT_NAME_VALUES
);

const ALLOWED_PROPERTY_KEY_VALUES = [
  "check_id",
  "command_id",
  "desktop_client_version",
  "duration_ms",
  "environment",
  "error",
  "error_class",
  "error_code",
  "failure_reason",
  "found_elsewhere",
  "latency_ms",
  "operation_class",
  "operation_type",
  "outcome",
  "payload_bytes",
  "platform",
  "plugin_count",
  "reason",
  "replay_command_count",
  "session_count",
  "shell",
  "surface",
  "sync_mode",
  "time_to_resolve_ms",
  "version",
] as const;
const allowedPropertyKeySchema = z.enum(ALLOWED_PROPERTY_KEY_VALUES);

const FORBIDDEN_IDENTITY_PROPERTY_KEY_VALUES = [
  "distinctId",
  "distinct_id",
  "clerkUserId",
  "clerk_user_id",
  "organizationId",
  "organization_id",
  "userId",
  "user_id",
  "computeTargetId",
  "compute_target_id",
] as const;
const forbiddenIdentityPropertyKeySchema = z.enum(
  FORBIDDEN_IDENTITY_PROPERTY_KEY_VALUES
);

// Early Desktop analytics builds sent this generic duplicate of
// desktop_client_version. Accept and drop it for version-skew compatibility.
const LEGACY_DROPPED_PROPERTY_KEY_VALUES = ["version"] as const;
const legacyDroppedPropertyKeySchema = z.enum(
  LEGACY_DROPPED_PROPERTY_KEY_VALUES
);

const desktopAnalyticsPropertyValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
]);

const desktopAnalyticsPropertiesSchema = z
  .unknown()
  .pipe(jsonObjectSchema)
  .transform((properties, ctx) => {
    const sanitized: Record<string, JsonValue> = {};
    const acceptedPropertiesForSize: Record<string, JsonValue> = {};

    for (const [key, value] of Object.entries(properties)) {
      if (forbiddenIdentityPropertyKeySchema.safeParse(key).success) {
        continue;
      }
      if (!allowedPropertyKeySchema.safeParse(key).success) {
        ctx.addIssue({
          code: "custom",
          message: "property_not_allowed",
        });
        return z.NEVER;
      }

      const parsedValue = desktopAnalyticsPropertyValueSchema.safeParse(value);
      if (!parsedValue.success) {
        ctx.addIssue({
          code: "custom",
          message: desktopAnalyticsPropertyValueReason(value),
        });
        return z.NEVER;
      }
      acceptedPropertiesForSize[key] = parsedValue.data;
      if (legacyDroppedPropertyKeySchema.safeParse(key).success) {
        continue;
      }
      sanitized[key] = parsedValue.data;
    }

    if (
      Buffer.byteLength(JSON.stringify(acceptedPropertiesForSize), "utf8") >
      DESKTOP_ANALYTICS_PROPERTY_MAX_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message: "properties_too_large",
      });
      return z.NEVER;
    }

    return sanitized;
  });

const desktopAnalyticsPayloadSchema = z
  .object({
    event: desktopAnalyticsEventNameSchema,
    occurredAt: z
      .string()
      .transform((value) => value.trim())
      .refine(
        (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
        { message: "occurred_at_invalid" }
      ),
    properties: desktopAnalyticsPropertiesSchema
      .optional()
      .default(emptyPayloadProperties),
  })
  .passthrough();

export type DesktopAnalyticsParseResult =
  | { ok: true; payload: ParsedDesktopAnalyticsPayload }
  | { ok: false; reason: string };

/**
 * Parses the Desktop product-analytics wire payload. The schema is intentionally
 * narrow because server-side identity enrichment is authoritative and Electron
 * must not control user/org/target attribution.
 */
export function parseDesktopAnalyticsPayload(
  payload: unknown
): DesktopAnalyticsParseResult {
  const parsed = desktopAnalyticsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: desktopAnalyticsParseFailureReason(parsed.error.issues),
    };
  }

  return {
    ok: true,
    payload: {
      event: parsed.data.event,
      properties: parsed.data.properties,
      occurredAt: parsed.data.occurredAt,
    },
  };
}

function desktopAnalyticsPropertyValueReason(value: unknown): string {
  if (typeof value === "string") {
    return "property_string_too_long";
  }
  if (typeof value === "number") {
    return "property_number_invalid";
  }
  return "property_value_invalid";
}

function emptyPayloadProperties(): Record<string, JsonValue> {
  return {};
}

function desktopAnalyticsParseFailureReason(
  issues: Array<{ path: PropertyKey[]; message: string }>
): string {
  const issue = issues[0];
  const path = issue?.path[0];
  if (!issue || path === undefined) {
    return "payload_not_object";
  }
  if (path === "event") {
    return "event_not_allowed";
  }
  if (path === "occurredAt") {
    return "occurred_at_invalid";
  }
  if (path === "properties") {
    return desktopAnalyticsPropertiesFailureReason(issue.message);
  }
  return "payload_not_object";
}

function desktopAnalyticsPropertiesFailureReason(message: string): string {
  switch (message) {
    case "property_not_allowed":
    case "property_number_invalid":
    case "property_string_too_long":
    case "property_value_invalid":
    case "properties_too_large":
      return message;
    default:
      return "properties_not_object";
  }
}
