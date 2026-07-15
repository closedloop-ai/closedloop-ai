import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { asRecord } from "./api-response-utils.js";
import {
  getOtlpRequestType,
  getOtlpResponseType,
  OtlpExportKind,
  OtlpProtoDescriptorError,
} from "./otlp/proto-descriptor.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  DEFAULT_OTLP_RECEIVER_PORT,
  makeOtlpReceiverUnavailableState,
  type OtlpReceiverState,
  OtlpReceiverUnavailableReason,
  setOtlpReceiverStateForProcess,
} from "./otlp-receiver-state.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 30_000;
const CONTENT_TYPE_PROTOBUF = "application/x-protobuf";
const NUMERIC_STRING_RE = /^-?\d+(?:\.\d+)?$/;
const UNKNOWN_EXPORT_DIAGNOSTIC_LIMIT = 10;

// Resource container -> instrumentation-scope array, one entry per OTLP signal.
// discriminateHarness() never inspects scope names, so the diagnostic surfaces
// them to reveal where an unrecognized harness stamps its identity.
const SCOPE_CONTAINER_KEYS = [
  { resource: "resourceMetrics", scopes: "scopeMetrics" },
  { resource: "resourceLogs", scopes: "scopeLogs" },
  { resource: "resourceSpans", scopes: "scopeSpans" },
] as const;

export const OtlpHarness = {
  Claude: "claude",
  Codex: "codex",
  Unknown: "unknown",
} as const;

export type OtlpHarness = (typeof OtlpHarness)[keyof typeof OtlpHarness];

export type OtlpScalarValue = string | number | boolean;
export type OtlpResourceAttributes = Record<string, OtlpScalarValue>;

export type NormalizedOtlpExport = {
  kind: OtlpExportKind;
  harness: Exclude<OtlpHarness, typeof OtlpHarness.Unknown>;
  resourceAttributes: OtlpResourceAttributes[];
  metricNames: string[];
  logSummaries: OtlpLogSummary[];
  spanSummaries: OtlpSpanSummary[];
  decodedPayload: Record<string, unknown>;
};

export type UnknownOtlpExport = Omit<NormalizedOtlpExport, "harness"> & {
  harness: typeof OtlpHarness.Unknown;
};

export type OtlpLogSummary = {
  severityText?: string;
  severityNumber?: number;
  body?: OtlpScalarValue;
};

export type OtlpSpanSummary = {
  name: string;
  traceId?: string;
  spanId?: string;
};

export type OtlpHttpReceiverOptions = {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  onClaudeExport?: (payload: NormalizedOtlpExport) => void | Promise<void>;
  onCodexExport?: (payload: NormalizedOtlpExport) => void | Promise<void>;
  onUnknownExport?: (payload: UnknownOtlpExport) => void | Promise<void>;
  onBindError?: (reason: string) => void;
  log?: (message: string) => void;
};

type DecodedOtlpExport = Omit<NormalizedOtlpExport, "harness">;

type OtlpDispatchPayload = NormalizedOtlpExport | UnknownOtlpExport;

type CallbackDispatch = {
  payload: OtlpDispatchPayload;
  callback?: (payload: OtlpDispatchPayload) => void | Promise<void>;
};

export class OtlpHttpReceiver {
  private readonly host: string;
  private readonly maxBodyBytes: number;
  private readonly options: OtlpHttpReceiverOptions;
  private readonly port: number;
  private boundPort: number | null = null;
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  private state: OtlpReceiverState;

  constructor(options: OtlpHttpReceiverOptions = {}) {
    this.options = options;
    this.host = options.host ?? DEFAULT_OTLP_RECEIVER_HOST;
    this.port = options.port ?? DEFAULT_OTLP_RECEIVER_PORT;
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    this.state = makeOtlpReceiverUnavailableState(
      OtlpReceiverUnavailableReason.NotStarted,
      this.port
    );
  }

  getState(): OtlpReceiverState {
    return this.state;
  }

  getBoundAddress(): AddressInfo | null {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address : null;
  }

  start(): Promise<OtlpReceiverState> {
    if (this.server) {
      return Promise.resolve(this.state);
    }
    if (this.host !== DEFAULT_OTLP_RECEIVER_HOST) {
      const state = makeOtlpReceiverUnavailableState(
        OtlpReceiverUnavailableReason.InvalidHost,
        this.port
      );
      this.setState(state);
      this.options.onBindError?.("OTLP receiver must bind 127.0.0.1 only.");
      return Promise.resolve(state);
    }

    return new Promise<OtlpReceiverState>((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => {
          this.sockets.delete(socket);
        });
      });
      server.on("error", (error: NodeJS.ErrnoException) => {
        const state = makeOtlpReceiverUnavailableState(
          OtlpReceiverUnavailableReason.BindFailed,
          this.port
        );
        this.server = null;
        this.setState(state);
        const reason =
          error.code === "EADDRINUSE"
            ? `OTLP receiver port ${this.port} is already in use.`
            : `OTLP receiver bind failed: ${error.message}`;
        this.log(reason);
        this.options.onBindError?.(reason);
        resolve(state);
      });
      server.listen(this.port, DEFAULT_OTLP_RECEIVER_HOST, () => {
        const address = server.address() as AddressInfo | null;
        this.boundPort = address?.port ?? this.port;
        const state: OtlpReceiverState = {
          available: true,
          host: DEFAULT_OTLP_RECEIVER_HOST,
          port: this.boundPort,
        };
        this.setState(state);
        this.log(
          `OTLP receiver ready on http://${DEFAULT_OTLP_RECEIVER_HOST}:${this.boundPort}`
        );
        resolve(state);
      });
      this.server = server;
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    this.setState(
      makeOtlpReceiverUnavailableState(
        OtlpReceiverUnavailableReason.Stopped,
        this.port
      )
    );
    if (!server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      server.close(() => {
        this.sockets.clear();
        resolve();
      });
      server.closeAllConnections();
      for (const socket of this.sockets) {
        socket.destroy();
      }
    });
  }

  private setState(state: OtlpReceiverState): void {
    this.state = state;
    setOtlpReceiverStateForProcess(state);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const kind = kindForPath(req.url ?? "");
    if (!kind) {
      this.respondText(res, 404, "not found");
      return;
    }
    if (req.method !== "POST") {
      this.respondText(res, 405, "method not allowed");
      return;
    }
    const contentType = getSupportedOtlpContentType(
      req.headers["content-type"]
    );
    if (!contentType) {
      this.respondText(res, 415, "unsupported media type");
      return;
    }

    readBody(req, this.maxBodyBytes, REQUEST_BODY_TIMEOUT_MS)
      .then((body) => {
        let decoded: DecodedOtlpExport;
        try {
          decoded = decodeOtlpExport(kind, body);
        } catch (error) {
          if (error instanceof OtlpProtoDescriptorError) {
            this.log("OTLP receiver descriptor initialization failed.");
            this.respondText(res, 500, "otlp receiver unavailable");
            return;
          }
          this.respondText(res, 400, "malformed otlp payload");
          return;
        }
        const dispatch = this.prepareDispatch(decoded);
        let responseBody: Buffer;
        try {
          responseBody = encodeEmptyOtlpResponse(kind);
        } catch (error) {
          if (error instanceof OtlpProtoDescriptorError) {
            this.log("OTLP receiver descriptor initialization failed.");
            this.respondText(res, 500, "otlp receiver unavailable");
            return;
          }
          throw error;
        }
        this.respondProtobuf(res, 200, responseBody);
        this.dispatchAfterAck(dispatch);
      })
      .catch((error: unknown) => {
        const status = statusForBodyReadError(error);
        this.respondText(res, status, bodyForBodyReadStatus(status), {
          closeConnection:
            error instanceof PayloadTooLargeError ||
            error instanceof RequestTimeoutError,
          onEnd:
            error instanceof PayloadTooLargeError ||
            error instanceof RequestTimeoutError
              ? () => req.destroy()
              : undefined,
        });
      });
  }

  private prepareDispatch(decoded: DecodedOtlpExport): CallbackDispatch {
    const harness = discriminateHarness(decoded);
    if (harness === OtlpHarness.Claude) {
      return {
        payload: { ...decoded, harness },
        callback: this.options.onClaudeExport as CallbackDispatch["callback"],
      };
    }
    if (harness === OtlpHarness.Codex) {
      return {
        payload: { ...decoded, harness },
        callback: this.options.onCodexExport as CallbackDispatch["callback"],
      };
    }
    return {
      payload: { ...decoded, harness },
      callback: this.options.onUnknownExport as CallbackDispatch["callback"],
    };
  }

  private dispatchAfterAck(dispatch: CallbackDispatch): void {
    if (dispatch.payload.harness === OtlpHarness.Unknown) {
      this.log(
        `OTLP receiver dropped unknown-harness ${dispatch.payload.kind} export. ${describeUnknownExport(dispatch.payload)}`
      );
    }
    Promise.resolve(dispatch.callback?.(dispatch.payload)).catch(() => {
      this.log(
        `OTLP receiver callback failed for ${dispatch.payload.kind}/${dispatch.payload.harness}.`
      );
    });
  }

  private respondText(
    res: ServerResponse,
    status: number,
    body: string,
    options: { closeConnection?: boolean; onEnd?: () => void } = {}
  ): void {
    res.writeHead(status, {
      Connection: options.closeConnection ? "close" : "keep-alive",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(body, options.onEnd);
  }

  private respondProtobuf(
    res: ServerResponse,
    status: number,
    body: Buffer
  ): void {
    res.writeHead(status, {
      "Content-Type": CONTENT_TYPE_PROTOBUF,
      "Content-Length": String(body.length),
    });
    res.end(body);
  }
}

export function encodeEmptyOtlpResponse(kind: OtlpExportKind): Buffer {
  const responseType = getOtlpResponseType(kind);
  return Buffer.from(responseType.encode(responseType.create({})).finish());
}

function decodeOtlpExport(
  kind: OtlpExportKind,
  buffer: Buffer
): DecodedOtlpExport {
  const requestType = getOtlpRequestType(kind);
  const message = requestType.decode(buffer);
  const decodedPayload = requestType.toObject(message, {
    bytes: Buffer,
    longs: String,
    defaults: false,
  }) as Record<string, unknown>;
  return normalizeDecodedExport(kind, decodedPayload);
}

function normalizeDecodedExport(
  kind: OtlpExportKind,
  decodedPayload: Record<string, unknown>
): DecodedOtlpExport {
  if (kind === OtlpExportKind.Metrics) {
    const resourceMetrics = asArray(decodedPayload.resourceMetrics);
    return {
      kind,
      resourceAttributes: collectResourceAttributes(resourceMetrics),
      metricNames: collectMetricNames(resourceMetrics),
      logSummaries: [],
      spanSummaries: [],
      decodedPayload,
    };
  }
  if (kind === OtlpExportKind.Logs) {
    const resourceLogs = asArray(decodedPayload.resourceLogs);
    return {
      kind,
      resourceAttributes: collectResourceAttributes(resourceLogs),
      metricNames: [],
      logSummaries: collectLogSummaries(resourceLogs),
      spanSummaries: [],
      decodedPayload,
    };
  }
  const resourceSpans = asArray(decodedPayload.resourceSpans);
  return {
    kind,
    resourceAttributes: collectResourceAttributes(resourceSpans),
    metricNames: [],
    logSummaries: [],
    spanSummaries: collectSpanSummaries(resourceSpans),
    decodedPayload,
  };
}

function collectResourceAttributes(
  resourceContainers: Record<string, unknown>[]
): OtlpResourceAttributes[] {
  return resourceContainers.map((container) =>
    keyValuesToAttributes(asArray(asRecord(container.resource).attributes))
  );
}

function collectMetricNames(
  resourceMetrics: Record<string, unknown>[]
): string[] {
  return resourceMetrics.flatMap((resourceMetric) =>
    asArray(resourceMetric.scopeMetrics).flatMap((scopeMetric) =>
      asArray(scopeMetric.metrics)
        .map((metric) => stringValue(metric.name))
        .filter((name): name is string => name !== undefined)
    )
  );
}

function collectLogSummaries(
  resourceLogs: Record<string, unknown>[]
): OtlpLogSummary[] {
  return resourceLogs.flatMap((resourceLog) =>
    asArray(resourceLog.scopeLogs).flatMap((scopeLog) =>
      asArray(scopeLog.logRecords).map((record) => {
        const summary: OtlpLogSummary = {};
        const severityText = stringValue(record.severityText);
        const severityNumber = numberValue(record.severityNumber);
        const body = scalarFromAnyValue(asRecord(record.body));
        if (severityText !== undefined) {
          summary.severityText = severityText;
        }
        if (severityNumber !== undefined) {
          summary.severityNumber = severityNumber;
        }
        if (body !== undefined) {
          summary.body = body;
        }
        return summary;
      })
    )
  );
}

function collectSpanSummaries(
  resourceSpans: Record<string, unknown>[]
): OtlpSpanSummary[] {
  return resourceSpans.flatMap((resourceSpan) =>
    asArray(resourceSpan.scopeSpans).flatMap((scopeSpan) =>
      asArray(scopeSpan.spans).map((span) => {
        const summary: OtlpSpanSummary = {
          name: stringValue(span.name) ?? "",
        };
        const traceId = bytesToHex(span.traceId);
        const spanId = bytesToHex(span.spanId);
        if (traceId) {
          summary.traceId = traceId;
        }
        if (spanId) {
          summary.spanId = spanId;
        }
        return summary;
      })
    )
  );
}

function keyValuesToAttributes(
  values: Record<string, unknown>[]
): OtlpResourceAttributes {
  const attributes: OtlpResourceAttributes = {};
  for (const value of values) {
    const key = stringValue(value.key);
    const scalar = scalarFromAnyValue(asRecord(value.value));
    if (key && scalar !== undefined) {
      attributes[key] = scalar;
    }
  }
  return attributes;
}

function scalarFromAnyValue(
  value: Record<string, unknown>
): OtlpScalarValue | undefined {
  const stringScalar = stringValue(value.stringValue);
  if (stringScalar !== undefined) {
    return stringScalar;
  }
  if (typeof value.boolValue === "boolean") {
    return value.boolValue;
  }
  return numberValue(value.intValue) ?? numberValue(value.doubleValue);
}

function discriminateHarness(decoded: DecodedOtlpExport): OtlpHarness {
  const searchable = [
    ...decoded.metricNames,
    ...decoded.spanSummaries.map((span) => span.name),
    ...decoded.resourceAttributes.flatMap((attributes) =>
      Object.entries(attributes).flatMap(([key, value]) => [key, String(value)])
    ),
  ].map((value) => value.toLowerCase());

  if (searchable.some(isClaudeIdentifier)) {
    return OtlpHarness.Claude;
  }
  if (searchable.some(isCodexIdentifier)) {
    return OtlpHarness.Codex;
  }
  return OtlpHarness.Unknown;
}

function isClaudeIdentifier(value: string): boolean {
  return (
    value === "claude-code" ||
    value === "claude_code" ||
    value.startsWith("claude-code.") ||
    value.startsWith("claude_code.")
  );
}

function isCodexIdentifier(value: string): boolean {
  // The Codex product family stamps its identity with a "codex-"/"codex_"
  // prefix (e.g. service.name "codex-cli", "codex-app-server"; scope
  // "codex_otel.log_only"). Anchoring at the start — rather than a substring
  // match — keeps incidental names like "my_codex_cli_helper" unclassified.
  return (
    value === "codex" ||
    value.startsWith("codex-") ||
    value.startsWith("codex_")
  );
}

// Compact, bounded summary of an unrecognized export's identity-bearing
// fields. Deliberately excludes log bodies (logSummaries[].body), which can
// carry user prompts — only scope names, resource attributes, and metric/span
// names are logged.
function describeUnknownExport(payload: UnknownOtlpExport): string {
  const attributePairs = payload.resourceAttributes.flatMap((attributes) =>
    Object.entries(attributes).map(([key, value]) => `${key}=${value}`)
  );
  const names = [
    ...payload.metricNames,
    ...payload.spanSummaries.map((span) => span.name),
  ].filter((name) => name.length > 0);
  return [
    formatDiagnosticList("scopes", collectScopeNames(payload.decodedPayload)),
    formatDiagnosticList("resourceAttributes", attributePairs),
    formatDiagnosticList("names", names),
  ].join(" ");
}

function collectScopeNames(decodedPayload: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const { resource, scopes } of SCOPE_CONTAINER_KEYS) {
    for (const container of asArray(decodedPayload[resource])) {
      for (const scope of asArray(container[scopes])) {
        const name = stringValue(asRecord(scope.scope).name);
        if (name) {
          names.add(name);
        }
      }
    }
  }
  return [...names];
}

function formatDiagnosticList(label: string, values: string[]): string {
  const shown = values.slice(0, UNKNOWN_EXPORT_DIAGNOSTIC_LIMIT);
  const suffix =
    values.length > shown.length
      ? ` (+${values.length - shown.length} more)`
      : "";
  return `${label}=[${shown.join(", ")}]${suffix}`;
}

function kindForPath(pathname: string): OtlpExportKind | null {
  switch (pathname) {
    case "/v1/metrics":
      return OtlpExportKind.Metrics;
    case "/v1/logs":
      return OtlpExportKind.Logs;
    case "/v1/traces":
      return OtlpExportKind.Traces;
    default:
      return null;
  }
}

function getSupportedOtlpContentType(
  value: string | string[] | undefined
): typeof CONTENT_TYPE_PROTOBUF | null {
  const contentType = Array.isArray(value) ? value[0] : value;
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized === CONTENT_TYPE_PROTOBUF) {
    return normalized;
  }
  return null;
}

function readBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = (): void => {
      req.setTimeout(0);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const settleWithError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      chunks.length = 0;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        settleWithError(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      settleWithError(error);
    };
    req.setTimeout(timeoutMs, () => {
      settleWithError(new RequestTimeoutError());
    });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function statusForBodyReadError(error: unknown): number {
  if (error instanceof PayloadTooLargeError) {
    return 413;
  }
  if (error instanceof RequestTimeoutError) {
    return 408;
  }
  return 400;
}

function bodyForBodyReadStatus(status: number): string {
  switch (status) {
    case 408:
      return "request timeout";
    case 413:
      return "payload too large";
    default:
      return "bad request";
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && NUMERIC_STRING_RE.test(value)) {
    return Number(value);
  }
  return undefined;
}

function bytesToHex(value: unknown): string | undefined {
  if (Buffer.isBuffer(value)) {
    return value.toString("hex");
  }
  return undefined;
}

class PayloadTooLargeError extends Error {}

class RequestTimeoutError extends Error {}
