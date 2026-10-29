import {
  DesktopAgentSessionsAckReason,
  SYNC_ACK_DETAIL_MAX_CHARS,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it, vi } from "vitest";
import {
  desktopAgentSessionsHandlerContext as baseContext,
  upsertBatchMock,
  validationFailedAck,
  validDesktopAgentSessionsPayload as validPayload,
} from "@/lib/__tests__/desktop-agent-sessions-handler-fixtures";
import { handleDesktopAgentSessionsEvent } from "../desktop-agent-sessions-handler";
import { summarizeParseIssues } from "../desktop-agent-sessions-parse-guards";

const { mockEmitTelemetryMetric, mockLog } = vi.hoisted(() => ({
  mockEmitTelemetryMetric: vi.fn(),
  mockLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: mockLog,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

describe("summarizeParseIssues", () => {
  it.each([
    {
      name: "an empty issue list",
      issues: [],
      expected: "payload_invalid",
    },
    {
      name: "an unrecognized root",
      issues: [{ path: ["unexpected"], message: "Invalid input" }],
      expected: "payload_invalid",
    },
    {
      name: "schemaVersion",
      issues: [{ path: ["schemaVersion"], message: "Invalid input" }],
      expected: "schema_version_invalid",
    },
    {
      name: "batchId",
      issues: [{ path: ["batchId"], message: "Invalid UUID" }],
      expected: "batch_id_invalid",
    },
    {
      name: "syncMode",
      issues: [{ path: ["syncMode"], message: "Invalid option" }],
      expected: "sync_mode_invalid",
    },
    {
      name: "a mismatched sessionCount",
      issues: [{ path: ["sessionCount"], message: "session_count_mismatch" }],
      expected: "session_count_mismatch",
    },
    {
      name: "an otherwise invalid sessionCount",
      issues: [{ path: ["sessionCount"], message: "Invalid input" }],
      expected: "session_count_invalid",
    },
    {
      name: "the sessions root",
      issues: [{ path: ["sessions"], message: "Invalid input" }],
      expected: "sessions_invalid",
    },
    {
      name: "a nested session",
      issues: [{ path: ["sessions", 0], message: "Invalid input" }],
      expected: "session_invalid:sessions[0]",
    },
    {
      name: "an oversized session trace source payload",
      issues: [
        {
          path: ["sessions", 0],
          message: "session_trace_source_payload_too_large",
        },
      ],
      expected: "session_trace_source_payload_too_large",
    },
  ])("maps $name to $expected", ({ issues, expected }) => {
    expect(summarizeParseIssues(issues)).toBe(expected);
  });

  /**
   * ISS-8005. The rendered path is capped so the whole reason fits the
   * desktop's 120-char log budget. A dropped tail must SAY it was dropped:
   * a bare prefix would name a field that is not the one that failed, which is
   * the defect this diagnostic exists to end.
   */
  it("marks a path it had to cut instead of naming the wrong field", () => {
    const fortyChars = "a".repeat(40);

    expect(
      summarizeParseIssues([
        {
          path: ["sessions", 0, fortyChars, fortyChars, fortyChars],
          message: "Invalid input",
        },
      ])
    ).toBe(`session_invalid:sessions[0].${fortyChars}.${fortyChars}...`);
  });

  /**
   * ISS-8005. SINGLE-CHARACTER segments on purpose: they grow the rendered path
   * two chars at a time, so it can stop within one character of the cap. Long
   * segments would overshoot in one jump and stop far below it, which passes
   * against a budget that is far too large — the mutation this must catch.
   */
  it("keeps the whole reason inside the shared ack-detail budget", () => {
    const deepPath = Array.from({ length: 80 }, () => "a");
    const reason = summarizeParseIssues([
      { path: ["sessions", 0, ...deepPath], message: "" },
    ]);

    expect(reason.length).toBeLessThanOrEqual(SYNC_ACK_DETAIL_MAX_CHARS);
  });
});

describe("handleDesktopAgentSessionsEvent parse details", () => {
  it("surfaces a batchId-shaped failure on the rejected ack", async () => {
    const upsertBatch = upsertBatchMock();

    await expect(
      handleDesktopAgentSessionsEvent(
        { ...validPayload, batchId: "not-a-uuid" },
        baseContext,
        {
          upsertBatch,
        }
      )
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
      detail: "batch_id_invalid",
    });
    expect(upsertBatch).not.toHaveBeenCalled();
  });

  /**
   * ISS-8005. Every case below drives the real route parse, so the asserted
   * strings are rendered from paths Zod actually produced rather than from
   * hand-written `path` arrays that could agree with a broken renderer.
   *
   * The expectations are literal, NOT re-derived from the mapper under test: a
   * renamed reason or a re-spelled separator has to fail here.
   */
  async function detailForSession(session: Record<string, unknown>) {
    return await handleDesktopAgentSessionsEvent(
      {
        ...validPayload,
        sessions: [{ ...validPayload.sessions[0], ...session }],
      },
      baseContext,
      {
        upsertBatch: upsertBatchMock(),
      }
    );
  }

  it("names the invalid field, and names a DIFFERENT one differently", async () => {
    const badEventDate = await detailForSession({
      events: [
        {
          externalEventId: "evt-1",
          agentExternalId: null,
          eventType: "tool_use",
          toolName: null,
          createdAt: "not-a-date",
        },
      ],
    });
    const badAgentName = await detailForSession({
      agents: [
        {
          externalAgentId: "agent-1",
          name: "",
          type: "main",
          status: "active",
        },
      ],
    });

    expect(badEventDate).toEqual(
      validationFailedAck("session_invalid:sessions[0].events[0].createdAt")
    );
    expect(badAgentName).toEqual(
      validationFailedAck("session_invalid:sessions[0].agents[0].name")
    );
  });

  it("masks a payload-supplied key, keeping the field that carries it", async () => {
    const result = await detailForSession({
      // `phaseIterations` is a `z.record`, so this key is customer content, not
      // a schema field name. `0` fails `.positive()`; the key is deliberately a
      // valid camelCase identifier, so only the payload-keyed rule can mask it.
      phaseIterations: { customerPhaseLabel: 0 },
    });

    expect(result).toEqual(
      validationFailedAck("session_invalid:sessions[0].phaseIterations.*")
    );
    expect(JSON.stringify(result)).not.toContain("customerPhaseLabel");
  });

  it("stops at a payload-supplied key nested under an array element", async () => {
    const result = await detailForSession({
      activityBuckets: [
        {
          label: "bucket",
          cIn: 0,
          cOut: 0,
          cCache: 0,
          total: 0,
          toolStart: 0,
          tl0: null,
          byModel: { customerModelName: { cIn: -1, cOut: 0, cCache: 0 } },
        },
      ],
    });

    expect(result).toEqual(
      validationFailedAck(
        "session_invalid:sessions[0].activityBuckets[0].byModel.*"
      )
    );
    expect(JSON.stringify(result)).not.toContain("customerModelName");
  });

  it("still accepts a valid session", async () => {
    const upsertBatch = upsertBatchMock(["sess-1"]);

    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        upsertBatch,
      })
    ).resolves.toMatchObject({ accepted: true });
    expect(upsertBatch).toHaveBeenCalledTimes(1);
  });
});
