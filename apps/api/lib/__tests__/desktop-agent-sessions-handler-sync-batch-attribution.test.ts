/**
 * ISS-7227: the client-generated `AgentSessionSyncBatch.batchId` must reach the
 * server's `request_completed` attribution, so a failed sync's desktop half and
 * cloud half are one query instead of two unrelated log lines.
 *
 * These drive the REAL handler, the REAL payload parse, and the REAL
 * AsyncStorage-backed attribution store; only the upsert and the org-policy
 * gate are doubles. The id asserted is a literal written HERE, distinct from the
 * shared fixture's, so a recorder that stamped some other id — or echoed the
 * fixture by construction — fails rather than agreeing.
 */
import type { RequestCompletedSpanAttribution } from "@repo/observability/telemetry/request-completed";
import { buildRequestCompletedContractAttributes } from "@repo/observability/telemetry/request-completed";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopAgentSessionsRateLimiter,
  handleDesktopAgentSessionsEvent,
} from "../desktop-agent-sessions-handler";
import { DesktopAgentSessionsAckReason } from "../desktop-agent-sessions-schema";
import {
  getRequestSpanAttribution,
  runWithRequestSpanAttribution,
} from "../observability/request-span-attribution";
import {
  desktopAgentSessionsHandlerContext as baseContext,
  upsertBatchMock,
  validDesktopAgentSessionsPayload as validPayload,
} from "./desktop-agent-sessions-handler-fixtures";

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

/**
 * The id the desktop minted for this attempt. Deliberately NOT the fixture's
 * value: the assertion has to prove the handler carried THIS request's id
 * across the hop, which an implementation that reported a constant, a fresh
 * `randomUUID()`, or the fixture default could not satisfy.
 */
const SENT_BATCH_ID = "3f2a91c4-7d5e-4b18-9a03-6e8c1d47b2f5";

/**
 * The emitted attribute name, written out here rather than imported from
 * `TelemetryAttribute`. This suite exists to police that name reaching the
 * line: reading it from the const it guards would keep the assertion green
 * through a rename of the const's VALUE, which is the drift that breaks every
 * saved Datadog query. The duplication is the test.
 */
const SYNC_BATCH_ID_ATTRIBUTE = "sync.batch_id";

beforeEach(() => {
  mockEmitTelemetryMetric.mockReset();
  mockLog.error.mockReset();
});

describe("handleDesktopAgentSessionsEvent sync batch attribution", () => {
  it("carries the sent batch id onto the accepted request's attribution", async () => {
    const { ack, attribution } = await handleWithAttribution({
      ...validPayload,
      batchId: SENT_BATCH_ID,
    });

    expect(ack).toEqual({ accepted: true });
    expect(attribution).toEqual({ syncBatchId: SENT_BATCH_ID });
  });

  /**
   * The case the ticket exists for. An ingestion 500 is the failure RCA cannot
   * currently join, so the id has to be recorded BEFORE the upsert rather than
   * on the success path — a recorder placed after it would leave exactly the
   * failing population unattributed while every green request looked correct.
   */
  it("carries the batch id when the ingest throws and the ack is a 500", async () => {
    const { ack, attribution } = await handleWithAttribution(
      { ...validPayload, batchId: SENT_BATCH_ID },
      {
        upsertBatch: vi.fn().mockRejectedValue(new Error("db down")),
      }
    );

    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
    expect(attribution).toEqual({ syncBatchId: SENT_BATCH_ID });
  });

  /**
   * The throttled population, which the parse never sees: the handler
   * rate-limits before it parses, and the desktop still writes a failure record
   * carrying this batch id for a `rate_limited` rejection. A recorder placed
   * after the limiter leaves exactly that population unjoinable.
   */
  it("carries the batch id when the limiter refuses the request", async () => {
    const rateLimiter = new DesktopAgentSessionsRateLimiter({
      maxRequests: 1,
    });
    // Spend the one-request window, so the attempt under test is the refusal.
    await handleWithAttribution(
      { ...validPayload, batchId: SENT_BATCH_ID },
      { now: () => 0, rateLimiter }
    );

    const { ack, attribution } = await handleWithAttribution(
      { ...validPayload, batchId: SENT_BATCH_ID },
      { now: () => 0, rateLimiter }
    );

    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    });
    expect(attribution).toEqual({ syncBatchId: SENT_BATCH_ID });
  });

  /**
   * The pre-limiter read is a VALIDATED read, not a copy: a throttled request
   * whose id is not a UUID is still attributed by omission. Without this the
   * case above is satisfied by a recorder that stamps whatever the body said.
   */
  it("records nothing when the limiter refuses a request whose batch id is not a uuid", async () => {
    const rateLimiter = new DesktopAgentSessionsRateLimiter({
      maxRequests: 1,
    });
    await handleWithAttribution(
      { ...validPayload, batchId: SENT_BATCH_ID },
      { now: () => 0, rateLimiter }
    );

    const { ack, attribution } = await handleWithAttribution(
      { ...validPayload, batchId: "batch-1" },
      { now: () => 0, rateLimiter }
    );

    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    });
    expect(attribution).toEqual({});
  });

  /**
   * A body the schema rejects for some OTHER reason still carries a readable,
   * UUID-shaped id, and the desktop records `validation_failed` against it — so
   * that rejection is joinable too. The id is the one field independently
   * validated here; nothing else about the payload is trusted.
   */
  it("carries the batch id when the payload fails validation elsewhere", async () => {
    const { ack, attribution } = await handleWithAttribution({
      ...validPayload,
      batchId: SENT_BATCH_ID,
      sessionCount: 99,
    });

    expect(ack).toMatchObject({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    expect(attribution).toEqual({ syncBatchId: SENT_BATCH_ID });
  });

  /**
   * Version skew and hostile input: a body that never names a UUID-shaped batch
   * id yields no trustworthy value, so the request stays honestly unjoinable
   * rather than carrying a fabricated or unvalidated one. Graded against the
   * positive cases above — the same drive, the same store, the opposite outcome.
   */
  it.each([
    ["a payload with no batch id at all", { batchId: undefined }],
    ["a batch id that is not a uuid", { batchId: "batch-1" }],
    ["a batch id carrying prose", { batchId: "org 1 / sync attempt" }],
  ])("records nothing for %s", async (_name, override) => {
    const { ack, attribution } = await handleWithAttribution({
      ...validPayload,
      ...override,
    });

    expect(ack).toMatchObject({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    expect(attribution).toEqual({});
  });

  /**
   * The trust boundary: a request body is JSON, and JSON is not constrained by
   * the handler's types. A non-object body must cost the attribute and nothing
   * more — a telemetry read may never be what fails an ingest.
   */
  it.each([
    ["a body that is not an object", "not-a-body"],
    ["a null body", null],
    ["an array body", [{ batchId: SENT_BATCH_ID }]],
  ])("records nothing and does not throw for %s", async (_name, body) => {
    const { ack, attribution } = await handleWithAttribution(body);

    expect(ack).toMatchObject({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    expect(attribution).toEqual({});
  });

  /**
   * The handler also serves the relay socket-event and desktop-gateway socket
   * transports, which do not open an attribution scope. Recording must be inert
   * there rather than throwing — a telemetry seam may never fail an ingest.
   */
  it("accepts the batch unchanged outside a request attribution scope", async () => {
    await expect(
      handleDesktopAgentSessionsEvent(
        { ...validPayload, batchId: SENT_BATCH_ID },
        baseContext,
        { upsertBatch: upsertBatchMock() }
      )
    ).resolves.toEqual({ accepted: true });
    expect(getRequestSpanAttribution()).toBeUndefined();
  });

  /**
   * The end of the hop: the recorded id has to survive projection onto the
   * emitted line under the canonical attribute name, not merely sit in the
   * store.
   */
  it("projects the recorded id onto the emitted sync.batch_id attribute", async () => {
    const { attribution } = await handleWithAttribution({
      ...validPayload,
      batchId: SENT_BATCH_ID,
    });

    const attributes = buildRequestCompletedContractAttributes({
      requestUrl: "https://api.example.test/desktop/agent-sessions/sync",
      method: "POST",
      statusCode: 500,
      durationMs: 12,
      attribution,
    });

    // The whole attribute set, not just the new key: it also proves the added
    // field neither displaced nor duplicated anything the line already carried.
    expect(attributes).toEqual({
      "http.request.method": "POST",
      "http.response.status_code": 500,
      "url.path": "/desktop/agent-sessions/sync",
      duration_ms: 12,
      [SYNC_BATCH_ID_ATTRIBUTE]: SENT_BATCH_ID,
      "telemetry.schema_name": "span",
    });
  });
});

async function handleWithAttribution(
  payload: unknown,
  deps: Parameters<typeof handleDesktopAgentSessionsEvent>[2] = {}
) {
  let attribution: RequestCompletedSpanAttribution | undefined;
  const ack = await runWithRequestSpanAttribution(async () => {
    const result = await handleDesktopAgentSessionsEvent(payload, baseContext, {
      upsertBatch: upsertBatchMock(),
      ...deps,
    });
    attribution = getRequestSpanAttribution();
    return result;
  });
  return { ack, attribution };
}
