/**
 * @file desktop-agent-components-parse.ts
 * @description ISS-4662 — the sanitize-then-validate entry point for
 * `POST /desktop/components/sync`.
 *
 * Split from `desktop-agent-sessions-schema.ts` (which is at the
 * `noExcessiveLinesPerFile` ceiling) because it is its own responsibility: that
 * file DEFINES the wire shapes, this one owns what a route must do to a raw body
 * before trusting it. The session lane's equivalent (`parseDesktopAgentSessionsPayload`)
 * still lives beside its schemas; when that file is next split, this is where its
 * parse half belongs too.
 */
import { isAgentComponentSyncSchemaVersionSkew } from "@repo/api/src/types/agent-component-sync-schema-version";
import {
  type RedactedDefinitionBody,
  redactDefinitionBody,
} from "@repo/lib/security/redact-definition-content";
import {
  PostgresJsonDepthExceededError,
  sanitizePostgresJson,
} from "./agent-sessions-text-sanitizer";
import { summarizeParseIssues } from "./desktop-agent-sessions-parse-guards";
import {
  type DesktopAgentComponentsPayload,
  desktopAgentComponentsPayloadSchema,
} from "./desktop-agent-sessions-schema";
import { isRecord } from "./type-guards";

/**
 * Outcome of {@link parseDesktopAgentComponentsPayload}.
 *
 * `schemaVersionSkew` is the WHOLE skew verdict, not an ingredient of one: the
 * batch's only defect is its `schemaVersion`, and that version is one an API
 * deploy could come to accept. Only the parser can answer it — `reason` is
 * summarized from the first issue alone, so it cannot distinguish a batch whose
 * sole defect is its version from one that is also malformed elsewhere, and the
 * version has to be read off the SANITIZED payload the schema actually judged
 * rather than off the raw body. Version skew is the one rejection an API deploy
 * can fix, so it is the only one that earns the cursor-holding 400 (ISS-7978),
 * now coded `schema_version_unsupported` (ISS-8609).
 */
export type DesktopAgentComponentsParseResult =
  | { ok: true; payload: DesktopAgentComponentsPayload }
  | { ok: false; reason: string; schemaVersionSkew: boolean };

/**
 * Parse a `POST /desktop/components/sync` body, sanitizing it for Postgres FIRST.
 *
 * The component lane persists `content` — and now every variant `content` — into
 * Postgres `text`, which rejects NUL and lone surrogates. This route validated
 * the RAW body, so one NUL-bearing definition passed the schema and then threw
 * from the write as an opaque 500, leaving the desktop's cursor to retry the same
 * poison batch forever (whitlockk, #4295). The session lane has sanitized before
 * validation since FEA-2258 for exactly this reason; this reuses that sanitizer
 * rather than adding a second one.
 *
 * Sanitizing BEFORE the schema (not after) matters for the same reason it does
 * there: stripping a NUL can shorten or empty a string, so a sanitize-after-validate
 * would let a required `min(1)` identity field pass as `"\0"` and then collapse to
 * `""` — a shape the schema would have rejected. Validating the sanitized payload
 * guarantees the values that reach the database still satisfy the schema.
 *
 * Unlike the session lane this does NOT run the key-collision assertion. That is
 * a GAP, not a design choice, and the comment here previously asserted the
 * opposite — ISS-7560 measured it. Each component carries a free-form `metadata`
 * blob (`optionalJsonObjectSchema`) whose keys are persisted verbatim into jsonb
 * by `app/desktop/components/sync/service.ts`, so two keys that collapse to one
 * after sanitization DO silently drop a persisted field here, exactly as they
 * would on the session lane: `{"a\0b": x, "ab": y}` reaches the database as
 * `{"ab": y}`.
 *
 * Closing that gap is a cross-repo contract change awaiting a human ruling, not
 * an implementation-task call: the assertion must be scoped to `components[]
 * .metadata` (FEA-2691 requires collisions in schema-stripped desktop-local keys
 * to stay tolerated), and it turns a batch a shipped desktop sends today from a
 * 200 into a 400. When that ruling lands, copy the session lane wholesale —
 * `assertPersistedJsonBlobsHaveNoKeyCollision` plus its paired
 * `PostgresJsonKeyCollisionError` → `payload_sanitized_key_collision` arm,
 * `desktop-agent-sessions-schema.ts:940-946`. Until then this lane cannot throw
 * that error, so carrying a catch for it here would be unreachable code.
 */
export function parseDesktopAgentComponentsPayload(
  payload: unknown
): DesktopAgentComponentsParseResult {
  let sanitizedPayload: unknown;
  try {
    sanitizedPayload = sanitizePostgresJson(payload);
  } catch (error) {
    if (error instanceof PostgresJsonDepthExceededError) {
      return {
        ok: false,
        reason: "payload_nested_too_deeply",
        schemaVersionSkew: false,
      };
    }
    throw error;
  }
  const parsed =
    desktopAgentComponentsPayloadSchema.safeParse(sanitizedPayload);
  if (!parsed.success) {
    const schemaVersionOnly = parsed.error.issues.every(
      (issue) => issue.path[0] === "schemaVersion"
    );
    return {
      ok: false,
      reason: summarizeParseIssues(parsed.error.issues),
      // Both halves read the SAME sanitized payload. Deriving the version half
      // from the raw body instead let the two disagree wherever sanitizing
      // changes it — the `metadata` key-collision gap documented above — so the
      // predicate judged a value the schema never saw.
      schemaVersionSkew:
        schemaVersionOnly &&
        isRecord(sanitizedPayload) &&
        Object.hasOwn(sanitizedPayload, "schemaVersion") &&
        isAgentComponentSyncSchemaVersionSkew(sanitizedPayload.schemaVersion),
    };
  }
  return { ok: true, payload: redactComponentContent(parsed.data) };
}

/**
 * ISS-4965: scrub secrets out of every definition body before it is persisted,
 * for a Desktop build that predates the producer-side redaction. Runs AFTER the
 * schema so a marker longer than the token it replaces can never turn an
 * accepted batch into a rejected one.
 */
function redactComponentContent(
  payload: DesktopAgentComponentsPayload
): DesktopAgentComponentsPayload {
  return {
    ...payload,
    components: payload.components.map((component) => ({
      ...component,
      ...(typeof component.content === "string"
        ? redactBody(
            component.content,
            component.componentKind,
            component.usageScopeHash
          )
        : {}),
      ...(component.variants
        ? {
            variants: component.variants.map((variant) => ({
              ...variant,
              ...redactBody(
                variant.content,
                component.componentKind,
                variant.usageScopeHash
              ),
            })),
          }
        : {}),
    })),
  };
}

/**
 * ISS-4965: a digest the producer sent was taken over the text as written, so
 * it wins over one derived here from a body the producer had already redacted.
 */
function redactBody(
  content: string,
  componentKind: string,
  sentUsageScopeHash: string | undefined
): RedactedDefinitionBody {
  const body = redactDefinitionBody(content, componentKind);
  return sentUsageScopeHash
    ? { ...body, usageScopeHash: sentUsageScopeHash }
    : body;
}
