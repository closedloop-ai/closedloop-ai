/**
 * ISS-11347 — which parsed LLM requests become GenAI spans, when, and how often.
 *
 * A live import re-parses the whole transcript on every change, so the bridge
 * sees the same request over and over as a FRESH object, and a Claude request's
 * usage can still be growing when it is first seen. These pin that each request
 * is emitted exactly once with its final usage, that history and corrupt stamps
 * are never sent, that only per-request harnesses are read, and that neither
 * memory bound turns into a re-emit.
 */
import assert from "node:assert/strict";
import {
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { CODEX_AUTO_REVIEW_LABEL } from "@repo/lib/harness/codex/codex-session-meta";
import { afterEach, describe, test, vi } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import type { DesktopGenAiRequestEventInput } from "../src/main/telemetry/app-otel-runtime-gen-ai.js";
import { createGenAiRequestTelemetry } from "../src/main/telemetry/gen-ai-request-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { CollectorRecordsDroppedReason } from "../src/main/telemetry/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { codexBurstWindowMs } from "../src/shared/codex-burst-window.js";
import {
  BOUND_AT_MS,
  boundTelemetry,
  PRICED_MODEL,
  record,
  reparsed,
  STARTED_AT,
  stampedAt,
} from "./support/gen-ai-request-telemetry-fixtures.js";

const UNPRICED_MODEL = "acme-unreleased-model-9";
const CLAUDE_ENTRY_SCHEME = "claude.transcript.entry.uuid";
/** Past the bridge's settle window and its sweep period together. */
const SETTLED_AFTER_MS = 150_000;

afterEach(() => {
  vi.useRealTimers();
  Observability.reset();
});

describe("GenAI request telemetry", () => {
  test("a request re-offered by every re-parse is emitted once", () => {
    const { emitted, telemetry } = boundTelemetry();
    const first = record(1);
    const second = record(2);
    const subagent = record(3, { subagentId: "agent-1" });
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [first],
      },
      Harness.Codex
    );
    // A later parse can place a record ahead of ones already seen, shifting
    // every index behind it; the key must not be the index.
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: reparsed([subagent, first, second]),
      },
      Harness.Codex
    );
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: reparsed([subagent, first, second]),
      },
      Harness.Codex
    );

    assert.deepEqual(stampedAt(emitted), [1000, 3000, 2000]);
  });

  test("two round-trips sharing a carried stamp and model are two requests, each once", () => {
    const { emitted, telemetry } = boundTelemetry();
    // Codex carries the last stamp onto a `token_count` that has none, so two
    // round-trips can share one; each is still its own record, and the second
    // may only be written after a parse has already sent the first.
    const series = [record(1, { output: 5 }), record(1, { output: 7 })];
    for (const tokenSeries of [series.slice(0, 1), series, series]) {
      telemetry.observeLiveSession(
        {
          sessionId: "s1",
          model: null,
          startedAt: STARTED_AT,
          tokenSeries: reparsed(tokenSeries),
        },
        Harness.Codex
      );
    }

    assert.deepEqual(
      emitted.map((input) => input.outputTokens),
      [5, 7]
    );
  });

  test("identical usage at two different times is two requests", () => {
    const { emitted, telemetry } = boundTelemetry();
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1), record(2)],
      },
      Harness.Codex
    );

    assert.equal(emitted.length, 2);
  });

  test("the same usage in two sessions is two requests", () => {
    const { emitted, telemetry } = boundTelemetry();
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1)],
      },
      Harness.Codex
    );
    telemetry.observeLiveSession(
      {
        sessionId: "s2",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1)],
      },
      Harness.Codex
    );

    assert.equal(emitted.length, 2);
  });

  test("a Claude request ships once a later one closes it, with its final usage", () => {
    const { emitted, telemetry } = boundTelemetry();
    const identity = {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: CLAUDE_ENTRY_SCHEME,
      sourceRecordIds: ["0f8b5e8e-6a8d-4f2a-9a4e-2c1f0b7d9e11"],
    };
    // Claude writes a line per content block, so the first parse of a request
    // can carry a partial output count that later lines grow.
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1, { output: 1, sourceIdentity: identity })],
      },
      Harness.Claude
    );
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1, { output: 152, sourceIdentity: identity })],
      },
      Harness.Claude
    );
    assert.equal(emitted.length, 0, "a request nothing closed was shipped");

    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [
          record(1, { output: 152, sourceIdentity: identity }),
          record(9),
        ],
      },
      Harness.Claude
    );

    assert.deepEqual(
      emitted.map((input) => input.outputTokens),
      [152]
    );
  });

  test("without a proven source id, a growing Claude request still ships once", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { clock, emitted, telemetry } = boundTelemetry();
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1, { output: 1 })],
      },
      Harness.Claude
    );
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1, { output: 152 }), record(9)],
      },
      Harness.Claude
    );
    // Let everything still held settle, so a stale partial copy would ship too.
    clock.nowMs += SETTLED_AFTER_MS;
    vi.advanceTimersByTime(SETTLED_AFTER_MS);

    assert.deepEqual(
      emitted.map((input) => input.outputTokens),
      [152, 20]
    );
  });

  test("a Claude request whose source id degrades mid-stream still ships once, with its final usage", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { clock, emitted, telemetry } = boundTelemetry();
    // A later line of the same message with no usable UUID makes the parser
    // report the record's provenance as unavailable from then on.
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [
          record(1, {
            output: 1,
            sourceIdentity: {
              availability: TokenSourceIdentityAvailability.Available,
              scheme: CLAUDE_ENTRY_SCHEME,
              sourceRecordIds: ["0f8b5e8e-6a8d-4f2a-9a4e-2c1f0b7d9e11"],
            },
          }),
        ],
      },
      Harness.Claude
    );
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [
          record(1, {
            output: 152,
            sourceIdentity: {
              availability: TokenSourceIdentityAvailability.Unavailable,
              reason:
                TokenSourceIdentityUnavailableReason.MissingSourceRecordId,
            },
          }),
          record(9),
        ],
      },
      Harness.Claude
    );
    // Let everything still held settle, so a stale partial copy would ship too.
    clock.nowMs += SETTLED_AFTER_MS;
    vi.advanceTimersByTime(SETTLED_AFTER_MS);

    assert.deepEqual(
      emitted.map((input) => input.outputTokens),
      [152, 20]
    );
  });

  test("a subagent's request does not close the parent's", () => {
    const { emitted, telemetry } = boundTelemetry();
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1), record(2, { subagentId: "agent-1" })],
      },
      Harness.Claude
    );
    assert.equal(emitted.length, 0);

    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [
          record(1),
          record(2, { subagentId: "agent-1" }),
          record(3, { subagentId: "agent-1" }),
        ],
      },
      Harness.Claude
    );

    assert.deepEqual(stampedAt(emitted), [2000]);
  });

  test("a Claude request nothing closes ships once its usage has settled", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { clock, emitted, telemetry } = boundTelemetry();
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1)],
      },
      Harness.Claude
    );
    clock.nowMs += SETTLED_AFTER_MS / 2;
    vi.advanceTimersByTime(SETTLED_AFTER_MS / 2);
    assert.equal(emitted.length, 0, "shipped before its usage settled");

    clock.nowMs += SETTLED_AFTER_MS / 2;
    vi.advanceTimersByTime(SETTLED_AFTER_MS / 2);

    assert.deepEqual(stampedAt(emitted), [1000]);
  });

  test("held requests past capacity ship oldest first rather than pile up", () => {
    const { emitted, telemetry } = boundTelemetry({ heldCapacity: 2 });
    for (const [offset, sessionId] of ["s1", "s2", "s3"].entries()) {
      telemetry.observeLiveSession(
        {
          sessionId,
          model: null,
          startedAt: STARTED_AT,
          tokenSeries: [record(offset + 1)],
        },
        Harness.Claude
      );
    }

    // s1's request was held first, so it is the one that ships.
    assert.deepEqual(stampedAt(emitted), [1000]);
  });

  test("history, unknown models, and unreadable or future stamps are never sent", () => {
    const { emitted, telemetry } = boundTelemetry();
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [
          record(-1),
          record(1, { inferred: true }),
          record(2, { model: CODEX_AUTO_REVIEW_LABEL }),
          record(3, { timestamp: "not a timestamp" }),
          record(61),
          record(0),
          record(60),
        ],
      },
      Harness.Codex
    );

    // Only the requests stamped AT the bind and at the skew bound qualify.
    assert.deepEqual(stampedAt(emitted), [0, 60_000]);
  });

  test("a harness whose series is not per request emits nothing", () => {
    const { emitted, telemetry } = boundTelemetry();
    for (const harness of [Harness.Cursor, Harness.Copilot, Harness.OpenCode]) {
      telemetry.observeLiveSession(
        {
          sessionId: harness,
          model: null,
          startedAt: STARTED_AT,
          tokenSeries: [record(1)],
        },
        harness
      );
    }
    // Positive control: the same series on a per-request harness does emit.
    telemetry.observeLiveSession(
      {
        sessionId: "codex",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1)],
      },
      Harness.Codex
    );

    assert.equal(emitted.length, 1);
  });

  test("nothing is emitted before a runtime is bound or after it is unbound", () => {
    const emitted: DesktopGenAiRequestEventInput[] = [];
    const telemetry = createGenAiRequestTelemetry({ now: () => BOUND_AT_MS });
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1)],
      },
      Harness.Codex
    );
    telemetry.bindRuntime({
      emitGenAiRequestEvent: (input) => {
        emitted.push(input);
      },
    });
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(2)],
      },
      Harness.Codex
    );
    telemetry.bindRuntime(null);
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(3)],
      },
      Harness.Codex
    );

    assert.deepEqual(stampedAt(emitted), [2000]);
  });

  test("the cap forgets the oldest stamp, so an older request a later parse adds still ships", () => {
    const { emitted, telemetry } = boundTelemetry({ capacity: 2 });
    // A folded root appends its child's requests after its own, so the order
    // the bridge first sees requests in is not their time order.
    const parent = [record(5), record(6)];
    const child = [
      record(2, { subagentId: "agent-1" }),
      record(3, { subagentId: "agent-1" }),
    ];
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [parent[0], child[0]],
      },
      Harness.Codex
    );
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: reparsed([...parent, child[0]]),
      },
      Harness.Codex
    );
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: reparsed([...parent, ...child]),
      },
      Harness.Codex
    );

    assert.deepEqual(stampedAt(emitted), [5000, 2000, 6000, 3000]);
  });

  test("a Codex request inside the rollout's leading window waits for it to close", () => {
    const { clock, emitted, telemetry } = boundTelemetry();
    const startedAt = new Date(BOUND_AT_MS).toISOString();
    const windowMs = codexBurstWindowMs();
    // A resume replays the original rollout, freshly stamped, in a burst the
    // parser strips only once it can see all of it.
    const replayed = [record(0.1), record(0.2), record(0.3)];
    const genuine = record(1.7);
    telemetry.observeLiveSession(
      { sessionId: "resumed", model: null, startedAt, tokenSeries: replayed },
      Harness.Codex
    );
    telemetry.observeLiveSession(
      { sessionId: "fresh", model: null, startedAt, tokenSeries: [genuine] },
      Harness.Codex
    );
    assert.equal(emitted.length, 0, "shipped while the window was open");

    clock.nowMs += windowMs;
    const later = record(windowMs / 1000 + 4);
    // Once the window closes the parser has stripped the replay...
    telemetry.observeLiveSession(
      { sessionId: "resumed", model: null, startedAt, tokenSeries: [later] },
      Harness.Codex
    );
    // ...and a genuine early request is still offered, so it ships once.
    telemetry.observeLiveSession(
      {
        sessionId: "fresh",
        model: null,
        startedAt,
        tokenSeries: reparsed([genuine]),
      },
      Harness.Codex
    );
    telemetry.observeLiveSession(
      {
        sessionId: "fresh",
        model: null,
        startedAt,
        tokenSeries: reparsed([genuine]),
      },
      Harness.Codex
    );

    assert.deepEqual(stampedAt(emitted), [windowMs + 4000, 1700]);
  });

  test("requests the contract refuses are counted once per pass, not sent", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });
    const { emitted, telemetry } = boundTelemetry();
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [
          record(1, { model: "not a model id" }),
          record(2, { model: "/Users/someone/weights.gguf" }),
          record(3),
        ],
      },
      Harness.Codex
    );
    // A pass that refuses nothing reports nothing.
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(4)],
      },
      Harness.Codex
    );

    assert.deepEqual(stampedAt(emitted), [3000, 4000]);
    assert.deepEqual(
      telemetryEvents.map(
        (event) => event.diagnostics?.collectorRecordsDropped
      ),
      [{ reason: CollectorRecordsDroppedReason.GenAiRequestRefused, count: 2 }]
    );
  });

  test("a subscription session sends its model and tokens, but no cost", () => {
    const { emitted, telemetry } = boundTelemetry({
      billingMode: "codex_subscription",
    });
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1)],
      },
      Harness.Codex
    );

    const [request] = emitted;
    assert.equal(request?.model, PRICED_MODEL);
    assert.equal(request?.outputTokens, 20);
    assert.equal("costUsd" in (request ?? {}), false);
  });

  test("a session whose billing mode is undetermined keeps its cost, as the headline ledger does", () => {
    const { emitted, telemetry } = boundTelemetry({ billingMode: "unknown" });
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1)],
      },
      Harness.Codex
    );

    assert.ok(
      (emitted[0]?.costUsd ?? 0) > 0,
      "an undetermined session lost its cost"
    );
  });

  test("a key forgotten at capacity is never emitted again", () => {
    const { emitted, telemetry } = boundTelemetry({ capacity: 2 });
    const series = [record(1), record(2), record(3)];
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: series,
      },
      Harness.Codex
    );
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: reparsed(series),
      },
      Harness.Codex
    );

    assert.equal(emitted.length, 3);
  });

  test("an API-billed session's priced request carries its cost, an unpriced model carries none", () => {
    const { emitted, telemetry } = boundTelemetry();
    telemetry.observeLiveSession(
      {
        sessionId: "s1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(1), record(2, { model: UNPRICED_MODEL })],
      },
      Harness.Codex
    );

    const [priced, unpriced] = emitted;
    assert.ok(
      priced?.costUsd !== undefined && priced.costUsd > 0,
      `expected a positive cost for ${PRICED_MODEL}, got ${priced?.costUsd}`
    );
    assert.equal(unpriced?.model, UNPRICED_MODEL);
    assert.equal("costUsd" in (unpriced ?? {}), false);
  });
});
