import {
  InvocationSyncParentStatus,
  invocationSyncMissingParentsSchema,
} from "@repo/api/src/types/invocation-sync-diagnostics";
import { describe, expect, it } from "vitest";
import { buildDesktopTelemetryPayload } from "../telemetry/emitter";
import { TelemetryCategory } from "../telemetry/telemetry-category";

const diagnostic = {
  computeTargetId: "target-1",
  sessionSourceKey: "sessions:target-1",
  observedAt: "2026-10-05T19:41:00.000Z",
  parts: [
    {
      externalSessionId: "session-1",
      externalGenerationId: "a".repeat(64),
      partIndex: 0,
      partHash: "b".repeat(64),
      attemptCount: 2,
      permanentAttemptCount: 1,
      parent: {
        externalSessionId: "session-1",
        sessionPresent: true,
        outboxStatus: InvocationSyncParentStatus.Withheld,
      },
    },
  ],
};

describe("authenticated invocation diagnostic boundary", () => {
  it("preserves the diagnostic through wire validation and server log sanitization", () => {
    const payload = buildDesktopTelemetryPayload({
      schemaVersion: "1",
      category: TelemetryCategory.InvocationSyncMissingParents,
      severity: "warn",
      timestamp: diagnostic.observedAt,
      trace: { commandId: "", operationId: "", computeTargetId: "target-1" },
      diagnostics: { invocationSyncMissingParents: diagnostic },
    });
    expect(payload.category).toBe(
      TelemetryCategory.InvocationSyncMissingParents
    );
    expect(payload.diagnostics).toEqual({
      invocationSyncMissingParents: diagnostic,
    });
  });

  it("coarsens unknown peer queue states without losing the identifiers", () => {
    const parsed = invocationSyncMissingParentsSchema.parse({
      ...diagnostic,
      parts: [
        {
          ...diagnostic.parts[0],
          parent: {
            ...diagnostic.parts[0]?.parent,
            outboxStatus: "future_state",
          },
        },
      ],
    });
    expect(parsed.parts[0]?.parent?.outboxStatus).toBe(
      InvocationSyncParentStatus.Unknown
    );
    expect(parsed.parts[0]?.externalSessionId).toBe("session-1");
  });

  it.each([
    "/private/home/user/session.json",
    "person@example.com",
    `sk_live_${"x".repeat(40)}`,
    "a".repeat(201),
  ])("redacts unsafe diagnostic identifiers: %s", (id) => {
    const parsed = invocationSyncMissingParentsSchema.parse({
      ...diagnostic,
      parts: [{ ...diagnostic.parts[0], externalSessionId: id }],
    });
    expect(parsed.parts[0]?.externalSessionId).toBe("[redacted]");
  });

  // Both ladders, not just the first: the two counters carry the same bound, and
  // a one-key fixture cannot tell a per-field validator from a global one.
  it.each(
    IMPOSSIBLE_COUNTS.flatMap((count) =>
      ATTEMPT_COUNT_FIELDS.map((field) => [field, count] as const)
    )
  )("rejects an impossible %s: %s", (field, count) => {
    expect(
      invocationSyncMissingParentsSchema.safeParse({
        ...diagnostic,
        parts: [{ ...diagnostic.parts[0], [field]: count }],
      }).success
    ).toBe(false);
  });

  it("carries an unreadable parent retry deadline as a flag, not a value", () => {
    const parsed = invocationSyncMissingParentsSchema.parse({
      ...diagnostic,
      parts: [
        {
          ...diagnostic.parts[0],
          parent: {
            ...diagnostic.parts[0]?.parent,
            nextAttemptAtInvalid: true,
          },
        },
      ],
    });
    expect(parsed.parts[0]?.parent).toMatchObject({
      nextAttemptAtInvalid: true,
    });
    expect(parsed.parts[0]?.parent).not.toHaveProperty("nextAttemptAt");
  });

  it("bounds parts and strips payload content", () => {
    expect(
      invocationSyncMissingParentsSchema.safeParse({
        ...diagnostic,
        parts: Array.from({ length: 11 }, () => diagnostic.parts[0]),
      }).success
    ).toBe(false);
    const parsed = invocationSyncMissingParentsSchema.parse({
      ...diagnostic,
      parts: [{ ...diagnostic.parts[0], items: [{ prompt: "private" }] }],
    });
    expect(parsed.parts[0]).not.toHaveProperty("items");
  });
});

/** The two durable attempt ladders a part carries, which share one bound. */
const ATTEMPT_COUNT_FIELDS = ["attemptCount", "permanentAttemptCount"] as const;
/** Values no attempt ladder can hold. */
const IMPOSSIBLE_COUNTS = [
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
];
