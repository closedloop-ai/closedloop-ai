import type { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTracing, resetTracingForTest } from "../provider";
import { stubEnabledTracingEnv } from "./tracing-env";

// ---------------------------------------------------------------------------
// tracing/provider.ts — pg instrumentation shape (ISS-8278).
//
// The provider hands the SDK exactly one PgInstrumentation, and the two ways
// its ingest cost can regress pull in opposite directions: leaving connect
// spans on re-adds ~28% of prod span volume, and silencing pg wholesale to buy
// that back destroys the per-request query count ISS-8919 is measured on. Both
// are pinned here, so neither can be traded for the other by accident.
//
// "Measured on" means the query SPANS, not `trace.postgresql.query.hits` —
// that metric counts connect spans too, so it shifted at the cutover while the
// count this pins stayed intact. `docs/runbooks/prod-db-load-measurement.md`
// owns that distinction and the figures; do not restate them here.
//
// The capture below keeps only PgInstrumentation entries, so this pins the pg
// registration and says nothing about what else the provider registers —
// adding an unrelated instrumentation is free and should not redden this file.
// ---------------------------------------------------------------------------

type RegisterConfig = Parameters<typeof registerInstrumentations>[0];

const registered: PgInstrumentation[] = [];

vi.mock("@opentelemetry/instrumentation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@opentelemetry/instrumentation")>();
  return {
    ...actual,
    registerInstrumentations: (config: RegisterConfig) => {
      for (const entry of config.instrumentations ?? []) {
        for (const instrumentation of [entry].flat()) {
          if (instrumentation instanceof PgInstrumentation) {
            registered.push(instrumentation);
          }
        }
      }
      return actual.registerInstrumentations(config);
    },
  };
});

// Module-level, so a case that read a sibling's registration would pass in file
// order and fail run alone.
beforeEach(() => {
  registered.length = 0;
});

afterEach(async () => {
  await resetTracingForTest();
  vi.unstubAllEnvs();
});

describe("pg instrumentation", () => {
  it("suppresses pool-connect spans while leaving query spans instrumented", () => {
    stubEnabledTracingEnv();

    expect(initTracing().enabled).toBe(true);

    const [pg, ...extra] = registered;
    // The positive half: pg is still instrumented, and still enabled. Cutting
    // ingest by dropping this registration (or by `enabled: false`) would take
    // the query spans with it, which is the trade this asserts against.
    expect(pg).toBeInstanceOf(PgInstrumentation);
    // No SECOND PgInstrumentation: one registered without the flag below would
    // re-emit connect spans, and `pg` alone would not catch it.
    expect(extra).toHaveLength(0);
    expect(pg.getConfig().enabled).not.toBe(false);
    expect(pg.getConfig().ignoreConnectSpans).toBe(true);
  });
});
