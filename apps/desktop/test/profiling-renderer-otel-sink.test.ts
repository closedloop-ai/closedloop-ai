import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRendererOtelExportHandler } from "../src/main/ipc/renderer-otel-ipc.js";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import type { ProfilingRenderCommitRow } from "../src/shared/profiling.js";
import {
  buildRenderCommitBridgeRecord,
  RENDERER_RENDER_COMMIT_EVENT_NAME_BASE,
  RendererRenderCause,
  RendererRenderPhase,
  RendererRenderView,
} from "../src/shared/render-commit-event.js";
import {
  DesktopOtelSignal,
  RendererOtelAllowedAttributeKey,
  type RendererOtelBridgeRecord,
} from "../src/shared/renderer-otel-bridge-constants.js";

function createRuntimeSpy(): {
  runtime: DesktopOtelRuntime;
  calls: RendererOtelBridgeRecord[][];
} {
  const calls: RendererOtelBridgeRecord[][] = [];
  const runtime = {
    exportExternalRecords(records: RendererOtelBridgeRecord[]) {
      calls.push(records);
      return {
        ok: true as const,
        acceptedRecords: records.length,
        droppedRecordsCount: 0,
      };
    },
  } as unknown as DesktopOtelRuntime;
  return { runtime, calls };
}

/**
 * Build the handler with the sanitizer bypassed. The bridge sanitizer has its
 * own coverage; what matters here is that the records the REAL producer
 * (`buildRenderCommitBridgeRecord`) emits decode correctly on the main side.
 */
function createHandler(options: {
  records: RendererOtelBridgeRecord[];
  profilingSink?: { append(row: ProfilingRenderCommitRow): void };
}) {
  const { runtime, calls } = createRuntimeSpy();
  const handler = createRendererOtelExportHandler({
    isTrustedSender: () => true,
    runtime,
    parsePayload: () => ({
      ok: true,
      payload: { records: options.records },
    }),
    profilingSink: options.profilingSink,
    profilingClock: { nowMs: () => 0, nowEpochMs: () => 1_700_000_000_000 },
  });
  return { handler, calls };
}

function createRecordingSink(): {
  rows: ProfilingRenderCommitRow[];
  append(row: ProfilingRenderCommitRow): void;
} {
  const rows: ProfilingRenderCommitRow[] = [];
  return { rows, append: (row) => rows.push(row) };
}

describe("renderer otel render-commit profiling sink", () => {
  test("decodes prefix-named commits onto flat rows", () => {
    const sink = createRecordingSink();
    const { handler } = createHandler({
      profilingSink: sink,
      records: [
        buildRenderCommitBridgeRecord({
          view: RendererRenderView.SessionsList,
          phase: RendererRenderPhase.Update,
          cause: RendererRenderCause.Paginate,
          itemCount: 50,
          actualMs: 42.7,
          baseMs: 30.1,
        }),
        buildRenderCommitBridgeRecord({
          view: RendererRenderView.SessionsDetail,
          phase: RendererRenderPhase.Mount,
          cause: RendererRenderCause.Mount,
          itemCount: 1,
          actualMs: 8.2,
          baseMs: 8.2,
        }),
      ],
    });

    handler({ sender: {} }, {});

    assert.deepEqual(sink.rows, [
      {
        view: RendererRenderView.SessionsList,
        phase: RendererRenderPhase.Update,
        cause: RendererRenderCause.Paginate,
        actualMs: 42.7,
        ts: 1_700_000_000_000,
      },
      {
        view: RendererRenderView.SessionsDetail,
        phase: RendererRenderPhase.Mount,
        cause: RendererRenderCause.Mount,
        actualMs: 8.2,
        ts: 1_700_000_000_000,
      },
    ]);
  });

  test("ignores records that are not render commits", () => {
    const sink = createRecordingSink();
    const { handler, calls } = createHandler({
      profilingSink: sink,
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: "desktop.renderer.some_other_event",
          attributes: {
            [RendererOtelAllowedAttributeKey.Values]: [99],
          },
        },
        {
          // The bare base name is never emitted (the view suffix is always
          // appended); it must not be mistaken for a commit either.
          signal: DesktopOtelSignal.Log,
          name: RENDERER_RENDER_COMMIT_EVENT_NAME_BASE,
          attributes: {
            [RendererOtelAllowedAttributeKey.Values]: [99],
          },
        },
        { signal: DesktopOtelSignal.Log, name: undefined },
      ],
    });

    handler({ sender: {} }, {});

    assert.deepEqual(sink.rows, []);
    assert.equal(calls.length, 1, "unrelated records still export normally");
  });

  test("skips a commit whose duration did not decode instead of writing a zero", () => {
    const sink = createRecordingSink();
    const { handler } = createHandler({
      profilingSink: sink,
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: `${RENDERER_RENDER_COMMIT_EVENT_NAME_BASE}.${RendererRenderView.SessionsList}`,
          attributes: {
            [RendererOtelAllowedAttributeKey.Mode]: RendererRenderCause.Sort,
          },
        },
      ],
    });

    handler({ sender: {} }, {});

    assert.deepEqual(
      sink.rows,
      [],
      "a missing measurement must not become a 0 ms commit in the report"
    );
  });

  test("a throwing sink never skips the OTel export", () => {
    const { handler, calls } = createHandler({
      profilingSink: {
        append() {
          throw new Error("sink is on fire");
        },
      },
      records: [
        buildRenderCommitBridgeRecord({
          view: RendererRenderView.SessionsList,
          phase: RendererRenderPhase.Update,
          cause: RendererRenderCause.Filter,
          itemCount: 10,
          actualMs: 5,
          baseMs: 4,
        }),
      ],
    });

    const result = handler({ sender: {} }, {});

    assert.equal(calls.length, 1, "exportExternalRecords must still be called");
    assert.equal(result.ok, true);
  });

  test("with no sink the export path is unchanged", () => {
    const { handler, calls } = createHandler({
      records: [
        buildRenderCommitBridgeRecord({
          view: RendererRenderView.SessionsList,
          phase: RendererRenderPhase.Mount,
          cause: RendererRenderCause.Mount,
          itemCount: 1,
          actualMs: 1,
          baseMs: 1,
        }),
      ],
    });

    const result = handler({ sender: {} }, {});

    assert.equal(calls.length, 1);
    assert.equal(result.ok, true);
  });
});
