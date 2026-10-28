import path from "node:path";
import { DesktopClientAttributionHeader } from "@repo/api/src/types/desktop-client-attribution";
import { log } from "@repo/observability/log";
import {
  KEYLESS_TELEMETRY_API_ROUTE_PREFIX,
  KEYLESS_TELEMETRY_CONTENT_TYPE,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
  KeylessTelemetryRejectionReason,
  KeylessTelemetrySignal,
} from "@repo/shared-platform/keyless-telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  getVercelOidcToken: vi.fn(),
}));

vi.mock("@/env", () => ({ env: mocks.env }));
vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: mocks.getVercelOidcToken,
}));

import {
  DESKTOP_OTLP_EXPORT_MEASURED_EVENT,
  DESKTOP_OTLP_INSTALL_BUDGET_PER_WINDOW,
  desktopOtlpInstallBudget,
} from "./handler";
import { POST } from "./route";

const COLLECTOR_URL = "https://collector.example.test";
const AUDIENCE = "https://collector.example.test/otlp";
const OIDC_TOKEN = "vercel-oidc-token";
const INSTALL_ID = "2f1c8f8e-3b7a-4c1d-9e2f-5a6b7c8d9e0f";
const OTHER_INSTALL_ID = "8d0e6b2a-1c3f-4a5b-8c7d-9e0f1a2b3c4d";
const OTLP_BODY = new Uint8Array([10, 3, 1, 2, 3, 0, 255]);

const fetchMock = vi.fn((_url: URL, _init: RequestInit) =>
  Promise.resolve(new Response("", { status: 200 }))
);

describe("POST /desktop/otlp/v1/[signal] (ISS-12211)", () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.env.DESKTOP_OTLP_COLLECTOR_URL = COLLECTOR_URL;
    mocks.env.DESKTOP_OTLP_COLLECTOR_OIDC_AUDIENCE = AUDIENCE;
    mocks.getVercelOidcToken.mockReset();
    mocks.getVercelOidcToken.mockResolvedValue(OIDC_TOKEN);
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    desktopOtlpInstallBudget.clear();
    info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(log, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(Object.values(KeylessTelemetrySignal))(
    "forwards a %s batch byte for byte to the Collector with the OIDC bearer",
    async (signal) => {
      const response = await POST(...exportRequest(signal));

      expect(response.status).toBe(200);
      expect(mocks.getVercelOidcToken).toHaveBeenCalledWith({
        audience: AUDIENCE,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url.toString()).toBe(`${COLLECTOR_URL}/v1/${signal}`);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        authorization: `Bearer ${OIDC_TOKEN}`,
        "content-type": KEYLESS_TELEMETRY_CONTENT_TYPE,
      });
      expect(new Uint8Array(init.body as Uint8Array)).toEqual(OTLP_BODY);
      expect(info).toHaveBeenCalledWith(DESKTOP_OTLP_EXPORT_MEASURED_EVENT, {
        signal,
        wireBytes: OTLP_BODY.byteLength,
      });
    }
  );

  it("is served at the path the desktop transport posts to", () => {
    const appRoot = path.join(import.meta.dirname, "..", "..", "..", "..");
    const servedAt = `/${path.relative(appRoot, import.meta.dirname)}`;

    expect(servedAt).toBe(`${KEYLESS_TELEMETRY_API_ROUTE_PREFIX}/v1/[signal]`);
  });

  it.each([
    ["the Collector URL is unset", "DESKTOP_OTLP_COLLECTOR_URL", "traces"],
    [
      "the OIDC audience is unset",
      "DESKTOP_OTLP_COLLECTOR_OIDC_AUDIENCE",
      "traces",
    ],
    ["the signal is unknown", undefined, "profiles"],
  ])(
    "answers 404 and forwards nothing when %s",
    async (_label, unset, signal) => {
      if (unset) {
        mocks.env[unset] = undefined;
      }

      const response = await POST(...exportRequest(signal));

      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "a JSON content type",
      { contentType: "application/json" },
      KeylessTelemetryRejectionReason.InvalidContentType,
    ],
    [
      "no installation id",
      { installId: null },
      KeylessTelemetryRejectionReason.InvalidRequest,
    ],
    [
      "a non-UUID installation id",
      { installId: "not-a-uuid" },
      KeylessTelemetryRejectionReason.InvalidRequest,
    ],
  ])("refuses %s with 400 before forwarding", async (_label, options, code) => {
    const response = await POST(
      ...exportRequest(KeylessTelemetrySignal.Logs, options)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body over the desktop transport's own ceiling with 413", async () => {
    const response = await POST(
      ...exportRequest(KeylessTelemetrySignal.Traces, {
        body: new Uint8Array(KEYLESS_TELEMETRY_MAX_BODY_BYTES + 1),
      })
    );

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 500 and forwards nothing when the upload breaks off mid-read", async () => {
    const [request, context] = exportRequest(KeylessTelemetrySignal.Traces);
    const broken = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("client went away"));
        },
      }),
      duplex: "half",
    } as RequestInit);

    const response = await POST(broken, context);

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 500 and forwards nothing when the upload closes short of its Content-Length", async () => {
    const response = await POST(
      ...streamedExportRequest(OTLP_BODY, OTLP_BODY.byteLength + 1)
    );

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a streamed upload that meets its Content-Length", async () => {
    const response = await POST(
      ...streamedExportRequest(OTLP_BODY, OTLP_BODY.byteLength)
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a body exactly at the ceiling", async () => {
    const response = await POST(
      ...exportRequest(KeylessTelemetrySignal.Traces, {
        body: new Uint8Array(KEYLESS_TELEMETRY_MAX_BODY_BYTES),
      })
    );

    expect(response.status).toBe(200);
  });

  it("refuses an install past its budget, and only that install", async () => {
    for (let i = 0; i < DESKTOP_OTLP_INSTALL_BUDGET_PER_WINDOW; i += 1) {
      expect(
        (await POST(...exportRequest(KeylessTelemetrySignal.Metrics))).status
      ).toBe(200);
    }

    const refused = await POST(
      ...exportRequest(KeylessTelemetrySignal.Metrics)
    );
    const other = await POST(
      ...exportRequest(KeylessTelemetrySignal.Metrics, {
        installId: OTHER_INSTALL_ID,
      })
    );

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({
      code: KeylessTelemetryRejectionReason.RateLimited,
    });
    expect(other.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(
      DESKTOP_OTLP_INSTALL_BUDGET_PER_WINDOW + 1
    );
  });

  it.each([400, 413, 415])(
    "answers 400 otlp_rejected when the Collector refuses the payload with %i",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response("", { status }));

      const response = await POST(
        ...exportRequest(KeylessTelemetrySignal.Logs)
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: KeylessTelemetryRejectionReason.OtlpRejected,
      });
    }
  );

  it.each([401, 403, 404, 429])(
    "answers a retryable 503 when the hop in front of the Collector answers %i",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response("", { status }));

      const response = await POST(
        ...exportRequest(KeylessTelemetrySignal.Logs)
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe(
        String(KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS)
      );
      expect(await response.json()).toMatchObject({
        code: KeylessTelemetryRejectionReason.CollectorUnavailable,
      });
    }
  );

  it.each([
    [
      "the Collector answers 503",
      () => fetchMock.mockResolvedValueOnce(new Response("", { status: 503 })),
      KeylessTelemetryRejectionReason.CollectorUnavailable,
    ],
    [
      "the Collector is unreachable",
      () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")),
      KeylessTelemetryRejectionReason.CollectorUnavailable,
    ],
    [
      "the OIDC token cannot be minted",
      () =>
        mocks.getVercelOidcToken.mockRejectedValueOnce(new Error("no token")),
      KeylessTelemetryRejectionReason.CollectorUnavailable,
    ],
    [
      "the forward times out",
      () => {
        vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(
          AbortSignal.abort(new DOMException("timed out", "TimeoutError"))
        );
        fetchMock.mockImplementationOnce((_url, init) =>
          Promise.reject(init.signal?.reason)
        );
      },
      KeylessTelemetryRejectionReason.RequestTimeout,
    ],
  ])("answers a retryable 503 when %s", async (_label, arrange, code) => {
    arrange();

    const response = await POST(
      ...exportRequest(KeylessTelemetrySignal.Traces)
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(
      String(KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS)
    );
    expect(await response.json()).toMatchObject({ code });
  });
});

function exportRequest(
  signal: string,
  options: {
    body?: Uint8Array<ArrayBuffer>;
    contentType?: string;
    installId?: string | null;
  } = {}
): [Request, { params: Promise<{ signal: string }> }] {
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? KEYLESS_TELEMETRY_CONTENT_TYPE,
  };
  const installId =
    options.installId === undefined ? INSTALL_ID : options.installId;
  if (installId !== null) {
    headers[DesktopClientAttributionHeader.InstallationId] = installId;
  }
  return [
    new Request(
      `https://api.closedloop.ai${KEYLESS_TELEMETRY_API_ROUTE_PREFIX}/v1/${signal}`,
      { method: "POST", headers, body: options.body ?? OTLP_BODY }
    ),
    { params: Promise.resolve({ signal }) },
  ];
}

/** A body stream that closes cleanly after `bytes`, declaring `contentLength`. */
function streamedExportRequest(
  bytes: Uint8Array,
  contentLength: number
): [Request, { params: Promise<{ signal: string }> }] {
  const [request, context] = exportRequest(KeylessTelemetrySignal.Traces);
  const headers = new Headers(request.headers);
  headers.set("content-length", String(contentLength));
  return [
    new Request(request.url, {
      method: "POST",
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit),
    context,
  ];
}
