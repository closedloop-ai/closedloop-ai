import { afterEach, describe, expect, it, vi } from "vitest";
import { initTracing, resetTracingForTest } from "../provider";
import { clearTracingEnv } from "./tracing-env";

// The exporter is mocked module-wide, so this lives apart from provider.test.ts.
const exporterOptions = vi.hoisted((): unknown[] => []);

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    constructor(options: unknown) {
      exporterOptions.push(options);
    }
    export(): void {
      // nothing is exported in these cases
    }
    forceFlush(): Promise<void> {
      return Promise.resolve();
    }
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

afterEach(async () => {
  await resetTracingForTest();
  exporterOptions.length = 0;
  vi.unstubAllEnvs();
});

describe("the OTLP exporter's Datadog key header (ISS-11827)", () => {
  it("authenticates a direct export with the key", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACING_ENABLED", "1");
    vi.stubEnv("DD_API_KEY", "dd-test-key");
    vi.stubEnv(
      "DD_OTLP_TRACES_ENDPOINT",
      "https://otlp.example.test/v1/traces"
    );

    expect(initTracing().enabled).toBe(true);
    expect(exporterOptions).toStrictEqual([
      {
        url: "https://otlp.example.test/v1/traces",
        headers: { "dd-api-key": "dd-test-key" },
      },
    ]);
  });

  it("sends no key header at all to a keyless loopback sidecar", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACING_ENABLED", "1");
    vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", "http://localhost:4318/v1/traces");

    expect(initTracing().enabled).toBe(true);
    // Strict: a `dd-api-key: undefined` entry is an invalid header value that
    // fails every export at send time, which the SDK reports nowhere.
    expect(exporterOptions).toStrictEqual([
      { url: "http://localhost:4318/v1/traces", headers: {} },
    ]);
  });
});
