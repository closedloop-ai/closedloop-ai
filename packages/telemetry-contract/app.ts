import { z } from "zod";
import { AppExceptionOrigin } from "./app-exception-origin";
import { TelemetryAttribute } from "./src/attributes";
import { boundedText, TelemetryTextMaxLength } from "./src/schema-primitives";

/**
 * ISS-5103: closed, low-cardinality set of sqlite import record-group labels for
 * the `import.group_label` attribute. The SSOT for the values (precedent:
 * `SyncReason` in `sync.ts`): the thirteen `runGroup` labels the desktop
 * write-core passes at its call sites, plus `unknown` — the version-skew
 * fallback a newer desktop maps an unrecognized label to, so cardinality stays
 * capped when write-core gains a group before this contract learns it. A
 * desktop-side guard test asserts exact set equality against the write-core
 * call sites, so the two cannot drift silently.
 */
export const ImportGroupLabel = {
  Events: "events",
  TokenUsage: "token_usage",
  TokenEvents: "token_events",
  ActivitySegments: "activity_segments",
  LinkSnapshotBefore: "link_snapshot_before",
  ArtifactLinks: "artifact_links",
  PullRequests: "pull_requests",
  SegmentWorkItemRefs: "segment_work_item_refs",
  ComponentInvocations: "component_invocations",
  LinkSnapshotAfter: "link_snapshot_after",
  SyncWatermark: "sync_watermark",
  AnalyticsRollup: "analytics_rollup",
  RevisionSeal: "revision_seal",
  Unknown: "unknown",
} as const;

/** Literal union of `import.group_label` values. */
export type ImportGroupLabel =
  (typeof ImportGroupLabel)[keyof typeof ImportGroupLabel];

/** ISS-5103: discriminator values for desktop import-health events. */
export const ImportHealthEvent = {
  GroupFailed: "group_failed",
  Pass: "pass",
} as const;

/** Literal union of `import.event` values. */
export type ImportHealthEvent =
  (typeof ImportHealthEvent)[keyof typeof ImportHealthEvent];

/** Strict app attribute schema for fleet identity, lifecycle, and exception metadata. */
export const AppTelemetrySchema = z
  .object({
    [TelemetryAttribute.AppInstallationId]: boundedText(
      TelemetryTextMaxLength.AppInstallationId
    ).optional(),
    [TelemetryAttribute.AppOrganizationId]: boundedText(
      TelemetryTextMaxLength.AppOrganizationId
    ).optional(),
    [TelemetryAttribute.DeploymentEnvironmentName]: boundedText(
      TelemetryTextMaxLength.DeploymentEnvironmentName
    ).optional(),
    [TelemetryAttribute.ExceptionType]: boundedText(
      TelemetryTextMaxLength.ExceptionType
    ).optional(),
    [TelemetryAttribute.ExceptionMessage]: boundedText(
      TelemetryTextMaxLength.ExceptionMessage
    ).optional(),
    [TelemetryAttribute.ExceptionStacktrace]: boundedText(
      TelemetryTextMaxLength.ExceptionStacktrace
    ).optional(),
    [TelemetryAttribute.AppExceptionOrigin]: z
      .enum([
        AppExceptionOrigin.PreInit,
        AppExceptionOrigin.Main,
        AppExceptionOrigin.Renderer,
      ])
      .optional(),
    [TelemetryAttribute.AppOperatingMode]: z
      .enum(["single_player", "multiplayer"])
      .optional(),
    [TelemetryAttribute.AppLifecycleEvent]: z
      .enum(["start", "heartbeat", "shutdown"])
      .optional(),
    // ISS-5103 desktop import-health counters. All optional and additive: an
    // older desktop simply never sends them, and an older collector allowlist
    // shipped alongside this change keeps redaction in sync.
    [TelemetryAttribute.ImportEvent]: z.enum(ImportHealthEvent).optional(),
    [TelemetryAttribute.ImportGroupLabel]: z.enum(ImportGroupLabel).optional(),
    [TelemetryAttribute.ImportGroupFailedCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.ImportSessionsIncomplete]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.ImportSessionsPendingRevision]: z
      .number()
      .int()
      .min(0)
      .optional(),
  })
  .strict();

/** Parsed app telemetry attribute shape. */
export type AppTelemetry = z.infer<typeof AppTelemetrySchema>;
