/**
 * @file renderer-otel-bridge-test-fixtures.ts
 * @description Shared record-variant narrowing for the renderer OTel bridge
 * suites. `RendererOtelBridgeRecord` is a union, so both
 * `renderer-otel-bridge.test.ts` and `renderer-otel-bridge-edges.test.ts` need
 * the same way to prove which member came back before asserting on it. This is
 * a plain module, not a `*.test.ts`, so the flat `test/` discovery in
 * `scripts/run-node-tests.mjs` does not pick it up as a suite.
 */

import {
  DesktopOtelSignal,
  type RendererOtelBridgeRecord,
  type RendererOtelExceptionBridgeRecord,
  type RendererOtelGenericBridgeRecord,
} from "../src/shared/renderer-otel-bridge-constants.js";

/**
 * Mirrors the parser's own exception classification
 * (`isExceptionRecord` in renderer-otel-bridge.ts) so the two union members can
 * be told apart in assertions.
 */
export function isExceptionBridgeRecord(
  record: RendererOtelBridgeRecord
): record is RendererOtelExceptionBridgeRecord {
  return (
    (record.signal === DesktopOtelSignal.Log ||
      record.signal === DesktopOtelSignal.Trace) &&
    record.name === "exception"
  );
}

/** The parsed record at `index`, proven present and of the exception variant. */
export function expectExceptionRecord(
  records: RendererOtelBridgeRecord[],
  index: number
): RendererOtelExceptionBridgeRecord {
  const record = records[index];
  if (!(record && isExceptionBridgeRecord(record))) {
    throw new Error(`expected an exception bridge record at index ${index}`);
  }
  return record;
}

/** The parsed record at `index`, proven present and of the generic variant. */
export function expectGenericRecord(
  records: RendererOtelBridgeRecord[],
  index: number
): RendererOtelGenericBridgeRecord {
  const record = records[index];
  if (!record || isExceptionBridgeRecord(record)) {
    throw new Error(`expected a generic bridge record at index ${index}`);
  }
  return record;
}
