import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import type { JsonValue } from "@repo/api/src/types/common";
import type {
  DesktopAnalyticsEventName as ParsedDesktopAnalyticsEventName,
  DesktopAnalyticsPayload as ParsedDesktopAnalyticsPayload,
} from "@repo/api/src/types/desktop-analytics";
import {
  DESKTOP_ANALYTICS_SOCKET_EVENT as API_DESKTOP_ANALYTICS_SOCKET_EVENT,
  DESKTOP_ANALYTICS_STRING_MAX_LENGTH as API_DESKTOP_ANALYTICS_STRING_MAX_LENGTH,
  DesktopAnalyticsAckReason as ApiDesktopAnalyticsAckReason,
  DesktopAnalyticsEventName as ApiDesktopAnalyticsEventName,
  DesktopAnalyticsPropertyKey as ApiDesktopAnalyticsPropertyKey,
  DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH,
  DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS,
  DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS,
} from "@repo/api/src/types/desktop-analytics";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import { UUID_V4_PATTERN } from "@repo/api/src/types/onboarding-analytics";
import {
  GridviewRolloutDecisionOutcome,
  GridviewRolloutDecisionReason,
  SharedAnalyticsComponent,
  Surface,
} from "@repo/api/src/types/surface-analytics";
import { z } from "zod";
import { jsonObjectSchema } from "./json-schema";

export type {
  DesktopAnalyticsAck,
  DesktopAnalyticsPayload,
} from "@repo/api/src/types/desktop-analytics";

export const DESKTOP_ANALYTICS_SOCKET_EVENT =
  API_DESKTOP_ANALYTICS_SOCKET_EVENT;
export const DesktopAnalyticsAckReason = ApiDesktopAnalyticsAckReason;

export const DESKTOP_ANALYTICS_PROPERTY_MAX_BYTES = 8 * 1024;
export const DESKTOP_ANALYTICS_STRING_MAX_LENGTH =
  API_DESKTOP_ANALYTICS_STRING_MAX_LENGTH;

const DESKTOP_ANALYTICS_EVENT_NAME_VALUES = Object.values(
  ApiDesktopAnalyticsEventName
) as [ParsedDesktopAnalyticsEventName, ...ParsedDesktopAnalyticsEventName[]];
const desktopAnalyticsEventNameSchema = z.enum(
  DESKTOP_ANALYTICS_EVENT_NAME_VALUES
);

const allowedPropertyKeySchema = z.enum(ApiDesktopAnalyticsPropertyKey);

export const FORBIDDEN_IDENTITY_PROPERTY_KEY_VALUES = [
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

/**
 * ISS-10502 (PRD-736 D3), + `account_mode` (ISS-10913): the array-valued
 * properties (`steps_skipped`, `harnesses_detected`, `account_mode`) accept
 * bounded string arrays — and ONLY those keys do;
 * every other key stays primitive-valued. Elements are bounded strings, not
 * enum members: the vocabularies are closed at the emitters, and server-side
 * membership would reject the WHOLE event from a newer desktop whose
 * vocabulary this API predates (version skew + whole-payload `z.NEVER`).
 * The element cap is the tighter ARRAY one, so a fully-clamped payload
 * composes with DESKTOP_ANALYTICS_PROPERTY_MAX_BYTES (see the const's doc).
 */
const desktopAnalyticsArrayPropertyValueSchema = z
  .array(z.string().max(DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH))
  .max(DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS);

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

      const parsedValue = DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS.has(key)
        ? desktopAnalyticsArrayPropertyValueSchema.safeParse(value)
        : desktopAnalyticsPropertyValueSchema.safeParse(value);
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
    // ISS-10503 (PRD-736 D5, decision #12): the envelope-level client-supplied
    // distinct id. The v4-UUID shape check is the load-bearing injection
    // control — no client can put an arbitrary distinct id into PostHog.
    // Optional: authenticated calls omit it except the one alias-triggering
    // call after account establishment.
    distinctId: z
      .string()
      .regex(UUID_V4_PATTERN, { message: "distinct_id_invalid" })
      .optional(),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    if (
      payload.event !== ApiDesktopAnalyticsEventName.GridviewRolloutDecision
    ) {
      return;
    }
    const rolloutDecisionReason = validateGridviewRolloutDecisionProperties(
      payload.properties
    );
    if (rolloutDecisionReason) {
      ctx.addIssue({
        code: "custom",
        path: ["properties"],
        message: rolloutDecisionReason,
      });
    }
  })
  .transform((payload) => {
    if (
      payload.event !== ApiDesktopAnalyticsEventName.GridviewRolloutDecision
    ) {
      return payload;
    }
    return {
      ...payload,
      properties: normalizeGridviewRolloutDecisionProperties(
        payload.properties
      ),
    };
  });

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
      // Preserve omission (Cross-Repo rule): absent stays absent, never null.
      ...(parsed.data.distinctId === undefined
        ? {}
        : { distinctId: parsed.data.distinctId }),
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
  if (Array.isArray(value)) {
    return "property_array_invalid";
  }
  return "property_value_invalid";
}

function emptyPayloadProperties(): Record<string, JsonValue> {
  return {};
}

const GRIDVIEW_ROLLOUT_DECISION_OUTCOMES: ReadonlySet<JsonValue> = new Set(
  Object.values(GridviewRolloutDecisionOutcome)
);

const GRIDVIEW_ROLLOUT_DECISION_COMPONENTS: ReadonlySet<JsonValue> = new Set([
  SharedAnalyticsComponent.BranchesListSurfaceV2,
  SharedAnalyticsComponent.SessionsListSurfaceV2,
]);

const GRIDVIEW_ROLLOUT_DECISION_REASONS: ReadonlySet<JsonValue> = new Set([
  ...Object.values(BranchesListRolloutDecisionReason),
  ...Object.values(GridviewRolloutDecisionReason),
  ...Object.values(FeatureAssignmentDelivery),
]);

function validateGridviewRolloutDecisionProperties(
  properties: Record<string, JsonValue>
):
  | "gridview_rollout_decision_component_invalid"
  | "gridview_rollout_decision_outcome_invalid"
  | "gridview_rollout_decision_reason_invalid"
  | null {
  if (!GRIDVIEW_ROLLOUT_DECISION_COMPONENTS.has(properties.component)) {
    return "gridview_rollout_decision_component_invalid";
  }
  if (!GRIDVIEW_ROLLOUT_DECISION_OUTCOMES.has(properties.outcome)) {
    return "gridview_rollout_decision_outcome_invalid";
  }
  if (typeof properties.reason !== "string") {
    return "gridview_rollout_decision_reason_invalid";
  }
  return null;
}

function normalizeGridviewRolloutDecisionProperties(
  properties: Record<string, JsonValue>
): Record<string, JsonValue> {
  return {
    ...properties,
    reason: normalizeGridviewRolloutDecisionReason(properties.reason),
    surface: Surface.Desktop,
  };
}

function normalizeGridviewRolloutDecisionReason(reason: JsonValue): JsonValue {
  if (reason === GridviewRolloutDecisionReason.AssignmentUnresolved) {
    return FeatureAssignmentDelivery.Pending;
  }
  if (
    reason === GridviewRolloutDecisionReason.FlagEnabled ||
    reason === GridviewRolloutDecisionReason.FlagDisabled
  ) {
    return FeatureAssignmentDelivery.Assigned;
  }
  if (GRIDVIEW_ROLLOUT_DECISION_REASONS.has(reason)) {
    return reason;
  }
  return FeatureAssignmentDelivery.Unavailable;
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
  if (path === "distinctId") {
    return "distinct_id_invalid";
  }
  if (path === "properties") {
    return desktopAnalyticsPropertiesFailureReason(issue.message);
  }
  return "payload_not_object";
}

function desktopAnalyticsPropertiesFailureReason(message: string): string {
  switch (message) {
    case "property_not_allowed":
    case "property_array_invalid":
    case "property_number_invalid":
    case "property_string_too_long":
    case "property_value_invalid":
    case "properties_too_large":
    case "gridview_rollout_decision_component_invalid":
    case "gridview_rollout_decision_outcome_invalid":
    case "gridview_rollout_decision_reason_invalid":
      return message;
    default:
      return "properties_not_object";
  }
}
