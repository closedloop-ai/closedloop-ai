import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRenderCommitBridgeRecord,
  clampCount,
  RendererRenderCause,
  RendererRenderPhase,
  RendererRenderView,
  renderCommitEventName,
  round1,
} from "../src/shared/render-commit-event.js";
import { parseRendererOtelBridgePayload } from "../src/shared/renderer-otel-bridge.js";
import {
  DesktopOtelSignal,
  RendererOtelAllowedAttributeKey,
} from "../src/shared/renderer-otel-bridge-constants.js";

test("round1 rounds to 0.1ms and coerces non-positive/non-finite to 0", () => {
  assert.equal(round1(12.34), 12.3);
  assert.equal(round1(12.35), 12.4);
  assert.equal(round1(0), 0);
  assert.equal(round1(-5), 0);
  assert.equal(round1(Number.NaN), 0);
  assert.equal(round1(Number.POSITIVE_INFINITY), 0);
});

test("clampCount truncates to a non-negative integer; non-finite/negative → 0", () => {
  assert.equal(clampCount(25), 25);
  assert.equal(clampCount(25.9), 25);
  assert.equal(clampCount(0), 0);
  assert.equal(clampCount(-3), 0);
  assert.equal(clampCount(Number.NaN), 0);
  assert.equal(clampCount(Number.POSITIVE_INFINITY), 0);
});

test("buildRenderCommitBridgeRecord maps fields onto the four-key envelope", () => {
  const record = buildRenderCommitBridgeRecord({
    view: RendererRenderView.SessionsList,
    phase: RendererRenderPhase.Update,
    cause: RendererRenderCause.Paginate,
    itemCount: 25,
    actualMs: 8.27,
    baseMs: 14.55,
  });

  assert.equal(record.signal, DesktopOtelSignal.Log);
  assert.equal(record.name, "desktop.renderer.render_commit.sessions_list");
  assert.deepEqual(record.attributes, {
    [RendererOtelAllowedAttributeKey.Values]: [8.3, 14.6],
    [RendererOtelAllowedAttributeKey.Count]: 25,
    [RendererOtelAllowedAttributeKey.Mode]: "paginate",
    [RendererOtelAllowedAttributeKey.Status]: "update",
  });
});

test("renderCommitEventName carries the view as a stable name suffix", () => {
  assert.equal(
    renderCommitEventName(RendererRenderView.SessionsList),
    "desktop.renderer.render_commit.sessions_list"
  );
  assert.equal(
    renderCommitEventName(RendererRenderView.SessionsDetail),
    "desktop.renderer.render_commit.sessions_detail"
  );
});

// The renderer→main bridge null-drops the whole batch if any attribute key is
// outside the generic allow-list. This proves the built record survives the
// real sanitizer unchanged — the load-bearing guarantee of FEA-1998.
test("a built render-commit record round-trips through the real sanitizer intact", () => {
  const record = buildRenderCommitBridgeRecord({
    view: RendererRenderView.SessionsList,
    phase: RendererRenderPhase.Update,
    cause: RendererRenderCause.Filter,
    itemCount: 25,
    actualMs: 9.99,
    baseMs: 11.1,
  });

  const parsed = parseRendererOtelBridgePayload({ records: [record] });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.payload.records.length, 1);
  assert.deepEqual(parsed.payload.records[0], record);
});

test("every cause renders a sanitizer-safe record (no null-drop for any cause)", () => {
  for (const cause of Object.values(RendererRenderCause)) {
    const record = buildRenderCommitBridgeRecord({
      view: RendererRenderView.SessionsList,
      phase: RendererRenderPhase.Update,
      cause,
      itemCount: 10,
      actualMs: 1.2,
      baseMs: 1.2,
    });
    const parsed = parseRendererOtelBridgePayload({ records: [record] });
    assert.equal(parsed.ok, true, `cause ${cause} must survive the sanitizer`);
  }
});
